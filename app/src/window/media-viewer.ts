/**
 * The media viewer: an overlay over the whole window, not a window of its own (Fractal and Tuba do
 * the same). One image or video at a time, with previous/next and a swipe through the other
 * pictures and videos of the same message; no zoom or opening animation yet.
 */

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _, fmt } from '@curlew/protocol';

import type { AttachmentKind } from './attachment-model.ts';
import {
  type AttachmentSource,
  failureText,
  fetchAttachment,
  loadTexture,
  openWithDesktop,
  saveCopyAs,
} from './attachment-store.ts';
import { attachmentName } from './attachment-view.ts';
import { albumPosition, albumStep, swipeStep } from './viewer-model.ts';

/** One picture or video of a message, as the viewer steps through them. */
export interface AlbumItem {
  source: AttachmentSource;
  kind: AttachmentKind;
}

export interface MediaViewer {
  /** Goes into a `Gtk.Overlay` over the window's content; hidden until `open`. */
  widget: Gtk.Widget;
  /** Opens `source`; `album` (which contains it) lets the person move to the others. */
  open(source: AttachmentSource, kind: AttachmentKind, album?: readonly AlbumItem[]): void;
  close(): void;
  /** Escape and F11 work wherever the focus is while the viewer shows. */
  install(window: Gtk.Window): void;
}

export function createMediaViewer(
  toast: (text: string) => void,
  onShownChanged: (shown: boolean) => void,
): MediaViewer {
  const toolbar = new Adw.ToolbarView({ visible: false, focusable: true });
  toolbar.add_css_class('background');

  const header = new Adw.HeaderBar({ showStartTitleButtons: false, showEndTitleButtons: false });
  const heading = new Adw.WindowTitle({ title: '', subtitle: '' });
  header.set_title_widget(heading);
  const back = new Gtk.Button({ iconName: 'go-previous-symbolic', tooltipText: _('Back') });
  const fullscreen = new Gtk.Button({ iconName: 'view-fullscreen-symbolic', tooltipText: _('Fullscreen') });
  const copy = new Gtk.Button({ iconName: 'edit-copy-symbolic', tooltipText: _('Copy image') });
  const save = new Gtk.Button({ iconName: 'document-save-symbolic', tooltipText: _('Save as…') });
  const openWith = new Gtk.Button({ iconName: 'document-open-symbolic', tooltipText: _('Open with…') });
  header.pack_start(back);
  header.pack_end(fullscreen);
  header.pack_end(save);
  header.pack_end(openWith);
  header.pack_end(copy);
  toolbar.add_top_bar(header);

  const stack = new Gtk.Stack();
  stack.add_named(
    new Adw.Spinner({
      halign: Gtk.Align.CENTER,
      valign: Gtk.Align.CENTER,
      widthRequest: 48,
      heightRequest: 48,
    }),
    'loading',
  );
  const picture = new Gtk.Picture({
    contentFit: Gtk.ContentFit.CONTAIN,
    canShrink: true,
    hexpand: true,
    vexpand: true,
    marginStart: 12,
    marginEnd: 12,
    marginBottom: 12,
  });
  stack.add_named(picture, 'image');
  const videoSlot = new Gtk.Box({ hexpand: true, vexpand: true });
  stack.add_named(videoSlot, 'video');
  const failed = new Adw.StatusPage({
    iconName: 'image-missing-symbolic',
    title: _('Could not load the attachment'),
  });
  const retry = new Gtk.Button({ label: _('Try Again'), halign: Gtk.Align.CENTER });
  retry.add_css_class('pill');
  failed.set_child(retry);
  stack.add_named(failed, 'error');
  // Previous and next sit over the media's edges, as in Fractal; a swipe does the same on a touch screen.
  const arrow = (iconName: string, tooltip: string, halign: Gtk.Align): Gtk.Button => {
    const button = new Gtk.Button({
      iconName,
      tooltipText: tooltip,
      halign,
      valign: Gtk.Align.CENTER,
      marginStart: 12,
      marginEnd: 12,
      visible: false,
    });
    button.add_css_class('osd');
    button.add_css_class('circular');
    button.update_property([Gtk.AccessibleProperty.LABEL], [tooltip]);
    return button;
  };
  const previous = arrow('go-previous-symbolic', _('Previous'), Gtk.Align.START);
  const next = arrow('go-next-symbolic', _('Next'), Gtk.Align.END);
  const stage = new Gtk.Overlay({ child: stack });
  stage.add_overlay(previous);
  stage.add_overlay(next);
  toolbar.set_content(stage);

  let run = 0;
  let current: { source: AttachmentSource; path: string | null; texture: Gdk.Texture | null } | null = null;
  let items: readonly AlbumItem[] = [];
  let index = 0;
  let opener: Gtk.Widget | null = null;
  let window: Gtk.Window | null = null;
  let madeFullscreen = false;

  const clearVideo = () => {
    let child = videoSlot.get_first_child();
    while (child) {
      videoSlot.remove(child);
      child = videoSlot.get_first_child();
    }
  };

  const close = () => {
    if (!toolbar.get_visible()) return;
    run++;
    toolbar.set_visible(false);
    clearVideo();
    picture.set_paintable(null);
    current = null;
    items = [];
    if (madeFullscreen && window?.is_fullscreen()) window.unfullscreen();
    madeFullscreen = false;
    onShownChanged(false);
    opener?.grab_focus();
    opener = null;
  };

  const toggleFullscreen = () => {
    if (!window) return;
    if (window.is_fullscreen()) window.unfullscreen();
    else {
      madeFullscreen = true;
      window.fullscreen();
    }
  };

  const savePart = () => {
    const shown = current;
    if (!shown?.path) return;
    saveCopyAs(window, shown.path, GLib.path_get_basename(shown.path)).catch((err: unknown) =>
      toast(fmt(_('Could not save the attachment: {error}'), { error: failureText(err) })),
    );
  };

  const openPart = () => {
    const shown = current;
    if (!shown?.path) return;
    openWithDesktop(window, shown.path, true).catch((err: unknown) =>
      toast(fmt(_('Could not open the attachment: {error}'), { error: failureText(err) })),
    );
  };

  const copyImage = () => {
    const texture = current?.texture;
    if (!texture) return;
    const value = new GObject.Value();
    value.init(Gdk.Texture.$gtype);
    value.set_object(texture);
    Gdk.Display.get_default()?.get_clipboard().set_content(Gdk.ContentProvider.new_for_value(value));
    toast(_('Image copied'));
  };

  back.connect('clicked', close);
  fullscreen.connect('clicked', toggleFullscreen);
  save.connect('clicked', savePart);
  openWith.connect('clicked', openPart);
  retry.connect('clicked', () => show());
  copy.connect('clicked', copyImage);

  // In fullscreen the bar is out of the way; a click on the media brings it back.
  const click = new Gtk.GestureClick();
  click.connect('released', () => {
    if (window?.is_fullscreen()) toolbar.set_reveal_top_bars(!toolbar.get_reveal_top_bars());
  });
  stack.add_controller(click);

  const show = () => {
    const item = items[index];
    if (!item) return;
    const { source, kind } = item;
    const mine = ++run;
    current = { source, path: null, texture: null };
    const name = attachmentName(source.info);
    heading.set_title(name);
    const position = albumPosition(index, items.length);
    heading.set_subtitle(position);
    previous.set_visible(albumStep(index, items.length, -1) !== null);
    next.set_visible(albumStep(index, items.length, 1) !== null);
    copy.set_visible(kind === 'image');
    save.set_sensitive(false);
    openWith.set_sensitive(false);
    copy.set_sensitive(false);
    clearVideo();
    picture.set_paintable(null);
    picture.update_property(
      [Gtk.AccessibleProperty.LABEL],
      [kind === 'video' ? fmt(_('Video: {name}'), { name }) : fmt(_('Image: {name}'), { name })],
    );
    stack.set_visible_child_name('loading');
    void fetchAttachment(source)
      .then(async (path) => {
        if (mine !== run || !current || toolbar.get_root() === null) return;
        current.path = path;
        save.set_sensitive(true);
        openWith.set_sensitive(true);
        if (kind === 'video') {
          const video = new Gtk.Video({ autoplay: true, hexpand: true, vexpand: true });
          video.set_filename(path);
          videoSlot.append(video);
          stack.set_visible_child_name('video');
        } else {
          const texture = await loadTexture(path);
          // `close()`, another `show()` or the window's end may have happened while the decoder worked.
          if (mine !== run || !current || toolbar.get_root() === null) return;
          current.texture = texture;
          picture.set_paintable(texture);
          copy.set_sensitive(true);
          stack.set_visible_child_name('image');
        }
        // The next picture is likely wanted next; a video is not fetched unasked.
        const after = items[index + 1];
        if (after?.kind === 'image') void fetchAttachment(after.source).catch(() => undefined);
      })
      .catch((err: unknown) => {
        if (mine !== run || toolbar.get_root() === null) return;
        failed.set_description(failureText(err));
        stack.set_visible_child_name('error');
      });
  };

  const step = (delta: number): boolean => {
    const to = albumStep(index, items.length, delta);
    if (to === null) return false;
    index = to;
    show();
    return true;
  };
  previous.connect('clicked', () => step(-1));
  next.connect('clicked', () => step(1));

  const swipe = new Gtk.GestureSwipe();
  swipe.connect('swipe', (_gesture, vx, vy) => {
    const delta = swipeStep(vx, vy);
    if (delta !== 0) step(delta);
  });
  stack.add_controller(swipe);

  return {
    widget: toolbar,
    open(source, kind, album) {
      items = album && album.length > 1 ? album : [{ source, kind }];
      const at = items.findIndex((item) => item.source.info === source.info);
      index = at < 0 ? 0 : at;
      if (at < 0) items = [{ source, kind }];
      opener = (toolbar.get_root() as Gtk.Window | null)?.get_focus() ?? null;
      toolbar.set_visible(true);
      onShownChanged(true);
      toolbar.grab_focus();
      show();
    },
    close,
    install(target) {
      window = target;
      target.connect('notify::fullscreened', () => {
        const full = target.is_fullscreen();
        fullscreen.set_icon_name(full ? 'view-restore-symbolic' : 'view-fullscreen-symbolic');
        fullscreen.set_tooltip_text(full ? _('Leave fullscreen') : _('Fullscreen'));
        toolbar.set_reveal_top_bars(true);
        if (!full) madeFullscreen = false;
      });
      const keys = new Gtk.EventControllerKey({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
      keys.connect('key-pressed', (_controller, keyval, _code, state) => {
        if (!toolbar.get_visible()) return false;
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        if (keyval === Gdk.KEY_Escape) close();
        else if (keyval === Gdk.KEY_F11) toggleFullscreen();
        else if (keyval === Gdk.KEY_Left) step(toolbar.get_direction() === Gtk.TextDirection.RTL ? 1 : -1);
        else if (keyval === Gdk.KEY_Right) step(toolbar.get_direction() === Gtk.TextDirection.RTL ? -1 : 1);
        else if (ctrl && (keyval === Gdk.KEY_s || keyval === Gdk.KEY_S)) savePart();
        else if (ctrl && (keyval === Gdk.KEY_c || keyval === Gdk.KEY_C)) copyImage();
        else return false;
        return true;
      });
      target.add_controller(keys);
    },
  };
}
