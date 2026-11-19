import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import { selectableFor } from './bubble-menu-model.ts';

/**
 * A touch drag over a selectable label starts a selection instead of scrolling. The label stays
 * selectable for mouse and touchpad, and turns unselectable while a touch is on it; Copy lives in
 * the long-press menu.
 */
export function selectableForPointerOnly(label: Gtk.Label): void {
  const sync = (controller: Gtk.EventController): void => {
    const touch = controller.get_current_event_device()?.get_source() === Gdk.InputSource.TOUCHSCREEN;
    const want = selectableFor(touch);
    if (label.get_selectable() !== want) label.set_selectable(want);
  };
  const click = new Gtk.GestureClick({ button: 0, propagationPhase: Gtk.PropagationPhase.CAPTURE });
  click.connect('pressed', () => sync(click));
  const motion = new Gtk.EventControllerMotion({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
  motion.connect('enter', () => sync(motion));
  motion.connect('motion', () => sync(motion));
  label.add_controller(click);
  label.add_controller(motion);
}
