/**
 * Lot 85F — COLLECTE de la connaissance T1 PERSISTÉE d'un document (ticket
 * §4) : vue BORNÉE et TRAÇABLE, lecture seule, jamais le fichier, jamais une
 * relance T1.
 *
 * Couches (selon disponibilité) :
 *   · `document_facts` actifs (clé lue, clé du registre, libellé, valeur,
 *     extrait, confiance, unités sources) ;
 *   · `document_unresolved_facts` (non résolus / retenus) ;
 *   · `document_source_units` informatives (couvertes, non résolues,
 *     incertaines) de TOUTES natures : bloc de texte, libellé : valeur, champ
 *     de formulaire, tableau, ligne de tableau, observation visuelle… — les
 *     tableaux et champs de formulaire persistés sont des unités ;
 *   · documents de la MÊME RÉALITÉ MÉTIER, dans le compte : documents actifs
 *     d'une même Opération (`business_operation_documents`, Opération ni
 *     invalidée ni fusionnée) et documents portant EXACTEMENT la même
 *     référence de contrat (`gatherRelatedDocumentValues`, lot 61). Jamais un
 *     rapprochement par ressemblance, par bien ou par fournisseur.
 *
 * Aucun contenu n'est jugé ni filtré d'après ses mots : la pertinence est
 * l'affaire du traitement sémantique. Une lecture en échec LÈVE (jamais
 * « information absente »).
 */
import { pgClient } from '@/db';
import type { KnowledgeConfidence, KnowledgeDocument, KnowledgeElement } from './contract';

type Row = Record<string, unknown>;
const q = async <T = Row>(sql: string, params: unknown[]): Promise<T[]> =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as T[];

/** Éléments lus au plus par document (avant pagination). */
const MAX_PAR_DOCUMENT = 2_000;

export type CollectedElement = KnowledgeElement & { structured?: boolean };

export interface CollectedKnowledge {
  /** Le document a une extraction T1 (sinon : NO_T1_KNOWLEDGE). */
  hasExtraction: boolean;
  documents: KnowledgeDocument[];
  elements: CollectedElement[];
  /** Couches absentes (migration non appliquée) : l'information peut exister ailleurs. */
  missing: string[];
}

const texte = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length ? s : null;
};
const confianceFait = (c: unknown): KnowledgeConfidence => (c === 'certain' || c === 'probable' ? c : 'conflictual');
const confianceUnite = (cov: unknown): KnowledgeConfidence => (cov === 'COVERED' ? 'certain' : cov === 'UNRESOLVED' ? 'probable' : 'conflictual');

/** Documents de la même réalité métier (Opération commune, référence de contrat exacte), dans le compte, bornés. */
export async function linkedDocuments(accountId: number, fileId: number, fieldKey: string, max: number): Promise<{ docs: Array<{ fileId: number; relation: 'SAME_OPERATION' | 'SAME_CONTRACT_REFERENCE' }>; missing: string[] }> {
  const out = new Map<number, 'SAME_OPERATION' | 'SAME_CONTRACT_REFERENCE'>();
  const missing: string[] = [];
  if (max <= 0) return { docs: [], missing };
  const [{ ok }] = await q<{ ok: boolean }>(`SELECT to_regclass('business_operation_documents') IS NOT NULL AS ok`, []);
  if (ok) {
    const rows = await q<{ file_id: number }>(
      `SELECT DISTINCT d2.file_id
         FROM business_operation_documents d1
         JOIN business_operations o ON o.id = d1.operation_id AND o.account_id = d1.account_id
                                    AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
         JOIN business_operation_documents d2 ON d2.operation_id = d1.operation_id AND d2.account_id = d1.account_id
                                             AND d2.file_id <> d1.file_id AND d2.active
         JOIN asset_files f ON f.id = d2.file_id AND f.account_id = d2.account_id AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
        WHERE d1.account_id = $1 AND d1.file_id = $2 AND d1.active
        ORDER BY d2.file_id LIMIT $3`,
      [accountId, fileId, max],
    );
    for (const r of rows) out.set(Number(r.file_id), 'SAME_OPERATION');
  } else missing.push('BUSINESS_OPERATION_DOCUMENTS');
  if (out.size < max) {
    const { gatherRelatedDocumentValues } = await import('@/services/to-process/document-field-evidence');
    const lies = await gatherRelatedDocumentValues(accountId, fileId, fieldKey);
    for (const id of lies.relatedFiles ?? []) if (!out.has(id) && out.size < max) out.set(id, 'SAME_CONTRACT_REFERENCE');
  }
  return { docs: [...out.entries()].map(([id, relation]) => ({ fileId: id, relation })), missing };
}

/** Connaissance T1 persistée des documents donnés (premier = cible). Lève sur une lecture en échec. */
export async function collectT1Knowledge(
  accountId: number, fileId: number, fieldKey: string, opts: { maxLinkedDocuments: number },
): Promise<CollectedKnowledge> {
  const missing: string[] = [];
  const [cible] = await q<Row>(
    `SELECT f.id, COALESCE(to_jsonb(f) ->> 'retained_title', e.title, f.original_filename) AS title, COALESCE(f.document_type_code, e.document_type_code) AS type,
            e.id AS extraction_id
       FROM asset_files f
       LEFT JOIN LATERAL (SELECT x.id, x.title, x.document_type_code FROM document_extractions x
                           WHERE x.file_id = f.id AND x.account_id = f.account_id ORDER BY x.id DESC LIMIT 1) e ON true
      WHERE f.id = $1 AND f.account_id = $2`,
    [fileId, accountId],
  );
  if (!cible || !cible.extraction_id) return { hasExtraction: false, documents: [], elements: [], missing: ['EXTRACTION'] };
  const lies = await linkedDocuments(accountId, fileId, fieldKey, opts.maxLinkedDocuments);
  missing.push(...lies.missing);
  const ids = [fileId, ...lies.docs.map((d) => d.fileId)];
  const meta = new Map((await q<Row>(
    `SELECT f.id, COALESCE(to_jsonb(f) ->> 'retained_title', e.title, f.original_filename) AS title, COALESCE(f.document_type_code, e.document_type_code) AS type
       FROM asset_files f
       LEFT JOIN LATERAL (SELECT x.title, x.document_type_code FROM document_extractions x
                           WHERE x.file_id = f.id AND x.account_id = f.account_id ORDER BY x.id DESC LIMIT 1) e ON true
      WHERE f.account_id = $1 AND f.id = ANY($2::int[])`,
    [accountId, ids],
  )).map((r) => [Number(r.id), r]));
  const documents: KnowledgeDocument[] = ids.map((id, i) => ({
    ref: `D${i}`, fileId: id, role: i === 0 ? 'TARGET' : 'LINKED', relation: i === 0 ? null : lies.docs[i - 1].relation,
    title: texte(meta.get(id)?.title)?.slice(0, 200) ?? null, documentType: texte(meta.get(id)?.type),
  }));
  const refDoc = new Map(documents.map((d) => [d.fileId, d.ref]));
  const elements: CollectedElement[] = [];

  const faits = await q<Row>(
    `SELECT id, file_id, fact_key, to_jsonb(f) ->> 'canonical_key' AS canonical, label, value_text, excerpt, confidence,
            to_jsonb(f) -> 'source_unit_ids' AS units
       FROM document_facts f WHERE f.account_id = $1 AND f.file_id = ANY($2::int[]) AND f.status = 'active'
      ORDER BY f.file_id, f.id LIMIT ${MAX_PAR_DOCUMENT * ids.length}`,
    [accountId, ids],
  );
  for (const r of faits) {
    const valeur = texte(r.value_text);
    const extrait = texte(r.excerpt);
    elements.push({
      ref: `F-${r.id}`, document: refDoc.get(Number(r.file_id)) ?? 'D?', fileId: Number(r.file_id), layer: 'FACT',
      kind: String(r.canonical ?? r.fact_key ?? 'fact'), label: texte(r.label) ?? texte(r.fact_key), value: valeur,
      text: extrait && extrait !== valeur ? extrait : null, confidence: confianceFait(r.confidence), page: null,
      sourceUnitIds: Array.isArray(r.units) ? (r.units as unknown[]).map(String) : [], structured: !!r.canonical,
    });
  }

  const { sourceLayerReady } = await import('@/services/ai/source-analysis/source-units/repository');
  if (!(await sourceLayerReady())) {
    missing.push('SOURCE_UNITS', 'UNRESOLVED_FACTS');
  } else {
    const { RELIABLE_UNRESOLVED_REASONS } = await import('@/services/ai/reconciliation/document-asset/source-unit-provider');
    const nr = await q<Row>(
      `SELECT id, file_id, raw_key, canonical_key, raw_value, reason, source_unit_ids FROM document_unresolved_facts
        WHERE account_id = $1 AND file_id = ANY($2::int[]) AND status IN ('UNRESOLVED', 'RETAINED')
        ORDER BY file_id, id LIMIT ${MAX_PAR_DOCUMENT * ids.length}`,
      [accountId, ids],
    );
    for (const r of nr) {
      elements.push({
        ref: `N-${r.id}`, document: refDoc.get(Number(r.file_id)) ?? 'D?', fileId: Number(r.file_id), layer: 'UNRESOLVED_FACT',
        kind: String(r.canonical_key ?? r.raw_key ?? 'unresolved'), label: texte(r.raw_key), value: texte(r.raw_value), text: null,
        confidence: RELIABLE_UNRESOLVED_REASONS.includes(String(r.reason)) ? 'probable' : 'conflictual', page: null,
        sourceUnitIds: Array.isArray(r.source_unit_ids) ? (r.source_unit_ids as unknown[]).map(String) : [],
      });
    }
    const unites = await q<Row>(
      `SELECT id, file_id, source_unit_id, kind, page, label, value_text, content_text, coverage_status
         FROM document_source_units
        WHERE account_id = $1 AND file_id = ANY($2::int[]) AND coverage_status IN ('COVERED', 'UNRESOLVED', 'UNCERTAIN') AND kind <> 'PAGE_GAP'
        ORDER BY file_id, ordinal LIMIT ${MAX_PAR_DOCUMENT * ids.length}`,
      [accountId, ids],
    );
    for (const r of unites) {
      elements.push({
        ref: `U-${r.id}`, document: refDoc.get(Number(r.file_id)) ?? 'D?', fileId: Number(r.file_id), layer: 'SOURCE_UNIT',
        kind: String(r.kind), label: texte(r.label), value: texte(r.value_text), text: texte(r.content_text),
        confidence: confianceUnite(r.coverage_status), page: r.page === null || r.page === undefined ? null : Number(r.page),
        covered: r.coverage_status === 'COVERED', sourceUnitId: texte(r.source_unit_id),
      });
    }
  }
  return { hasExtraction: true, documents, elements, missing };
}
