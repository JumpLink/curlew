# OMEMO live interop checklist

By hand, before each release that touches OMEMO ([ADR 0006](../../../docs/adr/0006-omemo-end-to-end-encryption.md) §Tests).
Everything here is synthetic: a throwaway Prosody on 127.0.0.1 and an isolated curlew profile.
Monal is not covered until someone has an iOS device.

Tick one column per peer. Record what you saw in the notes line, not just a tick.

## Lab

```sh
app/tests/interop/omemo-lab up          # Prosody + alice/bob/carol + curlew logged in as alice
eval "$(app/tests/interop/omemo-lab env)"
omemo-lab status                        # (when on PATH) container, accounts, curlew state
app/tests/interop/omemo-lab down        # removes the container and the whole lab directory
```

Build first: `gjsify workspace curlew-cli build`.

- Domain `localhost`, STARTTLS on `127.0.0.1:5222`, direct TLS on `127.0.0.1:5223`. Nothing listens on other interfaces.
- Passwords: `$XDG_RUNTIME_DIR/curlew-omemo-lab/passwords/{alice,bob,carol}` (0600).
- curlew trusts the lab certificate through the existing `backends.xmpp.settings.tlsCaFile`.
  The certificate is still checked against `localhost`; no curlew code is changed for the lab.
- **Shell traps after `eval "$(omemo-lab env)"`:**
  - `curlew` is a shell function that exists only in that shell.
  - `XDG_DATA_HOME` now points into the lab, so a bare `podman` in that shell looks in the wrong
    storage. Use `omemo-lab status`, or `env -u XDG_DATA_HOME -u XDG_CONFIG_HOME podman ...`.
  - `DBUS_SESSION_BUS_ADDRESS` is pinned to nothing on purpose: otherwise GOA hands curlew the
    real mailboxes. The lab also disables the mail backend.
- `ID` below is alice's account id: `omemo-lab status` prints it (`xmpp-…`, stable).
  `export ID=xmpp-…`.
- Server-side look (PEP nodes, users):
  `env -u XDG_DATA_HOME -u XDG_CONFIG_HOME podman exec curlew-omemo-lab prosodyctl shell pubsub list_nodes alice@localhost`

## Client setup

Log the peer in as **bob@localhost** (password from the file above). carol@localhost is only
needed for item 6, as a contact without OMEMO (use any client without OMEMO, or none: carol
simply never publishes a device list).

| Peer | How | Version tested |
|---|---|---|
| Dino | Flatpak `im.dino.Dino` is installed. `flatpak run im.dino.Dino`, add account `bob@localhost`, advanced: server `127.0.0.1`, port 5222 | |
| Gajim | `org.gajim.Gajim` is **not** installed: `flatpak install flathub org.gajim.Gajim` | |
| Conversations | Android emulator AVD `Tablet_API_36`, start **only** with `./scripts/android_emulator.sh start Tablet_API_36` (werkstatt hub). The host is `10.0.2.2` from inside the emulator. APK from F-Droid. Account `bob@localhost`, set hostname `10.0.2.2`, port 5222 in the account's advanced options | |

Certificate acceptance. **Not verified by the author — UI labels and the exact steps need a
hand check, correct this section as you go:**

- Dino: a certificate prompt may appear for the self-signed `localhost` certificate; accept it.
  If the Flatpak refuses, trust the lab certificate system-wide (not run by the lab; the
  Flatpak may not read this store at all):
  `sudo cp "$XDG_RUNTIME_DIR/curlew-omemo-lab/certs/localhost.crt" /etc/pki/ca-trust/source/anchors/ && sudo update-ca-trust`
  (undo: remove the file, run `sudo update-ca-trust` again).
- Gajim: its certificate dialog for the account lets you accept the certificate once.
- Conversations: it asks to trust the certificate. Whether it accepts a connection to host
  `10.0.2.2` for the domain `localhost` is **unknown**; if not, note it here and fall back to
  testing Conversations with Dino-equivalent steps against a lab domain that resolves.

Before the first test, check with `omemo-lab status` that curlew is connected and
`curlew omemo devices --account $ID` shows alice's own device.

## Items

Fingerprints: `curlew omemo devices --account $ID --jid bob@localhost` lists bob's devices and
their trust state. `omemo trust` needs a TTY and asks you to type the fingerprint back.

| # | Check | Dino | Gajim | Conv. |
|---|---|---|---|---|
| 1 | First contact, peer → curlew | ☐ | ☐ | ☐ |
| 2 | First contact, curlew → peer | ☐ | ☐ | ☐ |
| 3 | BTBV: a new device is trusted without verification | ☐ | ☐ | ☐ |
| 4 | Verified: an extra unverified device gets nothing | ☐ | ☐ | ☐ |
| 5 | `distrusted` | ☐ | ☐ | ☐ |
| 6 | No trusted device: refused, no plaintext | ☐ | ☐ | ☐ |
| 7 | `encryption: "required"` refused against carol | ☐ | ☐ | ☐ |
| 8 | Carbon from bob's second device | ☐ | ☐ | ☐ |
| 9 | MAM catch-up after curlew downtime | ☐ | ☐ | ☐ |
| 10 | Identity change (peer reinstalled) | ☐ | ☐ | ☐ |
| 11 | `omemo reset` → new session, no hang | ☐ | ☐ | ☐ |

### 1. First contact, peer → curlew

Enable OMEMO in the peer's chat with alice@localhost, send "ping 1".

```sh
curlew sync --account $ID
curlew conversations list
curlew conversations show <conversation-id> --bodies   # "ping 1" appears decrypted
curlew omemo devices --account $ID --jid bob@localhost # bob's device is listed
```

### 2. First contact, curlew → peer

```sh
curlew send "pong 1" --account $ID --to bob@localhost
```

Expect: the peer shows "pong 1" with an OMEMO lock, not as a plaintext or "could not decrypt".

### 3. BTBV

Add a second device for bob (a second client or the same client under another resource that
publishes its own device). Wait for curlew to sync, then:

```sh
curlew sync --account $ID
curlew omemo devices --account $ID --jid bob@localhost   # new device: trusted, not verified
curlew send "to both" --account $ID --to bob@localhost   # both devices decrypt it
```

### 4. Verified

```sh
curlew omemo trust --account $ID --jid bob@localhost --fingerprint <fp-of-first-device> --state verified
```

Now add a third, unverified device for bob and send:

```sh
curlew sync --account $ID
curlew send "verified only" --account $ID --to bob@localhost
```

Expect: the verified device decrypts it; the new unverified device gets nothing for it.

### 5. distrusted

```sh
curlew omemo trust --account $ID --jid bob@localhost --fingerprint <fp> --state distrusted
curlew send "after distrust" --account $ID --to bob@localhost
```

Expect: the distrusted device receives nothing; the others do.

### 6. No trusted device

Distrust every one of bob's devices, then:

```sh
curlew send "must not leave" --account $ID --to bob@localhost
```

Expect: `OmemoSendRefusedError`, exit non-zero, and **no plaintext** reaches bob (check the peer,
and the Prosody archive stays without that message).

### 7. `encryption: "required"` against carol

Set in the lab config (`$XDG_CONFIG_HOME/curlew/config.json`; the key is `<account>` or
`<account>/<address>`):

```sh
jq --arg id "$ID" '.encryption[$id] = "required"' "$XDG_CONFIG_HOME/curlew/config.json" > /tmp/c.json \
  && mv /tmp/c.json "$XDG_CONFIG_HOME/curlew/config.json"
curlew send "hello carol" --account $ID --to carol@localhost
```

Expect: refused with reason `encryption-required`, nothing sent. Remove the entry afterwards
(`jq --arg id "$ID" 'del(.encryption[$id])' …`).

### 8. Carbon from bob's second device

With two bob devices online (OMEMO on, alice trusted), bob's device B sends "from B" to alice.

```sh
curlew sync --account $ID
curlew conversations show <conversation-id> --bodies
```

Expect: "from B" appears once, decrypted, from bob. The reverse: bob device A sends to alice,
device B shows the carbon copy.

### 9. MAM catch-up after downtime

Stop curlew's connection (no `sync` running; with a daemon profile, stop it). The peer sends
"offline 1" and "offline 2". Then:

```sh
curlew sync --account $ID
curlew conversations show <conversation-id> --bodies
```

Expect: both messages, decrypted, once, in order.

### 10. Identity change

Reinstall the peer client (or clear its data) and log in as bob again: new identity key, new device id.

```sh
curlew sync --account $ID
curlew omemo devices --account $ID --jid bob@localhost
curlew conversations show <conversation-id> --bodies
```

Expect: a notice in the chat about the changed identity, the old device is not silently the
same one, and a send reaches the new device only under the trust rules of items 3–5.

### 11. `omemo reset`

```sh
curlew omemo reset --account $ID --jid bob@localhost
curlew send "after reset" --account $ID --to bob@localhost
curlew sync --account $ID
```

Expect: a fresh session, the peer decrypts "after reset", the command returns (no hang), and
bob's reply decrypts too.

## Result

Date, curlew commit, Prosody image, versions in the table above, deviations:
