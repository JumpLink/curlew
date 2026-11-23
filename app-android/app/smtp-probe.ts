import { Buffer } from "node:buffer";
import { File, knownFolders, path } from "@nativescript/core";
import { openEndpointStream } from "@curlew/imap/stream";
import { sendMessageOverWire, type SmtpAccount } from "@curlew/smtp/wire-send";
import type { ProbeResult } from "./probe.ts";

// nodemailer's composer reads the global `Buffer`; this shell has no auto-globals pass.
globalThis.Buffer ??= Buffer;

/**
 * Where `dev/android-smtp-probe.sh` leaves the test CA and the loopback server ports. Nothing is
 * baked into the APK: no files, no SMTP probe. The host is the emulator's 10.0.2.2.
 */
const HOST = "10.0.2.2";
const DIR = "curlew-smtp-probe";

interface Setup {
  ports: { implicit: number; starttls: number; refused: number };
  ca: string;
  otherCa: string;
}

function readSetup(): Setup | null {
  const dir = path.join(knownFolders.documents().path, DIR);
  const read = (name: string) => path.join(dir, name);
  if (!File.exists(read("ports.json"))) return null;
  return {
    ports: JSON.parse(File.fromPath(read("ports.json")).readTextSync()),
    ca: File.fromPath(read("ca.pem")).readTextSync(),
    otherCa: File.fromPath(read("other-ca.pem")).readTextSync(),
  };
}

const account = (port: number, security: SmtpAccount["security"], ca: string): SmtpAccount => ({
  host: HOST,
  port,
  security,
  username: "probe@example.invalid",
  auth: { kind: "password", password: "probe-password-for-the-dummy-server" },
  tls: { ca },
});

const message = (tag: string) => ({
  from: "sender@example.invalid",
  to: ["rcpt@example.invalid"],
  subject: `Curlew SMTP probe ${tag}`,
  text: `probe body ${tag}\n.dot line\n`,
  messageId: `<probe-${tag}@example.invalid>`,
});

async function run(kind: string, ms0: number, work: () => Promise<string>, expectFailure = false): Promise<ProbeResult> {
  try {
    const detail = await work();
    return { host: HOST, port: 0, kind: kind as ProbeResult["kind"], ok: !expectFailure, ms: Date.now() - ms0, detail };
  } catch (e) {
    const code = (e as { code?: string }).code ?? "?";
    const text = String((e as Error)?.message ?? e);
    return { host: HOST, port: 0, kind: kind as ProbeResult["kind"], ok: expectFailure && code === "tls", ms: Date.now() - ms0, detail: `${expectFailure ? "refused" : "failed"} code=${code} ${text}` };
  }
}

/** Sends over the wire client on the Gio transport to the host's dummy servers; the host judges what arrived. */
export async function probeSmtp(emit: (r: ProbeResult) => void): Promise<void> {
  const setup = readSetup();
  if (!setup) return;
  const open = openEndpointStream;
  const t = () => Date.now();
  let t0 = t();
  emit(await run("smtp-implicit", t0, async () => {
    const r = await sendMessageOverWire(account(setup.ports.implicit, "tls", setup.ca), message("implicit"), { open });
    return `accepted=${r.accepted.length} response=${r.response}`;
  }));
  t0 = t();
  emit(await run("smtp-starttls", t0, async () => {
    const r = await sendMessageOverWire(account(setup.ports.starttls, "starttls", setup.ca), message("starttls"), { open });
    return `accepted=${r.accepted.length} response=${r.response}`;
  }));
  t0 = t();
  emit(await run("smtp-untrusted", t0, async () => {
    await sendMessageOverWire(account(setup.ports.refused, "starttls", setup.otherCa), message("untrusted"), { open });
    return "message was SENT over an untrusted certificate";
  }, true));
}
