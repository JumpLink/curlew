/** The attachments of one bubble: a picture for an image, a tile with name, size and buttons for the rest. */

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';
import { _, fmt, _n } from '@curlew/protocol';
import type { MessageRef } from '@curlew/protocol';

import {
  type AttachmentKind,
  attachmentKind,
  boundedSize,
  BUBBLE_MAX_IMAGE_HEIGHT,
  BUBBLE_MAX_IMAGE_WIDTH,
  effectiveMime,
  isOpenable,
  showsInline,
  tileAction,
} from './attachment-model.ts';
import {
  type AttachmentSource,
  failureText,
  fetchAttachment,
  loadTexture,
  openWithDesktop,
  saveCopyAs,
} from './attachment-store.ts';
import { attachmentLine, type AttachmentInfo } from './conversation-model.ts';

export interface AttachmentHandlers {
  /** Opens the viewer on an image or a video. */
  view(source: AttachmentSource, kind: AttachmentKind): void;
  toast(text: string): void;
  /** Starts `load` once `widget` is near the visible part of the history. */
  whenVisible(widget: Gtk.Widget, load: () => void): void;
}

const PLACEHOLDER = { width: 240, height: 160 };

export function attachmentName(info: AttachmentInfo): string {
  return info.filename ?? attachmentLine(info);
}

function sizeText(info: AttachmentInfo): string {
  const mime = effectiveMime(info);
  const type = mime ? Gio.content_type_get_description(mime) : '';
  return info.size === null || info.size === undefined
    ? type
    : [type, GLib.format_size(info.size)].filter(Boolean).join(' · ');
}

function tile(source: AttachmentSource, handlers: AttachmentHandlers): Gtk.Widget {
  const { info } = source;
  const kind = attachmentKind(info);
  const name = attachmentName(info);
  const box = new Gtk.Box({ spacing: 10, marginStart: 8, marginEnd: 8, marginTop: 8, marginBottom: 8 });
  box.add_css_class('card');
  box.set_tooltip_text(name);
  const mime = effectiveMime(info) ?? 'application/octet-stream';
  box.append(new Gtk.Image({ gicon: Gio.content_type_get_icon(mime), pixelSize: 32, marginStart: 4 }));

  const text = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    hexpand: true,
    valign: Gtk.Align.CENTER,
  });
  text.append(
    new Gtk.Label({ label: name, xalign: 0, ellipsize: Pango.EllipsizeMode.MIDDLE, maxWidthChars: 28 }),
  );
  const detail = new Gtk.Label({
    label: sizeText(info),
    xalign: 0,
    ellipsize: Pango.EllipsizeMode.END,
    maxWidthChars: 28,
  });
  detail.add_css_class('caption');
  detail.add_css_class('dim-label');
  text.append(detail);
  box.append(text);

  const openable = isOpenable(info);
  const action = tileAction(kind);
  let open: Gtk.Button | null = null;
  let save: Gtk.Button | null = null;
  if (openable) {
    open = new Gtk.Button({
      iconName: action === 'view' ? 'media-playback-start-symbolic' : 'document-open-symbolic',
      tooltipText: action === 'view' ? _('Play') : _('Open'),
      valign: Gtk.Align.CENTER,
    });
    save = new Gtk.Button({
      iconName: 'document-save-symbolic',
      tooltipText: _('Save as…'),
      valign: Gtk.Align.CENTER,
    });
    for (const button of [open, save]) {
      button.add_css_class('flat');
      button.add_css_class('circular');
      box.append(button);
    }
  }

  if (openable) {
    // The button is blocked while the part is fetched, so a second click cannot start a second fetch.
    const run = (button: Gtk.Button, work: (path: string, window: Gtk.Window | null) => Promise<unknown>) => {
      button.set_sensitive(false);
      const window = button.get_root() as Gtk.Window | null;
      void fetchAttachment(source)
        .then((path) => work(path, window))
        .catch((err: unknown) =>
          handlers.toast(fmt(_('Could not fetch the attachment: {error}'), { error: failureText(err) })),
        )
        // The window may have been closed while the part was fetched; a button that is gone from
        // the tree has no state left to restore.
        .finally(() => {
          if (button.get_root() !== null) button.set_sensitive(true);
        });
    };
    open!.connect('clicked', () => {
      if (action === 'view') handlers.view(source, kind);
      else run(open!, (path, window) => openWithDesktop(window, path));
    });
    save!.connect('clicked', () =>
      run(save!, (path, window) => saveCopyAs(window, path, GLib.path_get_basename(path))),
    );
  }
  return box;
}

/** A placeholder tile for a chat message whose backend said it has attachments but gave no descriptors yet. */
function genericTile(): Gtk.Widget {
  const box = new Gtk.Box({ spacing: 10, marginStart: 8, marginEnd: 8, marginTop: 8, marginBottom: 8 });
  box.add_css_class('card');
  box.set_tooltip_text(_('Attachment'));
  box.append(
    new Gtk.Image({
      gicon: Gio.content_type_get_icon('application/octet-stream'),
      pixelSize: 32,
      marginStart: 4,
    }),
  );
  const text = new Gtk.Label({
    label: _('Attachment'),
    xalign: 0,
    ellipsize: Pango.EllipsizeMode.MIDDLE,
    maxWidthChars: 28,
  });
  text.add_css_class('dim-label');
  box.append(text);
  return box;
}

/** A picture that loads when it is near the screen; a failed load becomes the tile. */
function picture(source: AttachmentSource, handlers: AttachmentHandlers): Gtk.Widget {
  const slot = new Gtk.Box({ halign: Gtk.Align.START });
  const frame = new Gtk.Overlay({ halign: Gtk.Align.START, overflow: Gtk.Overflow.HIDDEN });
  frame.add_css_class('card');
  const image = new Gtk.Picture({
    contentFit: Gtk.ContentFit.SCALE_DOWN,
    canShrink: true,
    widthRequest: PLACEHOLDER.width,
    heightRequest: PLACEHOLDER.height,
  });
  const button = new Gtk.Button({ child: image, tooltipText: attachmentName(source.info) });
  button.add_css_class('flat');
  button.add_css_class('image-button');
  const spinner = new Adw.Spinner({
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
    widthRequest: 32,
    heightRequest: 32,
    visible: false,
  });
  frame.set_child(button);
  frame.add_overlay(spinner);
  slot.append(frame);
  button.connect('clicked', () => handlers.view(source, 'image'));

  const fail = () => {
    slot.remove(frame);
    slot.append(tile(source, handlers));
  };
  const load = (): void => {
    spinner.set_visible(true);
    // The box the bubble gives a picture, in the pixels the texture is decoded at.
    const scale = frame.get_scale_factor();
    void fetchAttachment(source)
      .then((path) =>
        loadTexture(path, {
          width: BUBBLE_MAX_IMAGE_WIDTH * scale,
          height: BUBBLE_MAX_IMAGE_HEIGHT * scale,
        }),
      )
      .then((texture) => {
        // The bubble left the window while the picture decoded; there is nothing to paint into.
        if (frame.get_root() === null) return;
        const size = boundedSize({
          width: texture.get_width() / scale,
          height: texture.get_height() / scale,
        });
        image.set_paintable(texture);
        image.set_size_request(size.width, size.height);
        spinner.set_visible(false);
      })
      .catch(() => {
        if (frame.get_root() === null) return;
        fail();
      });
  };
  handlers.whenVisible(frame, load);
  return slot;
}

/** The attachments of a message, stacked; `more` names the ones left out. */
export function attachmentList(
  ref: MessageRef,
  shown: readonly AttachmentInfo[],
  more: number,
  handlers: AttachmentHandlers,
  generic = false,
): Gtk.Box {
  const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
  for (const info of shown) {
    const source = { ref, info };
    list.append(showsInline(info) ? picture(source, handlers) : tile(source, handlers));
  }
  if (generic) list.append(genericTile());
  if (more > 0) {
    const rest = new Gtk.Label({
      label: fmt(_n('and {n} more attachment', 'and {n} more attachments', more), { n: more }),
      xalign: 0,
    });
    rest.add_css_class('caption');
    rest.add_css_class('dim-label');
    list.append(rest);
  }
  return list;
}
