import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseExposedTools, applyToolAllowlist } from '@/mcp/tool-allowlist';

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
