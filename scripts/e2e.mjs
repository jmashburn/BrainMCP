/**
 * End-to-end check against a real git clone.
 *
 * Set E2E_DOCKER_IMAGE to run the server from a built image instead of tsx —
 * the same checks against the artefact that actually gets deployed, which is
 * where packaging problems (missing runtime deps, a missing gitleaks binary)
 * show up and a source-tree run cannot.
 *
 * The unit and behaviour suites run against an in-memory vault, so the git path
 * — clone, core.hooksPath, commit, push — and the guards' behaviour through a
 * real MCP client are not covered by them. This drives the actual stdio server
 * over the actual protocol against a throwaway repo on disk.
 *
 * Self-contained: builds its own bare repo and vault fixture in a temp dir.
 *
 *   node scripts/e2e.mjs          # E2E_KEEP=1 to keep the fixture for inspection
 *
 * Requires `gitleaks` on PATH for the secret-scanning check.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2E = mkdtempSync(path.join(tmpdir(), 'brain-mcp-e2e-'));
const KEEP = process.env.E2E_KEEP === '1';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// ---------------------------------------------------------------- fixture ---

const HOOK = `#!/usr/bin/env bash
# Fails closed: a scanner that silently passes when missing looks like it ran.
set -uo pipefail
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "pre-commit: gitleaks is not installed." >&2
  exit 1
fi
if ! gitleaks git --staged --no-banner --redact >/dev/null 2>&1; then
  echo "pre-commit: gitleaks found secrets in the staged changes." >&2
  exit 1
fi
exit 0
`;

const FILES = {
  'CLAUDE.md': '# Agent protocol\n\nRead this first.\n',
  'README.md': '# Vault\n\nOrganisation guidelines live here.\n',
  '.githooks/pre-commit': HOOK,
  '90-Meta/templates/reference.md':
    '---\ntype: reference\nstatus: active\ncreated: {{date}}\n---\n\n# {{title}}\n\n{{body}}\n',
  '90-Meta/templates/daily.md':
    '---\ntype: daily\ncreated: {{date}}\n---\n\n# {{date}}\n\n## Claude session\n\n',
  '10-Tasks/TASKS.md': '# Tasks\n\n## Now\n\n_(nothing yet)_\n\n## Next\n\n_(nothing yet)_\n',
  '00-Inbox/.gitkeep': '',
  '70-Journal/.gitkeep': '',
};

function buildFixture() {
  git(['init', '-q', '--bare', path.join(E2E, 'vault.git')], E2E);
  const seed = path.join(E2E, 'seed');
  mkdirSync(seed);

  for (const [rel, body] of Object.entries(FILES)) {
    const full = path.join(seed, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  chmodSync(path.join(seed, '.githooks/pre-commit'), 0o755);

  git(['init', '-q', '-b', 'main'], seed);
  // Scaffolding, not a commit under test: don't run the hook or sign it.
  git(['config', 'core.hooksPath', '.git/hooks'], seed);
  git(['config', 'commit.gpgsign', 'false'], seed);
  git(['config', 'user.email', 'e2e@example.com'], seed);
  git(['config', 'user.name', 'e2e'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'seed vault'], seed);
  git(['push', '-q', path.join(E2E, 'vault.git'), 'main'], seed);
}

buildFixture();
console.log(`fixture: ${E2E}`);
if (process.env.E2E_DOCKER_IMAGE) console.log(`server: docker ${process.env.E2E_DOCKER_IMAGE}`);

// ----------------------------------------------------------------- server ---

const IMAGE = process.env.E2E_DOCKER_IMAGE;

// Hooks inherit the server's environment, so whatever a hook needs must be
// findable on PATH there. In the container that's the image's own PATH.
const serverEnv = {
  VAULT_REPO: `file://${E2E}/vault.git`,
  VAULT_BRANCH: 'main',
  GIT_TOKEN: 'unused-for-file-urls',
  GIT_USERNAME: 'e2e',
  LOCAL_VAULT_PATH: `${E2E}/clone`,
  VAULT_HOOKS_PATH: '.githooks',
  JOURNAL_PATH_TEMPLATE: '70-Journal/{{date}}.md',
  JOURNAL_DATE_FORMAT: 'YYYY-MM-DD',
  JOURNAL_ACTIVITY_SECTION: '## Claude session',
  JOURNAL_FILE_TEMPLATE: '90-Meta/templates/daily.md',
  JOURNAL_ENTRY_STYLE: 'bullet',
  TEMPLATES_DIR: '90-Meta/templates',
  INBOX_DIR: '00-Inbox',
  INBOX_TEMPLATE: 'reference.md',
  TASKS_PATH: '10-Tasks/TASKS.md',
  TASKS_DEFAULT_SECTION: '## Now',
  NOTE_SOURCE: 'e2e-client',
  EXPOSED_TOOLS:
    'read-note,search-vault,list-files-in-vault,capture-inbox,add-task,log-journal-entry,create-note',
};

// Mount the fixture at the same path inside the container so file:// URLs and
// LOCAL_VAULT_PATH mean the same thing on both sides. Run as the invoking user
// so pushed objects aren't left root-owned in the host fixture.
const dockerArgs = () => [
  'run',
  '--rm',
  '-i',
  '--user',
  `${process.getuid()}:${process.getgid()}`,
  '-e',
  'HOME=/tmp',
  '-v',
  `${E2E}:${E2E}`,
  ...Object.entries(serverEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
  IMAGE,
  'stdio',
];

const transport = new StdioClientTransport(
  IMAGE
    ? { command: 'docker', args: dockerArgs(), env: { PATH: process.env.PATH } }
    : {
        // cwd must be packages/app so tsx resolves the '@/' aliases, as `npm run dev` does.
        command: 'npx',
        args: ['tsx', 'src/server/local/stdio.ts'],
        cwd: path.join(REPO, 'packages', 'app'),
        env: { ...process.env, ...serverEnv },
      },
);

const client = new Client({ name: 'e2e', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* error responses are plain text */
  }
  return { text, parsed, isError: r.isError === true };
};

try {
  console.log('\n--- tools/list ---');
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name).sort();
  console.log('  exposed:', names.join(', '));
  check('allowlist hides delete-note', !names.includes('delete-note'));
  check('allowlist hides move-note', !names.includes('move-note'));
  check('capture-inbox is exposed', names.includes('capture-inbox'));
  check('add-task is exposed', names.includes('add-task'));

  console.log('\n--- capture-inbox ---');
  const cap = await call('capture-inbox', {
    title: 'rate limiting idea',
    body: 'Token bucket per client.',
    tags: ['infra'],
  });
  check('capture succeeded', cap.parsed?.success === true, cap.text.slice(0, 120));
  check(
    'Title Case filename in the inbox',
    cap.parsed?.path === '00-Inbox/Rate Limiting Idea.md',
    cap.parsed?.path,
  );

  // The vault is cloned lazily on the first tool call, so anything inspecting
  // the clone must come after one.
  console.log('\n--- clone + hooks ---');
  const hooksPath = git(['config', '--get', 'core.hooksPath'], `${E2E}/clone`);
  check('core.hooksPath applied to the clone', hooksPath === '.githooks', `got "${hooksPath}"`);

  const note =
    (await call('read-note', { path: '00-Inbox/Rate Limiting Idea.md' })).parsed?.content ?? '';
  check('template applied', /type:\s*reference/.test(note) && /status:\s*active/.test(note));
  check('provenance recorded', /source:\s*e2e-client/.test(note) && /via:\s*brain-mcp/.test(note));
  check('tags rendered', /tags:\s*\[infra\]/.test(note));

  console.log('\n--- git actually committed and pushed ---');
  check(
    'commit reached the remote',
    /Rate Limiting Idea|Update file/.test(
      git(['log', '--oneline', '-1', 'main'], `${E2E}/vault.git`),
    ),
  );
  check(
    'note present on the remote',
    git(['ls-tree', '-r', '--name-only', 'main'], `${E2E}/vault.git`).includes(
      '00-Inbox/Rate Limiting Idea.md',
    ),
  );

  console.log('\n--- add-task ---');
  const task = await call('add-task', { text: 'Prove the hook fires' });
  check('add-task succeeded', task.parsed?.success === true, task.text.slice(0, 100));
  const tasks = (await call('read-note', { path: '10-Tasks/TASKS.md' })).parsed?.content ?? '';
  check(
    'dated unchecked task written',
    /- \[ \] Prove the hook fires \(\d{4}-\d{2}-\d{2}\)/.test(tasks),
  );
  check('placeholder cleared', !/## Now\n\n_\(nothing yet\)_/.test(tasks));

  console.log('\n--- journal (bullet style) ---');
  const jr = await call('log-journal-entry', {
    activity_type: 'development',
    summary: 'Ran the end-to-end suite.',
    key_topics: ['mcp', 'git'],
  });
  check('journal entry succeeded', jr.parsed?.success === true, jr.text.slice(0, 100));
  const today = new Date().toISOString().slice(0, 10);
  const journal =
    (await call('read-note', { path: `70-Journal/${today}.md` })).parsed?.content ?? '';
  check('daily note created from template', journal.includes('## Claude session'));
  check(
    'bullet style, not the detailed block',
    new RegExp(`- ${today} — Ran the end-to-end suite\\.`).test(journal) &&
      !journal.includes('###'),
    journal.split('\n').find(l => l.startsWith('- 2')) ?? '(no bullet)',
  );

  // Vault-root operations pass an empty path. Exercised here because a guard
  // that rejects empty paths breaks listing and search while every write-path
  // test still passes.
  console.log('\n--- vault-root reads ---');
  const listed = await call('list-files-in-vault', {});
  check('list-files-in-vault works', !listed.isError, listed.text.slice(0, 80));
  check('listing includes a seeded note', /TASKS\.md/.test(listed.text));
  const found = await call('search-vault', { query: 'Organisation' });
  check('search-vault works', !found.isError, found.text.slice(0, 80));
  check('search finds README content', /README/i.test(found.text));

  console.log('\n--- protected paths ---');
  for (const p of ['CLAUDE.md', 'README.md', '.githooks/pre-commit']) {
    const r = await call('create-note', { path: p, content: 'pwned', overwrite: true });
    check(`write to ${p} refused`, /protected path/i.test(r.text));
  }

  console.log('\n--- path traversal ---');
  const trav = await call('create-note', { path: '../../escaped.md', content: 'x' });
  check(
    'traversal refused',
    /escapes the vault|not allowed/i.test(trav.text),
    trav.text.slice(0, 80),
  );

  console.log("\n--- the vault's own hook, on a server-side commit ---");
  // Random, not a placeholder: gitleaks allowlists obviously-fake tokens, so a
  // synthetic value passes and the control looks broken when it isn't.
  const token =
    'ghp_' +
    Buffer.from(`${Math.random()}${Date.now()}`)
      .toString('base64')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 36);
  const leak = await call('create-note', {
    path: '00-Inbox/Leak.md',
    content: `token = "${token}"\n`,
  });
  check(
    'commit containing a secret is refused by the vault hook',
    leak.isError || leak.parsed?.success !== true,
    /gitleaks found secrets/.test(leak.text) ? 'gitleaks fired' : leak.text.slice(0, 80),
  );
  check(
    'leaked note did NOT reach the remote',
    !git(['ls-tree', '-r', '--name-only', 'main'], `${E2E}/vault.git`).includes('00-Inbox/Leak.md'),
  );

  console.log('\n--- guidance resource ---');
  const res = await client.readResource({ uri: 'obsidian://vault-readme' });
  const guidance = res.contents?.[0]?.text ?? '';
  check(
    'serves guidance from both README.md and CLAUDE.md',
    guidance.includes('Agent protocol') && guidance.includes('Organisation guidelines'),
  );
} finally {
  await client.close();
  if (KEEP) console.log(`\nfixture kept at ${E2E}`);
  else rmSync(E2E, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
