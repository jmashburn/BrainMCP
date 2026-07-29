import { describe, it, expect, vi } from 'vitest';
import {
  assertInsideVault,
  matchesPattern,
  parseProtectedPaths,
  guardVaultManager,
  PathNotAllowedError,
} from '@/services/path-guard';
import type { VaultManager } from '@/services/vault-manager';

describe('assertInsideVault', () => {
  it('accepts ordinary vault-relative paths', () => {
    expect(assertInsideVault('70-Journal/2026-07-28.md')).toBe('70-Journal/2026-07-28.md');
    expect(assertInsideVault('./Home.md')).toBe('Home.md');
  });

  it('rejects traversal out of the vault', () => {
    expect(() => assertInsideVault('../../.ssh/authorized_keys')).toThrow(PathNotAllowedError);
    expect(() => assertInsideVault('..')).toThrow(PathNotAllowedError);
  });

  it('rejects traversal that only escapes after normalisation', () => {
    expect(() => assertInsideVault('notes/../../etc/passwd')).toThrow(PathNotAllowedError);
  });

  it('allows traversal that stays inside the vault', () => {
    expect(assertInsideVault('notes/sub/../file.md')).toBe('notes/file.md');
  });

  it('rejects absolute paths', () => {
    expect(() => assertInsideVault('/etc/passwd')).toThrow(PathNotAllowedError);
  });

  it('rejects backslash-separated traversal', () => {
    expect(() => assertInsideVault('..\\..\\.ssh\\authorized_keys')).toThrow(PathNotAllowedError);
  });

  it('rejects empty paths', () => {
    expect(() => assertInsideVault('')).toThrow(PathNotAllowedError);
  });
});

describe('matchesPattern', () => {
  it('matches an exact file', () => {
    expect(matchesPattern('CLAUDE.md', 'CLAUDE.md')).toBe(true);
    expect(matchesPattern('Home.md', 'CLAUDE.md')).toBe(false);
  });

  it('matches a directory subtree with **', () => {
    expect(matchesPattern('90-Meta/conventions.md', '90-Meta/**')).toBe(true);
    expect(matchesPattern('90-Meta/templates/adr.md', '90-Meta/**')).toBe(true);
    expect(matchesPattern('90-Metadata/notes.md', '90-Meta/**')).toBe(false);
  });

  it('does not let * cross a path separator', () => {
    expect(matchesPattern('90-Meta/templates/adr.md', '90-Meta/*')).toBe(false);
    expect(matchesPattern('90-Meta/conventions.md', '90-Meta/*')).toBe(true);
  });

  it('matches case-insensitively, since the vault may be on a case-insensitive fs', () => {
    expect(matchesPattern('claude.md', 'CLAUDE.md')).toBe(true);
  });
});

describe('parseProtectedPaths', () => {
  it('splits and trims a comma-separated list', () => {
    expect(parseProtectedPaths('CLAUDE.md, 90-Meta/** ,.githooks/**')).toEqual([
      'CLAUDE.md',
      '90-Meta/**',
      '.githooks/**',
    ]);
  });

  it('returns an empty list when unset', () => {
    expect(parseProtectedPaths(undefined)).toEqual([]);
    expect(parseProtectedPaths('')).toEqual([]);
  });
});

const PROTECTED = ['CLAUDE.md', '90-Meta/**', '.githooks/**'];

function makeVault() {
  return {
    readFile: vi.fn().mockResolvedValue('contents'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    moveFile: vi.fn().mockResolvedValue(undefined),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    listFiles: vi.fn().mockResolvedValue([]),
  } as unknown as VaultManager & Record<string, ReturnType<typeof vi.fn>>;
}

describe('guardVaultManager', () => {
  it('allows writes to ordinary notes', async () => {
    const vault = makeVault();
    const guarded = guardVaultManager(vault, PROTECTED);

    await guarded.writeFile('00-Inbox/Idea.md', 'body');

    expect(vault.writeFile).toHaveBeenCalledWith('00-Inbox/Idea.md', 'body');
  });

  it('refuses to write a protected file', async () => {
    const vault = makeVault();
    const guarded = guardVaultManager(vault, PROTECTED);

    await expect(guarded.writeFile('CLAUDE.md', 'malicious')).rejects.toThrow(PathNotAllowedError);
    expect(vault.writeFile).not.toHaveBeenCalled();
  });

  it('refuses to write inside a protected subtree', async () => {
    const vault = makeVault();
    const guarded = guardVaultManager(vault, PROTECTED);

    await expect(guarded.writeFile('90-Meta/conventions.md', 'x')).rejects.toThrow(
      PathNotAllowedError,
    );
    await expect(guarded.writeFile('.githooks/pre-commit', 'exit 0')).rejects.toThrow(
      PathNotAllowedError,
    );
    expect(vault.writeFile).not.toHaveBeenCalled();
  });

  it('refuses to delete a protected file — disabling the hook is as bad as rewriting it', async () => {
    const vault = makeVault();
    const guarded = guardVaultManager(vault, PROTECTED);

    await expect(guarded.deleteFile('.githooks/pre-commit')).rejects.toThrow(PathNotAllowedError);
    expect(vault.deleteFile).not.toHaveBeenCalled();
  });

  it('refuses a move whose destination is protected', async () => {
    const vault = makeVault();
    const guarded = guardVaultManager(vault, PROTECTED);

    await expect(guarded.moveFile('00-Inbox/x.md', 'CLAUDE.md')).rejects.toThrow(
      PathNotAllowedError,
    );
    expect(vault.moveFile).not.toHaveBeenCalled();
  });

  it('refuses to reach a protected file via traversal', async () => {
    const vault = makeVault();
    const guarded = guardVaultManager(vault, PROTECTED);

    await expect(guarded.writeFile('00-Inbox/../CLAUDE.md', 'x')).rejects.toThrow(
      PathNotAllowedError,
    );
    expect(vault.writeFile).not.toHaveBeenCalled();
  });

  it('contains reads without protecting them — clients must be able to read the protocol', async () => {
    const vault = makeVault();
    const guarded = guardVaultManager(vault, PROTECTED);

    await expect(guarded.readFile('CLAUDE.md')).resolves.toBe('contents');
    await expect(guarded.readFile('../../etc/passwd')).rejects.toThrow(PathNotAllowedError);
  });
});

describe('vault-root operations', () => {
  it('allows an empty path, which is how listing the whole vault is expressed', async () => {
    const vault = makeVault();
    const guarded = guardVaultManager(vault, PROTECTED);

    await guarded.listFiles('');

    expect(vault.listFiles).toHaveBeenCalledWith('');
  });

  it('allows an absent path for the same reason', async () => {
    const vault = makeVault();
    const guarded = guardVaultManager(vault, PROTECTED);

    await (guarded as unknown as { listFiles: (p?: string) => Promise<unknown> }).listFiles();

    expect(vault.listFiles).toHaveBeenCalledWith(undefined);
  });

  it('still contains a non-empty listing path', async () => {
    const vault = makeVault();
    const guarded = guardVaultManager(vault, PROTECTED);

    await expect(guarded.listFiles('../../etc')).rejects.toThrow(PathNotAllowedError);
  });

  it('does not extend the empty-path allowance to writes', async () => {
    const vault = makeVault();
    const guarded = guardVaultManager(vault, PROTECTED);

    await expect(guarded.writeFile('', 'x')).rejects.toThrow(PathNotAllowedError);
    expect(vault.writeFile).not.toHaveBeenCalled();
  });
});
