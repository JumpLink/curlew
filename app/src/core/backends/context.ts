/**
 * The `BackendContext` a backend is constructed with: its settings from the config, the
 * environment, and its own private secrets directory. The one place those are decided, so no
 * backend picks a path or reads the config file by itself.
 */

import type { BackendContext } from '@curlew/protocol';
import { secretsDir } from '@curlew/store';
import { join } from 'node:path';
import type { CurlewConfig } from '../config.ts';

export function backendContext(
  name: string,
  config: CurlewConfig,
  env: NodeJS.ProcessEnv = process.env,
): BackendContext {
  return {
    settings: config.backends[name]?.settings ?? {},
    env,
    secretsDir: join(secretsDir(env), name),
  };
}
