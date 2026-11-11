import GLib from 'gi://GLib?version=2.0';

/** Flatpak marks its sandbox with this file and variable. */
export function inSandbox(): boolean {
  return GLib.file_test('/.flatpak-info', GLib.FileTest.EXISTS) || GLib.getenv('FLATPAK_ID') !== null;
}
