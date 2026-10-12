// Builds the curlew bundle: `node scripts/build-bundle.mjs <gjs|node>`.
//
// The only reason this is not a plain `gjsify build` line: a distributor (the Flatpak manifest)
// can embed ONE Telegram api_id/api_hash pair through CURLEW_TELEGRAM_EMBEDDED_API_ID and
// CURLEW_TELEGRAM_EMBEDDED_API_HASH. The pair becomes the compile-time constant
// `__CURLEW_TELEGRAM_EMBEDDED__` ("<id>:<hash>") — only when both are set. CI and dev builds set
// neither, pass no --define, and embed nothing. The values are never printed.
import { spawnSync } from 'node:child_process';

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
