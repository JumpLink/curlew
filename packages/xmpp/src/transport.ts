/**
 * Where to connect, and whether that is allowed — pure policy plus the discovery lookups.
 *
 * Preference (encryption from the first byte first):
 *   1. Direct TLS (XEP-0368): SRV `_xmpps-client._tcp.<domain>`, `xmpps://host:port`.
 *   2. WebSocket (RFC 7395) over TLS, found through `/.well-known/host-meta.json` (XEP-0156).
 *   3. STARTTLS: SRV `_xmpp-client._tcp.<domain>`, else `<domain>:5222`.
 *
 * All three work on both runtimes. The raw-TLS paths were blocked here until gjsify#1958 aliased
 * `Readable.prototype.addListener` to `on`: `@xmpp/tls` subscribes `'data'` through `addListener`
 * (via `@xmpp/events`' `addEventListener ?? addListener`), so where the two names were not the same
 * function the peer's answer ARRIVED and sat unread in the readable buffer — it never went
 * missing — and the login sat at `opening` until it timed out. Measured over direct TLS against a
 * local Prosody 13: 10 of 12 GJS runs stalled at `opening` in ~2.1 s before the alias, 19 of 20
 * reached `online` in 577–679 ms after it, with nothing patched in this file. The intermittent
 * `Gio.TlsError` certificate rejection counted separately — 2 of those 12 before, 1 of the 20 after
 * — is a different defect: it also takes runs that would otherwise go online.
 *
 * The certificate is always checked against the XMPP DOMAIN (sent as SNI), not against the host
 * an SRV record points to: that is what XEP-0368 and RFC 6120 §13.7.2 require, and it is what
 * keeps a forged SRV answer from redirecting the login to someone else's certificate.
 *
 * Unencrypted transport is allowed only to a loopback address (a local test server, a local
 * proxy) — and even there no password is sent in the clear (`client.ts` refuses PLAIN).
 */

export type EndpointKind = 'direct-tls' | 'websocket' | 'starttls';

export interface Endpoint {
  kind: EndpointKind;
  /** What xmpp.js connects to: `xmpps://…`, `wss://…`/`ws://…`, `xmpp://…`. */
  uri: string;
  host: string;
  port: number;
}

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * A server address the user typed (`accounts add xmpp`): `xmpps://host[:port]` (direct TLS),
 * `wss://host/path` (WebSocket), `xmpp://host[:port]` (STARTTLS), or a bare `host[:port]`,
 * read as direct TLS. `ws://` only to a loopback address.
 */
export function parseService(service: string): Endpoint {
  const raw = service.trim();
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `xmpps://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`not a server address: ${JSON.stringify(service)} — e.g. xmpps://xmpp.example.org:5223`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error(`the server address has no host: ${JSON.stringify(service)}`);
  switch (url.protocol) {
    case 'xmpps:': {
      const port = Number(url.port) || 5223;
      return { kind: 'direct-tls', uri: `xmpps://${formatHost(host)}:${port}`, host, port };
    }
    case 'xmpp:': {
      const port = Number(url.port) || 5222;
      return { kind: 'starttls', uri: `xmpp://${formatHost(host)}:${port}`, host, port };
    }
    case 'wss:':
    case 'ws:': {
      if (url.protocol === 'ws:' && !isLoopback(host)) {
        throw new Error(
          `refusing unencrypted ws:// to ${host} — use wss:// (ws:// is accepted only for a loopback address)`,
        );
      }
      const port = Number(url.port) || (url.protocol === 'wss:' ? 443 : 80);
      return { kind: 'websocket', uri: url.toString(), host, port };
    }
    default:
      throw new Error(`unsupported server address scheme ${url.protocol} — use xmpps://, wss:// or xmpp://`);
  }
}

export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}

/** What discovery needs from the outside world — injected so the order is testable. */
export interface DiscoveryDeps {
  /** DNS SRV lookup; resolves to [] (or rejects) when there is no record. */
  resolveSrv(name: string): Promise<SrvRecord[]>;
  /** GET a JSON document over HTTPS; resolves to null when there is none. */
  fetchJson(url: string): Promise<unknown>;
}

function sortSrv(records: readonly SrvRecord[]): SrvRecord[] {
  // RFC 2782: "." as the only target means the service is decidedly not available.
  return records
    .filter((r) => r.name && r.name !== '.')
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight);
}

async function srv(deps: DiscoveryDeps, name: string): Promise<SrvRecord[]> {
  try {
    return sortSrv(await deps.resolveSrv(name));
  } catch {
    return [];
  }
}

/** WebSocket endpoints from XEP-0156's JSON host-meta. Only `wss://` counts. */
export function websocketLinks(hostMeta: unknown): string[] {
  const links = (hostMeta as { links?: unknown } | null)?.links;
  if (!Array.isArray(links)) return [];
  return links
    .filter(
      (l): l is { rel: string; href: string } =>
        typeof l?.rel === 'string' &&
        typeof l?.href === 'string' &&
        l.rel === 'urn:xmpp:alt-connections:websocket',
    )
    .map((l) => l.href)
    .filter((href) => href.startsWith('wss://'));
}

/** Every way to reach `domain`, most preferred first. */
export async function discoverEndpoints(domain: string, deps: DiscoveryDeps): Promise<Endpoint[]> {
  const [direct, hostMeta, starttls] = await Promise.all([
    srv(deps, `_xmpps-client._tcp.${domain}`),
    deps.fetchJson(`https://${domain}/.well-known/host-meta.json`).catch(() => null),
    srv(deps, `_xmpp-client._tcp.${domain}`),
  ]);
  const endpoints: Endpoint[] = [
    ...direct.map((r) => parseService(`xmpps://${formatHost(r.name.replace(/\.$/, ''))}:${r.port}`)),
    ...websocketLinks(hostMeta).map((href) => parseService(href)),
    ...starttls.map((r) => parseService(`xmpp://${formatHost(r.name.replace(/\.$/, ''))}:${r.port}`)),
  ];
  // RFC 6120 §3.2.2: no SRV record at all — try the domain itself on the default port.
  if (direct.length === 0 && starttls.length === 0) endpoints.push(parseService(`xmpp://${domain}:5222`));
  const seen = new Set<string>();
  return endpoints.filter((e) => !seen.has(e.uri) && seen.add(e.uri));
}

/**
 * The SASL mechanism for a login, or an error that says why there is none — the downgrade
 * defence in one pure function. No login at all over an unencrypted stream off loopback.
 * SCRAM never sends the password; PLAIN does, so only inside TLS.
 *
 * SCRAM-SHA-1 is the strongest SCRAM xmpp.js 0.14 ships (no SCRAM-SHA-256 package, and
 * `sasl-ht-sha-256-none` is FAST token auth, not a password mechanism); SHA-256 would slot in
 * first here once it exists. No channel binding (-PLUS) yet.
 */
export function chooseMechanism(
  offered: readonly string[],
  connection: { encrypted: boolean; host: string },
): 'SCRAM-SHA-1' | 'PLAIN' {
  if (!connection.encrypted && !isLoopback(connection.host)) {
    throw new Error(`refusing to log in over an unencrypted connection to ${connection.host}`);
  }
  if (offered.includes('SCRAM-SHA-1')) return 'SCRAM-SHA-1';
  if (connection.encrypted && offered.includes('PLAIN')) return 'PLAIN';
  throw new Error(
    `the server offers no login mechanism postbote uses on this connection (offered: ${offered.join(', ') || 'none'})`,
  );
}
