/**
 * Local speech-to-text for finished recordings: the machine's fit, the model download and the
 * decode, all in one place that never touches GTK. It runs in a worker process (`curlew
 * transcribe`), so neither the model load, the memory probe nor the decode can stall a window.
 * Nothing here leaves the machine: the engine is sherpa-onnx and the only network use is the
 * model download, which the person confirmed.
 *
 * // gjsify gap (unfixed, gjsify/gjsify#2762): `transcribe()` decodes on the calling thread and
 * // there is no "model that fits this machine" helper; this module is the extractable stand-in.
 */

import { TRANSCRIBE_OVERHEAD_BYTES, type TranscribeStatus, type TranscriptResult } from '../../window/transcribe-model.ts';

type SpeechModule = typeof import('@gjsify/speech-recognition');

async function speech(): Promise<SpeechModule | null> {
  try {
    return await import('@gjsify/speech-recognition');
  } catch {
    return null;
  }
}

const OPTIONS = { kind: 'offline', quality: 'conversation' } as const;

/** Where a model for `lang` would run, whether it is on disk and how many bytes a download costs. */
export async function readStatus(lang: string): Promise<TranscribeStatus> {
  const none: TranscribeStatus = { backend: false, placement: 'none', availability: 'unavailable', model: null };
  const sr = await speech();
  if (!sr || !sr.hasRecognitionBackend()) return none;
  const entry = sr.modelFor(lang, OPTIONS.quality, OPTIONS.kind);
  if (!entry) return { ...none, backend: true };
  const fit = await import('@gjsify/machine-fit');
  const bytes = entry.files.reduce((sum, file) => sum + file.bytes, 0);
  // The engine runs on the CPU, so the question is whether RAM holds it: no GPU is offered to the check.
  const memory = { ...fit.readMachineMemory(), gpus: [] };
  const placement = fit.checkFit(
    fit.estimateFootprint({ weightsBytes: bytes, overheadBytes: TRANSCRIBE_OVERHEAD_BYTES }),
    memory,
  ).placement;
  const availability = await sr.available({ langs: [lang], ...OPTIONS });
  return { backend: true, placement, availability, model: { id: entry.id, bytes } };
}

/** Fetches the model for `lang` through the shared model store (verified, resumable). */
export async function installModel(
  lang: string,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const sr = await speech();
  if (!sr) return false;
  return sr.install({
    langs: [lang],
    ...OPTIONS,
    signal,
    onProgress: (p) => onProgress(p.received, p.total),
  });
}

/** Decodes one audio file (Ogg/Opus, M4A, …: GStreamer reads it) to text. */
export async function transcribeFile(path: string, lang: string, signal?: AbortSignal): Promise<TranscriptResult> {
  const sr = await speech();
  if (!sr || !sr.hasRecognitionBackend()) throw new Error('No speech recognition engine on this machine');
  const entry = sr.modelFor(lang, OPTIONS.quality, OPTIONS.kind);
  if (!entry) throw new Error(`No speech model for '${lang}'`);
  const result = await sr.transcribe(path, { model: entry.id, signal });
  return { text: result.text.trim(), language: result.language, engine: result.engine };
}
