/**
 * Date tranchée par T4 → preuve RÉVISÉE du champ (décision PO D-M, lot 20).
 *
 * Quand la branche TEMPORAL_AMBIGUITY de T4 (R5, lot 18) retient l'une des
 * lectures possibles d'une date (jj/mm ↔ mm/jj), la date retenue corrige aussi
 * la FICHE — jamais directement :
 *   1. elle devient une NOUVELLE preuve du champ d'origine (même document,
 *      même cible, même type documentaire, même autorité), règle de
 *      projection `T4_TEMPORAL_RESOLUTION` ;
 *   2. la preuve d'origine passe SUPERSEDED (cycle de vie 0219), reliée à la
 *      révisée (`superseded_by_evidence_id`) ;
 *   3. la réconciliation T3 du bien (ou de l'équipement / de la pièce) est
 *      mise en file. T3 applique par les primitives canoniques
 *      (`writeCanonicalAssetField` / `writeCanonicalEntityFields`, origine
 *      RECONCILIATION) : la valeur automatique remplacée est corrigée
 *      (`isT4DateRevision`) ; une valeur USER/ADMIN n'est JAMAIS remplacée
 *      (carte de conflit à la place). La source n'est jamais USER.
 *
 * Toujours actif depuis le lot 16b-3 (commutateur `CANONICAL_WRITE_MODE`
 * supprimé ; R5 et T4 le sont depuis le lot 16b-2) : preuve révisée, preuve
 * d'origine remplacée, T3 en file. Ne lève jamais : l'agenda ne doit pas échouer pour cela.
 */
import { pgClient } from '@/db';
import { fieldEvidenceCanonicalReady } from './canonical-columns';
import { recordEvidence } from './field-evidence.service';
import type { EvidenceConfidence, EvidenceTargetType, FieldEvidenceInput } from './evidence.types';

import { T4_REVISION_RULE } from '../reconciliation/negative-reconciliation';

/** Règle de projection portée par la preuve révisée (lue par T3 : `isT4DateRevision`). */
export { T4_REVISION_RULE };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ReviseDateInput {
  accountId: number;
  userId?: number | null;
  /** Document source du candidat agenda. */
  sourceFileId: number;
  /** Champ d'origine du candidat agenda (clé canonique). */
  fieldKey: string;
  /** Date lue par l'extraction (AAAA-MM-JJ). */
  extractedDate: string;
  /** Date retenue par T4 (AAAA-MM-JJ). */
  chosenDate: string;
  /** Preuve source du candidat, si connue (`sources[].evidenceId`). */
  evidenceId?: number | null;
}

export interface ReviseDateResult {
  /** Preuve d'origine trouvée (ACTIVE), sinon null. */
  originalId: number | null;
  /** Preuve révisée écrite, sinon null. */
  revisedId: number | null;
  enqueued: boolean;
}

/** Preuve d'origine, telle que relue en base. */
export interface OriginalEvidenceRow {
  id: number;
  assetId: number;
  fieldKey: string;
  value: unknown;
  sourceType: string;
  sourceId: number;
  sourceVersion: number | null;
  location: Record<string, unknown> | null;
  excerpt: string | null;
  evidenceOrigin: string | null;
  documentType: string | null;
  documentDate: string | Date | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  confidence: string;
  authorityScore: number;
  operationTraceId: string | null;
  canonicalKey: string | null;
  canonicalUnit: string | null;
  targetType: string | null;
  targetEntityId: number | null;
  targetLabel: string | null;
  targetConfidence: string | null;
  eventType: string | null;
  eventNature: string | null;
  analysisRunId: number | null;
}

export interface ReviseDateDeps {
  schemaReady: () => Promise<boolean>;
  findOriginal: (p: ReviseDateInput) => Promise<OriginalEvidenceRow | null>;
  record: (input: FieldEvidenceInput) => Promise<number>;
  supersede: (p: { accountId: number; originalId: number; revisedId: number }) => Promise<void>;
  enqueueAsset: (p: { accountId: number; userId: number; assetIds: number[]; sourceFileId: number; reason: string }) => Promise<unknown>;
  enqueueEntity: (p: {
    accountId: number; userId: number; targets: Array<{ type: 'EQUIPMENT' | 'ROOM'; id: number }>; sourceFileId: number; reason: string;
  }) => Promise<unknown>;
}

const COLONNES = `id, asset_id AS "assetId", field_key AS "fieldKey", value_json AS value, source_type AS "sourceType",
    source_id AS "sourceId", source_version AS "sourceVersion", source_location AS location, evidence_excerpt AS excerpt,
    evidence_origin AS "evidenceOrigin", document_type AS "documentType", document_date AS "documentDate",
    provider, model, prompt_version AS "promptVersion", confidence, authority_score AS "authorityScore",
    operation_trace_id AS "operationTraceId", canonical_key AS "canonicalKey", canonical_unit AS "canonicalUnit",
    target_type AS "targetType", target_entity_id AS "targetEntityId", target_entity_label AS "targetLabel",
    target_confidence AS "targetConfidence", semantic_event_type AS "eventType", semantic_event_nature AS "eventNature",
    analysis_run_id AS "analysisRunId"`;
const ACTIVE = `status = 'active' AND (lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE')`;

/** Valeur d'une preuve ramenée à une date ISO (AAAA-MM-JJ), sinon null. */
export function evidenceDateValue(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const d = v.trim().slice(0, 10);
  return ISO_DATE.test(d) ? d : null;
}

/**
 * Preuve ACTIVE d'origine : par identifiant (preuve du candidat), sinon par
 * document, champ et valeur lue — toujours bornée au compte, et dont la
 * valeur est bien la date extraite (jamais une autre preuve du champ).
 */
async function findOriginalDefault(p: ReviseDateInput): Promise<OriginalEvidenceRow | null> {
  if (p.evidenceId) {
    const [r] = (await pgClient.unsafe(
      `SELECT ${COLONNES} FROM field_evidence WHERE id = $1 AND account_id = $2 AND ${ACTIVE}`,
      [p.evidenceId, p.accountId] as never[],
    )) as unknown as OriginalEvidenceRow[];
    if (r && evidenceDateValue(r.value) === p.extractedDate) return r;
  }
  const [r] = (await pgClient.unsafe(
    `SELECT ${COLONNES} FROM field_evidence
      WHERE account_id = $1 AND source_type IN ('document', 'web_link') AND source_id = $2 AND ${ACTIVE}
        AND (field_key = $3 OR canonical_key = $3) AND left(value_json #>> '{}', 10) = $4
      ORDER BY id DESC LIMIT 1`,
    [p.accountId, p.sourceFileId, p.fieldKey, p.extractedDate] as never[],
  )) as unknown as OriginalEvidenceRow[];
  return r ?? null;
}

const defaultDeps: ReviseDateDeps = {
  schemaReady: () => fieldEvidenceCanonicalReady(),
  findOriginal: findOriginalDefault,
  record: (input) => recordEvidence(input),
  supersede: async ({ accountId, originalId, revisedId }) => {
    await pgClient.unsafe(
      `UPDATE field_evidence SET lifecycle_status = 'SUPERSEDED', superseded_at = now(), superseded_by_evidence_id = $3
        WHERE account_id = $1 AND id = $2 AND (lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE')`,
      [accountId, originalId, revisedId] as never[],
    );
  },
  enqueueAsset: async (p) => (await import('../reconciliation/t3-queue')).enqueueT3ForAssets(p),
  enqueueEntity: async (p) => (await import('../reconciliation/t3-queue')).enqueueT3ForEntities({ ...p, triggeredBy: 'document_analyzed' }),
};

/** Preuve révisée : copie de l'originale, date retenue, règle tracée (pure). */
export function revisedEvidenceInput(o: OriginalEvidenceRow, p: ReviseDateInput): FieldEvidenceInput {
  const type = o.targetType as EvidenceTargetType | null;
  return {
    accountId: p.accountId,
    assetId: Number(o.assetId),
    fieldKey: String(o.fieldKey),
    value: p.chosenDate,
    normalizedValue: p.chosenDate,
    sourceType: o.sourceType as FieldEvidenceInput['sourceType'],
    sourceId: Number(o.sourceId),
    ...(o.sourceVersion != null ? { sourceVersion: Number(o.sourceVersion) } : {}),
    location: (o.location ?? {}) as FieldEvidenceInput['location'],
    // Même extrait : c'est la lecture de CE texte que T4 a tranchée.
    excerpt: o.excerpt ?? null,
    evidenceOrigin: o.evidenceOrigin === 'VISUAL_ANALYSIS' ? 'VISUAL_ANALYSIS' : 'TEXT_EXTRACTION',
    ...(o.documentType ? { documentType: o.documentType } : {}),
    documentDate: o.documentDate ? new Date(o.documentDate) : null,
    ...(o.provider ? { provider: o.provider } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.promptVersion ? { promptVersion: o.promptVersion } : {}),
    confidence: o.confidence as EvidenceConfidence,
    authorityScore: Number(o.authorityScore),
    ...(o.operationTraceId ? { operationTraceId: o.operationTraceId } : {}),
    canonicalKey: o.canonicalKey ?? String(o.fieldKey),
    canonicalUnit: o.canonicalUnit ?? null,
    // Valeur lue d'origine conservée (audit : « 05/12/2027 » lu, 2027-12-05 retenu).
    rawValue: typeof o.value === 'string' ? o.value : o.value == null ? null : JSON.stringify(o.value),
    target: type
      ? {
        type, entityId: o.targetEntityId == null ? null : Number(o.targetEntityId),
        label: o.targetLabel ?? null, confidence: (o.targetConfidence as EvidenceConfidence | null) ?? 'certain',
      }
      : null,
    semanticEvent: o.eventType ? { type: String(o.eventType), nature: String(o.eventNature ?? '') } : null,
    projectionOrigin: 'DETERMINISTIC_RULE',
    projectionRule: T4_REVISION_RULE,
    analysisRunId: o.analysisRunId ?? null,
  };
}

export async function reviseDateEvidenceFromT4(p: ReviseDateInput, deps: ReviseDateDeps = defaultDeps): Promise<ReviseDateResult> {
  const out: ReviseDateResult = { originalId: null, revisedId: null, enqueued: false };
  if (!ISO_DATE.test(p.chosenDate) || !ISO_DATE.test(p.extractedDate) || p.chosenDate === p.extractedDate) return out;
  try {
    if (!(await deps.schemaReady())) return out;
    const o = await deps.findOriginal(p);
    if (!o) return out;
    out.originalId = Number(o.id);
    const journal = {
      event: 't4.revised_date_evidence', accountId: p.accountId, sourceFileId: p.sourceFileId,
      // Jamais de valeur dans le journal : clé et identifiants.
      fieldKey: p.fieldKey, originalId: out.originalId,
    };
    out.revisedId = await deps.record(revisedEvidenceInput(o, p));
    await deps.supersede({ accountId: p.accountId, originalId: out.originalId, revisedId: out.revisedId });

    const userId = p.userId ?? 0;
    const type = o.targetType;
    if ((type === 'EQUIPMENT' || type === 'ROOM') && o.targetEntityId != null) {
      await deps.enqueueEntity({
        accountId: p.accountId, userId, targets: [{ type, id: Number(o.targetEntityId) }],
        sourceFileId: p.sourceFileId, reason: T4_REVISION_RULE,
      });
    } else if (userId > 0) {
      await deps.enqueueAsset({
        accountId: p.accountId, userId, assetIds: [Number(o.assetId)], sourceFileId: p.sourceFileId, reason: T4_REVISION_RULE,
      });
    } else {
      // Le travail T3 d'un bien exige un utilisateur : la preuve révisée sera
      // appliquée à la prochaine réconciliation du bien.
      console.info(JSON.stringify({ ...journal, revisedId: out.revisedId, dryRun: false, enqueued: false }));
      return out;
    }
    out.enqueued = true;
    console.info(JSON.stringify({ ...journal, revisedId: out.revisedId, dryRun: false }));
    return out;
  } catch (e) {
    console.error('[t4] preuve révisée non écrite (non bloquant) :', (e as Error).message);
    return out;
  }
}
