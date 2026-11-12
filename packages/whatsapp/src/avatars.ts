/**
 * The WhatsApp backend's profile pictures: the small picture of a chat or contact, asked on the
 * connection the receiver already holds (a second login would collide with its session) and then
 * downloaded from the URL the server names.
 *
 * `peer` is the chat's JID as the index holds it.
 */

import { _, type AvatarSource, type ByteSink, fmt } from '@curlew/protocol';
import type { WaAvatarView } from './client.ts';

export class WhatsAppAvatars implements AvatarSource {
  private readonly view: WaAvatarView;
  private readonly download: typeof globalThis.fetch;

  constructor(view: WaAvatarView, download: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init)) {
    this.view = view;
    this.download = download;
  }

  async fetchAvatar(
    peer: string,
    sink: ByteSink,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<{ mimeType: string | null; size: number } | null> {
    if (!peer.includes('@')) return null;
    const url = await this.view.profilePictureUrl(peer);
    if (url === null || !url.startsWith('https://')) return null;
    const response = await this.download(url, { signal: options.signal });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    if (bytes.byteLength > options.maxBytes) {
      throw new Error(
        fmt(_('the picture is larger than the limit of {limit} bytes'), { limit: String(options.maxBytes) }),
      );
    }
    await sink.write(bytes);
    return { mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || null, size: bytes.byteLength };
  }

  /** The connection belongs to the receiver. */
  async close(): Promise<void> {}
}
