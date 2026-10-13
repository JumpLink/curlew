import { applyGrantGate, requiresCapability } from '@gjsify/mcp';
import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chatConversationId, getConversation, recordSentChatMessage } from '@curlew/store';
import { chatMessage, GrantedXmppSession, isArrivalHint, validateImageUrl } from '@curlew/xmpp';
import type { XmppLink } from '@curlew/xmpp';
import xml from '@xmpp/xml';

import { permitFor, recordDelivered, requireSendGrant } from '../../../src/core/actions/send.ts';
import { openIndex } from '../../../src/core/actions/index-sync.ts';
import { waitReply } from '../../../src/core/actions/wait-reply.ts';
import { appendWriteLog } from '../../../src/core/write-log.ts';
import { freshDb } from '../store/fixtures.ts';
import { createRecorder } from '../mcp/recorder.ts';

const ACCOUNT = 'xmpp-abc123';
const OWNER = 'owner@example.org';
const ACCOUNT_INFO = { id: ACCOUNT, identity: 'bot@example.org', provider: 'xmpp' };
const GRANTS = [{ capability: 'xmpp.send' as const, target: `${ACCOUNT}/${OWNER}` }];

function fakeLink(sent: Array<[string, string, string]>, oob: string[] = []): XmppLink {
  return {
    jid: 'bot@example.org',
    roster: async () => [],
    bookmarks: async () => [],
    features: async () => new Set(),
    mam: async () => ({ entries: [], complete: true }),
    close: async () => {},
    sendChat: async (to, id, body, oobUrl) => {
      sent.push([to, id, body]);
      if (oobUrl !== undefined) oob.push(oobUrl);
    },
    goAvailable: async () => {},
    onArrival: () => () => {},
    onClosed: () => {},
  };
}

export default async () => {
  await describe('xmpp stanzas for sending', async () => {
    await it('builds a plain chat message with origin-id, receipt request and markable', async () => {
      const m = chatMessage({ to: OWNER, id: 'id-1', body: 'hi' });
      expect(m.attrs.type).toBe('chat');
      expect(m.getChildText('body')).toBe('hi');
      expect(m.getChild('origin-id')?.attrs.id).toBe('id-1');
      expect(m.getChild('request') !== undefined).toBe(true);
      expect(m.getChild('markable') !== undefined).toBe(true);
      expect(m.getChild('encrypted') === undefined).toBe(true);
    });

    await it('adds an XEP-0066 oob reference only when asked', async () => {
      const url = 'https://example.org/a.jpg';
      const m = chatMessage({ to: OWNER, id: 'id-2', body: url, oobUrl: url });
      const x = m.getChild('x', 'jabber:x:oob');
      expect(x?.getChildText('url')).toBe(url);
      expect(m.getChildText('body')).toBe(url);
      expect(
        chatMessage({ to: OWNER, id: 'id-3', body: 'hi' }).getChild('x', 'jabber:x:oob') === undefined,
      ).toBe(true);
    });

    await it('treats a message with a body as an arrival hint, a bare chat state as none', async () => {
      expect(isArrivalHint(xml('message', { type: 'chat' }, xml('body', {}, 'x')))).toBe(true);
      expect(
        isArrivalHint(
          xml('message', { type: 'chat' }, xml('active', { xmlns: 'http://jabber.org/protocol/chatstates' })),
        ),
      ).toBe(false);
      expect(isArrivalHint(xml('presence'))).toBe(false);
    });

    await it('recognises a reply with a fallback quote and legacy OMEMO without a body', async () => {
      const reply = xml(
        'message',
        { type: 'chat' },
        xml('body', {}, '> quoted\nanswer'),
        xml('reply', { xmlns: 'urn:xmpp:reply:0', id: 'x', to: 'a@example.org' }),
        xml('fallback', { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' }),
      );
      expect(isArrivalHint(reply)).toBe(true);
      const legacy = xml('message', { type: 'chat' }, xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' }));
      expect(isArrivalHint(legacy)).toBe(true);
      const mam = xml('message', {}, xml('result', { xmlns: 'urn:xmpp:mam:2' }, xml('forwarded')));
      expect(isArrivalHint(mam)).toBe(false);
    });
  });

  await describe('the send grant', async () => {
    await it('is exact: another address or account is refused', async () => {
      requireSendGrant({ grants: GRANTS }, ACCOUNT, OWNER);
      let refused = 0;
      for (const [a, t] of [
        [ACCOUNT, 'other@example.org'],
        ['xmpp-other', OWNER],
      ] as const) {
        try {
          requireSendGrant({ grants: GRANTS }, a, t);
        } catch {
          refused++;
        }
      }
      try {
        requireSendGrant({ grants: [] }, ACCOUNT, OWNER);
      } catch {
        refused++;
      }
      expect(refused).toBe(3);
    });

    await it('lists only the granted addresses of that account in the permit', async () => {
      expect(permitFor(GRANTS, ACCOUNT).addresses.join()).toBe(OWNER);
      expect(permitFor(GRANTS, 'xmpp-other').addresses.length).toBe(0);
    });

    await it('GrantedXmppSession refuses an address outside the permit and writes nothing', async () => {
      const sent: Array<[string, string, string]> = [];
      const session = new GrantedXmppSession(fakeLink(sent), permitFor(GRANTS, ACCOUNT), () => 'oid');
      let failed = false;
      try {
        await session.send('other@example.org', 'x');
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(sent.length).toBe(0);
      const ok = await session.send(OWNER, 'hello');
      expect(ok.originId).toBe('oid');
      expect(sent.length).toBe(1);
    });
  });

  await describe('sending an image', async () => {
    await it('accepts only plain https URLs', async () => {
      expect(validateImageUrl('https://example.org/a b'.replace(' ', '%20'))).toBe(
        'https://example.org/a%20b',
      );
      for (const bad of [
        'http://example.org/a.jpg',
        'ftp://example.org/a.jpg',
        'javascript:alert(1)',
        'https://user:pw@example.org/a.jpg',
        'https://example.org/a b.jpg',
        'https://example.org/a\n.jpg',
        'not a url',
        `https://example.org/${'a'.repeat(2_000)}`,
      ]) {
        let refused = false;
        try {
          validateImageUrl(bad);
        } catch {
          refused = true;
        }
        expect(refused).toBe(true);
      }
    });

    await it('sends body = URL with the same URL as oob, and checks the permit first', async () => {
      const sent: Array<[string, string, string]> = [];
      const oob: string[] = [];
      const session = new GrantedXmppSession(fakeLink(sent, oob), permitFor(GRANTS, ACCOUNT), () => 'img-1');
      let refused = false;
      try {
        await session.sendImage('other@example.org', 'https://example.org/a.jpg');
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
      expect(sent.length).toBe(0);
      const out = await session.sendImage(OWNER, 'https://example.org/a.jpg');
      expect(out.originId).toBe('img-1');
      expect(sent[0][2]).toBe('https://example.org/a.jpg');
      expect(oob.join()).toBe('https://example.org/a.jpg');
    });
  });

  await describe('the sent message in the index', async () => {
    await it('is stored as own message and found by since/incomingOnly', async () => {
      const db = freshDb();
      const rec = recordSentChatMessage(db, {
        backend: 'xmpp',
        account: ACCOUNT_INFO,
        chatRemoteId: OWNER,
        clientId: 'oid',
        text: 'ping',
        sentAt: '2026-01-01T10:00:00.000Z',
      });
      expect(rec.conversationId).toBe(chatConversationId('xmpp', ACCOUNT, OWNER));
      const all = getConversation(db, rec.conversationId, { includeBodies: true });
      expect(all?.messages.length).toBe(1);
      expect(all?.messages[0].fromSelf).toBe(true);
      const incoming = getConversation(db, rec.conversationId, { incomingOnly: true });
      expect(incoming?.messages.length).toBe(0);
    });

    await it('waitReply times out without a reply', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-wait-'));
      try {
        const out = await waitReply({
          accountId: ACCOUNT,
          peer: OWNER,
          after: '2026-01-01T10:00:00.000Z',
          timeoutS: 0,
          dbPath: ':memory:',
          configPath: join(dir, 'none.json'),
        });
        expect(out.status).toBe('timeout');
        expect(out.cursor).toBe('2026-01-01T10:00:00.000Z');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await describe('reply references', async () => {
    await it('returns the id a reply references, and waitReply carries it', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-reply-'));
      try {
        const dbPath = join(dir, 'index.db');
        const sent: Array<[string, string, string]> = [];
        const session = new GrantedXmppSession(fakeLink(sent), permitFor(GRANTS, ACCOUNT), () => 'oid-1');
        const out = await session.send(OWNER, 'question');
        // The stanza id and the origin-id are one value, so either spelling in <reply id> matches.
        expect(sent[0][1]).toBe(out.originId);
        expect(chatMessage({ to: OWNER, id: out.originId, body: 'x' }).getChild('origin-id')?.attrs.id).toBe(
          out.originId,
        );

        const rec = recordDelivered(dbPath, ACCOUNT_INFO, { ...out, text: 'question' });
        const db = openIndex(dbPath);
        try {
          const insert = (remote: string, at: string, replyTo: string | null) =>
            db
              .prepare(
                `INSERT INTO conversation_messages (id, conversation_id, backend, account_id, presentation,
                   from_self, sent_at, seen, has_attachments, classification, classification_reason,
                   remote_id, body, remote_seq, reply_to_client_id)
                 VALUES (?, ?, 'xmpp', ?, 'bubble', 0, ?, 0, 0, 'conversational', 'chat-member', ?, 'answer', ?, ?)`,
              )
              .run(`m-${remote}`, rec.conversationId, ACCOUNT, at, remote, Date.parse(at), replyTo);
          insert('a1', '2026-01-01T10:00:01.000Z', 'oid-1');
          insert('a2', '2026-01-01T10:00:02.000Z', null);
        } finally {
          db.close();
        }
        const waited = await waitReply({
          accountId: ACCOUNT,
          peer: OWNER,
          after: '2026-01-01T10:00:00.000Z',
          timeoutS: 0,
          dbPath,
          configPath: join(dir, 'none.json'),
        });
        expect(waited.status).toBe('reply');
        expect(waited.messages.map((m) => m.replyToId).join()).toBe('oid-1,');
        expect(waited.messages[1].replyToId).toBe(null);
        expect('replyToClientId' in waited.messages[0]).toBe(false);
        const only = await waitReply({
          accountId: ACCOUNT,
          peer: OWNER,
          after: '2026-01-01T10:00:00.000Z',
          timeoutS: 0,
          replyTo: 'oid-1',
          dbPath,
          configPath: join(dir, 'none.json'),
        });
        expect(only.messages.length).toBe(1);
        expect(only.messages[0].replyToId).toBe('oid-1');
        const none = await waitReply({
          accountId: ACCOUNT,
          peer: OWNER,
          after: '2026-01-01T10:00:00.000Z',
          timeoutS: 0,
          replyTo: 'other',
          dbPath,
          configPath: join(dir, 'none.json'),
        });
        expect(none.status).toBe('timeout');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await describe('the write log', async () => {
    await it('appends a line without any message text', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-log-'));
      try {
        const path = join(dir, 'sub', 'writes.log');
        appendWriteLog(
          { capability: 'xmpp.send', target: `${ACCOUNT}/${OWNER}`, frontend: 'cli', id: 'oid' },
          { path },
        );
        const line = JSON.parse(readFileSync(path, 'utf8').trim());
        expect(line.id).toBe('oid');
        expect(line.text === undefined).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await describe('the grant gate with send_message-shaped tools', async () => {
    const register = (rec: ReturnType<typeof createRecorder>) =>
      rec.server.registerTool(
        'send',
        requiresCapability(
          { inputSchema: {}, annotations: { readOnlyHint: false } },
          {
            capability: 'xmpp.send',
            targetOf: (a: { account: string; to: string }) => `${a.account}/${a.to}`,
          },
        ) as never,
        (async () => 'reached') as never,
      );

    await it('drops the tool without a grant', async () => {
      const rec = createRecorder();
      applyGrantGate(rec.server, []);
      register(rec);
      expect(rec.names().length).toBe(0);
    });

    await it('serves it with a grant and refuses a call to another address', async () => {
      const rec = createRecorder();
      applyGrantGate(rec.server, GRANTS);
      register(rec);
      expect(rec.names().join()).toBe('send');
      const bad = (await rec.handler('send')({ account: ACCOUNT, to: 'x@example.org' })) as {
        isError?: boolean;
      };
      expect(bad.isError).toBe(true);
      expect(await rec.handler('send')({ account: ACCOUNT, to: OWNER })).toBe('reached');
    });
  });

  await describe('a delivered message the index cannot take', async () => {
    await it('is reported, not thrown: a retry would send it twice', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-send-'));
      try {
        // A file where the index directory should be: opening the index fails.
        writeFileSync(join(dir, 'blocked'), '');
        const result = recordDelivered(join(dir, 'blocked', 'index.db'), ACCOUNT_INFO, {
          chatJid: OWNER,
          originId: 'id-1',
          text: 'hi',
          sentAt: '2026-08-06T12:00:00.000Z',
        });
        expect(result.messageId).toBe(null);
        expect(result.conversationId).toBe(chatConversationId('xmpp', ACCOUNT, OWNER));
        expect(typeof result.indexError).toBe('string');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
