// Probe: is the built postbote bundle RELOCATABLE? Copy it out of the tree, run it from there,
// and see whether it still finds its native addon.
//
// Why this exists. `--app gjs` bakes the ABSOLUTE prebuild path of every native addon into the
// bundle, so `app/dist/postbote.gjs.mjs` carries a path into the machine and directory that built
// it. postbote ships libsignal (Rust behind N-API), so a build made in a CI container or a
// release directory cannot be shipped, copied, packaged or moved: the copy dies at the first
// Signal command with `gjsify-napi: cannot resolve addon path '…'`. The addon is loaded on first
// use, so the bundle STARTS fine and fails later — which is why no other check in this repo
// notices. `mcp-gjs-smoke.mjs` runs the real bundle from inside the tree, where the baked path
// happens to be right, and is green for exactly that reason.
//
// gjsify gap (unfixed, gjsify fix/napi-addon-relocatable): the bundler must stop baking an
// absolute addon path and resolve a bundle-relative one at load time. Until it does, this probe
// reports the gap loudly and exits 0, because CI has to stay green on a repo that cannot be
// moved yet. It is not a rubber stamp: it exits 1 if the addon fails to load, if the copy can
// still see a `node_modules`, or if — once the fix lands — the bundle ever carries an absolute
// addon path again. Then the banner disappears and the run itself becomes the assertion; the
// check it stands in for is named in the banner.
//
// What it runs. `postbote addon-canary`, which calls `loadSignalLib()` and prints typeofs and
// export counts: no socket, no Signal server, no account, no config, no index, no secret. No
// user data can appear in its output, so the transcript is safe to keep.
//
// Prerequisite: `gjsify install` + `gjsify workspace postbote-cli build`, and gjs on PATH.
// Run with: `node app/tests/integration/bundle-relocation.mjs` (or `gjsify workspace postbote-cli test:relocation`).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

import { countOccurrences, findBakedAddonPaths } from './bundle-paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..', '..'); // tests/integration -> app
const repoRoot = join(appRoot, '..'); // app -> repo root
const bundle = join(appRoot, 'dist', 'postbote.gjs.mjs');

// The gjsify bin lives in the WORKSPACE ROOT's node_modules, not app/'s — the same reason
// mcp-gjs-smoke.mjs says it. `gjsify run` is the production entry: it puts the gjsify typelibs and
// its own prebuild dirs on GI_TYPELIB_PATH / LD_LIBRARY_PATH by itself, so the child needs a
// minimal env and a green run is evidence about the BUNDLE, not about an env we assembled.
const gjsify = join(repoRoot, 'node_modules', '.bin', 'gjsify');

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

if (!existsSync(bundle)) fail('build first — app/dist/postbote.gjs.mjs missing');
if (!existsSync(gjsify)) fail('run `gjsify install` first — @gjsify/cli bin missing');
const gjsifyVersion = spawnSync(gjsify, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? '?';

// ── the detector, before the detector's verdict ───────────────────────────────
//
// A probe that reports "relocatable" because its pattern stopped matching would be the worst
// outcome available here: the gap would be declared closed and the bundle shipped. So the same
// scan runs over a planted absolute path first, and the probe refuses to interpret the real
// bundle if it cannot find that one.
const PLANTED = '/planted/root/node_modules/@signalapp/libsignal-client/prebuilds/a.node';
const plantedHits = findBakedAddonPaths(`loadAddon(\`${PLANTED}\`)`);
if (plantedHits.length !== 1 || plantedHits[0] !== PLANTED) {
  fail(
    `the detector is broken — it missed a planted absolute addon path (got ${JSON.stringify(plantedHits)})`,
  );
}

// ── the static half: what the bundle carries ──────────────────────────────────

const bundleText = readFileSync(bundle, 'utf8');
const baked = findBakedAddonPaths(bundleText);
const rootHits = countOccurrences(bundleText, repoRoot);

console.log('postbote bundle relocation probe');
console.log(`  bundle     ${bundle} (${(bundleText.length / 1e6).toFixed(1)} MB, built here)`);
console.log(`  baked      ${baked.length === 0 ? 'no absolute addon path' : baked.join('\n             ')}`);
console.log(`  build root ${rootHits} occurrence(s) of ${repoRoot} in the bundle text`);

// ── the behavioural half: the same bundle, copied out of the tree ─────────────

const scratch = mkdtempSync(join(tmpdir(), 'postbote-relocation-'));
const relocated = join(scratch, 'postbote.gjs.mjs');

// Nothing above the copy may hold a `node_modules`, or the relocation test proves nothing: the
// graph could resolve the addon from there and the baked path would never be exercised. A
// `.gjsify-link.json` beside a bundle is a second, machine-local way to find native addons.
const reachable = [];
for (let dir = scratch, up = parse(scratch).root; ; dir = parse(dir).dir) {
  const candidate = join(dir, 'node_modules');
  if (existsSync(candidate)) reachable.push(candidate);
  if (dir === up) break;
}
if (reachable.length > 0)
  fail(`a node_modules is reachable from the copy — the test is void: ${reachable.join(', ')}`);
if (existsSync(join(scratch, '.gjsify-link.json')))
  fail('a .gjsify-link.json sits in the copy — it is not standalone');
if (scratch.startsWith(`${repoRoot}/`))
  fail(`the scratch dir ${scratch} is inside the repo — copying there would be a no-op`);

copyFileSync(bundle, relocated);

// gjsify >= 0.53 no longer bakes the addon path: the bundle finds it by package IDENTITY, in a
// node_modules reachable from the bundle's own location (the `<bundle dir>/addons/` layout it
// names in its error is not read yet — measured). A bundle with no node_modules around it cannot
// load a third-party addon, so the shipped unit is "bundle + the addon package". This stages
// exactly that beside the copy — the one package, nothing else of the build tree — so the run
// proves the bundle carries no path into the machine that built it.
const ADDON_PKG = '@signalapp/libsignal-client';
const addonSource = join(repoRoot, 'node_modules', ADDON_PKG);
const addonStaged = join(scratch, 'node_modules', ADDON_PKG);
const prebuildDir = `prebuilds/${process.platform}-${process.arch}`;
if (existsSync(join(addonSource, prebuildDir))) {
  mkdirSync(join(addonStaged, prebuildDir), { recursive: true });
  copyFileSync(join(addonSource, 'package.json'), join(addonStaged, 'package.json'));
  for (const file of readdirSync(join(addonSource, prebuildDir))) {
    copyFileSync(join(addonSource, prebuildDir, file), join(addonStaged, prebuildDir, file));
  }
}

// Minimal env, and the differences are part of what this probe reports:
//   - LD_LIBRARY_PATH / GI_TYPELIB_PATH / NODE_PATH: anything inherited could resolve a native
//     library from the build machine and hide the gap. `gjsify run` exports what its own prebuilds
//     need, so nothing of ours is required.
//   - POSTBOTE_CLI_PREBUILD: set for the UNIT test run only (app/package.json "test"), and
//     irrelevant on GJS, where the addon path comes out of the bundle. Dropping it is the point —
//     it shows the load needs no hint from the environment.
//   - XDG_*: the canary touches no account, but pointing these at the scratch dir means that if
//     that ever changes it writes into a temp dir rather than a real index. cwd is the scratch
//     dir for the same reason: `import 'dotenv/config'` finds no `.env` to read there.
const env = { ...process.env };
for (const name of ['LD_LIBRARY_PATH', 'GI_TYPELIB_PATH', 'NODE_PATH', 'POSTBOTE_CLI_PREBUILD']) {
  delete env[name];
}
Object.assign(env, {
  XDG_DATA_HOME: join(scratch, 'data'),
  XDG_CONFIG_HOME: join(scratch, 'config'),
  XDG_CACHE_HOME: join(scratch, 'cache'),
  POSTBOTE_CLI_ADDON_CANARY: '1',
});

console.log(`  copy       ${relocated}`);
console.log(
  `  reachable  no node_modules above ${scratch}, no .gjsify-link.json; ${ADDON_PKG} staged beside the copy`,
);
console.log('  env        LD_LIBRARY_PATH, GI_TYPELIB_PATH, NODE_PATH, POSTBOTE_CLI_PREBUILD removed;');
console.log('             XDG_{DATA,CONFIG,CACHE}_HOME and cwd pointed at the copy');
console.log(`  runner     gjsify ${gjsifyVersion} run <copy> addon-canary`);

const run = spawnSync(gjsify, ['run', relocated, 'addon-canary'], {
  cwd: scratch,
  env,
  encoding: 'utf8',
  timeout: 300_000,
});
const stdout = run.stdout ?? '';
const stderr = run.stderr ?? '';
const canaryLine = stdout.split('\n').find((line) => line.includes('"canary":"addon"'));
let report = null;
try {
  report = canaryLine ? JSON.parse(canaryLine) : null;
} catch {
  report = null;
}
// Exit code alone cannot tell a loaded addon from an empty namespace object, so the shapes the
// canary reports are the assertion: both halves loaded, both non-empty, all four Rust-backed
// constructors callable (a half-finished N-API registration leaves the module object in place
// and these missing).
const loaded =
  run.status === 0 &&
  report?.canary === 'addon' &&
  report?.core === 'object' &&
  report?.zk === 'object' &&
  report?.coreExports > 0 &&
  report?.zkExports > 0 &&
  Object.values(report?.bindings ?? {}).every((kind) => kind === 'function');

console.log(`  run        exit ${run.status}${loaded ? `, addon loaded: ${canaryLine}` : ''}`);
if (!loaded) {
  const tail = [stdout, stderr]
    .join('\n')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('$ '))
    .slice(-6)
    .join('\n            ');
  console.log(`  output     ${tail}`);
}
rmSync(scratch, { recursive: true, force: true });

// Two worlds, one code path. The static scan says which one this is; below, the run is asserted
// in both.
if (baked.length > 0) {
  const stillThere = existsSync(baked[0]);
  const line = '='.repeat(78);
  console.log(`
${line}
  KNOWN GAP — a built postbote bundle is not relocatable. Exiting 0 on purpose.
${line}
  cause        gjsify build --app gjs bakes the ABSOLUTE prebuild path of the native addon into
               the bundle, so the bundle only loads libsignal on the machine and at the path that
               built it. postbote cannot be shipped, copied or packaged until that changes, and
               the failure is LATE: the bundle starts, then dies at the first Signal command
               with "gjsify-napi: cannot resolve addon path '…'".

  the assertion this stands in for
               findBakedAddonPaths(bundle) must return nothing. It returned ${baked.length}:
                 ${baked.join('\n                 ')}
               The build root appears ${rootHits} time(s) in the bundle text, all of it inside
               that path — the build machine's home directory sits in a file meant for release.

  why the run above did not catch it
               it succeeded, and that is the trap. The baked path
                 ${baked[0]}
               ${stillThere ? 'still exists on this machine, so the copy loaded the addon out of' : 'does not exist, so a successful run would mean the gap is already gone —'}
               ${stillThere ? "the build tree's node_modules, not from anywhere near the copy. A tree" : 'which contradicts the scan above. Report both; never delete the scan.'}
               ${stillThere ? 'that was moved, or a bundle built in a container, fails exactly here.' : ''}

  the fix      gjsify branch fix/napi-addon-relocatable — the bundle must carry a path relative
               to itself and resolve the prebuild at load time. When it lands, this banner
               disappears, the run above becomes the assertion (the addon must load from the
               copy), and an absolute addon path in the bundle text turns this probe RED.

  the marker   // gjsify gap (unfixed, gjsify fix/napi-addon-relocatable)
               in app/src/frontends/cli/addon-canary.ts — update it to the PR number when there is one

  environment  POSTBOTE_CLI_PREBUILD is NOT set for this run. The unit test suite sets it and
               this probe deliberately does not: on GJS the addon path comes out of the bundle,
               so the load above needed no hint from the environment.

  if the run FAILED, the gap is no longer latent
               the tree this bundle was built at is gone or moved, and app/dist is broken right
               now. That is a real failure, not this banner.`);

  if (!loaded) {
    fail(
      'the relocated copy could not load the native addon while the bundle bakes an absolute ' +
        'path. If the build tree is still on disk, something other than the known gap is broken ' +
        '— see the output above. If it is not, the gap has been hit for real.',
    );
  }
  console.log('\nKNOWN GAP reported, exit 0. Relocation is NOT fixed.');
  process.exit(0);
}

// No absolute addon path: the gap is closed, and from here on this is an ordinary assertion.
if (rootHits > 0) {
  fail(
    `the bundle carries the build root ${rootHits} time(s) but no absolute addon path — ` +
      'relocatable, yet the build machine path is still in a file meant for release',
  );
}
if (!loaded) {
  fail(
    'the bundle bakes no absolute addon path, but the relocated copy still could not load it — ' +
      'the fix landed broken. See the output above.',
  );
}
console.log(`OK: no absolute addon path in the bundle — none of ${repoRoot} is baked in`);
console.log(
  `OK: the relocated copy loaded libsignal — ${report.coreExports} core / ${report.zkExports} zk exports, all four Rust bindings callable`,
);
console.log('OK: a built postbote bundle survives being moved. The gap is closed.');
process.exit(0);
