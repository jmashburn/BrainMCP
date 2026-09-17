/**
 * Access levels.
 *
 * A credential grants either read access or read-and-write access to the
 * vault. The level is decided where the credential is proven (the login page
 * or a static bearer token), carried as an OAuth scope on issued tokens, and
 * enforced twice: read sessions are never offered a write tool, and the vault
 * they are handed refuses writes.
 */

export type AccessLevel = 'read' | 'write';

export const SCOPE_READ = 'vault:read';
export const SCOPE_WRITE = 'vault:write';
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE];

export function scopeFor(access: AccessLevel): string {
  return access === 'write' ? `${SCOPE_READ} ${SCOPE_WRITE}` : SCOPE_READ;
}

/**
 * Anything that does not explicitly carry the write scope is read-only, so a
 * record with a missing or unrecognised scope fails closed.
 */
export function accessFromScope(scope: string | undefined | null): AccessLevel {
  return (scope ?? '').split(/\s+/).includes(SCOPE_WRITE) ? 'write' : 'read';
}

/**
 * The access to grant when a client asked for specific scopes. A client may
 * narrow what the credential allows, never widen it. Scopes we do not define
 * are ignored rather than rejected: connectors routinely send their own.
 */
export function narrowAccess(allowed: AccessLevel, requestedScope?: string | null): AccessLevel {
  if (allowed === 'read') return 'read';
  const requested = (requestedScope ?? '').split(/\s+/).filter(s => SUPPORTED_SCOPES.includes(s));
  if (requested.length === 0) return allowed;
  return requested.includes(SCOPE_WRITE) ? 'write' : 'read';
}

const listOf = (raw: string | undefined): string[] =>
  (raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

export interface AccessConfigReport {
  loginWrite: boolean;
  loginRead: boolean;
  staticWrite: number;
  staticRead: number;
  /** Human-readable misconfigurations. Never contains a credential. */
  problems: string[];
}

/**
 * What is configured, for the startup log. A credential listed at both levels
 * resolves to read-only, which silently removes write access from whoever
 * expected it — worth saying out loud.
 */
export function describeAccessConfig(env: NodeJS.ProcessEnv = process.env): AccessConfigReport {
  const staticWrite = listOf(env.MCP_STATIC_BEARER_TOKENS);
  const staticRead = listOf(env.MCP_STATIC_BEARER_TOKENS_RO);
  const problems: string[] = [];

  if (env.PERSONAL_AUTH_TOKEN && env.PERSONAL_AUTH_TOKEN === env.PERSONAL_AUTH_TOKEN_RO) {
    problems.push(
      'PERSONAL_AUTH_TOKEN and PERSONAL_AUTH_TOKEN_RO are identical: every login is read-only',
    );
  }
  const overlap = staticWrite.filter(t => staticRead.includes(t)).length;
  if (overlap > 0) {
    problems.push(
      `${overlap} token(s) appear in both MCP_STATIC_BEARER_TOKENS and MCP_STATIC_BEARER_TOKENS_RO: they are read-only`,
    );
  }

  return {
    loginWrite: Boolean(env.PERSONAL_AUTH_TOKEN),
    loginRead: Boolean(env.PERSONAL_AUTH_TOKEN_RO),
    staticWrite: staticWrite.length,
    staticRead: staticRead.length,
    problems,
  };
}
