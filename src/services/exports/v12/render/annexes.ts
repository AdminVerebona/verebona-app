/**
 * Annexes intégrées (CDC §14.1, ANN-PDF-001 à 008) avec pdf-lib.
 *
 * Le dossier imprimé par Chromium contient déjà, pour chaque page source, une
 * page d'annexe au design validé : bannière « A1 · titre · type · date ·
 * Page n / N du document » (ANN-PDF-004), pied « Ce dossier a été préparé
 * avec Verebona. · Page X / Y », et un cadre vide. Chaque page du PDF source
 * y est APPOSÉE en vectoriel (Form XObject : texte sélectionnable, aucune
 * rastérisation), mise à l'échelle pour tenir dans le cadre, ratio conservé,
 * centrée, rotation `/Rotate` respectée (ANN-PDF-003/005). L'index
 * (ANN-PDF-001/002) porte les vrais numéros de page grâce aux deux passes.
 *
 * Les images annexées sont posées directement par le HTML (`<img>` en
 * *contain*) et n'ont pas besoin de cette étape.
 *
 * `inspectPdfFile` contrôle un PDF source AVANT le rendu : un PDF chiffré est
 * « protected », illisible « corrupted » — il est alors exclu du dossier et la
 * génération devient partielle (SEL-GEN-006, ALT-004). Pour une pièce intégrée
 * au PDF, l'inspection est STRICTE (apposition à blanc) : une pièce retenue
 * s'appose ensuite sans surprise, l'index et la pagination sont justes.
 *
 * Isolement : tout décodage d'un PDF utilisateur (inspection, apposition) se
 * fait dans `annex-worker.cjs`, un worker_thread au tas plafonné et limité en
 * durée (`EXPORTS_ANNEX_WORKER_MEMORY_MB`, `EXPORTS_ANNEX_WORKER_TIMEOUT_MS`),
 * avec un plafond de décompression (`EXPORTS_ANNEX_MAX_DECODED_MB`).
 * Un échec du worker (mémoire, délai) vaut « corrupted » : la pièce est exclue.
 */

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { PDFDocument } from 'pdf-lib';
import type { PageMap } from '../types';
import type { FrameRect } from './render-pdf';

/** Largeur A4 en px CSS (210 mm à 96 dpi). */
const A4_WIDTH_PX = 793.7007874;
/** Marge intérieure du cadre (px CSS) : la page source ne touche pas le filet. */
const FRAME_INSET_PX = 6;

/** Dimensions utiles (CropBox, points) et rotation d'une page source. */
export interface PageBox { width: number; height: number; rotation: number }

export type PdfInspection =
  | { status: 'ok'; pages: number; boxes: PageBox[] }
  | { status: 'protected' | 'corrupted'; pages: null; reason: string };

// ─── Worker d'isolement ─────────────────────────────────────────────────────

const envInt = (name: string, def: number, min: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : def;
};
/** Tas maximal du worker (Mo, défaut 512). */
export const annexWorkerMemoryMb = (): number => envInt('EXPORTS_ANNEX_WORKER_MEMORY_MB', 512, 64);
/** Volume décompressé maximal par document dans le worker (Mo, défaut 256 ; 64 Mo max par flux). */
export const annexMaxDecodedMb = (): number => envInt('EXPORTS_ANNEX_MAX_DECODED_MB', 256, 1);
/** Durée maximale d'une opération du worker (ms, défaut 60 s). */
export const annexWorkerTimeoutMs = (): number => envInt('EXPORTS_ANNEX_WORKER_TIMEOUT_MS', 60_000, 1_000);

/**
 * Chemin du worker : résolu depuis la racine du projet comme le répertoire
 * statique (le bundle Next.js ne relocalise pas ce fichier) ;
 * `EXPORTS_V12_ANNEX_WORKER` permet de le déplacer.
 */
export function annexWorkerFile(): string {
  const override = process.env.EXPORTS_V12_ANNEX_WORKER?.trim();
  return override ? path.resolve(override) : path.join(process.cwd(), 'src', 'services', 'exports', 'v12', 'render', 'annex-worker.cjs');
}

export class AnnexWorkerError extends Error {}

/** Exécute une opération dans un worker neuf, tué au délai ou au dépassement mémoire. */
function runAnnexWorker<T>(data: Record<string, unknown>, transferList: ArrayBuffer[] = [], timeoutMs = annexWorkerTimeoutMs()): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(annexWorkerFile(), {
        workerData: { ...data, limits: { maxDecodedBytes: annexMaxDecodedMb() * 1024 * 1024 } },
        transferList,
        resourceLimits: { maxOldGenerationSizeMb: annexWorkerMemoryMb(), maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
        stdout: false,
        stderr: false,
      });
    } catch (e) {
      reject(new AnnexWorkerError(`worker indisponible : ${(e as Error).message}`));
      return;
    }
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new AnnexWorkerError(`délai dépassé (${timeoutMs} ms)`))), timeoutMs);
    worker.once('message', (m: { ok: boolean; result?: T; error?: string }) =>
      done(() => (m?.ok ? resolve(m.result as T) : reject(new AnnexWorkerError(m?.error ?? 'échec du worker')))));
    // ERR_WORKER_OUT_OF_MEMORY, exception non rattrapée…
    worker.once('error', (e) => done(() => reject(new AnnexWorkerError(e.message))));
    worker.once('exit', (code) => done(() => reject(new AnnexWorkerError(`worker arrêté (code ${code})`))));
  });
}

/**
 * Contrôle d'un PDF source (fichier local) dans le worker : lisible, non
 * chiffré, au moins une page. `strict` : toutes les pages sont réellement
 * incorporées (pièce destinée au PDF). Toute défaillance du worker → corrupted.
 */
export async function inspectPdfFile(file: string, opts: { strict: boolean }): Promise<PdfInspection> {
  try {
    return await runAnnexWorker<PdfInspection>({ op: 'inspect', path: file, strict: opts.strict });
  } catch (e) {
    return { status: 'corrupted', pages: null, reason: `inspection interrompue : ${(e as Error).message}`.slice(0, 200) };
  }
}

// ─── Apposition ─────────────────────────────────────────────────────────────

export interface OverlayAnnex {
  annexRef: string;
  pageCount: number;
  /** PDF source à apposer ; absent pour une image (déjà dans le HTML). */
  pdfPath?: string;
  /** Pages sources inspectées (dimensions, rotation). */
  boxes?: PageBox[];
}

export interface OverlayResult {
  pdf: Buffer;
  /** Annexes dont l'apposition a échoué (à exclure : le dossier est re-rendu sans elles). */
  failed: string[];
}

/** Position d'une page source dans un cadre, en points PDF (origine en bas à gauche). */
export function placeInFrame(params: {
  pageWidthPt: number; pageHeightPt: number; frame: FrameRect; srcWidth: number; srcHeight: number; rotation: number;
}): { x: number; y: number; scale: number; rotate: number } {
  const k = params.pageWidthPt / A4_WIDTH_PX;
  const fx = (params.frame.left + FRAME_INSET_PX) * k;
  const fw = Math.max(1, (params.frame.width - 2 * FRAME_INSET_PX) * k);
  const fh = Math.max(1, (params.frame.height - 2 * FRAME_INSET_PX) * k);
  const fTop = (params.frame.top + FRAME_INSET_PX) * k;
  const rot = ((params.rotation % 360) + 360) % 360;
  const quarter = rot === 90 || rot === 270;
  const dispW = quarter ? params.srcHeight : params.srcWidth;
  const dispH = quarter ? params.srcWidth : params.srcHeight;
  const scale = Math.min(fw / dispW, fh / dispH);
  const X = fx + (fw - dispW * scale) / 2;
  const Y = params.pageHeightPt - fTop - fh + (fh - dispH * scale) / 2;
  const w = params.srcWidth * scale;
  const h = params.srcHeight * scale;
  // /Rotate est une rotation horaire à l'affichage : on tourne de −rot autour du point d'ancrage.
  switch (rot) {
    case 90: return { x: X, y: Y + w, scale, rotate: -90 };
    case 180: return { x: X + w, y: Y + h, scale, rotate: -180 };
    case 270: return { x: X + h, y: Y, scale, rotate: -270 };
    default: return { x: X, y: Y, scale, rotate: 0 };
  }
}

/** Métadonnées du dossier (identiques à celles posées par le worker). */
function setDossierMetadata(out: PDFDocument, title: string, subject: string | undefined, date: Date): void {
  out.setTitle(title);
  if (subject) out.setSubject(subject);
  out.setAuthor('Verebona');
  out.setCreator('Verebona');
  out.setProducer('Verebona — dossiers V12 (Chromium, pdf-lib)');
  out.setLanguage('fr-FR');
  out.setCreationDate(date);
  out.setModificationDate(date);
}

interface WorkerDraw { srcIndex: number; targetIndex: number; x: number; y: number; scale: number; rotate: number }

/**
 * Appose les pages des PDF sources sur leurs pages d'annexe (dans le worker).
 *  frames    : un cadre par page d'annexe, dans l'ordre (toutes annexes, images comprises) ;
 *  pageSizes : dimensions (points) des pages du PDF imprimé.
 * Un échec global du worker (mémoire, délai) rend toutes les annexes PDF « en échec ».
 */
export async function applyAnnexOverlays(params: {
  pdf: Buffer;
  annexes: OverlayAnnex[];
  pageMap: PageMap;
  frames: FrameRect[];
  pageSizes: Array<{ width: number; height: number }>;
  metadata: { title: string; subject?: string; date?: Date };
}): Promise<OverlayResult> {
  const failed: string[] = [];
  const jobs: Array<{ annexRef: string; path: string; draws: WorkerDraw[] }> = [];
  let frameIndex = 0;
  for (const a of params.annexes) {
    const firstFrame = frameIndex;
    frameIndex += Math.max(1, a.pageCount);
    if (!a.pdfPath) continue;
    const start = params.pageMap.annexStart[a.annexRef];
    const n = Math.min(a.boxes?.length ?? 0, a.pageCount);
    if (!start || n < 1) { failed.push(a.annexRef); continue; }
    const draws: WorkerDraw[] = [];
    for (let i = 0; i < n; i++) {
      const targetIndex = start - 1 + i;
      const size = params.pageSizes[targetIndex];
      const frame = params.frames[firstFrame + i];
      const box = a.boxes![i];
      if (!size || !frame) { draws.length = 0; break; }
      draws.push({
        srcIndex: i, targetIndex,
        ...placeInFrame({ pageWidthPt: size.width, pageHeightPt: size.height, frame, srcWidth: box.width, srcHeight: box.height, rotation: box.rotation }),
      });
    }
    if (!draws.length) { failed.push(a.annexRef); continue; }
    jobs.push({ annexRef: a.annexRef, path: a.pdfPath, draws });
  }

  const date = params.metadata.date ?? new Date();
  if (!jobs.length) {
    // Aucune page source à apposer : le PDF imprimé (produit par Chromium) est
    // sûr, les métadonnées sont posées ici sans passer par le worker.
    const out = await PDFDocument.load(params.pdf, { updateMetadata: false });
    setDossierMetadata(out, params.metadata.title, params.metadata.subject, date);
    return { pdf: Buffer.from(await out.save()), failed };
  }

  // Copie transférable : le Buffer d'origine peut partager un ArrayBuffer du pool Node.
  const bytes = new Uint8Array(params.pdf.byteLength);
  bytes.set(params.pdf);
  const metadata = { ...params.metadata, date: date.toISOString() };
  try {
    const res = await runAnnexWorker<{ pdf: Uint8Array; failed: Array<{ annexRef: string; reason: string }> }>(
      { op: 'overlay', pdf: bytes, annexes: jobs, metadata },
      [bytes.buffer],
    );
    for (const f of res.failed) {
      console.error(`[exports-v12] apposition de l'annexe ${f.annexRef} impossible :`, f.reason);
      failed.push(f.annexRef);
    }
    return { pdf: Buffer.from(res.pdf.buffer, res.pdf.byteOffset, res.pdf.byteLength), failed };
  } catch (e) {
    console.error('[exports-v12] worker d\'apposition en échec :', (e as Error).message);
    return { pdf: params.pdf, failed: [...failed, ...jobs.map((j) => j.annexRef)] };
  }
}
