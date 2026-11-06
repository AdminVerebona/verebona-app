/**
 * Lot 107G — téléchargement d'un diagnostic durable (serveur uniquement).
 *
 *   · l'archive : lot 113Q — l'archive ZIP DÉFINITIVE, assemblée et vérifiée
 *     une fois par le worker, est servie telle quelle (`streamStoredArchive`) ;
 *     pour une publication antérieure (sans archive définitive), ZIP assemblé
 *     en flux par COPIE des fichiers compressés, sans recompression. Mêmes
 *     chemins et même contenu (`manifeste.json`, `donnees/…`), mémoire bornée
 *     (un morceau à la fois, contre-pression jusqu'au client) ; un client
 *     parti ou une coupure n'affecte jamais l'archive stockée : relancer le
 *     téléchargement suffit ;
 *   · un fichier : URL signée de courte durée (fichier `.json.gz`), seulement
 *     pour un chemin listé dans l'index d'intégrité (jamais une clé arbitraire).
 */
import type { PassThrough } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { writeWithBackpressure } from '@/services/admin/account-data/stream-response';
import type { DiagStorage, DiagStoredIndex } from './runner';

/** Index d'intégrité stocké d'une tentative publiée ; null : absent (purgé, jamais publié). */
export async function readStoredIndex(storage: DiagStorage, prefix: string): Promise<DiagStoredIndex | null> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    const o = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: `${prefix}integrite.json.gz` })) as { Body?: { transformToByteArray?: () => Promise<Uint8Array> } & NodeJS.ReadableStream };
    const bytes = o.Body?.transformToByteArray ? Buffer.from(await o.Body.transformToByteArray()) : await streamToBuffer(o.Body as NodeJS.ReadableStream);
    return JSON.parse(gunzipSync(bytes).toString('utf8')) as DiagStoredIndex;
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'NoSuchKey' || (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

async function streamToBuffer(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

type ZipOutcome = { ok: true; bytes: number } | { ok: false; bytes: number; error: unknown; clientGone: boolean };

/**
 * Lot 113Q — ARCHIVE DÉFINITIVE déjà prête : l'objet ZIP stocké (assemblé et
 * vérifié par le worker) est servi TEL QUEL, en flux, avec contre-pression
 * jusqu'au client. Aucun recalcul, aucune décompression ni compression : un
 * second téléchargement relit le même objet.
 */
export async function streamStoredArchive(storage: DiagStorage, key: string, out: PassThrough): Promise<ZipOutcome> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  let bytes = 0;
  try {
    const o = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key })) as { Body?: AsyncIterable<Uint8Array> & { destroy?: () => void } };
    if (!o.Body) throw new Error('archive vide');
    try {
      for await (const c of o.Body) {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
        bytes += b.length;
        try { await writeWithBackpressure(out, b); } catch (err) { o.Body.destroy?.(); return { ok: false, bytes, error: err, clientGone: true }; }
      }
    } catch (e) {
      return { ok: false, bytes, error: e, clientGone: false };
    }
    return { ok: true, bytes };
  } catch (e) {
    return { ok: false, bytes, error: e, clientGone: false };
  }
}

/**
 * Archive d'une tentative publiée AVANT le lot 113Q (sans archive
 * définitive) : assemblée en flux depuis les fichiers stockés — lot 113Q :
 * par COPIE des flux compressés (`archive.ts`), sans décompression ni
 * recompression, ZIP64 au besoin (plus de limite de 4 Gio).
 */
export async function streamDiagnosticJobZip(index: DiagStoredIndex, storage: DiagStorage, prefix: string, out: PassThrough): Promise<ZipOutcome> {
  const { archiveOrder, writeArchive } = await import('./archive');
  let bytes = 0;
  let clientGone = false;
  try {
    const r = await writeArchive(storage, archiveOrder(index, prefix, null), new Date(index.generatedAt), async (c) => {
      bytes += c.length;
      try { await writeWithBackpressure(out, c); } catch (err) { clientGone = true; throw err; }
    });
    return { ok: true, bytes: r.bytes };
  } catch (e) {
    return { ok: false, bytes, error: e, clientGone };
  }
}

/** Chemin téléchargeable un par un ? (listé dans l'index ; jamais `..`, jamais absolu). */
export function isStoredPath(index: DiagStoredIndex, path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('..') || path.includes('\\')) return false;
  return path === 'integrite.json' || index.files.some((f) => f.path === path);
}
