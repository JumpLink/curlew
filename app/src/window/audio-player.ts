/** A voice note or audio part in a bubble: play/pause, a seek bar and the time, fetched on the first press. */

import GLib from 'gi://GLib?version=2.0';
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { _, fmt } from '@curlew/protocol';

import { attachmentKind, playbackFraction, playbackLabel } from './attachment-model.ts';
import { type AttachmentSource, failureText, fetchAttachment, saveCopyAs } from './attachment-store.ts';
import { attachmentLine } from './conversation-model.ts';

/** Only one part plays at a time: starting another one pauses this. */
let current: { pause(): void } | null = null;

const MICROSECONDS = 1000;

export function audioPlayer(source: AttachmentSource, toast: (text: string) => void): Gtk.Widget {
  const { info } = source;
  const name = info.filename ?? attachmentLine(info);
  const voice = attachmentKind(info) === 'voice';
  // The card is the surface; the controls sit inside it with their own padding, not against its edge.
  const box = new Gtk.Box({ marginStart: 8, marginEnd: 8, marginTop: 8, marginBottom: 8 });
  box.add_css_class('card');
  box.set_tooltip_text(name);
  const content = new Gtk.Box({
    spacing: 10,
    hexpand: true,
    marginStart: 10,
    marginEnd: 8,
    marginTop: 8,
    marginBottom: 8,
  });
  box.append(content);

  const play = new Gtk.Button({ iconName: 'media-playback-start-symbolic', valign: Gtk.Align.CENTER });
  play.add_css_class('circular');
  play.add_css_class('suggested-action');
  const playLabel = voice ? _('Play voice message') : fmt(_('Play {name}'), { name });
  play.set_tooltip_text(playLabel);
  play.update_property([Gtk.AccessibleProperty.LABEL], [playLabel]);
  content.append(play);

  const middle = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    hexpand: true,
    valign: Gtk.Align.CENTER,
  });
  const seek = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL,
    adjustment: new Gtk.Adjustment({ lower: 0, upper: 1, stepIncrement: 0.05, pageIncrement: 0.1 }),
    drawValue: false,
    hexpand: true,
    widthRequest: 140,
    sensitive: false,
  });
  seek.update_property([Gtk.AccessibleProperty.LABEL], [_('Position')]);
  middle.append(seek);
  const time = new Gtk.Label({ label: playbackLabel(0, info.durationMs), xalign: 0 });
  time.add_css_class('caption');
  time.add_css_class('dim-label');
  time.add_css_class('numeric');
  middle.append(time);
  content.append(middle);

  const save = new Gtk.Button({
    iconName: 'document-save-symbolic',
    tooltipText: _('Save as…'),
    valign: Gtk.Align.CENTER,
  });
  save.add_css_class('flat');
  save.add_css_class('circular');
  content.append(save);

  let media: Gtk.MediaFile | null = null;
  let fetching = false;
  let path: string | null = null;
  const handle = {
    pause: () => media?.pause(),
  };

  const totalMs = (): number | null => {
    const fromMedia = media && media.duration > 0 ? Math.round(media.duration / MICROSECONDS) : null;
    return fromMedia ?? info.durationMs ?? null;
  };
  // `change-value` is the person's own movement, so moving the bar from here never seeks.
  const show = () => {
    if (!media) return;
    const position = Math.round(media.timestamp / MICROSECONDS);
    const total = totalMs();
    time.set_label(playbackLabel(position, total));
    seek.set_value(playbackFraction(position, total));
  };
  const showState = () => {
    const playing = media?.playing === true;
    play.set_icon_name(playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic');
    const label = playing ? _('Pause') : playLabel;
    play.set_tooltip_text(label);
    play.update_property([Gtk.AccessibleProperty.LABEL], [label]);
    if (playing) current = handle;
    else if (current === handle) current = null;
  };

  const open = async (): Promise<Gtk.MediaFile> => {
    path ??= await fetchAttachment(source);
    const file = Gtk.MediaFile.new_for_filename(path);
    file.connect('notify::timestamp', show);
    file.connect('notify::duration', show);
    file.connect('notify::playing', showState);
    file.connect('notify::ended', () => {
      if (!file.ended) return;
      // Back to the start, ready to play again.
      file.seek(0);
      show();
    });
    file.connect('notify::error', () => {
      const err = file.get_error();
      if (err) toast(fmt(_('Could not play the attachment: {error}'), { error: err.message }));
    });
    return file;
  };

  play.connect('clicked', () => {
    if (media) {
      if (media.playing) media.pause();
      else {
        if (current && current !== handle) current.pause();
        media.play();
      }
      return;
    }
    if (fetching) return;
    fetching = true;
    play.set_sensitive(false);
    void open()
      .then((file) => {
        // The bubble left the window while the part was fetched.
        if (box.get_root() === null) return;
        media = file;
        seek.set_sensitive(true);
        if (current && current !== handle) current.pause();
        file.play();
      })
      .catch((err: unknown) =>
        toast(fmt(_('Could not fetch the attachment: {error}'), { error: failureText(err) })),
      )
      .finally(() => {
        fetching = false;
        play.set_sensitive(true);
      });
  });

  seek.connect('change-value', (_scale, _scroll, value) => {
    const total = totalMs();
    if (!media || !total) return false;
    media.seek(Math.round(Math.min(1, Math.max(0, value)) * total * MICROSECONDS));
    return false;
  });

  // A bubble that leaves the window must not keep playing, or hold the file open.
  box.connect('unrealize', () => {
    media?.pause();
    if (current === handle) current = null;
  });

  save.connect('clicked', () => {
    save.set_sensitive(false);
    const window = save.get_root() as Gtk.Window | null;
    void fetchAttachment(source)
      .then((file) => saveCopyAs(window, file, GLib.path_get_basename(file)))
      .catch((err: unknown) =>
        toast(fmt(_('Could not fetch the attachment: {error}'), { error: failureText(err) })),
      )
      .finally(() => {
        if (save.get_root() !== null) save.set_sensitive(true);
      });
  });

  // A voice note is short: it stops at a width that reads as a player, not as a wide download bar.
  return new Adw.Clamp({ maximumSize: 300, tighteningThreshold: 300, child: box, halign: Gtk.Align.START });
}
