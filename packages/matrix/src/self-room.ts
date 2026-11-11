/** Is a room a note-to-self room? Only the homeserver knows the members, and only right now. */

export interface RoomMembersSession {
  homeserver: string;
  accessToken: string;
  fetch: typeof globalThis.fetch;
}

export const isRoomId = (to: string): boolean => to.trim().startsWith('!');

/**
 * Whether every member of the room that is still around — joined, invited, knocking or banned —
 * is `userId`. One GET through the read-only gate; a failed or odd answer is false, so the
 * caller treats the room as somebody else's.
 */
export async function roomHoldsOnly(session: RoomMembersSession, userId: string, roomId: string): Promise<boolean> {
  const base = session.homeserver.replace(/\/+$/, '');
  const url = `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId.trim())}/members?not_membership=leave`;
  const response = await session.fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  if (!response.ok) return false;
  const body = (await response.json()) as { chunk?: unknown };
  if (!Array.isArray(body.chunk) || body.chunk.length === 0) return false;
  const own = userId.trim().toLowerCase();
  return body.chunk.every((event) => {
    const member = event as { state_key?: unknown; content?: { membership?: unknown } };
    return (
      typeof member.state_key === 'string' &&
      member.state_key.toLowerCase() === own &&
      member.content?.membership === 'join'
    );
  });
}
