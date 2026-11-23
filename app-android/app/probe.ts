import { type MailTarget, probeMediaFile } from "@curlew/protocol";
import { File, Folder, knownFolders, path } from "@nativescript/core";
import { ImapClient, openTlsStream } from "@curlew/imap/stream";
import { probeSmtp } from "./smtp-probe.ts";
import { migrate, openIndexDb, probeFts5, searchIndex, storePaths, upsertAccount, upsertFolder, upsertMessages, type IndexDatabase } from "@curlew/store/index-db";

export interface ProbeResult {
  host: string;
  port: number;
  kind: "imap" | "reject" | "media" | "store" | "store-file" | "smtp-implicit" | "smtp-starttls" | "smtp-untrusted";
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

const PNG_WIDTH = 3;
const PNG_HEIGHT = 2;

/** A PNG signature plus an IHDR chunk (3x2, 8-bit RGB), generated in code; no pixel data is needed to probe. */
function pngHeader(): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, PNG_WIDTH);
  v.setUint32(20, PNG_HEIGHT);
  b[24] = 8;
  b[25] = 2;
  return b;
}

/** Writes a known PNG to the cache dir and runs the real `probeMediaFile` (openSync, fstatSync, readSync) on it. */
export function probeMediaOnDisk(): ProbeResult {
  const t0 = Date.now();
  const file = path.join(knownFolders.temp().path, "curlew-probe.png");
  try {
    const bytes = pngHeader();
    // NativeScript's File.writeSync wants a Java byte[], not a typed array.
    const java = Array.create("byte", bytes.length);
    bytes.forEach((v, i) => { java[i] = v > 127 ? v - 256 : v; });
    File.fromPath(file).writeSync(java);
    const r = probeMediaFile(file, "application/octet-stream");
    const ok = r.width === PNG_WIDTH && r.height === PNG_HEIGHT;
    return { host: "media-probe", port: 0, kind: "media", ok, ms: Date.now() - t0, detail: `type=png size=${bytes.length}B detected=${r.width}x${r.height} expected=${PNG_WIDTH}x${PNG_HEIGHT}` };
  } catch (e) {
    return { host: "media-probe", port: 0, kind: "media", ok: false, ms: Date.now() - t0, detail: String((e as Error)?.message ?? e) };
  }
}

const STORE_BODY = "Energieberatung für das Dach, Termin im März";

/** One synthetic message with an indexed body, through the real upsert functions. */
function insertProbeMessage(db: IndexDatabase): void {
  upsertAccount(db, { id: "probe", identity: "probe", provider: "probe" });
  upsertFolder(db, { accountId: "probe", path: "INBOX", name: "INBOX", role: null });
  upsertMessages(db, "probe", "INBOX", [{
    uid: 1, messageId: "<probe@example.invalid>", subject: "Probe", sender: "a@example.invalid", recipients: "b@example.invalid",
    date: "2026-11-21T10:00:00Z", internalDate: "2026-11-21T10:00:00Z", size: STORE_BODY.length, seen: false, flagged: false,
    hasAttachment: false, attachments: [], bodyText: STORE_BODY,
    from: [{ name: null, email: "a@example.invalid" }], to: [{ name: null, email: "b@example.invalid" }], cc: [],
    inReplyTo: null, references: [], automation: { listId: null, listUnsubscribe: null, autoSubmitted: null, precedence: null }, emailChat: false,
  }], "2026-11-21T10:00:00Z");
}

/** The real index code on `:memory:`: open, migrate, probeFts5, insert one message, FTS search. */
export function probeStore(): ProbeResult {
  const t0 = Date.now();
  const steps: string[] = [];
  try {
    const db = openIndexDb(":memory:");
    steps.push("open");
    migrate(db);
    const tables = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
    steps.push(`migrate tables=${tables}`);
    probeFts5(db);
    steps.push("probeFts5");
    insertProbeMessage(db);
    const rows = (db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n;
    steps.push(`insert messages=${rows}`);
    const hits = searchIndex(db, { query: "marz" }).length;
    const miss = searchIndex(db, { query: "gibtesnicht" }).length;
    steps.push(`fts hits=${hits} (marz) miss=${miss}`);
    db.close();
    return { host: "store", port: 0, kind: "store", ok: rows === 1 && hits === 1 && miss === 0, ms: Date.now() - t0, detail: `:memory: ${steps.join(", ")}` };
  } catch (e) {
    return { host: "store", port: 0, kind: "store", ok: false, ms: Date.now() - t0, detail: `:memory: after [${steps.join(", ")}]: ${String((e as Error)?.stack ?? e)}` };
  }
}

function count(db: IndexDatabase, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function journalMode(db: IndexDatabase): string {
  return String((db.prepare("PRAGMA journal_mode").get() as Record<string, unknown>).journal_mode);
}

/**
 * The real index in a FILE in the app-private data dir (`getFilesDir()`, via `knownFolders.documents()`),
 * located by the store's own `storePaths()`: open (WAL, busy timeout), migrate, insert, close, reopen, verify.
 */
export function probeStoreFile(): ProbeResult {
  const t0 = Date.now();
  const steps: string[] = [];
  const dataDir = path.join(knownFolders.documents().path, "curlew-probe-store");
  const dirs = { data: dataDir, cache: path.join(knownFolders.temp().path, "curlew-probe-store"), config: path.join(dataDir, "config") };
  const file = storePaths(dirs).indexDbPath;
  try {
    Folder.fromPath(dataDir);
    let db = openIndexDb(file);
    steps.push(`open journal=${journalMode(db)}`);
    migrate(db);
    probeFts5(db);
    insertProbeMessage(db);
    steps.push(`insert messages=${count(db, "messages")}`);
    db.close();
    db = openIndexDb(file);
    const rows = count(db, "messages");
    const tables = count(db, "sqlite_master WHERE type = 'table'");
    const hits = searchIndex(db, { query: "marz" }).length;
    const journal = journalMode(db);
    db.close();
    steps.push(`reopen messages=${rows} tables=${tables} fts hits=${hits} journal=${journal}`);
    return { host: "store-file", port: 0, kind: "store-file", ok: rows === 1 && hits === 1 && journal === "wal", ms: Date.now() - t0, detail: `app-private files dir ${steps.join(", ")}` };
  } catch (e) {
    return { host: "store-file", port: 0, kind: "store-file", ok: false, ms: Date.now() - t0, detail: `app-private files dir after [${steps.join(", ")}]: ${String((e as Error)?.stack ?? e)}` };
  } finally {
    try { Folder.fromPath(dataDir).removeSync(); } catch { /* best effort */ }
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
  emit(probeMediaOnDisk());
  emit(probeStore());
  emit(probeStoreFile());
  await probeSmtp(emit);
  console.log(`${PREFIX} DONE`);
  onResult(`${PREFIX} DONE`);
}
