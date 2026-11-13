/** What the composer holds besides the text: the files picked to go with the message. Pure. */

/** One file waiting in the composer. `temporary` files are ours (a pasted picture) and go when they do. */
export interface PickedFile {
  path: string;
  name: string;
  size: number;
  temporary: boolean;
  /** A recorded voice note, with its length in milliseconds: sent as a voice message. */
  voiceMs?: number;
}

/** One message carries at most this many files; the backends enforce their own, lower, limits again. */
export const MAX_PICKED_FILES = 10;

/** `current` plus `incoming`, a path only once, up to the limit; `skipped` counts what did not fit. */
export function mergePicked(
  current: readonly PickedFile[],
  incoming: readonly PickedFile[],
  max = MAX_PICKED_FILES,
): { files: PickedFile[]; skipped: number } {
  const files = [...current];
  let skipped = 0;
  for (const file of incoming) {
    if (files.some((f) => f.path === file.path)) continue;
    if (files.length >= max) {
      skipped++;
      continue;
    }
    files.push(file);
  }
  return { files, skipped };
}

/** The name a pasted picture is saved under: sortable, no characters a file manager dislikes. */
export function pastedImageName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `pasted-image-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.png`;
}

/** The file names, as the local copy of a message without text shows them. */
export function pickedNames(files: readonly PickedFile[]): string {
  return files.map((f) => f.name).join(', ');
}
