/** Pure rules for recording a voice note: its name, its limits and how the composer reads it back. */

import { durationLabel } from './attachment-model.ts';
import type { PickedFile } from './composer-files-model.ts';

/** A note shorter than this is a slip of the finger and is dropped. */
export const MIN_VOICE_MS = 500;

/** Recording stops by itself here, so a forgotten button does not fill the disk. */
export const MAX_VOICE_MS = 5 * 60 * 1000;

/** The name a recording is saved under: sortable, Ogg because that is what the container holds. */
export function voiceNoteName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `voice-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.ogg`;
}

/** Whether a finished recording is worth sending; the length is clamped to the limit. */
export function judgeRecording(ms: number): { keep: boolean; durationMs: number } {
  const durationMs = Math.min(MAX_VOICE_MS, Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0)));
  return { keep: durationMs >= MIN_VOICE_MS, durationMs };
}

/** The running time shown on the record button. */
export function recordingLabel(ms: number): string {
  return durationLabel(ms) || '0:00';
}

/**
 * The message is a voice note when its one and only file is a recording: Delta Chat marks the
 * message's single attachment, so a recording next to other files goes as an ordinary file.
 */
export function voiceNoteOf(files: readonly PickedFile[]): { durationMs: number } | null {
  const only = files.length === 1 ? files[0] : undefined;
  return only?.voiceMs !== undefined && only.voiceMs > 0 ? { durationMs: only.voiceMs } : null;
}
