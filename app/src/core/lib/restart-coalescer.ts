/**
 * One restart at a time. An account add, a pause and a remove in quick succession each ask for a
 * `try-restart`; fired side by side they queue as separate stop/start cycles in systemd, and a
 * stop racing the next start left a daemon killed mid-stop with its leases behind. Calls that
 * arrive while a restart is running collapse into ONE more restart after it ends, so the daemon
 * still reads the final account list.
 */
export function createRestartCoalescer(run: () => Promise<void>): () => void {
  let running = false;
  let again = false;
  const go = async (): Promise<void> => {
    running = true;
    try {
      do {
        again = false;
        try {
          await run();
        } catch {
          // No systemd user session: the next start of the daemon reads the new account list.
        }
      } while (again);
    } finally {
      running = false;
    }
  };
  return () => {
    if (running) {
      again = true;
      return;
    }
    void go();
  };
}
