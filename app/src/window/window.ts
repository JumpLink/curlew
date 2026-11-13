/**
 * The window (docs/design/ui.md): a split view with the combined conversation list as the sidebar
 * and a content pane. At 720 sp and narrower it collapses to one pane. Agent access is not a main
 * area; it opens from the primary menu.
 */

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';
import { demoActive } from '../core/demo/active.ts';
import type { ConversationMessage } from '@curlew/protocol';

import { indexAccountLabels, loadAccountLabels } from './account-labels.ts';
import { presentAccounts } from './accounts-dialog.ts';
import { presentAgentAccess } from './agent-access-dialog.ts';
import { listStamp, loadConversationEntries, searchConversationText } from './conversation-list-store.ts';
import { choiceOfEntry, type ListEntry } from './conversation-list-model.ts';
import { aiEnabled, loadConfig, saveConfig } from '../core/config.ts';
import { DEFAULT_SEARCH_SCOPE } from '../core/lib/search-scope.ts';
import { candidateSets } from './merge-candidates-model.ts';
import { presentContactPage } from './contact-page.ts';
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
import { clearPreviews } from './attachment-store.ts';
import { createConversationView } from './conversation-view.ts';
import { createMediaViewer } from './media-viewer.ts';
import { presentNewConversation } from './new-conversation.ts';
import { draftEntry, existingEntry, routeAccounts } from './new-conversation-model.ts';
import { presentPreferences } from './preferences-dialog.ts';
import { presentWelcome } from './welcome.ts';
import { countAccounts, shouldShowWelcome, welcomeStartPage } from './welcome-model.ts';
import { loadAccountsState } from './accounts-store.ts';
import { inSandbox } from '../core/lib/sandbox.ts';
import { loadAgentAccess } from './agent-access-store.ts';
import { reactToMessage } from '../core/actions/react.ts';
import { contactsForPicker } from '../core/actions/contacts.ts';
import { sendMessage } from '../core/actions/send.ts';
import { sendReadReceipts } from '../core/actions/read-receipt.ts';
import { deltaChatEnabled } from '../core/actions/accounts.ts';
import { editMessage } from '../core/actions/edit.ts';
import { deleteMessage } from '../core/actions/delete.ts';
import { configPath } from '@curlew/store';

const COLLAPSE_AT = 'max-width: 720sp';
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
  /** Also open the search scope menu (`CURLEW_WINDOW_OPEN_SCOPE`). */
  openScope?: boolean;
  /** Open this conversation at start (the screenshot hook `CURLEW_WINDOW_OPEN`). */
  open?: string;
}

export function createWindow(app: Adw.Application, options: WindowOptions = {}): Adw.ApplicationWindow {
  const window = new Adw.ApplicationWindow({
    application: app,
    title: _('Curlew'),
    defaultWidth: 900,
    defaultHeight: 640,
    widthRequest: 360,
  });

  const split = new Adw.NavigationSplitView({
    minSidebarWidth: 280,
    maxSidebarWidth: 400,
    sidebarWidthFraction: 0.3,
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
  let currentMessages: ConversationMessage[] = [];
  const conversation = createConversationView(
    async (text, choice, files, replyTo) => {
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
  );
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
  const select = (entry: ListEntry) => {
    currentEntry = entry;
    currentMessages = loadConversationMessages(entry);
    conversation.show(entry, currentMessages, labels);
    conversation.setLook(lookOf(choiceOfEntry(loadConfig().contactChoices, entry)?.choice));
    split.set_content(conversation.page);
    split.set_show_content(true);
    confirmRead(currentMessages);
  };
  // A contact with no conversation opens as a draft row; the index gets the real one with the first send.
  const selectDraft = (entry: ListEntry) => {
    currentEntry = entry;
    currentMessages = [];
    conversation.show(entry, currentMessages, labels);
    conversation.setLook(lookOf(choiceOfEntry(loadConfig().contactChoices, entry)?.choice));
    split.set_content(conversation.page);
    split.set_show_content(true);
  };
  const startConversation = () => {
    const routes = routeAccounts(shown, loadConfig().deltaChatAccounts);
    presentNewConversation(window, routes, contactsForPicker, (contact) => {
      const existing = existingEntry(shown, contact);
      if (existing) {
        select(existing);
        return;
      }
      const draft = draftEntry(contact, routes);
      if (draft) selectDraft(draft);
    });
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
    review: () => review(),
    compose: () => startConversation(),
    searchText: (text) => searchConversationText(text),
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
  const toasts = new Adw.ToastOverlay({ child: stage });
  window.set_content(toasts);
  // Demo data must never pass for a real inbox: say so once, then stay out of the way.
  if (demoActive()) {
    window.title = _('Curlew (demo)');
    // `CURLEW_DEMO_QUIET=1` leaves the notice out, so a listing screenshot shows the window alone.
    if (process.env.CURLEW_DEMO_QUIET !== '1')
      toasts.add_toast(new Adw.Toast({ title: _('Demo data — nothing here is real'), timeout: 5 }));
  }
  viewer.install(window);

  const accounts = new Gio.SimpleAction({ name: 'accounts' });
  accounts.connect('activate', () => presentAccounts(window));
  const protocols = new Gio.SimpleAction({ name: 'protocols' });
  protocols.connect('activate', () => presentAccounts(window, { openProtocols: true }));
  window.add_action(protocols);
  window.add_action(accounts);
  const mergeContacts = new Gio.SimpleAction({ name: 'merge-contacts' });
  mergeContacts.connect('activate', () => review());
  window.add_action(mergeContacts);
  const action = new Gio.SimpleAction({ name: 'agent-access' });
  action.connect('activate', () => presentAgentAccess(window));
  const syncAi = () => action.set_enabled(aiEnabled(loadConfig(configPath())));
  syncAi();
  window.add_action(action);
  const preferences = new Gio.SimpleAction({ name: 'preferences' });
  preferences.connect('activate', () =>
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
  );
  window.add_action(preferences);
  const welcome = new Gio.SimpleAction({ name: 'welcome' });
  welcome.connect('activate', () => presentWelcome(window, () => refresh()));
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
  const refresh = () => {
    stamp = listStamp();
    shown = loadConversationEntries();
    sidebar.setEntries(shown, labels);
    sidebar.setSuggestions(candidateSets(shown, loadConfig(configPath()).declinedMerges).length);
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
  refresh();
  if (options.protocol) sidebar.chooseProtocol(options.protocol);
  if (options.search !== undefined)
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
      sidebar.showSearch(options.search!, options.openScope === true);
      return GLib.SOURCE_REMOVE;
    });
  // A notification, or the screenshot hook, names a chat by its conversation id or its row id.
  const openConversation = (id: string): void => {
    const entry = loadConversationEntries().find((e) => e.id === id || e.conversationIds.includes(id));
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
  const contactAction = new Gio.SimpleAction({ name: 'open-contact' });
  contactAction.connect('activate', () => {
    if (currentEntry) openContact(currentEntry);
  });
  window.add_action(contactAction);
  const emojiAction = new Gio.SimpleAction({ name: 'open-emoji' });
  emojiAction.connect('activate', () => conversation.openEmoji());
  window.add_action(emojiAction);
  if (options.open) openConversation(options.open);
  // First start only: the flag says it was finished, and anybody with accounts is not new.
  void (async () => {
    try {
      const path = configPath();
      if (loadConfig(path).ui.welcomeDone === true) return;
      const count = countAccounts(await loadAccountsState(path, { hostAccounts: !inSandbox() }));
      if (shouldShowWelcome(loadConfig(path).ui.welcomeDone, count)) welcome.activate(null);
    } catch {
      // No welcome screen is better than a broken window.
    }
  })();
  // The index changes as the daemon syncs; coming back to the window is the cheap moment to look.
  window.connect('notify::is-active', () => {
    if (window.is_active && listStamp() !== stamp) refresh();
  });
  if (!labelled) {
    labelled = true;
    void accountLabels().then((found) => {
      labels = found;
      refresh();
    });
  }
  return window;
}
