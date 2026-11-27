import { describe, expect, it } from '@gjsify/unit';

import {
  judgeRecording,
  levelFraction,
  parseLevelDb,
  recordingKeyAction,
  recordingSeconds,
  MAX_VOICE_MS,
  MIN_VOICE_MS,
  recordingLabel,
  voiceNoteName,
  voiceNoteOf,
} from '../../../src/window/voice-recorder-model.ts';

const file = (voiceMs?: number) => ({
  path: '/x/a.ogg',
  name: 'a.ogg',
  size: 1,
  temporary: true,
  ...(voiceMs === undefined ? {} : { voiceMs }),
});

export default async () => {
  await describe('voice recorder model', async () => {
    await it('names a recording by its local time', async () => {
      expect(voiceNoteName(new Date(2026, 0, 5, 7, 8, 9))).toBe('voice-2026-01-05-070809.ogg');
    });

    await it('drops a slip of the finger and clamps a long note', async () => {
      expect(judgeRecording(MIN_VOICE_MS - 1).keep).toBe(false);
      expect(judgeRecording(MIN_VOICE_MS).keep).toBe(true);
      expect(judgeRecording(MAX_VOICE_MS * 2).durationMs).toBe(MAX_VOICE_MS);
      expect(judgeRecording(NaN).keep).toBe(false);
    });

    await it('reads the running time as m:ss', async () => {
      expect(recordingLabel(0)).toBe('0:00');
      expect(recordingLabel(7000)).toBe('0:07');
    });

    await it('maps dB readings to a bar fraction', async () => {
      expect(levelFraction(0)).toBe(1);
      expect(levelFraction(-30)).toBe(0.5);
      expect(levelFraction(-90)).toBe(0);
      expect(levelFraction(-Infinity)).toBe(0);
      expect(levelFraction(NaN)).toBe(0);
      expect(levelFraction(12)).toBe(1);
    });

    await it('binds Escape to cancel and Enter or Space to stop', async () => {
      expect(recordingKeyAction('Escape')).toBe('cancel');
      expect(recordingKeyAction('Enter')).toBe('stop');
      expect(recordingKeyAction('Space')).toBe('stop');
      expect(recordingKeyAction('a')).toBe(null);
    });

    await it('reads the rms from a level message', async () => {
      expect(parseLevelDb('level, rms=(GValueArray)< -4.94 >, peak=(GValueArray)< -1.9 >;')).toBe(-4.94);
      expect(parseLevelDb('level, rms=(GValueArray)< -inf >;')).toBe(-Infinity);
      expect(parseLevelDb('level, peak=(GValueArray)< -1 >;')).toBe(null);
    });

    await it('counts whole seconds', async () => {
      expect(recordingSeconds(2999)).toBe(2);
      expect(recordingSeconds(-5)).toBe(0);
      expect(recordingSeconds(NaN)).toBe(0);
    });

    await it('sends a voice note only for a lone recording', async () => {
      expect(voiceNoteOf([file(4000)])).toStrictEqual({ durationMs: 4000 });
      expect(voiceNoteOf([file(4000), file()])).toBe(null);
      expect(voiceNoteOf([file()])).toBe(null);
      expect(voiceNoteOf([])).toBe(null);
    });
  });
};
