import { describe, expect, it } from '@gjsify/unit';

import {
  extractHeaderFields,
  imapLiteralPlaceholder,
  parseEnvelope,
  parseFetchAttributes,
  parseMessageIdList,
  parseDispositionNotification,
  parseThreadHeaders,
  threadHeaderFetchItem,
  tokenizeImapList,
} from '@curlew/protocol';

// Threading and classification headers. Synthetic data only.

const HEADER_BLOCK =
  'References: <a1@example.org>\r\n <a2@example.org>\r\n' +
  "In-Reply-To: <a2@example.org> (Anna's message of Monday)\r\n" +
  'List-Id: =?UTF-8?Q?Verein_M=C3=BCnster?= <verein.example.org>\r\n' +
  'Precedence: bulk\r\n\r\n';

export default async () => {
  await describe('tokenizeImapList: FETCH sections with spaces', async () => {
    await it('keeps BODY[HEADER.FIELDS (…)] as ONE key, so later pairs stay aligned', async () => {
      // Split at its spaces, the key became three tokens and every following key/value pair
      // shifted by one — the UID would have been read as a value.
      const line = `* 3 FETCH (BODY[HEADER.FIELDS (REFERENCES LIST-ID)] ${imapLiteralPlaceholder(0)} UID 42 FLAGS (\\Seen))`;
      const items = tokenizeImapList(line, [HEADER_BLOCK]);
      expect(items.length).toBe(6);
      expect(items[0]).toBe('BODY[HEADER.FIELDS (REFERENCES LIST-ID)]');
      expect(parseFetchAttributes(items).uid).toBe('42');
      expect(extractHeaderFields(items)).toBe(HEADER_BLOCK);
    });

    await it('leaves a bracketed mailbox atom alone', async () => {
      // Only BODY/BINARY sections are special; `[Gmail]/Sent` is an ordinary atom.
      expect(tokenizeImapList('("/" [Gmail]/Sent)')).toEqualArray(['/', '[Gmail]/Sent']);
    });

    await it('asks for the headers with PEEK, so a sync never sets \\Seen', async () => {
      expect(threadHeaderFetchItem().startsWith('BODY.PEEK[HEADER.FIELDS (')).toBe(true);
      expect(threadHeaderFetchItem()).toContain('REFERENCES');
      expect(threadHeaderFetchItem()).toContain('LIST-UNSUBSCRIBE');
    });
  });

  await describe('parseMessageIdList', async () => {
    await it('returns bracketed ids in order, without duplicates or prose', async () => {
      expect(parseMessageIdList('<a@x> <b@x>\t<a@x> (a comment)')).toEqualArray(['<a@x>', '<b@x>']);
    });

    await it('ignores bare, unbracketed tokens rather than guessing', async () => {
      expect(parseMessageIdList('a@x')).toEqualArray([]);
      expect(parseMessageIdList(null)).toEqualArray([]);
    });
  });

  await describe('parseThreadHeaders', async () => {
    await it('unfolds References and takes the id out of a chatty In-Reply-To', async () => {
      const parsed = parseThreadHeaders(HEADER_BLOCK);
      expect(parsed.references).toEqualArray(['<a1@example.org>', '<a2@example.org>']);
      expect(parsed.inReplyTo).toBe('<a2@example.org>');
    });

    await it('decodes the automation headers and reports absent ones as null', async () => {
      const { automation } = parseThreadHeaders(HEADER_BLOCK);
      expect(automation.listId).toBe('Verein Münster <verein.example.org>');
      expect(automation.precedence).toBe('bulk');
      expect(automation.listUnsubscribe).toBe(null);
      expect(automation.autoSubmitted).toBe(null);
    });

    await it('recognises a reaction mail by its Content-Disposition', async () => {
      expect(parseThreadHeaders('Content-Disposition: reaction\r\n').reaction).toBe(true);
      expect(parseThreadHeaders('Content-Disposition: attachment; filename=a\r\n').reaction).toBe(false);
      expect(parseThreadHeaders('').reaction).toBe(false);
    });

    await it('reads Chat-Edit and Chat-Delete with or without angle brackets', async () => {
      const parsed = parseThreadHeaders(
        'Chat-Edit: 00001@example.org\r\nChat-Delete: <00003@example.org>\r\n',
      );
      expect(parsed.chatEdit).toBe('<00001@example.org>');
      expect(parsed.chatDelete).toBe('<00003@example.org>');
      expect(parseThreadHeaders('').chatEdit).toBe(null);
      expect(parseThreadHeaders('Chat-Edit: a b\r\n').chatEdit).toBe(null);
    });

    await it('reads the receipt address only from Chat-Disposition-Notification-To', async () => {
      const asked = parseThreadHeaders('Chat-Disposition-Notification-To: Anna <Anna@Example.org>\r\n');
      expect(asked.receiptTo).toBe('anna@example.org');
      // A plain Disposition-Notification-To (newsletters, spam) is never a request we answer.
      expect(parseThreadHeaders('Disposition-Notification-To: anna@example.org\r\n').receiptTo).toBe(null);
      expect(parseThreadHeaders('Chat-Disposition-Notification-To: not an address\r\n').receiptTo).toBe(null);
    });

    await it('recognises a read receipt and reads what it confirms', async () => {
      expect(
        parseThreadHeaders(
          'Content-Type: multipart/report; report-type=disposition-notification; boundary=x\r\n',
        ).mdn,
      ).toBe(true);
      expect(parseThreadHeaders('Content-Type: multipart/mixed; boundary=x\r\n').mdn).toBe(false);
      const report = [
        'Reporting-UA: Example',
        'Original-Recipient: rfc822;ben@example.org',
        'Original-Message-ID: <t1@example.org>',
        'Disposition: manual-action/MDN-sent-manually; displayed',
      ].join('\r\n');
      expect(parseDispositionNotification(report)).toStrictEqual({
        originalMessageId: '<t1@example.org>',
        displayed: true,
      });
      const other = report.replace('displayed', 'deleted');
      expect(parseDispositionNotification(other).displayed).toBe(false);
    });

    await it('yields empty threading for an empty block', async () => {
      const parsed = parseThreadHeaders('');
      expect(parsed.references.length).toBe(0);
      expect(parsed.inReplyTo).toBe(null);
    });
  });

  await describe('parseEnvelope in-reply-to', async () => {
    await it('reads the ENVELOPE in-reply-to field as the fallback source', async () => {
      const env = tokenizeImapList(
        '(NIL "Re: Hi" NIL NIL NIL NIL NIL NIL "<parent@example.org>" "<child@example.org>")',
      );
      expect(parseEnvelope(env).inReplyTo).toBe('<parent@example.org>');
      expect(parseEnvelope(tokenizeImapList('(NIL NIL NIL NIL NIL NIL NIL NIL NIL NIL)')).inReplyTo).toBe(
        null,
      );
    });
  });

  await describe('Delta Chat voice note and sticker headers', async () => {
    const block = (...lines: string[]) => lines.join('\r\n') + '\r\n\r\n';

    await it('types a voice note with its duration', async () => {
      const parsed = parseThreadHeaders(
        block('Chat-Version: 1.0', 'Chat-Voice-Message: 1', 'Chat-Duration: 4200'),
      );
      expect(parsed.chatContent).toBe('voice');
      expect(parsed.durationMs).toBe(4200);
    });

    await it('accepts a voice note without Chat-Duration', async () => {
      const parsed = parseThreadHeaders(block('Chat-Version: 1.0', 'Chat-Voice-Message: 1'));
      expect(parsed.chatContent).toBe('voice');
      expect(parsed.durationMs).toBe(null);
      const garbled = parseThreadHeaders(
        block('Chat-Version: 1.0', 'Chat-Voice-Message: 1', 'Chat-Duration: soon'),
      );
      expect(garbled.durationMs).toBe(null);
    });

    await it('types a sticker', async () => {
      const parsed = parseThreadHeaders(block('Chat-Version: 1.0', 'Chat-Content: sticker'));
      expect(parsed.chatContent).toBe('sticker');
      expect(parsed.durationMs).toBe(null);
    });

    await it('ignores the headers on plain mail', async () => {
      const parsed = parseThreadHeaders(block('Chat-Voice-Message: 1', 'Chat-Duration: 900'));
      expect(parsed.chatContent).toBe(null);
      expect(parsed.durationMs).toBe(null);
    });
  });
};
