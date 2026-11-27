/**
 * `curlew transcribe` — local speech-to-text for one audio file. The window runs this as a worker
 * process so the model load and the decode stay off its main loop; each mode prints JSON lines on
 * stdout and nothing leaves the machine except a confirmed model download.
 */

import { _ } from '@curlew/protocol';
import type { CommandModule } from 'yargs';

import { installModel, readStatus, transcribeFile } from '../../core/lib/transcribe-local.ts';
import { languageOf } from '../../window/transcribe-model.ts';

const line = (value: unknown): void => console.log(JSON.stringify(value));

export const transcribeCommand: CommandModule = {
  command: 'transcribe [file]',
  get describe() {
    return _('Transcribe an audio file on this computer (nothing is sent anywhere)');
  },
  builder: (yargs) =>
    yargs
      .positional('file', { type: 'string', describe: 'The audio file' })
      .option('status', { type: 'boolean', describe: 'Report whether this machine can transcribe' })
      .option('install', { type: 'boolean', describe: 'Download the speech model' })
      .option('lang', { type: 'string', describe: 'BCP 47 language (default: from the locale)' }),
  handler: (argv) => {
    const lang = (argv.lang as string | undefined) ?? languageOf(process.env);
    const run = async (): Promise<void> => {
      if (argv.status) return line(await readStatus(lang));
      if (argv.install) {
        const ok = await installModel(lang, (received, total) => line({ progress: [received, total] }));
        return line({ ok });
      }
      if (typeof argv.file !== 'string' || argv.file === '') throw new Error('transcribe needs a file');
      line({ result: await transcribeFile(argv.file, lang) });
    };
    run()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        line({ error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      });
  },
};
