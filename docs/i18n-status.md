# Translation status

curlew is translatable with gettext. Source strings are English — every `msgid` in the repo is
English — and German lives in [`po/de.po`](../po/de.po). One domain, `curlew`, covers `app/src`
and every `packages/*/src`.

A build without compiled catalogues is not broken: an unresolved lookup returns its msgid, so the
output is correct English rather than blank.

## How it works

- **Runtime:** [`packages/protocol/src/i18n.ts`](../packages/protocol/src/i18n.ts) — `_`, `_n`,
  `_p`, `fmt`, and a `.mo` parser. Pure TypeScript with no imports, because curlew is
  dual-runtime: the same sources build to a GJS bundle and a Node one, and `import Gettext from
  'gettext'` resolves only under GJS. Binding the catalogue there would translate the GJS build
  and leave Node English.
- **Host half:** [`app/src/core/lib/i18n.ts`](../app/src/core/lib/i18n.ts) — `initI18n()` finds
  the `.mo`, reads it, installs it. Called as the first statement of `app/src/index.ts`, ahead of
  yargs, because every `describe` string is evaluated while the parser is built.
- **Language choice:** the POSIX chain, as gettext reads it — `LANGUAGE` (a `:`-list), then
  `LC_ALL`, `LC_MESSAGES`, `LANG`. `LC_ALL=C` or `POSIX` pins the run to English even if
  `LANGUAGE` asks for German. Each name is expanded most- to least-specific, so `de_AT.UTF-8`
  still finds the `de` catalogue.
- **Where the catalogue is read from,** in order: `GJSIFY_LOCALE_DIR` (what the `gjsify ship`
  launchers export), then `./locale` next to the bundle (`app/dist/locale`, which `build` fills),
  then `/usr/share/locale`.
- **Placeholders are named** (`{account}`, not `%s`), so a translation can reorder them. An
  unknown name stays visible as `{acount}` rather than printing `undefined`.
- **Plural forms come from the catalogue's `Plural-Forms` header**, evaluated by a hand-written
  parser — never `new Function`, since the expression arrives from a data file.

## Working on strings

```sh
./dev/i18n.sh extract    # re-scan the sources into po/curlew.pot and merge into po/de.po
./dev/i18n.sh compile    # po/*.po -> app/dist/locale/<lang>/LC_MESSAGES/curlew.mo
```

Also available as `i18n:extract` / `i18n:compile`; `build` runs the compile step itself. `compile`
warns and skips when `msgfmt` is absent, so a checkout without gettext still builds — but
`gjsify ship` refuses a `localeDir` with no `.mo`, which is why CI installs gettext.

Two rules for call sites:

- **Never call `_()` at module level.** It would resolve before `initI18n()` and freeze English
  into the module. That is why `where()` in `credentials.ts` and `reloginHint()` in `backend.ts`
  are functions, and why `TELEGRAM_MANIFEST.terms.summary` and `accountsCommand.describe` are
  getters.
- **Never build a plural from an `n === 1` check.** Use `_n()`; the rule is a property of the
  language and belongs in the catalogue.

German uses informal "du", matching the sibling projects.

## Translated

| Area | Strings |
|---|---|
| Telegram credentials ([`credentials.ts`](../packages/telegram/src/credentials.ts)) | all six errors: bad `api_id`, bad `api_hash`, credentials in the config file, env pair half-set, session built with other embedded credentials, session without stored credentials |
| Telegram login ([`login.ts`](../packages/telegram/src/login.ts)) | the unnamed-account fallback, and the "Telegram HAD authorized this session" recovery message |
| Telegram backend ([`backend.ts`](../packages/telegram/src/backend.ts)) | the five login prompts (api_id, api_hash, phone, code, 2FA password), the two unusable-session errors, the re-login hint |
| Telegram client ([`client.ts`](../packages/telegram/src/client.ts)) | the three login notices: email-login setup required, which channel sent the code, code/password rejected |
| Telegram manifest ([`manifest.ts`](../packages/telegram/src/manifest.ts)) | the terms summary shown before a login |
| CLI `accounts` ([`accounts.ts`](../app/src/frontends/cli/accounts.ts)) | command and option descriptions for `accounts`, `accounts list`, `accounts add` |
| CLI prompts ([`prompt.ts`](../app/src/frontends/cli/prompt.ts)) | "input ended before the login was complete" |

| CLI commands (`backends`, `calendar`, `check`, `contacts`, `conversations`, `daemon`, `deliveries`, `sync`/`index`, `mail`, `send`, `mcp`, `setup`) | every command, subcommand and option description, the `demandCommand` hints, the daemon stop notice, the backends terms refusal, the `setup --status` report |
| XMPP send path ([`messages.ts`](../packages/xmpp/src/messages.ts)) | all refusals, including the three `omemoRefused.*` reasons |

153 msgids. Covered by `app/tests/unit/core/i18n.test.ts`: a German locale yields German, a
language we do not ship falls back to English, `LC_ALL=C` wins over `LANGUAGE`, and a wired
Telegram error comes out German once the catalogue is installed.

## Not translated yet

Everything else still carries English literals. Roughly, in the order it is worth doing:

- **The other account backends** — Signal, WhatsApp, XMPP, Matrix: their prompts, login notices
  and manifest terms, i.e. the same surface Telegram now has.
- **The setup assistant's** step titles and prompts (`app/src/core/actions/setup.ts`); only the `setup` CLI command and its `--status` report are done.
- **The daemon's** log lines and notifications.
- **Error messages from `@curlew/store` and `@curlew/protocol`** that reach a user.

## Deliberately English

- **`omemoFallback`** (`packages/xmpp/src/messages.ts`). The plaintext `<body>` of an OMEMO message goes over the wire to the recipient's client; it must not depend on the sender's locale.
- **JSON output** of every command (keys and values), and the hidden `addon-canary` probe.
- **MCP tool output.** Agents parse those strings; a German `description` or error would change
  what a model sees from one desktop to the next. Same decision as in the sibling
  steuererklaerung project.
- **Protocol-level text** — IMAP/SMTP responses, Telegram's own `channel` names, server errors
  quoted verbatim. Not ours to translate.
- **Field names a user has to recognise elsewhere**: `api_id`, `api_hash`, Telegram's "API
  development tools" section, `--own-credentials`. Marked with `TRANSLATORS:` comments in the
  sources.
