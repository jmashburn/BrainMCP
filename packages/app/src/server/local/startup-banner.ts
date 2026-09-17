/**
 * The text printed when the local HTTP server starts.
 *
 * stdout is the log sink: whatever is printed here lands in `docker logs`,
 * `oc logs` or journald and is shipped to whatever aggregates them, where it
 * outlives rotating the value on the running process — and reading logs is a
 * much wider grant than reading secrets. So this function is not given the
 * client secret, or any other credential, and cannot print one.
 */
export interface StartupBannerInfo {
  baseUrl: string;
  vaultPath: string;
  clientId: string;
}

export function startupBanner({ baseUrl, vaultPath, clientId }: StartupBannerInfo): string {
  return `
╔═══════════════════════════════════════════════════════════╗
║  Obsidian MCP Server (OAuth 2.0 Protected)               ║
╠═══════════════════════════════════════════════════════════╣
║  Server:     ${baseUrl.padEnd(49)}║
║  Vault:      ${vaultPath.padEnd(49)}║
║  Client ID:  ${clientId.padEnd(49)}║
╚═══════════════════════════════════════════════════════════╝

OAuth 2.0 Endpoints:
  Authorization: ${baseUrl}/oauth/authorize
  Token:         ${baseUrl}/oauth/token
  Register:      ${baseUrl}/oauth/register
  Revoke:        ${baseUrl}/oauth/revoke
  Discovery:     ${baseUrl}/.well-known/oauth-authorization-server

MCP Endpoint (requires Bearer token):
  POST ${baseUrl}/mcp

Health Check:
  GET ${baseUrl}/health

Configure ChatGPT/Claude with:
  - Client ID: ${clientId}
  - Client Secret: (not printed — read OAUTH_CLIENT_SECRET from wherever you set it)
  - Authorization URL: ${baseUrl}/oauth/authorize
  - Token URL: ${baseUrl}/oauth/token
  `;
}
