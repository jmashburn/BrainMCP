import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryVaultManager } from '../support/doubles/in-memory-vault-manager.js';
import { handleCaptureInbox, handleAddTask } from '@/mcp/handlers/convention-handlers';
import type { VaultConventionsConfig } from '@/services/vault-conventions';

const CONFIG: VaultConventionsConfig = {
  templatesDir: '90-Meta/templates',
  inboxDir: '00-Inbox',
  inboxTemplate: 'reference.md',
  tasksPath: '10-Tasks/TASKS.md',
  tasksDefaultSection: '## Now',
  source: 'chatgpt',
};

const NOW = new Date('2026-07-28T19:20:00Z');

const TASKS = [
  '---',
  'type: tasks',
  'updated: 2026-07-28',
  '---',
  '',
  '# Tasks',
  '',
  '## Now',
  '',
  '- [ ] Existing task (2026-07-27)',
  '',
  '## Next',
  '',
  '_(nothing yet)_',
  '',
  '## Done (recent)',
  '',
  '- [x] Something finished (2026-07-26)',
].join('\n');

describe('capture-inbox', () => {
  let vault: InMemoryVaultManager;

  beforeEach(() => {
    vault = new InMemoryVaultManager();
  });

  it('writes to the inbox using a Title Case filename derived from the title', async () => {
    const result = await handleCaptureInbox(
      vault,
      { title: 'rate limiting idea', body: 'Token bucket per client.' },
      CONFIG,
      NOW,
    );

    expect(result.success).toBe(true);
    expect(result.data.path).toBe('00-Inbox/Rate Limiting Idea.md');
    expect(await vault.fileExists('00-Inbox/Rate Limiting Idea.md')).toBe(true);
  });

  it('generates conforming frontmatter when there is no template', async () => {
    await handleCaptureInbox(vault, { title: 'Idea', body: 'text', tags: ['infra'] }, CONFIG, NOW);
    const content = await vault.readFile('00-Inbox/Idea.md');

    expect(content).toMatch(/^---\n/);
    expect(content).toContain('created: 2026-07-28');
    expect(content).toContain('updated: 2026-07-28');
    expect(content).toContain('tags: [infra]');
  });

  it('records provenance, so a later reader can tell who wrote it', async () => {
    await handleCaptureInbox(vault, { title: 'Idea', body: 'text' }, CONFIG, NOW);
    const content = await vault.readFile('00-Inbox/Idea.md');

    expect(content).toContain('source: chatgpt');
    expect(content).toContain('via: brain-mcp');
  });

  it("fills the vault's own template when one exists", async () => {
    await vault.writeFile(
      '90-Meta/templates/reference.md',
      '---\ntype: reference\nstatus: active\ncreated: {{date}}\n---\n\n# {{title}}\n\n{{body}}\n',
    );

    await handleCaptureInbox(
      vault,
      { title: 'Fuse Search', body: 'Notes on fuse.js' },
      CONFIG,
      NOW,
    );
    const content = await vault.readFile('00-Inbox/Fuse Search.md');

    // The template is authoritative: its status survives, its placeholders fill.
    expect(content).toContain('status: active');
    expect(content).toContain('created: 2026-07-28');
    expect(content).toContain('# Fuse Search');
    expect(content).toContain('Notes on fuse.js');
  });

  it('still captures when the configured template is missing', async () => {
    const result = await handleCaptureInbox(vault, { title: 'Idea', body: 'text' }, CONFIG, NOW);

    // Losing a thought because a template was renamed is the worse failure.
    expect(result.success).toBe(true);
    expect(await vault.fileExists('00-Inbox/Idea.md')).toBe(true);
  });

  it('refuses to silently overwrite an existing capture', async () => {
    await handleCaptureInbox(vault, { title: 'Idea', body: 'first' }, CONFIG, NOW);
    const second = await handleCaptureInbox(vault, { title: 'Idea', body: 'second' }, CONFIG, NOW);

    expect(second.success).toBe(false);
    expect(second.error).toContain('already exists');
    expect(await vault.readFile('00-Inbox/Idea.md')).toContain('first');
  });

  it('does not let a title escape the inbox folder', async () => {
    const result = await handleCaptureInbox(
      vault,
      { title: '../../CLAUDE', body: 'pwned' },
      CONFIG,
      NOW,
    );

    expect(result.data.path.startsWith('00-Inbox/')).toBe(true);
    expect(await vault.fileExists('CLAUDE.md')).toBe(false);
  });
});

describe('add-task', () => {
  let vault: InMemoryVaultManager;

  beforeEach(async () => {
    vault = new InMemoryVaultManager();
    await vault.writeFile('10-Tasks/TASKS.md', TASKS);
  });

  it('adds a dated unchecked task to the default section', async () => {
    const result = await handleAddTask(vault, { text: 'Ship the MCP server' }, CONFIG, NOW);

    expect(result.success).toBe(true);
    const content = await vault.readFile('10-Tasks/TASKS.md');
    expect(content).toContain('- [ ] Ship the MCP server (2026-07-28)');
  });

  it('adds after the last task in the section, not before it', async () => {
    await handleAddTask(vault, { text: 'Second' }, CONFIG, NOW);
    const lines = (await vault.readFile('10-Tasks/TASKS.md')).split('\n');

    const existing = lines.findIndex(l => l.includes('Existing task'));
    const added = lines.findIndex(l => l.includes('Second'));
    expect(added).toBe(existing + 1);
  });

  it('does not spill past the section heading', async () => {
    await handleAddTask(vault, { text: 'Scoped' }, CONFIG, NOW);
    const lines = (await vault.readFile('10-Tasks/TASKS.md')).split('\n');

    const added = lines.findIndex(l => l.includes('Scoped'));
    const nextHeading = lines.findIndex(l => l.trim() === '## Next');
    expect(added).toBeLessThan(nextHeading);
  });

  it('targets a named section', async () => {
    await handleAddTask(vault, { text: 'Later thing', section: '## Next' }, CONFIG, NOW);
    const lines = (await vault.readFile('10-Tasks/TASKS.md')).split('\n');

    const added = lines.findIndex(l => l.includes('Later thing'));
    const next = lines.findIndex(l => l.trim() === '## Next');
    const done = lines.findIndex(l => l.trim().startsWith('## Done'));
    expect(added).toBeGreaterThan(next);
    expect(added).toBeLessThan(done);
  });

  it('accepts a section name without the heading markers', async () => {
    const result = await handleAddTask(vault, { text: 'x', section: 'Next' }, CONFIG, NOW);
    expect(result.success).toBe(true);
  });

  it('removes the placeholder once a real task lands', async () => {
    await handleAddTask(vault, { text: 'Real work', section: '## Next' }, CONFIG, NOW);
    const content = await vault.readFile('10-Tasks/TASKS.md');

    expect(content).toContain('Real work');
    expect(content).not.toContain('_(nothing yet)_');
  });

  it('names the available sections when the requested one is missing', async () => {
    const result = await handleAddTask(vault, { text: 'x', section: '## Nowhere' }, CONFIG, NOW);

    expect(result.success).toBe(false);
    expect(result.error).toContain('## Now');
    expect(result.error).toContain('## Next');
  });

  it('flattens a multi-line task so the list structure survives', async () => {
    await handleAddTask(vault, { text: 'First\n  second' }, CONFIG, NOW);
    const content = await vault.readFile('10-Tasks/TASKS.md');

    expect(content).toContain('- [ ] First second (2026-07-28)');
  });

  it('fails clearly when the task list does not exist', async () => {
    const empty = new InMemoryVaultManager();
    const result = await handleAddTask(empty, { text: 'x' }, CONFIG, NOW);

    expect(result.success).toBe(false);
    expect(result.error).toContain('TASKS_PATH');
  });
});
