/**
 * Calls `onChange` when a watched file may have changed.
 *
 * The DIRECTORY is monitored, not the file: `saveConfig` writes `config.json.part` and renames it,
 * and a monitor on the file itself would follow the replaced inode into nothing. Events are
 * filtered to the watched names and debounced, because an atomic write reports several. When the
 * directory does not exist yet a poll attaches the monitor as soon as it does.
 */

import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

const DEBOUNCE_MS = 150;
const ATTACH_POLL_MS = 2_000;

/**
 * Watch `names` inside `dir`. `debounceMs` is the quiet time after the FIRST event, not after the
 * last: a daemon writing thousands of rows keeps the directory busy, and a trailing debounce would
 * hold the callback back until it stops. This fires at most once per `debounceMs`.
 */
export function watchFiles(
  dir: string,
  names: readonly string[],
  onChange: () => void,
  debounceMs = DEBOUNCE_MS,
): () => void {
  let monitor: Gio.FileMonitor | null = null;
  let pending = 0;

  const soon = () => {
    if (pending) return;
    pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, debounceMs, () => {
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
        const touched = [file, other].some((f) => {
          const base = f?.get_basename();
          return base !== null && base !== undefined && names.includes(base);
        });
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

export function watchConfig(path: string, onChange: () => void): () => void {
  return watchFiles(GLib.path_get_dirname(path), [GLib.path_get_basename(path)], onChange);
}
