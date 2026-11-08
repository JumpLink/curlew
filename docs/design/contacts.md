# Contacts across protocols and the protocol picker

The rules for one person across many protocols. A design note in the language of
`docs/design/ui.md`; it extends "Main window: one combined list" and "Profile view: per
person". **Built so far: one row per person (participants the address book owns, plus manual
merges kept in `config.mergedPeople`), the selection mode with Merge and Separate, and the
merge assistant (a banner and "Merge contacts…" in the menu; skipped sets in
`config.declinedMerges`). Pinning and the rest are still concept.** Each phase lands as its own ADR
amendment, following the repo's rules (grouping is presentation, the store stays
backend-free, strings through gettext).

Curlew's unit of care is the person, not the account. The participant directory
(`packages/store/src/conversations.ts`) already knows this: a contact owns ALL its
addresses up front, so a Telegram user whose phone number is in the address book IS that
contact. The list and the composer do not act on that knowledge yet — a chat conversation
is one row per account-person, and the composer answers on the one backend the
conversation arrived on. This note is the list and the composer catching up.

## What identifies a person

Ordered by strength; the stronger evidence wins, and only the top three act on their own:

| Evidence | Effect |
|---|---|
| One EDS/CardDAV contact owns both addresses (mail, phone, JID) | merges automatically — today already |
| A chat peer's phone number belongs to a contact | merges automatically (a Telegram user whose number is in the book is that contact) |
| A JID that is letter for letter a contact's mail address | merges automatically (most people's XMPP and mail share the provider); only a CONTACT's address counts — someone who merely mailed from it is no proof |
| The same or a similar display name on two networks | never merges on its own; names are not identity — but they are what the merge assistant proposes |
| The same phone number on two different contacts | ambiguous — a suggestion, never an act |
| The person says so (manual merge) | the strongest evidence; beats everything above |

- **Automatic merges** are exactly what the address book positively owns, nothing more.
  The rebuild already redoes these links every run because the address book can change
  without a new message; a merged row therefore appears and disappears with the evidence.
- **Confirmed merges** go through the merge assistant (below): candidates are offered as
  sets, never merged silently. A declined set is remembered in the config and not re-asked.
- **Manual merge** is the person's act in the list's selection mode (below), and in the
  profile view for a single pair. Curlew stores the link itself.
- **Unmerge** is always available: the profile view lists the merged identities with
  *Trennen* beside each. Unmerging removes a grouping; it never deletes or rewrites a
  message. An unmerged automatic merge returns with the next rebuild if the evidence
  still holds; a manual one stays apart until merged again.

## Two ways to merge

Both are built mobile first, in the idiom of current Android and iOS messengers: touch
gestures and a bottom action bar on a phone, the same flow by pointer and keyboard on a
desktop. Minimal chrome, one decision per screen.

### Selection mode (by hand)

- **Enter**: a long press on a row of the conversation list (desktop: right click →
  *Select*, or Ctrl+click). The pressed row is the first selected.
- **In the mode**: a tap toggles a row; every row shows a check circle in place of its
  badge; the header shows the count ("2 selected", de "2 ausgewählt") and a *Cancel*
  button; Escape or Back leaves the mode.
- **Tools** sit in a bottom action bar and act on the selection: *Merge* (de
  "Zusammenführen", enabled from two people), *Mark as read*, *Pin*, *Archive* — each as
  far as it exists. Merge shows the avatars and protocols that would join, confirms once,
  and leaves the mode on the merged row.

### The merge assistant (guided)

- Reached from the main menu ("Merge contacts…", de "Kontakte zusammenführen…") and from
  a quiet banner on the list while candidates exist.
- It walks **sets** of people with similar names, one set per screen: avatar, name,
  protocol badge and last message per person, each with a check box. The person ticks who
  really is one person and continues; *Skip* moves on, and an untouched set counts as
  declined.
- It keeps going while sets remain, then ends with a summary ("3 merged"). Declined sets
  are not offered again; a set gains a newcomer → it is offered again with the newcomer.
- **Similar** means equal after normalising case, diacritics, spacing and the
  "Last, First" order, or close by token overlap (a first name plus a matching initial,
  a nickname as one token). Where the line lies is open question 5; it errs towards
  asking, because the person decides every merge anyway.
- Only people already in the list are offered; a set never mixes in the person
  themselves (the merged Note to self handles that).

## What a merge touches — and what it never touches

**A merge is a grouping, not a rewrite.** Canonical conversations keep their ids (the
mail grouping already works this way: the ids travel with the row); chat rows are state
and are never rewritten by presentation. History, every stored message, stays exactly
where its protocol wrote it.

- The list shows **one row per person**. A grouped tree — a person with one child row per
  protocol — was considered and rejected: it reintroduces protocol as the list's
  structure, which the window forbids. The many ways to reach someone live in the profile
  view.
- Row: avatar with ONE badge — the protocol of the last message, which is where the row's
  time and preview come from anyway (for a pinned person: the pinned protocol). Unread is
  summed across the merged conversations; the title is bold while any of them is unread.
- The conversation view is **one interleaved timeline**, chronological, with the day
  dividers of today. Multi-network clients have shown an interleaved history reads well;
  Curlew's addition is that every run names its carrier (below).

What stays per-protocol, always:

| Stays per-protocol | Why |
|---|---|
| History | each message keeps its protocol; interleaving displays, never rewrites |
| Read state | unread is counted per protocol; the row only sums it |
| Verification and encryption | the Verify section lists one three-state row per way to reach them, unchanged |
| Send limits and refusals | a send obeys its carrier alone — the 4096 chars, the encrypted-room refusal, the lease |

## The protocol picker

- **Where**: the composer carries a small protocol control at its leading edge — the
  current carrier's badge, clickable. One or two reachable protocols: a segmented
  control; more: a popover listing protocols, with account sub-entries where a protocol
  holds several (an account choice narrows only its own protocol, the filter popover's
  rule).
- **Default: the protocol of the last message** in this conversation — the conversation
  continues where it left off. The picker sets the carrier of the NEXT message only; it
  never re-addresss a past one.
- The picker offers only carriers with a **positively known target**: the participant's
  address of that protocol's send kind (`SEND_KIND`), or for a Matrix DM the room the
  index holds. Positive knowledge, fail closed — as everywhere.
- A pinned person has **no picker**: the badge shows the pin and does not open; the
  profile view says why.
- The send then runs that protocol's own path unchanged. A refused send stays in the
  entry and shows a toast — the existing behaviour, now also the only fallback behaviour.

## Cross-protocol rules (decided)

1. **A message NEVER silently switches protocol.** The carrier is what the picker said at
   send time. If that protocol cannot carry the message — limit reached, feature missing,
   link down, room encrypted — the send fails VISIBLY; the text stays in the entry.
   Nothing falls back to another protocol on its own: which network carries a message is
   a privacy statement (whose servers see it, which metadata trail it leaves), and the
   encrypted-room refusal is the precedent — Curlew does not "fall back to sending".
2. **A borrowed feature is marked, subtly.** When the person switches protocol to carry
   what the current one cannot (a file, say), two marks appear: the small protocol badge
   on the bubble, tooltip "Sent via Telegram" (de "Über Telegram gesendet"), and ONE
   system divider at the seam, "Continuing via Telegram" (de "Weiter über Telegram") —
   once per switch, not per message. Elsewhere a run of messages from one protocol
   carries the badge on its first bubble only, the same run rule as sender names in
   groups. Icon, not text. The mark is bookkeeping, not a warning: switching is
   legitimate; hiding it is not.
3. **Per-person routing: "Automatic" or "Only via <protocol>".** Default "Automatic"
   (de "Automatisch"): the composer follows the last message. "Only via Signal" (de
   "Nur über Signal") pins the person to one carrier: no picker, the row's badge shows
   the pin, and a send the pinned protocol cannot carry fails rather than detours. The
   setting lives in the profile view beside the ways to reach them, in the config — user
   decisions never live in the index.

## Note to self

Today each protocol has its own, titled "Note to self" (de "Notiz an mich"), recognised
only where the index knows positively (Signal, Telegram, WhatsApp, XMPP, Matrix; mail
cannot tell). **Decision: one merged row** — there is only one self, and the list is
organised by person. The timeline interleaves what each protocol stored; the picker
defaults to the last-used carrier; the cross-protocol rules apply unchanged. Positive
knowledge stays the gate: the merged row spans only backends that identified their own
address; a mail thread with oneself stays an ordinary mail thread — fail closed, as
`selfAddressOf` is today.

## Privacy

- **Merging is local only.** The link lives in the config (manual, pins, declined
  suggestions) and in the index's derived links (address book). No network is ever told
  that its peer is also reached elsewhere; a merged send is an ordinary send on its one
  protocol, and the person's other protocols learn nothing. Nothing here is ever sent
  anywhere.
- **The address book is never written by a merge.** Curlew stores the link itself (the
  leaning `docs/design/ui.md` already records). Whether an explicit optional "also save
  the number to the contact" is offered is an open question; the default is no.
- **Agents see merges read-only.** An agent reads a merged person as one contact; it
  cannot merge, unmerge, or pin — those are the person's decisions (ADR 0008). A grant
  never widens with a merge: `<backend>.send` names its `<account>/<address>` pair, and
  a merged person's OTHER protocol is a different pair, refused unless granted too. A pin
  binds agents as well — a send to a pinned person via another protocol is refused,
  naming the pin; the person's current intent beats an older blanket grant (ADR 0009).
  MCP output stays English.

## Open questions

1. **First contact default**: a merged person with no history — which carrier does
   "Automatic" pick? (Leaning: the protocol the row was opened or searched from.)
2. **Read state**: opening a merged timeline — does it clear unread on every protocol
   shown, or only where the person actually scrolled? (Leaning: only what was shown.)
3. ~~View vs carrier~~ — decided: the picker sets the carrier only; the timeline always
   interleaves every protocol, chronologically.
4. Is the optional address-book write-back offered on manual merge? (Default no.)
5. How weak may a name similarity be before the assistant does not offer the set?
6. Does a merged row's search cover every merged conversation's history (FTS is per
   conversation today)?
7. Does the merged Note to self get draft sync in a later phase, or stay read/send only?

## Phased rollout

- **Phase 1 — the merged Note to self**: one row for every backend that identified its
  own address, the interleaved timeline with run badges and the "Continuing via …"
  divider, and the composer picker defaulting to the carrier of the last message, sent or
  received. It builds the timeline and the picker on the one merge that needs no
  evidence, and is demoable against the synthetic `example.org` index.
- **Phase 2**: merged rows for people — from the links the directory already computes,
  and from manual merges in selection mode; unmerge in the profile view.
- **Phase 3**: the merge assistant.
- **Phase 4**: pinning ("Automatic" / "Only via …").

Every user-facing string above goes through gettext: English msgid, German catalogue from
the first string — "Notiz an mich", "Über Telegram gesendet", "Weiter über Telegram",
"Nur über Signal", "Automatisch", "Trennen", "Zusammenführen", "Kontakte zusammenführen…",
"2 ausgewählt".

## Not built

All of it. This note decides direction only; no row, timeline, picker, pin or merge
exists in the app today.
