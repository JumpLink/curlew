/** SQLite row value coercion helpers: turn untyped column values into the DTO shapes store uses. */

import type { ParticipantAddress } from '@curlew/protocol';

export function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** A tri-state boolean: NULL means the network did not say. */
export function tri(value: unknown): boolean | null {
  return value === null || value === undefined ? null : Number(value) === 1;
}

/** A tri-state flag as the column holds it: NULL = the network did not say. */
export function flag(value: boolean | null | undefined): number | null {
  return value === null || value === undefined ? null : value ? 1 : 0;
}

/**
 * The address list of a chat peer as `addresses_json` holds it. The column is written with
 * JSON.stringify, so a parse failure means a damaged row: it reads as no addresses, and one damaged
 * row never aborts a sync or a rebuild.
 */
export function parseParticipantAddresses(json: unknown): ParticipantAddress[] {
  try {
    const parsed = JSON.parse(String(json ?? '[]')) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((a): a is ParticipantAddress => typeof a?.kind === 'string' && typeof a?.value === 'string')
      : [];
  } catch {
    return [];
  }
}
