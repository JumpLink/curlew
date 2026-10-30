/**
 * One subscription to a socket's events, shared by the receive path and a granted send.
 *
 * Shared rather than written twice, for the reason `journal.ts` exists: Baileys acknowledges a
 * delivered message to WhatsApp BEFORE it emits it, and WhatsApp then forgets it. That holds for
 * EVERY connection this package opens — including the second, short-lived socket a granted send
 * runs on, which the server hands the offline queue to exactly like the first. So a message that
 * arrives while curlew is sending has to be mapped and journalled the same way a sync would do
 * it. Two copies of the list below would drift, and the first event the send path forgot to list
 * would be a message lost for good.
 *
 * Nothing here sends: it reads an emitter and a mapper, and hands the result to a sink.
 */

import type { DeliveryEvent } from '@curlew/protocol';
import type { WaConnectionUpdate, WaEventEmitter, WaEventMap, WaEventName } from './api.ts';
import type { WhatsAppMapper } from './map.ts';

type Listener<E extends WaEventName> = (data: WaEventMap[E]) => void;

/** What a subscriber does with what arrived. Only `events` is required. */
export interface MappedEventSink {
  /**
   * Mapped events, with whether this traffic proves a backlog is still flowing — a read receipt
   * or a contact update does not, so it must not keep a finished catch-up alive.
   */
  events(mapped: DeliveryEvent[], activity: boolean): void;
  connection?(update: WaConnectionUpdate): void;
  /** A history-sync chunk arrived; `running` is true while the phase has more to come. */
  history?(running: boolean): void;
  /** A history-sync phase ended. */
  historyDone?(): void;
  creds?(update: WaEventMap['creds.update']): void;
}

/** Subscribe the mapper to everything a socket delivers. Returns the detach. */
export function subscribeMapped(
  ev: WaEventEmitter,
  mapper: WhatsAppMapper,
  sink: MappedEventSink,
): () => void {
  const listeners: Array<[WaEventName, Listener<WaEventName>]> = [];
  const on = <E extends WaEventName>(event: E, listener: Listener<E>) => {
    ev.on(event, listener);
    listeners.push([event, listener as Listener<WaEventName>]);
  };
  const push = (mapped: DeliveryEvent[], activity: boolean) => sink.events(mapped, activity);

  on('connection.update', (u) => sink.connection?.(u));
  on('messages.upsert', ({ messages, type }) =>
    // `notify`: arrived live; `append`: from the offline queue or the phone. Neither is read yet.
    push(
      messages.flatMap((m) => mapper.message(m, false)),
      type === 'notify' || type === 'append',
    ),
  );
  on('messaging-history.set', (set) => {
    sink.history?.(typeof set.progress === 'number' && set.progress < 100);
    push(mapper.history(set), true);
  });
  on('messaging-history.status', () => sink.historyDone?.());
  on('messages.update', (u) => push(mapper.receipts(u), false));
  on('message-receipt.update', (u) => push(mapper.userReceipts(u), false));
  on('messages.delete', (d) => push(mapper.deletion(d), true));
  on('chats.upsert', (chats) =>
    push(
      chats.flatMap((c) => mapper.chat(c, false)),
      false,
    ),
  );
  on('chats.update', (chats) =>
    push(
      chats.flatMap((c) => mapper.chat(c, false)),
      false,
    ),
  );
  on('chats.delete', (ids) => push(mapper.chatDeletion(ids), true));
  on('contacts.upsert', (cs) =>
    push(
      cs.flatMap((c) => mapper.contact(c)),
      false,
    ),
  );
  on('contacts.update', (cs) =>
    push(
      cs.flatMap((c) => mapper.contact(c)),
      false,
    ),
  );
  on('groups.upsert', (gs) =>
    push(
      gs.flatMap((g) => mapper.group(g)),
      false,
    ),
  );
  on('groups.update', (gs) =>
    push(
      gs.flatMap((g) => mapper.group(g)),
      false,
    ),
  );
  on('lid-mapping.update', ({ lid, pn }) => {
    mapper.resolver.learn(lid, pn);
    // No event of its own, but the pair may merge two chats — `takeMerges` picks it up.
    push([], false);
  });
  on('creds.update', (u) => sink.creds?.(u));

  return () => {
    for (const [event, listener] of listeners) ev.off(event, listener);
  };
}
