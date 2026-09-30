/**
 * État canonique d'un document — CDC 15 T2-25, T2-18 (lot 15).
 *
 * Lecteur unique des métadonnées d'un document pour l'assistant : titre,
 * date, type (référentiel V2 et catalogue documentaire du registre),
 * rubrique, montant, fournisseur, état d'analyse, biens liés par la
 * relation N-N `document_asset_links` (X-01) — avec repli sur les colonnes
 * historiques `asset_id` / `linked_asset_id` si aucun lien N-N n'existe — et
 * faits T1 actifs. Borné au compte, document supprimé exclu.
 */
import { pgClient } from '@/db';
import { getDocumentType, getRubric } from '@/lib/referential/v2';
import { resolveDocumentType } from '@/services/canonical/registry';
import { documentAnalysisStatus } from '../core/document-status';

export interface CanonicalDocumentAsset {
  assetId: number;
  name: string;
  /** PRIMARY | SECONDARY | MENTIONED ; LEGACY_COLUMN si lu sur les colonnes historiques. */
  role: string;
  origin: string;
}

export interface CanonicalDocumentFact {
  id: number;
  key: string;
  /** Clé canonique du registre, si le fait en porte une. */
  canonicalKey: string | null;
  label: string | null;
  value: string | null;
  unit: string | null;
  confidence: string;
  excerpt: string | null;
}

export interface CanonicalDocumentState {
  fileId: number;
  title: string;
  documentDate: string | null;
  /** Code du référentiel V2 (`document_type_code`) et son libellé. */
  documentTypeCode: string | null;
  documentTypeLabel: string | null;
  /** Code du catalogue documentaire du registre (FACTURE, DEVIS…), résolu. */
  catalogCode: string | null;
  rubricCode: string | null;
  rubricLabel: string | null;
  amountCents: number | null;
  supplier: string | null;
  analysisStatus: string;
  /** Biens liés (N-N), rôle le plus fort d'abord. */
  assets: CanonicalDocumentAsset[];
  facts: CanonicalDocumentFact[];
}

type Row = {
  id: number; title: string; documentDate: string | null; documentTypeCode: string | null; legacyType: string | null;
  rubricCode: string | null; amountCents: number | null; supplier: string | null; analysisState: string | null;
  assetId: number | null; linkedAssetId: number | null;
};

/** Code du catalogue documentaire d'un document (type V2, sinon type historique). */
export function catalogCodeOf(documentTypeCode: string | null, legacyType: string | null): string | null {
  return resolveDocumentType(documentTypeCode)?.code ?? resolveDocumentType(legacyType)?.code ?? null;
}

/** Biens liés à des documents par la relation N-N (repli : colonnes historiques). */
export async function documentAssetsOf(accountId: number, fileIds: number[]): Promise<Map<number, CanonicalDocumentAsset[]>> {
  const out = new Map<number, CanonicalDocumentAsset[]>();
  if (fileIds.length === 0) return out;
  const liens = (await pgClient.unsafe(
    `SELECT l.file_id AS "fileId", l.asset_id AS "assetId", a.name, l.link_role AS role, l.origin
       FROM document_asset_links l
       JOIN assets a ON a.id = l.asset_id AND a.account_id = l.account_id AND a.deleted_at IS NULL
      WHERE l.account_id = $1 AND l.file_id = ANY($2::int[]) AND l.status = 'ACTIVE' AND l.asset_id IS NOT NULL
      ORDER BY CASE l.link_role WHEN 'PRIMARY' THEN 0 WHEN 'SECONDARY' THEN 1 ELSE 2 END, l.id`,
    [accountId, fileIds] as never[],
  ).catch(() => [])) as unknown as Array<{ fileId: number } & CanonicalDocumentAsset>;
  for (const l of liens) {
    const cur = out.get(l.fileId) ?? [];
    if (!cur.some((c) => c.assetId === l.assetId)) cur.push({ assetId: l.assetId, name: l.name, role: l.role, origin: l.origin });
    out.set(l.fileId, cur);
  }
  // Repli : document sans lien N-N (table absente, rattrapage non passé).
  const sans = fileIds.filter((f) => !out.has(f));
  if (sans.length) {
    const col = (await pgClient.unsafe(
      `SELECT f.id AS "fileId", a.id AS "assetId", a.name
         FROM asset_files f JOIN assets a ON a.id = coalesce(f.asset_id, f.linked_asset_id) AND a.account_id = f.account_id AND a.deleted_at IS NULL
        WHERE f.account_id = $1 AND f.id = ANY($2::int[])`,
      [accountId, sans] as never[],
    )) as unknown as Array<{ fileId: number; assetId: number; name: string }>;
    for (const c of col) out.set(c.fileId, [{ assetId: c.assetId, name: c.name, role: 'PRIMARY', origin: 'LEGACY_COLUMN' }]);
  }
  return out;
}

/** État canonique d'un document du compte ; `null` s'il n'existe pas ou est supprimé. */
export async function getCanonicalDocumentState(
  accountId: number,
  fileId: number,
  opts: { factsLimit?: number } = {},
): Promise<CanonicalDocumentState | null> {
  const [r] = (await pgClient.unsafe(
    `SELECT f.id, coalesce(f.retained_title, f.original_filename, 'Document') AS title,
            to_char(f.document_date, 'YYYY-MM-DD') AS "documentDate", f.document_type_code AS "documentTypeCode",
            f.document_type AS "legacyType", f.rubric_code AS "rubricCode", f.amount_cents AS "amountCents",
            f.supplier, f.analysis_state AS "analysisState", f.asset_id AS "assetId", f.linked_asset_id AS "linkedAssetId"
       FROM asset_files f
      WHERE f.id = $1 AND f.account_id = $2 AND f.deleted_at IS NULL`,
    [fileId, accountId] as never[],
  )) as unknown as Row[];
  if (!r) return null;
  const { documentFactsCanonicalReady } = await import('@/services/ai/evidence/canonical-columns');
  const canon = await documentFactsCanonicalReady().catch(() => false);
  const facts = (await pgClient.unsafe(
    `SELECT id::float8 AS id, fact_key AS key, ${canon ? 'canonical_key' : 'NULL::text'} AS "canonicalKey", label,
            coalesce(value_text, value_number::text) AS value, value_unit AS unit, confidence, excerpt
       FROM document_facts
      WHERE account_id = $1 AND file_id = $2 AND status = 'active'
      ORDER BY id LIMIT $3`,
    [accountId, fileId, Math.min(Math.max(opts.factsLimit ?? 40, 0), 200)] as never[],
  ).catch(() => [])) as unknown as CanonicalDocumentFact[];
  const assets = (await documentAssetsOf(accountId, [fileId])).get(fileId) ?? [];
  return {
    fileId: Number(r.id),
    title: r.title,
    documentDate: r.documentDate,
    documentTypeCode: r.documentTypeCode,
    documentTypeLabel: r.documentTypeCode ? getDocumentType(r.documentTypeCode)?.label ?? null : null,
    catalogCode: catalogCodeOf(r.documentTypeCode, r.legacyType),
    rubricCode: r.rubricCode,
    rubricLabel: r.rubricCode ? getRubric(r.rubricCode)?.label ?? null : null,
    amountCents: r.amountCents === null ? null : Number(r.amountCents),
    supplier: r.supplier,
    analysisStatus: documentAnalysisStatus(r.analysisState),
    assets,
    facts: facts.map((f) => ({ ...f, id: Number(f.id) })),
  };
}
