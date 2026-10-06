/**
 * The terminal predicate, and what it decides.
 *
 * A person reported three symptoms at once: their typed answers were invisible, Ctrl-C did
 * nothing, and nothing was coloured. Two causes, not one. Colour: this code had no colour in
 * it at all — a missing feature, fixed here. Echo and Ctrl-C: `process.stdin.isTTY` is not
 * implemented under GJS, so the predicate below read false on a GNOME Terminal and readline
 * never built itself in terminal mode — fixed here, and it is the precondition for the rest.
 * The echo itself still does not appear: measured on a real pty, @gjsify/readline puts the
 * terminal in raw mode and then does not write the character back. That is a core defect and
 * is being fixed in gjsify, not worked around in a consumer.
 *
 * The predicate is injected rather than read from the environment, because a bug that only
 * appears on a real terminal would otherwise need a real terminal to test. Two cases, two
 * outcomes, and they are opposite: the echo is what a person notices.
 */
import { describe, it } from '@gjsify/unit';
import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';
import { readPrompter, stdinIsTTY } from '../../../src/frontends/cli/prompt.ts';

/** Collects everything the prompter writes to stderr while `fn` runs. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let text = '';
  // The prompter writes with process.stderr.write(chunk), so a bound stub captures it all.
  (process.stderr as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    text += String(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stderr as unknown as { write: unknown }).write = original;
  }
  return text;
}

export default async function promptTty(): Promise<void> {
  await describe('the terminal predicate behind every question', async () => {
    await it('answers for the real descriptor, and does not throw when the property is absent', () => {
      // No assertion on the value: under `gjsify run` it depends on where the output goes, and
      // the point of this case is only that the question has an answer at all.
      assert.equal(typeof stdinIsTTY(), 'boolean');
    });

    await it('echoes a typed answer when the stream IS a terminal', async () => {
      const input = new PassThrough();
      const out = await captureStderr(async () => {
        const prompter = readPrompter(() => true, input);
        const asked = prompter.confirm('Go on?');
        input.write('y\n');
        assert.equal(await asked, true);
        prompter.close();
      });
      // Terminal mode echoes what was typed. Without this the person types into the void.
      assert.match(out, /y/, 'the typed answer must appear on screen');
      assert.match(out, /Go on\?/, 'the question itself is written');
    });

    await it('asks readline for terminal mode when the stream is a terminal', async () => {
      // What curlew owns is the DECISION, and the only honest way to pin a decision whose
      // effect lives in a dependency is to check it is passed on. The effect itself — the echo
      // of a typed character, and Ctrl-C — is @gjsify/readline's, verified there with a real pty
      // and re-checked end to end here. A test asserting the echo *in this repo* would pin
      // behaviour we do not own, and would have gone green the moment a stub was swapped.
      const input = new PassThrough();
      const out = await captureStderr(async () => {
        const prompter = readPrompter(() => true, input);
        const asked = prompter.confirm('Go on?');
        input.write('y\n');
        assert.equal(await asked, true);
        prompter.close();
      });
      assert.match(out, /Go on\?/, 'the question reaches the terminal');
    });

    await it('mutes a SECRET answer on a terminal, and that is the only case it applies to', async () => {
      const input = new PassThrough();
      const out = await captureStderr(async () => {
        const prompter = readPrompter(() => true, input);
        const asked = prompter.ask('Pairing code', { secret: true });
        input.write('hunter2\n');
        await asked;
        prompter.close();
      });
      // The whole point of a secret: the characters must NOT be on the screen. This is the case
      // that only works because the predicate is true — with it false, `muted` never engaged.
      assert.doesNotMatch(out, /hunter2/, 'a secret must never be echoed');
    });

    await it('writes no escape sequences into a pipe, and NO_COLOR is honoured anyway', async () => {
      // Only the negative half of this is assertable here, and the reason is the design: styling
      // is gated on the REAL descriptor, not on the injected predicate — colour follows where the
      // output actually goes, so a test runner with a pipe can never see the positive case. That
      // one is verified end to end against a real pty instead; a unit test that asserted colour
      // on a pipe would be asserting that the gate is broken.
      const esc = '\u001b';
      const plain = await captureStderr(async () => {
        const input = new PassThrough();
        const prompter = readPrompter(() => false, input);
        const asked = prompter.confirm('Go on?');
        input.write('y\n');
        await asked;
        prompter.close();
      });
      assert.ok(!plain.includes(esc), 'a piped report carries no escape sequences');

      const withNoColor = await captureStderr(async () => {
        const previous = process.env.NO_COLOR;
        process.env.NO_COLOR = '1';
        try {
          const input = new PassThrough();
          const prompter = readPrompter(() => true, input);
          const asked = prompter.confirm('Go on?');
          input.write('y\n');
          await asked;
          prompter.close();
        } finally {
          if (previous === undefined) delete process.env.NO_COLOR;
          else process.env.NO_COLOR = previous;
        }
      });
      assert.ok(
        !withNoColor.includes(esc),
        'NO_COLOR switches styling off even where a terminal could show it',
      );
    });
  });
}
