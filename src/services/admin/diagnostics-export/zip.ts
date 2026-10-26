/**
 * Lots 77C, 81C — archive ZIP du diagnostic, générée CÔTÉ SERVEUR EN FLUX
 * avec la dépendance existante `jszip` (aucune nouvelle dépendance).
 *
 * jszip sait produire une archive en flux : `generateNodeStream` avec
 * `streamFiles: true` (en-têtes locaux + descripteurs de données : aucune
 * entrée n'est gardée en mémoire pour en connaître la taille) et des
 * entrées fournies comme flux Node lus SÉQUENTIELLEMENT et À LA DEMANDE
 * (vérifié : une entrée n'est lue qu'une fois la précédente terminée). Chaque
 * fichier du plan est donc produit au moment où l'archive le demande, lot par
 * lot, dans la session de lecture ; la mémoire reste bornée (un lot, un
 * tampon de compression), quel que soit le volume.
 *
 * Contre-pression de bout en bout : client HTTP → archive → producteur. Un
 * client qui part arrête la génération (session fermée, génération FAILED) ;
 * une erreur fatale interrompt le flux : l'archive reçue est illisible
 * (pas de répertoire central), jamais présentée comme complète. Limite du
 * format (jszip sans ZIP64) : 4 Gio par archive — au-delà, la génération
 * échoue explicitement (FAILED), jamais silencieusement.
 */
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import type { DiagBundle, DiagPlan } from './collect';
import { SinkError, type TextSink } from '@/services/admin/account-data/export';
import { writeWithBackpressure } from '@/services/admin/account-data/stream-response';
import type { PassThrough } from 'node:stream';

/** Archive en mémoire d'un diagnostic déjà généré en mémoire (tests, petits volumes). */
export async function buildDiagnosticZip(bundle: Pick<DiagBundle, 'files' | 'manifest'>): Promise<Buffer> {
  const zip = new JSZip();
  const date = new Date(bundle.manifest.generatedAt);
  for (const f of bundle.files) zip.file(f.path, f.content, { date, createFolders: true });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
}

/** Limite du format ZIP sans ZIP64 (jszip) : au-delà, échec explicite. */
export const ZIP_MAX_BYTES = 4 * 1024 ** 3 - 64 * 1024 ** 2;

/** Entrée lue à la demande : le producteur ne démarre qu'à la première lecture et suit la contre-pression. */
function lazyEntry(produce: (sink: TextSink) => Promise<void>, state: { aborted: boolean }, onDone: (p: Promise<void>) => void): Readable {
  let started = false;
  let wake: (() => void) | null = null;
  let closed = false;
  const r = new Readable({
    highWaterMark: 64 * 1024,
    read() {
      if (wake) { const w = wake; wake = null; w(); }
      if (started) return;
      started = true;
      const sink: TextSink = {
        write: async (c: string) => {
          if (closed || state.aborted) throw new SinkError(new Error('archive interrompue'));
          if (!r.push(Buffer.from(c, 'utf8'))) await new Promise<void>((resolve) => { wake = resolve; });
          if (closed || state.aborted) throw new SinkError(new Error('archive interrompue'));
        },
      };
      const p = produce(sink).then(() => { r.push(null); }, (e) => { r.destroy(e instanceof Error ? e : new Error(String(e))); throw e; });
      onDone(p);
    },
  });
  r.on('close', () => { closed = true; if (wake) { const w = wake; wake = null; w(); } });
  return r;
}

type ZipOutcome = { ok: true; bytes: number } | { ok: false; bytes: number; error: unknown; clientGone: boolean };

/**
 * Écrit l'archive du plan dans `out` (flux de réponse), en flux. Rend
 * l'issue une fois l'archive terminée ou interrompue ; les producteurs en
 * cours sont attendus (la session peut alors être fermée sans requête en vol).
 */
export async function streamDiagnosticZip(plan: DiagPlan, out: PassThrough, generatedAt: Date): Promise<ZipOutcome> {
  const zip = new JSZip();
  const state = { aborted: false };
  const running: Array<Promise<void>> = [];
  const readables: Readable[] = [];
  for (const e of plan.entries) {
    const r = lazyEntry(e.produce, state, (p) => running.push(p.catch(() => undefined)));
    readables.push(r);
    zip.file(e.path, r, { date: generatedAt, createFolders: true, binary: true });
  }
  const zs = zip.generateNodeStream({ streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
  let bytes = 0;
  const outcome = await new Promise<ZipOutcome>((resolve) => {
    let settled = false;
    const done = (o: ZipOutcome) => { if (!settled) { settled = true; resolve(o); } };
    zs.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > ZIP_MAX_BYTES) {
        state.aborted = true;
        zs.pause();
        done({ ok: false, bytes, error: new Error('archive au-delà de 4 Gio (format ZIP sans ZIP64) : ciblez un objet ou une période'), clientGone: false });
        return;
      }
      zs.pause();
      writeWithBackpressure(out, chunk).then(() => zs.resume(), (err) => {
        state.aborted = true;
        done({ ok: false, bytes, error: err, clientGone: true });
      });
    });
    zs.on('end', () => done({ ok: true, bytes }));
    zs.on('error', (err: unknown) => { state.aborted = true; done({ ok: false, bytes, error: err, clientGone: false }); });
  });
  // Interruption : chaque entrée est fermée (un producteur en attente d'écriture s'arrête).
  if (!outcome.ok) for (const r of readables) if (!r.destroyed) r.destroy();
  // Producteurs en cours : terminés (ou interrompus) avant toute fermeture de session.
  await Promise.all(running);
  return outcome;
}
