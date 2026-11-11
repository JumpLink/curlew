/**
 * The pages for adding an account: a list of protocols, and one login page per run that shows
 * what the backend asks for — a question, a QR code or a status line — one step at a time.
 *
 * The login itself is the same `accountsAdd` the CLI runs; this file only supplies a prompter
 * that paints widgets. What is shown comes from `account-prompter.ts` and `account-add-model.ts`.
 */

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '@curlew/protocol';

import { accountsAdd } from '../core/actions/accounts.ts';
import { backendsEnable, backendsList } from '../core/actions/backends.ts';
import { addableProtocols, mailProtocol, needsTerms, type AddableProtocol } from './account-add-model.ts';
import { inSandbox } from '../core/lib/sandbox.ts';
import { restartDaemonIfRunning } from './accounts-daemon.ts';
import { createSurfacePrompter, type PromptStep, type SurfacePrompter } from './account-prompter.ts';
import { qrImage, qrScaleFor } from './qr-image.ts';

export interface AddAccountDeps {
  navigation: Adw.NavigationView;
  /** The page to go back to once an account is added or the person is done. */
  root: Adw.NavigationPage;
  path: string;
  onError(err: Error): void;
  /** An account was added: the caller reloads its list. */
  onAdded(): void;
  /** Open GNOME Settings → Online Accounts, where existing mail accounts are set up. */
  openGoaSettings(): void;
  /** The login to run; the real one unless a probe substitutes it. */
  login?(backend: string, prompter: SurfacePrompter): Promise<unknown>;
}

/** The widest a QR code is drawn, so it fits a phone-sized window with its margins. */
const QR_MAX_PIXELS = 260;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function scrolled(child: Gtk.Widget): Gtk.ScrolledWindow {
  const clamp = new Adw.Clamp({ maximumSize: 420, tighteningThreshold: 320, child });
  return new Gtk.ScrolledWindow({
    hscrollbarPolicy: Gtk.PolicyType.NEVER,
    vexpand: true,
    child: clamp,
  });
}

function column(): Gtk.Box {
  return new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 18,
    marginTop: 24,
    marginBottom: 24,
    marginStart: 18,
    marginEnd: 18,
    valign: Gtk.Align.CENTER,
  });
}

function wrappedLabel(text: string, classes: string[] = []): Gtk.Label {
  return new Gtk.Label({
    label: text,
    wrap: true,
    xalign: 0,
    justify: Gtk.Justification.LEFT,
    cssClasses: classes,
    selectable: false,
  });
}

function pillButton(label: string): Gtk.Button {
  return new Gtk.Button({
    label,
    halign: Gtk.Align.CENTER,
    cssClasses: ['suggested-action', 'pill'],
  });
}

function qrWidget(data: string): Gtk.Widget {
  const image = qrImage(data, qrScaleFor(data, QR_MAX_PIXELS));
  const bytes = GLib.Bytes.new(image.rgba);
  const texture = Gdk.MemoryTexture.new(
    image.width,
    image.height,
    Gdk.MemoryFormat.R8G8B8A8,
    bytes,
    image.width * 4,
  );
  const picture = new Gtk.Picture({ paintable: texture, canShrink: false, halign: Gtk.Align.CENTER });
  return new Adw.Bin({ child: picture, halign: Gtk.Align.CENTER, cssClasses: ['card'] });
}

class LoginPage {
  readonly page: Adw.NavigationPage;
  private readonly stack = new Gtk.Stack({ transitionType: Gtk.StackTransitionType.CROSSFADE });
  private current: Gtk.Widget | null = null;
  private prompter: SurfacePrompter | null = null;
  private serial = 0;

  constructor(
    private readonly deps: AddAccountDeps,
    private readonly protocol: AddableProtocol,
  ) {
    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(new Adw.HeaderBar());
    toolbar.set_content(this.stack);
    this.page = new Adw.NavigationPage({ title: protocol.label, child: toolbar });
    deps.navigation.connect('popped', (_nav: Adw.NavigationView, popped: Adw.NavigationPage) => {
      if (popped === this.page) this.prompter?.cancel();
    });
  }

  start(): void {
    if (needsTerms(this.protocol)) this.showTerms();
    else void this.run();
  }

  private show(widget: Gtk.Widget): void {
    const name = `step-${this.serial++}`;
    this.stack.add_named(widget, name);
    this.stack.set_visible_child_name(name);
    if (this.current) this.stack.remove(this.current);
    this.current = widget;
  }

  private showTerms(): void {
    const terms = this.protocol.terms;
    if (terms === null) return;
    const box = column();
    box.append(
      new Gtk.Image({ iconName: 'dialog-warning-symbolic', pixelSize: 48, cssClasses: ['warning'] }),
    );
    box.append(wrappedLabel(_('Please read this first'), ['title-2']));
    box.append(wrappedLabel(terms.summary));
    if (terms.url) {
      box.append(new Gtk.LinkButton({ uri: terms.url, label: terms.url, halign: Gtk.Align.START }));
    }
    const risk = new Gtk.CheckButton({
      label: _('I understand and accept the risk for my account'),
      halign: Gtk.Align.CENTER,
    });
    const accept = pillButton(_('Accept and Continue'));
    // Reading the notice is not accepting it: the button stays off until the box is ticked.
    accept.set_sensitive(false);
    risk.connect('toggled', () => accept.set_sensitive(risk.get_active()));
    accept.connect('clicked', () => {
      try {
        backendsEnable(this.protocol.backend, { acceptTerms: true, path: this.deps.path });
      } catch (err) {
        this.showError(errorMessage(err));
        return;
      }
      void this.run();
    });
    box.append(risk);
    box.append(accept);
    this.show(scrolled(box));
  }

  private showStep(step: PromptStep): void {
    switch (step.kind) {
      case 'ask':
        this.showAsk(step);
        return;
      case 'qr':
        this.showQr(step.data, step.instructions);
        return;
      case 'status':
        this.showStatus(step.message);
        return;
    }
  }

  private showAsk(step: Extract<PromptStep, { kind: 'ask' }>): void {
    const box = column();
    box.append(wrappedLabel(step.label, ['title-4']));
    const entry: Gtk.Editable & Gtk.Widget = step.secret
      ? new Gtk.PasswordEntry({ showPeekIcon: true })
      : new Gtk.Entry();
    const submit = () => step.submit(entry.get_text());
    entry.connect('activate', submit);
    box.append(entry);
    const next = pillButton(_('Continue'));
    next.connect('clicked', submit);
    box.append(next);
    this.show(scrolled(box));
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      entry.grab_focus();
      return GLib.SOURCE_REMOVE;
    });
  }

  private showQr(data: string, instructions: string): void {
    const box = column();
    box.append(qrWidget(data));
    const text = wrappedLabel(instructions);
    text.set_justify(Gtk.Justification.CENTER);
    text.set_xalign(0.5);
    box.append(text);
    box.append(new Adw.Spinner({ halign: Gtk.Align.CENTER, widthRequest: 24, heightRequest: 24 }));
    this.show(scrolled(box));
  }

  private showStatus(message: string): void {
    const status = new Adw.StatusPage({
      title: _('Adding account…'),
      description: message,
      child: new Adw.Spinner({ halign: Gtk.Align.CENTER, widthRequest: 32, heightRequest: 32 }),
    });
    this.show(status);
  }

  private showError(message: string): void {
    const retry = pillButton(_('Try Again'));
    retry.connect('clicked', () => void this.run());
    const status = new Adw.StatusPage({
      iconName: 'dialog-warning-symbolic',
      title: _('Could not add the account'),
      description: message,
      child: retry,
    });
    this.show(status);
  }

  private async run(): Promise<void> {
    this.prompter?.cancel();
    const prompter = createSurfacePrompter({ present: (step) => this.showStep(step) });
    this.prompter = prompter;
    this.showStatus(_('Connecting…'));
    try {
      if (!this.protocol.enabled && !needsTerms(this.protocol)) {
        backendsEnable(this.protocol.backend, { path: this.deps.path });
      }
      await (this.deps.login ?? ((backend, p) => accountsAdd(backend, p, {}, this.deps.path)))(
        this.protocol.backend,
        prompter,
      );
    } catch (err) {
      // Leaving the page cancels the login on purpose; that is not an error to show.
      if (!prompter.cancelled) this.showError(errorMessage(err));
      return;
    }
    if (prompter.cancelled) return;
    restartDaemonIfRunning();
    this.deps.onAdded();
    this.deps.navigation.pop_to_page(this.deps.root);
  }
}

function protocolRow(protocol: AddableProtocol, onActivate: () => void): Adw.ActionRow {
  const row = new Adw.ActionRow({
    title: protocol.label,
    subtitle: needsTerms(protocol) ? _('Asks you to accept terms first') : '',
    activatable: true,
    useMarkup: false,
  });
  row.add_prefix(new Gtk.Image({ iconName: protocol.icon }));
  row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic' }));
  row.connect('activated', onActivate);
  return row;
}

/** Push the list of protocols that can be added; choosing one pushes its login page. */
export function pushAddAccountPage(deps: AddAccountDeps): void {
  const { backends } = backendsList(deps.path);
  const protocols = addableProtocols(backends);
  const mailEntry = mailProtocol(backends);

  const chats = new Adw.PreferencesGroup({
    title: _('Chats'),
    description: _('Signal, WhatsApp and Telegram link this computer as another device of your account.'),
  });
  for (const protocol of protocols) {
    chats.add(
      protocolRow(protocol, () => {
        const login = new LoginPage(deps, protocol);
        deps.navigation.push(login.page);
        login.start();
      }),
    );
  }

  const mail = new Adw.PreferencesGroup({ title: _('Mail') });
  if (mailEntry) {
    const own = protocolRow(mailEntry, () => {
      const login = new LoginPage(deps, mailEntry);
      deps.navigation.push(login.page);
      login.start();
    });
    own.set_subtitle(_('Sign in with an address and a password'));
    mail.add(own);
  }
  // A Flatpak cannot see GNOME Online Accounts (ADR 0011), so the shortcut would lead nowhere.
  if (!inSandbox()) {
    const goa = new Adw.ActionRow({
      title: _('GNOME Online Accounts'),
      subtitle: _('Use an account you already set up in GNOME Settings'),
      activatable: true,
      useMarkup: false,
    });
    goa.add_prefix(new Gtk.Image({ iconName: 'avatar-default-symbolic' }));
    goa.add_suffix(new Gtk.Image({ iconName: 'adw-external-link-symbolic' }));
    goa.connect('activated', () => deps.openGoaSettings());
    mail.add(goa);
  }

  const content = new Adw.PreferencesPage();
  content.add(chats);
  content.add(mail);

  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(new Adw.HeaderBar());
  toolbar.set_content(content);
  deps.navigation.push(new Adw.NavigationPage({ title: _('Add Account'), child: toolbar }));
}
