/** Pure rules for recording a voice note: its name, its limits and how the composer reads it back. */

import { durationLabel } from './attachment-model.ts';
import { fileStamp, type PickedFile } from './composer-files-model.ts';

/** A note shorter than this is a slip of the finger and is dropped. */
export const MIN_VOICE_MS = 500;

/** Recording stops by itself here, so a forgotten button does not fill the disk. */
export const MAX_VOICE_MS = 5 * 60 * 1000;

/** The name a recording is saved under: sortable, Ogg because that is what the container holds. */
export function voiceNoteName(at: Date): string {
  return `voice-${fileStamp(at)}.ogg`;
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

/** The quietest level the meter shows, in dB; anything below reads as silence. */
export const LEVEL_FLOOR_DB = -60;

/** A GStreamer `level` reading (dB, 0 = full scale) as a bar fraction from 0 to 1. */
export function levelFraction(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB));
}

/** What a key does in the recording bar: Escape cancels, Enter or Space ends the note. */
export function recordingKeyAction(key: 'Escape' | 'Enter' | 'Space' | string): 'cancel' | 'stop' | null {
  if (key === 'Escape') return 'cancel';
  return key === 'Enter' || key === 'Space' ? 'stop' : null;
}

/** The screen-reader text for the running time, in whole seconds. */
export function recordingSeconds(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
}

/** The first channel's RMS in dB from a `level` message's text (`rms=(GValueArray)< -4.9 >`); null when absent. */
export function parseLevelDb(structure: string): number | null {
  const match = /rms=\(GValueArray\)<\s*(-?(?:\d+(?:\.\d+)?|inf))/.exec(structure);
  if (!match) return null;
  const db = match[1] === '-inf' ? -Infinity : Number(match[1]);
  return Number.isNaN(db) ? null : db;
}

/** The screen-reader name of the running recording: spoken once, not per tick. */
export function recordingAnnouncement(ms: number): string {
  return String(recordingSeconds(ms));
}
