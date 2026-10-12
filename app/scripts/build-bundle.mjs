// Builds the curlew bundle: `node scripts/build-bundle.mjs <gjs|node>`.
//
// Two reasons it is not a plain `gjsify build` line. The second is the catalogues, down near the
// build call. The first: a distributor (the Flatpak manifest)
// can embed ONE Telegram api_id/api_hash pair through CURLEW_TELEGRAM_EMBEDDED_API_ID and
// CURLEW_TELEGRAM_EMBEDDED_API_HASH. The pair becomes the compile-time constant
// `__CURLEW_TELEGRAM_EMBEDDED__` ("<id>:<hash>") — only when both are set. CI and dev builds set
// neither, pass no --define, and embed nothing. The values are never printed.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (target !== 'gjs' && target !== 'node') {
  console.error('usage: build-bundle.mjs <gjs|node>');
  process.exit(2);
}

const id = (process.env.CURLEW_TELEGRAM_EMBEDDED_API_ID ?? '').trim();
const hash = (process.env.CURLEW_TELEGRAM_EMBEDDED_API_HASH ?? '').trim();
const defines = [];
if (id || hash) {
  if (!/^[1-9][0-9]*$/.test(id) || !/^[0-9a-f]{32}$/i.test(hash)) {
    console.error(
      'CURLEW_TELEGRAM_EMBEDDED_API_ID and CURLEW_TELEGRAM_EMBEDDED_API_HASH must be set together: ' +
        'a positive whole number and 32 hexadecimal characters (values not shown)',
    );
    process.exit(1);
  }
  defines.push('--define', `__CURLEW_TELEGRAM_EMBEDDED__=${JSON.stringify(`${id}:${hash.toLowerCase()}`)}`);
  console.error('build-bundle: embedding a Telegram api_id/api_hash pair from the environment');
}

// The catalogues, into dist/locale, before the bundle: `gjsify ship` reads `gjsify.ship.localeDir`
// and hard-fails on a directory that holds no .mo, so a release built from a tree that never
// compiled them does not get as far as a package. The script itself skips (with a warning) when
// msgfmt is missing — a build without gettext installed runs in English, the source language.
const i18nScript = fileURLToPath(new URL('../../dev/i18n.sh', import.meta.url));
const catalogues = spawnSync(i18nScript, ['compile'], { stdio: 'inherit' });
if (catalogues.status !== 0) process.exit(catalogues.status ?? 1);

const result = spawnSync(
  'gjsify',
  [
    'build',
    'src/index.ts',
    '--app',
    target,
    '--external',
    'jimp,sharp',
    '--outfile',
    `dist/curlew.${target}.mjs`,
    ...defines,
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
