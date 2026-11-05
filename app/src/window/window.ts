/**
 * The window (docs/design/ui.md): a split view with the combined conversation list as the sidebar
 * and a content pane. At 720 sp and narrower it collapses to one pane. Agent access is not a main
 * area; it opens from the primary menu.
 */

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import { _, fmt } from '@curlew/protocol';

import { indexAccountLabels, loadAccountLabels } from './account-labels.ts';
import { presentAgentAccess } from './agent-access-dialog.ts';
import { loadConversationEntries } from './conversation-list-store.ts';
import { type ListEntry, protocolLabel } from './conversation-list-model.ts';
import { createConversationList } from './conversation-list.ts';
import { loadAgentAccess } from './agent-access-store.ts';
import { configPath } from '@curlew/store';

const COLLAPSE_AT = 'max-width: 720sp';
async function accountLabels(): Promise<Map<string, string>> {
  try {
    return await loadAccountLabels(loadAgentAccess(configPath()).backends, configPath());
  } catch {
    return indexAccountLabels();
  }
}

function placeholder(entry: ListEntry | null): Adw.NavigationPage {
  const status = new Adw.StatusPage({
    iconName: 'view-dual-symbolic',
    title: entry ? entry.title : _('Select a conversation'),
    description: entry
      ? fmt(_('{protocol} conversation. Reading and writing here is not built yet.'), {
          protocol: protocolLabel(entry.backend),
        })
      : _('Pick a conversation from the list.'),
  });
  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(new Adw.HeaderBar());
  toolbar.set_content(status);
  const page = new Adw.NavigationPage({ title: entry ? entry.title : _('Curlew'), tag: 'content' });
  page.set_child(toolbar);
  return page;
}

export interface WindowOptions {
  /** Start with this protocol chip on (the screenshot hook `CURLEW_WINDOW_FILTER`). */
  protocol?: string;
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
  menu.append(_('Agent access'), 'win.agent-access');
  const appSection = new Gio.Menu();
  appSection.append(_('About Curlew'), 'app.about');
  appSection.append(_('Quit'), 'app.quit');
  menu.append_section(null, appSection);

  const setContent = (entry: ListEntry | null) => split.set_content(placeholder(entry));
  const sidebar = createConversationList(menu, (entry) => {
    setContent(entry);
    split.set_show_content(true);
  });
  split.set_sidebar(sidebar.page);
  setContent(null);

  const breakpoint = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse(COLLAPSE_AT) });
  breakpoint.add_setter(split, 'collapsed', true);
  window.add_breakpoint(breakpoint);
  window.set_content(split);

  const action = new Gio.SimpleAction({ name: 'agent-access' });
  action.connect('activate', () => presentAgentAccess(window));
  window.add_action(action);

  let labels = indexAccountLabels();
  let labelled = false;
  const refresh = () => sidebar.setEntries(loadConversationEntries(), labels);
  refresh();
  if (options.protocol) sidebar.chooseProtocol(options.protocol);
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
