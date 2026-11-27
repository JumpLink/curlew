/** The dictation button of the composer: record with the voice-note pipeline, transcribe locally, put the text into the entry. */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';
import { ensurePrivateDir, previewsDir } from '@curlew/store';

import {
  createJob,
  dictationKeyAction,
  dictationPress,
  failureMessage,
  type DictationPhase,
  type Job,
} from './transcribe-model.ts';
import { askDownload } from './transcribe-ui.ts';
import { probeOffer, workerInstall, workerTranscribe } from './transcribe-worker.ts';
import { startVoicePipeline, type VoicePipeline } from './voice-pipeline.ts';
import { judgeRecording, MAX_VOICE_MS } from './voice-recorder-model.ts';

export interface DictationOptions {
  toast(text: string): void;
  /** The words the person spoke; the caller puts them into the entry and sends nothing. */
  insert(text: string): void;
}

export interface Dictation {
  button: Gtk.Button;
  /** Whether the composer offers dictation at all; the button also stays hidden where the machine cannot transcribe. */
  setAvailable(on: boolean): void;
}

const IDLE_TIP = _('Dictate a message');

export function createDictation(options: DictationOptions): Dictation {
  const button = new Gtk.Button({
    iconName: 'microphone-sensitivity-high-symbolic',
    tooltipText: IDLE_TIP,
    visible: false,
  });
  button.add_css_class('flat');
  button.add_css_class('circular');
  button.update_property([Gtk.AccessibleProperty.LABEL], [IDLE_TIP]);

  let wanted = false;
  let fits = false;
  let phase: DictationPhase = 'idle';
  let recording: { pipeline: VoicePipeline; path: string } | null = null;
  let job: Job | null = null;
  let limit = 0;

  const refresh = (): void => button.set_visible(wanted && fits);
  const label = (text: string): void => {
    button.set_tooltip_text(text);
    button.update_property([Gtk.AccessibleProperty.LABEL], [text]);
  };
  const reset = (path?: string): void => {
    if (limit) GLib.source_remove(limit);
    limit = 0;
    if (path) rmSync(path, { force: true });
    phase = 'idle';
    recording = null;
    job = null;
    button.remove_css_class('suggested-action');
    button.set_icon_name('microphone-sensitivity-high-symbolic');
    label(IDLE_TIP);
  };

  void probeOffer().then((offer) => {
    fits = offer.kind === 'ready' || offer.kind === 'needs-download';
    refresh();
  });

  const transcribe = (path: string): void => {
    phase = 'transcribing';
    button.remove_css_class('suggested-action');
    button.set_icon_name('process-stop-symbolic');
    label(_('Cancel dictation'));
    let asked = false;
    const own = createJob({
      status: probeOffer,
      download: workerInstall,
      run: (signal) => workerTranscribe(path, signal),
      save: () => {},
    });
    job = own;
    own.subscribe((state) => {
      if (job !== own) return;
      if (state.kind === 'confirming' && !asked) {
        asked = true;
        askDownload(button, state.bytes, (yes) => {
          if (yes) void own.confirm();
          else own.cancel();
        });
      } else if (state.kind === 'done') {
        const text = state.text;
        reset(path);
        if (text.trim() === '') options.toast(_('No speech found'));
        else options.insert(text);
      } else if (state.kind === 'failed') {
        reset(path);
        options.toast(failureMessage(state));
      } else if (state.kind === 'idle') {
        reset(path);
      }
    });
    void own.request();
  };

  const stop = (keep: boolean): void => {
    const run = recording;
    if (!run) return;
    if (limit) GLib.source_remove(limit);
    limit = 0;
    if (!keep) {
      run.pipeline.abort();
      reset(run.path);
      return;
    }
    phase = 'transcribing';
    void run.pipeline.stop().then((ms) => {
      if (phase !== 'transcribing' || recording !== run) return;
      recording = null;
      if (!judgeRecording(ms).keep) {
        reset(run.path);
        options.toast(_('The recording was too short'));
        return;
      }
      transcribe(run.path);
    });
  };

  const start = (): void => {
    const dir = join(previewsDir(), 'voice');
    ensurePrivateDir(dir);
    const path = join(dir, `dictation-${Date.now()}.ogg`);
    let pipeline: VoicePipeline | null = null;
    try {
      pipeline = startVoicePipeline({
        path,
        onLevel: () => {},
        onError: () => {
          if (recording?.path !== path) return;
          recording.pipeline.abort();
          reset(path);
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
    recording = { pipeline, path };
    phase = 'recording';
    button.add_css_class('suggested-action');
    button.set_icon_name('media-playback-stop-symbolic');
    label(_('Stop dictating'));
    limit = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MAX_VOICE_MS, () => {
      limit = 0;
      stop(true);
      return GLib.SOURCE_REMOVE;
    });
  };

  button.connect('clicked', () => {
    const { action } = dictationPress(phase);
    if (action === 'start') start();
    else if (action === 'stop') stop(true);
    else job?.cancel();
  });

  const keys = new Gtk.EventControllerKey();
  keys.connect('key-pressed', (_c, keyval) => {
    if (dictationKeyAction(keyval === Gdk.KEY_Escape ? 'Escape' : '') !== 'cancel') return false;
    if (phase === 'recording') stop(false);
    else if (phase === 'transcribing') job?.cancel();
    else return false;
    return true;
  });
  button.add_controller(keys);

  return {
    button,
    setAvailable(on) {
      wanted = on;
      if (!on && phase === 'recording') stop(false);
      refresh();
    },
  };
}
