# ADR 0005 — calendars and contacts without GOA/EDS: a shared live DAV client and a credential broker

- **Status:** Proposed (2026-10-10)
- **Scope:** issue #40; `@curlew/gnome` (stays the Linux driver), a new shared DAV package,
  `@gjsify/system-accounts` (gjsify ADR 0095), reminder's planned CalDAV backend

## Context

Contacts and calendars go through GOA + evolution-data-server today (`packages/gnome/src/contacts.gjs.ts:147`
`searchContacts`, `calendar.gjs.ts:158` `listEvents`, `goa.gjs.ts:142` `listAccounts`). Neither exists
on macOS or Windows. Issue #40 decided the direction: an own, small implementation with a credential
broker and a live CalDAV/CardDAV client, no EDS-style cache, behind the same interface as
`@curlew/gnome`. This ADR settles the open questions of that issue.

What both consumers have today:

| | curlew | reminder |
|---|---|---|
| Seam | no port. `@curlew/gnome` exports functions (`index.ts`) returning DTOs (`protocol/src/types.ts:45` `ContactDTO`, `:56` `CalendarEventDTO`) | `CalendarBackend` port (`core/src/backend.ts:21`): `listCalendars`, `listItems`, `getItem`, `createItem` |
| Moves | parsed DTOs | iCalendar **text** only; parsing, dedupe, grants stay in core |
| Backends | EDS only | `BACKENDS = ['eds']` (`core/src/config.ts:13`); a CalDAV backend is "a new package plus one `BACKENDS` value" (`AGENTS.md`) |
| Credentials | per connection from GOA, never in a DTO | none yet; ADR 0001 §3 names `@gjsify/system-accounts` |

reminder ADR 0001 §1 says "neither project imports the other". Both need the same transport.

## Decision

### 1. One shared pure DAV package, not two clients

A CalDAV client written twice is a second truth that drifts. Neither app may import the other, and
`@curlew/gnome` cannot host it (it is `gi://`-bound). So the transport becomes its own package:

- **Pure TypeScript, no `gi://`, runs on Node and GJS.** `fetch` + XML only.
- **Scope:** discovery (RFC 6764 `.well-known`, `current-user-principal`, `calendar-home-set`,
  `addressbook-home-set`), `PROPFIND`, `REPORT` (`calendar-query`, `calendar-multiget`,
  `addressbook-query`, `addressbook-multiget`, `sync-collection`), `PUT`/`DELETE` with `If-Match`.
  It moves iCalendar / vCard **text** and etags, like reminder's port. It parses neither.
- **Auth is injected** as `() => Promise<Authorization>` (Basic or Bearer), fetched per request,
  never stored by the package.
- **Home: gjsify**, as a platform package next to `@gjsify/system-accounts`, not in curlew or
  reminder. Reason ("Own need first" / "Core deps"): the capability serves two products and any
  third gjsify app; a gjsify app should not need a messenger to get a DAV client. Fallback if
  gjsify tiering (ADR 0003 there) rejects it: a new small repo `dav`, same shape. The maintainer decides;
  it is the one placement call in this ADR.
- **Consumers adapt, not fork:** reminder writes `@reminder/caldav` implementing `CalendarBackend`
  over it (text in, text out). curlew gets a `ContactBackend`/`CalendarBackend` port in
  `@curlew/protocol`, with `@curlew/gnome` as one driver and `@curlew/dav` (vCard/iCal to DTO) as the
  other. reminder's `core/src/ical.ts` parser is pure; whether curlew reuses it or ical.js is
  decided at build time (a parser in `protocol`, per curlew's "parsing is pure" rule).

### 2. Library: own thin layer over `fetch`, not tsdav, not libical-glib

| Option | Licence | Verdict |
|---|---|---|
| `tsdav` 2.4.0 | MIT; deps `debug`, `xml-js` 1.6.11 | Works on `fetch`, but a hidden XML dependency from 2018, a much larger surface than the ~8 requests needed, and its auth helpers want to own the OAuth refresh. Acceptable as a spike, not as the kernel |
| `ical.js` 2.2.1 | MPL-2.0 | Fine for parsing in curlew (file-level copyleft, usable from LGPL packages); not needed in the DAV package |
| libical-glib | LGPL-2.1 / MPL-2.0 | Native GI dependency to bundle on macOS (Homebrew `libical` 4.0.5 ships the typelib per the issue); defeats "pure, Node-testable". No |
| own layer | ours (LGPL, like the other packages) | **Chosen.** The wire is small: RFC 4791 §7 reports, RFC 6352 §8, RFC 6578 sync-collection |

XML under GJS: gjsify ships `@gjsify/domparser` and `@gjsify/fetch` (`gjsify/gjsify/packages/web/`).
**Not verified here:** namespace-aware querying (`getElementsByTagNameNS`) in `domparser` and
streaming behaviour of `fetch` for multi-status bodies. Phase 1 starts with that probe; a gap is
fixed in gjsify (AGENTS.md "Core deps"), with a test, not shimmed here.

Provider quirks are tested against recorded multistatus fixtures (synthetic) plus a Nextcloud
container, never real accounts.

### 3. Credential broker: extend `@gjsify/system-accounts`, tokens never in a DTO

GOA is a token broker. Ours is the same shape: ADR 0095's `getCredentials` already returns
`{kind:'password'} | {kind:'oauth2'; token; expiresAt} | unavailable`. A non-GOA driver adds OAuth
(RFC 8252 external user agent, PKCE, loopback redirect) and a refresh-token store. ADR 0095
lists exactly this as a non-goal "now" and keeps room for it; this ADR is the consumer that opens it.

**Where tokens live:** refresh tokens and app passwords are `secret`. First driver: curlew's existing
`SecretStore` pattern (file per account, 0600 in 0700, `secret` backup tier) — it already exists,
works on GJS and needs no native binding. macOS Keychain and Windows Credential Locker are later
drivers behind the same `SecretStore` shape (details not read; ADR 0095 also marks them unexplored).
Linux keeps GOA/libsecret and is untouched. The access token is short-lived, in memory only.

**Providers:**

| Provider | Wire | Auth | Needs a registered client? | Flow |
|---|---|---|---|---|
| Nextcloud / ownCloud / Radicale / any DAV server | CalDAV, CardDAV | Basic with (app) password | **No** | none |
| iCloud | `caldav.icloud.com`, CardDAV | app-specific password (needs 2FA) | **No** (Apple's "authorize the app" path is for vetted apps; do not rely on it) | none |
| Google | CalDAV `apidata.googleusercontent.com`, CardDAV `www.googleapis.com/.well-known/carddav` | OAuth 2.0 **only**; Basic is refused with 401 | **Yes**: Google Cloud project, CalDAV API enabled, consent screen, OAuth client "Desktop app" | **Loopback + PKCE**. Device flow is not an option: its allowed scopes are only `email`, `openid`, `profile`, Drive `appdata`/`file`, YouTube |
| Microsoft 365 / Outlook.com | **no CalDAV/CardDAV**; Microsoft Graph | OAuth 2.0 | **Yes**: Entra app registration, public client | Loopback (`http://localhost` registered) + PKCE, or device code. A **different protocol**: out of this ADR, a separate Graph driver later |

Sources: RFC 4791, 6352, 6578, 6764, 8252, 8628;
[Google CalDAV guide](https://developers.google.com/workspace/calendar/caldav/v2/guide),
[Google CardDAV](https://developers.google.com/people/carddav),
[Google device flow scopes](https://developers.google.com/identity/protocols/oauth2/limited-input-device),
[Apple app-specific passwords](https://support.apple.com/en-us/102654),
[Microsoft redirect URIs](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url).
Microsoft's lack of CalDAV rests on Learn Q&A threads, not a normative statement; confirm before
the Graph decision. Google's exact consent-screen / verification burden for the calendar and
contacts scopes (testing mode token lifetime, verification) is **not yet checked** against the
policy pages.

**Client secrets in a distributed app:** a desktop client's secret is not confidential (RFC 8252
§8.5). It ships in the app; the registration (name, logo, privacy policy URL, scopes) is what
Google reviews, so it is the product's, not a hidden credential.

### 4. Phases

0. **Probe (no registration):** `domparser`/`fetch` multistatus probe under GJS and Node; fix gaps in gjsify.
1. **DAV package + Basic auth** against a Nextcloud container (CI) and, by hand, the real Nextcloud:
   discovery, list, `sync-collection`, `PUT` with `If-Match`. Includes iCloud with an app password.
2. **Consumers:** reminder `@reminder/caldav` (still behind `calendar.create` grants; the backend checks nothing itself);
   curlew `@curlew/dav` behind a new port; Linux keeps GOA/EDS.
3. **OAuth broker + Google** once the registration below exists.
4. **macOS / Windows secret stores**; Graph driver as its own ADR.

Writes stay granted per capability and target (ADR 0004) on every backend; the read-only gate is unchanged.

## What the maintainer must do personally

1. Google: create a Cloud project, enable the CalDAV API and the People/CardDAV scope, configure the consent screen (privacy policy URL, app name), create an OAuth client of type *Desktop app*, decide on verification (public use) vs. test users.
2. Microsoft (only when the Graph driver is wanted): Entra app registration as public client with the `http://localhost` redirect; decide on publisher verification.
3. Decide the package home (gjsify vs. new repo) and the maintainer of the publish/Trusted Publisher bootstrap for a new `@gjsify/*` name.
4. Provide a throw-away Nextcloud user/app password for a live check (kept outside the repo).
5. Apple needs nothing registered: the user creates an app-specific password.

## Consequences

- curlew and reminder get CalDAV through one implementation; neither imports the other.
- `@gjsify/system-accounts` gains an OAuth driver; ADR 0095's "not goals" line is lifted for it.
- Outlook.com / Microsoft 365 stay unsupported until a Graph driver exists.
- Without a cache every list is a network round trip; `sync-collection` tokens are kept per collection
  as `derived` state only if listing proves too slow.

## Open

- Package home (§1) and name.
- Whether curlew's DTO parsing uses ical.js or reminder's pure parser.
- `domparser` / `fetch` fitness (§2, phase 0).
- Google verification burden (§3).
