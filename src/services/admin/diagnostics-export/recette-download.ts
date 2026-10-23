/**
 * Lot 82E — téléchargement d'un export complet de recette stocké (OVH S3).
 * Serveur uniquement.
 *
 *   · un fichier : URL signée de COURTE durée (règle des dossiers V12 :
 *     `shortLivedDownloadUrl`), émise après revérification des droits ; le
 *     chemin demandé doit figurer au manifeste (ou être un fichier de
 *     documentation) — jamais une clé arbitraire du stockage ;
 *   · l'ensemble : archive ZIP produite EN FLUX depuis le stockage (fichiers
 *     lus un par un, à la demande ; parties déjà compressées stockées telles
 *     quelles), mémoire bornée. Limite du format (jszip sans ZIP64) : 4 Gio —
 *     au-delà, refus explicite (fichiers téléchargeables un par un).
 */
import { Readable, type PassThrough } from 'node:stream';
import JSZip from 'jszip';
import { writeWithBackpressure } from '@/services/admin/account-data/stream-response';
import { ZIP_MAX_BYTES } from './zip';
import { isSafeRecettePath } from './recette-catalog';
import { recettePrefix, type RecetteManifest, type RecetteStorage } from './recette';

export const RECETTE_DOC_FILES = ['manifeste.json', 'LISEZMOI.txt', 'dictionnaire.json', 'dictionnaire.csv'] as const;

/** Fichiers téléchargeables d'une génération (manifeste en dernier). */
export function recetteDownloadables(m: RecetteManifest | null): string[] {
  if (!m) return [];
  // Fichiers effectivement écrits (une partie annulée n'existe pas dans le stockage).
  const written = m.files.filter((f) => f.sha256 !== null).map((f) => f.path);
  const docs = RECETTE_DOC_FILES.filter((p) => written.includes(p));
  return [...docs, ...written.filter((p) => !(RECETTE_DOC_FILES as readonly string[]).includes(p)), 'manifeste.json'];
}

/** Chemin demandé autorisé pour cette génération ? */
export function isDownloadablePath(m: RecetteManifest | null, path: string): boolean {
  return isSafeRecettePath(path) && recetteDownloadables(m).includes(path);
}

export function recetteContentType(path: string): string {
  if (path.endsWith('.ndjson.gz')) return 'application/gzip';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.csv')) return 'text/csv';
  return 'text/plain';
}

/** Nom de téléchargement : `verebona-recette-<génération>-<chemin>`. */
export function recetteFileName(generationId: string, path: string): string {
  return `verebona-recette-${generationId.slice(0, 8)}-${path.replace(/\//g, '_')}`;
}

/** Entrée lue à la demande depuis le stockage (contre-pression vers l'archive). */
function lazyObject(storage: RecetteStorage, key: string): Readable {
  let body: NodeJS.ReadableStream | null = null;
  let started = false;
  const r = new Readable({
    read() {
      if (body) { (body as Readable).resume?.(); return; }
      if (started) return;
      started = true;
      void (async () => {
        try {
          const { GetObjectCommand } = await import('@aws-sdk/client-s3');
          const o = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key })) as { Body?: NodeJS.ReadableStream };
          if (!o.Body) throw new Error(`objet ${key} vide`);
          body = o.Body;
          body.on('data', (c: Buffer) => { if (!r.push(c)) (body as Readable).pause?.(); });
          body.on('end', () => r.push(null));
          body.on('error', (e: Error) => r.destroy(e));
        } catch (e) {
          r.destroy(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    },
  });
  return r;
}

export type RecetteZipOutcome = { ok: true; bytes: number } | { ok: false; bytes: number; error: unknown; clientGone: boolean };

/** Archive complète d'une génération, écrite en flux dans `out`. */
export async function streamRecetteZip(m: RecetteManifest, storage: RecetteStorage, out: PassThrough): Promise<RecetteZipOutcome> {
  const zip = new JSZip();
  const date = new Date(m.generatedAt);
  const prefix = recettePrefix(m.generationId);
  const entries: Readable[] = [];
  for (const path of recetteDownloadables(m)) {
    const e = lazyObject(storage, `${prefix}${path}`);
    entries.push(e);
    zip.file(path, e, { date, binary: true, createFolders: true, compression: path.endsWith('.gz') ? 'STORE' : 'DEFLATE' });
  }
  const zs = zip.generateNodeStream({ streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
  let bytes = 0;
  const outcome = await new Promise<RecetteZipOutcome>((resolve) => {
    let settled = false;
    const done = (o: RecetteZipOutcome) => { if (!settled) { settled = true; resolve(o); } };
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
