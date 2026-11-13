/**
 * The one version of Curlew: `app/package.json`. Everything that shows or reports a version (the
 * About dialog, `curlew --version`, the MCP server handshake) reads it from here; the bundler
 * inlines the JSON, so it holds on GJS and Node and in the unit tests alike. A test pins
 * the root `package.json`, every package and the newest metainfo release to the same number.
 */
import pkg from '../../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
