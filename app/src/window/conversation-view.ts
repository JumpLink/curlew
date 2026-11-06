/** The conversation pane: mail and messenger history as bubbles, with a small chat composer. */

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';
import { _, fmt } from '@curlew/protocol';
import type { ConversationMessage } from '@curlew/protocol';
import type { MessageCursor } from '@curlew/store';

import type { ListEntry } from './conversation-list-model.ts';
import { initials, protocolLabel, shortTime } from './conversation-list-model.ts';
import {
  bubbleText,
  cursorOf,
  dayOf,
  dayStarts,
  newOlder,
  PAGE_SIZE,
  senderRunStarts,
  subjectLabels,
} from './conversation-model.ts';
import { fadedOverlay } from './fade-bin.ts';

export interface ConversationView {
  page: Adw.NavigationPage;
  show(entry: ListEntry, messages: ConversationMessage[]): void;
}

const ROWS_PER_TURN = 8;

/** What is built for one message, kept so a later page can correct its day separator and subject. */
interface Built {
  row: Gtk.ListBoxRow;
  bubble: Gtk.Box;
  separator: Gtk.ListBoxRow | null;
  subject: Gtk.Label | null;
  sender: Gtk.Box | null;
}

export function createConversationView(
  onSend: (text: string) => Promise<ConversationMessage>,
  loadOlder: (entry: ListEntry, oldest: MessageCursor) => ConversationMessage[],
): ConversationView {
  let entry: ListEntry | null = null;
  // The array is the caller's: a sent message is pushed onto it, an older page spliced in front.
  let messages: ConversationMessage[] = [];
  let sending = false;
  let generation = 0;
  const built = new Map<string, Built>();
  // Paging state. `ready` is false until the first page is built and scrolled to the end;
  // `prepending` is true from the spinner until the older rows have been laid out.
  let ready = false;
  let exhausted = false;
  let loading = false;
  let prepending = false;
  let lastUpper = 0;
  let spinner: Gtk.ListBoxRow | null = null;

  const title = new Adw.WindowTitle({ title: _('Curlew') });
  const header = new Adw.HeaderBar();
  header.set_title_widget(title);
  const history = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE });
  history.add_css_class('navigation-sidebar');
  const scroller = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true });
  scroller.set_child(history);

  const composer = new Gtk.Box({ spacing: 6, marginStart: 12, marginEnd: 12, marginTop: 8, marginBottom: 8 });
  const input = new Gtk.Entry({ placeholderText: _('Write a message'), hexpand: true });
  const send = new Gtk.Button({ iconName: 'mail-send-symbolic', tooltipText: _('Send message') });
  send.add_css_class('suggested-action');
  send.add_css_class('circular');
  composer.append(input);
  composer.append(send);

  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  content.append(scroller);
  content.append(composer);
  const overlay = new Adw.ToastOverlay({ child: content });
  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(header);
  toolbar.set_content(overlay);
  const page = new Adw.NavigationPage({ title: _('Conversation'), tag: 'content' });
  page.set_child(toolbar);

  const adjustment = scroller.get_vadjustment();

  const scrollToEnd = () => {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      adjustment.set_value(adjustment.get_upper());
      return GLib.SOURCE_REMOVE;
    });
  };

  // Runs `done` once GTK has laid out what was just added: the frame clock ticks before it lays
  // out, so the second tick is the first one that sees the new `upper`.
  const afterLayout = (run: number, done: () => void) => {
    let ticks = 0;
    scroller.add_tick_callback(() => {
      if (run !== generation) return GLib.SOURCE_REMOVE;
      if (++ticks < 2) return GLib.SOURCE_CONTINUE;
      done();
      return GLib.SOURCE_REMOVE;
    });
  };

  const daySeparator = (day: string): Gtk.ListBoxRow => {
    const label = new Gtk.Label({ label: day, xalign: 0.5, marginTop: 12, marginBottom: 6 });
    label.add_css_class('dim-label');
    label.add_css_class('caption');
    const row = new Gtk.ListBoxRow({ selectable: false, activatable: false });
    row.set_child(label);
    return row;
  };

  const subjectHeading = (subject: string): Gtk.Label => {
    const label = new Gtk.Label({ label: subject, xalign: 0, wrap: true });
    label.add_css_class('heading');
    return label;
  };

  // Who wrote the run of bubbles it opens: a small avatar with initials, like the list, and the name.
  const senderHeading = (name: string): Gtk.Box => {
    const box = new Gtk.Box({ spacing: 6 });
    box.append(new Adw.Avatar({ size: 20, text: name, showInitials: initials(name) !== '' }));
    const label = new Gtk.Label({ label: name, xalign: 0, ellipsize: Pango.EllipsizeMode.END });
    label.add_css_class('caption-heading');
    box.append(label);
    return box;
  };

  // Builds the rows of one message; `position` is where the first goes in the list, -1 for the end.
  const addRow = (
    message: ConversationMessage,
    subject: string | undefined,
    sender: string | undefined,
    startsDay: boolean,
    position: number,
  ) => {
    const card = new Gtk.Box();
    card.add_css_class('card');
    const bubble = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 4,
      marginStart: 12,
      marginEnd: 12,
      marginTop: 8,
      marginBottom: 8,
    });
    card.append(bubble);
    const senderBox = sender !== undefined ? senderHeading(sender) : null;
    if (senderBox) bubble.append(senderBox);
    const heading = subject ? subjectHeading(subject) : null;
    if (heading) bubble.append(heading);
    const full = (message.bodyText?.trim() || message.notice || _('No text body')) + (message.bodyTruncated ? ' …' : '');
    const preview = bubbleText(full);
    const body = new Gtk.Label({
      label: preview.clipped ? `${preview.text} …` : preview.text,
      xalign: 0,
      wrap: true,
      // A long URL has no word break and would widen the bubble past the window.
      wrapMode: Pango.WrapMode.WORD_CHAR,
      selectable: true,
      maxWidthChars: 56,
    });
    bubble.append(fadedOverlay(body, preview.clipped, () => body.set_label(full)));
    if (message.hasAttachments) {
      const attachments = new Gtk.Label({ label: _('Contains attachments'), xalign: 0 });
      attachments.add_css_class('caption');
      attachments.add_css_class('dim-label');
      bubble.append(attachments);
    }
    const time = new Gtk.Label({ label: shortTime(message.sentAt), xalign: 1 });
    time.add_css_class('caption');
    time.add_css_class('dim-label');
    bubble.append(time);

    const row = new Gtk.ListBoxRow({
      selectable: false,
      activatable: false,
      marginStart: 12,
      marginEnd: 12,
      marginTop: 3,
      marginBottom: 3,
    });
    row.set_child(card);
    row.set_halign(message.fromSelf ? Gtk.Align.END : Gtk.Align.START);
    const separator = startsDay ? daySeparator(dayOf(message)) : null;
    // The separator goes above its message: before it when appending, after it when both are put
    // in front at the same index.
    if (position === -1) {
      if (separator) history.insert(separator, -1);
      history.insert(row, -1);
    } else {
      history.insert(row, position);
      if (separator) history.insert(separator, position);
    }
    built.set(message.id, { row, bubble, separator, subject: heading, sender: senderBox });
  };

  // After a page went in front, its newest neighbour may no longer open a day or a topic.
  const reconcile = (
    message: ConversationMessage,
    subject: string | undefined,
    sender: string | undefined,
    startsDay: boolean,
  ) => {
    const one = built.get(message.id);
    if (!one) return;
    if (one.separator && !startsDay) {
      history.remove(one.separator);
      one.separator = null;
    } else if (!one.separator && startsDay) {
      one.separator = daySeparator(dayOf(message));
      history.insert(one.separator, one.row.get_index());
    }
    if (one.sender && sender === undefined) {
      one.bubble.remove(one.sender);
      one.sender = null;
    } else if (!one.sender && sender !== undefined) {
      one.sender = senderHeading(sender);
      one.bubble.prepend(one.sender);
    }
    if (one.subject && !subject) {
      one.bubble.remove(one.subject);
      one.subject = null;
    } else if (!one.subject && subject) {
      one.subject = subjectHeading(subject);
      one.bubble.prepend(one.subject);
    }
  };

  const nearTop = () => adjustment.get_value() < adjustment.get_page_size() * 2;

  const loadPage = () => {
    const shownEntry = entry;
    const oldest = messages[0];
    if (!shownEntry || !oldest || !ready || exhausted || loading) return;
    loading = true;
    prepending = true;
    lastUpper = adjustment.get_upper();
    const spin = new Gtk.ListBoxRow({ selectable: false, activatable: false });
    spin.set_child(new Adw.Spinner({ halign: Gtk.Align.CENTER, widthRequest: 32, heightRequest: 32, marginTop: 12, marginBottom: 12 }));
    spinner = spin;
    history.insert(spin, 0);
    const run = generation;

    const finish = () => {
      if (spinner) history.remove(spinner);
      spinner = null;
      loading = false;
      afterLayout(run, () => {
        prepending = false;
        if (nearTop()) loadPage();
      });
    };

    // The spinner gets a frame before the read blocks the loop.
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (run !== generation) return GLib.SOURCE_REMOVE;
      let fresh: ConversationMessage[];
      try {
        const page = loadOlder(shownEntry, cursorOf(oldest));
        exhausted = page.length < PAGE_SIZE;
        fresh = newOlder(messages, page);
      } catch (err) {
        // Not retried until the conversation is opened again, or it would loop on every scroll.
        exhausted = true;
        overlay.add_toast(
          new Adw.Toast({
            title: fmt(_('Could not load older messages: {error}'), {
              error: err instanceof Error ? err.message : String(err),
            }),
            timeout: 6,
          }),
        );
        finish();
        return GLib.SOURCE_REMOVE;
      }
      if (fresh.length === 0) {
        finish();
        return GLib.SOURCE_REMOVE;
      }
      const joinedAt = fresh.length;
      messages.splice(0, 0, ...fresh);
      const subjects = subjectLabels(messages);
      const starts = dayStarts(messages);
      const senders = senderRunStarts(messages, shownEntry.kind === 'group');
      let next = joinedAt - 1;
      // Newest of the page first, each above the one before, so the rows grow upward from the
      // spinner and the person's place below them is the one that has to hold still.
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (run !== generation) return GLib.SOURCE_REMOVE;
        const stop = Math.max(next - ROWS_PER_TURN, -1);
        for (; next > stop; next--) {
          const message = messages[next]!;
          addRow(message, subjects.get(message.id), senders.get(message.id), starts.has(message.id), 1);
        }
        if (next >= 0) return GLib.SOURCE_CONTINUE;
        const joined = messages[joinedAt]!;
        reconcile(joined, subjects.get(joined.id), senders.get(joined.id), starts.has(joined.id));
        finish();
        return GLib.SOURCE_REMOVE;
      });
      return GLib.SOURCE_REMOVE;
    });
  };

  // What came in front pushed the rows the person was reading down by the growth of `upper`.
  adjustment.connect('notify::upper', () => {
    if (prepending) {
      const upper = adjustment.get_upper();
      const grown = upper - lastUpper;
      lastUpper = upper;
      if (grown !== 0) adjustment.set_value(adjustment.get_value() + grown);
    }
    if (ready && nearTop()) loadPage();
  });
  adjustment.connect('value-changed', () => {
    if (ready && nearTop()) loadPage();
  });

  const submit = () => {
    const text = input.get_text().trim();
    if (!text || sending || !entry) return;
    sending = true;
    input.set_sensitive(false);
    send.set_sensitive(false);
    void onSend(text)
      .then((message) => {
        const previousDay = dayOf(messages[messages.length - 1] ?? message);
        messages.push(message);
        const day = dayOf(message);
        // The person's own message starts no sender run, and the next one from another starts its own.
        addRow(message, undefined, undefined, day !== '' && day !== previousDay, -1);
        input.set_text('');
        scrollToEnd();
      })
      .catch((err: unknown) => {
        overlay.add_toast(
          new Adw.Toast({
            title: fmt(_('Message not sent: {error}'), { error: err instanceof Error ? err.message : String(err) }),
            timeout: 6,
          }),
        );
      })
      .finally(() => {
        sending = false;
        input.set_sensitive(true);
        send.set_sensitive(true);
        input.grab_focus();
      });
  };
  send.connect('clicked', submit);
  input.connect('activate', submit);

  return {
    page,
    show(nextEntry, nextMessages) {
      entry = nextEntry;
      messages = nextMessages;
      title.set_title(nextEntry.title);
      title.set_subtitle(protocolLabel(nextEntry.backend));
      history.remove_all();
      built.clear();
      composer.set_visible(nextEntry.target !== null);
      input.set_text('');
      const subjects = subjectLabels(messages);
      const starts = dayStarts(messages);
      const senders = senderRunStarts(messages, nextEntry.kind === 'group');
      const shown = [...messages];
      const run = ++generation;
      // A newer show() ends every older build and page load; their callbacks see the new generation.
      ready = false;
      exhausted = shown.length < PAGE_SIZE;
      loading = false;
      prepending = false;
      spinner = null;
      let next = 0;
      // A few rows per main-loop turn, so the window keeps repainting and answering while a long
      // history is built; the first page alone is scrolled to the end.
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (run !== generation) return GLib.SOURCE_REMOVE;
        const stop = Math.min(next + ROWS_PER_TURN, shown.length);
        for (; next < stop; next++) {
          const message = shown[next]!;
          addRow(message, subjects.get(message.id), senders.get(message.id), starts.has(message.id), -1);
        }
        scrollToEnd();
        if (next < shown.length) return GLib.SOURCE_CONTINUE;
        afterLayout(run, () => {
          adjustment.set_value(adjustment.get_upper());
          ready = true;
          if (nearTop()) loadPage();
        });
        return GLib.SOURCE_REMOVE;
      });
    },
  };
}
