import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TlsCredentials {
  /** Self-signed for localhost and 127.0.0.1: the server's certificate, and what `tls.ca` pins. */
  cert: string;
  key: string;
  /** An unrelated self-signed certificate: a `tls.ca` that does not cover the server. */
  otherCert: string;
}

let cached: TlsCredentials | undefined;

function generate(dir: string, name: string, subject: string, san: string): { cert: string; key: string } {
  const keyFile = join(dir, `${name}.key`);
  const certFile = join(dir, `${name}.crt`);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-subj',
      subject,
      '-addext',
      san,
    ],
    { stdio: 'ignore' },
  );
  return { cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8') };
}

/** Generated once per run with the system `openssl`, in a temp dir that is gone again: synthetic, never committed. */
export function tlsCredentials(): TlsCredentials {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), 'curlew-smtp-tls-'));
  try {
    const server = generate(dir, 'server', '/CN=localhost', 'subjectAltName=DNS:localhost,IP:127.0.0.1');
    const other = generate(dir, 'other', '/CN=other', 'subjectAltName=DNS:other');
    cached = { ...server, otherCert: other.cert };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return cached;
}
