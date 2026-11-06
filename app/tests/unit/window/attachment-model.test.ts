import { describe, expect, it } from '@gjsify/unit';

import {
  attachmentKind,
  boundedSize,
  effectiveMime,
  INLINE_IMAGE_MAX_BYTES,
  previewKey,
  showsInline,
  shownAttachments,
  tileAction,
} from '../../../src/window/attachment-model.ts';

const part = (
  over: Partial<{ filename: string | null; mimeType: string | null; section: string; size: number | null }>,
) => ({
  filename: 'photo.png',
  mimeType: 'image/png',
  section: '2',
  size: 1000,
  ...over,
});

export default async () => {
  await describe('attachmentKind', async () => {
    await it('classifies by MIME type', async () => {
      expect(attachmentKind({ filename: null, mimeType: 'image/jpeg' })).toBe('image');
      expect(attachmentKind({ filename: null, mimeType: 'IMAGE/PNG; name=x' })).toBe('image');
      expect(attachmentKind({ filename: null, mimeType: 'video/mp4' })).toBe('video');
      expect(attachmentKind({ filename: null, mimeType: 'audio/ogg' })).toBe('audio');
      expect(attachmentKind({ filename: null, mimeType: 'application/pdf' })).toBe('file');
    });

    await it('keeps vector images and unknown parts as files', async () => {
      expect(attachmentKind({ filename: 'logo.svg', mimeType: 'image/svg+xml' })).toBe('file');
      expect(attachmentKind({ filename: null, mimeType: null })).toBe('file');
    });

    await it('falls back to the extension for a generic type', async () => {
      expect(attachmentKind({ filename: 'IMG_1.JPG', mimeType: 'application/octet-stream' })).toBe('image');
      expect(attachmentKind({ filename: 'clip.webm', mimeType: null })).toBe('video');
      expect(attachmentKind({ filename: 'noext', mimeType: 'application/octet-stream' })).toBe('file');
      expect(effectiveMime({ filename: 'a.pdf', mimeType: 'application/pdf' })).toBe('application/pdf');
    });
  });

  await describe('showsInline', async () => {
    await it('shows a fetchable image of reasonable size', async () => {
      expect(showsInline(part({}))).toBe(true);
      expect(showsInline(part({ size: null }))).toBe(true);
    });

    await it('leaves huge images, other kinds and unfetchable parts to the tile', async () => {
      expect(showsInline(part({ size: INLINE_IMAGE_MAX_BYTES + 1 }))).toBe(false);
      expect(showsInline(part({ mimeType: 'application/pdf', filename: 'a.pdf' }))).toBe(false);
      expect(showsInline({ filename: 'x.png', mimeType: 'image/png' })).toBe(false);
    });
  });

  await describe('tileAction', async () => {
    await it('plays video in the viewer and hands the rest to the desktop', async () => {
      expect(tileAction('video')).toBe('view');
      expect(tileAction('file')).toBe('open');
      expect(tileAction('audio')).toBe('open');
    });
  });

  await describe('boundedSize', async () => {
    await it('never scales up', async () => {
      expect(boundedSize({ width: 100, height: 50 })).toStrictEqual({ width: 100, height: 50 });
    });

    await it('bounds the height and keeps the ratio', async () => {
      expect(boundedSize({ width: 600, height: 600 })).toStrictEqual({ width: 300, height: 300 });
      expect(boundedSize({ width: 1000, height: 100 }, 400, 300)).toStrictEqual({ width: 400, height: 40 });
    });

    await it('never collapses to zero and falls back for a bad size', async () => {
      expect(boundedSize({ width: 100000, height: 1 }, 400, 300).height).toBe(1);
      expect(boundedSize({ width: 0, height: 0 })).toStrictEqual({ width: 420, height: 150 });
    });
  });

  await describe('shownAttachments', async () => {
    await it('skips parts without a section and reports the surplus', async () => {
      const parts = [part({ section: '1' }), { filename: 'x', mimeType: null }, part({ section: '3' })];
      const { shown, more } = shownAttachments(parts, 1);
      expect(shown.map((p) => p.section)).toStrictEqual(['1']);
      expect(more).toBe(1);
      expect(shownAttachments(undefined)).toStrictEqual({ shown: [], more: 0 });
    });
  });

  await describe('previewKey', async () => {
    await it('tells parts of different messages apart', async () => {
      const ref = { accountId: 'a@example.org', folder: 'INBOX', uid: 7 };
      expect(previewKey(ref, '2')).toBe(previewKey({ ...ref }, '2'));
      expect(previewKey(ref, '2') === previewKey(ref, '3')).toBe(false);
      expect(previewKey(ref, '2') === previewKey({ ...ref, uid: 8 }, '2')).toBe(false);
      expect(
        previewKey({ accountId: 'ab', folder: 'c' }, '1') ===
          previewKey({ accountId: 'a', folder: 'bc' }, '1'),
      ).toBe(false);
    });
  });
};
