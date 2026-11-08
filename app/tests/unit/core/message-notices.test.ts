import { describe, expect, it } from '@gjsify/unit';

import type { ChangeRow } from '@curlew/store';
import { freshDb } from '../store/fixtures.ts';
import { MAX_NOTICES_PER_POLL, newNoticeState, planNotices } from '../../../src/core/lib/message-notices.ts';

type Db = ReturnType<typeof freshDb>;

const SINCE = new Date('2026-11-08T10:00:00Z');

interface Seed {
  id: string;
  at?: string;
  body?: string | null;
  fromSelf?: boolean;
  seen?: boolean;
  presentation?: string;
  attachment?: boolean;
  sender?: string | null;
}

function chat(db: Db, id: string, title: string, kind: 'direct' | 'group', backend = 'telegram'): void {
  db.prepare(
    `INSERT INTO conversations (id, backend, account_id, kind, title, classification, classification_reason)
     VALUES (?, ?, 'acct', ?, ?, 'chat', 'synthetic')`,
  ).run(id, backend, kind, title);
}

let seq = 0;
function message(db: Db, conversationId: string, backend: string, seed: Seed): void {
  seq += 1;
  db.prepare(
    `INSERT INTO conversation_messages
       (id, conversation_id, backend, account_id, presentation, sender_name, from_self, sent_at, seen,
        has_attachments, classification, classification_reason, remote_id, remote_seq, body)
     VALUES (?, ?, ?, 'acct', ?, ?, ?, ?, ?, ?, 'chat', 'synthetic', ?, ?, ?)`,
  ).run(
    seed.id,
    conversationId,
    backend,
    seed.presentation ?? 'bubble',
    seed.sender === undefined ? 'Alex Example' : seed.sender,
    seed.fromSelf ? 1 : 0,
    seed.at ?? '2026-11-08T10:05:00Z',
    seed.seen ? 1 : 0,
    seed.attachment ? 1 : 0,
    seed.id,
    seq,
    seed.body === undefined ? 'Hello there' : seed.body,
  );
}

function touched(...ids: string[]): ChangeRow[] {
  return ids.map((conversationId, i) => ({
    seq: i + 1,
    at: SINCE.toISOString(),
    kind: 'messages',
    backend: 'telegram',
    accountId: 'acct',
    conversationId,
  }));
}

export default async () => {
  await describe('planNotices', async () => {
    await it('announces an incoming unread chat message with its text', async () => {
      const db = freshDb();
      try {
        chat(db, 'c1', 'Alex Example', 'direct');
        message(db, 'c1', 'telegram', { id: 'm1' });
        const [notice, ...rest] = planNotices(db, touched('c1'), 'preview', newNoticeState(SINCE));
        expect(rest.length).toBe(0);
        expect(notice.title).toBe('Alex Example');
        expect(notice.body).toBe('Hello there');
        expect(notice.conversationId).toBe('c1');
      } finally {
        db.close();
      }
    });

    await it('leaves the text out unless the mode is preview', async () => {
      const db = freshDb();
      try {
        chat(db, 'c1', 'Alex Example', 'direct');
        message(db, 'c1', 'telegram', { id: 'm1', body: 'a secret' });
        const [notice] = planNotices(db, touched('c1'), 'sender', newNoticeState(SINCE));
        expect(notice.body).toBe('New message');
        expect(notice.body.includes('secret')).toBe(false);
      } finally {
        db.close();
      }
    });

    await it('says nothing when notifications are off', async () => {
      const db = freshDb();
      try {
        chat(db, 'c1', 'Alex Example', 'direct');
        message(db, 'c1', 'telegram', { id: 'm1' });
        expect(planNotices(db, touched('c1'), 'off', newNoticeState(SINCE)).length).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('skips mail, the own messages, read ones, history and notices', async () => {
      const db = freshDb();
      try {
        chat(db, 'mail', 'Inbox thread', 'direct', 'mail');
        message(db, 'mail', 'mail', { id: 'mm' });
        chat(db, 'c1', 'Alex Example', 'direct');
        message(db, 'c1', 'telegram', { id: 'own', fromSelf: true });
        message(db, 'c1', 'telegram', { id: 'read', seen: true });
        message(db, 'c1', 'telegram', { id: 'old', at: '2026-11-08T09:00:00Z' });
        message(db, 'c1', 'telegram', { id: 'notice', presentation: 'notice' });
        expect(planNotices(db, touched('mail', 'c1'), 'preview', newNoticeState(SINCE)).length).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('shows the last few lines, and the sender in a group', async () => {
      const db = freshDb();
      try {
        chat(db, 'g1', 'Harbour crew', 'group');
        for (let i = 1; i <= 5; i++) {
          message(db, 'g1', 'telegram', {
            id: `m${i}`,
            at: `2026-11-08T10:0${i}:00Z`,
            body: `line ${i}`,
            sender: i % 2 ? 'Alex Example' : 'Sam Example',
          });
        }
        const [notice] = planNotices(db, touched('g1'), 'preview', newNoticeState(SINCE));
        expect(notice.body).toBe('Alex Example: line 3\nSam Example: line 4\nAlex Example: line 5');
      } finally {
        db.close();
      }
    });

    await it('counts the messages instead when it may not show them', async () => {
      const db = freshDb();
      try {
        chat(db, 'c1', 'Alex Example', 'direct');
        message(db, 'c1', 'telegram', { id: 'm1', at: '2026-11-08T10:01:00Z' });
        message(db, 'c1', 'telegram', { id: 'm2', at: '2026-11-08T10:02:00Z' });
        const [notice] = planNotices(db, touched('c1'), 'sender', newNoticeState(SINCE));
        expect(notice.body).toBe('2 new messages');
      } finally {
        db.close();
      }
    });

    await it('names an attachment when the message has no text', async () => {
      const db = freshDb();
      try {
        chat(db, 'c1', 'Alex Example', 'direct');
        message(db, 'c1', 'telegram', { id: 'm1', body: '', attachment: true });
        const [notice] = planNotices(db, touched('c1'), 'preview', newNoticeState(SINCE));
        expect(notice.body).toBe('Sent an attachment');
      } finally {
        db.close();
      }
    });

    await it('does not announce a message twice, but does the next one', async () => {
      const db = freshDb();
      try {
        chat(db, 'c1', 'Alex Example', 'direct');
        message(db, 'c1', 'telegram', { id: 'm1', at: '2026-11-08T10:01:00Z', body: 'one' });
        const state = newNoticeState(SINCE);
        expect(planNotices(db, touched('c1'), 'preview', state).length).toBe(1);
        expect(planNotices(db, touched('c1'), 'preview', state).length).toBe(0);
        message(db, 'c1', 'telegram', { id: 'm2', at: '2026-11-08T10:02:00Z', body: 'two' });
        const [notice] = planNotices(db, touched('c1'), 'preview', state);
        expect(notice.body).toBe('two');
      } finally {
        db.close();
      }
    });

    await it('folds a flood of chats into one summary', async () => {
      const db = freshDb();
      try {
        const ids: string[] = [];
        for (let i = 0; i < MAX_NOTICES_PER_POLL + 3; i++) {
          chat(db, `c${i}`, `Chat ${i}`, 'direct');
          message(db, `c${i}`, 'telegram', { id: `m${i}` });
          ids.push(`c${i}`);
        }
        const notices = planNotices(db, touched(...ids), 'preview', newNoticeState(SINCE));
        expect(notices.length).toBe(MAX_NOTICES_PER_POLL);
        expect(notices[notices.length - 1].body).toBe('4 more chats have new messages');
      } finally {
        db.close();
      }
    });

    await it('ignores journal rows that name no chat', async () => {
      const db = freshDb();
      try {
        chat(db, 'c1', 'Alex Example', 'direct');
        message(db, 'c1', 'telegram', { id: 'm1' });
        const rows: ChangeRow[] = [
          { seq: 1, at: '', kind: 'accounts', backend: null, accountId: null, conversationId: null },
          { seq: 2, at: '', kind: 'messages', backend: 'telegram', accountId: 'acct', conversationId: null },
        ];
        expect(planNotices(db, rows, 'preview', newNoticeState(SINCE)).length).toBe(0);
      } finally {
        db.close();
      }
    });
  });
};
