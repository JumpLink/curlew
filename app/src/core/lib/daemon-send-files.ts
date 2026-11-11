/**
 * The daemon's side of attachments that arrive as file descriptors (wire v7, ADR 0011).
 *
 * A caller never names a path the daemon should open: it opens the file itself and hands the
 * descriptor over the bus, so the daemon reads exactly what the caller could read — and a daemon in
 * a sandbox needs no access to the caller's files at all. The senders, though, take paths
 * (`inspectSendFiles` resolves, stats and checks one, and the upload opens it again), so the
 * descriptor is copied once into a private directory and the unchanged send plan runs on the copy.
 * Copying also keeps the guard honest: it checks a regular file in a directory only this process
 * can enter, not a path somebody may swap between the check and the read.
 */

import GLib from 'gi://GLib?version=2.0';
import type Gio from 'gi://Gio?version=2.0';
import GioUnix from 'gi://GioUnix?version=2.0';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensurePrivateDir, sendStagingDir } from '@curlew/store';
import { DAEMON_MAX_FILE_BYTES, type DaemonFdPlan } from './daemon-bus.ts';

/** The copies of one call's files, in the order the request named them. */
export interface StagedFiles {
  paths: string[];
  /** Delete the copies. Twice is fine. */
  cleanup(): void;
}

const CHUNK_BYTES = 256 * 1024;

function readChunk(stream: GioUnix.InputStream): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    stream.read_bytes_async(CHUNK_BYTES, GLib.PRIORITY_DEFAULT, null, (_source, result) => {
      try {
        resolve(stream.read_bytes_finish(result!).get_data() ?? new Uint8Array(0));
      } catch (error) {
        reject(error as Error);
      }
    });
  });
}

/** Copy one descriptor into `target`, and stop at the byte cap: a caller does not get to fill the disk. */
async function copyDescriptor(fd: number, target: string): Promise<void> {
  const stream = new GioUnix.InputStream({ fd, close_fd: true });
  const out = openSync(target, 'wx', 0o600);
  try {
    let total = 0;
    for (;;) {
      const chunk = await readChunk(stream);
      if (chunk.length === 0) return;
      total += chunk.length;
      if (total > DAEMON_MAX_FILE_BYTES) {
        throw new Error(`an attachment is larger than the ${DAEMON_MAX_FILE_BYTES} bytes the daemon accepts`);
      }
      writeSync(out, chunk);
    }
  } finally {
    closeSync(out);
    stream.close(null);
  }
}

/**
 * Copy the descriptors of one call into a fresh 0700 directory, as planned by `planFdFiles`.
 * Nothing is left behind on a failure; on success the caller runs `cleanup` when the send is over.
 */
export async function stageSendFiles(fdList: Gio.UnixFDList | null, plan: readonly DaemonFdPlan[]): Promise<StagedFiles> {
  if (plan.length === 0 || fdList === null) return { paths: [], cleanup: () => {} };
  const root = mkdtempSync(join(ensurePrivateDir(sendStagingDir()), 'send-'));
  const cleanup = (): void => rmSync(root, { recursive: true, force: true });
  try {
    const paths: string[] = [];
    for (const step of plan) {
      const target = join(root, step.relativePath);
      mkdirSync(dirname(target), { mode: 0o700 });
      await copyDescriptor(fdList.get(step.handle), target);
      paths.push(target);
    }
    return { paths, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
