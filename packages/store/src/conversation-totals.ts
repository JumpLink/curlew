/**
 * The five `conversations` header columns that summarise the messages beneath them — count,
 * unread, first and last timestamp, attachments.
 *
 * Two engines write them: `syncChats` (`chat-sync.ts`) and `receiveDeliveries`
 * (`delivery-sync.ts`), each after its own batch and each selecting its own rows — a backend's
 * chats there, an id list here. The selection therefore stays with the caller; what must be one
 * text is the SET half, or the two copies drift and a conversation's header depends on which
 * engine wrote it.
 *
 * `schema.ts` carries a third copy inside the v12 upgrade. That one is historical: a migration
 * is a record of what the binary of that day ran, so it must not follow this helper.
 */
export function conversationTotalsSql(where: string): string {
  return `UPDATE conversations SET
       message_count = (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = conversations.id),
       unread_count = (SELECT COUNT(*) FROM conversation_messages m
                        WHERE m.conversation_id = conversations.id AND m.from_self = 0 AND m.seen = 0),
       first_message_at = (SELECT MIN(sent_at) FROM conversation_messages m WHERE m.conversation_id = conversations.id),
       last_message_at = (SELECT MAX(sent_at) FROM conversation_messages m WHERE m.conversation_id = conversations.id),
       has_attachments = (SELECT COUNT(*) > 0 FROM conversation_messages m
                           WHERE m.conversation_id = conversations.id AND m.has_attachments = 1)
     WHERE ${where}`;
}
