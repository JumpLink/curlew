/** What the composer's microphone does when pressed; persisted as `ui.micMode`. */
export const MIC_MODES = ['voice', 'dictate'] as const;

export type MicMode = (typeof MIC_MODES)[number];

export const DEFAULT_MIC_MODE: MicMode = 'voice';

export const isMicMode = (value: unknown): value is MicMode =>
  typeof value === 'string' && (MIC_MODES as readonly string[]).includes(value);
