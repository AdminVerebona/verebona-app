/**
 * Lot 109K (ticket T1 « couverture PDF », COR-01) — couche texte DÉTERMINISTE
 * du PDF original, page par page, pour la vérification de couverture.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * La sonde historique (`source-verification#probePdf`, pdf-lib) lit les
 * chaînes des flux de contenu : elle ne décode NI les polices composites
 * (CID / Identity-H, sortie ordinaire des navigateurs et des logiciels de
 * facturation), NI les encodages propres (/Differences), NI le texte posé dans
 * une forme (XObject). Sur ces pages elle ne rend aucun échantillon et la page
 * reste « non vérifiée » alors que T1 l'a peut-être lue intégralement : une
 * FAUSSE incertitude.
 *
 * Voie fiable, sans IA : la couche texte pdf.js (cartes ToUnicode, CMaps),
 * DÉJÀ extraite avant le modèle et persistée (`document_raw_extracts`, lot 61)
 * avec l'empreinte SHA-256 des octets lus (lot 75C, G). Elle est RÉUTILISÉE
 * quand l'empreinte des octets vérifiés est identique ; sinon (extract absent,
 * contenu différent, table absente) elle est recalculée EN MÉMOIRE depuis les
 * mêmes octets (aucun téléchargement, aucune écriture, aucun appel IA).
 *
 * La transcription OCR persistée (`ocr_pages`) n'est PAS une preuve : c'est
 * la lecture du modèle lui-même — comparer la transcription à elle-même ne
 * prouverait rien. Elle sert seulement à qualifier le MOTIF d'une page
 * scannée (texte reconnu / aucun texte reconnu), jamais à la vérifier.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';

export type PageTextLayerOrigin = 'PERSISTED_RAW_EXTRACT' | 'IN_MEMORY_EXTRACTION';

export interface PageTextLayer {
  /** Texte de la couche texte, par page (1…n) ; '' : page sans couche texte. */
  pages: ReadonlyMap<number, string>;
  pageCount: number | null;
  origin: PageTextLayerOrigin;
  /** Empreinte des octets dont la couche texte est issue. */
  sourceSha256: string;
  /** Extract tronqué (bornes) : les pages au-delà sont absentes de `pages`, jamais réputées vides. */
  truncated: boolean;
}

export const sha256Hex = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/** Pages d'un extract brut (texte intégral + positions) → texte par page (pure). */
export function pageTextsFromRawExtract(fullText: string | null | undefined, pages: ReadonlyArray<{ page: number; start: number; end: number }> | null | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!fullText || !Array.isArray(pages)) return out;
  for (const p of pages) {
    if (!Number.isInteger(p.page) || p.page < 1 || !Number.isInteger(p.start) || !Number.isInteger(p.end) || p.end < p.start) continue;
    out.set(p.page, fullText.slice(p.start, p.end));
  }
  return out;
}

type Row = Record<string, unknown>;

/** Extract persisté du fichier pour CES octets (même empreinte, extraction non en échec), sinon null. Ne lève jamais. */
async function persistedLayer(p: { accountId: number; fileId: number; sha: string }): Promise<PageTextLayer | null> {
  try {
    const { pgClient } = await import('@/db');
    const { RAW_EXTRACTOR_VERSION } = await import('../raw-extract/extract');
    const [r] = (await pgClient.unsafe(
      `SELECT full_text, pages, page_count, truncated, extraction_status, source_sha256, extractor_version
         FROM document_raw_extracts
        WHERE file_id = $1 AND account_id = $2`,
      [p.fileId, p.accountId] as never[],
    )) as unknown as Row[];
    if (!r || String(r.source_sha256 ?? '').toLowerCase() !== p.sha || Number(r.extractor_version) !== RAW_EXTRACTOR_VERSION) return null;
    if (r.extraction_status === 'FAILED' || r.extraction_status === 'NOT_SUPPORTED') return null;
    const pages = pageTextsFromRawExtract(r.full_text as string | null, r.pages as Array<{ page: number; start: number; end: number }> | null);
    return { pages, pageCount: r.page_count == null ? null : Number(r.page_count), origin: 'PERSISTED_RAW_EXTRACT', sourceSha256: p.sha, truncated: r.truncated === true };
  } catch {
    return null;
  }
}

/**
 * Couche texte du PDF vérifié : extract persisté de même empreinte, sinon
 * extraction en mémoire des mêmes octets. `null` : lecture impossible (la
 * vérification retombe sur la seule sonde — jamais une page réputée lue).
 */
export async function loadPageTextLayer(p: {
  accountId: number;
  fileId: number | null;
  bytes: Uint8Array;
  /** Extraction (remplaçable en test). */
  extract?: (bytes: Uint8Array) => Promise<{ fullText: string | null; pages: Array<{ page: number; start: number; end: number }>; pageCount: number | null; truncated: boolean; status: string } | null>;
}): Promise<PageTextLayer | null> {
  const sha = sha256Hex(p.bytes);
  if (p.fileId) {
    const persiste = await persistedLayer({ accountId: p.accountId, fileId: p.fileId, sha });
    if (persiste) return persiste;
  }
  try {
    const ex = p.extract
      ? await p.extract(p.bytes)
      : await (async () => {
        const { extractRawText, rawExtractLimits } = await import('../raw-extract/extract');
        return extractRawText({ bytes: p.bytes, mimeType: 'application/pdf' }, rawExtractLimits());
      })();
    if (!ex || ex.status === 'FAILED' || ex.status === 'NOT_SUPPORTED') return null;
    return { pages: pageTextsFromRawExtract(ex.fullText, ex.pages), pageCount: ex.pageCount, origin: 'IN_MEMORY_EXTRACTION', sourceSha256: sha, truncated: ex.truncated };
  } catch {
    return null;
  }
}
