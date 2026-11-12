/** The conversation pane: mail and messenger history as bubbles, with a small chat composer. */

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';
import { _, fmt } from '@curlew/protocol';
import type { ConversationMessage, MessageReaction, ReplyTarget } from '@curlew/protocol';
import type { MessageCursor } from '@curlew/store';

import { hasContactPage } from './contact-page.ts';
import { showPicture, showSenderPicture } from './contact-picture.ts';
import type { ListEntry } from './conversation-list-model.ts';
import {
  canSend,
  clockTime,
  composerBlock,
  entryProtocolSubtitle,
  initials,
  protocolChoices,
  routeOptions,
  protocolIcon,
  protocolLabel,
  roomHint,
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
  changesOfferedFor,
  deleteHandleOf,
  editHandleOf,
  foldAlbums,
  MAX_ALBUM_PARTS,
  newOlder,
  PAGE_SIZE,
  protocolDividers,
  protocolRunStarts,
  QUICK_REACTIONS,
  quoteOf,
  reactHandleOf,
  reactionsOfferedIn,
  reactionChip,
  replyDraftOf,
  senderRunStarts,
  type ShownMessage,
  subjectLabels,
  toggleOwnReaction,
  withOwnReaction,
  type ProtocolRun,
  type Quote,
  type MessageHandle,
  type ReactionChange,
  type ReplyDraft,
} from './conversation-model.ts';
import { attachmentList, type AttachmentHandlers } from './attachment-view.ts';
import { type Look, lookClasses } from '../core/lib/appearance.ts';
import { ChatBackground } from './chat-background.ts';
import type { AlbumItem } from './media-viewer.ts';
import { createSilentVideoHost } from './video-preview.ts';
import { leadsWithMedia, shownAttachments, type AttachmentKind } from './attachment-model.ts';
import { hasRichText, richMarkup } from './rich-text-model.ts';
import type { AttachmentSource } from './attachment-store.ts';
import { fadedOverlay } from './fade-bin.ts';
import { createComposerFiles } from './composer-files.ts';
import { createComposerInput } from './composer-input.ts';
import type { PickedFile } from './composer-files-model.ts';

export interface ConversationView {
  page: Adw.NavigationPage;
  show(entry: ListEntry, messages: ShownMessage[], accountLabels: Map<string, string>): void;
  /** Give the open chat its own colours and pattern; an empty look follows the app-wide setting. */
  setLook(look: Look): void;
}

const ROWS_PER_TURN = 8;

// Sets a bubble's text: links and light Markdown as markup, anything else as it came. The markup
// is well-formed by construction (every character is escaped, every tag closed), and it can use
// `<a>`, which `Pango.parse_markup` does not know, so it is not pre-checked.
function setBodyText(label: Gtk.Label, text: string): void {
  if (hasRichText(text)) label.set_markup(richMarkup(text));
  else {
    label.set_use_markup(false);
    label.set_label(text);
  }
}

/** What is built for one message, kept so a later page can correct its day separator and subject. */
interface Built {
  row: Gtk.ListBoxRow;
  bubble: Gtk.Box;
  meta: Gtk.Box;
  reactions: Gtk.Box;
  separator: Gtk.ListBoxRow | null;
  protocolDivider: Gtk.ListBoxRow | null;
  subject: Gtk.Label | null;
  sender: Gtk.Box | null;
  badge: Gtk.Image | null;
  body: Gtk.Label | null;
  edited: Gtk.Label | null;
}

export function createConversationView(
  onSend: (
    text: string,
    choice: ProtocolChoice,
    files: PickedFile[],
    replyTo?: ReplyTarget,
  ) => Promise<ConversationMessage>,
  canAttach: (backend: string) => boolean,
  canReply: (backend: string) => boolean,
  canReact: (backend: string) => boolean,
  onReact: (
    message: ShownMessage,
    handle: MessageHandle<ProtocolChoice>,
    change: ReactionChange,
  ) => Promise<void>,
  canEdit: (backend: string) => boolean,
  canDelete: (backend: string) => boolean,
  onEdit: (message: ShownMessage, handle: MessageHandle<ProtocolChoice>, text: string) => Promise<void>,
  onDelete: (message: ShownMessage, handle: MessageHandle<ProtocolChoice>) => Promise<void>,
  loadOlder: (entry: ListEntry, oldest: MessageCursor) => ShownMessage[],
  loadQuoted: (entry: ListEntry, remoteIds: readonly string[]) => ShownMessage[],
  openMedia: (source: AttachmentSource, kind: AttachmentKind, album?: readonly AlbumItem[]) => void,
  onRoute: (entry: ListEntry, backend: string | null) => void,
  onContact: (entry: ListEntry) => void,
): ConversationView {
  let entry: ListEntry | null = null;
  // The array is the caller's: a sent message is pushed onto it, an older page spliced in front.
  let messages: ShownMessage[] = [];
  let accountLabels = new Map<string, string>();
  let selectedChoice: ProtocolChoice | null = null;
  // Every carrier the open conversation can send through; a reply is offered only on one of them.
  let carriers: ProtocolChoice[] = [];
  let reply: ReplyDraft<ProtocolChoice> | null = null;
  let edit: { message: ShownMessage; originalText: string; handle: MessageHandle<ProtocolChoice> } | null =
    null;
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
  // Messages that replies quote but that are older than the pages loaded so far, by network id: a
  // quote shows them, and a click on it pages back until the real row exists.
  const quoteTargets = new Map<string, ShownMessage>();
  let jumpTo: string | null = null;

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
  // The person's picture opens their contact page.
  const contactAvatar = new Adw.Avatar({ size: 32, showInitials: true });
  const contact = new Gtk.Button({ child: contactAvatar, tooltipText: _('Contact details'), visible: false });
  contact.add_css_class('flat');
  contact.add_css_class('circular');
  contact.connect('clicked', () => {
    if (entry) onContact(entry);
  });
  header.pack_start(contact);
  const history = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE });
  history.add_css_class('navigation-sidebar');
  const scroller = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true });
  scroller.set_child(history);
  // The pattern sits under the messages and takes no clicks.
  const backdrop = new Gtk.Overlay({ vexpand: true });
  const pattern = new ChatBackground();
  backdrop.set_child(pattern);
  backdrop.add_overlay(scroller);
  // A conversation with nothing in it says so, instead of showing the bare pattern like a failed load.
  const empty = new Adw.StatusPage({
    iconName: 'chat-message-new-symbolic',
    title: _('No messages yet'),
    valign: Gtk.Align.CENTER,
    canTarget: false,
    visible: false,
  });
  empty.add_css_class('compact');
  backdrop.add_overlay(empty);

  const composer = new Gtk.Box({ spacing: 6, marginStart: 6, marginEnd: 6, marginTop: 6, marginBottom: 6 });
  const input = createComposerInput(_('Write a message'));
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
  composer.append(input.widget);
  composer.append(picker);
  composer.append(send);

  // What the next message answers: the quote's look, one line, and a way to drop it again.
  const replyBar = new Gtk.Box({ spacing: 6, marginStart: 12, marginEnd: 6, marginTop: 6, visible: false });
  const replySlot = new Gtk.Box({ hexpand: true });
  const replyClose = new Gtk.Button({
    iconName: 'window-close-symbolic',
    tooltipText: _('Cancel reply'),
    valign: Gtk.Align.CENTER,
  });
  replyClose.add_css_class('flat');
  replyClose.add_css_class('circular');
  replyBar.append(replySlot);
  replyBar.append(replyClose);

  // The bar shown while editing one of the person's own messages.
  const editBar = new Gtk.Box({ spacing: 6, marginStart: 12, marginEnd: 6, marginTop: 6, visible: false });
  const editSlot = new Gtk.Box({ hexpand: true });
  const editClose = new Gtk.Button({
    iconName: 'window-close-symbolic',
    tooltipText: _('Cancel editing'),
    valign: Gtk.Align.CENTER,
  });
  editClose.add_css_class('flat');
  editClose.add_css_class('circular');
  editBar.append(editSlot);
  editBar.append(editClose);

  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  const hint = new Gtk.Label({ xalign: 0, marginStart: 12, marginEnd: 12, marginTop: 4, visible: false });
  hint.add_css_class('dim-label');
  hint.add_css_class('caption');
  content.append(backdrop);
  const overlay = new Adw.ToastOverlay({ child: content });
  const files = createComposerFiles({
    parent: () => (page.get_root() as Gtk.Window | null) ?? null,
    toast: (text) => overlay.add_toast(new Adw.Toast({ title: text, timeout: 4 })),
    onChange: () => {},
    dropOn: content,
    pasteInto: input.view,
  });
  composer.prepend(files.button);
  // The buttons stay at the bottom edge while the field grows upward.
  for (const part of [files.button, picker, send]) part.set_valign(Gtk.Align.END);
  // Everything the person types into rides in one bottom bar, so the history can run beneath it.
  const compose = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  // Each part is a card of its own, so it stays legible over the messages scrolling beneath it.
  const pill = new Gtk.Box({ marginStart: 12, marginEnd: 12, marginTop: 6, marginBottom: 8 });
  pill.add_css_class('card');
  pill.add_css_class('curlew-surface');
  pill.append(composer);
  // The card is the surface and the part keeps its own margins as padding inside it.
  const floating = (part: Gtk.Widget): Gtk.Box => {
    const card = new Gtk.Box({ marginStart: 12, marginEnd: 12, marginTop: 4, visible: part.get_visible() });
    card.add_css_class('card');
    card.add_css_class('curlew-surface');
    card.append(part);
    part.bind_property('visible', card, 'visible', GObject.BindingFlags.SYNC_CREATE);
    return card;
  };
  hint.set_margin_bottom(4);
  for (const part of [hint, files.strip, replyBar, editBar]) compose.append(floating(part));
  compose.append(pill);
  const toolbar = new Adw.ToolbarView({ extendContentToBottomEdge: true });
  toolbar.add_top_bar(header);
  toolbar.add_bottom_bar(compose);
  toolbar.set_content(overlay);
  // The header stays solid, as in Telegram, so a message never runs under its title. The composer
  // floats, so the last message must be able to scroll clear of it (ADR 0013).
  toolbar.connect('notify::bottom-bar-height', () =>
    history.set_margin_bottom(toolbar.get_bottom_bar_height()),
  );
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
    const label = new Gtk.Label({
      label: day,
      marginStart: 12,
      marginEnd: 12,
      marginTop: 3,
      marginBottom: 3,
    });
    label.add_css_class('caption');
    // A pill of its own, so the date stays legible on the wallpaper.
    const pill = new Gtk.Box({ halign: Gtk.Align.CENTER, marginTop: 12, marginBottom: 6 });
    pill.add_css_class('card');
    pill.add_css_class('curlew-surface');
    pill.append(label);
    const row = new Gtk.ListBoxRow({ selectable: false, activatable: false });
    row.set_child(pill);
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

  const padded = <T extends Gtk.Widget>(widget: T): T => {
    widget.set_margin_start(12);
    widget.set_margin_end(12);
    return widget;
  };

  // The bubble's first part gets the top padding, unless it is a picture block that runs to the edge.
  const padTop = (bubble: Gtk.Box): void => {
    let index = 0;
    for (let child = bubble.get_first_child(); child; child = child.get_next_sibling(), index++) {
      child.set_margin_top(index === 0 && !child.has_css_class('bleeds') ? 8 : 0);
    }
  };

  const subjectHeading = (subject: string): Gtk.Label => {
    const label = new Gtk.Label({ label: subject, xalign: 0, wrap: true, marginStart: 12, marginEnd: 12 });
    label.add_css_class('heading');
    return label;
  };

  // Who wrote the run of bubbles it opens: a small avatar with initials, like the list, and the name.
  const senderHeading = (name: string, message: ConversationMessage): Gtk.Box => {
    const box = new Gtk.Box({ spacing: 6, marginStart: 12, marginEnd: 12 });
    const avatar = new Adw.Avatar({ size: 20, text: name, showInitials: initials(name) !== '' });
    if (entry) showSenderPicture(avatar, entry, message.senderAddress);
    box.append(avatar);
    const label = new Gtk.Label({ label: name, xalign: 0, ellipsize: Pango.EllipsizeMode.END });
    label.add_css_class('caption-heading');
    label.add_css_class('accent');
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

  const sameCarrier = (a: ProtocolChoice, b: ProtocolChoice): boolean =>
    a.backend === b.backend && a.accountId === b.accountId;

  const clearReply = (): void => {
    reply = null;
    replyBar.set_visible(false);
    let child = replySlot.get_first_child();
    while (child) {
      replySlot.remove(child);
      child = replySlot.get_first_child();
    }
  };
  replyClose.connect('clicked', () => {
    clearReply();
    input.grabFocus();
  });

  const clearEdit = (): void => {
    edit = null;
    editBar.set_visible(false);
    let child = editSlot.get_first_child();
    while (child) {
      editSlot.remove(child);
      child = editSlot.get_first_child();
    }
    input.setPlaceholder(_('Write a message'));
  };
  editClose.connect('clicked', () => {
    clearEdit();
    input.setText('');
    input.grabFocus();
  });

  const selectChoice = (choice: ProtocolChoice): void => {
    // A reply is a link inside one network: another carrier cannot send it.
    if (reply && !sameCarrier(reply.choice, choice)) clearReply();
    // Editing is tied to one carrier too.
    if (edit && !sameCarrier(edit.handle.choice, choice)) clearEdit();
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

  // The message a reply points at: a bar, the author and a short excerpt, in theme colours only.
  const quoteLine = (author: string, excerpt: string, lines: number): Gtk.Box => {
    const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
    const name = new Gtk.Label({ label: author, xalign: 0, ellipsize: Pango.EllipsizeMode.END });
    name.add_css_class('caption-heading');
    // The author in the accent colour, as Fractal and Telegram tint a quote.
    name.add_css_class('accent');
    text.append(name);
    const line = new Gtk.Label({
      label: excerpt,
      xalign: 0,
      lines,
      wrap: true,
      wrapMode: Pango.WrapMode.WORD_CHAR,
      ellipsize: Pango.EllipsizeMode.END,
      maxWidthChars: 40,
    });
    line.add_css_class('caption');
    line.add_css_class('dim-label');
    text.append(line);
    const block = new Gtk.Box({ spacing: 8 });
    block.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL }));
    block.append(text);
    return block;
  };

  const quoteBlock = (quote: Quote): Gtk.Widget => {
    const block = quoteLine(quote.author, quote.excerpt, 2);
    // A button would indent the quote by its padding; a click on the block does the same.
    block.set_tooltip_text(_('Show the quoted message'));
    block.set_cursor_from_name('pointer');
    const click = new Gtk.GestureClick();
    click.connect('released', () => scrollToMessage(quote.id));
    block.add_controller(click);
    block.update_property(
      [Gtk.AccessibleProperty.LABEL],
      [fmt(_('Reply to {author}: {excerpt}'), { author: quote.author, excerpt: quote.excerpt })],
    );
    return block;
  };

  // Brings a message that is on the page to the middle of the view; the history stays put when
  // the person scrolls on, so this never turns the scroll-to-end off by itself.
  const scrollToMessage = (id: string) => {
    const target = built.get(id)?.row;
    if (!target) {
      // Older than what is loaded: page back until it arrives (see `finish` in loadPage).
      if (!exhausted) {
        jumpTo = id;
        loadPage();
      } else {
        overlay.add_toast(new Adw.Toast({ title: _('The quoted message is no longer in the history') }));
      }
      return;
    }
    const { y, height } = target.get_allocation();
    const middle = y + height / 2 - adjustment.get_page_size() / 2;
    const top = Math.max(0, Math.min(middle, adjustment.get_upper() - adjustment.get_page_size()));
    adjustment.set_value(top);
  };

  const startReply = (draft: ReplyDraft<ProtocolChoice>): void => {
    selectChoice(draft.choice);
    clearReply();
    reply = draft;
    replySlot.append(quoteLine(draft.author, draft.excerpt, 1));
    replyBar.update_property(
      [Gtk.AccessibleProperty.LABEL],
      [fmt(_('Reply to {author}: {excerpt}'), { author: draft.author, excerpt: draft.excerpt })],
    );
    replyBar.set_visible(true);
    input.grabFocus();
  };

  // One reaction at a time per message: a second tap while the first is on its way would race it.
  const reacting = new Set<string>();
  const react = (
    message: ShownMessage,
    handle: MessageHandle<ProtocolChoice>,
    emoji: string,
    showReactions: () => void,
  ): void => {
    if (reacting.has(message.id)) return;
    reacting.add(message.id);
    const change = toggleOwnReaction(message.reactions, emoji);
    onReact(message, handle, change)
      .then(() => {
        message.reactions = withOwnReaction(message.reactions, change.emoji);
        showReactions();
      })
      .catch((err: unknown) => {
        overlay.add_toast(
          new Adw.Toast({
            title: fmt(_('Reaction not sent: {error}'), {
              error: err instanceof Error ? err.message : String(err),
            }),
            timeout: 6,
          }),
        );
      })
      .finally(() => reacting.delete(message.id));
  };

  const removeMessage = (message: ShownMessage): void => {
    const one = built.get(message.id);
    if (!one) return;
    if (one.separator) history.remove(one.separator);
    if (one.protocolDivider) history.remove(one.protocolDivider);
    history.remove(one.row);
    built.delete(message.id);
    const index = messages.findIndex((m) => m.id === message.id);
    if (index !== -1) messages.splice(index, 1);
  };

  const startEdit = (message: ShownMessage, handle: MessageHandle<ProtocolChoice>): void => {
    selectChoice(handle.choice);
    clearReply();
    clearEdit();
    const text = message.bodyText ?? '';
    edit = { message, originalText: text, handle };
    input.setText(text);
    input.setPlaceholder(_('Edit message'));
    editSlot.append(quoteLine(_('You'), text, 1));
    editBar.update_property(
      [Gtk.AccessibleProperty.LABEL],
      [fmt(_('Editing your message: {excerpt}'), { excerpt: text })],
    );
    editBar.set_visible(true);
    input.grabFocus();
  };

  const confirmDelete = (message: ShownMessage, handle: MessageHandle<ProtocolChoice>): void => {
    const dialog = new Adw.AlertDialog({
      heading: _('Delete message?'),
      body: _('This will remove the message for everyone in the chat.'),
      closeResponse: 'cancel',
      defaultResponse: 'delete',
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('delete', _('Delete for everyone'));
    dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.connect('response', (_dlg, response) => {
      if (response !== 'delete') return;
      const builtMsg = built.get(message.id);
      if (!builtMsg) return;
      builtMsg.row.set_visible(false);
      builtMsg.separator?.set_visible(false);
      builtMsg.protocolDivider?.set_visible(false);
      onDelete(message, handle)
        .then(() => removeMessage(message))
        .catch((err: unknown) => {
          builtMsg.row.set_visible(true);
          builtMsg.separator?.set_visible(true);
          builtMsg.protocolDivider?.set_visible(true);
          overlay.add_toast(
            new Adw.Toast({
              title: fmt(_('Message not deleted: {error}'), {
                error: err instanceof Error ? err.message : String(err),
              }),
              timeout: 6,
            }),
          );
        });
    });
    const root = page.get_root() as Gtk.Window | null;
    dialog.present(root);
  };

  // What the open chat allows beyond what a protocol can do: Saved Messages take no reaction,
  // Signal closes edit and delete after a day. The entries are not shown rather than refused.
  const reactable = (backend: string): boolean =>
    canReact(backend) && reactionsOfferedIn(backend, entry?.self === true);
  const changeable =
    (can: (backend: string) => boolean, message: ShownMessage) =>
    (backend: string): boolean =>
      can(backend) && changesOfferedFor(backend, message, entry?.self === true, Date.now());

  // The emoji row, "Reply", "Edit", "Delete" and "Copy" for one bubble. Long press (touch) and right
  // click (pointer) open it; both run before the selectable text, which would otherwise keep the press.
  const attachBubbleActions = (card: Gtk.Box, message: ShownMessage, showReactions: () => void): void => {
    const open = (gesture: Gtk.Gesture, x: number, y: number): void => {
      const usable = composer.get_visible() && !composerBlocked;
      const draft = usable ? replyDraftOf(message, carriers, canReply) : null;
      const handle = usable ? reactHandleOf(message, carriers, reactable) : null;
      const editHandle = usable ? editHandleOf(message, carriers, changeable(canEdit, message)) : null;
      const deleteHandle = usable ? deleteHandleOf(message, carriers, changeable(canDelete, message)) : null;
      const text = message.bodyText?.trim() ?? '';
      if (!draft && !handle && !editHandle && !deleteHandle && !text) return;
      gesture.set_state(Gtk.EventSequenceState.CLAIMED);
      const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
      const popover = new Gtk.Popover({ autohide: true, hasArrow: false, child: box });
      if (handle) {
        const emojis = new Gtk.Box({ spacing: 2, halign: Gtk.Align.CENTER });
        const own = message.reactions?.find((r) => r.own)?.emoji;
        for (const emoji of QUICK_REACTIONS) {
          const button = new Gtk.Button({ label: emoji });
          button.add_css_class('flat');
          if (emoji === own) button.add_css_class('accent');
          button.update_property([Gtk.AccessibleProperty.LABEL], [emoji]);
          button.connect('clicked', () => {
            popover.popdown();
            react(message, handle, emoji, showReactions);
          });
          emojis.append(button);
        }
        box.append(emojis);
      }
      const entryButton = (label: string, action: () => void): void => {
        const button = new Gtk.Button({ label });
        button.add_css_class('flat');
        (button.get_child() as Gtk.Label).set_xalign(0);
        button.connect('clicked', () => {
          popover.popdown();
          action();
        });
        box.append(button);
      };
      if (draft) entryButton(_('Reply'), () => startReply(draft));
      if (editHandle) entryButton(_('Edit'), () => startEdit(message, editHandle));
      if (deleteHandle) entryButton(_('Delete'), () => confirmDelete(message, deleteHandle));
      if (text) entryButton(_('Copy'), () => card.get_clipboard().set(text));
      popover.set_parent(card);
      const spot = new Gdk.Rectangle({ x: Math.round(x), y: Math.round(y), width: 1, height: 1 });
      popover.set_pointing_to(spot);
      // The popover belongs to the card: it goes before the card does, after its own click is handled.
      popover.connect('closed', () => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
          popover.unparent();
          return GLib.SOURCE_REMOVE;
        });
      });
      popover.popup();
    };
    const longPress = new Gtk.GestureLongPress({
      touchOnly: true,
      propagationPhase: Gtk.PropagationPhase.CAPTURE,
    });
    longPress.connect('pressed', (gesture: Gtk.GestureLongPress, x: number, y: number) =>
      open(gesture, x, y),
    );
    const click = new Gtk.GestureClick({
      button: Gdk.BUTTON_SECONDARY,
      propagationPhase: Gtk.PropagationPhase.CAPTURE,
    });
    click.connect('pressed', (gesture: Gtk.GestureClick, _n: number, x: number, y: number) =>
      open(gesture, x, y),
    );
    card.add_controller(longPress);
    card.add_controller(click);
  };

  // The emoji under a bubble, wrapping; the person's own is tinted with the accent colour.
  const reactionRow = (
    message: ShownMessage,
    reactions: readonly MessageReaction[],
    showReactions: () => void,
  ): Gtk.Widget => {
    const flow = new Gtk.FlowBox({
      selectionMode: Gtk.SelectionMode.NONE,
      homogeneous: false,
      minChildrenPerLine: 1,
      maxChildrenPerLine: 20,
      columnSpacing: 4,
      rowSpacing: 4,
      halign: Gtk.Align.START,
    });
    for (const reaction of reactions) {
      const { text, tooltip } = reactionChip(reaction);
      const chip = new Gtk.Label({
        label: text,
        marginStart: 8,
        marginEnd: 8,
        marginTop: 2,
        marginBottom: 2,
      });
      chip.add_css_class('caption');
      if (reaction.own) chip.add_css_class('accent');
      const frame = new Gtk.Box();
      frame.add_css_class('card');
      frame.append(chip);
      frame.set_tooltip_text(tooltip);
      frame.update_property([Gtk.AccessibleProperty.LABEL], [`${reaction.emoji}, ${tooltip}`]);
      // Tapping a chip gives that emoji too, or takes the person's own back.
      const tap = new Gtk.GestureClick({ button: Gdk.BUTTON_PRIMARY });
      tap.connect('released', () => {
        const handle =
          composer.get_visible() && !composerBlocked ? reactHandleOf(message, carriers, reactable) : null;
        if (handle) react(message, handle, reaction.emoji, showReactions);
      });
      frame.add_controller(tap);
      if (reactHandleOf(message, carriers, reactable)) frame.set_cursor_from_name('pointer');
      flow.append(frame);
    }
    return flow;
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
    // Clips a picture block to the bubble's rounded corners.
    const card = new Gtk.Box({ overflow: Gtk.Overflow.HIDDEN });
    card.add_css_class('card');
    // The person's own messages take the accent colour, as in Telegram and WhatsApp (ADR 0013); the
    // others get the opaque surface, which a chat's own primary tint recolours.
    card.add_css_class(message.fromSelf ? 'curlew-own' : 'curlew-surface');
    // No padding of its own: text parts carry the side margins, a picture block runs to the edge.
    const bubble = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, marginBottom: 8 });
    card.append(bubble);
    // Holds the chips; rebuilt in place when the person's own reaction changes.
    const reactions = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    reactions.add_css_class('reactions');
    const showReactions = (): void => {
      for (let child = reactions.get_first_child(); child; child = reactions.get_first_child()) {
        reactions.remove(child);
      }
      const chips = message.reactions ?? [];
      reactions.set_visible(chips.length > 0);
      if (chips.length > 0) reactions.append(reactionRow(message, chips, showReactions));
    };
    attachBubbleActions(card, message, showReactions);
    const senderBox = sender !== undefined ? senderHeading(sender, message) : null;
    if (senderBox) bubble.append(senderBox);
    const heading = subject ? subjectHeading(subject) : null;
    if (heading) bubble.append(heading);
    const quote = quoteOf(message, messages) ?? quoteOf(message, [...quoteTargets.values()]);
    if (quote) bubble.append(padded(quoteBlock(quote)));
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
    // Text under a picture wraps at the picture's width, so the bubble does not grow past it.
    const textWidth = leadsWithMedia(shown) ? 30 : 56;
    let body: Gtk.Label | null = null;
    if (written || (!listed && !generic)) {
      const preview = bubbleText(full);
      const label = new Gtk.Label({
        xalign: 0,
        wrap: true,
        // A long URL has no word break and would widen the bubble past the window.
        wrapMode: Pango.WrapMode.WORD_CHAR,
        selectable: true,
        maxWidthChars: textWidth,
      });
      setBodyText(label, preview.clipped ? `${preview.text} …` : preview.text);
      body = label;
      bubble.append(padded(fadedOverlay(label, preview.clipped, () => setBodyText(label, full))));
    }
    showReactions();
    bubble.append(padded(reactions));
    const time = new Gtk.Label({ label: clockTime(message.sentAt), xalign: 1 });
    time.add_css_class('caption');
    time.add_css_class('dim-label');
    const meta = new Gtk.Box({ spacing: 6, halign: Gtk.Align.END });
    let badge: Gtk.Image | null = null;
    if (run) {
      badge = new Gtk.Image({ iconName: protocolIcon(run.backend), pixelSize: 12 });
      badge.set_tooltip_text(protocolLabel(run.backend));
      meta.append(badge);
    }
    let edited: Gtk.Label | null = null;
    if (message.editedAt) {
      edited = new Gtk.Label({ label: _('edited'), xalign: 1 });
      edited.add_css_class('caption');
      edited.add_css_class('dim-label');
      meta.append(edited);
    }
    meta.append(time);
    // Only where the network reports it; "sent" and "delivered" would be guesses, so they show nothing.
    if (message.fromSelf && message.readByPeer) {
      const read = new Gtk.Image({ iconName: 'object-select-symbolic', pixelSize: 12 });
      read.add_css_class('accent');
      read.set_tooltip_text(_('Read'));
      read.update_property([Gtk.AccessibleProperty.LABEL], [_('Read')]);
      meta.append(read);
    }
    bubble.append(padded(meta));
    padTop(bubble);

    const row = new Gtk.ListBoxRow({
      selectable: false,
      activatable: false,
      marginStart: 12,
      marginEnd: 12,
      // Close inside a run of one sender, apart where a new run opens with its name.
      marginTop: senderBox ? 10 : 2,
      marginBottom: 2,
    });
    // A long message stops short of the pane's full width on a wide window, so a line stays readable.
    const clamp = new Adw.Clamp({ maximumSize: 560, tighteningThreshold: 560, child: card });
    row.set_child(clamp);
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
      reactions,
      badge,
      separator,
      protocolDivider,
      subject: heading,
      sender: senderBox,
      body,
      edited,
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
      one.sender = senderHeading(sender, message);
      one.bubble.prepend(one.sender);
    }
    one.row.set_margin_top(one.sender ? 10 : 2);
    if (one.subject && !subject) {
      one.bubble.remove(one.subject);
      one.subject = null;
    } else if (!one.subject && subject) {
      one.subject = subjectHeading(subject);
      one.bubble.prepend(one.subject);
    }
    padTop(one.bubble);
  };

  const updateBubbleText = (message: ShownMessage): void => {
    const one = built.get(message.id);
    if (!one) return;
    const text = message.bodyText?.trim() ?? '';
    if (one.body) {
      // Remove the old faded overlay; rebuilding it refreshes the "Show more" button state.
      const oldOverlay = one.body.get_parent()?.get_parent();
      if (oldOverlay) one.bubble.remove(oldOverlay);
    }
    const preview = bubbleText(text);
    const body = new Gtk.Label({
      xalign: 0,
      wrap: true,
      wrapMode: Pango.WrapMode.WORD_CHAR,
      selectable: true,
      maxWidthChars: 56,
    });
    setBodyText(body, preview.clipped ? `${preview.text} …` : preview.text);
    one.bubble.insert_before(
      padded(fadedOverlay(body, preview.clipped, () => setBodyText(body, text))),
      one.reactions,
    );
    one.body = body;
    if (message.editedAt && !one.edited) {
      const edited = new Gtk.Label({ label: _('edited'), xalign: 1 });
      edited.add_css_class('caption');
      edited.add_css_class('dim-label');
      one.meta.insert_child_after(edited, one.badge);
      one.edited = edited;
    }
  };

  // Replies in `page` whose quoted message is in none of the `loaded` ones: read it from the index.
  const resolveQuotes = (
    forEntry: ListEntry,
    page: readonly ShownMessage[],
    loaded: readonly ShownMessage[],
  ) => {
    const have = new Set(loaded.map((message) => message.ref.remoteId));
    const wanted = new Set<string>();
    for (const message of page) {
      const target = message.replyToRemoteId;
      if (target && !have.has(target) && !quoteTargets.has(target)) wanted.add(target);
    }
    if (wanted.size === 0) return;
    try {
      for (const target of loadQuoted(forEntry, [...wanted])) {
        if (target.ref.remoteId) quoteTargets.set(target.ref.remoteId, target);
      }
    } catch {
      // The quote just stays out; opening the chat does not depend on it.
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
        const wanted = jumpTo;
        if (wanted !== null) {
          if (built.has(wanted) || exhausted) {
            jumpTo = null;
            scrollToMessage(wanted);
            return;
          }
          loadPage();
          return;
        }
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
        resolveQuotes(shownEntry, fresh, messages);
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
    const text = input.getText().trim();
    const picked = files.files();
    if (edit) {
      if (!text || sending) return;
      sending = true;
      input.setSensitive(false);
      send.set_sensitive(false);
      send.set_child(new Adw.Spinner());
      const { message, originalText, handle } = edit;
      const next = { ...message, bodyText: text, editedAt: new Date().toISOString() };
      updateBubbleText(next);
      clearEdit();
      void onEdit(next, handle, text)
        .then(() => {
          message.bodyText = text;
          message.editedAt = next.editedAt;
          input.setText('');
        })
        .catch((err: unknown) => {
          updateBubbleText({ ...message, bodyText: originalText });
          input.setText(text);
          overlay.add_toast(
            new Adw.Toast({
              title: fmt(_('Message not edited: {error}'), {
                error: err instanceof Error ? err.message : String(err),
              }),
              timeout: 6,
            }),
          );
        })
        .finally(() => {
          sending = false;
          input.setSensitive(true);
          send.set_sensitive(true);
          send.set_icon_name('mail-send-symbolic');
          input.grabFocus();
        });
      return;
    }
    if ((!text && picked.length === 0) || sending || !entry || !selectedChoice) return;
    sending = true;
    input.setSensitive(false);
    send.set_sensitive(false);
    // An upload takes a while: the button shows that something is happening.
    send.set_child(new Adw.Spinner());
    const replyTo = reply && sameCarrier(reply.choice, selectedChoice) ? reply.target : undefined;
    void onSend(text, selectedChoice, picked, replyTo)
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
        input.setText('');
        files.clear();
        clearReply();
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
        input.setSensitive(true);
        send.set_sensitive(true);
        send.set_icon_name('mail-send-symbolic');
        input.grabFocus();
      });
  };
  send.connect('clicked', submit);
  input.onSubmit(submit);

  let lookApplied: string[] = [];
  return {
    page,
    setLook(look) {
      for (const name of lookApplied) toolbar.remove_css_class(name);
      lookApplied = lookClasses(look);
      for (const name of lookApplied) toolbar.add_css_class(name);
      pattern.setPattern(look.background ?? null);
    },
    show(nextEntry, nextMessages, nextLabels) {
      entry = nextEntry;
      rebuildRoute(nextEntry);
      messages = foldAlbums(nextMessages);
      accountLabels = nextLabels;
      title.set_title(nextEntry.title);
      title.set_subtitle(entryProtocolSubtitle(nextEntry));
      contact.set_visible(hasContactPage(nextEntry));
      contactAvatar.set_text(nextEntry.title);
      contactAvatar.set_custom_image(null);
      showPicture(contactAvatar, nextEntry);
      history.remove_all();
      built.clear();
      empty.set_visible(nextMessages.length === 0);
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
      input.setSensitive(blocked === null);
      send.set_sensitive(blocked === null);
      composerBlocked = blocked !== null;
      input.setText('');
      files.clear();
      clearReply();
      clearEdit();
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
      carriers = choices.length > 0 ? choices : only ? [only] : [];
      if (selectedChoice) selectChoice(selectedChoice);
      else updateAttachable();
      const subjects = subjectLabels(messages);
      const starts = dayStarts(messages);
      const senders = senderRunStarts(messages, nextEntry.kind === 'group');
      const runs = protocolRunStarts(messages);
      const dividers = protocolDividers(messages);
      const shown = [...messages];
      quoteTargets.clear();
      jumpTo = null;
      resolveQuotes(nextEntry, shown, shown);
      const run = ++generation;
      // A newer show() ends every older build and page load; their callbacks see the new generation.
      ready = false;
      exhausted = nextMessages.length < PAGE_SIZE;
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
