/**
 * The window (docs/design/ui.md): a split view with the combined conversation list as the sidebar
 * and a content pane. At 720 sp and narrower it collapses to one pane. Agent access is not a main
 * area; it opens from the primary menu.
 */

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';
import type { ConversationMessage } from '@curlew/protocol';

import { indexAccountLabels, loadAccountLabels } from './account-labels.ts';
import { presentAccounts } from './accounts-dialog.ts';
import { presentAgentAccess } from './agent-access-dialog.ts';
import { loadConversationEntries } from './conversation-list-store.ts';
import type { ListEntry } from './conversation-list-model.ts';
import { createConversationList } from './conversation-list.ts';
import { composeMailReply } from './conversation-model.ts';
import {
  attachingBackends,
  loadConversationMessages,
  loadMailReplyTarget,
  loadOlderMessages,
} from './conversation-store.ts';
import { pickedNames } from './composer-files-model.ts';
import { clearPreviews } from './attachment-store.ts';
import { createConversationView } from './conversation-view.ts';
import { createMediaViewer } from './media-viewer.ts';
import { presentPreferences } from './preferences-dialog.ts';
import { loadAgentAccess } from './agent-access-store.ts';
import { sendMessage } from '../core/actions/send.ts';
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
  menu.append(_('Preferences'), 'win.preferences');
  menu.append(_('Agent access'), 'win.agent-access');
  const appSection = new Gio.Menu();
  appSection.append(_('About Curlew'), 'app.about');
  appSection.append(_('Quit'), 'app.quit');
  menu.append_section(null, appSection);

  // Fetched attachments are message content; an earlier run's leftovers go before this one's.
  if (!process.env.CURLEW_PREVIEWS_DIR && !process.env.POSTBOTE_PREVIEWS_DIR) clearPreviews();
  const viewer = createMediaViewer(
    (title) => toasts.add_toast(new Adw.Toast({ title, timeout: 4 })),
    (shown) => split.set_sensitive(!shown),
  );

  let currentEntry: ListEntry | null = null;
  let currentMessages: ConversationMessage[] = [];
  const conversation = createConversationView(
    async (text, choice, files) => {
      const entry = currentEntry;
      if (!entry) throw new Error(_('This conversation has no recipient address.'));
      // The carrier's own last message: a mail reply must not thread onto a Signal note.
      const parent =
        [...currentMessages]
          .reverse()
          .find((m) => m.backend === choice.backend && m.ref.accountId === choice.accountId) ?? null;
      const mail =
        choice.backend === 'mail' ? composeMailReply(parent, loadMailReplyTarget(parent), text) : null;
      const result = await sendMessage({
        accountId: choice.accountId,
        to: choice.target,
        text,
        frontend: 'window',
        ...(files.length > 0 ? { attachments: files.map((f) => f.path) } : {}),
        ...mail,
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
        emailChat: mail !== null,
        classification: 'conversational',
        classificationReason: 'self',
        ref: { accountId: choice.accountId, backend: choice.backend },
        bodyText: text || pickedNames(files),
      };
    },
    (backend) => attachingBackends().has(backend),
    (entry, oldest) => loadOlderMessages(entry, oldest),
    (source, kind) => viewer.open(source, kind),
  );
  const select = (entry: ListEntry) => {
    currentEntry = entry;
    currentMessages = loadConversationMessages(entry);
    conversation.show(entry, currentMessages, labels);
    split.set_content(conversation.page);
    split.set_show_content(true);
  };
  const sidebar = createConversationList(menu, select, () => presentAccounts(window));
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
  viewer.install(window);

  const accounts = new Gio.SimpleAction({ name: 'accounts' });
  accounts.connect('activate', () => presentAccounts(window));
  window.add_action(accounts);
  const action = new Gio.SimpleAction({ name: 'agent-access' });
  action.connect('activate', () => presentAgentAccess(window));
  window.add_action(action);
  const preferences = new Gio.SimpleAction({ name: 'preferences' });
  preferences.connect('activate', () =>
    presentPreferences(window, () => {
      currentEntry = null;
      currentMessages = [];
      split.set_content(placeholder());
      refresh();
    }),
  );
  window.add_action(preferences);

  let labels = indexAccountLabels();
  let labelled = false;
  const refresh = () => sidebar.setEntries(loadConversationEntries(), labels);
  refresh();
  if (options.protocol) sidebar.chooseProtocol(options.protocol);
  const open = options.open;
  if (open) {
    const entry = loadConversationEntries().find((e) => e.id === open || e.conversationIds.includes(open));
    if (entry) select(entry);
  }
  // The index changes as the daemon syncs; coming back to the window is the cheap moment to look.
  window.connect('notify::is-active', () => {
    if (window.is_active) refresh();
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
