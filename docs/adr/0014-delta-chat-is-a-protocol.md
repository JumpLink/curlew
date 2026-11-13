# ADR 0014 — Delta Chat is a protocol, opt-in per mail account

- **Status:** Proposed (2026-11-12). Decided by Pascal in chat; the choices below are the agreed shape.
- **Scope:** `app` (window, welcome screen, mail account page, config), `@curlew/smtp` (headers),
  `@curlew/protocol` (the marker flag), `@curlew/imap` (reading the peer's marker). No store change
  beyond what the marker already records.
- **Builds on:** [ADR 0001](0001-multi-protocol-messenger.md) §1 (mail is a backend, not dressed up as
  chat), [ADR 0010](0010-attachments-across-protocols.md) (attachments),
  [ADR 0015](0015-capabilities-per-thread.md) (which action a thread offers).

## Context

Curlew's "email chat" renders mail threads as bubbles and sends them with Delta Chat's open marker
`Chat-Version: 1.0` (`packages/smtp/src/message.ts:34`). Today the marker is not a choice:

- Every mail sent from the chat UI is marked. `replyFor` in `app/src/window/conversation-model.ts:48`
  sets `emailChat: true` on every reply, the optimistic row in `app/src/window/window.ts:181` sets
  `emailChat: mail !== null`, and a new conversation with a mail account is created with
  `emailChat: account.backend === 'mail'` (`app/src/window/new-conversation-model.ts:60`).
- The subject of a marked first message is `Chat: <first words>` (`chatSubject`,
  `app/src/window/conversation-model.ts:26`). Delta Chat's specification (0.37) asks for
  `Message from <sender name>`.
- The list filter "show all emails" (`ui.showAllEmails`, default `false` since the release plan,
  `app/src/core/config.ts:156`; applied in `app/src/window/conversation-list-model.ts:640`) hides
  unmarked mail threads. It changes the list only, never what is sent or stored.

So a person who only wants a nicer view of their mail silently tells every recipient's client that
they are in a chat. And the marker alone does nothing for the recipient unless the recipient's client
is a Delta Chat-compatible one.

## Decision

### 1. Delta Chat is a protocol, next to Signal and Telegram

The mail-chat feature becomes the protocol **Delta Chat**: mail carries it, the marker identifies
it. Compatible clients are Delta Chat, ArcaneChat and DeltaTouch. Plain mail stays unchanged: a
mail thread without the marker is shown and sent as mail, as before. The protocol picker
([contacts design](../design/contacts.md)) treats "Delta Chat" as one more carrier for a person.

### 2. Opt-in per account, default OFF

Sending the marker is a setting of each mail account (a GOA account or a configured mail account),
**off by default**. It is asked twice: on the welcome screen when the person adds or first sees a
mail account, and on that account's page afterwards. With it off, nothing the person sends carries
`Chat-Version`, whatever the window shows. The three places that mark unconditionally today (see
Context) read the account's setting instead.

This is a **behaviour change**: existing installs that send marked mail today stop doing so until
the person opts in. It lands **before** any header feature in §4 — no new header may ride on a
marker the person never chose.

### 3. The app explains it

The opt-in text says, in plain words:

- what an email chat is (mail shown as a conversation; Delta Chat-compatible clients show it the
  same way),
- what "show all emails" does (it filters the list only; it neither sends nor deletes anything),
- that people without a Delta Chat-compatible client simply see normal mail.

### 4. Delta Chat features only where the peer has shown the marker

A thread offers Delta Chat features only if the peer has sent `Chat-Version` (the thread's
`emailChat`, `packages/protocol/src/messenger.ts:234`; the message's, `:300`). Sending the marker
ourselves is not enough: the peer must have answered in kind. Capability handling follows
[ADR 0015](0015-capabilities-per-thread.md).

The features, in the order they land, all after the opt-in of §2:

- the subject `Message from <sender name>` per Delta Chat spec 0.37, replacing `Chat: <first words>`,
- reactions (RFC 9078), `Chat-Edit`, `Chat-Delete`,
- voice messages (`Chat-Voice-Message`, `Chat-Duration`), stickers, MDN read receipts, forwards.

### 5. After 0.1

Groups, Autocrypt (issue #145), chatmail accounts, webxdc and locations come later. Autocrypt comes
before chatmail accounts: chatmail relays accept only encrypted mail, so an account that cannot
encrypt cannot send.

### 6. When "Delta Chat compatible" may be claimed

README and metainfo say "Delta Chat compatible" only after a live test against a real peer
(package A26 of the 0.1 release plan). Until then the feature is described as "sends the open
`Chat-Version` marker".

## Consequences

- One new per-account setting and a welcome-screen step; the unconditional markers in the three
  places above go away. German strings from the first commit.
- Existing users lose the marker until they opt in. The CHANGELOG says so under Changed.
- Unmarked mail is never presented as a Delta Chat message, and a marked one only offers the
  features its peer has proven it understands.
- Chatmail, groups and Autocrypt need their own ADRs; this one only fixes their order.
- The subject change makes new first messages look different in non-chat clients (`Message from
  Alice` instead of `Chat: …`); threading is untouched, it runs on `In-Reply-To` and `References`.
