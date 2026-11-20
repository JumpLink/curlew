import { type MailTarget } from "@curlew/protocol";
import { ImapClient, openTlsStream } from "@curlew/imap/stream";

export interface ProbeResult {
  host: string;
  port: number;
  kind: "imap" | "reject";
  ok: boolean;
  ms: number;
  detail: string;
}

const PREFIX = "CURLEW-PROBE";

function target(host: string, port: number): MailTarget {
  return { accountId: `probe:${host}`, host, port, user: "", implicitTls: true, getPassword: () => "" };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Greeting, CAPABILITY, LOGOUT on a public IMAP server; no credentials are sent. */
export async function probeImap(host: string, port = 993): Promise<ProbeResult> {
  const t0 = Date.now();
  const client = new ImapClient(openTlsStream);
  try {
    await withTimeout(client.connect(target(host, port)), 20000, "connect");
    const greetingMs = Date.now() - t0;
    const caps = await withTimeout(client.capability(), 10000, "CAPABILITY");
    await client.logout();
    return { host, port, kind: "imap", ok: caps.length > 0, ms: greetingMs, detail: `greeting ${greetingMs} ms, CAPABILITY ${caps.length} tokens, total ${Date.now() - t0} ms` };
  } catch (e) {
    await client.logout().catch(() => undefined);
    return { host, port, kind: "imap", ok: false, ms: Date.now() - t0, detail: String((e as Error)?.message ?? e) };
  }
}

/** A host with a bad certificate: the TLS handshake must be REJECTED. Pass means it threw. */
export async function probeReject(host: string, port = 443): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const s = await withTimeout(openTlsStream(target(host, port)), 20000, "handshake");
    await s.close();
    return { host, port, kind: "reject", ok: false, ms: Date.now() - t0, detail: "handshake ACCEPTED a bad certificate" };
  } catch (e) {
    return { host, port, kind: "reject", ok: true, ms: Date.now() - t0, detail: `rejected: ${String((e as Error)?.message ?? e)}` };
  }
}

export async function runProbes(onResult: (line: string) => void): Promise<void> {
  const emit = (r: ProbeResult) => {
    const line = `${PREFIX} ${r.ok ? "PASS" : "FAIL"} ${r.kind} ${r.host}:${r.port} ${r.ms}ms ${r.detail}`;
    console.log(line);
    onResult(line);
  };
  const tls = (globalThis as { __NODE_GI_ANDROID_TLS?: unknown }).__NODE_GI_ANDROID_TLS;
  const info = `${PREFIX} INFO android-tls=${JSON.stringify(tls ?? null)}`;
  console.log(info);
  onResult(info);
  for (const host of ["imap.gmail.com", "imap.fastmail.com"]) emit(await probeImap(host));
  for (const host of ["expired.badssl.com", "self-signed.badssl.com"]) emit(await probeReject(host));
  console.log(`${PREFIX} DONE`);
  onResult(`${PREFIX} DONE`);
}
