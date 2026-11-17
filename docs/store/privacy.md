# Privacy statement

Curlew is a messenger that runs on your own computer. It has no server of its own, so there is
nobody at Curlew who could receive your data. This page says what the app stores, where it
connects, and what it never does. The app is open source
([github.com/JumpLink/curlew](https://github.com/JumpLink/curlew)); every point below can be
checked in the code, and the technical detail is in
[`docs/privacy/`](https://github.com/JumpLink/curlew/tree/main/docs/privacy).

## What Curlew does

Curlew brings your mail and your chats from Telegram, Signal, WhatsApp, Matrix and XMPP into one
list. For that it logs in to the accounts **you** add and shows what those services deliver.

## No telemetry, no Curlew server

- Curlew sends no usage data, crash reports or analytics anywhere, and has no account of its own.
- It talks only to the servers of the accounts you add: your mail provider (IMAP and SMTP), your
  Matrix homeserver, your XMPP server, and the Signal, Telegram and WhatsApp services.
- The messenger services and your mail provider handle your data under their own privacy
  policies. Curlew does not control them.

## What is stored on your computer

- **The index**: the messages of your accounts (mail headers and plain-text bodies, chat messages)
  in one local database under `$XDG_DATA_HOME/curlew/`, readable only by you. It is never
  uploaded.
- **Sessions and passwords**: the login sessions of the chat accounts and the passwords of
  XMPP and mail accounts you type into Curlew are kept in files readable only by you under the
  same folder. Mail accounts from GNOME Online Accounts (Linux) are read from the system when
  needed; Curlew does not store those credentials.
- **Settings**: your choices (enabled accounts, accepted terms, agent access rules) are in
  `$XDG_CONFIG_HOME/curlew/config.json`.
- **Downloads**: attachments you save go to your download folder.

You can delete all of this by removing those folders. Removing a copy from the index does not
delete the message at the service it came from.

## Where the app connects besides your accounts

- **Mail server discovery.** When you add a mail account by address, Curlew looks up the server
  settings: it asks `autoconfig.<your mail domain>`, `<your mail domain>/.well-known/autoconfig`
  and the public Mozilla Thunderbird configuration database
  (`autoconfig.thunderbird.net`). These requests carry the domain of the address you entered,
  and nothing else. Nothing happens until you add a mail account.
- **Links.** Links you click open in your own browser or app; Curlew does not load them itself.
  The "Open Link" button when linking Signal hands the link to another app on your device.

## AI assistants (off by default)

Curlew can offer your messages to an AI assistant through a local MCP server (`curlew mcp`),
but only when you switch AI on in the preferences. It is off by default; while it is off, every
agent request is denied. When it is on, the server talks to the assistant on your own computer
over standard input and output, not over the network, and you decide per account and contact
whether the assistant may read, send, or must ask you first. Which assistant you connect, and
what it does with what it reads, is governed by that assistant's provider, not by Curlew.

## Your rights and contact

You can look at, export and delete your data yourself, because it is on your computer. For
questions about this statement, write to pascal@jumplink.eu. The responsible person is named in
the [legal notice](https://jumplink.eu/curlew/en/legal-notice/).
