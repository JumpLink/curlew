// fixed upstream in gjsify: sync node:fs bridge; drop this stub after the bump.
// Stands in for packages/protocol/src/media-probe.ts in this shell only (see vite.config.ts).
export interface MediaProbe {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  voice: boolean;
}

const unsupported = (): never => {
  throw new Error("media probing is not available in the Android shell yet");
};

export const probeMedia = (_bytes: Uint8Array, _mimeType: string): MediaProbe => unsupported();
export const probeMediaFile = (_path: string, _mimeType: string): MediaProbe => unsupported();
