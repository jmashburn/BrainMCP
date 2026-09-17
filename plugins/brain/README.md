# Brain plugin for Claude Code

Registers a [BrainMCP](../../README.md) server with Claude Code in one step,
instead of adding it by hand on every machine.

The plugin contains no server and no credentials. It is a pointer (the server
entry lives in `.claude-plugin/plugin.json` under `mcpServers`): you tell it
where your server is, and Claude Code signs in to it through the server's own
OAuth login the first time the tools are used.

## Install

```bash
claude plugin marketplace add jmashburn/BrainMCP
claude plugin install brain@brainmcp --config url=https://brain.example.com/mcp
```

`url` is required and is the server's **`/mcp` endpoint**, not the site root —
a client pointed at the root connects and then finds no tools.

From inside Claude Code the same thing is `/plugin marketplace add
jmashburn/BrainMCP`, then `/plugin install brain@brainmcp`, which prompts for
the URL.

A marketplace can be any git URL, so a mirror on a self-hosted GitLab works the
same way and uses your existing git credentials:

```bash
claude plugin marketplace add https://gitlab.example.com/me/BrainMCP.git
```

## Signing in

The server shows up in `claude mcp list` as `plugin:brain:brain` and reports
_Needs authentication_ until you sign in: run `/mcp` in Claude Code, pick it,
and complete the login in the browser with your login token.

Which token you use decides what Claude Code can do. The read-write token gives
it every tool; the read-only token gives it only the tools that search, list and
read, and the server refuses writes. See
[Read-only and read-write access](../../README.md#read-only-and-read-write-access).

## Updating the plugin

The plugin carries a `version`, and Claude Code treats an installed version as
current until that number changes. To ship a change to the plugin, bump
`version` in `.claude-plugin/plugin.json`; users then run `claude plugin
marketplace update brainmcp` and `claude plugin update brain@brainmcp`.

## Change the URL or remove it

```bash
claude plugin uninstall brain@brainmcp
claude plugin install brain@brainmcp --config url=https://new-host.example.com/mcp
```

Inside Claude Code, `/plugin` → the plugin → Configure does the same.

## Token instead of login?

To authenticate with a static bearer token — for example to give several people
their own revocable, read-only credential — install
[`brain-token`](../brain-token/README.md) **instead of** this plugin. The two
cannot be combined: an `Authorization` header in a server entry disables Claude
Code's OAuth fallback even when the token is left unset.

## Already connected another way?

One route to the server is enough. If the same server is already added as a
claude.ai connector, or with `claude mcp add`, installing this too gives Claude
Code the same tools twice under two names. Pick one.

Note that an `mcpServers` block in `~/.claude/settings.json` is **not** read by
Claude Code — servers come from `~/.claude.json` (what `claude mcp add` writes),
a project's `.mcp.json`, or a plugin like this one.
