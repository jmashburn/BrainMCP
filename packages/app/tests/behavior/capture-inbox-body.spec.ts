import { describe, it, expect } from 'vitest';
import { InMemoryVaultManager } from '../support/doubles/in-memory-vault-manager.js';
import { handleCaptureInbox } from '@/mcp/handlers/convention-handlers';
import type { VaultConventionsConfig } from '@/services/vault-conventions';

const CONFIG: VaultConventionsConfig = {
  templatesDir: '90-Meta/templates',
  inboxDir: '00-Inbox',
  inboxTemplate: 'reference.md',
  tasksPath: '10-Tasks/TASKS.md',
  tasksDefaultSection: '## Now',
  source: 'spec',
};

const BODY = 'THE ONLY COPY OF THIS SENTENCE';

// A template a person fills in by hand: headings, no {{body}} slot.
const TEMPLATE_WITHOUT_BODY = ['# {{title}}', '', '## Summary', '', '## Notes', ''].join('\n');
const TEMPLATE_WITH_BODY = ['# {{title}}', '', '{{body}}', '', '## Links', ''].join('\n');

async function capture(template: string | null) {
  const vault = new InMemoryVaultManager();
  if (template !== null) await vault.writeFile('90-Meta/templates/reference.md', template);
  const result = await handleCaptureInbox(
    vault,
    { title: 'Load bearing thought', body: BODY },
    CONFIG,
  );
  return { result, written: await vault.readFile('00-Inbox/Load Bearing Thought.md') };
}

describe('capture-inbox never loses the body', () => {
  it('keeps the body when the template has no {{body}} slot', async () => {
    const { result, written } = await capture(TEMPLATE_WITHOUT_BODY);

    expect(result.success).toBe(true);
    expect(written).toContain(BODY);
  });

  it('still renders the rest of a template that has no {{body}} slot', async () => {
    const { written } = await capture(TEMPLATE_WITHOUT_BODY);

    expect(written).toContain('# Load bearing thought');
    expect(written).toContain('## Summary');
    expect(written.indexOf(BODY)).toBeGreaterThan(written.indexOf('## Notes'));
  });

  it('puts the body in the slot, once, when the template has one', async () => {
    const { written } = await capture(TEMPLATE_WITH_BODY);

    expect(written.split(BODY)).toHaveLength(2);
    expect(written.indexOf(BODY)).toBeLessThan(written.indexOf('## Links'));
  });

  it('keeps the body when there is no template at all', async () => {
    const { written } = await capture(null);

    expect(written).toContain(BODY);
  });
});
