/**
 * Lot 107G — téléchargement d'un diagnostic durable (serveur uniquement).
 *
 *   · l'archive : ZIP produit EN FLUX depuis les fichiers stockés de la
 *     tentative publiée — chaque fichier est lu à la demande, décompressé à
 *     la volée et recompressé dans le ZIP (mêmes chemins et même contenu que
 *     l'ancien ZIP du diagnostic : `manifeste.json`, `donnees/…`), mémoire
 *     bornée (un morceau à la fois, contre-pression jusqu'au client) ; un
 *     client parti ou une coupure n'affecte jamais l'archive stockée :
 *     relancer le téléchargement suffit ;
 *   · un fichier : URL signée de courte durée (fichier `.json.gz`), seulement
 *     pour un chemin listé dans l'index d'intégrité (jamais une clé arbitraire).
 */
import { Readable, type PassThrough } from 'node:stream';
import { createGunzip, gunzipSync } from 'node:zlib';
import JSZip from 'jszip';
import { writeWithBackpressure } from '@/services/admin/account-data/stream-response';
import { ZIP_MAX_BYTES } from '@/services/admin/diagnostics-export/zip';
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

/** Lecture fichier stocké (`.gz`) → contenu décompressé, à la demande, avec contre-pression. */
function lazyInflated(storage: DiagStorage, key: string): Readable {
  let source: Readable | null = null;
  let started = false;
  const r = new Readable({
    read() {
      if (source) { source.resume(); return; }
      if (started) return;
      started = true;
      void (async () => {
        try {
          const { GetObjectCommand } = await import('@aws-sdk/client-s3');
          const o = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key })) as { Body?: NodeJS.ReadableStream };
          if (!o.Body) throw new Error('objet vide');
          const gunzip = createGunzip();
          (o.Body as Readable).on('error', (e: Error) => gunzip.destroy(e));
          source = (o.Body as Readable).pipe(gunzip);
          source.on('data', (c: Buffer) => { if (!r.push(c)) source!.pause(); });
          source.on('end', () => r.push(null));
          source.on('error', (e: Error) => r.destroy(e));
        } catch (e) {
          r.destroy(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    },
  });
  return r;
}

type ZipOutcome = { ok: true; bytes: number } | { ok: false; bytes: number; error: unknown; clientGone: boolean };

/** Archive ZIP complète d'une tentative publiée, écrite en flux dans `out`. */
export async function streamDiagnosticJobZip(index: DiagStoredIndex, storage: DiagStorage, prefix: string, out: PassThrough): Promise<ZipOutcome> {
  const zip = new JSZip();
  const entries: Readable[] = [];
  const date = new Date(index.generatedAt);
  // Ordre : manifeste et rapport en tête (lecture humaine), puis l'ordre de production.
  const order = (p: string) => (p === 'manifeste.json' ? 0 : p === 'rapport.txt' ? 1 : p === 'integrite.json' ? 2 : p === 'SHA256SUMS.txt' ? 3 : 4);
  const files = [...index.files].sort((a, b) => order(a.path) - order(b.path));
  const listedIndex = index.files.some((f) => f.path === 'integrite.json');
  for (const f of files) {
    const e = lazyInflated(storage, `${prefix}${f.path}.gz`);
    entries.push(e);
    zip.file(f.path, e, { date, binary: true, createFolders: true });
  }
  // L'index d'intégrité n'est pas listé dans lui-même : ajouté à l'archive.
  if (!listedIndex) {
    const e = lazyInflated(storage, `${prefix}integrite.json.gz`);
    entries.push(e);
    zip.file('integrite.json', e, { date, binary: true, createFolders: true });
  }
  const zs = zip.generateNodeStream({ streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
  let bytes = 0;
  const outcome = await new Promise<ZipOutcome>((resolve) => {
    let settled = false;
    const done = (o: ZipOutcome) => { if (!settled) { settled = true; resolve(o); } };
    zs.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > ZIP_MAX_BYTES) {
        zs.pause();
        done({ ok: false, bytes, error: new Error('archive au-delà de 4 Gio (format ZIP sans ZIP64) : téléchargez les fichiers un par un'), clientGone: false });
        return;
      }
      zs.pause();
      writeWithBackpressure(out, chunk).then(() => zs.resume(), (err) => done({ ok: false, bytes, error: err, clientGone: true }));
    });
    zs.on('end', () => done({ ok: true, bytes }));
    zs.on('error', (err: unknown) => done({ ok: false, bytes, error: err, clientGone: false }));
  });
  if (!outcome.ok) for (const e of entries) if (!e.destroyed) e.destroy();
  return outcome;
}

/** Chemin téléchargeable un par un ? (listé dans l'index ; jamais `..`, jamais absolu). */
export function isStoredPath(index: DiagStoredIndex, path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('..') || path.includes('\\')) return false;
  return path === 'integrite.json' || index.files.some((f) => f.path === path);
}
