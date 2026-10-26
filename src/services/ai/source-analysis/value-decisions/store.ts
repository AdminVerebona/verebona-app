/**
 * Lot 91D — persistance des décisions T1 sur les valeurs significatives
 * (`document_value_decisions`, migration 0798).
 *
 *   · ANALYSE     : dans la transaction de `persistDocumentKnowledgeDetailed`,
 *                   les décisions courantes du document passent en
 *                   SUPERSEDED (nouvelle extraction), puis les nouvelles sont
 *                   écrites avec les faits persistés rattachés (ancres) ;
 *   · RÉEXAMEN    : seules les décisions des valeurs réexaminées sont
 *                   remplacées (SUPERSEDED, motif REVIEW) ;
 *   · jamais de suppression, jamais de doublon actif (index unique partiel,
 *     `ON CONFLICT DO NOTHING`).
 * Table absente (migration non appliquée) : rien n'est écrit, rien n'échoue.
 */
import type { PreparedValueDecision } from './validate';
import { decisionFingerprint, valueKey } from './validate';
import { T1_VALUE_DECISIONS_CONTRACT } from './contract';

type Tx = { unsafe: (q: string, p?: never[]) => Promise<unknown> };
const json = (v: unknown) => JSON.stringify(v ?? null);

let pret: { ok: boolean; at: number } | null = null;

/** Table 0798 présente ? (cache 5 min si absente ; ne lève jamais). */
export async function valueDecisionsTableReady(sql?: Tx): Promise<boolean> {
  if (pret && (pret.ok || Date.now() - pret.at < 300_000)) return pret.ok;
  let ok = false;
  try {
    const client = sql ?? (await import('@/db')).pgClient as unknown as Tx;
    const r = (await client.unsafe(`SELECT to_regclass('document_value_decisions') IS NOT NULL AS ok`)) as Array<{ ok: boolean }>;
    ok = r[0]?.ok === true;
  } catch {
    ok = false;
  }
  pret = { ok, at: Date.now() };
  return ok;
}

/** Réservé aux tests. */
export function __resetValueDecisionsTableProbeForTests(): void { pret = null; }

/** Nouvelle analyse : les décisions courantes du document cessent d'être courantes (jamais supprimées). */
export async function supersedeFileDecisions(tx: Tx, fileId: number, reason: 'REANALYSIS'): Promise<number> {
  const r = (await tx.unsafe(
    `UPDATE document_value_decisions SET status = 'SUPERSEDED', superseded_at = now(), superseded_reason = $2, updated_at = now()
      WHERE file_id = $1 AND status = 'ACTIVE' RETURNING 1`,
    [fileId, reason] as never[],
  )) as unknown[];
  return r.length;
}

export interface DecisionWriteContext {
  accountId: number;
  fileId: number;
  extractionId: number | null;
  analysisRunId: number | null;
  promptVersion: string | null;
  aiTraceId?: string | null;
  /** Empreinte de fait → identifiants des faits ACTIFS persistés. */
  factIds: ReadonlyMap<string, readonly number[]>;
}

/**
 * Écrit des décisions validées. Les décisions ACTIVES des mêmes valeurs
 * (unité, nature, forme normalisée) sont d'abord supersédées (motif REVIEW
 * pour un réexamen, REPLACED sinon) ; une décision identique déjà active
 * n'est pas réécrite. Rend le nombre de lignes écrites (doublons exclus).
 */
export async function insertValueDecisions(tx: Tx, c: DecisionWriteContext, decisions: readonly PreparedValueDecision[], opts: { replaceKeys?: boolean } = {}): Promise<number> {
  if (decisions.length === 0) return 0;
  const lignesFp = decisions.map((d) => decisionFingerprint(c.fileId, d));
  // Une valeur, une décision ACTIVE : celles des mêmes valeurs (unité, nature, forme normalisée) sont supersédées
  // (historique), sauf la décision identique déjà active (rejeu idempotent, aucun doublon).
  const cles = [...new Set(decisions.filter((d) => d.sourceUnitId && d.kind && d.normalizedValue).map((d) => valueKey(d.sourceUnitId!, d.kind!, d.normalizedValue!)))];
  if (cles.length) {
    await tx.unsafe(
      `UPDATE document_value_decisions SET status = 'SUPERSEDED', superseded_at = now(), superseded_reason = $3, updated_at = now()
        WHERE file_id = $1 AND status = 'ACTIVE' AND (source_unit_id || '|' || value_kind || '|' || normalized_value) = ANY($2::text[])
          AND decision_fp <> ALL($4::text[])`,
      [c.fileId, cles, opts.replaceKeys ? 'REVIEW' : 'REPLACED', lignesFp] as never[],
    );
  }
  const lignes = decisions.map((d, i) => ({
    origin: d.origin === 'REVIEW' ? 'REVIEW' : 'ANALYSIS', unit: d.sourceUnitId, fp: d.unitFingerprint, kind: d.kind, raw: d.rawValue.slice(0, 200),
    norm: d.normalizedValue, decision: d.decision, reason: d.reason.slice(0, 400), conf: d.confidence, evidence: d.evidence ?? {},
    factIds: [...new Set(d.relatedFactRefs.flatMap((r) => c.factIds.get(r) ?? []))],
    refs: d.relatedFactRefs, keys: d.relatedCandidateKeys, validity: d.validity, invalid: d.invalidReason, dfp: lignesFp[i],
  }));
  const r = (await tx.unsafe(
    `INSERT INTO document_value_decisions (
       account_id, file_id, extraction_id, analysis_run_id, origin, contract_version, prompt_version, source_unit_id, unit_fingerprint,
       value_kind, raw_value, normalized_value, decision, reason, confidence, evidence, related_fact_ids, related_fact_refs,
       related_candidate_keys, validity, invalid_reason, decision_fp, ai_trace_id
     )
     SELECT $1, $2, $3, $4, d.origin, $5, $6, d.unit, d.fp, d.kind, d.raw, d.norm, d.decision, d.reason, d.conf, coalesce(d.evidence, '{}'::jsonb),
            ARRAY(SELECT jsonb_array_elements_text(coalesce(d."factIds", '[]'::jsonb))::bigint),
            ARRAY(SELECT jsonb_array_elements_text(coalesce(d.refs, '[]'::jsonb))),
            ARRAY(SELECT jsonb_array_elements_text(coalesce(d.keys, '[]'::jsonb))),
            d.validity, d.invalid, d.dfp, $8
       FROM jsonb_to_recordset($7::jsonb) AS d(
         origin text, unit text, fp text, kind text, raw text, norm text, decision text, reason text, conf text, evidence jsonb,
         "factIds" jsonb, refs jsonb, keys jsonb, validity text, invalid text, dfp text
       )
     ON CONFLICT (file_id, decision_fp) WHERE status = 'ACTIVE' DO NOTHING
     RETURNING 1`,
    [c.accountId, c.fileId, c.extractionId, c.analysisRunId, T1_VALUE_DECISIONS_CONTRACT, c.promptVersion ?? '', json(lignes), c.aiTraceId ?? null] as never[],
  )) as unknown[];
  return r.length;
}

/** Décision active telle que la lit le contrôle (aucun contenu au-delà de la valeur et du motif). */
export interface ActiveValueDecision {
  id: number;
  fileId: number;
  origin: string;
  sourceUnitId: string | null;
  unitFingerprint: string | null;
  kind: string | null;
  normalizedValue: string | null;
  decision: string | null;
  reason: string;
  confidence: string | null;
  relatedFactIds: number[];
  relatedCandidateKeys: string[];
  validity: 'VALID' | 'INVALID';
  invalidReason: string | null;
}

/** Décisions ACTIVES de documents (lecture seule). Table absente : vide. */
export async function loadActiveValueDecisions(sql: Tx, accountId: number, fileIds: readonly number[]): Promise<ActiveValueDecision[]> {
  if (fileIds.length === 0 || !(await valueDecisionsTableReady(sql))) return [];
  return ((await sql.unsafe(
    `SELECT id::float8 AS id, file_id AS "fileId", origin, source_unit_id AS "sourceUnitId", unit_fingerprint AS "unitFingerprint",
            value_kind AS kind, normalized_value AS "normalizedValue", decision, reason, confidence,
            coalesce(related_fact_ids, '{}')::float8[] AS "relatedFactIds", related_candidate_keys AS "relatedCandidateKeys",
            validity, invalid_reason AS "invalidReason"
       FROM document_value_decisions
      WHERE account_id = $1 AND file_id = ANY($2::int[]) AND status = 'ACTIVE'
      ORDER BY id`,
    [accountId, `{${fileIds.filter(Number.isInteger).join(',')}}`] as never[],
  )) as Array<ActiveValueDecision & { relatedFactIds: number[] }>).map((d) => ({ ...d, id: Number(d.id), relatedFactIds: (d.relatedFactIds ?? []).map(Number) }));
}
