/**
 * Calls `onChange` when the config file may have changed.
 *
 * The DIRECTORY is monitored, not the file: `saveConfig` writes `config.json.part` and renames it,
 * and a monitor on the file itself would follow the replaced inode into nothing. Events are
 * filtered to `config.json` and debounced, because an atomic write reports several. When the
 * directory does not exist yet a poll attaches the monitor as soon as it does.
 */

import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

const DEBOUNCE_MS = 150;
const ATTACH_POLL_MS = 2_000;

export function watchConfig(path: string, onChange: () => void): () => void {
  const dir = GLib.path_get_dirname(path);
  const name = GLib.path_get_basename(path);
  let monitor: Gio.FileMonitor | null = null;
  let pending = 0;

  const soon = () => {
    if (pending) return;
    pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
      pending = 0;
      onChange();
      return GLib.SOURCE_REMOVE;
    });
  };

  const attach = () => {
    if (monitor || !GLib.file_test(dir, GLib.FileTest.IS_DIR)) return;
    try {
      monitor = Gio.File.new_for_path(dir).monitor_directory(Gio.FileMonitorFlags.NONE, null);
      monitor.connect('changed', (_m, file, other) => {
        const touched = [file, other].some((f) => f?.get_basename() === name);
        if (touched) soon();
      });
      // The file may have appeared between the last read and the attach.
      soon();
    } catch {
      monitor = null;
    }
  };

  attach();
  let tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ATTACH_POLL_MS, () => {
    attach();
    if (!monitor) return GLib.SOURCE_CONTINUE;
    // The source ends itself here; the cleanup must not remove an id GLib no longer knows.
    tick = 0;
    return GLib.SOURCE_REMOVE;
  });

  return () => {
    if (tick) GLib.source_remove(tick);
    if (pending) GLib.source_remove(pending);
    monitor?.cancel();
  };
}
