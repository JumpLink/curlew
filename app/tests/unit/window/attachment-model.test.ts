import { describe, expect, it } from '@gjsify/unit';
import type { AttachmentKind } from '../../../src/window/attachment-model.ts';

import {
  attachmentKind,
  AUTO_FETCH_VIDEO_MAX_BYTES,
  boundedSize,
  durationLabel,
  effectiveMime,
  INLINE_IMAGE_MAX_BYTES,
  isGridMedia,
  isOpenable,
  playbackFraction,
  playbackLabel,
  previewKey,
  shouldAutoFetch,
  showsInline,
  showsPlayer,
  showsPoster,
  shownAttachments,
  tileAction,
} from '../../../src/window/attachment-model.ts';

const part = (
  over: Partial<{
    filename: string | null;
    mimeType: string | null;
    section: string;
    size: number | null;
    kind: AttachmentKind;
  }>,
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
      expect(attachmentKind({ filename: null, mimeType: 'audio/mpeg' })).toBe('audio');
      expect(attachmentKind({ filename: null, mimeType: 'application/pdf' })).toBe('file');
    });

    await it('keeps vector images and unknown parts as files', async () => {
      expect(attachmentKind({ filename: 'logo.svg', mimeType: 'image/svg+xml' })).toBe('file');
      expect(attachmentKind({ filename: null, mimeType: null })).toBe('file');
    });

    await it('falls back to the extension for a generic type', async () => {
      expect(attachmentKind({ filename: 'IMG_1.JPG', mimeType: 'application/octet-stream' })).toBe('image');
      expect(attachmentKind({ filename: 'clip.webm', mimeType: null })).toBe('video');
      expect(attachmentKind({ filename: 'note.opus', mimeType: 'application/octet-stream' })).toBe('audio');
      expect(attachmentKind({ filename: 'noext', mimeType: 'application/octet-stream' })).toBe('file');
      expect(effectiveMime({ filename: 'a.pdf', mimeType: 'application/pdf' })).toBe('application/pdf');
    });

    await it('trusts an explicit kind from the backend', async () => {
      expect(attachmentKind({ filename: 'x.bin', mimeType: 'application/octet-stream', kind: 'video' })).toBe(
        'video',
      );
      expect(attachmentKind({ filename: 'x.bin', mimeType: 'application/octet-stream', kind: 'voice' })).toBe(
        'voice',
      );
    });
  });

  await describe('isOpenable', async () => {
    await it('is true only for mail parts with a section today', async () => {
      expect(isOpenable(part({}))).toBe(true);
      expect(isOpenable(part({ section: '' }))).toBe(false);
      expect(isOpenable({ filename: 'x.png', mimeType: 'image/png', index: 0 })).toBe(false);
    });

    await it('opens a chat part only when it is fetchable and its backend can fetch', async () => {
      const chat = { filename: 'x.png', mimeType: 'image/png', index: 0, size: 1000 };
      expect(isOpenable({ ...chat, fetchable: true, backendCanFetch: true })).toBe(true);
      expect(isOpenable({ ...chat, fetchable: true, backendCanFetch: false })).toBe(false);
      expect(isOpenable({ ...chat, fetchable: false, backendCanFetch: true })).toBe(false);
      expect(isOpenable({ ...chat, fetchable: true })).toBe(false);
    });
  });

  await describe('shouldAutoFetch', async () => {
    await it('fetches only small openable images', async () => {
      const chat = {
        filename: 'x.png',
        mimeType: 'image/png',
        index: 0,
        fetchable: true,
        backendCanFetch: true,
      };
      expect(shouldAutoFetch({ ...chat, size: 1_000_000 })).toBe(true);
      expect(shouldAutoFetch({ ...chat, size: 3_000_000 })).toBe(false);
      expect(shouldAutoFetch({ ...chat, size: null })).toBe(false);
      expect(shouldAutoFetch({ ...chat, size: 1000, backendCanFetch: false })).toBe(false);
      expect(shouldAutoFetch({ ...chat, size: 1000, mimeType: 'application/pdf', filename: 'a.pdf' })).toBe(
        false,
      );
    });
  });

  await describe('showsInline', async () => {
    await it('shows a fetchable image of reasonable size', async () => {
      expect(showsInline(part({}))).toBe(true);
      expect(showsInline(part({ size: null }))).toBe(true);
    });

    await it('shows a chat image inline only when small enough to fetch unasked', async () => {
      const chat = {
        filename: 'x.png',
        mimeType: 'image/png',
        index: 0,
        fetchable: true,
        backendCanFetch: true,
      };
      expect(showsInline({ ...chat, size: 1_000_000 })).toBe(true);
      expect(showsInline({ ...chat, size: 5_000_000 })).toBe(false);
      expect(showsInline({ ...chat, size: null })).toBe(false);
    });

    await it('leaves huge images, other kinds and unfetchable parts to the tile', async () => {
      expect(showsInline(part({ size: INLINE_IMAGE_MAX_BYTES + 1 }))).toBe(false);
      expect(showsInline(part({ mimeType: 'application/pdf', filename: 'a.pdf' }))).toBe(false);
      expect(showsInline({ filename: 'x.png', mimeType: 'image/png' })).toBe(false);
    });
  });

  await describe('showsPoster', async () => {
    const clip = {
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      index: 0,
      fetchable: true,
      backendCanFetch: true,
    };

    await it('shows the first frame of a small chat video', async () => {
      expect(showsPoster({ ...clip, size: 1_000_000 })).toBe(true);
      expect(showsPoster({ ...clip, size: AUTO_FETCH_VIDEO_MAX_BYTES })).toBe(true);
    });

    await it('keeps the tile for big, unsized, unfetchable and non-video parts', async () => {
      expect(showsPoster({ ...clip, size: AUTO_FETCH_VIDEO_MAX_BYTES + 1 })).toBe(false);
      expect(showsPoster({ ...clip, size: null })).toBe(false);
      expect(showsPoster({ ...clip, size: 1000, fetchable: false })).toBe(false);
      expect(showsPoster({ ...clip, size: 1000, mimeType: 'image/png', filename: 'a.png' })).toBe(false);
    });

    await it('never fetches a mail video unasked', async () => {
      expect(showsPoster({ filename: 'clip.mp4', mimeType: 'video/mp4', section: '2', size: 1000 })).toBe(
        false,
      );
    });
  });

  await describe('durationLabel', async () => {
    await it('writes minutes and seconds, hours only when needed', async () => {
      expect(durationLabel(18_000)).toBe('0:18');
      expect(durationLabel(61_400)).toBe('1:01');
      expect(durationLabel(3_725_000)).toBe('1:02:05');
    });

    await it('is empty without a usable length', async () => {
      expect(durationLabel(null)).toBe('');
      expect(durationLabel(undefined)).toBe('');
      expect(durationLabel(0)).toBe('');
      expect(durationLabel(Number.NaN)).toBe('');
    });
  });

  await describe('isGridMedia', async () => {
    await it('takes openable pictures and videos only', async () => {
      expect(isGridMedia(part({}))).toBe(true);
      expect(isGridMedia(part({ mimeType: 'video/mp4', filename: 'a.mp4' }))).toBe(true);
      expect(isGridMedia(part({ mimeType: 'application/pdf', filename: 'a.pdf' }))).toBe(false);
      expect(isGridMedia({ filename: 'x.png', mimeType: 'image/png' })).toBe(false);
    });
  });

  await describe('tileAction', async () => {
    await it('plays video in the viewer and hands the rest to the desktop', async () => {
      expect(tileAction('video')).toBe('view');
      expect(tileAction('file')).toBe('open');
      expect(tileAction('audio')).toBe('open');
      expect(tileAction('voice')).toBe('open');
    });
  });

  await describe('boundedSize', async () => {
    await it('never scales up', async () => {
      expect(boundedSize({ width: 100, height: 50 })).toStrictEqual({ width: 100, height: 50 });
    });

    await it('bounds the box and keeps the ratio', async () => {
      expect(boundedSize({ width: 600, height: 600 })).toStrictEqual({ width: 280, height: 280 });
      expect(boundedSize({ width: 1000, height: 100 }, 400, 300)).toStrictEqual({ width: 400, height: 40 });
    });

    await it('never collapses to zero and falls back for a bad size', async () => {
      expect(boundedSize({ width: 100000, height: 1 }, 400, 300).height).toBe(1);
      expect(boundedSize({ width: 0, height: 0 })).toStrictEqual({ width: 280, height: 150 });
    });
  });

  await describe('shownAttachments', async () => {
    await it('skips parts without a section or index and reports the surplus', async () => {
      const parts = [part({ section: '1' }), { filename: 'x', mimeType: null }, part({ section: '3' })];
      const { shown, more } = shownAttachments(parts, 1);
      expect(shown.map((p) => p.section)).toStrictEqual(['1']);
      expect(more).toBe(1);
      expect(shownAttachments(undefined)).toStrictEqual({ shown: [], more: 0 });
    });

    await it('skips a mail part with an empty section even when it has an index', async () => {
      const { shown } = shownAttachments([{ filename: 'x', mimeType: null, section: '', index: 0 }]);
      expect(shown).toStrictEqual([]);
    });

    await it('includes chat attachments that only have an index', async () => {
      const parts = [
        { filename: 'x.png', mimeType: 'image/png', index: 0 },
        { filename: 'y.pdf', mimeType: 'application/pdf', index: 1 },
      ];
      const { shown, more } = shownAttachments(parts);
      expect(shown).toStrictEqual(parts);
      expect(more).toBe(0);
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

    await it('uses the index for chat attachments without a section', async () => {
      const ref = { accountId: 'telegram-1', remoteId: 'msg-42' };
      expect(previewKey(ref, '', 0)).toBe(previewKey({ ...ref }, '', 0));
      expect(previewKey(ref, '', 0) === previewKey(ref, '', 1)).toBe(false);
      expect(previewKey(ref, '', 0) === previewKey({ ...ref, remoteId: 'msg-43' }, '', 0)).toBe(false);
    });
  });
  await describe('the player', async () => {
    await it('shows a player for fetchable voice notes and audio, not for other parts', async () => {
      const chat = { section: '', fetchable: true, backendCanFetch: true } as const;
      expect(showsPlayer(part({ kind: 'voice', ...chat }) as never)).toBe(true);
      expect(showsPlayer(part({ filename: 'song.mp3', mimeType: 'audio/mpeg', ...chat }) as never)).toBe(
        true,
      );
      expect(showsPlayer(part({ kind: 'voice', section: '' }) as never)).toBe(false);
      expect(showsPlayer(part({ kind: 'video', ...chat }) as never)).toBe(false);
    });

    await it('writes position and length', async () => {
      expect(playbackLabel(7_000, 31_000)).toBe('0:07 / 0:31');
      expect(playbackLabel(0, 31_000)).toBe('0:00 / 0:31');
      expect(playbackLabel(7_000, null)).toBe('0:07');
    });

    await it('keeps the seek fraction between 0 and 1', async () => {
      expect(playbackFraction(15_000, 30_000)).toBe(0.5);
      expect(playbackFraction(40_000, 30_000)).toBe(1);
      expect(playbackFraction(-5, 30_000)).toBe(0);
      expect(playbackFraction(5_000, null)).toBe(0);
      expect(playbackFraction(5_000, 0)).toBe(0);
    });
  });
};
