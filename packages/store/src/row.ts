/** SQLite row value coercion helpers: turn untyped column values into the DTO shapes store uses. */

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
