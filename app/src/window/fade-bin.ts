/**
 * A tall child, clamped to a short height with its last stretch faded out, and a "Show more"
 * button to open it — the pattern of Tuba's FadeBin. It keeps a long message from taking the
 * whole pane without cutting its text off abruptly.
 */

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Graphene from 'gi://Graphene?version=1.0';
import Gsk from 'gi://Gsk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';

/** A child taller than this is clamped. */
const COLLAPSE_ABOVE = 400;
const COLLAPSED_HEIGHT = 300;
const FADE_HEIGHT = 125;

export const FadeBin = GObject.registerClass(
  {
    GTypeName: 'CurlewFadeBin',
    Properties: {
      collapsed: GObject.ParamSpec.boolean('collapsed', null, null, GObject.ParamFlags.READABLE, false),
      expanded: GObject.ParamSpec.boolean('expanded', null, null, GObject.ParamFlags.READWRITE, false),
    },
  },
  // An Adw.Bin, not a bare Gtk.Widget, so the child is unparented by C code: a widget dropped
  // with its row is disposed during garbage collection, where GJS refuses to run a JS
  // vfunc_dispose, and the child would leak.
  class FadeBin extends Adw.Bin {
    private isExpanded = false;
    private isCollapsed = false;

    constructor() {
      super({ overflow: Gtk.Overflow.HIDDEN });
      // Adw.Bin's BinLayout would bypass the measure and allocate vfuncs below.
      this.set_layout_manager(null);
    }

    get collapsed(): boolean {
      return this.isCollapsed;
    }

    get expanded(): boolean {
      return this.isExpanded;
    }

    set expanded(value: boolean) {
      if (value === this.isExpanded) return;
      this.isExpanded = value;
      this.notify('expanded');
      this.queue_resize();
    }

    private clamps(natural: number): boolean {
      return !this.isExpanded && natural > COLLAPSE_ABOVE;
    }

    // A Gtk.Widget defaults to CONSTANT_SIZE, so the parent would ask for the height without a
    // width: a wrapping label then answers for its widest layout, fewer lines than it gets, and the
    // allocation cuts off its top and bottom.
    vfunc_get_request_mode(): Gtk.SizeRequestMode {
      return this.child?.get_request_mode() ?? Gtk.SizeRequestMode.CONSTANT_SIZE;
    }

    vfunc_measure(orientation: Gtk.Orientation, forSize: number): [number, number, number, number] {
      const child = this.child;
      if (!child || !child.should_layout()) return [0, 0, -1, -1];
      // The clamped height is not the child's: asked for its width at 300 px, a wrapping label
      // answers with the width that fits ALL its text into 300 px and runs past the window.
      const childForSize = orientation === Gtk.Orientation.HORIZONTAL ? -1 : forSize;
      const [min, natural, minBaseline, naturalBaseline] = child.measure(orientation, childForSize);
      if (orientation === Gtk.Orientation.VERTICAL && this.clamps(natural)) {
        return [COLLAPSED_HEIGHT, COLLAPSED_HEIGHT, -1, -1];
      }
      return [min, natural, minBaseline, naturalBaseline];
    }

    vfunc_size_allocate(width: number, height: number, baseline: number): void {
      const child = this.child;
      if (!child || !child.should_layout()) return;
      const [, natural] = child.measure(Gtk.Orientation.VERTICAL, width);
      const collapsed = this.clamps(natural);
      // The child gets its full height and the widget's own overflow clips it; shrinking it would
      // re-wrap its text.
      child.allocate(width, collapsed ? natural : height, baseline, null);
      if (collapsed !== this.isCollapsed) {
        this.isCollapsed = collapsed;
        // Not from inside the allocation: the listeners show and hide a button.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          this.notify('collapsed');
          return GLib.SOURCE_REMOVE;
        });
      }
    }

    vfunc_snapshot(snapshot: Gtk.Snapshot): void {
      const child = this.child;
      if (!child) return;
      if (!this.isCollapsed) {
        this.snapshot_child(child, snapshot);
        return;
      }
      const width = this.get_width();
      const height = this.get_height();
      const bounds = new Graphene.Rect().init(0, 0, width, height);
      const opaque = new Gdk.RGBA({ red: 0, green: 0, blue: 0, alpha: 1 });
      const clear = new Gdk.RGBA({ red: 0, green: 0, blue: 0, alpha: 0 });
      const fadeFrom = Math.max(0, (height - FADE_HEIGHT) / height);
      snapshot.push_mask(Gsk.MaskMode.ALPHA);
      snapshot.append_linear_gradient(
        bounds,
        new Graphene.Point().init(0, 0),
        new Graphene.Point().init(0, height),
        [
          new Gsk.ColorStop({ offset: 0, color: opaque }),
          new Gsk.ColorStop({ offset: fadeFrom, color: opaque }),
          new Gsk.ColorStop({ offset: 1, color: clear }),
        ],
      );
      snapshot.pop();
      this.snapshot_child(child, snapshot);
      snapshot.pop();
    }
  },
);
export type FadeBin = InstanceType<typeof FadeBin>;

/**
 * `child` under a FadeBin with the "Show more" pill over its faded foot. The pill is there while
 * the child is clamped, or while `forced` says the text is cut short elsewhere; `onExpand` runs
 * first on a click, so the caller can put the full content in before the clamp is lifted.
 */
export function fadedOverlay(child: Gtk.Widget, forced: boolean, onExpand: () => void): Gtk.Overlay {
  const bin = new FadeBin();
  bin.child = child;
  const more = new Gtk.Button({
    label: _('Show more'),
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.END,
    marginBottom: 6,
    visible: forced,
  });
  more.add_css_class('pill');
  more.add_css_class('opaque');
  const sync = () => more.set_visible(!bin.expanded && (forced || bin.collapsed));
  bin.connect('notify::collapsed', sync);
  more.connect('clicked', () => {
    onExpand();
    bin.expanded = true;
    more.set_visible(false);
  });
  const overlay = new Gtk.Overlay({ child: bin });
  overlay.add_overlay(more);
  return overlay;
}
