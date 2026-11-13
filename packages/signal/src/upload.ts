/**
 * Uploading one attachment: encrypt it, ask Signal where to put it, put it there.
 *
 * The flow is Signal-Desktop's (`ts/textsecure/WebAPI` `getAttachmentUploadForm` and
 * `putEncryptedAttachment`, `ts/util/uploads/tusProtocol`; Copyright Signal Messenger, LLC,
 * AGPL-3.0-only):
 *
 * 1. a fresh 64-byte key (32 AES-256-CBC, 32 HMAC-SHA256) and the plaintext padded with zeros to
 *    Signal's size bucket, so the stored size does not tell the file's exact length;
 * 2. `GET /v4/attachments/form/upload` on the authenticated chat connection returns the CDN
 *    number, the CDN key and the signed upload URL with the headers to send there;
 * 3. the ciphertext goes to the CDN over HTTPS, NOT through the chat socket: CDN 3 takes one TUS
 *    "creation with upload" POST, CDN 2 a POST that answers a `Location` and a PUT to it.
 *
 * The pointer a message carries holds the key, the digest and the CDN key; the recipient's
 * `decryptAttachment` is the other half of this.
 */

import { _, fmt } from '@curlew/protocol';
import { SIGNAL_ROOT_CA_PEM } from './constants.ts';
import { encryptAttachment, random } from './crypto.ts';
import type { ChatFetch } from './guard.ts';
import { basicAuth } from './net.ts';

/** Where the server says to put the ciphertext. */
export interface UploadForm {
  cdn: number;
  key: string;
  headers: Record<string, string>;
  signedUploadLocation: string;
}

/** Puts the encrypted bytes at the form's location. Injected so tests play the CDN. */
export type AttachmentUploader = (form: UploadForm, data: Uint8Array) => Promise<void>;

/** What a message's `AttachmentPointer` is made of. */
export interface UploadedAttachment {
  cdnKey: string;
  cdnNumber: number;
  key: Uint8Array;
  digest: Uint8Array;
  /** The plaintext size, without padding: the recipient cuts at it. */
  size: number;
}

/** The request the upload form is asked with; `guard.ts` names the same path. */
export function uploadFormPath(encryptedSize: number): string {
  return `/v4/attachments/form/upload?uploadLength=${encryptedSize}`;
}

/** Signal's size buckets (Desktop `getAttachmentSizeBucket`): 1.05^n, at least 541 bytes. */
export function paddedSize(size: number): number {
  return Math.max(541, Math.floor(1.05 ** Math.ceil(Math.log(size) / Math.log(1.05))));
}

/** Padding is zeros; `size` in the pointer is what cuts it off again. */
export function padAttachment(plaintext: Uint8Array): Uint8Array {
  if (plaintext.length === 0) return plaintext;
  const out = new Uint8Array(paddedSize(plaintext.length));
  out.set(plaintext);
  return out;
}

function reasonOfStatus(status: number): string {
  return `HTTP ${status}`;
}

export async function uploadAttachment(
  plaintext: Uint8Array,
  account: { aci: string; deviceId: number; password: string },
  fetch: ChatFetch,
  upload: AttachmentUploader,
): Promise<UploadedAttachment> {
  const key = random(64);
  const { data, digest } = encryptAttachment(padAttachment(plaintext), key);
  const response = await fetch({
    verb: 'GET',
    path: uploadFormPath(data.length),
    headers: [basicAuth(`${account.aci}.${account.deviceId}`, account.password)],
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      fmt(_('Signal would not take the file ({status}) — nothing was sent'), {
        status: reasonOfStatus(response.status),
      }),
    );
  }
  let form: UploadForm;
  try {
    const json = JSON.parse(new TextDecoder().decode(response.body ?? new Uint8Array())) as Record<
      string,
      unknown
    >;
    const location = json.signedUploadLocation ?? json.signedUploadUrl;
    if (typeof json.cdn !== 'number' || typeof json.key !== 'string' || typeof location !== 'string') {
      throw new Error('incomplete');
    }
    form = {
      cdn: json.cdn,
      key: json.key,
      headers: (json.headers ?? {}) as Record<string, string>,
      signedUploadLocation: location,
    };
  } catch {
    throw new Error(_('Signal answered the upload request with something curlew cannot read — nothing was sent'));
  }
  await upload(form, data);
  return { cdnKey: form.key, cdnNumber: form.cdn, key, digest, size: plaintext.length };
}

interface HttpsResult {
  status: number;
  location?: string;
}

async function httpsRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Uint8Array,
): Promise<HttpsResult> {
  const https = await import('node:https');
  return new Promise<HttpsResult>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        ca: SIGNAL_ROOT_CA_PEM,
        timeout: 120_000,
        headers: { ...headers, 'Content-Length': String(body.length) },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          const location = res.headers.location;
          resolve({ status: res.statusCode ?? 0, ...(location ? { location } : {}) });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('the CDN did not answer in time')));
    req.on('error', reject);
    req.end(body);
  });
}

function checked(result: HttpsResult): HttpsResult {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      fmt(_('the file server refused the upload ({status}) — nothing was sent'), {
        status: reasonOfStatus(result.status),
      }),
    );
  }
  return result;
}

/**
 * The real CDN upload over `node:https`, pinned to Signal's root like the download. One request
 * (CDN 3) or two (CDN 2); no resuming — a failed upload is repeated whole by sending again.
 */
export function httpsUploader(): AttachmentUploader {
  return async (form, data) => {
    if (form.cdn === 2) {
      const created = checked(await httpsRequest(form.signedUploadLocation, 'POST', form.headers, new Uint8Array(0)));
      if (!created.location) throw new Error(_('the file server named no place to upload to — nothing was sent'));
      checked(
        await httpsRequest(created.location, 'PUT', { 'Content-Range': `bytes 0-*/${data.length}` }, data),
      );
      return;
    }
    const filename = btoa(form.key);
    checked(
      await httpsRequest(
        form.signedUploadLocation,
        'POST',
        {
          ...form.headers,
          'Tus-Resumable': '1.0.0',
          'Upload-Length': String(data.length),
          'Upload-Metadata': `filename ${filename}`,
          'Content-Type': 'application/offset+octet-stream',
        },
        data,
      ),
    );
  };
}
