/** The quiet pattern behind a conversation's messages (ADR 0013). */

import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Graphene from 'gi://Graphene?version=1.0';
import Gtk from 'gi://Gtk?version=4.0';

import { backgroundToShow } from '../core/lib/appearance.ts';
import { DOODLE_TILE, doodleTileSvg } from './chat-doodles.ts';

const OPACITY = 0.07;

const live = new Set<InstanceType<typeof ChatBackground>>();
let shown = backgroundToShow(undefined);

/** Apply `value` (the `ui.chatBackground` setting) to every open conversation and the next ones. */
export function applyChatBackground(value: string | undefined): void {
  shown = backgroundToShow(value);
  for (const background of live) background.queue_draw();
}

/** A widget that only paints, and lets every click through to the messages above it. */
export const ChatBackground = GObject.registerClass(
  { GTypeName: 'CurlewChatBackground' },
  class ChatBackground extends Gtk.Widget {
    private texture: Gdk.Texture | null = null;
    private textureColor = '';

    constructor() {
      super({ canTarget: false, canFocus: false, hexpand: true, vexpand: true });
      this.connect('realize', () => live.add(this));
      this.connect('unrealize', () => live.delete(this));
    }

    // The foreground is light on a dark window and dark on a light one, so the pattern follows
    // the scheme without being told which it is.
    vfunc_css_changed(change: Gtk.CssStyleChange): void {
      super.vfunc_css_changed(change);
      this.queue_draw();
    }

    private tile(color: Gdk.RGBA): Gdk.Texture | null {
      const css = `rgb(${Math.round(color.red * 255)},${Math.round(color.green * 255)},${Math.round(color.blue * 255)})`;
      if (this.texture && css === this.textureColor) return this.texture;
      try {
        const bytes = new TextEncoder().encode(doodleTileSvg(css));
        this.texture = Gdk.Texture.new_from_bytes(GLib.Bytes.new(bytes));
        this.textureColor = css;
      } catch {
        // No SVG loader on this system: the conversation simply has a plain background.
        this.texture = null;
      }
      return this.texture;
    }

    vfunc_snapshot(snapshot: Gtk.Snapshot): void {
      const width = this.get_width();
      const height = this.get_height();
      if (shown === 'none' || width <= 0 || height <= 0) return;
      const texture = this.tile(this.get_color());
      if (!texture) return;
      const tile = new Graphene.Rect().init(0, 0, DOODLE_TILE, DOODLE_TILE);
      snapshot.push_opacity(OPACITY);
      snapshot.push_repeat(new Graphene.Rect().init(0, 0, width, height), tile);
      snapshot.append_texture(texture, tile);
      snapshot.pop();
      snapshot.pop();
    }
  },
);
