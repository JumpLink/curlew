/**
 * The `AccountPrompter` a window hands to a backend login, as a pure adapter: the backend asks
 * (`ask`, `notify`, `showQr`) and a surface — the widgets — shows one step at a time. No GTK here,
 * so both runtimes test it.
 *
 * Why an adapter and not widgets that implement the prompter: a login is one long awaited call
 * (`accountsAdd`) that may sit in `ask` for minutes. Leaving the page must end it, and a late
 * `notify` from a backend that is still running must not paint over whatever the window shows
 * next. Both are rules about the CALL, not the widgets, so they live here.
 */

import type { AccountPrompter } from '@curlew/protocol';

/** One thing the person sees or answers while an account is added. */
export type PromptStep =
  | { kind: 'ask'; label: string; secret: boolean; submit(value: string): void }
  | { kind: 'qr'; data: string; instructions: string }
  | { kind: 'status'; message: string };

/** What shows a step. The latest one replaces the one before. */
export interface PromptSurface {
  present(step: PromptStep): void;
}

/** The person left before the login finished. Not a failure to report. */
export class PromptCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'PromptCancelled';
  }
}

export interface SurfacePrompter extends AccountPrompter {
  /** Reject the question being asked and silence the backend from now on. */
  cancel(): void;
  readonly cancelled: boolean;
}

export function createSurfacePrompter(surface: PromptSurface): SurfacePrompter {
  let cancelled = false;
  let pending: ((err: Error) => void) | null = null;

  return {
    get cancelled() {
      return cancelled;
    },
    ask(label, options) {
      if (cancelled) return Promise.reject(new PromptCancelled());
      return new Promise<string>((resolve, reject) => {
        pending = reject;
        surface.present({
          kind: 'ask',
          label,
          secret: options?.secret === true,
          submit: (value) => {
            // A second press of Enter must not answer a question that is already answered.
            if (pending !== reject) return;
            pending = null;
            resolve(value);
          },
        });
      });
    },
    notify(message) {
      if (!cancelled) surface.present({ kind: 'status', message });
    },
    showQr(data, instructions) {
      if (!cancelled) surface.present({ kind: 'qr', data, instructions });
    },
    cancel() {
      cancelled = true;
      const reject = pending;
      pending = null;
      reject?.(new PromptCancelled());
    },
  };
}
