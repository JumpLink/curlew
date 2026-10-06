/**
 * Types for the relocation probe's pure helper, a plain `.mjs` (it is imported by a Node script
 * and by this suite, and curlew's unit tests are `.ts`). Declared here rather than turning on
 * `allowJs` in the app tsconfig, which would pull every integration script into the type check
 * for one file's sake.
 */

export declare function findBakedAddonPaths(bundleText: string): string[];

export declare function countOccurrences(haystack: string, needle: string): number;

export declare function firstOrNone(paths: string[]): string | null;
