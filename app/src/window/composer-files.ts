/**
 * The files of a message being written: a paperclip button, a strip of removable chips above the
 * entry, and the two other ways a file arrives — dropped on the pane and pasted (a copied picture
 * or a file copied in the file manager).
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';
import { _, fmt } from '@curlew/protocol';
import { ensurePrivateDir, previewsDir } from '@curlew/store';

import { MAX_PICKED_FILES, mergePicked, pastedImageName, type PickedFile } from './composer-files-model.ts';

export interface ComposerFilesOptions {
  /** The window the file dialog belongs to. */
  parent(): Gtk.Window | null;
  toast(text: string): void;
  /** The list of files changed: the send button may now be allowed or not. */
  onChange(): void;
  /** Files may be dropped here. */
  dropOn: Gtk.Widget;
  /** Pasting into this entry may bring a file or a picture. */
  pasteInto: Gtk.Widget;
}

export interface ComposerFiles {
  /** The paperclip. */
  button: Gtk.Button;
  /** The chips; hidden while the list is empty. */
  strip: Gtk.Widget;
  files(): PickedFile[];
  /** Empties the list; the pasted pictures it made are deleted. */
  clear(): void;
  /**
   * False for a carrier that cannot attach: the paperclip goes and so does everything picked.
   * Returns how many files that dropped, so the caller can say so.
   */
  setAttachable(on: boolean): number;
}

const dismissed = (err: unknown): boolean =>
  err instanceof GLib.Error && err.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED);

function chip(file: PickedFile, remove: () => void): Gtk.Widget {
  const box = new Gtk.Box({ spacing: 6, marginStart: 8, marginTop: 4, marginBottom: 4 });
  box.add_css_class('card');
  const type = Gio.content_type_guess(file.name, null)[0] ?? 'application/octet-stream';
  box.append(new Gtk.Image({ gicon: Gio.content_type_get_icon(type), pixelSize: 16 }));
  const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER });
  text.append(
    new Gtk.Label({
      label: file.name,
      xalign: 0,
      ellipsize: Pango.EllipsizeMode.MIDDLE,
      widthChars: 16,
      maxWidthChars: 22,
    }),
  );
  const size = new Gtk.Label({ label: GLib.format_size(file.size), xalign: 0 });
  size.add_css_class('caption');
  size.add_css_class('dim-label');
  text.append(size);
  box.append(text);
  const close = new Gtk.Button({
    iconName: 'window-close-symbolic',
    tooltipText: fmt(_('Remove {file}'), { file: file.name }),
    valign: Gtk.Align.CENTER,
  });
  close.add_css_class('flat');
  close.add_css_class('circular');
  close.connect('clicked', remove);
  box.append(close);
  return box;
}

export function createComposerFiles(options: ComposerFilesOptions): ComposerFiles {
  let picked: PickedFile[] = [];
  let attachable = false;

  const button = new Gtk.Button({
    iconName: 'mail-attachment-symbolic',
    tooltipText: _('Attach a file'),
    visible: false,
  });
  button.add_css_class('circular');
  button.add_css_class('flat');

  const row = new Gtk.Box({ spacing: 6, marginEnd: 12 });
  const scroller = new Gtk.ScrolledWindow({
    hscrollbarPolicy: Gtk.PolicyType.AUTOMATIC,
    vscrollbarPolicy: Gtk.PolicyType.NEVER,
    visible: false,
    child: row,
  });

  const discard = (file: PickedFile) => {
    if (file.temporary) rmSync(file.path, { force: true });
  };

  const render = () => {
    let child = row.get_first_child();
    while (child) {
      const next = child.get_next_sibling();
      row.remove(child);
      child = next;
    }
    for (const file of picked) {
      row.append(
        chip(file, () => {
          picked = picked.filter((f) => f !== file);
          discard(file);
          render();
          options.onChange();
        }),
      );
    }
    scroller.set_visible(picked.length > 0);
  };

  const add = (incoming: PickedFile[]) => {
    if (!attachable || incoming.length === 0) return;
    const { files, skipped } = mergePicked(picked, incoming);
    picked = files;
    render();
    options.onChange();
    if (skipped > 0) {
      options.toast(fmt(_('At most {max} files per message'), { max: MAX_PICKED_FILES }));
    }
  };

  // A path and its size from a Gio.File; a folder or a file with no local path is told to the person.
  const describe = (file: Gio.File): PickedFile | null => {
    const path = file.get_path();
    const name = file.get_basename() ?? '';
    try {
      const info = file.query_info('standard::type,standard::size', Gio.FileQueryInfoFlags.NONE, null);
      if (path === null || info.get_file_type() !== Gio.FileType.REGULAR) throw new Error('not a file');
      return { path, name, size: info.get_size(), temporary: false };
    } catch {
      options.toast(fmt(_('{file} is not a file that can be attached'), { file: name }));
      return null;
    }
  };

  const addFiles = (files: Gio.File[]) => add(files.map(describe).filter((f): f is PickedFile => f !== null));

  button.connect('clicked', () => {
    const dialog = new Gtk.FileDialog({ title: _('Attach files') });
    dialog.open_multiple(options.parent(), null, (_source, result) => {
      try {
        const model = dialog.open_multiple_finish(result);
        const files: Gio.File[] = [];
        for (let i = 0; i < (model?.get_n_items() ?? 0); i++) files.push(model!.get_item(i) as Gio.File);
        addFiles(files);
      } catch (err) {
        if (!dismissed(err)) options.toast(err instanceof Error ? err.message : String(err));
      }
    });
  });

  const drop = new Gtk.DropTarget({ actions: Gdk.DragAction.COPY });
  drop.set_gtypes([Gdk.FileList.$gtype]);
  drop.connect('drop', (_target, value: GObject.Value | Gdk.FileList) => {
    if (!attachable) return false;
    addFiles((value as Gdk.FileList).get_files());
    return true;
  });
  options.dropOn.add_controller(drop);

  const savePasted = (texture: Gdk.Texture) => {
    const dir = join(previewsDir(), 'pasted');
    ensurePrivateDir(dir);
    const name = pastedImageName(new Date());
    const path = join(dir, name);
    if (!texture.save_to_png(path)) throw new Error(_('The picture could not be saved'));
    return { path, name, size: Gio.File.new_for_path(path).query_info('standard::size', 0, null).get_size() };
  };

  // Ctrl+V: a copied file or picture becomes an attachment; text stays the entry's own business.
  const keys = new Gtk.EventControllerKey({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
  keys.connect('key-pressed', (_c, keyval, _code, state) => {
    if (!attachable || keyval !== Gdk.KEY_v || !(state & Gdk.ModifierType.CONTROL_MASK)) return false;
    const clipboard = options.pasteInto.get_clipboard();
    const formats = clipboard.get_formats();
    if (formats.contain_gtype(Gdk.FileList.$gtype)) {
      clipboard.read_value_async(Gdk.FileList.$gtype, GLib.PRIORITY_DEFAULT, null, (_s, res) => {
        try {
          const list = clipboard.read_value_finish(res) as Gdk.FileList;
          addFiles(list.get_files());
        } catch (err) {
          options.toast(err instanceof Error ? err.message : String(err));
        }
      });
      return true;
    }
    if (formats.contain_gtype(Gdk.Texture.$gtype) && !formats.contain_gtype(GObject.TYPE_STRING)) {
      clipboard.read_texture_async(null, (_s, res) => {
        try {
          const texture = clipboard.read_texture_finish(res);
          if (texture) add([{ ...savePasted(texture), temporary: true }]);
        } catch (err) {
          options.toast(err instanceof Error ? err.message : String(err));
        }
      });
      return true;
    }
    return false;
  });
  options.pasteInto.add_controller(keys);

  return {
    button,
    strip: scroller,
    files: () => [...picked],
    clear() {
      for (const file of picked) discard(file);
      picked = [];
      render();
    },
    setAttachable(on) {
      attachable = on;
      button.set_visible(on);
      const dropped = on ? 0 : picked.length;
      if (dropped > 0) {
        for (const file of picked) discard(file);
        picked = [];
        render();
        options.onChange();
      }
      return dropped;
    },
  };
}
