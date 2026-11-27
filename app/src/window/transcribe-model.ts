/**
 * Pure rules for transcribing voice notes and dictating text (issue #500): whether the feature is
 * offered on this machine, the state of one transcription job, and how dictated text joins the entry.
 * Free of GTK and of the engine, so Node and GJS test it the same way.
 */

import { _ } from '@curlew/protocol';

import { attachmentKind, isOpenable } from './attachment-model.ts';
import type { AttachmentInfo } from './conversation-model.ts';

/** What `@gjsify/machine-fit` says about where a model would run. */
export type FitPlacement = 'gpu' | 'gpu+cpu' | 'cpu' | 'unknown' | 'none';

export type ModelAvailability = 'available' | 'downloading' | 'downloadable' | 'unavailable';

/** What the worker reports about this machine; one JSON line of `curlew transcribe --status`. */
export interface TranscribeStatus {
  /** `hasRecognitionBackend()`: a native engine exists on this host. */
  backend: boolean;
  /** The CPU fit of the model's footprint (the engine runs on the CPU). */
  placement: FitPlacement;
  availability: ModelAvailability;
  /** The model that would run, with the bytes a download fetches; null when none fits the language. */
  model: { id: string; bytes: number } | null;
}

export type Offer =
  | { kind: 'hidden' }
  | { kind: 'ready' }
  | { kind: 'needs-download'; bytes: number }
  | { kind: 'busy' };

/** Working memory of the engine on top of the model files (compute buffers, the decoded audio). */
export const TRANSCRIBE_OVERHEAD_BYTES = 512 * 1024 * 1024;

/** The single "is this system suitable" gate: an engine, a model for the language, and room for it. */
export function decideOffer(status: TranscribeStatus | null): Offer {
  if (!status || !status.backend || status.model === null) return { kind: 'hidden' };
  if (status.placement !== 'cpu' && status.placement !== 'gpu' && status.placement !== 'gpu+cpu') {
    return { kind: 'hidden' };
  }
  switch (status.availability) {
    case 'available':
      return { kind: 'ready' };
    case 'downloadable':
      return { kind: 'needs-download', bytes: status.model.bytes };
    case 'downloading':
      return { kind: 'busy' };
    default:
      return { kind: 'hidden' };
  }
}

/** The BCP 47 language the models are picked for: the first part of the locale, English if none. */
export function languageOf(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  const first = (env.LANGUAGE ?? '').split(':')[0] || raw;
  const base = first.split('.')[0]?.split('@')[0]?.split('_')[0]?.toLowerCase() ?? '';
  return /^[a-z]{2,3}$/.test(base) && base !== 'c' ? base : 'en';
}

/** The part of a message a transcript belongs to: its first voice note or audio part that can be fetched. */
export function transcribableIndex(attachments: readonly AttachmentInfo[] | undefined): number | null {
  const found = (attachments ?? []).find((a) => {
    const kind = attachmentKind(a);
    return (kind === 'voice' || kind === 'audio') && isOpenable(a);
  });
  return found ? (found.index ?? 0) : null;
}

export type FailureCode = 'unavailable' | 'download' | 'transcribe';

export type JobState =
  | { kind: 'idle' }
  | { kind: 'confirming'; bytes: number }
  | { kind: 'downloading'; received: number; total: number }
  | { kind: 'transcribing' }
  | { kind: 'done'; text: string }
  | { kind: 'failed'; code: FailureCode; detail: string };

export interface TranscriptResult {
  text: string;
  language: string | null;
  engine: string;
}

export interface JobDeps {
  status(): Promise<Offer>;
  /** Fetches the model; resolves false when it could not be had. Honours `signal`. */
  download(onProgress: (received: number, total: number) => void, signal: AbortSignal): Promise<boolean>;
  /** Decodes the audio; rejects when aborted. */
  run(signal: AbortSignal): Promise<TranscriptResult>;
  /** Called once with a finished transcript, to keep it in the index. */
  save(result: TranscriptResult): void;
}

export interface Job {
  readonly state: JobState;
  subscribe(listener: (state: JobState) => void): () => void;
  /** Starts, or asks for the download first. */
  request(): Promise<void>;
  /** The person agreed to the download named in `confirming`. */
  confirm(): Promise<void>;
  /** Stops what runs or declines the download. */
  cancel(): void;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One transcription of one voice note: a small state machine around the engine, with nothing else in it. */
export function createJob(deps: JobDeps, cached: string | null = null): Job {
  let state: JobState = cached !== null ? { kind: 'done', text: cached } : { kind: 'idle' };
  let controller: AbortController | null = null;
  const listeners = new Set<(s: JobState) => void>();
  const set = (next: JobState): void => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  const busy = (): boolean =>
    state.kind === 'downloading' || state.kind === 'transcribing' || state.kind === 'confirming';

  const transcribe = async (own: AbortController): Promise<void> => {
    set({ kind: 'transcribing' });
    try {
      const result = await deps.run(own.signal);
      if (own.signal.aborted) return;
      deps.save(result);
      set({ kind: 'done', text: result.text });
    } catch (err) {
      if (own.signal.aborted) return;
      set({ kind: 'failed', code: 'transcribe', detail: errorText(err) });
    }
  };

  const start = async (): Promise<void> => {
    const own = new AbortController();
    controller = own;
    await transcribe(own);
  };

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request() {
      if (busy() || state.kind === 'done') return;
      const offer = await deps.status();
      if (offer.kind === 'hidden' || offer.kind === 'busy') {
        set({ kind: 'failed', code: 'unavailable', detail: '' });
        return;
      }
      if (offer.kind === 'needs-download') {
        set({ kind: 'confirming', bytes: offer.bytes });
        return;
      }
      await start();
    },
    async confirm() {
      if (state.kind !== 'confirming') return;
      const own = new AbortController();
      controller = own;
      set({ kind: 'downloading', received: 0, total: state.bytes });
      let ok = false;
      try {
        ok = await deps.download((received, total) => {
          if (!own.signal.aborted) set({ kind: 'downloading', received, total });
        }, own.signal);
      } catch (err) {
        if (own.signal.aborted) return;
        set({ kind: 'failed', code: 'download', detail: errorText(err) });
        return;
      }
      if (own.signal.aborted) return;
      if (!ok) {
        set({ kind: 'failed', code: 'download', detail: '' });
        return;
      }
      await transcribe(own);
    },
    cancel() {
      if (!busy()) return;
      controller?.abort();
      controller = null;
      set({ kind: 'idle' });
    },
  };
}

/** The fraction of a download, 0 to 1; 0 while the size is unknown. */
export function downloadFraction(received: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, received / total));
}

/** The text to put into the entry: trimmed, and set off from what is already there by one space. */
export function dictationInsert(text: string, before: string): string {
  const spoken = text.trim();
  if (spoken === '') return '';
  return before !== '' && !/\s$/.test(before) ? ` ${spoken}` : spoken;
}

/** What a key does while dictation runs: Escape throws the recording or the job away. */
export function dictationKeyAction(key: string): 'cancel' | null {
  return key === 'Escape' ? 'cancel' : null;
}

export type DictationPhase = 'idle' | 'recording' | 'transcribing';

/** The button's next phase when pressed: one press starts, the next stops, a third while decoding cancels. */
export function dictationPress(phase: DictationPhase): {
  next: DictationPhase;
  action: 'start' | 'stop' | 'cancel';
} {
  if (phase === 'idle') return { next: 'recording', action: 'start' };
  if (phase === 'recording') return { next: 'transcribing', action: 'stop' };
  return { next: 'idle', action: 'cancel' };
}

/** What the person reads when a job failed. */
export function failureMessage(state: { code: FailureCode; detail: string }): string {
  if (state.code === 'unavailable') return _('This computer cannot transcribe speech');
  const base =
    state.code === 'download' ? _('The speech model could not be downloaded') : _('Transcribing failed');
  return state.detail === '' ? base : `${base}: ${state.detail}`;
}
