/** Where and how to reach an SMTP server. Credentials are parameters, never read from anywhere. */
export interface SmtpAccount {
  host: string;
  port: number;
  /** `tls`: TLS from the first byte. `starttls`: upgrade is required. `none`: loopback only. */
  security: 'tls' | 'starttls' | 'none';
  /** Required with either `auth` kind; it is the login name. */
  username: string;
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
  /** Add Delta Chat's open `Chat-Version: 1.0` marker. */
  emailChat?: boolean;
  /** `Content-Disposition: reaction` (RFC 9078): the body is the emoji, empty to retract. */
  reaction?: boolean;
  /** `Chat-Edit` (Delta Chat): the `<id@host>` of the message whose text `text` replaces. */
  chatEdit?: string;
  /** `Chat-Delete` (Delta Chat): the `<id@host>` of the message to delete for everyone. */
  chatDelete?: string;
  /** RFC 5322 threading headers, used when this is a reply. */
  inReplyTo?: string;
  references?: string[];
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  /** The server's final reply to the message. */
  response: string;
}
