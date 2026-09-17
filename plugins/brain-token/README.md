# Brain (token) plugin for Claude Code

Registers a [BrainMCP](../../README.md) server with Claude Code using a
**static bearer token** instead of the browser login that the
[`brain`](../brain/README.md) plugin uses.

Use this one to give several people their own credential. The server's
`MCP_STATIC_BEARER_TOKENS_RO` (read-only) and `MCP_STATIC_BEARER_TOKENS`
(read-write) are comma-separated lists, so each person can have a token that is
revoked by removing it from the list, without touching anyone else. The login
page cannot do that: it bottoms out in one shared token per access level.

## Install

```bash
claude plugin marketplace add jmashburn/BrainMCP
claude plugin install brain-token@brainmcp \
  --config url=https://brain.example.com/mcp \
  --config token=<the token you were given>
```

Both options are required. `url` is the server's **`/mcp` endpoint**, not the
site root. The token is stored in Claude Code's credential store, not in
`settings.json`, and `claude mcp get plugin:brain-token:brain` shows it as
`Authorization: [REDACTED]`.

There is no sign-in step: `claude mcp list` should show
`plugin:brain-token:brain … ✔ Connected` straight away. What Claude Code can do
is decided by which list the token is in — a read-only token gets only the tools
that search, list and read.

## Pick one plugin, not both

`brain` and `brain-token` register the same server, so installing both gives
Claude Code the same tools twice.

They also cannot be merged into one plugin with an optional token. When a
server entry has an `Authorization` header, Claude Code sends it and **disables
OAuth fallback** — even if the token was left unset. The header goes out empty,
the server answers 401, and no login page ever appears:

> Server rejected the configured Authorization header (HTTP 401) … OAuth
> fallback is disabled when headers.Authorization is set.

So the login flow and the token flow have to be separate plugins.

## For the person running the server

```bash
openssl rand -hex 32        # one per person
```

Add it to `MCP_STATIC_BEARER_TOKENS_RO` (comma-separated) and restart the
server — see
[Setting up a read-only token](../../README.md#setting-up-a-read-only-token).
To revoke someone, remove their token from the list and restart. Clients using
static tokens are not signed out by a restart; clients using the login are.

Read-only limits what a client can do, not what it can see: a read-only token
can still read every note in the vault.
