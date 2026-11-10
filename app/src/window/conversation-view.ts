/** The conversation pane: mail and messenger history as bubbles, with a small chat composer. */

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';
import { _, fmt } from '@curlew/protocol';
import type { ConversationMessage } from '@curlew/protocol';
import type { MessageCursor } from '@curlew/store';

import type { ListEntry } from './conversation-list-model.ts';
import {
  canSend,
  composerBlock,
  entryProtocolSubtitle,
  initials,
  protocolChoices,
  routeOptions,
  protocolIcon,
  protocolLabel,
  roomHint,
  shortTime,
  singleChoice,
  type ProtocolChoice,
} from './conversation-list-model.ts';
import {
  attachmentLines,
  bubbleText,
  cursorOf,
  dayOf,
  dayStarts,
  defaultProtocolChoice,
  foldAlbums,
  MAX_ALBUM_PARTS,
  newOlder,
  PAGE_SIZE,
  protocolDividers,
  protocolRunStarts,
  senderRunStarts,
  type ShownMessage,
  subjectLabels,
  type ProtocolRun,
} from './conversation-model.ts';
import { attachmentList, type AttachmentHandlers } from './attachment-view.ts';
import type { AlbumItem } from './media-viewer.ts';
import { createSilentVideoHost } from './video-preview.ts';
import { shownAttachments, type AttachmentKind } from './attachment-model.ts';
import type { AttachmentSource } from './attachment-store.ts';
import { fadedOverlay } from './fade-bin.ts';
import { createComposerFiles } from './composer-files.ts';
import type { PickedFile } from './composer-files-model.ts';

export interface ConversationView {
  page: Adw.NavigationPage;
  show(entry: ListEntry, messages: ShownMessage[], accountLabels: Map<string, string>): void;
}

const ROWS_PER_TURN = 8;

/** What is built for one message, kept so a later page can correct its day separator and subject. */
interface Built {
  row: Gtk.ListBoxRow;
  bubble: Gtk.Box;
  meta: Gtk.Box;
  separator: Gtk.ListBoxRow | null;
  protocolDivider: Gtk.ListBoxRow | null;
  subject: Gtk.Label | null;
  sender: Gtk.Box | null;
  badge: Gtk.Image | null;
}

export function createConversationView(
  onSend: (text: string, choice: ProtocolChoice, files: PickedFile[]) => Promise<ConversationMessage>,
  canAttach: (backend: string) => boolean,
  loadOlder: (entry: ListEntry, oldest: MessageCursor) => ShownMessage[],
  openMedia: (source: AttachmentSource, kind: AttachmentKind, album?: readonly AlbumItem[]) => void,
  onRoute: (entry: ListEntry, backend: string | null) => void,
): ConversationView {
  let entry: ListEntry | null = null;
  // The array is the caller's: a sent message is pushed onto it, an older page spliced in front.
  let messages: ShownMessage[] = [];
  let accountLabels = new Map<string, string>();
  let selectedChoice: ProtocolChoice | null = null;
  let sending = false;
  let composerBlocked = false;
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
  // Pinning a merged person to one protocol; hidden for every other row.
  const route = new Gtk.MenuButton({
    iconName: 'view-more-symbolic',
    tooltipText: _('Choose how to reach this person'),
    visible: false,
  });
  const routeBox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 2,
    marginTop: 6,
    marginBottom: 6,
  });
  route.set_popover(new Gtk.Popover({ autohide: true, child: routeBox }));
  header.pack_end(route);
  const history = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE });
  history.add_css_class('navigation-sidebar');
  const scroller = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true });
  scroller.set_child(history);

  const composer = new Gtk.Box({ spacing: 6, marginStart: 12, marginEnd: 12, marginTop: 8, marginBottom: 8 });
  const input = new Gtk.Entry({ placeholderText: _('Write a message'), hexpand: true });
  const picker = new Gtk.MenuButton({
    iconName: 'network-transmit-receive-symbolic',
    tooltipText: protocolLabel(''),
    visible: false,
  });
  picker.add_css_class('circular');
  picker.add_css_class('flat');
  const pickerBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
  const pickerPopover = new Gtk.Popover({ autohide: true, child: pickerBox });
  picker.set_popover(pickerPopover);
  const send = new Gtk.Button({ iconName: 'mail-send-symbolic', tooltipText: _('Send message') });
  send.add_css_class('suggested-action');
  send.add_css_class('circular');
  composer.append(input);
  composer.append(picker);
  composer.append(send);

  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  const hint = new Gtk.Label({ xalign: 0, marginStart: 12, marginEnd: 12, marginTop: 4, visible: false });
  hint.add_css_class('dim-label');
  hint.add_css_class('caption');
  content.append(scroller);
  content.append(hint);
  const overlay = new Adw.ToastOverlay({ child: content });
  const files = createComposerFiles({
    parent: () => (page.get_root() as Gtk.Window | null) ?? null,
    toast: (text) => overlay.add_toast(new Adw.Toast({ title: text, timeout: 4 })),
    onChange: () => {},
    dropOn: content,
    pasteInto: input,
  });
  composer.prepend(files.button);
  content.append(files.strip);
  content.append(composer);
  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(header);
  toolbar.set_content(overlay);
  const page = new Adw.NavigationPage({ title: _('Conversation'), tag: 'content' });
  page.set_child(toolbar);

  const adjustment = scroller.get_vadjustment();

  // Pictures are fetched from the mailbox, so they wait until the bubble is near the screen, a
  // couple per pass: a conversation of fifty photos must not open fifty connections at once.
  const waiting: Array<{ widget: Gtk.Widget; load: () => void }> = [];
  const STARTS_PER_PASS = 2;
  let passScheduled = false;
  const nearScreen = (widget: Gtk.Widget): boolean => {
    if (!widget.get_mapped() || widget.get_height() <= 0) return false;
    const [ok, rect] = widget.compute_bounds(scroller);
    if (!ok) return false;
    const page = scroller.get_height();
    return rect.get_y() + rect.get_height() > -page && rect.get_y() < page * 2;
  };
  const loadPass = () => {
    passScheduled = false;
    let started = 0;
    let i = 0;
    while (i < waiting.length && started < STARTS_PER_PASS) {
      const item = waiting[i]!;
      if (!nearScreen(item.widget)) {
        i++;
        continue;
      }
      waiting.splice(i, 1);
      item.load();
      started++;
    }
    if (started === STARTS_PER_PASS) schedulePass(400);
    return GLib.SOURCE_REMOVE;
  };
  const schedulePass = (delay = 50) => {
    if (passScheduled || waiting.length === 0) return;
    passScheduled = true;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, delay, loadPass);
  };
  const handlers: AttachmentHandlers = {
    view: openMedia,
    toast: (title) => overlay.add_toast(new Adw.Toast({ title, timeout: 6 })),
    silentVideo: createSilentVideoHost(scroller),
    whenVisible: (widget, load) => {
      waiting.push({ widget, load });
      schedulePass();
    },
  };

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

  const protocolDividerRow = (text: string): Gtk.ListBoxRow => {
    const label = new Gtk.Label({ label: text, xalign: 0.5, marginTop: 8, marginBottom: 4 });
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

  let pickerChoiceIcons: Array<{ choice: ProtocolChoice; icon: Gtk.Image }> = [];

  const updateSelectedIcon = (): void => {
    for (const { choice, icon } of pickerChoiceIcons) {
      icon.set_visible(choice === selectedChoice);
    }
  };

  // The paperclip follows the carrier: files picked for one that takes none would be lost silently.
  const updateAttachable = (): void => {
    const on = selectedChoice !== null && !composerBlocked && canAttach(selectedChoice.backend);
    if (files.setAttachable(on) > 0) {
      overlay.add_toast(
        new Adw.Toast({
          title: fmt(_('{protocol} cannot send files; the attached files were removed'), {
            protocol: protocolLabel(selectedChoice?.backend ?? ''),
          }),
          timeout: 6,
        }),
      );
    }
  };

  const selectChoice = (choice: ProtocolChoice): void => {
    selectedChoice = choice;
    picker.icon_name = choice.icon;
    picker.set_tooltip_text(protocolLabel(choice.backend));
    picker.update_property(
      [Gtk.AccessibleProperty.LABEL],
      [fmt(_('Send via {protocol}'), { protocol: protocolLabel(choice.backend) })],
    );
    updateSelectedIcon();
    updateAttachable();
  };

  const rebuildRoute = (shownEntry: ListEntry): void => {
    let child = routeBox.get_first_child();
    while (child) {
      const next = child.get_next_sibling();
      routeBox.remove(child);
      child = next;
    }
    const options = routeOptions(shownEntry);
    route.set_visible(options.length > 0);
    let group: Gtk.CheckButton | null = null;
    for (const option of options) {
      const button = new Gtk.CheckButton({
        label: option.label,
        active: option.active,
        marginStart: 12,
        marginEnd: 12,
        marginTop: 4,
        marginBottom: 4,
      });
      if (group) button.set_group(group);
      else group = button;
      button.connect('toggled', () => {
        if (!button.get_active() || option.active) return;
        route.popdown();
        onRoute(shownEntry, option.backend);
      });
      routeBox.append(button);
    }
  };

  const rebuildPicker = (choices: ProtocolChoice[]): void => {
    pickerChoiceIcons = [];
    let child = pickerBox.get_first_child();
    while (child) {
      const next = child.get_next_sibling();
      pickerBox.remove(child);
      child = next;
    }
    for (const choice of choices) {
      const row = new Gtk.Box({
        spacing: 12,
        marginStart: 12,
        marginEnd: 12,
        marginTop: 8,
        marginBottom: 8,
      });
      row.append(new Gtk.Image({ iconName: choice.icon, pixelSize: 16 }));
      const label = new Gtk.Label({
        label: accountLabels.get(choice.accountId) ?? choice.label,
        xalign: 0,
        hexpand: true,
      });
      row.append(label);
      const selectedIcon = new Gtk.Image({
        iconName: 'object-select-symbolic',
        pixelSize: 16,
        visible: false,
      });
      row.append(selectedIcon);
      pickerChoiceIcons.push({ choice, icon: selectedIcon });
      const button = new Gtk.Button({ child: row });
      button.add_css_class('flat');
      button.connect('clicked', () => {
        selectChoice(choice);
        pickerPopover.popdown();
      });
      pickerBox.append(button);
    }
  };

  // Builds the rows of one message; `position` is where the first goes in the list, -1 for the end.
  const addRow = (
    message: ShownMessage,
    subject: string | undefined,
    sender: string | undefined,
    run: ProtocolRun | undefined,
    divider: string | undefined,
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
    const written = message.bodyText?.trim() || message.notice;
    const full =
      (written ||
        (message.hasAttachments ? attachmentLines(message.attachments).join('\n') : _('No text body'))) +
      (message.bodyTruncated ? ' …' : '');
    // What is listed below the text stands for the attachments itself; the placeholder line is
    // only for a message whose parts the index does not know.
    const { shown, more } = shownAttachments(
      message.attachments,
      message.groupId ? MAX_ALBUM_PARTS : undefined,
    );
    const listed = shown.length > 0;
    const generic = message.hasAttachments && !listed;
    if (listed || generic) bubble.append(attachmentList(message.ref, shown, more, handlers, generic));
    if (written || (!listed && !generic)) {
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
    }
    const time = new Gtk.Label({ label: shortTime(message.sentAt), xalign: 1 });
    time.add_css_class('caption');
    time.add_css_class('dim-label');
    const meta = new Gtk.Box({ spacing: 6, halign: Gtk.Align.END });
    let badge: Gtk.Image | null = null;
    if (run) {
      badge = new Gtk.Image({ iconName: protocolIcon(run.backend), pixelSize: 12 });
      badge.set_tooltip_text(protocolLabel(run.backend));
      meta.append(badge);
    }
    meta.append(time);
    bubble.append(meta);

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
    const protocolDivider = divider ? protocolDividerRow(divider) : null;
    // Dividers and day separators go above their message: before it when appending, after it when
    // both are put in front at the same index.
    if (position === -1) {
      if (separator) history.insert(separator, -1);
      if (protocolDivider) history.insert(protocolDivider, -1);
      history.insert(row, -1);
    } else {
      history.insert(row, position);
      if (protocolDivider) history.insert(protocolDivider, position);
      if (separator) history.insert(separator, position);
    }
    built.set(message.id, {
      row,
      bubble,
      meta,
      badge,
      separator,
      protocolDivider,
      subject: heading,
      sender: senderBox,
    });
  };

  // After a page went in front, its newest neighbour may no longer open a day, a topic or a run.
  const reconcile = (
    message: ConversationMessage,
    subject: string | undefined,
    sender: string | undefined,
    run: ProtocolRun | undefined,
    divider: string | undefined,
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
    if (one.protocolDivider && divider === undefined) {
      history.remove(one.protocolDivider);
      one.protocolDivider = null;
    } else if (!one.protocolDivider && divider !== undefined) {
      one.protocolDivider = protocolDividerRow(divider);
      history.insert(one.protocolDivider, one.row.get_index());
    }
    if (run) {
      if (one.badge) {
        one.badge.icon_name = protocolIcon(run.backend);
        one.badge.set_tooltip_text(protocolLabel(run.backend));
      } else {
        one.badge = new Gtk.Image({ iconName: protocolIcon(run.backend), pixelSize: 12 });
        one.badge.set_tooltip_text(protocolLabel(run.backend));
        one.meta.prepend(one.badge);
      }
    } else if (one.badge) {
      one.meta.remove(one.badge);
      one.badge = null;
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
    spin.set_child(
      new Adw.Spinner({
        halign: Gtk.Align.CENTER,
        widthRequest: 32,
        heightRequest: 32,
        marginTop: 12,
        marginBottom: 12,
      }),
    );
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
      let fresh: ShownMessage[];
      try {
        const page = loadOlder(shownEntry, cursorOf(oldest));
        exhausted = page.length < PAGE_SIZE;
        fresh = foldAlbums(newOlder(messages, page));
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
      const runs = protocolRunStarts(messages);
      const dividers = protocolDividers(messages);
      let next = joinedAt - 1;
      // Newest of the page first, each above the one before, so the rows grow upward from the
      // spinner and the person's place below them is the one that has to hold still.
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (run !== generation) return GLib.SOURCE_REMOVE;
        const stop = Math.max(next - ROWS_PER_TURN, -1);
        for (; next > stop; next--) {
          const message = messages[next]!;
          addRow(
            message,
            subjects.get(message.id),
            senders.get(message.id),
            runs.get(message.id),
            dividers.get(message.id),
            starts.has(message.id),
            1,
          );
        }
        if (next >= 0) return GLib.SOURCE_CONTINUE;
        const joined = messages[joinedAt]!;
        reconcile(
          joined,
          subjects.get(joined.id),
          senders.get(joined.id),
          runs.get(joined.id),
          dividers.get(joined.id),
          starts.has(joined.id),
        );
        finish();
        return GLib.SOURCE_REMOVE;
      });
      return GLib.SOURCE_REMOVE;
    });
  };

  // What came in front pushed the rows the person was reading down by the growth of `upper`.
  // A picture that arrives after the build changes the height; a person reading the newest
  // messages stays at the end, one who scrolled up keeps their place.
  let atEnd = true;
  adjustment.connect('notify::upper', () => {
    if (ready && !prepending && atEnd) scrollToEnd();
    if (prepending) {
      const upper = adjustment.get_upper();
      const grown = upper - lastUpper;
      lastUpper = upper;
      if (grown !== 0) adjustment.set_value(adjustment.get_value() + grown);
    }
    if (ready && nearTop()) loadPage();
    schedulePass();
  });
  adjustment.connect('value-changed', () => {
    if (ready) atEnd = adjustment.get_value() + adjustment.get_page_size() >= adjustment.get_upper() - 8;
    if (ready && nearTop()) loadPage();
    schedulePass();
  });
  adjustment.connect('notify::page-size', () => schedulePass());

  const submit = () => {
    const text = input.get_text().trim();
    const picked = files.files();
    if ((!text && picked.length === 0) || sending || !entry || !selectedChoice) return;
    sending = true;
    input.set_sensitive(false);
    send.set_sensitive(false);
    // An upload takes a while: the button shows that something is happening.
    send.set_child(new Adw.Spinner());
    void onSend(text, selectedChoice, picked)
      .then((message) => {
        const previous = messages[messages.length - 1] ?? null;
        const previousDay = dayOf(previous ?? message);
        messages.push(message);
        const day = dayOf(message);
        const run =
          previous === null || previous.backend !== message.backend
            ? { backend: message.backend }
            : undefined;
        const divider =
          previous && previous.backend !== message.backend
            ? fmt(_('Continuing via {protocol}'), { protocol: protocolLabel(message.backend) })
            : undefined;
        // The person's own message starts no sender run, and the next one from another starts its own.
        addRow(message, undefined, undefined, run, divider, day !== '' && day !== previousDay, -1);
        input.set_text('');
        files.clear();
        scrollToEnd();
      })
      .catch((err: unknown) => {
        // The text and the files stay where they are, so "Retry" sends the same message again.
        const toast = new Adw.Toast({
          title: fmt(_('Message not sent: {error}'), {
            error: err instanceof Error ? err.message : String(err),
          }),
          buttonLabel: _('Retry'),
          timeout: 10,
        });
        toast.connect('button-clicked', submit);
        overlay.add_toast(toast);
      })
      .finally(() => {
        sending = false;
        input.set_sensitive(true);
        send.set_sensitive(true);
        send.set_icon_name('mail-send-symbolic');
        input.grab_focus();
      });
  };
  send.connect('clicked', submit);
  input.connect('activate', submit);

  return {
    page,
    show(nextEntry, nextMessages, nextLabels) {
      entry = nextEntry;
      rebuildRoute(nextEntry);
      messages = foldAlbums(nextMessages);
      accountLabels = nextLabels;
      title.set_title(nextEntry.title);
      title.set_subtitle(entryProtocolSubtitle(nextEntry));
      history.remove_all();
      built.clear();
      waiting.length = 0;
      atEnd = true;
      const choices = protocolChoices(nextEntry);
      const only = singleChoice(nextEntry);
      const blocked = composerBlock(nextEntry);
      // A blocked composer stays visible but insensitive, so the hint can say why.
      const sendable = canSend(nextEntry);
      composer.set_visible(sendable);
      const roomLine = blocked ?? roomHint(nextEntry);
      hint.set_label(roomLine ?? '');
      hint.set_visible(sendable && roomLine !== null);
      input.set_sensitive(blocked === null);
      send.set_sensitive(blocked === null);
      composerBlocked = blocked !== null;
      input.set_text('');
      files.clear();
      if (choices.length > 1) {
        selectedChoice = defaultProtocolChoice(messages, choices);
        rebuildPicker(choices);
        picker.set_visible(true);
      } else if (only) {
        selectedChoice = only;
        picker.set_visible(false);
      } else {
        selectedChoice = null;
        picker.set_visible(false);
      }
      if (selectedChoice) selectChoice(selectedChoice);
      else updateAttachable();
      const subjects = subjectLabels(messages);
      const starts = dayStarts(messages);
      const senders = senderRunStarts(messages, nextEntry.kind === 'group');
      const runs = protocolRunStarts(messages);
      const dividers = protocolDividers(messages);
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
          addRow(
            message,
            subjects.get(message.id),
            senders.get(message.id),
            runs.get(message.id),
            dividers.get(message.id),
            starts.has(message.id),
            -1,
          );
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
