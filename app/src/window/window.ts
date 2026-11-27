/**
 * The window (docs/design/ui.md): a split view with the combined conversation list as the sidebar
 * and a content pane. At 720 sp and narrower it collapses to one pane. Agent access is not a main
 * area; it opens from the primary menu.
 */

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _, _n, fmt } from '@curlew/protocol';
import { demoActive } from '../core/demo/active.ts';
import type { ConversationMessage } from '@curlew/protocol';

import { indexAccountLabels, loadAccountLabels } from './account-labels.ts';
import {
  SIDEBAR_DEFAULT_MAX,
  SIDEBAR_DEFAULT_MIN,
  SIDEBAR_STEP,
  clampSidebarWidth,
} from './sidebar-width.ts';
import { createUpdateBanner } from './update-banner.ts';
import { presentAccounts } from './accounts-dialog.ts';
import { runDeliveryDaemon } from '../core/actions/daemon.ts';
import { indexSync } from '../core/actions/index-sync.ts';
import { hostReceiveLoop } from '../core/lib/in-process-receive.ts';
import { currentPlatform } from '../core/platform.ts';
import { presentAgentAccess } from './agent-access-dialog.ts';
import {
  listStamp,
  loadConversationEntries,
  loadConversationEntriesAsync,
  searchConversationText,
} from './conversation-list-store.ts';
import { loadSearchMatchIds } from './conversation-store.ts';
import { choiceOfEntry, type ListEntry } from './conversation-list-model.ts';
import { aiEnabled, deltaChatAccountIds, loadConfig, saveConfig } from '../core/config.ts';
import { DEFAULT_SEARCH_SCOPE } from '../core/lib/search-scope.ts';
import { candidateSets } from './merge-candidates-model.ts';
import { sinceStart, timed } from './stall-probe.ts';
import { hasContactPage, presentContactPage } from './contact-page.ts';
import { mentionEntry, mentionName } from './mention-model.ts';
import { presentMergeAssistant } from './merge-assistant.ts';
import {
  peopleChoose,
  peopleDecline,
  peopleMerge,
  peoplePin,
  peopleUnmerge,
} from '../core/actions/people.ts';
import { lookAfter, lookOf } from '../core/contact-choices.ts';
import { createConversationList } from './conversation-list.ts';
import { composeMailReply, senderNameOf } from './conversation-model.ts';
import {
  threadCapabilitiesFor,
  recordConversationRead,
  recordOwnReaction,
  recordOwnEdit,
  recordOwnDeletion,
  loadConversationMessages,
  loadMailReplyTarget,
  loadOlderMessages,
  loadQuotedMessages,
} from './conversation-store.ts';
import { pickedNames } from './composer-files-model.ts';
import { voiceNoteOf } from './voice-recorder-model.ts';
import { applyDaemonAccounts, clearPreviews } from './attachment-store.ts';
import { gioAccountsDaemonSource } from './accounts-daemon.ts';
import { createConversationView } from './conversation-view.ts';
import { createMediaViewer } from './media-viewer.ts';
import { presentNewConversation } from './new-conversation.ts';
import { draftEntry, existingEntry, routeAccounts } from './new-conversation-model.ts';
import { presentPreferences } from './preferences-dialog.ts';
import { presentWelcome } from './welcome.ts';
import { countOwnAccounts, shouldShowWelcome, welcomeStartPage } from './welcome-model.ts';
import { loadAccountsState } from './accounts-store.ts';
import { loadAgentAccess } from './agent-access-store.ts';
import { reactToMessage } from '../core/actions/react.ts';
import { contactsForPicker } from '../core/actions/contacts.ts';
import { sendMessage } from '../core/actions/send.ts';
import { sendReadReceipts } from '../core/actions/read-receipt.ts';
import { syncReadState } from '../core/actions/read-sync.ts';
import { createReadSyncScheduler } from './read-sync-scheduler.ts';
import { deltaChatEnabled } from '../core/actions/accounts.ts';
import { editMessage } from '../core/actions/edit.ts';
import { deleteMessage } from '../core/actions/delete.ts';
import { configPath, indexDbPath, openIndexDb, setChatFavourite, setChatMuted } from '@curlew/store';
import { setConversationFavourite } from '../core/actions/favourite.ts';
import { setConversationMute } from '../core/actions/mute.ts';
import { pollFiles, watchFiles } from './watch.ts';

const COLLAPSE_AT = 'max-width: 720sp';
/** At most one list reload per this many ms while the daemon writes. */
const INDEX_WATCH_MS = 2_000;
async function accountLabels(): Promise<Map<string, string>> {
  try {
    return await loadAccountLabels(loadAgentAccess(configPath()).backends, configPath());
  } catch {
    return indexAccountLabels();
  }
}

function placeholder(): Adw.NavigationPage {
  const status = new Adw.StatusPage({
    iconName: 'view-dual-symbolic',
    title: _('Select a conversation'),
    description: _('Pick a conversation from the list.'),
  });
  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(new Adw.HeaderBar());
  toolbar.set_content(status);
  const page = new Adw.NavigationPage({ title: _('Curlew'), tag: 'content' });
  page.set_child(toolbar);
  return page;
}

export interface WindowOptions {
  /** Start with this protocol chip on (the screenshot hook `CURLEW_WINDOW_FILTER`). */
  protocol?: string;
  /** Open the search with this text (the screenshot hook `CURLEW_WINDOW_SEARCH`). */
  search?: string;
  /** Start the selection mode with this many conversations picked (`CURLEW_WINDOW_SELECT`). */
  select?: number;
  /** Also open the search scope menu (`CURLEW_WINDOW_OPEN_SCOPE`). */
  openScope?: boolean;
  /** Open this conversation at start (the screenshot hook `CURLEW_WINDOW_OPEN`). */
  open?: string;
  /**
   * Open these conversations in turn, one per {@link WindowOptions.scriptMs} (the perf hook
   * `CURLEW_WINDOW_SWITCH`). Switching chat is the move that froze the window (#541), and
   * opening one chat at start does not measure it: the list is still being built then.
   */
  switchTo?: readonly string[];
  /** Type this into the search one character at a time (the perf hook `CURLEW_WINDOW_TYPE`). */
  typeSearch?: string;
  /** Milliseconds between the driven steps above (`CURLEW_WINDOW_SCRIPT_MS`). */
  scriptMs?: number;
}

/** How long to wait for that frame before giving up on it (see `onNextPaint`). */
const PAINT_WAIT_MS = 1000;

/**
 * Runs `done` once the next frame has actually been painted.
 *
 * There is no frame clock before the window is mapped, and a compositor that never maps it would
 * leave `done` uncalled -- which a reader of the log cannot tell apart from a window that never
 * came up. So the frame is waited for, but not forever.
 */
function onNextPaint(widget: Gtk.Widget, done: () => void): void {
  let fired = false;
  const once = () => {
    if (fired) return;
    fired = true;
    done();
  };
  const clock = widget.get_frame_clock();
  if (clock) {
    const painted = clock.connect('after-paint', () => {
      clock.disconnect(painted);
      once();
    });
    widget.queue_draw();
  }
  GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, PAINT_WAIT_MS, () => {
    once();
    return GLib.SOURCE_REMOVE;
  });
}

/**
 * A thin handle on the edge between the list and the chat: drag to resize, double-click or Home to
 * reset, Left/Right to nudge. Adw.NavigationSplitView has no resize of its own, so the handle sets
 * the split view's min and max width to the dragged value. It shows only while the split is not
 * collapsed, where the list has a width of its own.
 */
function createSidebarHandle(split: Adw.NavigationSplitView, page: Gtk.Widget): Gtk.Widget[] {
  const HANDLE = 8;
  const rtl = Gtk.Widget.get_default_direction() === Gtk.TextDirection.RTL;
  const handle = new Gtk.Box({
    accessibleRole: Gtk.AccessibleRole.SEPARATOR,
    halign: rtl ? Gtk.Align.END : Gtk.Align.START,
    widthRequest: HANDLE,
    focusable: true,
    cursor: Gdk.Cursor.new_from_name('col-resize', null),
    visible: false,
  });
  handle.update_property(
    [Gtk.AccessibleProperty.LABEL],
    [GLib.Variant.new_string(_('Resize the conversation list'))],
  );
  handle.set_tooltip_text(_('Drag to resize the conversation list. Double-click to reset.'));

  let wanted = loadConfig(configPath()).ui.sidebarWidth;
  const apply = (width: number | undefined) => {
    const next = width === undefined ? undefined : clampSidebarWidth(width, split.get_width());
    const min = next ?? SIDEBAR_DEFAULT_MIN;
    const max = next ?? SIDEBAR_DEFAULT_MAX;
    if (split.minSidebarWidth !== min) split.set_min_sidebar_width(min);
    if (split.maxSidebarWidth !== max) split.set_max_sidebar_width(max);
  };
  const save = () => {
    const config = loadConfig(configPath());
    if (wanted === undefined) delete config.ui.sidebarWidth;
    else config.ui.sidebarWidth = wanted;
    saveConfig(config, configPath());
  };
  // The edge follows the list's real width, read after layout: only when the window resizes, the
  // split collapses or the width changes, never per frame.
  let pending = 0;
  const update = () => {
    pending = 0;
    handle.set_visible(!split.collapsed);
    if (split.collapsed) return GLib.SOURCE_REMOVE;
    apply(wanted);
    const edge = rtl ? split.get_width() - page.get_width() : page.get_width();
    const margin = Math.max(0, Math.round(edge - HANDLE / 2));
    if (rtl) {
      if (handle.marginEnd !== margin) handle.set_margin_end(margin);
    } else if (handle.marginStart !== margin) handle.set_margin_start(margin);
    return GLib.SOURCE_REMOVE;
  };
  const updateSoon = () => {
    if (pending === 0) pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, update);
  };
  const set = (width: number | undefined) => {
    wanted = width === undefined ? undefined : clampSidebarWidth(width, split.get_width());
    apply(wanted);
    updateSoon();
  };
  apply(wanted);
  split.connect('notify::collapsed', updateSoon);
  // An invisible, untargetable sibling the size of the split view: its resize is the window's.
  const probe = new Gtk.DrawingArea({ canTarget: false, canFocus: false });
  probe.connect('resize', updateSoon);
  handle.connect('destroy', () => {
    if (pending !== 0) GLib.source_remove(pending);
    pending = 0;
  });

  const drag = new Gtk.GestureDrag();
  let startX = 0;
  drag.connect('drag-begin', (_g, x) => {
    startX = x;
    handle.grab_focus();
  });
  drag.connect('drag-update', (_g, offsetX) => {
    // The handle moves under the pointer, so read the pointer in the split view's coordinates.
    const [ok, x] = handle.translate_coordinates(split, startX + offsetX, 0);
    if (ok) set(rtl ? split.get_width() - x : x);
  });
  drag.connect('drag-end', save);
  handle.add_controller(drag);

  const click = new Gtk.GestureClick();
  click.connect('pressed', (_g, presses) => {
    if (presses !== 2) return;
    set(undefined);
    save();
  });
  handle.add_controller(click);

  const keys = new Gtk.EventControllerKey();
  keys.connect('key-pressed', (_c, keyval) => {
    const current = page.get_width();
    const sign = rtl ? -1 : 1;
    if (keyval === Gdk.KEY_Left) set(current - sign * SIDEBAR_STEP);
    else if (keyval === Gdk.KEY_Right) set(current + sign * SIDEBAR_STEP);
    else if (keyval === Gdk.KEY_Home) set(undefined);
    else return false;
    save();
    return true;
  });
  handle.add_controller(keys);
  return [probe, handle];
}

export function createWindow(app: Adw.Application, options: WindowOptions = {}): Adw.ApplicationWindow {
  return timed('createWindow', () => createWindowInner(app, options));
}

function createWindowInner(app: Adw.Application, options: WindowOptions): Adw.ApplicationWindow {
  const window = new Adw.ApplicationWindow({
    application: app,
    title: _('Curlew'),
    defaultWidth: 900,
    defaultHeight: 640,
    widthRequest: 360,
  });

  const split = new Adw.NavigationSplitView({
    minSidebarWidth: SIDEBAR_DEFAULT_MIN,
    maxSidebarWidth: SIDEBAR_DEFAULT_MAX,
    sidebarWidthFraction: 0.35,
  });

  const menu = new Gio.Menu();
  menu.append(_('Accounts'), 'win.accounts');
  menu.append(_('Merge contacts…'), 'win.merge-contacts');
  menu.append(_('Preferences'), 'win.preferences');
  // Hidden while AI features are off: the item follows the action's enabled state.
  const agentItem = Gio.MenuItem.new(_('Agent access'), 'win.agent-access');
  agentItem.set_attribute_value('hidden-when', GLib.Variant.new_string('action-disabled'));
  menu.append_item(agentItem);
  menu.append(_('Welcome'), 'win.welcome');
  const appSection = new Gio.Menu();
  appSection.append(_('About Curlew'), 'app.about');
  appSection.append(_('Quit'), 'app.quit');
  menu.append_section(null, appSection);

  // Fetched attachments are message content; an earlier run's leftovers go before this one's.
  if (!process.env.CURLEW_PREVIEWS_DIR) clearPreviews();
  // A logged-out account's attachments say so without a fetch; the mark goes when the daemon reports it again.
  const stopAccountWatch = gioAccountsDaemonSource().start((state) =>
    applyDaemonAccounts(state.accounts.values()),
  );
  window.connect('destroy', stopAccountWatch);
  const viewer = createMediaViewer(
    (title) => toasts.add_toast(new Adw.Toast({ title, timeout: 4 })),
    (shown) => split.set_sensitive(!shown),
  );

  const openContact = (entry: ListEntry): void => {
    presentContactPage(
      window,
      entry,
      choiceOfEntry(loadConfig().contactChoices, entry)?.choice ?? {},
      labels,
      {
        choose: (ids, patch) => {
          const before = loadConfig().contactChoices;
          peopleChoose(ids, patch);
          // The chat behind the open page follows each pick at once, not after the page closes.
          if (currentEntry?.id === entry.id) conversation.setLook(lookAfter(before, ids, patch));
        },
        separate: (ids) => {
          peopleUnmerge(ids);
          refresh();
        },
        closed: () => {
          refresh();
          // The rebuilt row replaces this one; open it again so the header follows the choice.
          const again = shown.find((e) => e.id === entry.id);
          if (again && currentEntry?.id === entry.id) select(again);
        },
      },
    );
  };

  let currentEntry: ListEntry | null = null;
  // The open chat the person marked unread by hand stays unread until another one is opened.
  let keptUnread: string | null = null;
  let currentMessages: ConversationMessage[] = [];
  const conversation = createConversationView(
    async (text, choice, files, clientId, replyTo) => {
      const entry = currentEntry;
      if (!entry) throw new Error(_('This conversation has no recipient address.'));
      // The carrier's own last message: a mail reply must not thread onto a Signal note.
      // A reply by mail names its message (`replyTo.remoteId` is the message id there).
      const answered =
        choice.backend === 'mail' && replyTo
          ? currentMessages.find((m) => m.id === replyTo.remoteId)
          : undefined;
      const parent =
        answered ??
        [...currentMessages]
          .reverse()
          .find((m) => m.backend === choice.backend && m.ref.accountId === choice.accountId) ??
        null;
      const mail =
        choice.backend === 'mail'
          ? composeMailReply(
              parent,
              loadMailReplyTarget(parent),
              text,
              deltaChatEnabled(choice.accountId),
              senderNameOf(labels.get(choice.accountId)),
              loadConfig().ui.sendReadReceipts === true,
            )
          : null;
      const result = await sendMessage({
        accountId: choice.accountId,
        to: choice.target,
        text,
        frontend: 'window',
        // The name the pending bubble is keyed by (ADR 0021 §2), so the answer finds it again.
        clientId,
        ...(files.length > 0 ? { attachments: files.map((f) => f.path) } : {}),
        ...(replyTo && mail === null ? { replyTo } : {}),
        ...mail,
        ...(mail?.emailChat && voiceNoteOf(files)
          ? { voiceMessage: true, durationMs: voiceNoteOf(files)!.durationMs }
          : {}),
      });
      return {
        id: result.originId,
        conversationId: parent?.conversationId ?? entry.conversationIds[0] ?? entry.id,
        backend: choice.backend,
        presentation: 'bubble',
        senderId: null,
        senderName: null,
        senderAddress: null,
        fromSelf: true,
        sentAt: result.sentAt,
        subject: mail?.subject ?? null,
        seen: true,
        hasAttachments: false,
        emailChat: mail?.emailChat === true,
        classification: 'conversational',
        classificationReason: 'self',
        // A chat network's id for the message is what the next reply to it points at.
        ref: {
          accountId: choice.accountId,
          backend: choice.backend,
          ...(mail === null ? { remoteId: result.originId } : {}),
        },
        ...(mail === null ? { clientId: result.originId } : {}),
        ...(replyTo && mail === null ? { replyToRemoteId: replyTo.remoteId } : {}),
        bodyText: text || pickedNames(files),
      };
    },
    (facts) => threadCapabilitiesFor(facts),
    async (message, handle, change) => {
      await reactToMessage({
        accountId: handle.choice.accountId,
        to: handle.choice.target,
        target: handle.target,
        emoji: change.emoji,
        ...(change.previous === undefined ? {} : { previous: change.previous }),
        frontend: 'window',
      });
      recordOwnReaction(message.id, change.emoji);
    },
    async (message, handle, text) => {
      await editMessage({
        accountId: handle.choice.accountId,
        to: handle.choice.target,
        target: handle.target,
        text,
        frontend: 'window',
      });
      recordOwnEdit(message.id, text);
    },
    async (message, handle) => {
      await deleteMessage({
        accountId: handle.choice.accountId,
        to: handle.choice.target,
        target: handle.target,
        frontend: 'window',
      });
      recordOwnDeletion(message.id);
    },
    (entry, oldest) => loadOlderMessages(entry, oldest),
    (entry, remoteIds) => loadQuotedMessages(entry, remoteIds),
    (source, kind, album) => viewer.open(source, kind, album),
    (entry, backend) => {
      peoplePin(entry.personIds, backend);
      refresh();
      // The rebuilt row replaces this one; open it again so the header and composer follow the pin.
      const again = shown.find((e) => e.id === entry.id);
      if (again) select(again);
    },
    (entry) => openContact(entry),
    {
      nameOf: (backend, mention) => mentionName(shown, backend, mention),
      open: (backend, mention, name) => {
        const person = mentionEntry(shown, backend, mention);
        if (person && hasContactPage(person)) {
          openContact(person);
          return;
        }
        // Someone the index has no chat with: just who the network says it is.
        const dialog = new Adw.AlertDialog({
          heading: name || mention.userId,
          body: name ? mention.userId : _('No further details are known about this person.'),
        });
        dialog.add_response('close', _('Close'));
        dialog.present(window);
      },
    },
  );
  // The local read position is the window's; the network half goes out after a quiet moment (#441).
  const readSync = createReadSyncScheduler(
    {
      set: (run, ms) =>
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
          run();
          return GLib.SOURCE_REMOVE;
        }),
      clear: (handle) => GLib.source_remove(handle as number),
    },
    (line) => console.warn(line),
  );
  // The flag is written locally first (what the list shows), then pushed where the network keeps one.
  const muteConversation = async (
    e: ListEntry,
    mute: { muted: boolean; until: string | null },
  ): Promise<void> => {
    const db = openIndexDb(indexDbPath(), { busyTimeoutMs: 300 });
    try {
      for (const id of e.conversationIds) {
        if (e.target === null) {
          setChatMuted(db, id, { muted: mute.muted, until: mute.until });
          continue;
        }
        await setConversationMute({
          db,
          conversationId: id,
          accountId: e.accountId,
          to: e.target,
          mute,
          frontend: 'window',
        });
      }
    } catch {
      // A busy index must not break the list; the flag is local either way.
    } finally {
      db.close();
    }
  };
  // Starred like muted: local first, then the network's pin. A full network keeps the star here and
  // says so once per run (ADR 0020 §6).
  let toldPinsFull = false;
  const favouriteConversation = async (e: ListEntry, favourite: boolean): Promise<void> => {
    const db = openIndexDb(indexDbPath(), { busyTimeoutMs: 300 });
    try {
      for (const id of e.conversationIds) {
        if (e.target === null) {
          setChatFavourite(db, id, { favourite });
          continue;
        }
        const outcome = await setConversationFavourite({
          db,
          conversationId: id,
          accountId: e.accountId,
          to: e.target,
          favourite,
          frontend: 'window',
        });
        if (outcome.kind === 'full' && !toldPinsFull) {
          toldPinsFull = true;
          toasts.add_toast(
            new Adw.Toast({
              title:
                outcome.limit === null
                  ? _('This network has no free pin left, so the favourite stays in Curlew only.')
                  : fmt(
                      _n(
                        'This network allows {count} pinned chat, so the favourite stays in Curlew only.',
                        'This network allows {count} pinned chats, so the favourite stays in Curlew only.',
                        outcome.limit,
                      ),
                      { count: outcome.limit },
                    ),
              timeout: 6,
            }),
          );
        }
      }
    } catch {
      // A busy index must not break the list; the star is local either way.
    } finally {
      db.close();
    }
  };
  const scheduleReadSync = (picked: readonly ListEntry[]): void => {
    if (loadConfig().ui.syncReadState === false) return;
    for (const e of picked.flatMap((p) => (p.members.length > 0 ? p.members : [p]))) {
      const to = e.target;
      if (to === null) continue;
      readSync.schedule(e.id, () =>
        syncReadState({ accountId: e.accountId, conversationIds: e.conversationIds, to, frontend: 'window' }),
      );
    }
  };
  // Opening a Delta Chat conversation answers the receipts its messages asked for (setting permitting).
  const confirmRead = (messages: readonly ConversationMessage[]): void => {
    if (loadConfig().ui.sendReadReceipts !== true) return;
    const carriers = new Map<string, Set<string>>();
    for (const m of messages) {
      if (m.backend !== 'mail' || !m.emailChat || m.fromSelf) continue;
      const ids = carriers.get(m.ref.accountId) ?? new Set<string>();
      ids.add(m.conversationId);
      carriers.set(m.ref.accountId, ids);
    }
    for (const [accountId, ids] of carriers) {
      for (const conversationId of ids) {
        // Fire and forget: a failed receipt must not disturb opening the conversation.
        void sendReadReceipts({ accountId, conversationId, frontend: 'window' }).catch(() => {});
      }
    }
  };
  // The text the sidebar is searching for; an opened conversation steps through its matches.
  let activeSearch = '';
  const select = (entry: ListEntry) => {
    currentEntry = entry;
    keptUnread = null;
    currentMessages = timed('load messages', () => loadConversationMessages(entry));
    timed('conversation.show', () => conversation.show(entry, currentMessages, labels));
    conversation.setSearch(activeSearch, activeSearch === '' ? [] : loadSearchMatchIds(entry, activeSearch));
    timed('setLook', () =>
      conversation.setLook(lookOf(choiceOfEntry(loadConfig().contactChoices, entry)?.choice)),
    );
    timed('set_content', () => {
      split.set_content(conversation.page);
      split.set_show_content(true);
    });
    timed('confirmRead', () => confirmRead(currentMessages));
  };
  // A contact with no conversation opens as a draft row; the index gets the real one with the first send.
  const selectDraft = (entry: ListEntry) => {
    currentEntry = entry;
    currentMessages = [];
    conversation.show(entry, currentMessages, labels);
    conversation.setSearch('', []);
    conversation.setLook(lookOf(choiceOfEntry(loadConfig().contactChoices, entry)?.choice));
    split.set_content(conversation.page);
    split.set_show_content(true);
  };
  const startConversation = () => {
    const routes = routeAccounts(shown, deltaChatAccountIds(loadConfig()));
    timed('present new conversation', () =>
      presentNewConversation(window, routes, contactsForPicker, (contact) => {
        const existing = existingEntry(shown, contact);
        if (existing) {
          select(existing);
          return;
        }
        const draft = draftEntry(contact, routes);
        if (draft) selectDraft(draft);
      }),
    );
  };
  const sidebar = createConversationList(menu, select, () => presentAccounts(window), {
    merge: (ids) => {
      peopleMerge(ids);
      refresh();
    },
    unmerge: (ids) => {
      peopleUnmerge(ids);
      refresh();
    },
    setRead: (picked, read) => {
      const ids = picked.flatMap((e) => (e.members.length > 0 ? e.members : [e]).map((m) => m.id));
      try {
        recordConversationRead(ids, read);
        if (read) scheduleReadSync(picked);
      } catch {
        // A busy index must not break the list; the next try works.
      }
      if (!read && currentEntry && picked.some((e) => e.id === currentEntry?.id))
        keptUnread = currentEntry.id;
      refresh();
    },
    setMute: (picked, mute) => {
      for (const e of picked.flatMap((p) => (p.members.length > 0 ? p.members : [p]))) {
        void muteConversation(e, mute).then(refresh);
      }
    },
    setFavourite: (picked, favourite) => {
      for (const e of picked.flatMap((p) => (p.members.length > 0 ? p.members : [p]))) {
        void favouriteConversation(e, favourite).then(refresh);
      }
    },
    review: () => review(),
    compose: () => startConversation(),
    searchText: (text) => searchConversationText(text),
    searchChanged: (text) => {
      activeSearch = text;
      if (currentEntry)
        conversation.setSearch(text, text === '' ? [] : loadSearchMatchIds(currentEntry, text));
    },
    searchScope: () => loadConfig(configPath()).ui.searchScope ?? DEFAULT_SEARCH_SCOPE,
    setSearchScope: (scope) => {
      const config = loadConfig(configPath());
      config.ui.searchScope = scope;
      saveConfig(config, configPath());
    },
  });
  split.set_sidebar(sidebar.page);
  split.set_content(placeholder());

  const breakpoint = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse(COLLAPSE_AT) });
  breakpoint.add_setter(split, 'collapsed', true);
  window.add_breakpoint(breakpoint);
  // The viewer is a sibling of the split view, over it, as in Fractal; the toasts sit above both.
  const stage = new Gtk.Overlay({ child: split });
  stage.add_overlay(viewer.widget);
  for (const overlay of createSidebarHandle(split, sidebar.page)) stage.add_overlay(overlay);
  const toasts = new Adw.ToastOverlay({ child: stage });
  const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  toasts.set_vexpand(true);
  column.append(createUpdateBanner(app));
  column.append(toasts);
  window.set_content(column);
  // No systemd or session bus here: the window receives while it is open (ADR 0002 stays the loop)
  // and runs the periodic pull sync itself (ADR 0002 §8) — the action's own ticker is off, because
  // two tickers in one process would hold the index-writer lease under the same holder.
  const receiver = demoActive()
    ? null
    : hostReceiveLoop(
        currentPlatform(),
        (params) => runDeliveryDaemon({ ...params, pullSync: null }),
        (line) => console.error(line),
        { pullSync: () => indexSync() },
      );
  if (receiver) window.connect('destroy', () => void receiver.stop());
  // Demo data must never pass for a real inbox: say so once, then stay out of the way.
  if (demoActive()) {
    window.title = _('Curlew (demo)');
    // `CURLEW_DEMO_QUIET=1` leaves the notice out, so a listing screenshot shows the window alone.
    if (process.env.CURLEW_DEMO_QUIET !== '1')
      toasts.add_toast(new Adw.Toast({ title: _('Demo data — nothing here is real'), timeout: 5 }));
  }
  viewer.install(window);

  const accounts = new Gio.SimpleAction({ name: 'accounts' });
  accounts.connect('activate', () =>
    timed('present accounts', () =>
      presentAccounts(window, {
        openAccount: process.env.CURLEW_WINDOW_OPEN_ACCOUNT || undefined,
        openAdd: process.env.CURLEW_WINDOW_OPEN_ADD || undefined,
      }),
    ),
  );
  const protocols = new Gio.SimpleAction({ name: 'protocols' });
  protocols.connect('activate', () =>
    timed('present protocols', () => presentAccounts(window, { openProtocols: true })),
  );
  window.add_action(protocols);
  window.add_action(accounts);
  const mergeContacts = new Gio.SimpleAction({ name: 'merge-contacts' });
  mergeContacts.connect('activate', () => review());
  window.add_action(mergeContacts);
  const action = new Gio.SimpleAction({ name: 'agent-access' });
  action.connect('activate', () => timed('present access', () => presentAgentAccess(window)));
  const syncAi = () => action.set_enabled(aiEnabled(loadConfig(configPath())));
  syncAi();
  window.add_action(action);
  const preferences = new Gio.SimpleAction({ name: 'preferences' });
  preferences.connect('activate', () =>
    timed('present preferences', () =>
      presentPreferences(
        window,
        () => {
          currentEntry = null;
          currentMessages = [];
          split.set_content(placeholder());
          refresh();
        },
        syncAi,
      ),
    ),
  );
  window.add_action(preferences);
  const welcome = new Gio.SimpleAction({ name: 'welcome' });
  welcome.connect('activate', () => timed('present welcome', () => presentWelcome(window, () => refresh())));
  window.add_action(welcome);
  // The screenshot hook `CURLEW_WINDOW_OPEN_WELCOME=<page>` opens one page directly.
  const welcomePage = new Gio.SimpleAction({
    name: 'welcome-page',
    parameterType: GLib.VariantType.new('s'),
  });
  welcomePage.connect('activate', (_a, parameter) => {
    const start = welcomeStartPage(parameter?.get_string()[0]);
    presentWelcome(window, () => refresh(), start);
  });
  window.add_action(welcomePage);

  let labels = indexAccountLabels();
  let labelled = false;
  let shown: ListEntry[] = [];
  let stamp = '';
  let suggestionsIdle = 0;
  let activationIdle = 0;
  let refreshRun = 0;
  let loading = false;
  let changedWhileLoading = false;
  let liveNext = false;
  let liveIdle = 0;
  let liveRetry = 0;
  const pendingLoad: Array<() => void> = [];
  const refresh = () => {
    stamp = listStamp();
    const run = ++refreshRun;
    loading = true;
    // Read in slices so the window keeps painting; a newer refresh abandons this one.
    void loadConversationEntriesAsync(() => run !== refreshRun).then((loaded) => {
      if (run !== refreshRun) return;
      loading = false;
      if (changedWhileLoading) {
        changedWhileLoading = false;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => (indexChanged(), GLib.SOURCE_REMOVE));
      }
      if (loaded === null) return;
      shown = loaded;
      timed('set entries', () => sidebar.setEntries(shown, labels));
      // The duplicate scan is only a banner: it runs when the loop is idle, once per burst of refreshes.
      if (suggestionsIdle) GLib.source_remove(suggestionsIdle);
      suggestionsIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        suggestionsIdle = 0;
        timed('candidate sets', () =>
          sidebar.setSuggestions(candidateSets(shown, loadConfig(configPath()).declinedMerges).length),
        );
        return GLib.SOURCE_REMOVE;
      });
      pendingLoad.forEach((done) => done());
      pendingLoad.length = 0;
      if (liveNext) {
        liveNext = false;
        followOpenChat();
      }
    });
  };
  // The open chat takes what the daemon wrote: one read of the newest page per burst of changes,
  // merged in place, so the scroll position, the composer and open menus stay as they are.
  const followOpenChat = () => {
    if (liveIdle || !currentEntry) return;
    liveIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      liveIdle = 0;
      const open = currentEntry;
      const entry = open && shown.find((e) => e.id === open.id);
      if (!entry || !window.get_mapped()) return GLib.SOURCE_REMOVE;
      let loaded: ConversationMessage[];
      try {
        loaded = timed('live messages', () => loadConversationMessages(entry));
      } catch {
        return GLib.SOURCE_REMOVE;
      }
      const result = conversation.update(loaded);
      if (result === 'busy') {
        liveNext = true;
        if (liveRetry) GLib.source_remove(liveRetry);
        liveRetry = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
          liveRetry = 0;
          followOpenChat();
          return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
      }
      const known = new Set(currentMessages.map((m) => m.id));
      // A late arrival (sent offline, older timestamp) is common; select() would empty the
      // composer and pull a phone back from the list into the chat.
      if (result === 'rebuild') conversation.show(entry, loaded, labels, true);
      currentEntry = entry;
      currentMessages = loaded;
      confirmRead(loaded.filter((m) => !known.has(m.id)));
      return GLib.SOURCE_REMOVE;
    });
  };
  // A change the daemon writes while the window is in front. A load still running finishes first:
  // restarting it on every change would starve the list during a long catch-up on a slow phone.
  const indexChanged = () => {
    if (!window.get_mapped() || listStamp() === stamp) return;
    liveNext = true;
    if (loading) changedWhileLoading = true;
    else refresh();
  };
  const review = () => {
    const sets = candidateSets(shown, loadConfig(configPath()).declinedMerges);
    if (sets.length === 0) {
      toasts.add_toast(new Adw.Toast({ title: _('No contacts to merge'), timeout: 3 }));
      return;
    }
    presentMergeAssistant(window, sets, labels, {
      merge: (ids) => peopleMerge(ids),
      decline: (ids) => peopleDecline(ids),
      closed: () => refresh(),
    });
  };
  // The window paints its empty shell first; the list loads on the next idle turn.
  const firstLoad = new Promise<void>((resolve) => {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      pendingLoad.push(() => {
        if (options.protocol) sidebar.chooseProtocol(options.protocol);
        // The counterpart of `curlew window: shown`. The list now HOLDS what the index had, but
        // holding is not showing: the frame that draws these rows is still to come, the person
        // waits through it, and it is GTK's work rather than the list's -- 180 ms of it where
        // there is no GPU. So cold start ends with that frame, not with the read, and the
        // responsiveness budget applies to what the window does afterwards (dev/perf-report.mjs).
        onNextPaint(window, () => {
          console.log(`curlew window: ready at ${sinceStart().toFixed(0)}`);
          resolve();
        });
      });
      refresh();
      return GLib.SOURCE_REMOVE;
    });
  });
  let searchHook = 0;
  if (options.search !== undefined)
    searchHook = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
      searchHook = 0;
      sidebar.showSearch(options.search!, options.openScope === true);
      return GLib.SOURCE_REMOVE;
    });
  if (options.select)
    GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      800,
      () => (sidebar.pickFirst(options.select!), GLib.SOURCE_REMOVE),
    );
  // A notification, or the screenshot hook, names a chat by its conversation id or its row id.
  const openConversation = (id: string): void => {
    const match = (e: ListEntry) => e.id === id || e.conversationIds.includes(id);
    const entry = shown.find(match) ?? loadConversationEntries().find(match);
    if (entry) select(entry);
  };
  const openAction = new Gio.SimpleAction({
    name: 'open-conversation',
    parameterType: GLib.VariantType.new('s'),
  });
  openAction.connect('activate', (_a, parameter) => {
    if (parameter) openConversation(parameter.get_string()[0]);
    window.present();
  });
  window.add_action(openAction);
  // The perf script: one move per tick, each named, so every stall the probe reports after it
  // belongs to exactly one move (#501). Idle outside the measurement harness.
  const steps: Array<[string, () => void]> = [
    ...(options.switchTo ?? []).map((id): [string, () => void] => [
      'switch chat',
      () => openConversation(id),
    ]),
    ...[...(options.typeSearch ?? '')].map((_c, i): [string, () => void] => [
      'search keystroke',
      () => sidebar.showSearch(options.typeSearch!.slice(0, i + 1), false),
    ]),
  ];
  let scriptHook = 0;
  if (steps.length > 0) {
    let at = 0;
    scriptHook = GLib.timeout_add(GLib.PRIORITY_DEFAULT, options.scriptMs ?? 1200, () => {
      const step = steps[at++];
      if (step === undefined) {
        scriptHook = 0;
        return GLib.SOURCE_REMOVE;
      }
      timed(step[0], step[1]);
      return GLib.SOURCE_CONTINUE;
    });
  }
  const contactAction = new Gio.SimpleAction({ name: 'open-contact' });
  contactAction.connect('activate', () => {
    if (currentEntry) openContact(currentEntry);
  });
  window.add_action(contactAction);
  const newConversationAction = new Gio.SimpleAction({ name: 'new-conversation' });
  newConversationAction.connect('activate', () => startConversation());
  window.add_action(newConversationAction);
  const emojiAction = new Gio.SimpleAction({ name: 'open-emoji' });
  emojiAction.connect('activate', () => conversation.openEmoji());
  window.add_action(emojiAction);
  const bubbleAction = new Gio.SimpleAction({ name: 'open-bubble-menu' });
  bubbleAction.connect('activate', () => conversation.openBubbleMenu());
  window.add_action(bubbleAction);
  if (options.open) void firstLoad.then(() => openConversation(options.open!));
  // First start only: the flag says it was finished, and anybody with accounts of their own is not new.
  void (async () => {
    try {
      const path = configPath();
      if (loadConfig(path).ui.welcomeDone === true) return;
      const count = countOwnAccounts(await loadAccountsState(path));
      if (shouldShowWelcome(loadConfig(path).ui.welcomeDone, count)) welcome.activate(null);
    } catch {
      // No welcome screen is better than a broken window.
    }
  })();
  // The index changes as the daemon syncs; coming back to the window is the cheap moment to look.
  window.connect('notify::is-active', () => {
    if (!window.is_active || listStamp() === stamp || activationIdle) return;
    // Let the window paint and take its first click before the list is reloaded.
    activationIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      activationIdle = 0;
      if (listStamp() !== stamp) refresh();
      return GLib.SOURCE_REMOVE;
    });
  });
  // Reading the open chat marks it read: window active, newest message in view, a moment of looking.
  // A poll, not a signal, so a message that lands while the person watches the end counts as read too.
  const READ_AFTER_MS = 1500;
  let lookedSince = 0;
  const readPoll = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 500, () => {
    const open = currentEntry;
    const entry = open && shown.find((e) => e.id === open.id);
    // On a phone the split is collapsed and going back shows the list while the chat stays current.
    const chatShown = !split.collapsed || split.show_content;
    const watching =
      entry &&
      window.is_active &&
      window.get_mapped() &&
      chatShown &&
      conversation.isAtEnd() &&
      keptUnread !== entry.id;
    if (!entry || !watching || entry.unread === 0) {
      lookedSince = 0;
      return GLib.SOURCE_CONTINUE;
    }
    const now = GLib.get_monotonic_time() / 1000;
    if (lookedSince === 0) lookedSince = now;
    if (now - lookedSince < READ_AFTER_MS) return GLib.SOURCE_CONTINUE;
    lookedSince = 0;
    try {
      recordConversationRead(
        (entry.members.length > 0 ? entry.members : [entry]).map((m) => m.id),
        true,
      );
      scheduleReadSync([entry]);
      refresh();
    } catch {
      // Busy index: tried again on the next tick.
    }
    return GLib.SOURCE_CONTINUE;
  });
  // A phone shows one window that never loses focus, so the activation check above never runs
  // there: a new account's catch-up or an arriving message stayed out of the list until restart.
  const dbPath = indexDbPath();
  const stopIndexWatch = pollFiles([dbPath, `${dbPath}-wal`], indexChanged, INDEX_WATCH_MS);
  const stopConfigWatch = watchFiles(
    GLib.path_get_dirname(configPath()),
    [GLib.path_get_basename(configPath())],
    indexChanged,
    INDEX_WATCH_MS,
  );
  window.connect('destroy', () => {
    // Nothing may fire into the destroyed window: the poll, the retries and the pending idles.
    for (const id of [readPoll, liveRetry, searchHook, scriptHook, suggestionsIdle, activationIdle, liveIdle])
      if (id !== 0) GLib.source_remove(id);
    readSync.cancelAll();
    stopIndexWatch();
    stopConfigWatch();
  });
  if (!labelled) {
    labelled = true;
    void accountLabels().then((found) => {
      // The index already named the accounts; a second full rebuild only when a name differs.
      const same = found.size === labels.size && [...found].every(([k, v]) => labels.get(k) === v);
      labels = found;
      if (!same) refresh();
    });
  }
  return window;
}
