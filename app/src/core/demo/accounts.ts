/** The accounts of the demo index: made up, one per protocol. */

export const DEMO_ACCOUNTS: ReadonlyArray<{
  id: string;
  identity: string;
  provider: string;
  address?: string;
}> = [
  { id: 'mail-demo1', identity: 'robin@example.org', provider: 'mail' },
  { id: 'xmpp-demo1', identity: 'robin@chat.example.org', provider: 'xmpp' },
  { id: 'signal-demo1', identity: 'Robin (Signal)', provider: 'signal' },
  { id: 'matrix-demo1', identity: '@robin:example.org', provider: 'matrix' },
  { id: 'telegram-demo1', identity: 'Robin (Telegram)', provider: 'telegram' },
  {
    id: 'whatsapp-demo1',
    identity: 'Robin (WhatsApp)',
    provider: 'whatsapp',
    address: '4915100000000@s.whatsapp.net',
  },
];
