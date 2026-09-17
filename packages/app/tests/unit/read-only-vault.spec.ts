import { describe, it, expect } from 'vitest';
import { readOnlyVaultManager, READ_ONLY_ERROR } from '@/services/read-only-vault';
import { InMemoryVaultManager } from '../support/doubles/in-memory-vault-manager.js';

function seeded() {
  const vault = new InMemoryVaultManager({ 'Home.md': '# Home' });
  return { vault, readOnly: readOnlyVaultManager(vault) };
}

describe('readOnlyVaultManager', () => {
  it('passes reads through', async () => {
    const { readOnly } = seeded();

    expect(await readOnly.readFile('Home.md')).toBe('# Home');
    expect(await readOnly.fileExists('Home.md')).toBe(true);
    expect(await readOnly.listFiles()).toContain('Home.md');
  });

  it('refuses writeFile and leaves the vault unchanged', async () => {
    const { vault, readOnly } = seeded();

    await expect(readOnly.writeFile('Home.md', 'changed')).rejects.toThrow(READ_ONLY_ERROR);
    expect(await vault.readFile('Home.md')).toBe('# Home');
  });

  it('refuses deleteFile', async () => {
    const { vault, readOnly } = seeded();

    await expect(readOnly.deleteFile('Home.md')).rejects.toThrow(READ_ONLY_ERROR);
    expect(await vault.fileExists('Home.md')).toBe(true);
  });

  it('refuses moveFile', async () => {
    const { vault, readOnly } = seeded();

    await expect(readOnly.moveFile('Home.md', 'Moved.md')).rejects.toThrow(READ_ONLY_ERROR);
    expect(await vault.fileExists('Moved.md')).toBe(false);
  });

  it('refuses createDirectory', async () => {
    const { readOnly } = seeded();

    await expect(readOnly.createDirectory('New', true)).rejects.toThrow(READ_ONLY_ERROR);
  });

  it('rejects rather than throwing synchronously', () => {
    const { readOnly } = seeded();

    expect(() => readOnly.writeFile('x.md', 'y').catch(() => {})).not.toThrow();
  });
});
