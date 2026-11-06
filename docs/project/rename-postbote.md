# curlew was `postbote`

Identifiers, packages, binary and MCP server are `curlew`. The old `postbote` name survives only in persisted formats and the data-directory fallback. Do not "fix" it.

## The rename fallback is load-bearing

`dataDir()`/`configPath()` use `$XDG_{DATA,CONFIG}_HOME/curlew/`, but when ONLY the old `postbote/` directory exists it is read and written in place (`homeSubdir` in `packages/store/src/paths.ts`): never moved, never a second directory beside it, ONE notice line on stderr. Delivery-only messages there are the only copy.

The old `POSTBOTE_*` variables are still read (`envValue`; `CURLEW_*` wins). The on-disk namespaces inside account and secret files (`postbote.account`, `postbote.matrix`, `postbote.undecryptable`, `postbote.api`) and the Matrix IndexedDB name `postbote-<account>` are FORMAT keys of existing files and stay. There is no libsecret/keyring use in this repo.

Pinned by `app/tests/unit/store/paths.test.ts` — the old-install case, not only a fresh one.
