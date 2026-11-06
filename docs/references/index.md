# Reference repositories

`refs/` holds 15 **read-only**, shallow reference repos (~330 MB with `.git`) for the multi-protocol work decided in [ADR 0001](../adr/0001-multi-protocol-messenger.md). Never edit under `refs/`; initialize only what the task needs (`git submodule update --init --depth 1 refs/<name>`). CI does not check them out.

Read the code before claiming how a network or library behaves.

| Area | Repos | Read it for |
|---|---|---|
| Signal | `flare`, `presage`, `libsignal`, `signal-desktop` | GTK4 client (Flare via `flare-backend` → presage); Rust client lib; Neon/N-API `@signalapp/libsignal-client`; TS service layer in `ts/textsecure/` |
| Matrix | `fractal`, `matrix-rust-sdk`, `matrix-spec` | GTK4 client; SDK (uniffi FFI only, no Node binding); the spec |
| Telegram | `paper-plane`, `mtcute` | GTK4 client on TDLib (inactive since 2024-06); pure-TS MTProto |
| WhatsApp | `whatsmeow`, `baileys` | Go reference; TS library (needs `libsignal` + `whatsapp-rust-bridge`) |
| XMPP | `dino`, `xmpp.js` | GTK4 client with its own OMEMO (`plugins/omemo/`); TS client, no OMEMO |
| Mail UI | `convey`, `hylki` | GTK4 Geary fork (conversation cards, GOA); Rust/libadwaita mailbox + composer |
