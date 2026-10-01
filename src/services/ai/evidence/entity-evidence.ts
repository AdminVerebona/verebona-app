/**
 * Preuves CIBLÉES sur un équipement ou une pièce — lectures de la
 * réconciliation T3 ciblée (CDC 15 T1-04, T3-03, T3-04 ; lot 18, volet R3).
 *
 * `field-evidence.service.ts` reste le point d'écriture et de lecture « champ
 * du bien » ; `getActiveEvidence(…, { target })` y sert la lecture des
 * preuves d'un champ ciblé. Ici : les lectures propres aux cibles (champs
 * ayant une preuve active, valeurs retirées, cibles d'un lot de preuves ou
 * d'une source). Mêmes filtres : `status = 'active'` (décision) et cycle de
 * vie ACTIVE (0219). Toujours bornées au compte. Vides sans 0219.
 *
 * ÉQUIPEMENT DÉPLACÉ (relecture lot 18) : une preuve ciblée garde l'`asset_id`
 * du bien porteur AU MOMENT de l'analyse. Pour une cible entité, les preuves
 * se lisent donc par `target_type` / `target_entity_id` et le COMPTE, jamais
 * par `asset_id` ; l'appartenance de l'entité au compte est contrôlée par
 * l'appelant via son bien parent ACTUEL (`canonical/entity-state`).
 */
import { pgClient } from '@/db';
import { fieldEvidenceCanonicalReady } from './canonical-columns';
import type { FieldEvidence } from './evidence.types';

export type EntityEvidenceType = 'EQUIPMENT' | 'ROOM';

export interface EntityEvidenceTarget {
  type: EntityEvidenceType;
  id: number;
  /** Bien porteur des preuves. */
  assetId: number;
}

const ACTIVE = `(lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE')`;

/** Champs ayant au moins une preuve ACTIVE pour cette cible. */
export async function listEntityEvidenceKeys(
  accountId: number, target: { type: EntityEvidenceType; id: number },
): Promise<string[]> {
  if (!(await fieldEvidenceCanonicalReady())) return [];
  const rows = (await pgClient.unsafe(
    `SELECT DISTINCT field_key AS k FROM field_evidence
      WHERE account_id = $1 AND target_type = $2 AND target_entity_id = $3 AND status = 'active' AND ${ACTIVE}`,
    [accountId, target.type, target.id] as never[],
  )) as unknown as Array<{ k: string }>;
  return rows.map((r) => r.k);
}

/** Valeurs des preuves de la cible sorties de l'état ACTIVE (phase négative T3-04). */
export async function listRetiredEntityEvidenceValues(
  accountId: number, target: { type: EntityEvidenceType; id: number },
): Promise<Array<{ fieldKey: string; value: unknown }>> {
  if (!(await fieldEvidenceCanonicalReady())) return [];
  return (await pgClient.unsafe(
    `SELECT DISTINCT field_key AS "fieldKey", value_json AS value FROM field_evidence
      WHERE account_id = $1 AND target_type = $2 AND target_entity_id = $3
        AND lifecycle_status IN ('WITHDRAWN', 'SUPERSEDED')`,
    [accountId, target.type, target.id] as never[],
  )) as unknown as Array<{ fieldKey: string; value: unknown }>;
}

function cibles(rows: Array<{ type: string; id: number; assetId: number }>): EntityEvidenceTarget[] {
  return rows
    .filter((r) => (r.type === 'EQUIPMENT' || r.type === 'ROOM') && Number(r.id) > 0)
    .map((r) => ({ type: r.type as EntityEvidenceType, id: Number(r.id), assetId: Number(r.assetId) }));
}

/** Cibles équipement / pièce d'un lot de preuves (retrait du cycle de vie). */
export async function listEvidenceEntityTargets(accountId: number, evidenceIds: number[]): Promise<EntityEvidenceTarget[]> {
  const ids = evidenceIds.filter((x) => Number.isInteger(x) && x > 0);
  if (ids.length === 0 || !(await fieldEvidenceCanonicalReady())) return [];
  return cibles((await pgClient.unsafe(
    `SELECT DISTINCT target_type AS type, target_entity_id AS id, asset_id AS "assetId" FROM field_evidence
      WHERE account_id = $1 AND id = ANY(string_to_array($2, ',')::int[])
        AND target_type IN ('EQUIPMENT', 'ROOM') AND target_entity_id IS NOT NULL`,
    [accountId, ids.join(',')] as never[],
  )) as unknown as Array<{ type: string; id: number; assetId: number }>);
}

/**
 * Cibles équipement / pièce des preuves ACTIVE d'une source — lues AVANT le
 * remplacement d'une réanalyse : ces entités perdent peut-être leur preuve.
 */
export async function listSourceEntityTargets(
  accountId: number, sourceType: string, sourceId: number,
): Promise<EntityEvidenceTarget[]> {
  if (!(await fieldEvidenceCanonicalReady())) return [];
  return cibles((await pgClient.unsafe(
    `SELECT DISTINCT target_type AS type, target_entity_id AS id, asset_id AS "assetId" FROM field_evidence
      WHERE account_id = $1 AND source_type = $2 AND source_id = $3 AND ${ACTIVE}
        AND target_type IN ('EQUIPMENT', 'ROOM') AND target_entity_id IS NOT NULL`,
    [accountId, sourceType, sourceId] as never[],
  )) as unknown as Array<{ type: string; id: number; assetId: number }>);
}

// ── Preuves actives d'une cible, sans filtre sur le bien porteur ───────────

const colonnes = (p = '') => `${p}id, ${p}account_id AS "accountId", ${p}asset_id AS "assetId", ${p}field_key AS "fieldKey", ${p}value_json AS "valueJson", ${p}normalized_value AS "normalizedValue", ${p}source_type AS "sourceType", ${p}source_id AS "sourceId", ${p}source_version AS "sourceVersion", ${p}source_location AS "sourceLocation", ${p}evidence_excerpt AS "evidenceExcerpt", ${p}evidence_origin AS "evidenceOrigin", ${p}visual_evidence AS "visualEvidence", ${p}document_type AS "documentType", ${p}document_date AS "documentDate", ${p}provider, ${p}model, ${p}prompt_version AS "promptVersion", ${p}confidence, ${p}authority_score AS "authorityScore", ${p}operation_trace_id AS "operationTraceId", ${p}status, ${p}extracted_at AS "extractedAt", ${p}lifecycle_status AS "lifecycleStatus", ${p}target_type AS "targetType", ${p}target_entity_id AS "targetEntityId"`;

type Ligne = Record<string, unknown>;

function versPreuve(r: Ligne): FieldEvidence {
  return {
    id: Number(r.id),
    accountId: Number(r.accountId),
    assetId: Number(r.assetId),
    fieldKey: String(r.fieldKey),
    value: r.valueJson,
    normalizedValue: (r.normalizedValue as string | null) ?? undefined,
    sourceType: r.sourceType as FieldEvidence['sourceType'],
    sourceId: Number(r.sourceId),
    sourceVersion: (r.sourceVersion as number | null) ?? undefined,
    location: (r.sourceLocation ?? {}) as FieldEvidence['location'],
    excerpt: (r.evidenceExcerpt as string | null) ?? null,
    evidenceOrigin: (r.evidenceOrigin ?? 'TEXT_EXTRACTION') as FieldEvidence['evidenceOrigin'],
    visualEvidence: (r.visualEvidence ?? null) as FieldEvidence['visualEvidence'],
    documentType: (r.documentType as string | null) ?? undefined,
    documentDate: r.documentDate ? new Date(r.documentDate as string) : null,
    provider: (r.provider as string | null) ?? undefined,
    model: (r.model as string | null) ?? undefined,
    promptVersion: (r.promptVersion as string | null) ?? undefined,
    confidence: r.confidence as FieldEvidence['confidence'],
    authorityScore: Number(r.authorityScore),
    operationTraceId: (r.operationTraceId as string | null) ?? undefined,
    status: r.status as FieldEvidence['status'],
    extractedAt: new Date(r.extractedAt as string),
    lifecycleStatus: (r.lifecycleStatus ?? 'ACTIVE') as FieldEvidence['lifecycleStatus'],
  } as FieldEvidence;
}

/**
 * Preuves ACTIVE d'un champ d'une cible, de la plus autoritaire à la moins
 * autoritaire (même ordre que `getActiveEvidence`) — quel que soit le bien
 * porteur enregistré sur la preuve.
 */
export async function getActiveEntityEvidence(
  accountId: number, target: { type: EntityEvidenceType; id: number }, fieldKey: string,
): Promise<FieldEvidence[]> {
  if (!(await fieldEvidenceCanonicalReady())) return [];
  const rows = (await pgClient.unsafe(
    `SELECT ${colonnes()} FROM field_evidence
      WHERE account_id = $1 AND target_type = $2 AND target_entity_id = $3 AND field_key = $4
        AND status = 'active' AND ${ACTIVE}
      ORDER BY authority_score DESC, document_date DESC NULLS FIRST, id`,
    [accountId, target.type, target.id, fieldKey] as never[],
  )) as unknown as Ligne[];
  return rows.map(versPreuve);
}

export interface EntityEvidenceWithTitle {
  target: { type: EntityEvidenceType; id: number };
  evidence: FieldEvidence;
  /** Titre du document source (non supprimé, du compte), sinon null. */
  documentTitle: string | null;
}

/**
 * Preuves ACTIVE de PLUSIEURS cibles en UNE requête (lecture assistant,
 * exports — relecture lot 18 : pas de N+1), avec le titre du document.
 * Même ordre que `getActiveEntityEvidence` au sein d'un champ.
 */
export async function listActiveEvidenceForTargets(
  accountId: number, targets: ReadonlyArray<{ type: EntityEvidenceType; id: number }>,
): Promise<EntityEvidenceWithTitle[]> {
  const eq = targets.filter((t) => t.type === 'EQUIPMENT').map((t) => t.id);
  const ro = targets.filter((t) => t.type === 'ROOM').map((t) => t.id);
  if ((eq.length === 0 && ro.length === 0) || !(await fieldEvidenceCanonicalReady())) return [];
  const rows = (await pgClient.unsafe(
    `SELECT ${colonnes('e.')},
            (SELECT coalesce(f.retained_title, f.original_filename) FROM asset_files f
              WHERE e.source_type = 'document' AND f.id = e.source_id AND f.account_id = e.account_id AND f.deleted_at IS NULL) AS "documentTitle"
       FROM field_evidence e
      WHERE e.account_id = $1 AND e.status = 'active' AND (e.lifecycle_status IS NULL OR e.lifecycle_status = 'ACTIVE')
        AND ((e.target_type = 'EQUIPMENT' AND e.target_entity_id = ANY(string_to_array($2, ',')::int[]))
          OR (e.target_type = 'ROOM' AND e.target_entity_id = ANY(string_to_array($3, ',')::int[])))
      ORDER BY e.authority_score DESC, e.document_date DESC NULLS FIRST, e.id`,
    [accountId, eq.join(','), ro.join(',')] as never[],
  )) as unknown as Ligne[];
  return rows.map((r) => ({
    target: { type: r.targetType as EntityEvidenceType, id: Number(r.targetEntityId) },
    evidence: versPreuve(r),
    documentTitle: (r.documentTitle as string | null) ?? null,
  }));
}
