// Test entry: aggregates every *.test.ts suite (each a default-exported async fn) and runs them
// under @gjsify/unit, on GJS and Node both (`gjsify test`). Keep this list in sync when adding a
// test file.
import { run } from '@gjsify/unit';

import runtime from './unit/runtime.test.ts';
import gnomeOptional from './unit/gnome/optional.test.ts';
import backends from './unit/backends.test.ts';

import imapParse from './unit/protocol/imap-parse.test.ts';
import mimeParse from './unit/protocol/mime-parse.test.ts';
import bodySection from './unit/protocol/body-section.test.ts';
import mutf7 from './unit/protocol/mutf7.test.ts';
import rfc2231 from './unit/protocol/rfc2231.test.ts';
import listParse from './unit/protocol/list-parse.test.ts';
import searchPlan from './unit/protocol/search-plan.test.ts';
import bodyStructure from './unit/protocol/bodystructure.test.ts';
import safeFilename from './unit/protocol/safe-filename.test.ts';
import transferDecode from './unit/protocol/transfer-decode.test.ts';
import messenger from './unit/protocol/messenger.test.ts';
import mailHeaders from './unit/protocol/mail-headers.test.ts';

import storePaths from './unit/store/paths.test.ts';
import storeDownload from './unit/store/download.test.ts';
import storeSendFiles from './unit/store/send-files.test.ts';
import storeFts from './unit/store/fts.test.ts';
import storeDb from './unit/store/db.test.ts';
import storeSync from './unit/store/sync.test.ts';
import storeClassify from './unit/store/classify.test.ts';
import storeThreads from './unit/store/threads.test.ts';
import storeConversations from './unit/store/conversations.test.ts';
import storeConversationTotals from './unit/store/conversation-totals.test.ts';
import storeChatSync from './unit/store/chat-sync.test.ts';
import storeChatBackfill from './unit/store/chat-backfill.test.ts';
import storeDeliverySync from './unit/store/delivery-sync.test.ts';
import storeDeliveryFollow from './unit/store/delivery-follow.test.ts';
import storeReceiveLease from './unit/store/receive-lease.test.ts';
import storeChanges from './unit/store/changes.test.ts';
import storeChangeAppends from './unit/store/change-appends.test.ts';
import storeConcurrency from './unit/store/concurrency.test.ts';

import telegram from './unit/telegram/telegram.test.ts';
import signal from './unit/signal/signal.test.ts';
import signalSend from './unit/signal/send.test.ts';
import signalAttachments from './unit/signal/attachments.test.ts';
import signalStoreFence from './unit/signal/store-fence.test.ts';
import whatsapp from './unit/whatsapp/whatsapp.test.ts';
import whatsappSend from './unit/whatsapp/send.test.ts';
import whatsappAttachments from './unit/whatsapp/attachments.test.ts';
import whatsappInSessionSend from './unit/whatsapp/in-session-send.test.ts';
import xmpp from './unit/xmpp/xmpp.test.ts';
import xmppTls from './unit/xmpp/tls.spec.ts';
import xmppAttachments from './unit/xmpp/attachments.test.ts';
import xmppSendFiles from './unit/xmpp/send-files.test.ts';
import omemoUpkeep from './unit/xmpp/omemo-upkeep.test.ts';
import pepRead from './unit/xmpp/pep-read.test.ts';
import omemoSend from './unit/xmpp/omemo-send.test.ts';
import omemoTrust from './unit/xmpp/omemo-trust.test.ts';
import omemoArchive from './unit/xmpp/omemo-archive.test.ts';
import matrix from './unit/matrix/matrix.test.ts';
import matrixSend from './unit/matrix/send.test.ts';
import matrixFollow from './unit/matrix/follow.test.ts';
import matrixRedact from './unit/matrix/redact.test.ts';
import matrixAttachments from './unit/matrix/attachments.test.ts';
import smtpMessage from './unit/smtp/message.test.ts';
import smtpSend from './unit/smtp/send.test.ts';
import mailSend from './unit/mail/send.test.ts';
import telegramSend from './unit/telegram/send.test.ts';
import telegramFollow from './unit/telegram/follow.test.ts';
import telegramAttachments from './unit/telegram/attachments.test.ts';

import date from './unit/core/date.test.ts';
import i18n from './unit/core/i18n.test.ts';
import limits from './unit/core/limits.test.ts';
import registry from './unit/core/registry.test.ts';
import grants from './unit/core/grants.test.ts';
import access from './unit/core/access.test.ts';
import accessBroker from './unit/core/access-broker.test.ts';
import agentAccess from './unit/core/agent-access.test.ts';
import windowAgentAccess from './unit/window/agent-access-model.test.ts';
import accountRemove from './unit/core/account-remove.test.ts';
import accountToggle from './unit/core/account-toggle.test.ts';
import peopleMergeTest from './unit/core/people-merge.test.ts';
import windowAccounts from './unit/window/accounts-model.test.ts';
import windowConversationList from './unit/window/conversation-list-model.test.ts';
import windowCandidates from './unit/window/merge-candidates-model.test.ts';
import windowSelection from './unit/window/selection-model.test.ts';
import windowAttachment from './unit/window/attachment-model.test.ts';
import windowMediaGrid from './unit/window/media-grid-model.test.ts';
import windowPreviewCache from './unit/window/preview-cache-model.test.ts';
import windowViewer from './unit/window/viewer-model.test.ts';
import windowVideoPreview from './unit/window/video-preview-model.test.ts';
import windowConversation from './unit/window/conversation-model.test.ts';
import windowComposerFiles from './unit/window/composer-files-model.test.ts';
import encryption from './unit/core/encryption.test.ts';
import capabilities from './unit/core/capabilities.test.ts';
import send from './unit/core/send.test.ts';
import selfAddress from './unit/core/self-address.test.ts';
import markdown from './unit/core/markdown.test.ts';
import daemon from './unit/core/daemon.test.ts';
import daemonAccounts from './unit/core/daemon-accounts.test.ts';
import watch from './unit/core/watch.test.ts';
import daemonSend from './unit/core/daemon-send.test.ts';
import accountPrompter from './unit/window/account-prompter.test.ts';
import accountAddModel from './unit/window/account-add-model.test.ts';
import qrImage from './unit/window/qr-image.test.ts';
import notifyQr from './unit/protocol/notify-qr.test.ts';
import daemonFetch from './unit/core/daemon-fetch.test.ts';
import chatAttachment from './unit/core/chat-attachment.test.ts';
import messageNotices from './unit/core/message-notices.test.ts';
import follow from './unit/core/follow.test.ts';
import deliveries from './unit/core/deliveries.test.ts';
import setup from './unit/core/setup.test.ts';
import setupSteps from './unit/core/setup-steps.test.ts';
import setupUnit from './unit/core/setup-unit.test.ts';

import promptTty from './unit/cli/prompt-tty.test.ts';
import mcpGate from './unit/mcp/gate.test.ts';
import mcpSetupTools from './unit/mcp/setup-tools.test.ts';
import mcpTools from './unit/mcp/tools.test.ts';

import omemo from './unit/omemo/omemo.test.ts';

import bundlePaths from './unit/integration/bundle-paths.test.ts';

run({
  runtime,
  gnomeOptional,
  backends,
  imapParse,
  mimeParse,
  bodySection,
  mutf7,
  rfc2231,
  listParse,
  searchPlan,
  bodyStructure,
  safeFilename,
  transferDecode,
  messenger,
  mailHeaders,
  storePaths,
  storeDownload,
  storeSendFiles,
  storeFts,
  storeDb,
  storeSync,
  storeClassify,
  storeThreads,
  storeConversations,
  storeConversationTotals,
  storeChatSync,
  storeChatBackfill,
  storeDeliverySync,
  storeDeliveryFollow,
  storeReceiveLease,
  storeChanges,
  storeChangeAppends,
  storeConcurrency,
  telegram,
  signal,
  signalSend,
  signalAttachments,
  signalStoreFence,
  whatsapp,
  whatsappSend,
  whatsappAttachments,
  whatsappInSessionSend,
  xmpp,
  xmppTls,
  xmppAttachments,
  xmppSendFiles,
  omemoUpkeep,
  pepRead,
  omemoSend,
  omemoTrust,
  omemoArchive,
  matrix,
  matrixSend,
  matrixFollow,
  matrixRedact,
  matrixAttachments,
  smtpMessage,
  smtpSend,
  mailSend,
  telegramSend,
  telegramFollow,
  telegramAttachments,
  date,
  i18n,
  limits,
  registry,
  grants,
  access,
  accessBroker,
  agentAccess,
  windowAgentAccess,
  windowAccounts,
  accountRemove,
  accountToggle,
  peopleMergeTest,
  windowConversationList,
  windowSelection,
  windowCandidates,
  windowConversation,
  windowComposerFiles,
  windowAttachment,
  windowMediaGrid,
  windowPreviewCache,
  windowViewer,
  windowVideoPreview,
  encryption,
  send,
  selfAddress,
  markdown,
  daemon,
  daemonAccounts,
  daemonSend,
  daemonFetch,
  accountPrompter,
  accountAddModel,
  qrImage,
  notifyQr,
  chatAttachment,
  messageNotices,
  watch,
  follow,
  deliveries,
  setup,
  setupSteps,
  setupUnit,
  capabilities,
  promptTty,
  mcpGate,
  mcpSetupTools,
  mcpTools,
  omemo,
  bundlePaths,
});
