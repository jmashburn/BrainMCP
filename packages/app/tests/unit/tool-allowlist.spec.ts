import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseExposedTools, applyToolAllowlist, READ_ONLY_TOOLS } from '@/mcp/tool-allowlist';
import { registerTools } from '@/mcp/tool-registrations';
import { InMemoryVaultManager } from '../support/doubles/in-memory-vault-manager.js';

describe('parseExposedTools', () => {
  it('returns null when unset, meaning register everything', () => {
    expect(parseExposedTools(undefined)).toBeNull();
    expect(parseExposedTools('')).toBeNull();
    expect(parseExposedTools('   ')).toBeNull();
  });

  it('parses and trims a comma-separated list', () => {
    const result = parseExposedTools('read-note, search-vault ,log-journal-entry');
    expect(result).toEqual(new Set(['read-note', 'search-vault', 'log-journal-entry']));
  });
});

function makeServer() {
  const registerTool = vi.fn();
  return { server: { registerTool } as unknown as McpServer, registerTool };
}

describe('applyToolAllowlist', () => {
  it('registers everything when no allowlist is configured', () => {
    const { server, registerTool } = makeServer();
    const wrapped = applyToolAllowlist(server, undefined);

    wrapped.registerTool('read-note', {} as never, (() => {}) as never);
    wrapped.registerTool('delete-note', {} as never, (() => {}) as never);

    expect(registerTool).toHaveBeenCalledTimes(2);
  });

  it('registers only allowlisted tools', () => {
    const { server, registerTool } = makeServer();
    const wrapped = applyToolAllowlist(server, 'read-note,search-vault');

    wrapped.registerTool('read-note', {} as never, (() => {}) as never);
    wrapped.registerTool('search-vault', {} as never, (() => {}) as never);
    wrapped.registerTool('delete-note', {} as never, (() => {}) as never);

    expect(registerTool).toHaveBeenCalledTimes(2);
    const names = registerTool.mock.calls.map(c => c[0]);
    expect(names).toEqual(['read-note', 'search-vault']);
    expect(names).not.toContain('delete-note');
  });

  it('omits a skipped tool entirely rather than refusing it on call', () => {
    // A tool absent from tools/list is one the model cannot be talked into using.
    const { server, registerTool } = makeServer();
    const wrapped = applyToolAllowlist(server, 'read-note');

    wrapped.registerTool('delete-note', {} as never, (() => {}) as never);

    expect(registerTool).not.toHaveBeenCalledWith(
      'delete-note',
      expect.anything(),
      expect.anything(),
    );
  });

  it('passes through non-registerTool members untouched', () => {
    const connect = vi.fn();
    const server = { registerTool: vi.fn(), connect } as unknown as McpServer;
    const wrapped = applyToolAllowlist(server, 'read-note');

    (wrapped as unknown as { connect: () => void }).connect();

    expect(connect).toHaveBeenCalled();
  });
});

const register = (wrapped: McpServer, name: string) =>
  wrapped.registerTool(name, {} as never, (() => {}) as never);

describe('applyToolAllowlist with read access', () => {
  it('registers only read-only tools', () => {
    const { server, registerTool } = makeServer();
    const wrapped = applyToolAllowlist(server, undefined, 'read');

    register(wrapped, 'read-note');
    register(wrapped, 'search-vault');
    register(wrapped, 'create-note');
    register(wrapped, 'delete-note');

    expect(registerTool.mock.calls.map(c => c[0])).toEqual(['read-note', 'search-vault']);
  });

  it('can be narrowed further by EXPOSED_TOOLS', () => {
    const { server, registerTool } = makeServer();
    const wrapped = applyToolAllowlist(server, 'read-note,create-note', 'read');

    register(wrapped, 'read-note');
    register(wrapped, 'search-vault');
    register(wrapped, 'create-note');

    expect(registerTool.mock.calls.map(c => c[0])).toEqual(['read-note']);
  });

  it('cannot be widened by EXPOSED_TOOLS naming a write tool', () => {
    const { server, registerTool } = makeServer();
    const wrapped = applyToolAllowlist(server, 'delete-note', 'read');

    register(wrapped, 'delete-note');

    expect(registerTool).not.toHaveBeenCalled();
  });

  it('leaves write access unfiltered', () => {
    const { server, registerTool } = makeServer();
    const wrapped = applyToolAllowlist(server, undefined, 'write');

    register(wrapped, 'delete-note');

    expect(registerTool).toHaveBeenCalledTimes(1);
  });
});

describe('READ_ONLY_TOOLS', () => {
  // Access is decided by the explicit list, and clients are advised by the
  // hint. If the two drift, a client is told a tool is safe that a read token
  // cannot call — or, worse, a writing tool is labelled read-only.
  it('matches exactly the tools registered with readOnlyHint', () => {
    const { server, registerTool } = makeServer();
    registerTools(server, () => new InMemoryVaultManager());

    const hinted = registerTool.mock.calls
      .filter(([, config]) => config?.annotations?.readOnlyHint === true)
      .map(([name]) => name)
      .sort();

    expect(hinted).toEqual([...READ_ONLY_TOOLS].sort());
  });

  it('contains no tool marked destructive', () => {
    const { server, registerTool } = makeServer();
    registerTools(server, () => new InMemoryVaultManager());

    const destructive = registerTool.mock.calls
      .filter(([, config]) => config?.annotations?.destructiveHint === true)
      .map(([name]) => name);

    expect(destructive.filter(name => READ_ONLY_TOOLS.has(name))).toEqual([]);
  });
});
