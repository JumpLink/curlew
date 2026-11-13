/** The record button of the composer: GStreamer to an Ogg/Opus file in the private cache, then a chip. */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gst from 'gi://Gst?version=1.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';
import { ensurePrivateDir, previewsDir } from '@curlew/store';

import type { PickedFile } from './composer-files-model.ts';
import { judgeRecording, MAX_VOICE_MS, recordingLabel, voiceNoteName } from './voice-recorder-model.ts';

export interface VoiceRecorderOptions {
  toast(text: string): void;
  /** A finished recording, ready to be a chip in the composer. */
  onRecorded(file: PickedFile): void;
}

export interface VoiceRecorder {
  button: Gtk.Button;
  /** Offered or not; turning it off while recording throws the recording away. */
  setAvailable(on: boolean): void;
}

interface Running {
  pipeline: Gst.Pipeline;
  path: string;
  startedAt: number;
}

/** Microphone sources in order of preference; each is tried until one starts. */
const SOURCES = ['pulsesrc', 'pipewiresrc'];

function begin(path: string): Running | null {
  Gst.init([]);
  for (const name of SOURCES) {
    const chain = [
      Gst.ElementFactory.make(name, null),
      Gst.ElementFactory.make('audioconvert', null),
      Gst.ElementFactory.make('audioresample', null),
      Gst.ElementFactory.make('capsfilter', null),
      Gst.ElementFactory.make('opusenc', null),
      Gst.ElementFactory.make('oggmux', null),
      Gst.ElementFactory.make('filesink', null),
    ];
    if (chain.some((element) => element === null)) continue;
    const elements = chain as Gst.Element[];
    elements[3]!.set_property('caps', Gst.Caps.from_string('audio/x-raw,rate=48000,channels=1'));
    elements[4]!.set_property('bitrate', 32000);
    elements[6]!.set_property('location', path);
    const pipeline = new Gst.Pipeline();
    for (const element of elements) pipeline.add(element);
    let linked = true;
    for (let i = 0; i < elements.length - 1; i++) linked = elements[i]!.link(elements[i + 1]!) && linked;
    if (linked && pipeline.set_state(Gst.State.PLAYING) !== Gst.StateChangeReturn.FAILURE) {
      return { pipeline, path, startedAt: GLib.get_monotonic_time() };
    }
    pipeline.set_state(Gst.State.NULL);
  }
  return null;
}

/** Ends the file cleanly (EOS lets the muxer write its last page); returns the length in ms. */
function finish(run: Running): number {
  const ms = (GLib.get_monotonic_time() - run.startedAt) / 1000;
  run.pipeline.send_event(Gst.Event.new_eos());
  run.pipeline.get_bus()?.timed_pop_filtered(Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR);
  run.pipeline.set_state(Gst.State.NULL);
  return ms;
}

export function createVoiceRecorder(options: VoiceRecorderOptions): VoiceRecorder {
  const content = new Adw.ButtonContent({ iconName: 'audio-input-microphone-symbolic' });
  const button = new Gtk.Button({ child: content, tooltipText: _('Record a voice message'), visible: false });
  button.add_css_class('flat');
  button.add_css_class('circular');
  button.update_property([Gtk.AccessibleProperty.LABEL], [_('Record a voice message')]);

  let running: Running | null = null;
  let tick = 0;

  const idle = (): void => {
    if (tick) GLib.source_remove(tick);
    tick = 0;
    running = null;
    content.set_icon_name('audio-input-microphone-symbolic');
    content.set_label('');
    button.remove_css_class('destructive-action');
    button.add_css_class('flat');
    button.set_tooltip_text(_('Record a voice message'));
  };

  const stop = (keep: boolean): void => {
    const run = running;
    if (!run) return;
    const ms = finish(run);
    idle();
    const verdict = judgeRecording(ms);
    if (!keep || !verdict.keep) {
      rmSync(run.path, { force: true });
      if (keep) options.toast(_('The recording was too short'));
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
  };

  button.connect('clicked', () => {
    if (running) {
      stop(true);
      return;
    }
    const dir = join(previewsDir(), 'voice');
    ensurePrivateDir(dir);
    const path = join(dir, voiceNoteName(new Date()));
    let started: Running | null = null;
    try {
      started = begin(path);
    } catch {
      started = null;
    }
    if (!started) {
      options.toast(_('No microphone could be opened'));
      return;
    }
    running = started;
    content.set_icon_name('media-playback-stop-symbolic');
    content.set_label(recordingLabel(0));
    button.remove_css_class('flat');
    button.add_css_class('destructive-action');
    button.set_tooltip_text(_('Stop and keep the recording'));
    tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
      if (!running) return GLib.SOURCE_REMOVE;
      const ms = (GLib.get_monotonic_time() - running.startedAt) / 1000;
      content.set_label(recordingLabel(ms));
      if (ms >= MAX_VOICE_MS) {
        tick = 0;
        stop(true);
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    });
  });

  return {
    button,
    setAvailable(on) {
      if (!on) stop(false);
      button.set_visible(on);
    },
  };
}
