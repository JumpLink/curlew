# Desktop notifications for chat messages

The daemon is the only process that always runs, so it notifies; the window need not be open.

## What notifies

- Chats only. A mailbox is not a conversation, and the first sync of one would bury the desktop.
- Incoming, unseen messages that are not notices, with `sent_at` at or after the daemon's start
  (`NoticeState.since`). A backlog catch-up is silent.
- Journal rows (ADR 0007) tell the daemon which chats changed; `planNotices` reads those chats and
  remembers the newest announced message per chat, so nothing is announced twice.

## What it says

`config.ui.notifications`: `preview` (default) shows the last three lines, prefixed with the
sender in a group; `sender` shows a count or "New message" and never the text; `off` shows
nothing. A message with no text reads "Sent an attachment". More than four chats in one poll
become one "N more chats have new messages" summary.

## Transport

`message-notifications.ts` talks to `org.freedesktop.Notifications`: one notification per chat,
replaced through `replaces_id`, hints `desktop-entry` and `category=im.received`, default action
"Open". Clicking calls `org.freedesktop.Application.ActivateAction('open-conversation', [id])` on
`eu.jumplink.curlew`; with no window running it launches the desktop entry with
`CURLEW_WINDOW_OPEN=<id>`.

The default sink exists only for the user's own index (`dbPath` unset); tests get none, so
synthetic messages never reach a real server.

## Known gaps

- The daemon does not know whether the window is focused. It relies on the window marking messages
  seen, so a message read at once can still flash a notification.
- The desktop entry is not `DBusActivatable` yet; a cold start goes through the launch fallback.
