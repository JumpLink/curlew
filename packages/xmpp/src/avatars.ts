/**
 * The XMPP backend's profile pictures: the picture in a contact's vCard (XEP-0054), read over one
 * read-only connection for a whole screenful of rows.
 *
 * Plain IQ gets, so nothing here is visible to the contact. `peer` is the bare JID the index
 * holds as the chat's address.
 */

import { _, type AvatarSource, type ByteSink, fmt } from '@curlew/protocol';
import type { XmppApi } from './api.ts';

export class XmppAvatars implements AvatarSource {
  private readonly api: XmppApi;

  constructor(api: XmppApi) {
    this.api = api;
  }

  async fetchAvatar(
    peer: string,
    sink: ByteSink,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<{ mimeType: string | null; size: number } | null> {
    if (!peer.includes('@')) return null;
    const picture = await this.api.avatar(peer);
    if (picture === null) return null;
    if (picture.bytes.byteLength > options.maxBytes) {
      throw new Error(
        fmt(_('the picture is larger than the limit of {limit} bytes'), { limit: String(options.maxBytes) }),
      );
    }
    await sink.write(picture.bytes);
    return { mimeType: picture.mimeType, size: picture.bytes.byteLength };
  }

  async close(): Promise<void> {
    await this.api.close();
  }
}
