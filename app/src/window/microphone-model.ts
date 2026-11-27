/** The composer's one microphone: which modes it offers, which one it runs, and how it looks. */

import { _ } from '@curlew/protocol';

import { DEFAULT_MIC_MODE, MIC_MODES, type MicMode } from '../core/lib/mic-mode.ts';

export { DEFAULT_MIC_MODE, isMicMode, MIC_MODES, type MicMode } from '../core/lib/mic-mode.ts';

/** The key of the choice in `config.ui`. */
export const MIC_MODE_KEY = 'micMode';

export interface MicOffer {
  /** The protocol takes voice notes and the composer takes files. */
  voice: boolean;
  /** This machine can transcribe (`probeOffer`). */
  dictate: boolean;
}

/** The modes the menu lists, in the menu's order. */
export function offeredModes(offer: MicOffer): MicMode[] {
  return MIC_MODES.filter((mode) => offer[mode]);
}

/**
 * The mode a press runs: the remembered one while it is offered, else the first one that is, else
 * none. The remembered choice is never rewritten by a fallback, so it returns when it is offered again.
 */
export function activeMicMode(stored: MicMode | undefined, offered: readonly MicMode[]): MicMode | null {
  if (offered.length === 0) return null;
  const wanted = stored ?? DEFAULT_MIC_MODE;
  return offered.includes(wanted) ? wanted : (offered[0] ?? null);
}

/** `none`: hidden; `button`: one mode left, a plain button; `split`: a button with a menu. */
export function micLayout(offered: readonly MicMode[]): 'none' | 'button' | 'split' {
  if (offered.length === 0) return 'none';
  return offered.length === 1 ? 'button' : 'split';
}

export interface MicLook {
  icon: string;
  /** Tooltip and accessible label of the main button. */
  label: string;
  /** The menu entry. */
  choice: string;
}

/** Looks of the idle control. Called at use, never at module load, so the language is known. */
export function micLook(mode: MicMode): MicLook {
  return mode === 'voice'
    ? {
        icon: 'audio-input-microphone-symbolic',
        label: _('Record a voice message'),
        choice: _('Voice message'),
      }
    : { icon: 'dictate-symbolic', label: _('Dictate a message'), choice: _('Dictate') };
}

/** Looks while a recording or a transcription runs; null means idle. */
export type MicBusy = { icon: string; label: string; suggested: boolean } | null;

/** The label of the arrow, which names what the menu changes. */
export const micMenuLabel = (): string => _('Choose what the microphone does');
