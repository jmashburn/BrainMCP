# Brain orientation: protocol, prompt, and the `orient` tool

The vault teaches clients how to use it. The canonical, human-editable agent
protocol lives **in the vault** at `90-Meta/skills/Brain/SKILL.md` — not in this
server's code. Editing that note changes how every client is guided, with no
rebuild. The server exposes it three complementary ways so clients of different
capability all get oriented.

## Canonical source

`90-Meta/skills/Brain/SKILL.md` is the single source of truth: how to orient,
what goes in which folder, the note conventions, and the write-back rules. The
server reads it at runtime. If it is missing, the resource and the `orient`
tool return a clear error rather than substituting stale hard-coded text.

## Three ways in (fallback order)

1. **Resource `brain://protocol`** — for clients that consume MCP resources.
   Returns the live contents of `SKILL.md`. Listed in `resources/list`.
2. **Prompt `brain-orient`** — for clients that consume MCP prompts. A short
   prompt that tells the client to read `brain://protocol` and, given an
   optional `topic`, to pull relevant context before asking. Listed in
   `prompts/list`.
3. **Tool `orient`** — for tool-only clients (e.g. the ChatGPT connector) that
   never invoke prompts or resources automatically. A single call returns the
   protocol plus a right-sized context package.

Narrow tasks can still skip orientation and use `search`/`read-note` directly;
the tool descriptions hint at this.

## `orient` tool

Input:

```jsonc
{ "topic": "sleeve drafting", "mode": "quick" | "substantive" }
```

- **quick** (default): protocol + the best matching note(s) for `topic`. For
  narrow capture/updates. Does not load tasks, journal, or the owner profile.
- **substantive**: protocol + owner note (`50-People/Jared.md`) + active tasks
  (`10-Tasks/TASKS.md`) + the most recent 1–2 journal notes + relevant notes for
  `topic` (listed by path so the client fetches what it needs).
- **mode omitted** defaults to `quick` — the cheapest safe path; avoids
  excessive reads when the request is ambiguous.

`orient` reuses the existing search/read handlers and the `VaultManager`, so it
inherits the same path guards and protections and adds no new vault access. It
is registered on every transport (stdio, HTTP, Lambda) — nothing about it is
HTTP-specific. Like the connector `search`/`fetch` tools, it is not subject to
`EXPOSED_TOOLS` (it registers on the raw server), so it is always available.

## ChatGPT connector compatibility

`orient`'s schema goes through the same `tools/list` sanitization as every other
tool: the draft-07 `$schema` marker and `outputSchema` are stripped on the way
out, which the OpenAI connector requires. The connector `search`/`fetch` tools,
stateful HTTP sessions, GET event stream, OAuth, Basic client auth, and static
bearer support are all unchanged.
