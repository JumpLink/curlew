/**
 * The remote id of a message curlew sent and has not yet met in the network's own history.
 *
 * It has a module of its own because the two places that need it sit on opposite sides of the
 * import graph: `chat-sync.ts` writes and adopts these rows, and `schema.ts` repairs the ones an
 * older curlew left behind. Importing `chat-sync.ts` from there would close the cycle
 * `schema → chat-sync → db → schema`.
 */
export const LOCAL_ECHO_PREFIX = 'local:';
