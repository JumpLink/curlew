# ADR 0016 — the window stays in the background

- **Status:** Proposed (2026-11-13). No code yet; the work packages at the end are the order.
- **Scope:** `app` (window, `curlew window`, a `--background` flag), the Flatpak manifest, the
  packaging in `contrib/`. The daemon changes only where the open questions say so.
- **Builds on:** [ADR 0002](0002-receiving-daemon.md) (the daemon receives),
  [ADR 0009](0009-agent-access-per-account-and-contact.md) (access prompts),
  [ADR 0011](0011-same-app-inside-and-outside-a-sandbox.md) (one app, inside and outside a sandbox;
  its table row "Keep receiving while the window is closed").
- **Pattern from:** Beifahrer's ADR 0024 ("The window stays in the background and shows the status").
  Read-only reference; its Flatpak step is implemented there and is the measured precedent.

## Context

Only the daemon runs in the background today (`curlew-daemon.service`, a systemd user unit). It
receives, writes the index and sends the desktop notifications
(`docs/design/notifications.md`). The window is a separate process: `curlew window` starts it, and
closing it ends the process. Nothing in `app/src/window/main.ts` calls `Gio.Application.hold()`.

That is correct while the daemon is the only thing that has to stay alive. It stops being enough in
two places:

- A notification click has to open a chat. With no window running, the desktop launches a new
  process (`CURLEW_WINDOW_OPEN=<id>`). That works, but each open pays the full start-up of the
  window.
- In a sandbox there is no systemd user unit. ADR 0011 names the Background portal as the
  sandbox's answer to "keep running while the window is closed"; nothing uses it yet.

## Decision

**1. The daemon stays headless.** It remains the only source of message notifications and the only
process that receives (ADR 0002). The window never receives, never holds a receive lease, and does
not become the daemon. A window that hosts the receiver would make autostart mandatory and tie
delivery-only backends (Signal, WhatsApp) to a GUI session.

**2. Closing the window keeps Curlew running only where the person can get it back.** On
`close-request` the window calls `Gio.Application.hold()` and hides, if and only if one of these
holds:

- inside the Flatpak, the Background portal granted the request (`Xdp.Portal.request_background`),
  so GNOME lists Curlew under Background Apps; or
- the person turned on autostart (rule 3), so the next login starts it hidden and a click on a
  notification raises it; or
- a status icon is shown (not available today; the same gate as in Beifahrer, once gjsify has it).

Otherwise closing quits, as today. An invisible process the person cannot find is worse than none.
"Quit" in the window's menu always ends the process (`release()`, then quit).

**3. Autostart is off by default.** A switch in the preferences turns it on. In the Flatpak it is
the `autostart` flag of the Background portal; elsewhere it is a `.desktop` entry in
`~/.config/autostart`. The entry runs `curlew window --background`: the window starts hidden and
holds the application. The portal reads each request as the whole wish, so every later request
repeats `autostart` while the switch is on. Where no backend exists the switch is not shown.
Whether to ask once after the first successful account link, as Beifahrer does after its first
pairing, is open question 3.

**4. Order: the Flatpak first.** `hold()` plus `request_background` work on GJS through libportal
with no new gjsify package. Beifahrer measured that this needs the GNOME runtime 51; runtime 50
ships no libportal typelib, so there closing keeps quitting. Curlew's manifest moves to 51 before the
step starts, or the step is skipped on 50 without an error.

**5. The window shows no state the daemon owns.** What the person needs while the window is
hidden (a degraded link, ADR 0003) already reaches them through the daemon's notifications. The
window adds no second channel for it; the portal's status line (`set_background_status`, at most 96
characters) may carry a one-line summary later, and is not part of this decision.

## Alternatives

- **Keep the status quo.** No new surface, no hidden process. Costs the cold start of every
  notification click and leaves the sandbox without a background story. Rejected for the Flatpak,
  and kept as the fallback in rule 2.
- **The window is the daemon.** One process, no IPC. Rejected in rule 1: delivery-only backends
  would depend on a graphical session, and ADR 0007's bus split would collapse.
- **Autostart on by default.** Convenient, but a process the person never asked for starts at every
  login. Rejected; the switch is cheap to find and open question 3 covers
  beginners.
- **Always hide on close, everywhere.** Simple, and Beifahrer's ADR 0024 rejected it for the same
  reason: with no way back (no icon, no list entry) the process is lost.

## Consequences

- A deb/rpm install on GNOME without the AppIndicator extension has no icon and no Background Apps
  entry, so closing quits there. This is a property of the desktop, not an error.
- The daemon's access prompts (ADR 0009) and message notifications still go through
  `org.freedesktop.Notifications` outside a sandbox. A held window does not change who sends them.
- **Windows and macOS.** Neither has a Background portal. macOS follows the Dock convention (a closed
  window leaves the app running; a Dock click brings it back), as Beifahrer ADR 0024 § 6 measured,
  including that the window must be minimised, not hidden, and that no custom `app.quit` action may
  exist. Windows waits for a gjsify background driver; until then closing quits. Autostart on both
  waits for their drivers (ADR 0011: login item, startup task).

## Open questions

1. **Access prompts from the daemon.** The daemon asks for agent access with a notification today
   (`access-notifications.ts`, ADR 0009). With a held window, the dialog could open in the window
   instead of a notification. Who owns the dialog, and what happens when the window is hidden?
2. **Notifications through a portal.** ADR 0011 plans `Gio.Notification` from a `Gio.Application`
   daemon. If the daemon becomes one, a click arrives as `ActivateAction` on the held window for free.
   Does that land before or after this ADR's Flatpak step?
3. **Ask once after the first account link?** Beifahrer asks after the first working pairing; Curlew
   would ask after the first account that receives a message. Decided when the preference exists.
4. **What the ✕ in GNOME's Background Apps list does to the process.** Unverified in Beifahrer;
   Curlew treats it as Quit until measured.

## Work packages

Each is small and merges alone.

1. Move the Flatpak manifest to GNOME runtime 51 (or confirm it is there), with libportal in the
   build.
2. `app/src/window/background-model.ts`: the pure decision "hold or quit on close", given what the
   platform offers. Unit tests on Node and GJS.
3. `background-portal.ts`: `request_background` behind that model, `hold()` and hide on close in the
   Flatpak, `release()` on Quit. No change outside the Flatpak.
4. The `--background` flag: the window starts hidden and holds, and only when the autostart switch is
   on.
5. An autostart switch in the preferences (Flatpak: portal `autostart`; strings in `po/de.po`),
   off by default.
6. deb/rpm autostart entry in `~/.config/autostart`, written and removed by the same switch.
7. Decide open question 1, then route the access dialog to the held window.
8. Status icon and macOS Dock behaviour, each when its gjsify piece exists.
