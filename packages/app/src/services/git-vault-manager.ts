import { simpleGit, SimpleGit } from 'simple-git';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { VaultManager } from './vault-manager';
import { logger } from '@/utils/logger';
import { getAuthenticatedGitUrl } from './git-auth-provider';

export interface VaultConfig {
  repoUrl: string;
  branch: string;
  gitToken: string;
  gitUsername?: string;
  vaultPath: string;
  /** Vault-relative hooks dir (e.g. '.githooks'), applied as core.hooksPath on clone. */
  hooksPath?: string;
  /**
   * How long reads may serve the existing clone before fetching again.
   * 0 fetches on every call. Writes always fetch first, whatever this says.
   */
  syncIntervalMs?: number;
}

export type GitFactory = (baseDir?: string) => SimpleGit;

/**
 * 'fresh' means the clone matches the remote as of this sync. 'stale' means the
 * remote could not be reached, so the clone is intact but possibly behind:
 * fine to read, not fine to commit onto.
 */
type SyncOutcome = 'fresh' | 'stale';

export const DEFAULT_SYNC_INTERVAL_MS = 30_000;
export const FETCH_TIMEOUT_MS = 5_000;
const PUSH_MAX_ATTEMPTS = 3;

export class GitVaultManager implements VaultManager {
  private config: VaultConfig;
  private createGit: GitFactory;
  private syncIntervalMs: number;

  // Every git command that touches the working tree (sync, commit, push) runs
  // through this queue. Without it a read-triggered `reset --hard` + `clean`
  // could land between a write's file change and its commit and silently
  // discard the write, and two writes could race for the index lock.
  private gitQueue: Promise<unknown> = Promise.resolve();
  private readSyncInFlight: Promise<SyncOutcome> | null = null;
  // Gates the interval. Set on every completed attempt, including one that
  // could not reach the remote, so an outage costs one fetch timeout per
  // interval rather than one per file read.
  private lastSyncAttemptAt: number | null = null;
  private lastSuccessfulSyncAt: number | null = null;

  constructor(config: VaultConfig, createGit?: GitFactory) {
    this.config = config;
    this.createGit = createGit ?? (baseDir => this.createGitInstance(baseDir));
    this.syncIntervalMs = config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  }

  private createGitInstance(baseDir?: string): SimpleGit {
    const instance = baseDir ? simpleGit(baseDir) : simpleGit();

    // simple-git's env(object) REPLACES the environment rather than merging, so
    // passing only GIT_TERMINAL_PROMPT leaves git with no PATH: it falls back to
    // /usr/bin:/bin and cannot find anything installed elsewhere. That silently
    // breaks credential helpers, gpg signing, ssh, and — since hooks inherit
    // this environment — any hook the vault relies on.
    return instance.env({
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    });
  }

  /**
   * Create authenticated URL by embedding credentials
   * Uses automatic provider detection to determine the correct authentication format
   */
  private getAuthenticatedUrl(): string {
    return getAuthenticatedGitUrl(
      this.config.repoUrl,
      this.config.gitToken,
      this.config.gitUsername,
    );
  }

  /**
   * Sanitize URL for logging (remove credentials)
   */
  private sanitizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.username = parsed.username ? '***' : '';
      parsed.password = '';
      return parsed.toString();
    } catch {
      return 'invalid-url';
    }
  }

  /**
   * Bring the clone up to date before a read, at most once per sync interval.
   *
   * Concurrent readers share one in-flight sync: a search reads every note in
   * parallel batches, and one fetch per file both took tens of seconds and let
   * overlapping fetches collide.
   */
  private async initialize(): Promise<void> {
    if (this.isSyncCurrent()) return;

    if (!this.readSyncInFlight) {
      this.readSyncInFlight = this.exclusive(async () =>
        // A write may have synced while this waited in the queue.
        this.isSyncCurrent() ? 'fresh' : this.sync(),
      ).finally(() => {
        this.readSyncInFlight = null;
      });
    }

    await this.readSyncInFlight;
  }

  /**
   * Run a change against a freshly synced clone, holding the git queue from
   * the sync through the push. Committing onto a clone that could not be
   * synced risks a rejected push or a commit built on an outdated note, so a
   * stale sync refuses the write instead.
   */
  private async mutate(work: () => Promise<void>): Promise<void> {
    await this.exclusive(async () => {
      if ((await this.sync()) === 'stale') {
        throw new Error(
          'Vault could not be synced with the remote, so the change was not made. Try again shortly.',
        );
      }
      await work();
    });
  }

  private isSyncCurrent(): boolean {
    return (
      this.syncIntervalMs > 0 &&
      this.lastSyncAttemptAt !== null &&
      Date.now() - this.lastSyncAttemptAt < this.syncIntervalMs &&
      this.hasClone()
    );
  }

  private hasClone(): boolean {
    return existsSync(path.join(this.config.vaultPath, '.git'));
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.gitQueue.then(task, task);
    // The queue only orders work; a failed task must not poison the next one.
    this.gitQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Clone if there is no clone, otherwise sync with the remote.
   * Callers must hold the git queue.
   */
  private async sync(): Promise<SyncOutcome> {
    if (!this.hasClone()) {
      logger.info('Cloning vault', {
        repoUrl: this.sanitizeUrl(this.config.repoUrl),
        branch: this.config.branch,
      });
      await this.removeVault();
      await this.cloneVault();
      this.recordSync('fresh');
      return 'fresh';
    }

    logger.debug('Vault exists, syncing with remote');
    const outcome = await this.syncVault();
    this.recordSync(outcome);
    return outcome;
  }

  private recordSync(outcome: SyncOutcome): void {
    const now = Date.now();
    this.lastSyncAttemptAt = now;
    if (outcome === 'fresh') {
      this.lastSuccessfulSyncAt = now;
    }
  }

  /**
   * Remove the vault directory completely
   */
  private async removeVault(): Promise<void> {
    if (existsSync(this.config.vaultPath)) {
      logger.debug('Removing vault directory for fresh clone');
      await fs.rm(this.config.vaultPath, { recursive: true, force: true });
    }
  }

  /**
   * Clone the vault repository (cold start)
   */
  private async cloneVault(): Promise<void> {
    const tempGit = this.createGit();
    const authUrl = this.getAuthenticatedUrl();

    await tempGit.clone(authUrl, this.config.vaultPath, {
      '--depth': 1,
      '--branch': this.config.branch,
      '--single-branch': null,
    });

    const vaultGit = this.createGit(this.config.vaultPath);
    await vaultGit.addConfig('user.name', 'Obsidian MCP Server');
    await vaultGit.addConfig('user.email', 'mcp@obsidian.local');

    // Let a vault carry its own hooks (e.g. .githooks/pre-commit running gitleaks).
    // Without this, commits made here bypass every check the vault enforces locally,
    // and a remote client becomes the one writer nothing scans. simple-git shells out
    // to git, so hooks run normally and a failing hook makes commit() throw.
    if (this.config.hooksPath) {
      const hooksDir = path.join(this.config.vaultPath, this.config.hooksPath);
      if (existsSync(hooksDir)) {
        await vaultGit.addConfig('core.hooksPath', this.config.hooksPath);
        logger.info('Vault hooks enabled', { hooksPath: this.config.hooksPath });
      } else {
        logger.warn('VAULT_HOOKS_PATH set but not present in vault; commits will be unchecked', {
          hooksPath: this.config.hooksPath,
        });
      }
    }
  }

  /**
   * Sync vault with remote (warm start)
   *
   * Only a broken local repository is worth deleting and re-cloning. A fetch
   * that fails is a remote problem — network, timeout, auth — which a re-clone
   * needs the same remote to fix, so deleting first would turn a slightly
   * stale vault into no vault at all, and do it under any read in flight.
   */
  private async syncVault(): Promise<SyncOutcome> {
    const startTime = Date.now();
    const vaultGit = this.createGit(this.config.vaultPath);
    const authUrl = this.getAuthenticatedUrl();

    // Local-only checks: these fail when the repository itself is unusable.
    try {
      // Set the remote URL with embedded credentials for authenticated operations
      await vaultGit.remote(['set-url', 'origin', authUrl]);
      await vaultGit.revparse(['HEAD']);
    } catch (error) {
      return this.recloneBrokenVault('Local repository is unusable', error, startTime);
    }

    try {
      logger.debug('Fetching latest changes from remote');
      await this.fetchWithTimeout(vaultGit);
    } catch (error) {
      logger.warn('Fetch failed; serving the existing vault until the next sync', {
        error,
        durationMs: Date.now() - startTime,
        branch: this.config.branch,
        lastSuccessfulSyncAt: this.lastSuccessfulSyncAt
          ? new Date(this.lastSuccessfulSyncAt).toISOString()
          : null,
      });
      return 'stale';
    }

    try {
      // Only reset when the remote actually moved. Compare local HEAD to the
      // fetched remote tip; if equal, the working tree already matches and a
      // hard reset + clean would be pure churn on every tool call.
      const [localHead, remoteHead] = await Promise.all([
        vaultGit.revparse(['HEAD']),
        vaultGit.revparse([`origin/${this.config.branch}`]),
      ]);

      if (localHead.trim() === remoteHead.trim()) {
        logger.info('Vault already up to date', {
          durationMs: Date.now() - startTime,
          branch: this.config.branch,
          head: localHead.trim().slice(0, 8),
        });
        return 'fresh';
      }

      // Remote moved: reset to it exactly and drop any local cruft.
      logger.debug('Remote advanced, resetting vault to clean state');
      await vaultGit.reset(['--hard', `origin/${this.config.branch}`]);
      await vaultGit.clean('fdx');

      logger.info('Vault synced with remote', {
        durationMs: Date.now() - startTime,
        branch: this.config.branch,
        from: localHead.trim().slice(0, 8),
        to: remoteHead.trim().slice(0, 8),
      });
      return 'fresh';
    } catch (error) {
      // The fetch succeeded, so the remote is reachable and a re-clone can work.
      return this.recloneBrokenVault('Could not reset to the fetched remote', error, startTime);
    }
  }

  private async fetchWithTimeout(vaultGit: SimpleGit): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        vaultGit.fetch('origin', this.config.branch),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Fetch timeout')), FETCH_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async recloneBrokenVault(
    reason: string,
    error: unknown,
    startTime: number,
  ): Promise<SyncOutcome> {
    logger.error(`${reason}; removing vault and performing fresh clone`, {
      error,
      durationMs: Date.now() - startTime,
      branch: this.config.branch,
    });
    await this.removeVault();
    await this.cloneVault();
    return 'fresh';
  }

  /**
   * Commit and push changes (synchronous, blocking)
   * Private method - called automatically after write operations
   */
  private async commitAndPush(message: string, affectedFiles: string[]): Promise<void> {
    const vaultGit = this.createGit(this.config.vaultPath);

    if (affectedFiles.length > 0) {
      await vaultGit.raw(['add', '-A', ...affectedFiles]);
    } else {
      await vaultGit.raw(['add', '-A']);
    }

    const status = await vaultGit.status();
    if (status.files.length === 0) {
      logger.debug('No changes to commit');
      return;
    }

    await vaultGit.commit(message);
    await this.pushWithRetry(vaultGit, PUSH_MAX_ATTEMPTS);
  }

  /**
   * Push with exponential backoff retry
   */
  private async pushWithRetry(vaultGit: SimpleGit, maxAttempts: number): Promise<void> {
    const startTime = Date.now();
    const authUrl = this.getAuthenticatedUrl();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Ensure remote URL has credentials before pushing
        await vaultGit.remote(['set-url', 'origin', authUrl]);
        await vaultGit.push('origin', this.config.branch);
        logger.info('Successfully pushed changes', {
          durationMs: Date.now() - startTime,
          attempts: attempt,
          branch: this.config.branch,
        });
        return;
      } catch (error) {
        if (attempt === maxAttempts) {
          throw new Error(`Failed to push after ${maxAttempts} attempts: ${error}`);
        }

        const delay = Math.pow(2, attempt) * 1000;
        logger.warn('Push attempt failed, retrying', {
          attempt,
          maxAttempts,
          delayMs: delay,
          error,
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Read a file from the vault
   */
  async readFile(relativePath: string): Promise<string> {
    await this.initialize();
    const fullPath = path.join(this.config.vaultPath, relativePath);

    try {
      return await fs.readFile(fullPath, 'utf-8');
    } catch (error: any) {
      throw new Error(`Failed to read file ${relativePath}: ${error.message}`);
    }
  }

  /**
   * Write content to a file
   * Automatically commits and pushes the change
   */
  async writeFile(relativePath: string, content: string): Promise<void> {
    await this.mutate(async () => {
      const fullPath = path.join(this.config.vaultPath, relativePath);

      const dir = path.dirname(fullPath);
      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(fullPath, content, 'utf-8');
      await this.commitAndPush(`Update file: ${relativePath}`, [relativePath]);
    });

    logger.debug('File written successfully', {
      path: relativePath,
      sizeBytes: content.length,
    });
  }

  /**
   * Delete a file
   * Automatically commits and pushes the change
   */
  async deleteFile(relativePath: string): Promise<void> {
    await this.mutate(async () => {
      const fullPath = path.join(this.config.vaultPath, relativePath);

      try {
        const stats = await this.getFileStats(relativePath);
        if (stats.isDirectory) {
          throw new Error(`Cannot delete ${relativePath}: it is a directory`);
        }

        await fs.unlink(fullPath);
        await this.commitAndPush(`Delete file: ${relativePath}`, [relativePath]);
      } catch (error: any) {
        throw new Error(`Failed to delete file ${relativePath}: ${error.message}`);
      }
    });

    logger.debug('File deleted successfully', {
      path: relativePath,
    });
  }

  /**
   * Move/rename a file
   * Automatically commits and pushes the change
   */
  async moveFile(sourcePath: string, destPath: string): Promise<void> {
    await this.mutate(async () => {
      const fullSourcePath = path.join(this.config.vaultPath, sourcePath);
      const fullDestPath = path.join(this.config.vaultPath, destPath);

      const destDir = path.dirname(fullDestPath);
      await fs.mkdir(destDir, { recursive: true });

      await fs.rename(fullSourcePath, fullDestPath);
      await this.commitAndPush(`Move file: ${sourcePath} → ${destPath}`, [sourcePath, destPath]);
    });
  }

  /**
   * Create a directory
   */
  async createDirectory(relativePath: string, recursive: boolean): Promise<void> {
    await this.initialize();
    const fullPath = path.join(this.config.vaultPath, relativePath);
    await fs.mkdir(fullPath, { recursive });
  }

  /**
   * List files in a directory
   */
  async listFiles(
    relativePath: string = '',
    options: {
      includeDirectories?: boolean;
      fileTypes?: string[];
      recursive?: boolean;
    } = {},
  ): Promise<string[]> {
    await this.initialize();
    const fullPath = path.join(this.config.vaultPath, relativePath);

    const files: string[] = [];
    await this.walkDirectory(fullPath, this.config.vaultPath, files, options);

    return files;
  }

  /**
   * Recursively walk directory
   */
  private async walkDirectory(
    dir: string,
    basePath: string,
    files: string[],
    options: {
      includeDirectories?: boolean;
      fileTypes?: string[];
      recursive?: boolean;
    },
  ): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.obsidian') {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      if (entry.isDirectory()) {
        if (options.includeDirectories) {
          files.push(relativePath);
        }

        if (options.recursive !== false) {
          await this.walkDirectory(fullPath, basePath, files, options);
        }
      } else {
        if (options.fileTypes && options.fileTypes.length > 0) {
          const ext = path.extname(entry.name).substring(1);
          if (!options.fileTypes.includes(ext)) {
            continue;
          }
        }

        files.push(relativePath);
      }
    }
  }

  /**
   * Check if a file exists
   */
  async fileExists(relativePath: string): Promise<boolean> {
    await this.initialize();
    const fullPath = path.join(this.config.vaultPath, relativePath);
    return existsSync(fullPath);
  }

  /**
   * Get file stats (private helper method)
   *
   * Does not sync: its only caller already holds a freshly synced clone, and
   * syncing here would queue behind that caller and never run.
   */
  private async getFileStats(relativePath: string): Promise<{
    size: number;
    modified: Date;
    isDirectory: boolean;
  }> {
    const fullPath = path.join(this.config.vaultPath, relativePath);

    try {
      const stats = await fs.stat(fullPath);
      return {
        size: stats.size,
        modified: stats.mtime,
        isDirectory: stats.isDirectory(),
      };
    } catch (error: any) {
      throw new Error(`Failed to get stats for ${relativePath}: ${error.message}`);
    }
  }

  /**
   * Get the absolute path to the vault
   */
  getVaultPath(): string {
    return this.config.vaultPath;
  }
}
