/**
 * The relocation probe's one piece of logic, kept pure: no imports, no I/O, no environment.
 *
 * Split out of `bundle-relocation.mjs` (which runs on Node) so the unit suite can test the same
 * function on GJS and Node instead of a copy of it that could drift — a detector that quietly
 * stopped matching is worse than no detector, because it would report the gap closed.
 *
 * The pattern is deliberately narrow: a POSIX-ABSOLUTE path that runs through `node_modules` and
 * ends in `.node` — a native addon as a `--app gjs` bundle carries it. Bundled JavaScript refers
 * to modules by bare specifier, so nothing else in a bundle should ever look like this. Relative
 * fragments (`./prebuilds/linux-x64/x.node`, `${dir}/node_modules/`) do not match: only an
 * absolute path is the gap.
 *
 * Stated limit, so nobody reads it as an oversight: Windows paths are NOT matched. The GJS
 * target and this probe's runner are Linux, and a backslash separator inside a JS string literal
 * is an escape — matching `C:\…` properly needs a pattern this file would then have to be
 * wrong about for every other case.
 */

/** Deliberately a factory, not a shared RegExp: `String.match` with /g is fine, `lastIndex` is not. */
const pattern = () => /\/[^\s"'`;,()[\]{}<>=]*node_modules[^\s"'`;,()[\]{}<>=]*\.node\b/g;

/** Every distinct absolute native-addon path in a built bundle. Empty = relocatable. */
export function findBakedAddonPaths(bundleText) {
  return [...new Set(bundleText.match(pattern()) ?? [])].sort();
}

/** How often a literal occurs — reports how much of the BUILD ROOT a bundle carries. */
export function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let total = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    total += 1;
  }
  return total;
}

/** One baked path, for the probe's messages. A path — never a value out of a module. */
export function firstOrNone(paths) {
  return paths.length > 0 ? paths[0] : null;
}
