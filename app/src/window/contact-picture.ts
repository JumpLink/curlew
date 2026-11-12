/**
 * The picture a contact shows. The person's own file beats the part they chose, which beats the
 * profile picture of the newest chat (`pictureSource`). Own pictures are scaled once, when they
 * are picked, and kept in the data directory.
 */

import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Adw from 'gi://Adw?version=1';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import { contactPicturesDir, ensurePrivateDir } from '@curlew/store';

import { loadTexture } from './attachment-store.ts';
import { avatarBackends, loadAvatar } from './avatar-store.ts';
import { type ListEntry, pictureSource } from './conversation-list-model.ts';

/** The address kind a network's profile pictures are asked for by; XMPP group senders are room nicknames. */
const PICTURE_KIND: Readonly<Record<string, string>> = {
  telegram: 'telegram',
  matrix: 'matrix',
  whatsapp: 'whatsapp',
};

/** The side of a saved picture, in pixels: sharp at 96 logical pixels on a 2x screen. */
const SAVED_SIDE = 256;
/** What the decoder scales a picked file down to while it loads, so a 12 MP photo stays cheap. */
const DECODE_SIDE = 512;
/** The box an own picture is decoded into, in device pixels (the list's 40 px avatar on a 2x screen). */
const SHOWN_BOX = { width: 192, height: 192 };

const ownPath = (file: string): string => join(contactPicturesDir(), file);

/** Put the row's picture on `avatar` once there is one; until then the avatar keeps its initials. */
export function showPicture(avatar: Adw.Avatar, entry: ListEntry): void {
  const source = pictureSource(entry, (backend) => avatarBackends().has(backend));
  if (source === null) return;
  if (source.kind === 'chat') {
    const { backend, accountId, target } = source.entry;
    if (target !== null)
      loadAvatar({ backend, accountId, target }, (texture) => avatar.set_custom_image(texture));
    return;
  }
  loadTexture(ownPath(source.file), SHOWN_BOX)
    .then((texture) => avatar.set_custom_image(texture))
    .catch(() => {
      // The file is gone or not a picture: the avatar keeps its fallback.
    });
}

/** The picture of one sender in a group chat, once there is one; initials until then. */
export function showSenderPicture(
  avatar: Adw.Avatar,
  entry: ListEntry,
  address: { kind: string; value: string } | null,
): void {
  if (address === null || PICTURE_KIND[entry.backend] !== address.kind) return;
  loadAvatar({ backend: entry.backend, accountId: entry.accountId, target: address.value }, (texture) =>
    avatar.set_custom_image(texture),
  );
}

/**
 * Scale the picked file to a centred square, save it as PNG and return its name in the contact
 * pictures directory. Throws when the file is not a picture; nothing is left behind then.
 */
export function saveOwnPicture(sourcePath: string): string {
  const loaded = GdkPixbuf.Pixbuf.new_from_file_at_scale(sourcePath, DECODE_SIDE, DECODE_SIDE, true);
  const upright = loaded.apply_embedded_orientation() ?? loaded;
  const side = Math.min(upright.get_width(), upright.get_height());
  const square = upright.new_subpixbuf(
    Math.floor((upright.get_width() - side) / 2),
    Math.floor((upright.get_height() - side) / 2),
    side,
    side,
  );
  const sized =
    side > SAVED_SIDE ? square.scale_simple(SAVED_SIDE, SAVED_SIDE, GdkPixbuf.InterpType.BILINEAR) : square;
  if (!sized) throw new Error('the picture could not be scaled');
  const dir = ensurePrivateDir(contactPicturesDir());
  const file = `${GLib.uuid_string_random()}.png`;
  const part = join(dir, `${file}.part`);
  try {
    sized.savev(part, 'png', [], []);
    renameSync(part, join(dir, file));
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
  return file;
}

/** Forget a picture the person no longer uses. A missing file is nothing to report. */
export function deleteOwnPicture(file: string): void {
  rmSync(ownPath(file), { force: true });
}
