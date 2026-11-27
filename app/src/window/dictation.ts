/** The dictation of the composer: record with the voice-note pipeline, transcribe locally, put the text into the entry. */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import GLib from 'gi://GLib?version=2.0';
import type Gtk from 'gi://Gtk?version=4.0';
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
import type { MicBusy } from './microphone-model.ts';
import { judgeRecording, MAX_VOICE_MS } from './voice-recorder-model.ts';

export interface DictationOptions {
  toast(text: string): void;
  /** The words the person spoke; the caller puts them into the entry and sends nothing. */
  insert(text: string): void;
  /** What the shared microphone control shows while dictating; null when idle. */
  onLook(look: MicBusy): void;
  /** Offered or not changed. */
  onOfferChange(): void;
  /** Where the download question anchors. */
  anchor(): Gtk.Widget;
}

export interface Dictation {
  /** The microphone was pressed: starts, stops or cancels, by the phase. */
  press(): void;
  /** Escape: true when it cancelled something. */
  escape(): boolean;
  /** Recording or transcribing. */
  busy(): boolean;
  /** The composer takes it and this machine can transcribe. */
  offered(): boolean;
  /** Whether the composer offers dictation at all; it also stays off where the machine cannot transcribe. */
  setAvailable(on: boolean): void;
}

export function createDictation(options: DictationOptions): Dictation {
  let wanted = false;
  let fits = false;
  let phase: DictationPhase = 'idle';
  let recording: { pipeline: VoicePipeline; path: string } | null = null;
  let job: Job | null = null;
  let limit = 0;

  let shown = false;
  const refresh = (): void => {
    if (shown === (wanted && fits)) return;
    shown = wanted && fits;
    options.onOfferChange();
  };
  const reset = (path?: string): void => {
    if (limit) GLib.source_remove(limit);
    limit = 0;
    if (path) rmSync(path, { force: true });
    phase = 'idle';
    recording = null;
    job = null;
    options.onLook(null);
  };

  void probeOffer().then((offer) => {
    fits = offer.kind === 'ready' || offer.kind === 'needs-download';
    refresh();
  });

  const transcribe = (path: string): void => {
    phase = 'transcribing';
    options.onLook({ icon: 'process-stop-symbolic', label: _('Cancel dictation'), suggested: false });
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
        askDownload(options.anchor(), state.bytes, (yes) => {
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
    options.onLook({ icon: 'media-playback-stop-symbolic', label: _('Stop dictating'), suggested: true });
    limit = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MAX_VOICE_MS, () => {
      limit = 0;
      stop(true);
      return GLib.SOURCE_REMOVE;
    });
  };

  const press = (): void => {
    const { action } = dictationPress(phase);
    if (action === 'start') start();
    else if (action === 'stop') stop(true);
    else job?.cancel();
  };

  const escape = (): boolean => {
    if (dictationKeyAction('Escape') !== 'cancel') return false;
    if (phase === 'recording') stop(false);
    else if (phase === 'transcribing') job?.cancel();
    else return false;
    return true;
  };

  return {
    press,
    escape,
    busy: () => phase !== 'idle',
    offered: () => shown,
    setAvailable(on) {
      wanted = on;
      if (!on && phase === 'recording') stop(false);
      refresh();
    },
  };
}
