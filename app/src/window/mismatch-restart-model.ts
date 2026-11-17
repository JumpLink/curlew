/** What the one restart does for each side of a wire mismatch; the actions are injected so it runs on Node. */

export type MismatchSide = 'daemon-older' | 'window-older';

export interface MismatchRestartActions {
  /** Start this window again and quit; the window is the side that is behind. */
  relaunchWindow(): void;
  /** Restart the background service; the service is the side that is behind. */
  restartDaemon(): Promise<void>;
}

/** Resolves with whether the restart went through; false means the mismatch is still there. */
export async function restartAfterMismatch(
  side: MismatchSide,
  actions: MismatchRestartActions,
): Promise<boolean> {
  if (side === 'window-older') {
    actions.relaunchWindow();
    return true;
  }
  try {
    await actions.restartDaemon();
    return true;
  } catch {
    return false;
  }
}
