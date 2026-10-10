/**
 * Découpage par pages d'un document dont la sortie T1 est SATURÉE — ticket
 * T1, « Ne plus tronquer silencieusement un document » :
 *
 *   document → passe 1 → saturation constatée → pages restantes en lots
 *   (chunk 1…N) → fusion idempotente → consolidation.
 *
 * Saturation (déterministe, aucun appel) : jetons de sortie au-delà du seuil
 * (`T1_SATURATION_OUTPUT_TOKENS`, 30 000 par défaut ≈ 90 % du plancher de
 * 32 768 de l'opération). Un document normal n'est JAMAIS découpé : aucun
 * téléchargement, aucun appel de plus.
 *
 * Lots : PDF d'UN fichier (pdf-lib, déjà dépendance), pages `dernière page
 * lue … fin` par paquets de `T1_CHUNK_PAGES` (20), au plus `T1_MAX_CHUNKS`
 * (50) lots. La dernière page lue est relue (elle a pu être coupée) : la
 * fusion dédoublonne. Un lot en échec devient une lacune `page:A:gap:B`
 * (FAILED) — jamais une perte silencieuse.
 */
import type { AiAttachment } from '../../gateway/types';

export const DEFAULT_CHUNK_PAGES = 20;
export const DEFAULT_MAX_CHUNKS = 50;
export const DEFAULT_SATURATION_OUTPUT_TOKENS = 30_000;
const FETCH_TIMEOUT_MS = 60_000;

const entier = (v: string | undefined, def: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v.trim() !== '' ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
};

export function chunkSettings(env: Record<string, string | undefined> = process.env) {
  return {
    chunkPages: entier(env.T1_CHUNK_PAGES, DEFAULT_CHUNK_PAGES, 1, 200),
    maxChunks: entier(env.T1_MAX_CHUNKS, DEFAULT_MAX_CHUNKS, 1, 500),
    saturationOutputTokens: entier(env.T1_SATURATION_OUTPUT_TOKENS, DEFAULT_SATURATION_OUTPUT_TOKENS, 1_000, 1_000_000),
  };
}

/**
 * La sortie de la passe a-t-elle atteint la borne de génération (le reste du
 * document peut manquer) ? Une transcription au-delà de 200 000 caractères
 * n'est PAS une saturation : le modèle l'a rendue en entier, elle est
 * réintégrée par le lot de débordement.
 */
export function isSaturated(p: { outputTokens: number }, env = process.env): boolean {
  return p.outputTokens >= chunkSettings(env).saturationOutputTokens;
}

/** Lots de pages à analyser à partir de `fromPage` (inclus) ; le surplus au-delà de `maxChunks` est rendu à part. */
export function planChunks(pageCount: number, fromPage: number, chunkPages: number, maxChunks: number): {
  chunks: Array<{ start: number; end: number }>; beyond: { start: number; end: number } | null;
} {
  const chunks: Array<{ start: number; end: number }> = [];
  let start = Math.max(1, fromPage);
  while (start <= pageCount && chunks.length < maxChunks) {
    const end = Math.min(pageCount, start + chunkPages - 1);
    chunks.push({ start, end });
    start = end + 1;
  }
  return { chunks, beyond: start <= pageCount ? { start, end: pageCount } : null };
}

/** Octets d'une source (URL S3 signée). Remplaçable en test. */
export async function fetchSourceBytes(url: string): Promise<Uint8Array | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function countPdfPages(bytes: Uint8Array): Promise<number | null> {
  try {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    return null;
  }
}

/** Sous-document des pages `start…end` (base 1, incluses). */
export async function extractPdfPages(bytes: Uint8Array, start: number, end: number): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i));
  for (const p of pages) out.addPage(p);
  return out.save();
}

/** Pièce jointe d'un lot : PDF des pages, en ligne (base64). */
export function chunkAttachment(base: { url: string; displayName?: string }, pdf: Uint8Array, start: number, end: number): AiAttachment {
  return {
    url: `${base.url.split('#')[0]}#pages=${start}-${end}`,
    mimeType: 'application/pdf',
    displayName: `${base.displayName ?? 'document'} (pages ${start} à ${end})`,
    data: Buffer.from(pdf).toString('base64'),
  };
}
