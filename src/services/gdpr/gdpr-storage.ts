/**
 * Accès S3 (OVH) de l'export RGPD : lecture des documents déposés, dépôt des
 * parties de l'archive, suppression des archives expirées.
 *
 * Lot 103C (ticket P1 « Fiabilisation de l'export », §3 D) :
 *  · profil `worker` de la fabrique centrale (`@/lib/s3-config`) — délais de
 *    connexion et d'inactivité adaptés aux traitements longs, au lieu du
 *    client interactif ;
 *  · tout en FLUX disque ↔ stockage : un document est écrit dans un fichier
 *    temporaire en calculant sa taille et son empreinte SHA-256, l'archive est
 *    envoyée depuis son fichier — jamais un document ni une archive entière
 *    en mémoire ;
 *  · nouvelles tentatives BORNÉES sur les erreurs transitoires (délai,
 *    injoignable, 5xx), jamais sur un objet absent ou un refus d'accès ;
 *  · journaux sans secret ni URL (`logS3Error`).
 *
 * Importé à la demande : la configuration S3 est lue à l'appel.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

type S3Bundle = {
  client: import('@aws-sdk/client-s3').S3Client;
  bucket: string;
  cmd: typeof import('@aws-sdk/client-s3');
  classify: typeof import('@/lib/s3-config').classifyS3Error;
  log: typeof import('@/lib/s3-config').logS3Error;
};

async function s3(): Promise<S3Bundle> {
  const [cfg, cmd] = await Promise.all([import('@/lib/s3-config'), import('@aws-sdk/client-s3')]);
  return { client: cfg.getS3Client('worker'), bucket: cfg.getS3Bucket(), cmd, classify: cfg.classifyS3Error, log: cfg.logS3Error };
}

/** Tentatives par opération de stockage (en plus de celles du SDK). */
const STORAGE_ATTEMPTS = 3;
const backoffMs = (attempt: number) => Math.min(8_000, 500 * 3 ** (attempt - 1));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isTransient(kind: string, httpStatus?: number): boolean {
  if (kind === 'TIMEOUT' || kind === 'UNREACHABLE') return true;
  if (kind === 'OTHER') return httpStatus == null || httpStatus >= 500 || httpStatus === 429;
  return false;
}

export type DownloadResult =
  | { ok: true; bytes: number; sha256: string }
  | { ok: false; reason: 'NOT_FOUND' | 'READ_FAILED'; detail: string };

/** Hash + compteur au passage du flux. */
function hashing(): { stream: Transform; digest: () => { bytes: number; sha256: string } } {
  const h = createHash('sha256');
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) { h.update(chunk); bytes += chunk.length; cb(null, chunk); },
  });
  return { stream, digest: () => ({ bytes, sha256: h.digest('hex') }) };
}

/**
 * Copie un objet stocké vers `dest` en flux (taille et SHA-256 calculées au
 * passage). Objet absent → `NOT_FOUND` (inutile de réessayer) ; erreurs
 * transitoires réessayées (bornées) puis `READ_FAILED`.
 */
export async function downloadStoredFileToPath(key: string, bucket: string | null | undefined, dest: string): Promise<DownloadResult> {
  const { client, bucket: defaultBucket, cmd, classify, log } = await s3();
  let last = 'inconnu';
  for (let attempt = 1; attempt <= STORAGE_ATTEMPTS; attempt++) {
    try {
      const res = await client.send(new cmd.GetObjectCommand({ Bucket: bucket || defaultBucket, Key: key }));
      if (!res.Body) return { ok: false, reason: 'NOT_FOUND', detail: 'corps vide' };
      const h = hashing();
      await pipeline(res.Body as NodeJS.ReadableStream, h.stream, fs.createWriteStream(dest));
      return { ok: true, ...h.digest() };
    } catch (e) {
      await fs.promises.rm(dest, { force: true }).catch(() => undefined);
      const info = classify(e);
      last = `${info.kind}${info.httpStatus ? ` HTTP ${info.httpStatus}` : ''}`;
      if (info.kind === 'NOT_FOUND') return { ok: false, reason: 'NOT_FOUND', detail: last };
      // Flux coupé en cours de lecture (ECONNRESET, fin prématurée) : transitoire.
      const streamCut = info.kind === 'OTHER' && /premature|aborted|ECONNRESET|socket/i.test(String((e as Error)?.message ?? ''));
      if (!(isTransient(info.kind, info.httpStatus) || streamCut) || attempt === STORAGE_ATTEMPTS) {
        log('gdpr-export lecture', e, { attempt });
        return { ok: false, reason: 'READ_FAILED', detail: last };
      }
      await sleep(backoffMs(attempt));
    }
  }
  return { ok: false, reason: 'READ_FAILED', detail: last };
}

/** Erreur de stockage transitoire épuisée (le job sera retenté). */
export class StorageUnavailableError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE';
  constructor(message: string) { super(message); this.name = 'StorageUnavailableError'; }
}

/** Envoie un fichier local en flux (taille connue). Erreurs transitoires réessayées, puis `StorageUnavailableError`. */
export async function uploadFileFromPath(localPath: string, key: string, contentType: string): Promise<void> {
  const { client, bucket, cmd, classify, log } = await s3();
  const size = (await fs.promises.stat(localPath)).size;
  for (let attempt = 1; attempt <= STORAGE_ATTEMPTS; attempt++) {
    try {
      await client.send(new cmd.PutObjectCommand({
        Bucket: bucket, Key: key, Body: fs.createReadStream(localPath), ContentLength: size, ContentType: contentType,
        Metadata: { 'x-verebona-type': 'gdpr-export' },
      }));
      return;
    } catch (e) {
      const info = classify(e);
      if (!isTransient(info.kind, info.httpStatus) || attempt === STORAGE_ATTEMPTS) {
        log('gdpr-export dépôt', e, { attempt });
        throw new StorageUnavailableError(`dépôt de l’archive impossible (${info.kind}${info.httpStatus ? ` HTTP ${info.httpStatus}` : ''})`);
      }
      await sleep(backoffMs(attempt));
    }
  }
}

export async function deleteStoredFile(key: string): Promise<boolean> {
  try {
    const { client, bucket, cmd } = await s3();
    await client.send(new cmd.DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e) {
    const { logS3Error } = await import('@/lib/s3-config').catch(() => ({ logS3Error: null as never }));
    if (logS3Error) logS3Error('gdpr-export suppression', e);
    else console.error('[gdpr-storage] suppression impossible :', (e as Error).message);
    return false;
  }
}
