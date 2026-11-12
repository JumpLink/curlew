/**
 * The Matrix backend's profile pictures: the picture of a room, or for a direct chat the one of
 * the person on the other side, as a small thumbnail from the account's own homeserver.
 *
 * Plain HTTP GETs through the read-only gate, like the attachment download. `peer` is the room id,
 * which is what the index holds as the chat's address.
 */

import { type AvatarSource, type ByteSink, fmt, _ } from '@curlew/protocol';
import { parseMxc } from './map.ts';

/** The thumbnail edge in pixels: the list's 40 px avatar on a 2x screen, with room to spare. */
const EDGE = 96;
const AUTHENTICATED = '/_matrix/client/v1/media/thumbnail';
const LEGACY = '/_matrix/media/v3/thumbnail';

export interface MatrixAvatarsSession {
  /** Base URL without a trailing slash, as the account file holds it. */
  homeserver: string;
  accessToken: string;
  /** The account's own user id: the member that is not the other side of a direct chat. */
  userId: string;
  /** Already wrapped in `readOnlyFetch`. */
  fetch: typeof globalThis.fetch;
  /** Releases the account file once the fetches are done. */
  onClose?: () => void;
}

export class MatrixAvatars implements AvatarSource {
  private readonly session: MatrixAvatarsSession;

  constructor(session: MatrixAvatarsSession) {
    this.session = session;
  }

  private get(path: string, signal?: AbortSignal): Promise<Response> {
    const base = this.session.homeserver.replace(/\/+$/, '');
    return this.session.fetch(`${base}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.session.accessToken}` },
      signal,
    });
  }

  /** The room's own picture, or null: a room without one answers 404, one we left 403. */
  private async roomAvatar(roomId: string, signal?: AbortSignal): Promise<string | null> {
    const response = await this.get(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.avatar`,
      signal,
    );
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { url?: unknown } | null;
    return typeof body?.url === 'string' && body.url !== '' ? body.url : null;
  }

  /** In a chat of exactly two, the other member's picture; a group without one of its own has none. */
  private async otherAvatar(roomId: string, signal?: AbortSignal): Promise<string | null> {
    const response = await this.get(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`, signal);
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as {
      joined?: Record<string, { avatar_url?: unknown }>;
    } | null;
    const others = Object.entries(body?.joined ?? {}).filter(([user]) => user !== this.session.userId);
    if (others.length !== 1) return null;
    const url = others[0]?.[1]?.avatar_url;
    return typeof url === 'string' && url !== '' ? url : null;
  }

  /** The thumbnail, the authenticated endpoint first and the legacy one if the server predates it. */
  private async thumbnail(mxc: string, signal?: AbortSignal): Promise<Response | null> {
    const parsed = parseMxc(mxc);
    if (parsed === null) return null;
    const path = `${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.mediaId)}`;
    const query = `width=${EDGE}&height=${EDGE}&method=crop`;
    const first = await this.get(`${AUTHENTICATED}/${path}?${query}`, signal);
    if (first.ok) return first;
    if (first.status !== 404) return null;
    const legacy = await this.get(`${LEGACY}/${path}?${query}&allow_redirect=true`, signal);
    return legacy.ok ? legacy : null;
  }

  async fetchAvatar(
    peer: string,
    sink: ByteSink,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<{ mimeType: string | null; size: number } | null> {
    if (!peer.startsWith('!')) return null;
    const mxc = (await this.roomAvatar(peer, options.signal)) ?? (await this.otherAvatar(peer, options.signal));
    if (mxc === null) return null;
    const response = await this.thumbnail(mxc, options.signal);
    if (response === null) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    if (bytes.byteLength > options.maxBytes) {
      throw new Error(fmt(_('the picture is larger than the limit of {limit} bytes'), { limit: String(options.maxBytes) }));
    }
    await sink.write(bytes);
    return { mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || null, size: bytes.byteLength };
  }

  async close(): Promise<void> {
    this.session.onClose?.();
  }
}
