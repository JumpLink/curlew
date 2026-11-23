import type { MailEndpointOpener } from '@curlew/protocol';

import { rawMessage, resolveMessageId } from './message.ts';
import type { OutgoingMessage, SendResult, SmtpAccount } from './types.ts';
import { validateAccount } from './validate.ts';
import { sendOverWire } from './wire.ts';
import type { WireOptions } from './wire.ts';

/**
 * Opt-in: speak SMTP ourselves over this opener instead of handing the connection to nodemailer
 * (ADR 0018 amendment). Without it the nodemailer transport runs, as before.
 */
export interface WireTransport extends WireOptions {
  open: MailEndpointOpener;
}

/**
 * Compose the message and send it over the wire client. This file is the whole Android send
 * path: it imports the composer but not nodemailer's transport, so a platform without
 * `node:net` and `node:tls` can bundle it.
 */
export async function sendMessageOverWire(
  account: SmtpAccount,
  message: OutgoingMessage,
  wire: WireTransport,
): Promise<SendResult> {
  validateAccount(account);
  const messageId = resolveMessageId(message);
  const to = message.mdn === undefined ? [...message.to, ...(message.cc ?? [])] : message.to;
  const result = await sendOverWire(
    account,
    { from: message.from, to },
    await rawMessage(message, messageId),
    wire.open,
    wire,
  );
  return { messageId, ...result };
}
