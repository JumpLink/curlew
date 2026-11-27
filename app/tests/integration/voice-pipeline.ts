// Records two seconds from `audiotestsrc` through the real voice pipeline and checks the file: an
// Ogg Opus mono voice note with level readings. No microphone, no bus; GJS only (`test:voice-pipeline`).
import GLib from 'gi://GLib?version=2.0';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeMediaFile } from '@curlew/protocol';
import { startVoicePipeline } from '../../src/window/voice-pipeline.ts';

let failures = 0;
const check = (name: string, ok: boolean): void => {
  console.log(ok ? 'ok  ' : 'FAIL', name);
  if (!ok) failures += 1;
};

const work = mkdtempSync(join(tmpdir(), 'curlew-voice-'));
const path = join(work, 'voice.ogg');
const loop = new GLib.MainLoop(null, false);
const levels: number[] = [];
let ms = 0;

const pipeline = startVoicePipeline({
  path,
  sources: ['audiotestsrc'],
  onLevel: (db) => levels.push(db),
  onError: (message) => console.log('error', message),
});
check('pipeline starts', pipeline !== null);
if (pipeline) {
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
    void pipeline.stop().then((length) => {
      ms = length;
      loop.quit();
    });
    return GLib.SOURCE_REMOVE;
  });
  loop.run();
  check('length is about two seconds', ms > 1500 && ms < 3500);
  check('file starts with OggS', readFileSync(path).subarray(0, 4).toString('latin1') === 'OggS');
  check('file is not empty', statSync(path).size > 500);
  check('level readings arrived', levels.length >= 5);
  const probe = probeMediaFile(path, 'audio/ogg');
  check('probe sees a voice note', probe.voice === true);
  check('probe length is close', probe.durationMs !== null && Math.abs(probe.durationMs - ms) < 600);
}
rmSync(work, { recursive: true, force: true });
if (failures > 0) imports.system.exit(1);
