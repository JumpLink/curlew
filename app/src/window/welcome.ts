/**
 * The first-run welcome screen: a dialog with a navigation view, so the add-account pages push
 * onto it as they do in the Accounts dialog. Closing it by any route counts as done.
 */

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';
import { configPath } from '@curlew/store';

import { loadConfig, saveConfig } from '../core/config.ts';
import { pushAddAccountPage } from './account-add.ts';
import { openGoaSettings } from './accounts-page.ts';
import { APP_ID } from './about.ts';
import { welcomePages, type WelcomePageId } from './welcome-model.ts';

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

export function presentWelcome(parent: Gtk.Window | null, onClosed: () => void): void {
  const path = configPath();
  const overlay = new Adw.ToastOverlay();
  const navigation = new Adw.NavigationView();
  overlay.set_child(navigation);
  const dialog = new Adw.Dialog({ title: _('Welcome'), contentWidth: 360, contentHeight: 560 });
  dialog.set_child(overlay);
  const onError = (err: Error) => overlay.add_toast(new Adw.Toast({ title: err.message, timeout: 4 }));

  const pages = welcomePages();
  const built = new Map<WelcomePageId, Adw.NavigationPage>();
  const next = (from: WelcomePageId) => {
    const following = pages[pages.indexOf(from) + 1];
    if (following === undefined) dialog.close();
    else navigation.push(built.get(following)!);
  };

  for (const id of pages) {
    switch (id) {
      case 'intro':
        built.set(
          id,
          statusPage(
            id,
            _('Welcome'),
            APP_ID,
            _('Welcome to Curlew'),
            _('Curlew brings your mail and chat accounts together in one conversation list.'),
            [pill(_('Next'), true, () => next(id)), pill(_('Skip'), false, () => dialog.close())],
            new Adw.HeaderBar({ showEndTitleButtons: false, showStartTitleButtons: false }),
          ),
        );
        break;
      case 'accounts': {
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
          id,
          _('Accounts'),
          'user-info-symbolic',
          _('Add your accounts'),
          _('Sign in to a mail or chat account. You can add more later from the menu.'),
          [add, pill(_('Done'), false, () => next(id))],
          new Adw.HeaderBar({ showEndTitleButtons: false }),
        );
        built.set(id, page.current);
        break;
      }
    }
  }

  navigation.add(built.get(pages[0])!);
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
