/**
 * The failures this package raises.
 *
 * They are kept apart rather than folded into one error with a string field because callers act
 * differently on each: a bad MAC is indexed as `bad-mac` and dropped, a duplicate is dropped
 * silently (XEP-0384 §6), an exhausted prekey means the key exchange has to be redone, and a
 * skipped-key limit is a possible DoS attempt worth a log line. These messages are read by an
 * agent or a log, never shown to a person, so they stay English and untranslated.
 *
 * Narrowing goes through the `is…` helpers, which look at `name`: an error crosses a package
 * boundary, where a second copy of the class would make `instanceof` answer false for an error
 * that is one. Same reasoning as `@curlew/protocol`'s `isChatRateLimitedError`.
 *
 * Note: no TypeScript parameter properties — Node's --experimental-strip-types does not support
 * them (same constraint as the rest of the repo).
 */

/** Base class of every error this package raises. */
export class OmemoError extends Error {
  readonly name: string = 'OmemoError';

  constructor(message: string) {
    super(message);
  }
}

/** The bytes on the wire are not a legacy OMEMO message: bad version byte, bad protobuf, no MAC. */
export class WireFormatError extends OmemoError {
  readonly name = 'WireFormatError';
}

/**
 * The truncated HMAC over the message did not match.
 *
 * This is what a tampered message, a wrong identity key or a forked session looks like, and what
 * the stanza layer indexes as `bad-mac`.
 */
export class AuthenticationFailedError extends OmemoError {
  readonly name = 'AuthenticationFailedError';
}

/** The MAC was good but the plaintext was not recoverable — broken CBC padding, a bad GCM tag. */
export class DecryptionFailedError extends OmemoError {
  readonly name = 'DecryptionFailedError';
}

/**
 * A message whose key this session has already derived and discarded.
 *
 * Forward secrecy means the key is gone, so this is not recoverable and not an error worth
 * showing: XEP-0384 §6 asks for a silent drop.
 */
export class DuplicateMessageError extends OmemoError {
  readonly name = 'DuplicateMessageError';
}

/**
 * Decrypting this message would mean deriving more skipped keys than the session allows.
 *
 * A peer can claim any chain index it likes, and each claimed step costs an HMAC and 32 bytes of
 * stored key, so the count is capped (`maxSkippedKeysPerMessage`). Refusing keeps the session
 * usable: the ratchet is untouched and the next in-order message still decrypts.
 */
export class SkippedKeyLimitError extends OmemoError {
  readonly name = 'SkippedKeyLimitError';
}

/**
 * No session could be built from this key exchange.
 *
 * A signed prekey or prekey we no longer have, a signature that does not verify, a bundle without
 * a prekey. The session does not exist afterwards, so the message is indexed as `no-session`.
 */
export class KeyExchangeFailedError extends OmemoError {
  readonly name = 'KeyExchangeFailedError';
}

function hasName(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name;
}

/** Narrow a thrown value to any error of this package. */
export function isOmemoError(err: unknown): err is OmemoError {
  return (
    isWireFormatError(err) ||
    isAuthenticationFailedError(err) ||
    isDecryptionFailedError(err) ||
    isDuplicateMessageError(err) ||
    isSkippedKeyLimitError(err) ||
    isKeyExchangeFailedError(err) ||
    hasName(err, 'OmemoError')
  );
}

/** Narrow a thrown value to {@link WireFormatError}. */
export function isWireFormatError(err: unknown): err is WireFormatError {
  return hasName(err, 'WireFormatError');
}

/** Narrow a thrown value to {@link AuthenticationFailedError}. */
export function isAuthenticationFailedError(err: unknown): err is AuthenticationFailedError {
  return hasName(err, 'AuthenticationFailedError');
}

/** Narrow a thrown value to {@link DecryptionFailedError}. */
export function isDecryptionFailedError(err: unknown): err is DecryptionFailedError {
  return hasName(err, 'DecryptionFailedError');
}

/** Narrow a thrown value to {@link DuplicateMessageError}. */
export function isDuplicateMessageError(err: unknown): err is DuplicateMessageError {
  return hasName(err, 'DuplicateMessageError');
}

/** Narrow a thrown value to {@link SkippedKeyLimitError}. */
export function isSkippedKeyLimitError(err: unknown): err is SkippedKeyLimitError {
  return hasName(err, 'SkippedKeyLimitError');
}

/** Narrow a thrown value to {@link KeyExchangeFailedError}. */
export function isKeyExchangeFailedError(err: unknown): err is KeyExchangeFailedError {
  return hasName(err, 'KeyExchangeFailedError');
}
