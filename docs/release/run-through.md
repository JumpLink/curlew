# Supervised run-through (0.2.0)

One person runs Curlew by hand while an agent watches and records. It covers two plan items: the
real-window run (A28) and the real Flatpak run (R13). Unit tests and CI cannot prove either: a
file that exists is not a window that opens. Do it once per release candidate, on the host build
and on the Flatpak bundle.

Every finding becomes an issue. Only blockers are fixed before the tag: data loss, a dead primary
flow, or an action the window offers that cannot work.

## Preparation

1. **Build the host copy.** Run `gjsify install`, then `gjsify workspace curlew-cli build`. Start
   the window with `gjsify run app/dist/curlew.gjs.mjs window`.
2. **Get the Flatpak bundle.** Download the `ship-flatpak` artifact of the CI run on the release
   candidate commit. Install it with `flatpak install --user ./curlew-*.flatpak`, start it with
   `flatpak run eu.jumplink.curlew`.
3. **Use a clean state for each pass.** Move `$XDG_DATA_HOME/curlew` and `$XDG_CONFIG_HOME/curlew`
   aside for the host pass. For the Flatpak pass, run
   `flatpak uninstall --delete-data eu.jumplink.curlew` before installing. Restore nothing
   afterwards unless you want your own data back.
4. **Use throwaway accounts.** Create one test account per protocol before you start. Never use
   your main mailbox or phone number. Write only placeholders into this file and into issues:
   `alice@example.org`, `+49 000 0000000`, `@robin:example.org`.
5. **Keep demo data out.** `CURLEW_DEMO=1` is for screenshots and layout checks. Do not use it for
   this run. `CURLEW_NO_HOST_ACCOUNTS=1` hides the host's GNOME Online Accounts and exists for
   screenshots only. Do not set it here: step 6 needs the GOA mail page.
6. **Prepare a second device or account** for each protocol, so you can send to the test account
   and receive from it.
7. **Agent log.** Start the window from a terminal the agent can read. Note every warning printed.

Repeat the steps below twice: once on the host, once in the Flatpak. Fill the results table at the
end as you go. Steps marked **Flatpak only** or **Host only** are skipped in the other pass.

## Steps

### 1. First start

- **Do:** Start Curlew on the clean state.
- **Expect:** The welcome screen opens. Pages: intro, protocols, accounts, Delta Chat, AI, summary.
  No page forces an input. Finish it. Close and reopen: no welcome screen.

### 2. Defaults

- **Do:** Open Preferences and the AI page.
- **Expect:** AI access is off. Read receipts are off. Delta Chat is off for mail accounts. In the
  Flatpak, `curlew mcp` run inside the sandbox lists no tools while AI is off.

### 3. Add one account per protocol

Do this for **mail, XMPP, Matrix, Telegram, Signal and WhatsApp**. Use every link or login method
the window offers for the protocol (password, QR code, phone number, discovery, SSO if offered).
Flatpak: mail through GNOME Online Accounts is not reachable there by design, so add mail with
address and password.

- **Do:** Open Accounts, add the account, follow the dialog.
- **Expect:**
  - The terms notice appears before Telegram, Signal and WhatsApp, and you can read it at 360 px.
  - A protocol that cannot run on this build says so before the terms, not after.
  - The dialog names no terminal command.
  - After linking, the account shows in the list and its conversations appear.
  - Signal on a device that also has the Signal app as the primary device: **Open Link** above
    the QR code hands the `sgnl://linkdevice` link to Signal, and Signal offers to link. Without
    such an app the window says no app opened the link, and **Copy Link** still works (#385).

Record, per protocol, which link method you used.

### 4. Send and receive

For each account:

- **Do:** Send a text message to the other device. Reply to it from the other device. Send a file.
  Send a pasted image (Signal). Record and send a voice note.
- **Expect:** Each message arrives on the other side and in Curlew. The bubble shows the time of
  day. Files and images open. In the Flatpak the microphone prompt appears before the first
  recording, and the voice note plays back.

### 5. Reactions, edits, deletes

- **Do:** React to a received message. Edit one of your messages. Delete one for everyone.
- **Expect:** The other side shows each change. A protocol that cannot edit or delete offers no such
  menu entry. An encrypted Matrix room and a plain mail thread offer nothing the chat cannot do.

### 6. Mail: the sent copy (R1)

- **Do:** Send a mail from Curlew to the other account. Then reload the window (quit and reopen).
  Open the Sent folder of the account in another mail client.
- **Expect:** Your own bubble is still in the thread after the reload. The Sent folder holds exactly
  one copy. Use a non-Gmail provider: Gmail files submissions itself and would hide a missing
  copy. Also check the Delta Chat row and, on the host, the GOA mail page.

### 7. Picker, design preview, pause

- **Do:** Open the emoji picker and search in English. Open a contact page and change Design,
  Accent colour and Chat background. Pause an account, then resume it.
- **Expect:** The picker opens at once. The chat behind the dialog changes while the dialog is
  open. Paused rows vanish and return on resume.

### 8. Background service

- **Host only:** Open Accounts, press "Start" when the background service is missing. Close the
  window and send a message to a Signal or WhatsApp account. It must arrive when you reopen.
- **Flatpak only:** Switch the background service on. The **portal dialog** (Background / Autostart)
  must appear. Allow it. Close the window and send a message to the test account.
- **Expect:** Either a notification arrives while the window is closed, or Curlew says plainly that
  it will not receive when closed. Click the notification: the window opens on that chat. Record
  what the portal dialog said. Check the file chooser opens through the portal, too.

### 9. Look and feel

- **Do:** Switch the system to dark mode, then set an accent colour in system settings.
- **Expect:** The window follows both. Nothing is unreadable.
- **Do:** Resize the window to 360 px wide.
- **Expect:** The conversation list, the chat, the Accounts dialog and the add-account dialogs
  work. No text runs off the right edge. No word breaks in the middle.

### 10. German

- **Do:** Start with `LANGUAGE=de` (host) or `flatpak run --env=LANGUAGE=de eu.jumplink.curlew`.
- **Expect:** Welcome, Accounts, Preferences and the add-account dialogs are German. No English
  string, no `%s` or placeholder visible.

### 11. AI and MCP

- **Do:** With AI off, run `curlew mcp` and list its tools. Switch AI on in Preferences. Let an
  agent ask for access to a conversation. Deny it.
- **Expect:** Off: no tool listed, and the refusal names Preferences → AI. On: an access prompt
  appears (a notification-portal prompt with four buttons in the Flatpak). Deny works and the
  agent sees no data.

### 12. Read receipts

- **Do:** Open a conversation from a protocol that supports read receipts. Check the other device.
- **Expect:** The other side sees no "read" mark. Switch the setting on, open another message:
  now it does.

### 13. Quit and reopen

- **Do:** Quit from the menu. Start again.
- **Expect:** Accounts, conversations and messages are all there. No welcome screen. Sent messages
  keep their bubbles.

### 14. Remove an account

- **Do:** Remove one account with "also delete" ticked. Remove a second only with the box clear.
- **Expect:** The first is gone with its messages and cached pictures; a second confirmation said
  so. The second keeps its messages and loses only its login. Every other account is untouched.

## Results

Write `ok`, `fail #<issue>` or `skip` in each cell. Put the build or commit under the table.
Copy the table into its own file per build; recorded runs: [v0.2.0-rc.5](run-through-0.2.0-rc.5.md).

| Step | Host | Flatpak | Notes |
|---|---|---|---|
| 1. First start | | | |
| 2. Defaults (AI off, receipts off) | | | |
| 3a. Add mail | | | |
| 3b. Add XMPP | | | |
| 3c. Add Matrix | | | |
| 3d. Add Telegram | | | |
| 3e. Add Signal | | | |
| 3f. Add WhatsApp | | | |
| 4. Send and receive | | | |
| 5. Reactions, edits, deletes | | | |
| 6. Sent copy in Sent (R1) | | | |
| 7. Picker, design preview, pause | | | |
| 8. Background service / portal dialog (R15) | | | |
| 9. Dark mode, accent, 360 px | | | |
| 10. German | | | |
| 11. AI and MCP | | | |
| 12. Read receipts | | | |
| 13. Quit and reopen | | | |
| 14. Account removal | | | |

Build or commit: `<sha>` · Date: `<date>` · Desktop and session: `<GNOME version, Wayland/X11>`
