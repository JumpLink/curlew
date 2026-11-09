/** The attachments of one bubble: a picture for an image, a tile with name, size and buttons for the rest. */

import Adw from 'gi://Adw?version=1';
import type Gdk from 'gi://Gdk?version=4.0';
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
  durationLabel,
  effectiveMime,
  isGridMedia,
  isOpenable,
  showsInline,
  showsPoster,
  tileAction,
} from './attachment-model.ts';
import {
  type AttachmentSource,
  failureText,
  fetchAttachment,
  loadPoster,
  loadTexture,
  openWithDesktop,
  saveCopyAs,
} from './attachment-store.ts';
import { attachmentLine, type AttachmentInfo } from './conversation-model.ts';
import { type GridCell, gridLayout, MAX_GRID_CELLS } from './media-grid-model.ts';

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

/** What an inline preview paints: the picture, or a video's first frame, and its natural size. */
interface Painted {
  paintable: Gdk.Paintable;
  width: number;
  height: number;
}

/**
 * A preview that loads when it is near the screen and opens the viewer when pressed; a failed load
 * becomes the tile. A video's carries a play symbol so it is not mistaken for a picture, and its
 * length. In a grid (`cell`) it has the cell's fixed size, crops to fill it, and a failed load
 * leaves the cell dark with the symbol: a tile would not fit. `paint` null shows only that dark
 * cell, for a part too big to fetch unasked.
 */
function inlinePreview(
  source: AttachmentSource,
  handlers: AttachmentHandlers,
  kind: AttachmentKind,
  paint: ((path: string, scale: number) => Promise<Painted>) | null,
  cell: GridCell | null = null,
): Gtk.Widget {
  const slot = new Gtk.Box({ halign: Gtk.Align.START });
  const frame = new Gtk.Overlay({ halign: Gtk.Align.START, overflow: Gtk.Overflow.HIDDEN });
  if (!cell) frame.add_css_class('card');
  const image = new Gtk.Picture({
    contentFit: cell ? Gtk.ContentFit.COVER : Gtk.ContentFit.SCALE_DOWN,
    canShrink: true,
    widthRequest: cell?.width ?? PLACEHOLDER.width,
    heightRequest: cell?.height ?? PLACEHOLDER.height,
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
  const symbol = (iconName: string): Gtk.Widget => {
    // A button only for its round OSD look: it sits over the frame and lets the press through.
    const badge = new Gtk.Button({
      iconName,
      halign: Gtk.Align.CENTER,
      valign: Gtk.Align.CENTER,
      canTarget: false,
      canFocus: false,
    });
    badge.add_css_class('osd');
    badge.add_css_class('circular');
    return badge;
  };
  if (kind === 'video') {
    frame.add_overlay(symbol('media-playback-start-symbolic'));
    const length = durationLabel(source.info.durationMs);
    if (length) {
      const badge = new Gtk.Label({
        label: length,
        halign: Gtk.Align.START,
        valign: Gtk.Align.START,
        marginStart: 6,
        marginTop: 6,
        canTarget: false,
      });
      badge.add_css_class('osd');
      badge.add_css_class('caption');
      badge.add_css_class('numeric');
      frame.add_overlay(badge);
    }
  }
  slot.append(frame);
  button.connect('clicked', () => handlers.view(source, kind));

  const fail = () => {
    spinner.set_visible(false);
    if (cell) {
      image.set_paintable(null);
      return;
    }
    slot.remove(frame);
    slot.append(tile(source, handlers));
  };
  const load = (): void => {
    if (!paint) return;
    spinner.set_visible(true);
    // The box the bubble gives a picture, in the pixels the texture is decoded at.
    const scale = frame.get_scale_factor();
    void fetchAttachment(source)
      .then((path) => paint(path, scale))
      .then((painted) => {
        // The bubble left the window while the picture decoded; there is nothing to paint into.
        if (frame.get_root() === null) return;
        image.set_paintable(painted.paintable);
        if (!cell) {
          const size = boundedSize({ width: painted.width / scale, height: painted.height / scale });
          image.set_size_request(size.width, size.height);
        }
        spinner.set_visible(false);
      })
      .catch(() => {
        if (frame.get_root() === null) return;
        fail();
      });
  };
  if (paint) handlers.whenVisible(frame, load);
  return slot;
}

function picture(
  source: AttachmentSource,
  handlers: AttachmentHandlers,
  cell: GridCell | null = null,
): Gtk.Widget {
  const box = {
    width: cell?.width ?? BUBBLE_MAX_IMAGE_WIDTH,
    height: cell?.height ?? BUBBLE_MAX_IMAGE_HEIGHT,
  };
  return inlinePreview(
    source,
    handlers,
    'image',
    async (path, scale) => {
      const texture = await loadTexture(path, { width: box.width * scale, height: box.height * scale });
      return { paintable: texture, width: texture.get_width(), height: texture.get_height() };
    },
    cell,
  );
}

function poster(
  source: AttachmentSource,
  handlers: AttachmentHandlers,
  cell: GridCell | null = null,
): Gtk.Widget {
  return inlinePreview(
    source,
    handlers,
    'video',
    async (path) => {
      const frame = await loadPoster(path);
      return { paintable: frame, width: frame.get_intrinsic_width(), height: frame.get_intrinsic_height() };
    },
    cell,
  );
}

/** One cell of the grid: the picture or first frame when it may load unasked, else the dark cell. */
function gridCell(source: AttachmentSource, handlers: AttachmentHandlers, cell: GridCell): Gtk.Widget {
  const { info } = source;
  if (showsInline(info)) return picture(source, handlers, cell);
  if (showsPoster(info)) return poster(source, handlers, cell);
  return inlinePreview(source, handlers, attachmentKind(info), null, cell);
}

/** A message's pictures and videos as one block (docs/design/media-grid.md). */
function mediaGrid(
  ref: MessageRef,
  media: readonly AttachmentInfo[],
  handlers: AttachmentHandlers,
): Gtk.Widget {
  const layout = gridLayout(media, BUBBLE_MAX_IMAGE_WIDTH);
  const fixed = new Gtk.Fixed({ halign: Gtk.Align.START, overflow: Gtk.Overflow.HIDDEN });
  fixed.add_css_class('card');
  fixed.set_size_request(layout.width, layout.height);
  layout.cells.forEach((cell, i) => {
    const info = media[i] as AttachmentInfo;
    fixed.put(gridCell({ ref: info.ref ?? ref, info }, handlers, cell), cell.x, cell.y);
  });
  return fixed;
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
  // Two or more pictures and videos form a grid; one keeps its own shape. The rest stay tiles.
  const media = shown.filter(isGridMedia).slice(0, MAX_GRID_CELLS);
  const gridded = media.length > 1 ? new Set(media) : new Set<AttachmentInfo>();
  let placed = false;
  for (const info of shown) {
    if (gridded.has(info)) {
      if (!placed) list.append(mediaGrid(ref, media, handlers));
      placed = true;
      continue;
    }
    const source = { ref: info.ref ?? ref, info };
    list.append(
      showsInline(info)
        ? picture(source, handlers)
        : showsPoster(info)
          ? poster(source, handlers)
          : tile(source, handlers),
    );
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
