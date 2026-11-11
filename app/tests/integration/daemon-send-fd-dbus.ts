// Send with attachments over a real session bus: client → fd list → daemon service → staged copies.
// The handler is a fake; what is checked is the transport (descriptors arrive, are copied into a
// private directory, and the directory is gone when the call ends). Run under `dbus-run-session`
// (see the test:send-fd-dbus script); the unit suite has no bus by design.
import GLib from 'gi://GLib?version=2.0';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gioDaemonSendClient } from '../../src/core/lib/daemon-send-client.ts';
import { DAEMON_WIRE_VERSION, type DaemonSendRequest } from '../../src/core/lib/daemon-bus.ts';
import { publishDaemonSend } from '../../src/core/lib/daemon-send-service.ts';

const log = (...parts: unknown[]) => console.log(parts.map((p) => String(p)).join(' '));
let failures = 0;
const check = (name: string, ok: boolean): void => {
  log(ok ? 'ok  ' : 'FAIL', name);
  if (!ok) failures += 1;
};

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'curlew-fd-'));
  process.env.CURLEW_STAGING_DIR = join(work, 'staging');
  const first = join(work, 'a', 'report.txt');
  const second = join(work, 'b', 'report.txt');
  mkdirSync(join(work, 'a'));
  mkdirSync(join(work, 'b'));
  writeFileSync(first, 'first file');
  writeFileSync(second, 'second file, longer');

  let seen: { paths: string[]; bodies: string[]; modes: number[]; dirMode: number } | null = null;
  const service = publishDaemonSend(
    async (request: DaemonSendRequest) => {
      const paths = request.attachments ?? [];
      seen = {
        paths,
        bodies: paths.map((p) => readFileSync(p, 'utf8')),
        modes: paths.map((p) => statSync(p).mode & 0o777),
        dirMode: statSync(join(paths[0], '..', '..')).mode & 0o777,
      };
      return { v: DAEMON_WIRE_VERSION, kind: 'refused', message: 'transport check' };
    },
    { log: (line) => log('daemon:', line) },
  );
  if (!service) throw new Error('no service');
  await new Promise<void>((resolve) => setTimeout(resolve, 300));

  const reply = await gioDaemonSendClient().send({
    v: DAEMON_WIRE_VERSION,
    backend: 'xmpp',
    account: 'xmpp-abc123',
    capability: 'xmpp.send',
    to: 'friend@example.org',
    text: 'two files',
    attachments: [first, second],
  });
  check('the handler ran and its reply came back', reply?.kind === 'refused');
  const got = seen as { paths: string[]; bodies: string[]; modes: number[]; dirMode: number } | null;
  check('both files arrived with their content', got?.bodies.join('|') === 'first file|second file, longer');
  check('two files of one name did not collide', new Set(got?.paths).size === 2);
  check(
    'the copies are 0600 in a 0700 directory',
    got?.modes.every((m) => m === 0o600) === true && got?.dirMode === 0o700,
  );
  check(
    "the copies are not the caller's files",
    got?.paths.every((p) => p !== first && p !== second) === true,
  );
  check(
    'the directory is removed after the call',
    got !== null && !existsSync(join(got.paths[0], '..', '..')),
  );

  let missing = '';
  try {
    await gioDaemonSendClient().send({
      v: DAEMON_WIRE_VERSION,
      backend: 'xmpp',
      account: 'xmpp-abc123',
      capability: 'xmpp.send',
      to: 'friend@example.org',
      attachments: [join(work, 'nope.txt')],
    });
  } catch (error) {
    missing = (error as Error).message;
  }
  check('a missing file fails in the caller, before the bus', missing.length > 0);

  service.close();
  log(failures === 0 ? 'ALL OK' : `${failures} FAILED`);
  if (failures > 0) throw new Error('send-fd-dbus failed');
}

const done = main().then(
  () => undefined,
  (error) => {
    failures += 1;
    log('FAILED:', String(error));
  },
);
// GJS only runs the callbacks the bus calls back with while a main loop is running.
const loop = new GLib.MainLoop(null, false);
done.then(() => process.exit(failures === 0 ? 0 : 1));
loop.run();
