import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SimpleGit } from 'simple-git';
import {
  DEFAULT_SYNC_INTERVAL_MS,
  FETCH_TIMEOUT_MS,
  GitVaultManager,
} from '@/services/git-vault-manager';
import { parseSyncIntervalMs } from '@/services/vault-factory';
import { configureLogger } from '@/utils/logger';

const INTERVAL_MS = 30_000;
const SLOW_GIT_MS = 10;

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Stands in for simple-git; clone lays down a minimal working tree. */
function fakeGit() {
  return {
    clone: vi.fn(async (_url: string, dir: string) => {
      await fs.mkdir(path.join(dir, '.git'), { recursive: true });
      await fs.writeFile(path.join(dir, 'note.md'), 'cloned');
    }),
    addConfig: vi.fn(async () => undefined),
    remote: vi.fn(async () => undefined),
    revparse: vi.fn(async () => 'abc123\n'),
    fetch: vi.fn(async (): Promise<void> => undefined),
    reset: vi.fn(async () => undefined),
    clean: vi.fn(async () => undefined),
    raw: vi.fn(async () => ''),
    status: vi.fn(async () => ({ files: [{ path: 'note.md' }] })),
    commit: vi.fn(async () => undefined),
    push: vi.fn(async (): Promise<void> => undefined),
  };
}

type FakeGit = ReturnType<typeof fakeGit>;

let root: string;
let vaultPath: string;
let git: FakeGit;

function manager(syncIntervalMs = INTERVAL_MS): GitVaultManager {
  return new GitVaultManager(
    {
      repoUrl: 'https://github.com/example/vault.git',
      branch: 'main',
      gitToken: 'token',
      vaultPath,
      syncIntervalMs,
    },
    () => git as unknown as SimpleGit,
  );
}

async function seedExistingClone(): Promise<void> {
  await fs.mkdir(path.join(vaultPath, '.git'), { recursive: true });
  await fs.writeFile(path.join(vaultPath, 'note.md'), 'existing');
}

beforeAll(() => {
  configureLogger({ stream: { write: () => true } as unknown as NodeJS.WriteStream });
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-vault-manager-'));
  vaultPath = path.join(root, 'vault');
  git = fakeGit();
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});

describe('GitVaultManager sync', () => {
  it('test_concurrent_reads_share_a_single_fetch', async () => {
    await seedExistingClone();
    git.fetch.mockImplementation(() => delay(SLOW_GIT_MS));
    const vault = manager();

    const reads = await Promise.all(Array.from({ length: 10 }, () => vault.readFile('note.md')));

    expect(reads.every(content => content === 'existing')).toBe(true);
    expect(git.fetch).toHaveBeenCalledTimes(1);
  });

  it('test_read_within_interval_does_not_fetch_again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await seedExistingClone();
    const vault = manager();

    await vault.readFile('note.md');
    vi.setSystemTime(Date.now() + INTERVAL_MS - 1);
    await vault.listFiles();

    expect(git.fetch).toHaveBeenCalledTimes(1);
  });

  it('test_read_after_interval_fetches_again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await seedExistingClone();
    const vault = manager();

    await vault.readFile('note.md');
    vi.setSystemTime(Date.now() + INTERVAL_MS);
    await vault.readFile('note.md');

    expect(git.fetch).toHaveBeenCalledTimes(2);
  });

  it('test_zero_interval_fetches_on_every_read', async () => {
    await seedExistingClone();
    const vault = manager(0);

    await vault.readFile('note.md');
    await vault.fileExists('note.md');

    expect(git.fetch).toHaveBeenCalledTimes(2);
  });

  it('test_write_within_interval_still_fetches_before_committing', async () => {
    await seedExistingClone();
    const vault = manager();

    await vault.readFile('note.md');
    await vault.writeFile('new.md', 'hello');

    expect(git.fetch).toHaveBeenCalledTimes(2);
    expect(git.fetch.mock.invocationCallOrder[1]).toBeLessThan(
      git.commit.mock.invocationCallOrder[0],
    );
    expect(git.push).toHaveBeenCalledTimes(1);
  });

  it('test_read_sync_waits_for_a_write_in_progress', async () => {
    await seedExistingClone();
    git.push.mockImplementation(() => delay(SLOW_GIT_MS));
    const vault = manager(0);

    await Promise.all([vault.writeFile('new.md', 'hello'), vault.readFile('note.md')]);

    // The read's fetch (and any reset/clean it implies) must not land between
    // the write's file change and its push.
    expect(git.fetch).toHaveBeenCalledTimes(2);
    expect(git.fetch.mock.invocationCallOrder[1]).toBeGreaterThan(
      git.push.mock.invocationCallOrder[0],
    );
  });

  it('test_missing_clone_is_cloned_without_fetching', async () => {
    const vault = manager();

    expect(await vault.readFile('note.md')).toBe('cloned');
    expect(git.clone).toHaveBeenCalledTimes(1);
    expect(git.fetch).not.toHaveBeenCalled();
  });
});

describe('GitVaultManager sync failures', () => {
  it('test_transient_fetch_failure_keeps_existing_vault', async () => {
    await seedExistingClone();
    git.fetch.mockRejectedValue(new Error('fatal: unable to access: Could not resolve host'));
    const vault = manager();

    expect(await vault.readFile('note.md')).toBe('existing');
    expect(git.clone).not.toHaveBeenCalled();
    expect(existsSync(path.join(vaultPath, '.git'))).toBe(true);
  });

  it('test_transient_fetch_failure_waits_for_next_interval_before_retrying', async () => {
    await seedExistingClone();
    git.fetch.mockRejectedValue(new Error('Could not resolve host'));
    const vault = manager();

    await vault.readFile('note.md');
    await vault.readFile('note.md');

    expect(git.fetch).toHaveBeenCalledTimes(1);
  });

  it('test_fetch_timeout_keeps_existing_vault', async () => {
    vi.useFakeTimers();
    await seedExistingClone();
    git.fetch.mockImplementation(() => new Promise(() => undefined));
    const vault = manager();

    const read = vault.readFile('note.md');
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);

    expect(await read).toBe('existing');
    expect(git.clone).not.toHaveBeenCalled();
  });

  it('test_write_is_refused_when_remote_cannot_be_reached', async () => {
    await seedExistingClone();
    git.fetch.mockRejectedValue(new Error('Could not resolve host'));
    const vault = manager();

    await expect(vault.writeFile('new.md', 'hello')).rejects.toThrow(/could not be synced/);
    expect(git.commit).not.toHaveBeenCalled();
    expect(existsSync(path.join(vaultPath, 'new.md'))).toBe(false);
    expect(existsSync(path.join(vaultPath, 'note.md'))).toBe(true);
  });

  it('test_broken_local_repository_is_recloned', async () => {
    await seedExistingClone();
    git.revparse.mockRejectedValueOnce(new Error('fatal: not a git repository'));
    const vault = manager();

    expect(await vault.readFile('note.md')).toBe('cloned');
    expect(git.clone).toHaveBeenCalledTimes(1);
    expect(git.fetch).not.toHaveBeenCalled();
  });
});

describe('parseSyncIntervalMs', () => {
  it('test_unset_interval_uses_default', () => {
    expect(parseSyncIntervalMs(undefined)).toBe(DEFAULT_SYNC_INTERVAL_MS);
  });

  it('test_interval_seconds_convert_to_ms', () => {
    expect(parseSyncIntervalMs('45')).toBe(45_000);
  });

  it('test_zero_interval_is_honoured', () => {
    expect(parseSyncIntervalMs('0')).toBe(0);
  });

  it('test_invalid_interval_falls_back_to_default', () => {
    expect(parseSyncIntervalMs('soon')).toBe(DEFAULT_SYNC_INTERVAL_MS);
    expect(parseSyncIntervalMs('-5')).toBe(DEFAULT_SYNC_INTERVAL_MS);
  });
});
