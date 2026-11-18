/**
 * Poll until a condition holds or the budget runs out. Resolves either way: the test's own
 * assertions after the call say what was missing, which reads better than a timeout error here.
 */
export async function until(done: () => boolean, ms = 3000, stepMs = 10): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, stepMs));
}
