# ADR 0011 — one app, inside and outside a sandbox

- **Status:** Accepted (2026-11-10). The rule is gjsify's; this ADR is Curlew's application of it and
  the order in which Curlew's seams change (plan S8). The open questions at the end are decided when
  their piece starts.
- **Scope:** `app` (window, daemon, CLI, MCP), `@curlew/store` (paths), `@curlew/gnome` (the Linux
  accounts driver), the packaging (`contrib/`, the Flatpak manifest, later the macOS and Windows
  packages).
- **The rule lives in gjsify:**
  [ADR 0138](../../../../gjsify/gjsify/docs/adr/0138-one-app-inside-and-outside-a-sandbox.md) (an app
  is one codebase inside and outside a sandbox, asks for a capability and never a mechanism, and an
  own seam is shaped like a portal until an official one exists), on top of
  [ADR 0101](../../../../gjsify/gjsify/docs/adr/0101-portals-are-the-platform-seam-below-the-gtk-api.md)
  (portals are the platform seam) and ADR 0095 (`system-accounts`). Do not restate the rule here.

## Context

Curlew should ship the way each platform wants an app shipped: a Flatpak on Linux, the Mac App Store
sandbox on macOS, whatever comparable isolation Windows offers. The README said "No Flatpak" because
GOA sits on the session bus. That was true of one seam; it is not the goal. gjsify's ADR 0138 sets
the goal for all our apps. What is left for Curlew is to find the places where it still reaches around
the rule and to change them in a sensible order.

## Decision

Curlew follows gjsify ADR 0138. A stand-in that two apps want moves to gjsify (precedent:
`@gjsify/dav`, `@gjsify/system-accounts`). The seams and their order:

### The seams, as they stand

| Seam | Today | Contract | Sandboxed Linux | macOS | Windows |
|---|---|---|---|---|---|
| Pick, save, open a file | `Gtk.FileDialog`, `Gtk.FileLauncher` | the GTK API, a portal under it | already right: FileChooser / OpenURI / OpenFile portals | NSOpenPanel via GTK | IFileDialog via GTK |
| Appearance, accent | Adwaita via gjsify | Settings portal | already right | gjsify reader (ADR 0078) | gjsify reader |
| Message and access notifications | raw `org.freedesktop.Notifications` calls in `core/lib/message-notifications.ts`, `access-notifications.ts` | `Gio.Notification` through a `Gio.Application`, which is the Notification portal in a sandbox | **change**: the daemon becomes a `Gio.Application`; the click action then arrives as `ActivateAction` for free | gjsify driver, planned | gjsify driver, planned |
| Files named by a caller (`curlew send --attach`) | the **path** goes over the bus, the daemon reads it (wire v3) | the caller opens the file, the **file descriptor** goes over the bus | **change**: a path from the host is not visible inside the sandbox; an fd is | fd passing is not the macOS way; XPC / bookmarks, open | open |
| Keep receiving while the window is closed | a systemd user unit written by `curlew setup` (`setup-unit.ts`) | `Xdp.Portal.request_background` (Background portal) with autostart | **change**: a launcher seam with one driver per platform | login item (SMAppService), open | startup task, open |
| Accounts and credentials of the desktop (mail, contacts, calendar) | `@curlew/gnome` on GOA / EDS | `@gjsify/system-accounts` (ADR 0095): no portal covers it | the one real hole: GOA is not reachable from a sandbox; Geary and Evolution ship `--talk-name=org.gnome.OnlineAccounts` | none yet; DAV without EDS (ADR 0005) | none yet |
| Chat account secrets | files, mode 0600, in the data directory (`SecretStore`) | the data directory of the app | already private to the app inside a sandbox; the Secret portal's master secret could encrypt them at rest, optional | Keychain, open | Credential Locker / DPAPI, open |
| Data, config, cache | `XDG_*` variables (`@curlew/store/paths.ts`) | the XDG variables | right: Flatpak points them into `~/.var/app/<id>/` | the container directory | the package directory |
| Agents and the CLI reach the daemon | the session bus, name `org.curlew…` | one bus name, `--own-name` in a sandbox | works; the daemon is the single door (see open question 1) | XPC, open | named pipe, open |

"Open" means nobody checked yet what the platform's sandbox allows; it is not a claim that it
cannot be done. Windows in particular has no portal; whether one of its isolation models is worth
supporting is **unchecked**.

### What this changes in the code, in order

1. **File descriptors instead of paths on the send wire** (daemon wire v7, **done**). The caller
   (`--attach` in the CLI, the window's composer, an agent's MCP call) opens the file and passes the
   descriptor; the daemon reads from it. This replaces the `PrivateTmp` workaround of 2026-11-09 with the
   right fix, also works outside a sandbox, and keeps the guard that decides *whether* a file may
   leave: it moves to the caller's side of the fd, which is where the person's consent is known.
   `Send` is `(sah)`: the request JSON, whose attachments are `{name, handle}`, and the fd list.
   The daemon copies each descriptor (capped at the largest sender limit) into a 0700 directory
   under `$XDG_CACHE_HOME/curlew/outgoing/` and runs the unchanged send plan on the copies, because
   the senders take paths and `inspectSendFiles` should again check a regular file nobody can swap;
   the directory is removed when the call ends. Progress events for large uploads are not part of
   this step.
2. **Notifications behind one `NoticeSink`** (**done**, differently than first planned). The first
   plan was `Gio.Notification` through a `Gio.Application` in the daemon. That does not work: a
   unique application would take `eu.jumplink.curlew` from the window, and a `NON_UNIQUE` one has no
   D-Bus connection, so GLib's notification backends find no service (checked with a fake server).
   Instead `message-notifications.ts` carries two drivers: the desktop's own service outside a
   sandbox, the Notification portal inside one (`AddNotification`, activated through the application
   id, so the window handles the click). The access prompts in `access-notifications.ts` have the same
   two drivers; the portal one uses buttons that come back as `ActionInvoked`. The two gaps in
   `docs/design/notifications.md` are unchanged.
3. **A launcher seam for "keep receiving"** (**done**). `core/actions/autostart.ts` defines
   `Autostart { status, enable, disable }`; `systemdAutostart` is the Linux-outside-a-sandbox driver
   (the unit file itself stays `setup-unit.ts`), `core/lib/autostart-portal.ts` calls the
   Background portal (`RequestBackground`, answered on a Request object) and `autostartFor` picks
   one. The portal has no query, so its `status()` is `unknown`. The setup stage `unit` runs the
   driver; one without a unit file skips writing and verifying it. Not wired yet: the window's
   `startDaemon` still calls `systemctl --user start`, and no settings switch exists. The seam is
   Curlew's own stand-in until gjsify's portal table The seam is Curlew's own stand-in until gjsify's portal table
   (ADR 0101) grows a Background row; it moves there then.
4. **Accounts stay behind `system-accounts`.** Curlew's mail, contact and calendar code asks the
   interface; `@curlew/gnome` is the Linux driver. The Flatpak does **not** get
   `--talk-name=org.gnome.OnlineAccounts` (decided, open question 2): it is a messenger and chat
   client, and the manifest stays narrow. Mail is still a chat transport there, as in Delta Chat,
   but its account is Curlew's own IMAP/SMTP login with the password in the `SecretStore`, not a
   GOA account. That login does not exist yet: today every mail account comes from GOA (see
   `accounts-model.ts`). Contacts and calendar stay a host-only feature until a portal covers them.
5. **The package.** A Flatpak manifest with the least finish-args that the above allows: network,
   Wayland/X11, no `--filesystem=home`, no `--talk-name` for notifications or GOA. The daemon's bus
   name `eu.jumplink.curlew.Daemon` needs no `--own-name`: Flatpak lets an app own its id and
   everything below it. Done: the manifest is generated by `gjsify ship --target flatpak` from
   `gjsify.ship.flatpak`, `ci.yml`'s `flatpak` job builds it with `flatpak-builder` and runs
   `curlew conversations list` inside it. Still to do: offline npm sources and Flathub screenshots.
   The same metainfo and screenshot rules as Flathub (`docs/concepts/app-product-rules.md` in the
   werkstatt repository) apply from the first manifest.

### What does not change

- ADR 0010: the GUI needs no grant, fetch goes through the daemon, agents get the read gate. The
  gates sit in the daemon and in the MCP layer, not in the transport, so a different transport
  below them leaves them as they are.
- The data model, the index schema, the protocols, the UI.

## Consequences

- The README line "No Flatpak" is replaced by a pointer to this ADR: the claim was true for GOA
  only, and GOA is one seam of eight.
- Each seam is a piece with its own tests. Because every driver speaks the same interface, the
  tests of the Linux-outside-a-sandbox driver cover the logic of the others; only the thin
  platform call is untested without that platform. A fake portal on a peer-to-peer `Gio.DBusServer`
  is the pattern (gjsify ADR 0078, 0095).
- A feature that cannot work in a sandbox without a hole (GOA) states the hole in the manifest and
  in the README, instead of hiding it.

## Open questions

1. **Where does the index live, and who reads it?** Inside a Flatpak the data directory is
   `~/.var/app/<id>/data/curlew`; a host CLI or an agent reading `~/.local/share/curlew/index.db`
   directly would see another (or no) index. Two ways: the daemon serves every read over the bus
   (the sandbox's door, an agent never opens the file), or the data directory is shared with
   `--filesystem=xdg-data/curlew`. The first fits the sandbox and ADR 0009 better and is
   slower to build. Decide with piece 1 of §3, because the fd-passing wire depends on it.
2. **GOA in a Flatpak: grant the hole or ship chat only?** Decided by the owner on 2026-11-11:
   chat only. Curlew is a messenger and chat client that can also chat over mail, like Delta
   Chat. The Flatpak gets no GOA hole. What follows: a mail account that does not come from GOA
   (own IMAP/SMTP login, password in the `SecretStore`), built in #249: *Add Account → Mail*
   discovers the servers over HTTPS the way Thunderbird does, tests the login and saves one
   `SecretStore` file per account. The system's accounts are read through
   `@gjsify/system-accounts` and are simply absent inside the sandbox.
3. **Secrets at rest.** Encrypt the `SecretStore` files with a key from the Secret portal, or rely
   on the sandbox's private directory? Matters for backups and for #145 (encryption).
4. **`attachmentsDir` and `XDG_DOWNLOAD_DIR`.** Where an agent's `message_save_attachment` writes
   needs `--filesystem=xdg-download` in a sandbox, or a portal-chosen folder.
5. **macOS and Windows sandboxes.** What each allows for a long-running background process and for
   a shared data directory between app and CLI (a macOS App Group is the candidate; unchecked).
