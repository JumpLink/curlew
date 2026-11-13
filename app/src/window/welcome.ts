/**
 * The first-run welcome screen: a dialog with a navigation view, so the add-account pages push
 * onto it as they do in the Accounts dialog. Closing it by any route counts as done.
 */

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';
import { configPath } from '@curlew/store';

import { aiEnabled, deltaChatAccountIds, loadConfig, plainMailOn, saveConfig } from '../core/config.ts';
import { pushAddAccountPage } from './account-add.ts';
import { openGoaSettings } from './accounts-page.ts';
import { APP_ID } from './about.ts';
import { pushProtocolsPage } from './protocols-page.ts';
import { loadAccountsState } from './accounts-store.ts';
import { chatOnly } from '../core/platform.ts';
import { inSandbox } from '../core/lib/sandbox.ts';
import { deltaChatPageText } from './email-chat-model.ts';
import {
  applyAiChoice,
  applyDeltaChatChoice,
  applyPlainMailChoice,
  countAccounts,
  mailAccountChoices,
  welcomePages,
  welcomeTexts,
  welcomeSummary,
  type WelcomePageId,
} from './welcome-model.ts';

export function markWelcomeDone(path = configPath()): void {
  const config = loadConfig(path);
  if (config.ui.welcomeDone === true) return;
  config.ui.welcomeDone = true;
  saveConfig(config, path);
}

function pill(label: string, suggested: boolean, onClick: () => void): Gtk.Button {
  const button = new Gtk.Button({
    label,
    halign: Gtk.Align.CENTER,
    cssClasses: suggested ? ['suggested-action', 'pill'] : ['pill'],
  });
  button.connect('clicked', onClick);
  return button;
}

function actions(...buttons: Gtk.Button[]): Gtk.Box {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
  for (const button of buttons) box.append(button);
  return box;
}

function statusPage(
  tag: WelcomePageId,
  title: string,
  icon: string,
  heading: string,
  description: string,
  buttons: Gtk.Button[],
  header: Adw.HeaderBar,
): Adw.NavigationPage {
  const status = new Adw.StatusPage({ iconName: icon, title: heading, description });
  status.set_child(actions(...buttons));
  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(header);
  toolbar.set_content(status);
  return new Adw.NavigationPage({ title, tag, child: toolbar });
}

function formPage(
  tag: WelcomePageId,
  title: string,
  description: string,
  group: Adw.PreferencesGroup,
  buttons: Gtk.Button[],
): Adw.NavigationPage {
  const content = new Adw.PreferencesPage();
  const intro = new Adw.PreferencesGroup({ title, description });
  content.add(intro);
  content.add(group);
  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(new Adw.HeaderBar({ showEndTitleButtons: false }));
  toolbar.set_content(content);
  toolbar.add_bottom_bar(actions(...buttons));
  return new Adw.NavigationPage({ title, tag, child: toolbar });
}

function saveWith(
  path: string,
  change: (config: ReturnType<typeof loadConfig>) => void,
  onError: (e: Error) => void,
): void {
  try {
    const config = loadConfig(path);
    change(config);
    saveConfig(config, path);
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

export function presentWelcome(parent: Gtk.Window | null, onClosed: () => void, start?: WelcomePageId): void {
  const path = configPath();
  const overlay = new Adw.ToastOverlay();
  const navigation = new Adw.NavigationView();
  overlay.set_child(navigation);
  const dialog = new Adw.Dialog({ title: _('Welcome'), contentWidth: 360, contentHeight: 560 });
  dialog.set_child(overlay);
  const onError = (err: Error) => overlay.add_toast(new Adw.Toast({ title: err.message, timeout: 4 }));

  const pages = welcomePages();
  const texts = welcomeTexts();
  // Pages that show the current state are built when they are reached, not up front.
  const builders = new Map<WelcomePageId, () => Adw.NavigationPage>();
  const next = (from: WelcomePageId) => {
    const following = pages[pages.indexOf(from) + 1];
    if (following === undefined) dialog.close();
    else navigation.push(builders.get(following)!());
  };
  const nextButton = (id: WelcomePageId) => pill(_('Next'), true, () => next(id));
  const hostAccounts = () => !inSandbox() && !chatOnly();

  builders.set('intro', () =>
    statusPage(
      'intro',
      _('Welcome'),
      APP_ID,
      _('Welcome to Curlew'),
      texts.intro,
      [nextButton('intro'), pill(_('Skip'), false, () => dialog.close())],
      new Adw.HeaderBar({ showEndTitleButtons: false, showStartTitleButtons: false }),
    ),
  );

  builders.set('protocols', () => {
    const page: { current?: Adw.NavigationPage } = {};
    const choose = pill(_('Choose Protocols'), false, () =>
      pushProtocolsPage({
        navigation,
        path,
        accountCounts: new Map(),
        onError,
        onChanged: () => {},
        parent: () => dialog,
      }),
    );
    page.current = statusPage(
      'protocols',
      _('Protocols'),
      'preferences-system-symbolic',
      _('Choose your protocols'),
      texts.protocols,
      [choose, nextButton('protocols')],
      new Adw.HeaderBar({ showEndTitleButtons: false }),
    );
    return page.current;
  });

  builders.set('accounts', () => {
    const page: { current?: Adw.NavigationPage } = {};
    const add = pill(_('Add Account'), true, () =>
      pushAddAccountPage({
        navigation,
        root: page.current!,
        path,
        onError,
        onAdded: () => {},
        openGoaSettings: () => openGoaSettings(onError),
      }),
    );
    page.current = statusPage(
      'accounts',
      _('Accounts'),
      'user-info-symbolic',
      _('Add your accounts'),
      texts.accounts,
      [add, pill(_('Done'), false, () => next('accounts'))],
      new Adw.HeaderBar({ showEndTitleButtons: false }),
    );
    return page.current;
  });

  builders.set('delta-chat', () => {
    const group = new Adw.PreferencesGroup();
    const page = formPage('delta-chat', _('Delta Chat'), deltaChatPageText(), group, [
      nextButton('delta-chat'),
    ]);
    const enabled = new Set(deltaChatAccountIds(loadConfig(path)));
    void loadAccountsState(path, { hostAccounts: hostAccounts() }).then(
      (load) => {
        const choices = mailAccountChoices(load);
        if (choices.length === 0) {
          group.set_description(
            _('No mail account yet. Once you add one, you can switch this on in its settings.'),
          );
          return;
        }
        for (const choice of choices) {
          const row = new Adw.SwitchRow({
            title: choice.label,
            subtitle: _('Use for Delta Chat'),
            active: enabled.has(choice.id),
            useMarkup: false,
          });
          const plain = new Adw.SwitchRow({
            title: choice.label,
            subtitle: _('Show ordinary email'),
            active: plainMailOn(loadConfig(path), choice.id),
            useMarkup: false,
          });
          let syncing = false;
          const reload = () => {
            const config = loadConfig(path);
            syncing = true;
            row.set_active(deltaChatAccountIds(config).includes(choice.id));
            plain.set_active(plainMailOn(config, choice.id));
            syncing = false;
          };
          row.connect('notify::active', () => {
            if (syncing) return;
            saveWith(path, (config) => applyDeltaChatChoice(config, choice.id, row.get_active()), onError);
            reload();
          });
          plain.connect('notify::active', () => {
            if (syncing) return;
            saveWith(path, (config) => applyPlainMailChoice(config, choice.id, plain.get_active()), onError);
            reload();
          });
          group.add(row);
          group.add(plain);
        }
      },
      (err: unknown) => onError(err instanceof Error ? err : new Error(String(err))),
    );
    return page;
  });

  builders.set('ai', () => {
    const group = new Adw.PreferencesGroup();
    const row = new Adw.SwitchRow({
      title: _('AI features'),
      subtitle: _(
        'An assistant could then read and send your messages through Curlew, each time as you allow it.',
      ),
      active: aiEnabled(loadConfig(path)),
    });
    row.connect('notify::active', () =>
      saveWith(path, (config) => applyAiChoice(config, row.get_active()), onError),
    );
    group.add(row);
    return formPage(
      'ai',
      _('AI'),
      _('Off, no assistant can reach your data. You can change this at any time in Preferences.'),
      group,
      [nextButton('ai')],
    );
  });

  builders.set('summary', () => {
    const group = new Adw.PreferencesGroup();
    const page = formPage(
      'summary',
      _('All set'),
      _('You can change all of this later: accounts and protocols in Accounts, the rest in Preferences.'),
      group,
      [pill(_('Start Using Curlew'), true, () => dialog.close())],
    );
    void loadAccountsState(path, { hostAccounts: hostAccounts() }).then((load) => {
      for (const line of welcomeSummary(loadConfig(path), countAccounts(load))) {
        group.add(new Adw.ActionRow({ title: line.title, subtitle: line.value, useMarkup: false }));
      }
    }, onError);
    return page;
  });

  navigation.add(builders.get(start !== undefined && builders.has(start) ? start : pages[0])!());
  dialog.connect('closed', () => {
    try {
      markWelcomeDone(path);
    } catch {
      // The screen is a convenience; a config that cannot be written must not break closing it.
    }
    onClosed();
  });
  dialog.present(parent);
}
