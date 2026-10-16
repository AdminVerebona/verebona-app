/**
 * Lot 61 — extract BRUT déterministe d'un document (ticket T1 §3).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Lecture SANS modèle, avant toute structuration :
 *   · PDF : couche texte de CHAQUE page (pdf.js), dans l'ordre, sans résumé
 *     ni reformulation, pages séparées par « --- page N --- » (format déjà lu
 *     par la vérification de couverture) ; positions de chaque page dans le
 *     texte (traçabilité par page) ;
 *   · texte brut (text/*, JSON, CSV) : contenu tel quel ;
 *   · images : aucune couche texte → OCR_REQUIRED (OCR délégué au modèle
 *     multimodal, contrôlé par la vérification de couverture lot 49B/54G).
 *
 * Jamais d'exhaustivité supposée :
 *   · page sans couche texte (scan, image, page blanche) → listée dans
 *     `pagesWithoutText`, statut PARTIAL_OCR_REQUIRED / OCR_REQUIRED ;
 *   · bornes (pages, caractères) atteintes → TRUNCATED, `truncated` + motif
 *     explicite (jamais COMPLETE) ;
 *   · lecture impossible (PDF corrompu, chiffré, moteur indisponible) →
 *     FAILED avec l'erreur, jamais un extract vide présenté comme complet.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Version de l'extracteur : un changement de règle invalide la réutilisation. */
export const RAW_EXTRACTOR_VERSION = 1;

export type RawExtractMethod = 'PDF_TEXT_LAYER' | 'PLAIN_TEXT' | 'NONE';
export type RawExtractStatus = 'COMPLETE' | 'PARTIAL_OCR_REQUIRED' | 'OCR_REQUIRED' | 'TRUNCATED' | 'FAILED' | 'NOT_SUPPORTED';

export interface RawExtractPage {
  page: number;
  /** Caractères de la page (hors marque). */
  chars: number;
  /** Position [start, end[ du texte de la page dans `fullText`. */
  start: number;
  end: number;
  hasText: boolean;
}

export interface RawExtract {
  method: RawExtractMethod;
  status: RawExtractStatus;
  pageCount: number | null;
  pagesWithText: number;
  pagesWithoutText: number[];
  truncated: boolean;
  truncationReason: string | null;
  fullText: string | null;
  pages: RawExtractPage[];
  error: string | null;
  durationMs: number;
}

export interface RawExtractLimits {
  maxPages: number;
  maxChars: number;
  /** Durée maximale de lecture (ms) : au-delà, arrêt à une frontière de page, TRUNCATED. */
  maxMs?: number;
}

/** Bornes administrables par l'environnement (défauts larges, jamais silencieuses). */
export function rawExtractLimits(env: Record<string, string | undefined> = process.env): RawExtractLimits {
  const pages = Number(env.T1_RAW_EXTRACT_MAX_PAGES);
  const chars = Number(env.T1_RAW_EXTRACT_MAX_CHARS);
  const ms = Number(env.T1_RAW_EXTRACT_MAX_MS);
  return {
    maxPages: Number.isFinite(pages) && pages > 0 ? Math.min(pages, 10_000) : 2_000,
    maxChars: Number.isFinite(chars) && chars > 0 ? Math.min(chars, 50_000_000) : 10_000_000,
    maxMs: Number.isFinite(ms) && ms > 0 ? Math.min(ms, 900_000) : 120_000,
  };
}

const TEXT_MIMES = /^(text\/|application\/(json|xml|csv|x-ndjson))/i;
const IMAGE_MIMES = /^image\//i;

/** Marque de page lue par `source-units/text#pageMarker`. */
export const rawPageMarker = (n: number) => `--- page ${n} ---`;

function vide(method: RawExtractMethod, status: RawExtractStatus, t0: number, over: Partial<RawExtract> = {}): RawExtract {
  return {
    method, status, pageCount: null, pagesWithText: 0, pagesWithoutText: [], truncated: false, truncationReason: null,
    fullText: null, pages: [], error: null, durationMs: Date.now() - t0, ...over,
  };
}

/** Texte d'une page pdf.js : éléments dans l'ordre, fins de ligne respectées. */
function pageText(items: ReadonlyArray<unknown>): string {
  let s = '';
  for (const it of items) {
    if (!it || typeof it !== 'object' || !('str' in it)) continue;
    const o = it as { str: string; hasEOL?: boolean };
    s += o.str;
    if (o.hasEOL) s += '\n';
  }
  return s.replace(/[ \t]+\n/g, '\n').trimEnd();
}

type PdfJs = {
  getDocument: (p: Record<string, unknown>) => { promise: Promise<PdfDoc>; destroy?: () => Promise<void> };
};
type PdfDoc = {
  numPages: number;
  getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }>; cleanup?: () => void }>;
  destroy: () => Promise<void>;
};

/** Moteur pdf.js (chargé à l'exécution, jamais empaqueté). Remplaçable en test. */
export async function loadPdfJs(): Promise<PdfJs> {
  const mod = await import(/* webpackIgnore: true */ 'pdfjs-dist/legacy/build/pdf.mjs');
  return mod as unknown as PdfJs;
}

/** Couche texte d'un PDF, page par page. */
export async function extractPdfTextLayer(bytes: Uint8Array, limits: RawExtractLimits = rawExtractLimits(), pdfjs?: PdfJs): Promise<RawExtract> {
  const t0 = Date.now();
  let lib: PdfJs;
  try {
    lib = pdfjs ?? await loadPdfJs();
  } catch (e) {
    return vide('PDF_TEXT_LAYER', 'FAILED', t0, { error: `moteur de lecture PDF indisponible : ${(e as Error).message}` });
  }
  let doc: PdfDoc | null = null;
  try {
    // Copie : pdf.js détache le tampon transmis.
    doc = await lib.getDocument({
      data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
    }).promise;
    const pageCount = doc.numPages;
    const pages: RawExtractPage[] = [];
    const sansTexte: number[] = [];
    let texte = '';
    let truncated = false;
    let truncationReason: string | null = null;
    const derniere = Math.min(pageCount, limits.maxPages);
    if (pageCount > limits.maxPages) {
      truncated = true;
      truncationReason = `pages ${limits.maxPages + 1} à ${pageCount} non extraites (borne de ${limits.maxPages} pages)`;
    }
    for (let n = 1; n <= derniere; n++) {
      if (limits.maxMs && n > 1 && Date.now() - t0 > limits.maxMs) {
        truncated = true;
        truncationReason = `lecture bornée à ${limits.maxMs} ms : pages ${n} à ${pageCount} non extraites`;
        break;
      }
      const page = await doc.getPage(n);
      const t = pageText((await page.getTextContent()).items);
      page.cleanup?.();
      const marque = `${texte ? '\n\n' : ''}${rawPageMarker(n)}\n`;
      if (texte.length + marque.length + t.length > limits.maxChars) {
        truncated = true;
        truncationReason = `texte borné à ${limits.maxChars} caractères : extraction arrêtée à la page ${n} (pages ${n} à ${pageCount} non extraites)`;
        break;
      }
      texte += marque;
      const start = texte.length;
      texte += t;
      const hasText = t.trim().length > 0;
      if (!hasText) sansTexte.push(n);
      pages.push({ page: n, chars: t.length, start, end: texte.length, hasText });
    }
    const avecTexte = pages.filter((p) => p.hasText).length;
    // Troncature prioritaire : un extract borné n'est JAMAIS présenté comme complet.
    const status: RawExtractStatus = truncated ? 'TRUNCATED'
      : avecTexte === 0 ? 'OCR_REQUIRED' : sansTexte.length > 0 ? 'PARTIAL_OCR_REQUIRED' : 'COMPLETE';
    return {
      method: 'PDF_TEXT_LAYER', status, pageCount, pagesWithText: avecTexte, pagesWithoutText: sansTexte,
      truncated, truncationReason, fullText: texte, pages, error: null, durationMs: Date.now() - t0,
    };
  } catch (e) {
    return vide('PDF_TEXT_LAYER', 'FAILED', t0, { error: `PDF illisible : ${(e as Error).message}` });
  } finally {
    await doc?.destroy().catch(() => undefined);
  }
}

/** Extract brut selon le type du fichier. Ne lève jamais. */
export async function extractRawText(p: { bytes: Uint8Array; mimeType: string | null }, limits: RawExtractLimits = rawExtractLimits(), pdfjs?: PdfJs): Promise<RawExtract> {
  const t0 = Date.now();
  const mime = (p.mimeType ?? '').toLowerCase();
  if (mime.includes('pdf')) return extractPdfTextLayer(p.bytes, limits, pdfjs);
  if (TEXT_MIMES.test(mime)) {
    const brut = new TextDecoder('utf-8', { fatal: false }).decode(p.bytes);
    const truncated = brut.length > limits.maxChars;
    const fullText = truncated ? brut.slice(0, limits.maxChars) : brut;
    return vide('PLAIN_TEXT', truncated ? 'TRUNCATED' : fullText.trim() ? 'COMPLETE' : 'OCR_REQUIRED', t0, {
      fullText, truncated, truncationReason: truncated ? `texte borné à ${limits.maxChars} caractères sur ${brut.length}` : null,
      pagesWithText: fullText.trim() ? 1 : 0,
    });
  }
  if (IMAGE_MIMES.test(mime)) {
    return vide('NONE', 'OCR_REQUIRED', t0, { pageCount: 1, pagesWithoutText: [1], error: null });
  }
  return vide('NONE', 'NOT_SUPPORTED', t0, { error: `type ${mime || 'inconnu'} : pas d'extraction déterministe (lecture par le modèle)` });
}
