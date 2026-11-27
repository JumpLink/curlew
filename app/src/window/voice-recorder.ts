/** The voice-message recording of the composer and its bar: timer, level, cancel and finish. */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';
import { ensurePrivateDir, previewsDir } from '@curlew/store';

import type { PickedFile } from './composer-files-model.ts';
import type { MicBusy } from './microphone-model.ts';
import { startVoicePipeline, type VoicePipeline } from './voice-pipeline.ts';
import {
  judgeRecording,
  levelFraction,
  MAX_VOICE_MS,
  recordingKeyAction,
  recordingLabel,
  voiceNoteName,
} from './voice-recorder-model.ts';

export interface VoiceRecorderOptions {
  toast(text: string): void;
  /** A finished recording, ready to be a chip in the composer. */
  onRecorded(file: PickedFile): void;
  /** What the shared microphone control shows: the stop control while recording, null when idle. */
  onLook(look: MicBusy): void;
  /** Offered or not changed. */
  onOfferChange(): void;
}

export interface VoiceRecorder {
  /** The microphone was pressed: starts a recording, and finishes it while one runs. */
  press(): void;
  /** A recording runs. */
  busy(): boolean;
  /** The protocol takes voice notes here. */
  offered(): boolean;
  /** Timer, level, cancel and finish; visible only while recording. */
  bar: Gtk.Widget;
  /** Offered or not; turning it off while recording throws the recording away. */
  setAvailable(on: boolean): void;
}

interface Running {
  pipeline: VoicePipeline;
  path: string;
  startedAt: number;
}

export function createVoiceRecorder(options: VoiceRecorderOptions): VoiceRecorder {
  const cancel = new Gtk.Button({
    iconName: 'user-trash-symbolic',
    tooltipText: _('Discard the recording'),
    valign: Gtk.Align.CENTER,
  });
  cancel.add_css_class('flat');
  cancel.add_css_class('circular');
  cancel.update_property([Gtk.AccessibleProperty.LABEL], [_('Discard the recording')]);
  const level = new Gtk.LevelBar({
    minValue: 0,
    maxValue: 1,
    value: 0,
    hexpand: true,
    valign: Gtk.Align.CENTER,
  });
  level.update_property([Gtk.AccessibleProperty.LABEL], [_('Microphone level')]);
  const timer = new Gtk.Label({ label: recordingLabel(0), xalign: 1 });
  timer.add_css_class('numeric');
  timer.add_css_class('heading');
  const finish = new Gtk.Button({
    iconName: 'media-playback-stop-symbolic',
    tooltipText: _('Stop and keep the recording'),
    valign: Gtk.Align.CENTER,
  });
  finish.add_css_class('suggested-action');
  finish.add_css_class('circular');
  finish.update_property([Gtk.AccessibleProperty.LABEL], [_('Stop and keep the recording')]);

  const bar = new Gtk.Box({
    spacing: 6,
    marginStart: 8,
    marginEnd: 8,
    marginTop: 4,
    marginBottom: 4,
    visible: false,
  });
  for (const part of [cancel, level, timer, finish]) bar.append(part);

  let running: Running | null = null;
  let tick = 0;

  const idle = (): void => {
    if (tick) GLib.source_remove(tick);
    tick = 0;
    running = null;
    bar.set_visible(false);
    level.set_value(0);
    timer.set_label(recordingLabel(0));
    options.onLook(null);
  };

  const elapsed = (run: Running): number => (GLib.get_monotonic_time() - run.startedAt) / 1000;

  const discard = (run: Running): void => {
    run.pipeline.abort();
    rmSync(run.path, { force: true });
  };

  const stop = (keep: boolean): void => {
    const run = running;
    if (!run) return;
    idle();
    if (!keep) {
      discard(run);
      return;
    }
    void run.pipeline.stop().then((ms) => {
      const verdict = judgeRecording(ms);
      if (!verdict.keep) {
        rmSync(run.path, { force: true });
        options.toast(_('The recording was too short'));
        return;
      }
      const size = Gio.File.new_for_path(run.path).query_info('standard::size', 0, null).get_size();
      options.onRecorded({
        path: run.path,
        name: run.path.split('/').pop() ?? 'voice.ogg',
        size,
        temporary: true,
        voiceMs: verdict.durationMs,
      });
    });
  };

  const start = (): void => {
    const dir = join(previewsDir(), 'voice');
    ensurePrivateDir(dir);
    const path = join(dir, voiceNoteName(new Date()));
    let pipeline: VoicePipeline | null = null;
    try {
      pipeline = startVoicePipeline({
        path,
        onLevel: (db) => level.set_value(levelFraction(db)),
        onError: () => {
          if (running?.path !== path) return;
          const run = running;
          idle();
          discard(run);
          options.toast(_('No microphone could be opened'));
        },
      });
    } catch {
      pipeline = null;
    }
    if (!pipeline) {
      options.toast(_('No microphone could be opened'));
      return;
    }
    running = { pipeline, path, startedAt: GLib.get_monotonic_time() };
    bar.set_visible(true);
    options.onLook({
      icon: 'media-playback-stop-symbolic',
      label: _('Stop and keep the recording'),
      suggested: true,
    });
    finish.grab_focus();
    tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
      if (!running) return GLib.SOURCE_REMOVE;
      const ms = elapsed(running);
      timer.set_label(recordingLabel(ms));
      if (ms >= MAX_VOICE_MS) {
        tick = 0;
        stop(true);
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    });
  };

  cancel.connect('clicked', () => stop(false));
  finish.connect('clicked', () => stop(true));

  // Escape throws the note away from anywhere in the bar; Enter and Space already press the focused button.
  const keys = new Gtk.EventControllerKey();
  keys.connect('key-pressed', (_c, keyval) => {
    const action = recordingKeyAction(keyval === Gdk.KEY_Escape ? 'Escape' : '');
    if (action !== 'cancel') return false;
    stop(false);
    return true;
  });
  bar.add_controller(keys);

  let offered = false;
  return {
    press: () => (running ? stop(true) : start()),
    busy: () => running !== null,
    offered: () => offered,
    bar,
    setAvailable(on) {
      if (!on) stop(false);
      if (on === offered) return;
      offered = on;
      options.onOfferChange();
    },
  };
}
