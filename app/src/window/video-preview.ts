/**
 * Silent video previews in a chat (docs/design/media-grid.md, piece 3): a lone video whose file is
 * already in the cache plays muted and looped while it is mostly on screen. One host per
 * conversation view picks the single preview that runs; the choice itself is `pickPlaying`.
 */

import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { configPath } from '@curlew/store';

import { loadConfig } from '../core/config.ts';
import { pickPlaying, silentVideosOn, type VideoCandidate } from './video-preview-model.ts';

export interface SilentVideo {
  /** The widget whose place on screen decides whether the preview runs. */
  widget: Gtk.Widget;
  start(): void;
  stop(): void;
}

export interface SilentVideoHost {
  register(video: SilentVideo): void;
}

/** What the config and the system allow; read again after the Preferences switch changes. */
let enabled = true;
const listeners = new Set<() => void>();

export function refreshSilentVideos(): void {
  let setting: boolean | undefined;
  try {
    setting = loadConfig(configPath()).ui.playVideosSilently;
  } catch {
    // A config that does not load changes nothing here; the window reports it elsewhere.
  }
  const animations = Gtk.Settings.get_default()?.gtk_enable_animations ?? true;
  enabled = silentVideosOn(setting, animations);
  for (const listener of listeners) listener();
}

const EVALUATE_DELAY_MS = 120;

/** Starts the one preview that should run and stops the rest, whenever the view moves. */
export function createSilentVideoHost(scroller: Gtk.ScrolledWindow): SilentVideoHost {
  refreshSilentVideos();
  const videos: SilentVideo[] = [];
  let playing: SilentVideo | null = null;
  let scheduled = false;

  const stopPlaying = () => {
    playing?.stop();
    playing = null;
  };

  const measure = (video: SilentVideo, id: number): VideoCandidate | null => {
    const widget = video.widget;
    if (!widget.get_mapped() || widget.get_height() <= 0) return null;
    const [ok, rect] = widget.compute_bounds(scroller);
    if (!ok) return null;
    const page = scroller.get_height();
    const top = Math.max(rect.get_y(), 0);
    const bottom = Math.min(rect.get_y() + rect.get_height(), page);
    const visible = Math.max(0, bottom - top) / rect.get_height();
    const centre = rect.get_y() + rect.get_height() / 2;
    return { id, visible, distance: Math.abs(centre - page / 2) };
  };

  const evaluate = () => {
    scheduled = false;
    // A bubble that left the window takes its preview with it.
    for (let i = videos.length - 1; i >= 0; i--) {
      if (videos[i]!.widget.get_root() === null) {
        if (videos[i] === playing) playing = null;
        videos.splice(i, 1);
      }
    }
    const window = scroller.get_root() as Gtk.Window | null;
    const focused = window !== null && window.isActive;
    if (!enabled || !focused) {
      stopPlaying();
      return GLib.SOURCE_REMOVE;
    }
    const candidates: VideoCandidate[] = [];
    videos.forEach((video, id) => {
      const measured = measure(video, id);
      if (measured) candidates.push(measured);
    });
    const next = pickPlaying(candidates, playing === null ? null : videos.indexOf(playing));
    const chosen = next === null ? null : (videos[next] ?? null);
    if (chosen !== playing) {
      stopPlaying();
      playing = chosen;
      playing?.start();
    }
    return GLib.SOURCE_REMOVE;
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, EVALUATE_DELAY_MS, evaluate);
  };

  scroller.get_vadjustment().connect('value-changed', schedule);
  listeners.add(schedule);
  scroller.connect('destroy', () => {
    listeners.delete(schedule);
    stopPlaying();
  });
  // The window's focus is known only once the scroller is in one.
  scroller.connect('notify::root', () => {
    const window = scroller.get_root() as Gtk.Window | null;
    window?.connect('notify::is-active', schedule);
  });
  scroller.connect('unmap', () => stopPlaying());
  scroller.connect('map', schedule);

  return {
    register(video) {
      videos.push(video);
      schedule();
    },
  };
}
