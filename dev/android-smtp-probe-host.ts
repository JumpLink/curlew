// Host half of the Android SMTP probe (docs/android/ap53-smtp-probe.md): loopback dummy SMTP
// servers with a throwaway self-signed certificate, the files the app reads, and the verdict.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDummyServer } from '../app/tests/unit/smtp/dummy-server.ts';
import { tlsCredentials } from '../app/tests/unit/smtp/tls-fixture.ts';

const PACKAGE = 'eu.jumplink.curlew';
const adb = (...args: string[]) => execFileSync('adb', args, { encoding: 'utf8' });

const implicit = await startDummyServer({ tls: 'implicit' });
const starttls = await startDummyServer({ tls: 'starttls' });
const refused = await startDummyServer({ tls: 'starttls' });
const { cert, otherCert } = tlsCredentials();

const dir = mkdtempSync(join(tmpdir(), 'curlew-android-smtp-'));
writeFileSync(join(dir, 'ca.pem'), cert);
writeFileSync(join(dir, 'other-ca.pem'), otherCert);
writeFileSync(join(dir, 'ports.json'), JSON.stringify({ implicit: implicit.port, starttls: starttls.port, refused: refused.port }));
for (const name of ['ca.pem', 'other-ca.pem', 'ports.json']) adb('push', join(dir, name), `/data/local/tmp/${name}`);
adb(
  'shell',
  `run-as ${PACKAGE} sh -c 'mkdir -p files/curlew-smtp-probe && cp /data/local/tmp/ca.pem /data/local/tmp/other-ca.pem /data/local/tmp/ports.json files/curlew-smtp-probe/'`,
);
console.log('SETUP ok ports', implicit.port, starttls.port, refused.port);
adb('shell', `am start -n ${PACKAGE}/com.tns.NativeScriptActivity`);

// The app logs CURLEW-PROBE DONE when every probe has run; wait for the dialogues instead.
const deadline = Date.now() + 120_000;
while (Date.now() < deadline && (implicit.dialogue.messages.length < 1 || starttls.dialogue.messages.length < 1 || !refused.dialogue.commands.length)) {
  await new Promise((r) => setTimeout(r, 1000));
}
await new Promise((r) => setTimeout(r, 5000));

const checks: [string, boolean][] = [
  ['implicit: one message arrived', implicit.dialogue.messages.length === 1],
  ['implicit: body and dot-stuffing', /probe body implicit\r\n\.\.dot line\r\n/.test(implicit.dialogue.messages[0] ?? '')],
  ['implicit: envelope', implicit.dialogue.commands.includes('MAIL FROM:<sender@example.invalid>') && implicit.dialogue.commands.includes('RCPT TO:<rcpt@example.invalid>')],
  ['implicit: AUTH PLAIN', implicit.dialogue.commands.some((c) => c.startsWith('AUTH PLAIN '))],
  ['starttls: one message arrived', starttls.dialogue.messages.length === 1],
  ['starttls: body', /probe body starttls\r\n/.test(starttls.dialogue.messages[0] ?? '')],
  ['starttls: EHLO STARTTLS EHLO AUTH', starttls.dialogue.commands.map((c) => c.split(' ')[0]).slice(0, 4).join(' ') === 'EHLO STARTTLS EHLO AUTH'],
  ['untrusted: no AUTH, no MAIL, no message', !refused.dialogue.commands.some((c) => /^(AUTH|MAIL)/.test(c)) && refused.dialogue.messages.length === 0],
  ['untrusted: STARTTLS was attempted', refused.dialogue.commands.some((c) => c === 'STARTTLS')],
];
for (const [name, ok] of checks) console.log(ok ? 'PASS' : 'FAIL', name);
await Promise.all([implicit.close(), starttls.close(), refused.close()]);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
