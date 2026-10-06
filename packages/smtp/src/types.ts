/** Where and how to reach an SMTP server. Credentials are parameters, never read from anywhere. */
export interface SmtpAccount {
  host: string;
  port: number;
  /** `tls`: TLS from the first byte. `starttls`: upgrade is required. `none`: loopback only. */
  security: 'tls' | 'starttls' | 'none';
  /** Required with either `auth` kind; it is the login name. */
  username?: string;
  auth: { kind: 'password'; password: string } | { kind: 'oauth2'; accessToken: string };
  tls?: {
    /** PEM of the certificate authority to trust, e.g. a self-signed server. */
    ca?: string;
    /** `false` switches the certificate check off. Do not. */
    rejectUnauthorized?: boolean;
  };
}

export interface OutgoingAttachment {
  filename: string;
  content: Uint8Array;
  contentType?: string;
}

/** Addresses are plain `local@host`: no display names, no groups. */
export interface OutgoingMessage {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: OutgoingAttachment[];
  /** `<id@host>`. Generated from the domain of `from` when absent. */
  messageId?: string;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  /** The server's final reply to the message. */
  response: string;
}
