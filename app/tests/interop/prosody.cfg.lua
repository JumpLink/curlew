-- Prosody for the OMEMO interop lab (see CHECKLIST.md). Throwaway: synthetic accounts, a
-- self-signed certificate, no data volume — `omemo-lab down` removes all of it.
--
-- What OMEMO (legacy, `eu.siacs.conversations.axolotl`) asks of the server:
--   * PEP with persistent items: the device list and every bundle are PEP nodes a client reads
--     while the owner is offline. mod_pep keeps items (`pep_max_items`) and honours the
--     publish-options the clients send (persist_items, max_items, access_model=open).
--   * open access on those nodes: a peer we have never exchanged presence with must still be
--     able to fetch the list and a bundle. Clients publish `access_model = open` themselves;
--     nothing here may overrule it.
--   * MAM (archive by default), carbons and stream management, so catch-up, the second device
--     and a dropped connection behave like on a real server.
-- No in-band registration: accounts exist only because `omemo-lab up` created them.

plugin_paths = {}
admins = {}

modules_enabled = {
  -- core
  "disco"; "roster"; "saslauth"; "tls"; "private"; "bookmarks"; "ping"; "time"; "version";
  "blocklist"; "vcard4"; "vcard_legacy"; "offline";
  -- what OMEMO and the checklist need
  "pep"; "mam"; "carbons"; "smacks"; "csi_simple";
  -- the in-container console `omemo-lab status` and the checklist read (a unix socket, not a port)
  "admin_shell";
}
-- No server-to-server, and `register` (in-band registration) is simply not listed.
modules_disabled = { "s2s" }

authentication = "internal_hashed"
storage = "internal"
data_path = "/var/lib/prosody"
pidfile = "/var/run/prosody/prosody.pid"
log = { info = "*console" }

-- Encryption from the first byte, like curlew's own policy: STARTTLS is mandatory on 5222,
-- direct TLS (XEP-0368) is on 5223. Never a PLAIN password in the clear.
c2s_ports = { 5222 }
c2s_direct_tls_ports = { 5223 }
c2s_require_encryption = true
allow_unencrypted_plain_auth = false

-- The device list and bundles are small; keep a generous history so a long checklist run never
-- loses the first key exchange.
pep_max_items = 256
archive_expires_after = "never"
default_archive_policy = true

VirtualHost "localhost"
  ssl = {
    certificate = "/etc/prosody/certs/localhost.crt";
    key = "/etc/prosody/certs/localhost.key";
  }
