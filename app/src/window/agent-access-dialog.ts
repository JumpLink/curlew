/**
 * The "Agent access" dialog (ADR 0009 step 5), opened from the primary menu. The file is read and
 * written through `agent-access-store.ts`; this module wires the page to it and keeps it current
 * while the dialog is open.
 */

import Adw from 'gi://Adw?version=1';
import type Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';
import { configPath, indexDbPath, openIndexDb } from '@curlew/store';
import { existsSync } from 'node:fs';

import { indexAccountLabels, loadAccountLabels } from './account-labels.ts';
import { contactNameFromIndex } from '../core/lib/contact-name.ts';
import { groupByAccount, type EditResult, type PolicyEdit } from './agent-access-model.ts';
import { createAgentAccessPage } from './agent-access-page.ts';
import { loadAgentAccess, updateAgentAccess } from './agent-access-store.ts';
import { watchConfig } from './watch.ts';

/** A read-only lookup of display names; without an index there are simply no names. */
function nameLookup(): {
  nameOf: (account: string, contact: string) => string | undefined;
  close: () => void;
} {
  const path = indexDbPath();
  if (!existsSync(path)) return { nameOf: () => undefined, close: () => {} };
  try {
    const db = openIndexDb(path, { busyTimeoutMs: 300 });
    return {
      nameOf: (account, contact) => contactNameFromIndex(db, account, contact),
      close: () => db.close(),
    };
  } catch {
    return { nameOf: () => undefined, close: () => {} };
  }
}

export function presentAgentAccess(parent: Gtk.Window | null): void {
  const path = configPath();
  const overlay = new Adw.ToastOverlay();
  const toast = (title: string) => overlay.add_toast(new Adw.Toast({ title, timeout: 4 }));
  let labels = indexAccountLabels();
  let labelledBackends = '';
  let loading = false;
  let again = false;
  let open = true;

  const page = createAgentAccessPage(
    (edit: PolicyEdit): EditResult => {
      let result: EditResult;
      try {
        result = updateAgentAccess(edit, path);
      } catch (err) {
        result = { ok: false, error: 'invalid', detail: err instanceof Error ? err.message : String(err) };
      }
      // The file is the truth: show what is in it now, also after a refusal.
      void reload();
      return result;
    },
    toast,
    () => parent,
  );

  async function reload(): Promise<void> {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      let state;
      try {
        state = loadAgentAccess(path);
      } catch (err) {
        page.showError(err instanceof Error ? err.message : String(err));
        return;
      }
      // Names from the index are looked up per refresh: they change as the daemon syncs.
      const render = () => {
        if (!open) return;
        const names = nameLookup();
        try {
          const groups = groupByAccount(state.policy, labels, names.nameOf);
          const accounts = [...labels].map(([id, label]) => ({ id, label }));
          page.show({
            askWithoutRule: state.policy.askWithoutRule,
            sendFilesUnasked: state.policy.sendFilesUnasked === true,
            groups,
            accounts,
          });
        } finally {
          names.close();
        }
      };
      // The page appears first with ids; the labels follow, because asking a backend for its
      // accounts can be slow and must not hold the first paint back.
      render();
      const key = state.backends.join(',');
      if (key !== labelledBackends) {
        labelledBackends = key;
        labels = await loadAccountLabels(state.backends, path);
        render();
      }
    } finally {
      loading = false;
      if (again && open) {
        again = false;
        void reload();
      }
    }
  }

  const header = new Adw.HeaderBar();
  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(header);
  toolbar.set_content(page.widget);
  overlay.set_child(toolbar);

  const dialog = new Adw.Dialog({
    title: _('Agent access'),
    contentWidth: 560,
    contentHeight: 640,
  });
  dialog.set_child(overlay);

  void reload();
  const stop = watchConfig(path, () => void reload());
  dialog.connect('closed', () => {
    open = false;
    stop();
  });
  dialog.present(parent);
}
