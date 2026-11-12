/**
 * Profile pictures for the chat list. The daemon fetches and caches them (`FetchAvatars`); the
 * window reads the cache straight from disk and asks the daemon only about what is missing or
 * stale. Everything is best effort: without a daemon, an old daemon, or a picture, the row keeps
 * its initials.
 */

import { avatarsDir, configPath } from '@curlew/store';
import type Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';

import { backendsList } from '../core/actions/backends.ts';
import { demoActive } from '../core/demo/active.ts';
import { avatarState } from '../core/lib/avatar-cache.ts';
import { DAEMON_MAX_AVATAR_PEERS, DAEMON_WIRE_VERSION } from '../core/lib/daemon-bus.ts';
import { gioDaemonSendClient } from '../core/lib/daemon-send-client.ts';
import { loadTexture } from './attachment-store.ts';

/** The box a picture is scaled into, in device pixels: the list's 40 px avatar on a 2x screen. */
const BOX = { width: 80, height: 80 };
/** A picture is a few kilobytes; anything near this is not a profile picture. */
const AVATAR_MAX_BYTES = 2_000_000;
/** How many textures stay decoded, so a list rebuilt for a filter does not decode them all again. */
const TEXTURE_CAP = 600;
/** How many pictures one window asks the daemon for, top of the list first. */
const ASK_CAP = 300;
const DEBOUNCE_MS = 150;
/** After this many failed batches in a row the window stops asking until it is restarted. */
const MAX_FAILURES = 3;

export interface AvatarPeer {
  backend: string;
  accountId: string;
  /** `ListEntry.target`. */
  target: string;
}

let capable: Set<string> | null = null;

/** The backends whose manifest says they can fetch a profile picture. */
export function avatarBackends(cfgPath = configPath()): Set<string> {
  capable ??= new Set(
    backendsList(cfgPath)
      .backends.filter((status) => status.capabilities.avatars === true)
      .map((status) => status.name),
  );
  return capable;
}

const textures = new Map<string, Gdk.Texture>();
const waiting = new Map<string, Array<(texture: Gdk.Texture) => void>>();
const asked = new Set<string>();
const pending = new Map<string, { backend: string; accountId: string; peers: string[] }>();
let flushTimer: number | null = null;
let busy = false;
let failures = 0;
let askedCount = 0;

const keyOf = (p: AvatarPeer): string => [p.backend, p.accountId, p.target].join('\u0000');

function remember(key: string, texture: Gdk.Texture): void {
  textures.delete(key);
  textures.set(key, texture);
  if (textures.size > TEXTURE_CAP) textures.delete(textures.keys().next().value as string);
}

function deliver(key: string, texture: Gdk.Texture): void {
  remember(key, texture);
  const callbacks = waiting.get(key) ?? [];
  waiting.delete(key);
  for (const apply of callbacks) {
    try {
      apply(texture);
    } catch {
      // The row was torn down while the picture was on its way.
    }
  }
}

function show(key: string, path: string): void {
  loadTexture(path, BOX).then(
    (texture) => deliver(key, texture),
    () => waiting.delete(key), // Not a picture: the row keeps its initials.
  );
}

function schedule(): void {
  if (flushTimer !== null || busy) return;
  flushTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
    flushTimer = null;
    void flush();
    return GLib.SOURCE_REMOVE;
  });
}

async function flush(): Promise<void> {
  if (demoActive()) {
    pending.clear();
    return;
  }
  if (busy || failures >= MAX_FAILURES) return;
  const [id, group] = pending.entries().next().value ?? [];
  if (id === undefined || group === undefined) return;
  const peers = group.peers.splice(0, DAEMON_MAX_AVATAR_PEERS);
  if (group.peers.length === 0) pending.delete(id);
  busy = true;
  try {
    const reply = await gioDaemonSendClient().fetchAvatars({
      v: DAEMON_WIRE_VERSION,
      backend: group.backend,
      account: group.accountId,
      peers,
      maxBytes: AVATAR_MAX_BYTES,
    });
    if (reply === null || reply.kind === 'failed') {
      failures++;
    } else if (reply.kind === 'fetched') {
      failures = 0;
      for (const [peer, file] of Object.entries(reply.avatars)) {
        const key = keyOf({ backend: group.backend, accountId: group.accountId, target: peer });
        if (file === null) waiting.delete(key);
        else show(key, file.path);
      }
    }
  } catch {
    failures++;
  } finally {
    busy = false;
    if (pending.size > 0) schedule();
  }
}

/**
 * Give `apply` the picture of this chat once there is one. Called for every row: a row that has
 * no picture (or whose backend cannot fetch one) never hears back.
 */
export function loadAvatar(peer: AvatarPeer, apply: (texture: Gdk.Texture) => void): void {
  if (!avatarBackends().has(peer.backend)) return;
  const key = keyOf(peer);
  const known = textures.get(key);
  if (known !== undefined) {
    apply(known);
    return;
  }
  const state = avatarState(avatarsDir(), peer.backend, peer.accountId, peer.target);
  if (state.kind === 'none' && !state.stale) return;
  const callbacks = waiting.get(key);
  if (callbacks) callbacks.push(apply);
  else waiting.set(key, [apply]);
  if (state.kind === 'hit') show(key, state.path);
  if (state.kind === 'hit' && !state.stale) return;
  if (asked.has(key) || askedCount >= ASK_CAP || failures >= MAX_FAILURES) return;
  asked.add(key);
  askedCount++;
  const id = `${peer.backend}\u0000${peer.accountId}`;
  const group = pending.get(id) ?? { backend: peer.backend, accountId: peer.accountId, peers: [] };
  group.peers.push(peer.target);
  pending.set(id, group);
  schedule();
}
