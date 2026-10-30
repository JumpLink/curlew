// Smoke test: the curlew MCP stdio server runs natively on GJS and answers a real
// `initialize` + `tools/list` + `tools/call` handshake driven by the MCP SDK client, EXITS when
// its client goes away, and DROPS a tool that declares itself mutating.
//
// Launched via `gjsify run` (the production entry): it resolves every dependency's native
// prebuild paths on its own and keeps stdout uncontaminated (its banner goes to stderr), so we
// spawn it with a CLEAN env — no manual LD_LIBRARY_PATH / GI_TYPELIB_PATH. A green run proves
// no launcher wrapper is needed.
//
// Prerequisite: `gjsify install` + `gjsify workspace curlew-cli build`, and gjs on PATH.
// Run with: `node app/tests/integration/mcp-gjs-smoke.mjs`.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..', '..'); // tests/integration -> app
const repoRoot = join(appRoot, '..'); // app -> repo root
const bundle = join(appRoot, 'dist', 'curlew.gjs.mjs');
assert(existsSync(bundle), 'build first — app/dist/curlew.gjs.mjs missing');

// The gjsify bin lives in the WORKSPACE ROOT's node_modules, not app/'s.
const gjsify = join(repoRoot, 'node_modules', '.bin', 'gjsify');
assert(existsSync(gjsify), 'run `gjsify install` first — @gjsify/cli bin missing');

// Clean env: strip native paths so success proves `gjsify run` resolves them itself.
const env = { ...process.env };
delete env.LD_LIBRARY_PATH;
delete env.GI_TYPELIB_PATH;
// Never the real config: grants in it would change the catalogue. No file = no grants.
const scratch = mkdtempSync(join(tmpdir(), 'curlew-mcp-'));
env.CURLEW_CONFIG = join(scratch, 'none.json');

// Sorted, because the comparison below is a sorted deepEqual — the ordering is the assertion.
// `setup_run` is deliberately ABSENT: it declares `readOnlyHint: false`, so the gate must drop it
// on this default connection. It appears only in the ungated run further down, and its presence
// there is what makes its absence here mean something.
const EXPECTED_TOOLS = [
  'accounts_list',
  'calendar_list_events',
  'contacts_search',
  'conversations_get',
  'conversations_list',
  'mail_get_message',
  'mail_list_folders',
  'mail_list_parts',
  'mail_save_attachment',
  'mail_search',
  'mail_search_local',
  'mail_sync_status',
  'messaging_capabilities',
  'omemo_devices',
  'setup_status',
  'xmpp_wait_reply',
];

// ── 1. handshake, catalogue, and one real call ──────────────────────────────

const transport = new StdioClientTransport({
  command: gjsify,
  args: ['run', bundle, 'mcp'],
  env,
  cwd: appRoot,
  stderr: 'inherit',
});

const client = new Client({ name: 'gjs-smoke', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const info = client.getServerVersion();
assert.equal(info?.name, 'curlew', `unexpected server name: ${info?.name}`);

const { tools } = await client.listTools();
assert.deepEqual(
  tools.map((t) => t.name).sort(),
  EXPECTED_TOOLS,
  'tool catalogue drifted — update EXPECTED_TOOLS deliberately, it is the client contract',
);

// The read-only promise, asserted ON THE WIRE rather than in the source: this is what an MCP
// client actually sees. A tool that lost its annotation would have been dropped by the gate and
// failed the catalogue check above; one that gained `readOnlyHint: false` fails here.
for (const tool of tools) {
  assert.equal(tool.annotations?.readOnlyHint, true, `tool ${tool.name} is not marked read-only`);
}
console.log(`OK: MCP stdio server on GJS — ${tools.length} read-only tools (${info.name} ${info.version})`);

// A real tools/call. Tolerate environments without GOA (headless CI has no session bus): we
// assert the server answers with a well-formed result, not that it succeeds.
const res = await client.callTool({ name: 'accounts_list', arguments: {} });
assert(Array.isArray(res.content) && res.content.length > 0, 'accounts_list returned no content');
if (res.isError) {
  console.log(
    `OK: accounts_list callable (GOA unavailable here: ${String(res.content[0].text).slice(0, 80)})`,
  );
} else {
  const payload = JSON.parse(res.content[0].text);
  assert(Array.isArray(payload.accounts), 'expected an accounts array');
  console.log(`OK: accounts_list → ${payload.accounts.length} account(s)`);
}

await client.close();

// ── 2. the server exits when its client goes away ───────────────────────────
//
// A regression test, not a nicety. The obvious park — `await new Promise(() => {})` — is
// unsettleable, so a server whose client died kept running forever; such processes were found
// REPARENTED TO `systemd --user`, which only happens once their spawner is gone. The SDK will
// not report EOF (its StdioServerTransport listens for `data`/`error` only), so this is the
// server author's job and nothing else would catch a regression.
//
// Driven with a raw spawn on purpose: StdioClientTransport.close() KILLS the child, which would
// pass whether or not EOF is handled.

const child = spawn(gjsify, ['run', bundle, 'mcp'], {
  env,
  cwd: appRoot,
  stdio: ['pipe', 'pipe', 'inherit'],
});
const exitedEarly = await Promise.race([
  new Promise((r) => child.once('exit', (code) => r(`exited early with ${code}`))),
  new Promise((r) => setTimeout(() => r(null), 4000)),
]);
assert.equal(exitedEarly, null, `server did not stay up while stdin was open: ${exitedEarly}`);

child.stdin.end(); // EOF — "your client is gone"
const outcome = await Promise.race([
  new Promise((r) => child.once('exit', (code) => r(code))),
  new Promise((r) => setTimeout(() => r('timeout'), 15000)),
]);
if (outcome === 'timeout') {
  child.kill('SIGKILL');
  assert.fail('server did not exit within 15s of stdin EOF — it would be orphaned');
}
assert.equal(outcome, 0, `server exited with ${outcome} on stdin EOF, expected 0`);
console.log('OK: server exits cleanly on stdin EOF (no orphan)');

// ── 3. the read-only gate actually CLOSES ─────────────────────────────────────
//
// Section 1 asserts every served tool is read-only. That is necessary and NOT sufficient: all
// twelve real tools declare `readOnlyHint: true`, so a gate that had quietly stopped wrapping
// `registerTool` would serve exactly the same catalogue and section 1 would still pass. It
// cannot distinguish a working gate from no gate at all.
//
// So ask the gate to do the thing it exists for. `CURLEW_MCP_GATE_CANARY=1` registers two
// tools that must be dropped, through the same `server.registerTool` the real tools use, after
// the gate has wrapped it.
//
// TWO runs, and the second is the point. "Canary absent" alone is worthless evidence: it is
// equally consistent with the gate dropping it and with the canary never being registered. The
// run with writes ALLOWED must show the canary present, which is what proves the first run's
// absence was the gate acting rather than nothing happening.

async function listToolNames(extraEnv) {
  const t = new StdioClientTransport({
    command: gjsify,
    args: ['run', bundle, 'mcp'],
    env: { ...env, ...extraEnv },
    cwd: appRoot,
    stderr: 'inherit',
  });
  const c = new Client({ name: 'gate-probe', version: '1.0.0' }, { capabilities: {} });
  await c.connect(t);
  const { tools: list } = await c.listTools();
  await c.close();
  return list.map((x) => x.name).sort();
}

// Four canaries (ADR 0004 §3). Three must be dropped, and they fail for DIFFERENT reasons — see
// gate-canary.ts: declared mutating, unannotated, and a capability nobody granted. The fourth is
// the positive control: it declares `canary.write`, is served only when that grant exists, and
// without it a gate that dropped everything would pass the other three.
const DROPPED = ['gate_canary_write', 'gate_canary_unannotated', 'gate_canary_ungranted'];
const CONTROL = 'gate_canary_granted';

const gated = await listToolNames({ CURLEW_MCP_GATE_CANARY: '1' });
for (const canary of [...DROPPED, CONTROL]) {
  assert(!gated.includes(canary), `GATE IS OPEN: ${canary} was served without a grant — ${gated.join(', ')}`);
}
assert(!gated.includes('setup_run'), `GATE IS OPEN: setup_run was served — ${gated.join(', ')}`);
assert(
  !gated.includes('send_message'),
  `GATE IS OPEN: send_message was served with no <backend>.send grant — ${gated.join(', ')}`,
);
assert(gated.includes('setup_status'), 'setup_status must be served: it declares itself read-only');
assert.deepEqual(gated, EXPECTED_TOOLS, 'gated catalogue drifted');
console.log(
  `OK: without a grant the gate DROPS all canaries, setup_run and send_message (${gated.length} tools)`,
);

// With grants: the positive control and send_message appear, the other three still do not.
const grantsFile = join(scratch, 'granted.json');
writeFileSync(
  grantsFile,
  JSON.stringify({
    backends: {},
    grants: [
      { capability: 'canary.write', target: 'canary' },
      { capability: 'xmpp.send', target: 'xmpp-abc123/owner@example.org' },
    ],
  }),
);
const granted = await listToolNames({ CURLEW_MCP_GATE_CANARY: '1', CURLEW_CONFIG: grantsFile });
assert(
  granted.includes(CONTROL),
  `${CONTROL} never served — the gate drops everything (${granted.join(', ')})`,
);
assert(
  granted.includes('send_message'),
  `send_message not served with an xmpp.send grant (${granted.join(', ')})`,
);
for (const canary of DROPPED) {
  assert(!granted.includes(canary), `GATE IS OPEN: ${canary} was served — ${granted.join(', ')}`);
}
assert(!granted.includes('setup_run'), 'setup_run must stay dropped without MCP_ALLOW_WRITE');
console.log(
  `OK: with grants the positive control and send_message are served, the other canaries stay dropped`,
);

// Any `<backend>.send` grant serves send_message, not only XMPP's: the tool is gated by the union,
// the action then checks the exact backend's capability. A mail-only config is the proof.
const mailGrantsFile = join(scratch, 'granted-mail.json');
writeFileSync(
  mailGrantsFile,
  JSON.stringify({
    backends: {},
    grants: [{ capability: 'mail.send', target: 'goa-account-1/owner@example.org' }],
  }),
);
const mailGranted = await listToolNames({ CURLEW_MCP_GATE_CANARY: '1', CURLEW_CONFIG: mailGrantsFile });
assert(
  mailGranted.includes('send_message'),
  `send_message not served with a mail.send grant (${mailGranted.join(', ')})`,
);
console.log('OK: a mail.send grant alone serves send_message');

const telegramGrantsFile = join(scratch, 'granted-telegram.json');
writeFileSync(
  telegramGrantsFile,
  JSON.stringify({
    backends: {},
    grants: [{ capability: 'telegram.send', target: 'telegram-42/1001' }],
  }),
);
const telegramGranted = await listToolNames({
  CURLEW_MCP_GATE_CANARY: '1',
  CURLEW_CONFIG: telegramGrantsFile,
});
assert(
  telegramGranted.includes('send_message'),
  `send_message not served with a telegram.send grant (${telegramGranted.join(', ')})`,
);
for (const canary of DROPPED) {
  assert(
    !telegramGranted.includes(canary),
    `GATE IS OPEN: ${canary} was served — ${telegramGranted.join(', ')}`,
  );
}
console.log('OK: a telegram.send grant alone serves send_message and nothing else that writes');

const matrixGrantsFile = join(scratch, 'granted-matrix.json');
writeFileSync(
  matrixGrantsFile,
  JSON.stringify({
    backends: {},
    grants: [{ capability: 'matrix.send', target: 'matrix-0123456789abcd/!room:example.org' }],
  }),
);
const matrixGranted = await listToolNames({
  CURLEW_MCP_GATE_CANARY: '1',
  CURLEW_CONFIG: matrixGrantsFile,
});
assert(
  matrixGranted.includes('send_message'),
  `send_message not served with a matrix.send grant (${matrixGranted.join(', ')})`,
);
for (const canary of DROPPED) {
  assert(!matrixGranted.includes(canary), `GATE IS OPEN: ${canary} was served — ${matrixGranted.join(', ')}`);
}
console.log('OK: a matrix.send grant alone serves send_message and nothing else that writes');

const signalGrantsFile = join(scratch, 'granted-signal.json');
writeFileSync(
  signalGrantsFile,
  JSON.stringify({
    backends: {},
    grants: [
      {
        capability: 'signal.send',
        target: 'signal-9f3a1c2e-7b4d-4e18-8c6a-2f5b1d0e3a47/9f3a1c2e-7b4d-4e18-8c6a-2f5b1d0e3a47',
      },
    ],
  }),
);
const signalGranted = await listToolNames({
  CURLEW_MCP_GATE_CANARY: '1',
  CURLEW_CONFIG: signalGrantsFile,
});
assert(
  signalGranted.includes('send_message'),
  `send_message not served with a signal.send grant (${signalGranted.join(', ')})`,
);
for (const canary of DROPPED) {
  assert(!signalGranted.includes(canary), `GATE IS OPEN: ${canary} was served — ${signalGranted.join(', ')}`);
}
console.log('OK: a signal.send grant alone serves send_message and nothing else that writes');

// The env switch still opens setup_run, and only that.
const ungated = await listToolNames({ CURLEW_MCP_GATE_CANARY: '1', CURLEW_MCP_ALLOW_WRITE: '1' });
assert(
  ungated.includes('setup_run'),
  `setup_run never registered with the switch on (${ungated.join(', ')})`,
);
for (const canary of [...DROPPED, CONTROL]) {
  assert(!ungated.includes(canary), `the write switch must not open ${canary} (${ungated.join(', ')})`);
}
console.log(`OK: CURLEW_MCP_ALLOW_WRITE opens setup_run only (${ungated.length} tools)`);

process.exit(0);
