import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import { selectableFor } from './bubble-menu-model.ts';

const guarded = new WeakSet<Gtk.Label>();

/** Marks a body label as selectable by pointer only; `guardTouchSelection` flips it per press. */
export function selectableForPointerOnly(label: Gtk.Label): void {
  guarded.add(label);
}

function setSelectable(widget: Gtk.Widget, want: boolean): void {
  if (widget instanceof Gtk.Label && guarded.has(widget) && widget.get_selectable() !== want) {
    widget.set_selectable(want);
  }
  for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
    setSelectable(child, want);
  }
}

/**
 * A touch drag over a selectable label starts a selection instead of scrolling. A capture-phase press on
 * the bubble runs before any label sees the press: it reads the device and turns selection off for a
 * touchscreen, on for mouse and touchpad. Copy stays in the long-press menu.
 */
export function guardTouchSelection(card: Gtk.Widget): void {
  const click = new Gtk.GestureClick({ button: 0, propagationPhase: Gtk.PropagationPhase.CAPTURE });
  click.connect('pressed', () => {
    const touch = click.get_current_event_device()?.get_source() === Gdk.InputSource.TOUCHSCREEN;
    setSelectable(card, selectableFor(touch));
  });
  // No reset on `stopped`: it fires once a touch drag passes the click threshold, i.e. mid-scroll,
  // and would hand the drag back to the label. The next press decides again for its own device.
  card.add_controller(click);
}
