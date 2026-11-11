import { describe, expect, it } from '@gjsify/unit';

import {
  addressDomain,
  autoconfigUrls,
  discoverServers,
  expandUsername,
  parseClientConfig,
} from '../../../../packages/imap/src/autoconfig.ts';

const ADDRESS = 'ada@example.org';

const config = (incoming: string, outgoing: string): string => `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.org">
    ${incoming}
    ${outgoing}
  </emailProvider>
</clientConfig>`;

const imap = (socket: string, auth = 'password-cleartext', port = 993): string => `
  <incomingServer type="imap">
    <hostname>imap.example.org</hostname><port>${port}</port>
    <socketType>${socket}</socketType>
    <username>%EMAILADDRESS%</username><authentication>${auth}</authentication>
  </incomingServer>`;

const smtp = (socket: string, auth = 'password-cleartext', port = 587): string => `
  <outgoingServer type="smtp">
    <hostname>smtp.example.org</hostname><port>${port}</port>
    <socketType>${socket}</socketType>
    <username>%EMAILLOCALPART%</username><authentication>${auth}</authentication>
  </outgoingServer>`;

export default async () => {
  await describe('mail autoconfig', async () => {
    await it('reads the IMAP and SMTP servers and fills the login placeholders', async () => {
      const result = parseClientConfig(config(imap('SSL'), smtp('STARTTLS')), ADDRESS);
      expect('servers' in result).toBe(true);
      if (!('servers' in result)) return;
      expect(result.servers.imap.host).toBe('imap.example.org');
      expect(result.servers.imap.port).toBe(993);
      expect(result.servers.imap.user).toBe(ADDRESS);
      expect(result.servers.smtp.security).toBe('starttls');
      expect(result.servers.smtp.user).toBe('ada');
    });

    await it('maps SMTP over SSL to TLS from the first byte', async () => {
      const result = parseClientConfig(config(imap('SSL'), smtp('SSL', 'password-cleartext', 465)), ADDRESS);
      expect('servers' in result && result.servers.smtp.security).toBe('tls');
    });

    await it('skips an IMAP server that needs STARTTLS, which Curlew cannot speak', async () => {
      const both = config(imap('STARTTLS', 'password-cleartext', 143) + imap('SSL'), smtp('STARTTLS'));
      const result = parseClientConfig(both, ADDRESS);
      expect('servers' in result && result.servers.imap.port).toBe(993);
      const only = parseClientConfig(
        config(imap('STARTTLS', 'password-cleartext', 143), smtp('STARTTLS')),
        ADDRESS,
      );
      expect('refusal' in only && only.refusal).toBe('unsupported');
    });

    await it('names OAuth2 as the reason when that is all the provider offers', async () => {
      const result = parseClientConfig(config(imap('SSL', 'OAuth2'), smtp('STARTTLS', 'OAuth2')), ADDRESS);
      expect('refusal' in result && result.refusal).toBe('oauth2');
    });

    await it('decodes entities and ignores a document that is not a config', async () => {
      const result = parseClientConfig(
        config(imap('SSL').replace('imap.example.org', 'imap&amp;co.example.org'), smtp('STARTTLS')),
        ADDRESS,
      );
      expect('servers' in result && result.servers.imap.host).toBe('imap&co.example.org');
      expect('refusal' in parseClientConfig('<html>404</html>', ADDRESS)).toBe(true);
    });

    await it('expands every placeholder, case-insensitively', async () => {
      expect(expandUsername('%EMAILLOCALPART%@%emaildomain%/%EMAILADDRESS%', ADDRESS)).toBe(
        'ada@example.org/ada@example.org',
      );
    });

    await it('takes the domain of an address and nothing else', async () => {
      expect(addressDomain(' Ada@Example.ORG ')).toBe('example.org');
      expect(addressDomain('ada')).toBe(null);
      expect(addressDomain('ada@localhost')).toBe(null);
      expect(addressDomain('a b@example.org')).toBe(null);
    });

    await it('asks the provider first and Mozilla last, over HTTPS only', async () => {
      const urls = autoconfigUrls(ADDRESS);
      expect(urls.length).toBe(3);
      expect(urls.every((u) => u.startsWith('https://'))).toBe(true);
      expect(urls[0]).toContain('autoconfig.example.org');
      expect(urls[2]).toBe('https://autoconfig.thunderbird.net/v1.1/example.org');
      expect(autoconfigUrls('nonsense').length).toBe(0);
    });

    await it('stops at the first place that answers and tolerates the ones that fail', async () => {
      const asked: string[] = [];
      const found = await discoverServers(ADDRESS, async (url) => {
        asked.push(url);
        if (asked.length === 1) throw new Error('tls failure');
        if (asked.length === 2) return null;
        return config(imap('SSL'), smtp('STARTTLS'));
      });
      expect(found !== null && 'servers' in found).toBe(true);
      expect(asked.length).toBe(3);
    });

    await it('finds nothing when no place answers, and remembers an OAuth2 refusal', async () => {
      expect(await discoverServers(ADDRESS, async () => null)).toBe(null);
      const oauth = await discoverServers(ADDRESS, async () =>
        config(imap('SSL', 'OAuth2'), smtp('SSL', 'OAuth2')),
      );
      expect(oauth !== null && 'refusal' in oauth && oauth.refusal).toBe('oauth2');
    });
  });
};
