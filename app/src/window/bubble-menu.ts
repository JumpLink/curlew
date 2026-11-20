import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import type { BubbleMenuEntry } from './bubble-menu-model.ts';

/** Vertical buttons (icon above a short label) in a FlowBox that wraps on a narrow screen. */
export function bubbleActionRow(
  entries: readonly (BubbleMenuEntry & { label: string; run: () => void })[],
): Gtk.FlowBox {
  const actions = new Gtk.FlowBox({
    selectionMode: Gtk.SelectionMode.NONE,
    activateOnSingleClick: false,
    homogeneous: true,
    minChildrenPerLine: 1,
    maxChildrenPerLine: 4,
    halign: Gtk.Align.CENTER,
  });
  for (const entry of entries) {
    const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
    content.append(new Gtk.Image({ iconName: entry.icon }));
    content.append(new Gtk.Label({ label: entry.label, ellipsize: Pango.EllipsizeMode.END }));
    const button = new Gtk.Button({ child: content });
    button.add_css_class('flat');
    if (entry.destructive) button.add_css_class('error');
    button.update_property([Gtk.AccessibleProperty.LABEL], [entry.label]);
    button.connect('clicked', entry.run);
    actions.append(button);
    actions.get_last_child()?.set_focusable(false);
  }
  return actions;
}
