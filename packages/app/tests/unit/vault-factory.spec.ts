import { describe, it, expect, afterEach } from 'vitest';
import { guidanceFiles } from '@/services/vault-conventions';
import { DEFAULT_PROTECTED_PATHS } from '@/services/vault-factory';
import { isProtected } from '@/services/path-guard';
import { BRAIN_PROTOCOL_PATH } from '@/mcp/brain-protocol';

const ORIGINAL = process.env.VAULT_GUIDANCE_FILES;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.VAULT_GUIDANCE_FILES;
  else process.env.VAULT_GUIDANCE_FILES = ORIGINAL;
});

/** Mirrors how createVaultManager composes the two lists. */
function effectiveProtectedPaths(): string[] {
  return Array.from(new Set([...DEFAULT_PROTECTED_PATHS, ...guidanceFiles()]));
}

describe('guidanceFiles', () => {
  it('defaults to the common agent-vault filenames', () => {
    delete process.env.VAULT_GUIDANCE_FILES;
    expect(guidanceFiles({})).toEqual(['README.md', 'CLAUDE.md', 'AGENTS.md']);
  });

  it('is configurable per vault', () => {
    expect(guidanceFiles({ VAULT_GUIDANCE_FILES: 'CLAUDE.md, 90-Meta/conventions.md' })).toEqual([
      'CLAUDE.md',
      '90-Meta/conventions.md',
    ]);
  });
});

describe('guidance files are protected from writes', () => {
  it('protects the defaults, README.md included', () => {
    delete process.env.VAULT_GUIDANCE_FILES;
    const paths = effectiveProtectedPaths();

    // README.md is not in DEFAULT_PROTECTED_PATHS; it earns protection purely
    // by being published as guidance.
    expect(DEFAULT_PROTECTED_PATHS).not.toContain('README.md');
    expect(isProtected('README.md', paths)).toBe(true);
    expect(isProtected('CLAUDE.md', paths)).toBe(true);
  });

  it('protects a custom guidance file named only in VAULT_GUIDANCE_FILES', () => {
    process.env.VAULT_GUIDANCE_FILES = '90-Meta/conventions.md';
    const paths = effectiveProtectedPaths();

    expect(isProtected('90-Meta/conventions.md', paths)).toBe(true);
  });

  it('still leaves ordinary notes writable', () => {
    delete process.env.VAULT_GUIDANCE_FILES;
    const paths = effectiveProtectedPaths();

    expect(isProtected('00-Inbox/Idea.md', paths)).toBe(false);
    expect(isProtected('70-Journal/2026-07-28.md', paths)).toBe(false);
  });
});

describe('Brain protocol path protection', () => {
  it('protects the vault-authored protocol note from client writes by default', () => {
    expect(DEFAULT_PROTECTED_PATHS).toContain(BRAIN_PROTOCOL_PATH);
    expect(isProtected(BRAIN_PROTOCOL_PATH, DEFAULT_PROTECTED_PATHS)).toBe(true);
  });
});
