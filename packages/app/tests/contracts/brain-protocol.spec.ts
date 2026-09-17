/**
 * Contract tests for the Brain orientation surface: the brain://protocol
 * resource, the brain-orient prompt, and the orient tool. Driven through the
 * real MCP SDK client over an in-memory transport so the tests exercise the
 * same list/read/get/call paths a connector uses.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerResources } from '@/mcp/resource-registrations';
import { registerPrompts } from '@/mcp/prompt-registrations';
import { registerOrientTool } from '@/mcp/orient-tool';
import { sanitizeToolsList } from '@/server/shared/mcp-routes';
import { BRAIN_PROTOCOL_PATH, BRAIN_PROTOCOL_URI } from '@/mcp/brain-protocol';
import { InMemoryVaultManager } from '../support/doubles/in-memory-vault-manager.js';

const PROTOCOL_MARKER = 'CANONICAL-PROTOCOL-MARKER';
const PROTOCOL_TEXT = `# Brain protocol\n\n${PROTOCOL_MARKER}\n\nSearch before asking.`;

function seededVault(overrides: Record<string, string> = {}): InMemoryVaultManager {
  return new InMemoryVaultManager({
    [BRAIN_PROTOCOL_PATH]: PROTOCOL_TEXT,
    '50-People/Jared.md': 'Jared is the owner. JARED-MARKER',
    '10-Tasks/TASKS.md': '- [ ] ship the thing TASK-MARKER',
    '70-Journal/2026-09-08.md': 'older journal JOURNAL-08',
    '70-Journal/2026-09-09.md': 'newest journal JOURNAL-09',
    '20-Projects/Sleeve Project.md': 'notes about the sleeve draft SLEEVE-MARKER',
    ...overrides,
  });
}

async function connect(vault: InMemoryVaultManager): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0', instructions: '' });
  registerResources(server, () => vault);
  registerPrompts(server);
  registerOrientTool(server, () => vault);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe('brain://protocol resource', () => {
  it('is listed in resources/list', async () => {
    const client = await connect(seededVault());
    const { resources } = await client.listResources();
    expect(resources.map(r => r.uri)).toContain(BRAIN_PROTOCOL_URI);
  });

  it('returns the live contents of the vault SKILL.md', async () => {
    const client = await connect(seededVault());
    const res = await client.readResource({ uri: BRAIN_PROTOCOL_URI });
    expect(res.contents[0].text).toContain(PROTOCOL_MARKER);
  });

  it('reflects edits to SKILL.md without a rebuild or hard-coded fallback', async () => {
    const vault = seededVault();
    const client = await connect(vault);
    await vault.writeFile(BRAIN_PROTOCOL_PATH, '# Brain protocol\n\nEDITED-MARKER');
    const res = await client.readResource({ uri: BRAIN_PROTOCOL_URI });
    expect(res.contents[0].text).toContain('EDITED-MARKER');
    expect(res.contents[0].text).not.toContain(PROTOCOL_MARKER);
  });

  it('fails clearly when SKILL.md is missing', async () => {
    const vault = new InMemoryVaultManager({ '10-Tasks/TASKS.md': 'x' });
    const client = await connect(vault);
    await expect(client.readResource({ uri: BRAIN_PROTOCOL_URI })).rejects.toThrow(/not found/i);
  });
});

describe('brain-orient prompt', () => {
  it('is listed in prompts/list', async () => {
    const client = await connect(seededVault());
    const { prompts } = await client.listPrompts();
    expect(prompts.map(p => p.name)).toContain('brain-orient');
  });

  it('points the client at the protocol resource and handles an optional topic', async () => {
    const client = await connect(seededVault());
    const withTopic = await client.getPrompt({
      name: 'brain-orient',
      arguments: { topic: 'sleeves' },
    });
    const text = withTopic.messages[0].content.text as string;
    expect(text).toContain(BRAIN_PROTOCOL_URI);
    expect(text).toContain('sleeves');

    const noTopic = await client.getPrompt({ name: 'brain-orient', arguments: {} });
    expect(noTopic.messages[0].content.text as string).toContain(BRAIN_PROTOCOL_URI);
  });
});

describe('orient tool', () => {
  it('is listed and its tools/list schema is ChatGPT-safe after sanitization', async () => {
    const client = await connect(seededVault());
    const { tools } = await client.listTools();
    const orient = tools.find(t => t.name === 'orient');
    expect(orient).toBeDefined();
    // Sanitize the raw list the way the HTTP transport does, then assert the
    // draft-07 marker and outputSchema are gone (the connector drops tools that
    // keep them).
    const message = { result: { tools } };
    sanitizeToolsList(message);
    const cleaned = message.result.tools.find(t => t.name === 'orient')!;
    expect(JSON.stringify(cleaned.inputSchema)).not.toContain('$schema');
    expect('outputSchema' in cleaned).toBe(false);
  });

  it('quick mode returns the protocol and the best topic note, without full orientation', async () => {
    const client = await connect(seededVault());
    const res = await client.callTool({
      name: 'orient',
      arguments: { topic: 'sleeve', mode: 'quick' },
    });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain(PROTOCOL_MARKER);
    expect(text).toContain('SLEEVE-MARKER');
    expect(text).not.toContain('TASK-MARKER');
    expect(text).not.toContain('JOURNAL-09');
    expect(text).not.toContain('JARED-MARKER');
  });

  it('substantive mode adds Jared, tasks, and recent journal', async () => {
    const client = await connect(seededVault());
    const res = await client.callTool({
      name: 'orient',
      arguments: { topic: 'sleeve', mode: 'substantive' },
    });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain(PROTOCOL_MARKER);
    expect(text).toContain('JARED-MARKER');
    expect(text).toContain('TASK-MARKER');
    expect(text).toContain('JOURNAL-09');
    expect(text).toContain('Sleeve Project.md');
  });

  it('defaults to quick when mode is omitted', async () => {
    const client = await connect(seededVault());
    const res = await client.callTool({ name: 'orient', arguments: { topic: 'sleeve' } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('mode: quick');
    expect(text).not.toContain('TASK-MARKER');
  });

  it('fails clearly when SKILL.md is missing', async () => {
    const vault = new InMemoryVaultManager({ '10-Tasks/TASKS.md': 'x' });
    const client = await connect(vault);
    const res = await client.callTool({ name: 'orient', arguments: { topic: 'x' } });
    // SDK surfaces a thrown handler as an error result.
    expect(res.isError).toBe(true);
  });

  it('only reads vault-relative internal paths (no traversal vectors)', () => {
    // orient takes a topic, never a path, and its fixed reads are vault-relative.
    // Guard against a regression that introduces a '..' path constant.
    const src = readFileSync(path.resolve(__dirname, '../../src/mcp/orient-tool.ts'), 'utf8');
    expect(src).not.toMatch(/\.\.\//);
  });
});
