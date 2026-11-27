/** The widgets of local transcription: the consent dialog for the model download and the transcript under a bubble. */

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';
import { _, fmt } from '@curlew/protocol';

import { downloadFraction, failureMessage, type Job, type JobState } from './transcribe-model.ts';

/** Asks before the model is downloaded, with its size: nothing is fetched without a yes. */
export function askDownload(parent: Gtk.Widget, bytes: number, answer: (yes: boolean) => void): void {
  const size = GLib.format_size(bytes);
  const dialog = new Adw.AlertDialog({
    heading: _('Download the speech model?'),
    body: fmt(
      _(
        'Transcribing needs a speech model of {size}. It is downloaded once and kept on this computer; the audio never leaves it.',
      ),
      { size },
    ),
  });
  dialog.add_response('cancel', _('Cancel'));
  dialog.add_response('download', fmt(_('Download {size}'), { size }));
  dialog.set_response_appearance('download', Adw.ResponseAppearance.SUGGESTED);
  dialog.set_default_response('cancel');
  dialog.set_close_response('cancel');
  dialog.connect('response', (_dialog: Adw.AlertDialog, response: string) => answer(response === 'download'));
  dialog.present(parent);
}

/** The transcript of one voice note: progress and a cancel button while it runs, the text in an expander after. */
export function transcriptBlock(job: Job): Gtk.Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, visible: false });

  const spinner = new Gtk.Spinner({ spinning: true, valign: Gtk.Align.CENTER });
  const status = new Gtk.Label({
    xalign: 0,
    hexpand: true,
    wrap: true,
    wrapMode: Pango.WrapMode.WORD_CHAR,
    maxWidthChars: 40,
  });
  status.add_css_class('caption');
  const cancel = new Gtk.Button({
    iconName: 'process-stop-symbolic',
    tooltipText: _('Cancel transcribing'),
    valign: Gtk.Align.CENTER,
  });
  cancel.add_css_class('flat');
  cancel.add_css_class('circular');
  cancel.update_property([Gtk.AccessibleProperty.LABEL], [_('Cancel transcribing')]);
  cancel.connect('clicked', () => job.cancel());
  const row = new Gtk.Box({ spacing: 6 });
  for (const part of [spinner, status, cancel]) row.append(part);
  const progress = new Gtk.ProgressBar({ visible: false });
  progress.update_property([Gtk.AccessibleProperty.LABEL], [_('Speech model download')]);

  const text = new Gtk.Label({
    xalign: 0,
    wrap: true,
    wrapMode: Pango.WrapMode.WORD_CHAR,
    selectable: true,
    maxWidthChars: 56,
  });
  const expander = new Gtk.Expander({ label: _('Transcript'), child: text, visible: false });
  box.append(row);
  box.append(progress);
  box.append(expander);

  let asked = false;
  const render = (state: JobState, fresh: boolean): void => {
    box.set_visible(state.kind !== 'idle');
    const busy = state.kind === 'confirming' || state.kind === 'downloading' || state.kind === 'transcribing';
    row.set_visible(busy || state.kind === 'failed');
    spinner.set_visible(busy);
    cancel.set_visible(busy);
    progress.set_visible(state.kind === 'downloading');
    expander.set_visible(state.kind === 'done');
    switch (state.kind) {
      case 'confirming':
        status.set_label(_('Waiting for your answer'));
        if (!asked) {
          asked = true;
          askDownload(box, state.bytes, (yes) => {
            asked = false;
            if (yes) void job.confirm();
            else job.cancel();
          });
        }
        break;
      case 'downloading': {
        const fraction = downloadFraction(state.received, state.total);
        progress.set_fraction(fraction);
        status.set_label(
          fmt(_('Downloading the speech model… {percent}%'), { percent: Math.round(fraction * 100) }),
        );
        break;
      }
      case 'transcribing':
        status.set_label(_('Transcribing…'));
        break;
      case 'failed':
        status.set_label(failureMessage(state));
        break;
      case 'done':
        text.set_label(state.text === '' ? _('No speech found') : state.text);
        expander.set_expanded(fresh);
        break;
      default:
        break;
    }
  };
  render(job.state, false);
  const off = job.subscribe((state) => render(state, true));
  box.connect('destroy', off);
  return box;
}
