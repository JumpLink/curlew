import { describe, expect, it } from '@gjsify/unit';

import {
  createJob,
  decideOffer,
  dictationInsert,
  dictationPress,
  downloadFraction,
  languageOf,
  transcribableIndex,
  type JobDeps,
  type JobState,
  type Offer,
  type TranscribeStatus,
} from '../../../src/window/transcribe-model.ts';

const status = (over: Partial<TranscribeStatus>): TranscribeStatus => ({
  backend: true,
  placement: 'cpu',
  availability: 'available',
  model: { id: 'm', bytes: 650_000_000 },
  ...over,
});

const deps = (over: Partial<JobDeps> & { offer?: Offer } = {}): JobDeps & { saved: string[] } => {
  const saved: string[] = [];
  return {
    saved,
    status: async () => over.offer ?? { kind: 'ready' },
    download:
      over.download ??
      (async (progress) => {
        progress(5, 10);
        return true;
      }),
    run: over.run ?? (async () => ({ text: 'hi', language: 'en', engine: 'test' })),
    save: (r) => saved.push(r.text),
  };
};

export default async () => {
  await describe('decideOffer', async () => {
    await it('hides the feature without an engine, a model or room', async () => {
      expect(decideOffer(null).kind).toBe('hidden');
      expect(decideOffer(status({ backend: false })).kind).toBe('hidden');
      expect(decideOffer(status({ model: null })).kind).toBe('hidden');
      expect(decideOffer(status({ placement: 'none' })).kind).toBe('hidden');
      expect(decideOffer(status({ placement: 'unknown' })).kind).toBe('hidden');
      expect(decideOffer(status({ availability: 'unavailable' })).kind).toBe('hidden');
    });
    await it('offers it ready, or with the download size', async () => {
      expect(decideOffer(status({})).kind).toBe('ready');
      const offer = decideOffer(status({ availability: 'downloadable' }));
      expect(offer.kind).toBe('needs-download');
      expect(offer.kind === 'needs-download' ? offer.bytes : 0).toBe(650_000_000);
      expect(decideOffer(status({ availability: 'downloading' })).kind).toBe('busy');
    });
  });
  await describe('languageOf', async () => {
    await it('takes the first language of the locale, English otherwise', async () => {
      expect(languageOf({ LANG: 'de_DE.UTF-8' })).toBe('de');
      expect(languageOf({ LANGUAGE: 'fr:de', LANG: 'de_DE' })).toBe('fr');
      expect(languageOf({ LANG: 'C' })).toBe('en');
      expect(languageOf({})).toBe('en');
    });
  });
  await describe('transcribableIndex', async () => {
    await it('finds the first fetchable voice or audio part', async () => {
      const a = {
        filename: 'a.png',
        mimeType: 'image/png',
        kind: 'image',
        index: 0,
        fetchable: true,
        backendCanFetch: true,
      };
      const v = {
        filename: 'v.ogg',
        mimeType: 'audio/ogg',
        kind: 'voice',
        index: 1,
        fetchable: true,
        backendCanFetch: true,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(transcribableIndex([a, v] as any)).toBe(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(transcribableIndex([a, { ...v, fetchable: false }] as any)).toBe(null);
      expect(transcribableIndex(undefined)).toBe(null);
    });
  });
  await describe('createJob', async () => {
    await it('transcribes and saves when the model is there', async () => {
      const d = deps();
      const job = createJob(d);
      const seen: string[] = [];
      job.subscribe((s: JobState) => seen.push(s.kind));
      await job.request();
      expect(seen.join(',')).toBe('transcribing,done');
      expect(d.saved.join()).toBe('hi');
    });
    await it('asks before downloading and only then fetches', async () => {
      const d = deps({ offer: { kind: 'needs-download', bytes: 10 } });
      const job = createJob(d);
      await job.request();
      expect(job.state.kind).toBe('confirming');
      await job.confirm();
      expect(job.state.kind).toBe('done');
    });
    await it('fails with a code when the machine does not fit', async () => {
      const job = createJob(deps({ offer: { kind: 'hidden' } }));
      await job.request();
      expect(job.state.kind).toBe('failed');
    });
    await it('cancel aborts a running job and saves nothing', async () => {
      let release: () => void = () => {};
      const d = deps({
        run: (signal) =>
          new Promise((resolve) => {
            release = () => resolve({ text: 'late', language: null, engine: 'test' });
            signal.addEventListener('abort', release);
          }),
      });
      const job = createJob(d);
      const pending = job.request();
      await Promise.resolve();
      await Promise.resolve();
      job.cancel();
      await pending;
      expect(job.state.kind).toBe('idle');
      expect(d.saved.length).toBe(0);
    });
    await it('starts done from a cached transcript', async () => {
      const state = createJob(deps(), 'cached').state;
      expect(state.kind).toBe('done');
      expect(state.kind === 'done' ? state.text : '').toBe('cached');
    });
    await it('reports a failed run', async () => {
      const job = createJob(
        deps({
          run: async () => {
            throw new Error('boom');
          },
        }),
      );
      await job.request();
      const state = job.state;
      expect(state.kind).toBe('failed');
      expect(state.kind === 'failed' ? state.detail : '').toBe('boom');
    });
  });
  await describe('dictation helpers', async () => {
    await it('joins dictated text with one space', async () => {
      expect(dictationInsert('  hello ', 'abc')).toBe(' hello');
      expect(dictationInsert('hello', 'abc ')).toBe('hello');
      expect(dictationInsert('hello', '')).toBe('hello');
      expect(dictationInsert('   ', 'abc')).toBe('');
    });
    await it('cycles the button through its phases', async () => {
      expect(dictationPress('idle').action).toBe('start');
      expect(dictationPress('recording').action).toBe('stop');
      expect(dictationPress('transcribing').action).toBe('cancel');
    });
    await it('clamps the download fraction', async () => {
      expect(downloadFraction(5, 10)).toBe(0.5);
      expect(downloadFraction(5, 0)).toBe(0);
      expect(downloadFraction(50, 10)).toBe(1);
    });
  });
};
