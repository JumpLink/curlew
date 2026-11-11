/**
 * Mail server discovery: the Thunderbird "autoconfig" format (`clientConfig` v1.1), read from the
 * provider itself or from Mozilla's ISP database. A provider that publishes nothing is not an
 * error here — the caller asks the person for the servers.
 *
 * Pure but for the injected `fetchText`, so a test needs no network. Only what `MailTarget` and
 * `SmtpTarget` can speak is accepted: IMAP over TLS from the first byte, SMTP over TLS or
 * STARTTLS, a password login. A provider that wants OAuth2 is reported as such instead of being
 * offered a login that cannot work.
 */

export interface DiscoveredImap {
  host: string;
  port: number;
  user: string;
}

export interface DiscoveredSmtp {
  host: string;
  port: number;
  user: string;
  security: 'tls' | 'starttls';
}

export interface DiscoveredServers {
  imap: DiscoveredImap;
  smtp: DiscoveredSmtp;
}

/** Why a document yielded no servers: the provider needs a flow Curlew does not have. */
export type AutoconfigRefusal = 'oauth2' | 'unsupported';

const UNSUPPORTED_AUTH = new Set(['oauth2', 'gssapi', 'ntlm', 'client-ip-address', 'tls-client-cert']);

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagText(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return match ? decodeEntities(match[1].trim()) : null;
}

function serverBlocks(xml: string, tag: 'incomingServer' | 'outgoingServer', type: string): string[] {
  const blocks: string[] = [];
  const open = new RegExp(`<${tag}\\s[^>]*type\\s*=\\s*"${type}"[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  for (let match = open.exec(xml); match; match = open.exec(xml)) blocks.push(match[1]);
  return blocks;
}

/** Fill the `%EMAILADDRESS%`-style placeholders a config uses for the login name. */
export function expandUsername(template: string, address: string): string {
  const at = address.lastIndexOf('@');
  const local = at === -1 ? address : address.slice(0, at);
  const domain = at === -1 ? '' : address.slice(at + 1);
  return template
    .replace(/%EMAILADDRESS%/gi, address)
    .replace(/%EMAILLOCALPART%/gi, local)
    .replace(/%EMAILDOMAIN%/gi, domain);
}

interface Candidate {
  host: string;
  port: number;
  socket: string;
  user: string;
  auth: string;
}

function candidate(block: string, address: string): Candidate | null {
  const host = tagText(block, 'hostname');
  const port = Number.parseInt(tagText(block, 'port') ?? '', 10);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    host,
    port,
    socket: (tagText(block, 'socketType') ?? '').toUpperCase(),
    user: expandUsername(tagText(block, 'username') ?? '%EMAILADDRESS%', address),
    auth: (tagText(block, 'authentication') ?? '').toLowerCase(),
  };
}

function usable(c: Candidate): boolean {
  return !UNSUPPORTED_AUTH.has(c.auth);
}

/**
 * Read the first usable IMAP and SMTP server out of a `clientConfig` document. Null when there
 * are none, with the reason when the cause is the login method.
 */
export function parseClientConfig(
  xml: string,
  address: string,
): { servers: DiscoveredServers } | { refusal: AutoconfigRefusal } {
  const imaps = serverBlocks(xml, 'incomingServer', 'imap')
    .map((block) => candidate(block, address))
    .filter((c): c is Candidate => c !== null);
  const smtps = serverBlocks(xml, 'outgoingServer', 'smtp')
    .map((block) => candidate(block, address))
    .filter((c): c is Candidate => c !== null);

  const imap = imaps.find((c) => usable(c) && c.socket === 'SSL');
  const smtp = smtps.find((c) => usable(c) && (c.socket === 'SSL' || c.socket === 'STARTTLS'));
  if (imap && smtp) {
    return {
      servers: {
        imap: { host: imap.host, port: imap.port, user: imap.user },
        smtp: {
          host: smtp.host,
          port: smtp.port,
          user: smtp.user,
          security: smtp.socket === 'SSL' ? 'tls' : 'starttls',
        },
      },
    };
  }
  const wantsOAuth = [...imaps, ...smtps].some((c) => c.auth === 'oauth2');
  return { refusal: wantsOAuth ? 'oauth2' : 'unsupported' };
}

/** The domain of an address, lower-cased; null when it is not shaped like one. */
export function addressDomain(address: string): string | null {
  const match = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(address.trim());
  return match ? match[1].toLowerCase() : null;
}

/** Where to look, in order: the provider's own files first, Mozilla's database last. */
export function autoconfigUrls(address: string): string[] {
  const domain = addressDomain(address);
  if (!domain) return [];
  const query = `?emailaddress=${encodeURIComponent(address)}`;
  return [
    `https://autoconfig.${domain}/mail/config-v1.1.xml${query}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml${query}`,
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
  ];
}

/**
 * Ask each place in turn. `fetchText` returns the body, or null for anything that is not a
 * success (404, TLS failure, timeout): a missing file is the normal case, not an error.
 */
export async function discoverServers(
  address: string,
  fetchText: (url: string) => Promise<string | null>,
): Promise<{ servers: DiscoveredServers } | { refusal: AutoconfigRefusal } | null> {
  let refusal: AutoconfigRefusal | null = null;
  for (const url of autoconfigUrls(address)) {
    let body: string | null;
    try {
      body = await fetchText(url);
    } catch {
      body = null;
    }
    if (!body) continue;
    const parsed = parseClientConfig(body, address);
    if ('servers' in parsed) return parsed;
    refusal ??= parsed.refusal;
  }
  return refusal ? { refusal } : null;
}
