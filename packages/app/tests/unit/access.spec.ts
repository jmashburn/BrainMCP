import { describe, it, expect } from 'vitest';
import {
  scopeFor,
  accessFromScope,
  narrowAccess,
  describeAccessConfig,
  SCOPE_READ,
  SCOPE_WRITE,
} from '@/services/access';

describe('scopeFor', () => {
  it('gives write access both scopes', () => {
    expect(scopeFor('write')).toBe(`${SCOPE_READ} ${SCOPE_WRITE}`);
  });

  it('gives read access only the read scope', () => {
    expect(scopeFor('read')).toBe(SCOPE_READ);
  });
});

describe('accessFromScope', () => {
  it('reads write access from a scope that includes vault:write', () => {
    expect(accessFromScope('vault:read vault:write')).toBe('write');
  });

  it('reads a read-only scope as read', () => {
    expect(accessFromScope('vault:read')).toBe('read');
  });

  it('fails closed when the scope is missing or unrecognised', () => {
    expect(accessFromScope(undefined)).toBe('read');
    expect(accessFromScope(null)).toBe('read');
    expect(accessFromScope('')).toBe('read');
    expect(accessFromScope('admin everything')).toBe('read');
  });

  it('does not match a scope that merely contains the write scope as a substring', () => {
    expect(accessFromScope('vault:writeonly')).toBe('read');
  });
});

describe('narrowAccess', () => {
  it('keeps the allowed access when the client asked for nothing', () => {
    expect(narrowAccess('write', undefined)).toBe('write');
    expect(narrowAccess('read', undefined)).toBe('read');
  });

  it('narrows write to read when the client asked only to read', () => {
    expect(narrowAccess('write', 'vault:read')).toBe('read');
  });

  it('never widens read, whatever the client asks for', () => {
    expect(narrowAccess('read', 'vault:read vault:write')).toBe('read');
  });

  it('ignores scopes it does not define rather than narrowing on them', () => {
    expect(narrowAccess('write', 'openid profile claudeai')).toBe('write');
  });
});

describe('describeAccessConfig', () => {
  it('counts what is configured without echoing any credential', () => {
    const report = describeAccessConfig({
      PERSONAL_AUTH_TOKEN: 'rw-secret',
      PERSONAL_AUTH_TOKEN_RO: 'ro-secret',
      MCP_STATIC_BEARER_TOKENS: 'a, b',
      MCP_STATIC_BEARER_TOKENS_RO: 'c',
    });

    expect(report).toEqual({
      loginWrite: true,
      loginRead: true,
      staticWrite: 2,
      staticRead: 1,
      problems: [],
    });
  });

  it('reports identical login tokens, which make every login read-only', () => {
    const report = describeAccessConfig({
      PERSONAL_AUTH_TOKEN: 'same',
      PERSONAL_AUTH_TOKEN_RO: 'same',
    });

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).not.toContain('same');
  });

  it('reports a static token listed at both levels', () => {
    const report = describeAccessConfig({
      MCP_STATIC_BEARER_TOKENS: 'shared-token,other',
      MCP_STATIC_BEARER_TOKENS_RO: 'shared-token',
    });

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).not.toContain('shared-token');
  });
});
