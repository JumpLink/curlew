/**
 * The placeholder rows the conversation list shows while it is reading the index for the first
 * time (#541).
 *
 * Before this, the list showed its empty state until the first read came back -- "No conversations
 * yet" on a window that has thousands of them, which on a cold page cache lasted long enough to
 * read. Rows shaped like the real ones say the same thing honestly: something is coming, and it
 * will look like this.
 *
 * It is a placeholder, not content: nothing here is focusable, clickable or in the accessibility
 * tree, so Tab goes straight past it and a screen reader is told the list is busy instead of being
 * read eight rows of nothing.
 */

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

/** Placeholder rows: a few more than one screen at 360 px, so no gap shows under them. */
const ROWS = 9;

/**
 * Paint only -- a tint and a radius, both from libadwaita's own named colours, so the bars follow
 * the light and dark palettes and every accent without a second rule. The layout is widgets, as
 * everywhere else in the window; CSS here draws, it does not arrange.
 */
const SKELETON_CSS = `
.curlew-skeleton {
  background-color: alpha(@window_fg_color, 0.1);
  border-radius: 6px;
}
.curlew-skeleton.curlew-pulsing {
  animation: curlew-skeleton-pulse 1.8s ease-in-out infinite;
}
@keyframes curlew-skeleton-pulse {
  from { opacity: 1; }
  50% { opacity: 0.45; }
  to { opacity: 1; }
}
`;

let installed = false;

function installCss(): void {
  if (installed) return;
  const display = Gdk.Display.get_default();
  if (!display) return;
  const provider = new Gtk.CssProvider();
  provider.load_from_string(SKELETON_CSS);
  Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  installed = true;
}

/**
 * One bar standing in for a line of text, `1 / (spacers + 1)` of the width.
 *
 * The share comes from how many empty boxes expand beside it, not from a width request: a width
 * request would raise the sidebar's minimum width, and a placeholder may not decide how narrow
 * the window can get.
 */
function bar(height: number, spacers: number, pulsing: boolean): Gtk.Widget {
  const line = new Gtk.Box({ valign: Gtk.Align.CENTER });
  const fill = new Gtk.Box({ hexpand: true, heightRequest: height, valign: Gtk.Align.CENTER });
  fill.add_css_class('curlew-skeleton');
  if (pulsing) fill.add_css_class('curlew-pulsing');
  line.append(fill);
  for (let i = 0; i < spacers; i++) line.append(new Gtk.Box({ hexpand: true }));
  return line;
}

/**
 * The placeholder page for the list's stack: rows in the shape of {@link entryRow}'s, an avatar
 * and two lines of text.
 *
 * The pulse follows the person's animation setting, so "reduce animations" gets still bars rather
 * than a breathing sidebar.
 */
export function createSkeletonRows(): Gtk.Widget {
  installCss();
  const pulsing = Gtk.Settings.get_default()?.gtkEnableAnimations ?? true;
  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE, canFocus: false });
  list.add_css_class('navigation-sidebar');
  for (let i = 0; i < ROWS; i++) {
    const box = new Gtk.Box({ spacing: 12 });
    const avatar = new Adw.Avatar({ size: 40, marginEnd: 6, marginBottom: 6 });
    avatar.add_css_class('curlew-skeleton');
    if (pulsing) avatar.add_css_class('curlew-pulsing');
    box.append(avatar);
    const lines = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 8,
      hexpand: true,
      valign: Gtk.Align.CENTER,
    });
    // Two shares, alternating, so the rows read as a list of different names and not as a pattern.
    lines.append(bar(14, i % 2 === 0 ? 1 : 2, pulsing));
    lines.append(bar(10, i % 2 === 0 ? 2 : 1, pulsing));
    box.append(lines);
    const row = new Gtk.ListBoxRow({ selectable: false, activatable: false, canFocus: false, child: box });
    list.append(row);
  }
  // A scroller, like the real list, because nine rows of fixed height would otherwise make the
  // window's minimum height their own.
  const page = new Gtk.ScrolledWindow({
    hscrollbarPolicy: Gtk.PolicyType.NEVER,
    vscrollbarPolicy: Gtk.PolicyType.EXTERNAL,
    vexpand: true,
    canFocus: false,
    // Nothing to aim at: the pointer and the keyboard pass through to whatever comes next.
    canTarget: false,
    child: list,
  });
  // Out of the accessibility tree entirely. What is happening is said once, by the stack these
  // rows sit in: `busy` there, not nine unlabelled rows here.
  page.update_state([Gtk.AccessibleState.HIDDEN], [true]);
  return page;
}
