# TLS test fixtures

TEST ONLY. Throwaway keys for the loopback TLS test (`mail/transport-tls.test.ts`); they protect
nothing and must never be trusted outside it. Valid 100 years, so the test never expires.

- `ca.pem` — test CA (its key was discarded). Trusted through the transport's `ca` seam.
- `server.pem` / `server.key` — leaf signed by that CA, SAN `localhost` + `127.0.0.1`.
- `other.pem` / `other.key` — self-signed, not chained to the CA (untrusted-cert case).
