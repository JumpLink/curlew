/**
 * Every user-facing string of the send path, in one place for the gettext pass that follows.
 */

export const MESSAGES = {
  notPermitted: (account: string, to: string) =>
    `sending from ${account} to ${to} is not granted — add { "capability": "xmpp.send", "target": "${account}/${to}" } to config.grants`,
  notBare: (to: string) => `${JSON.stringify(to)} is not a bare XMPP address — expected name@example.org`,
  emptyText: 'there is nothing to send: the text is empty',
  imageNotHttps: 'the image URL must be a valid https:// URL without credentials or spaces',
  imageTooLong: (max: number) => `the image URL is longer than ${max} characters`,
  tooLong: (max: number) => `the text is longer than ${max} characters`,
  noAccount: (id: string) => `no XMPP account ${id} — \`curlew accounts list\` shows them`,
} as const;
