/**
 * COH-DOC-CLASSIFICATION — classement documentaire (Rubrique / Type) cohérent
 * avec la nomenclature COURANTE et avec la nature identifiée par T1
 * (lot 86E, ticket P1 « Équipements et mobilier » §5, §6 ; arbitrages C-Q1,
 * C-Q2, C-Q7, C-Q11).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN MOTEUR PARALLÈLE
 *
 * Le contrôle LIT (sans IA, mode à blanc compris) le classement enregistré
 * (`asset_files`) et la connaissance T1 déjà persistée (`document_extractions` :
 * nature identifiée `metadata.legacyDocumentType`, Rubrique / Type retenus par
 * l'analyse). Il ne classe rien lui-même ; chaque réparation passe par un
 * service existant :
 *
 *   · IDENTIFIED_TYPE_NOT_RECORDED  Rubrique connue, Type absent, alors que la
 *       nature identifiée (« BON_COMMANDE ») correspond à UN seul Type de la
 *       Rubrique (`v2TypeForRubric`, la correspondance unique du classement
 *       T1) → `applyV2Classification` (moteur de décision §11.3 : une valeur
 *       de l'utilisateur n'est jamais remplacée), sans nouvelle extraction ;
 *   · TYPE_NOT_IN_RUBRIC  Type enregistré absent de la Rubrique enregistrée,
 *       et un Type de même nature y existe → même service ; sans candidat :
 *       constat (FINDING) ;
 *   · CLASSIFIED_BEFORE_RUBRIC  classement AUTOMATIQUE produit sous une
 *       version du référentiel antérieure à une Rubrique (`since`) dont la
 *       nature du document relève : la décision « ce document relève de
 *       Équipements et mobilier » est SÉMANTIQUE — elle appartient à T1, qui
 *       reçoit la nomenclature courante en données. Réévaluation par la
 *       relance T1 existante (`requeueDocumentForReread`), dans le plafond
 *       unique des relances IA du contrôle (L83-Q3) ; au-delà : constat.
 *
 * Préservé : une Rubrique validée par l'utilisateur (aucun constat sur le
 * domaine), un Type validé par l'utilisateur (jamais remplacé). Un reclassement
 * n'écrit que la Rubrique / le Type et les cartes « À traiter » de classement :
 * aucune association à un événement d'Agenda ni à une Opération.
 * Journal : `coherence_repairs` (service, avant / après, motif).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ChainLink, CheckContext, CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows, type Row } from '../util';
import { OPEN_DOCUMENT_SQL } from './document-links';
import { t1RelaunchBudgetLeft } from './extract-chain';
import {
  getDocumentType, isTypeCompatibleWithRubric, rubricsIntroducedAfter,
} from '@/lib/referential/v2';
import { v2TypeForRubric } from '@/lib/referential/document-codes';

export const DOCUMENT_CLASSIFICATION_CHECK_ID = 'COH-DOC-CLASSIFICATION';

export type ClassificationAnomaly = 'IDENTIFIED_TYPE_NOT_RECORDED' | 'TYPE_NOT_IN_RUBRIC' | 'CLASSIFIED_BEFORE_RUBRIC';
export type ClassificationRepair = 'RECORD_TYPE' | 'REEVALUATE_T1';

/** Classement enregistré et connaissance T1 d'un document (lecture seule). */
export interface ClassificationState {
  fileId: number;
  rubricCode: string | null;
  documentTypeCode: string | null;
  rubricUserValidated: boolean;
  typeUserValidated: boolean;
  /** Version du référentiel du dernier examen du classement (§11.6). */
  referentialVersion: string | null;
  /** Nature identifiée par T1 (code du DOCUMENT_CATALOG), persistée avec la connaissance. */
  identifiedType: string | null;
  /** Type V2 retenu par l'analyse T1 (connaissance persistée). */
  t1DocumentTypeCode: string | null;
  /** Confiance du classement T1 enregistré (`rubric_confidence`). */
  rubricConfidence: number | null;
  analysisInProgress: boolean;
}

export interface ClassificationDiagnosis {
  verdict: Inspection['verdict'];
  anomaly?: ClassificationAnomaly;
  repair?: ClassificationRepair;
  /** Type à enregistrer (RECORD_TYPE). */
  expectedType?: string | null;
  /** Rubriques que le classement enregistré ne pouvait pas connaître (REEVALUATE_T1). */
  newRubrics?: string[];
}

const MAILLON: Record<ClassificationAnomaly, ChainLink> = {
  IDENTIFIED_TYPE_NOT_RECORDED: 'PERSISTENCE',
  TYPE_NOT_IN_RUBRIC: 'PERSISTENCE',
  CLASSIFIED_BEFORE_RUBRIC: 'T1',
};

/**
 * Diagnostic PUR d'un document (testé sans base). Ordre : la réévaluation du
 * domaine d'abord (elle peut changer la Rubrique, donc le Type attendu), puis
 * les écarts de Type.
 */
export function diagnoseDocumentClassification(s: ClassificationState): ClassificationDiagnosis {
  const identified = { documentTypeCode: s.t1DocumentTypeCode, canonicalType: s.identifiedType };

  // 1. Nomenclature : Rubrique introduite après le classement automatique,
  //    dont la nature du document relève. La Rubrique de l'utilisateur prime.
  if (!s.rubricUserValidated) {
    const natures = { documentTypeCode: s.documentTypeCode ?? s.t1DocumentTypeCode, canonicalType: s.identifiedType };
    const nouvelles = rubricsIntroducedAfter(s.referentialVersion)
      .filter((r) => r.code !== s.rubricCode)
      .filter((r) => v2TypeForRubric(natures, r.code) !== null
        || (!!s.documentTypeCode && isTypeCompatibleWithRubric(s.documentTypeCode, r.code)))
      .map((r) => r.code);
    if (nouvelles.length > 0) {
      return { verdict: 'REPAIRABLE', anomaly: 'CLASSIFIED_BEFORE_RUBRIC', repair: 'REEVALUATE_T1', newRubrics: nouvelles };
    }
  }

  if (!s.rubricCode || s.typeUserValidated) return { verdict: 'CONSISTENT' };

  // 2. Type enregistré hors de sa Rubrique (§5.1).
  if (s.documentTypeCode && getDocumentType(s.documentTypeCode)
      && !isTypeCompatibleWithRubric(s.documentTypeCode, s.rubricCode)) {
    const attendu = v2TypeForRubric({ canonicalType: s.identifiedType }, s.rubricCode);
    return attendu
      ? { verdict: 'REPAIRABLE', anomaly: 'TYPE_NOT_IN_RUBRIC', repair: 'RECORD_TYPE', expectedType: attendu }
      : { verdict: 'FINDING', anomaly: 'TYPE_NOT_IN_RUBRIC', expectedType: null };
  }

  // 3. Nature identifiée mais Type non enregistré (le cas « BON_COMMANDE »).
  if (!s.documentTypeCode) {
    const attendu = v2TypeForRubric(identified, s.rubricCode);
    if (attendu) return { verdict: 'REPAIRABLE', anomaly: 'IDENTIFIED_TYPE_NOT_RECORDED', repair: 'RECORD_TYPE', expectedType: attendu };
  }
  return { verdict: 'CONSISTENT' };
}

const ETAT_SQL = `
  SELECT f.id, f.rubric_code, f.document_type_code, f.rubric_user_validated, f.type_user_validated,
         f.classification_referential_version, f.rubric_confidence::float8 AS rubric_confidence,
         f.analysis_state, e.document_type_code AS t1_type, e.metadata ->> 'legacyDocumentType' AS identified
    FROM asset_files f
    JOIN document_extractions e ON e.file_id = f.id AND e.account_id = f.account_id
   WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND ${OPEN_DOCUMENT_SQL}`;

function etatDe(r: Row): ClassificationState {
  return {
    fileId: Number(r.id),
    rubricCode: (r.rubric_code as string | null) ?? null,
    documentTypeCode: (r.document_type_code as string | null) ?? null,
    rubricUserValidated: r.rubric_user_validated === true,
    typeUserValidated: r.type_user_validated === true,
    referentialVersion: (r.classification_referential_version as string | null) ?? null,
    identifiedType: (r.identified as string | null) ?? null,
    t1DocumentTypeCode: (r.t1_type as string | null) ?? null,
    rubricConfidence: r.rubric_confidence == null ? null : Number(r.rubric_confidence),
    analysisInProgress: ['UPLOADING', 'UPLOADED', 'ANALYZING'].includes(String(r.analysis_state ?? '')),
  };
}

async function charger(ctx: Pick<CheckContext, 'sql'>, accountId: number, ids: readonly number[]): Promise<Map<number, ClassificationState>> {
  return new Map((await rows(ctx.sql, ETAT_SQL, [accountId, intArray(ids)])).map((r) => [Number(r.id), etatDe(r)]));
}

export const documentClassificationCheck: CoherenceCheck = {
  id: DOCUMENT_CLASSIFICATION_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Classement documentaire : nomenclature courante et type identifié = type enregistré',
  domain: 'documents',
  level: 'N2',
  objectType: 'document',
  scope: 'documents visibles du compte dont la connaissance T1 est persistée (document_extractions)',
  sources: ['asset_files', 'document_extractions', 'coherence_repairs'],
  applicability: 'compte éligible',
  invariant: 'le Type enregistré appartient à la Rubrique enregistrée et correspond à la nature identifiée par T1 quand la Rubrique n’en propose qu’un ; un classement automatique a été établi avec toutes les Rubriques dont la nature du document relève',
  anomalies: ['IDENTIFIED_TYPE_NOT_RECORDED', 'TYPE_NOT_IN_RUBRIC', 'CLASSIFIED_BEFORE_RUBRIC'],
  autoRepairWhen: 'Type : correspondance unique du référentiel (nature identifiée → Type de la Rubrique), par le moteur de décision ; domaine : réévaluation par T1 (relance existante) dans le plafond des relances IA du contrôle',
  forbiddenRepairs: [
    'remplacer une Rubrique ou un Type validés par l’utilisateur', 'choisir une Rubrique par règle lexicale (nom de fichier, fournisseur, produit)',
    'écrire hors du moteur de décision (applyV2Classification)', 'relancer T1 au-delà du plafond ou deux fois pour le même diagnostic',
    'créer une association à un événement d’Agenda ou à une Opération', 'appeler l’IA en mode à blanc',
  ],
  services: [
    'documents/apply-v2-classification.service#applyV2Classification',
    'ai/source-analysis/source-units/jobs#requeueDocumentForReread',
  ],
  chain: ['T1', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED'],
  frequency: 'campagne exhaustive quotidienne (lecture seule, sans IA) + contrôle ciblé après analyse ou modification du document',
  criticality: 'MEDIUM',
  tests: ['L86E-U-COH', 'L86E-E2E-03', 'L86E-E2E-04', 'L86E-E2E-05'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f JOIN document_extractions e ON e.file_id = f.id AND e.account_id = f.account_id
       WHERE f.account_id = $1 AND f.id > $2 AND ${OPEN_DOCUMENT_SQL} ORDER BY f.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f JOIN document_extractions e ON e.file_id = f.id AND e.account_id = f.account_id
       WHERE f.account_id = $1 AND f.id = $2 AND ${OPEN_DOCUMENT_SQL}`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const etats = await charger(ctx, accountId, ids);
    let budget: number | null = null;
    for (const id of ids) {
      const s = etats.get(id);
      if (!s) { out.set(id, { verdict: 'GONE' }); continue; }
      const d = diagnoseDocumentClassification(s);
      if (d.verdict === 'CONSISTENT') { out.set(id, { verdict: 'CONSISTENT', detail: { fileId: id } }); continue; }
      const observed = { rubricCode: s.rubricCode, documentTypeCode: s.documentTypeCode, referentialVersion: s.referentialVersion, identifiedType: s.identifiedType };
      const base: Inspection = {
        verdict: d.verdict, anomaly: d.anomaly, faultyLink: d.anomaly ? MAILLON[d.anomaly] : 'PERSISTENCE',
        expected: d.repair === 'RECORD_TYPE' ? { documentTypeCode: d.expectedType } : d.newRubrics ? { evaluatedWith: d.newRubrics } : undefined,
        observed,
        detail: { fileId: id, repair: d.repair ?? null, ...(d.newRubrics ? { newRubrics: d.newRubrics } : {}) },
        inputHash: hashOf({ id, a: d.anomaly, o: observed, t: d.expectedType ?? null, n: d.newRubrics ?? null }),
      };
      if (d.repair === 'REEVALUATE_T1') {
        if (s.analysisInProgress) {
          out.set(id, { ...base, verdict: 'FINDING', detail: { ...base.detail, analysisInProgress: true } });
          continue;
        }
        // Plafond unique des relances IA du contrôle (L83-Q3), partagé avec COH-DOC-EXTRACT-CHAIN.
        budget ??= await t1RelaunchBudgetLeft(ctx);
        if (budget <= 0) {
          out.set(id, { ...base, verdict: 'FINDING', detail: { ...base.detail, relaunchBudgetReached: true } });
          continue;
        }
        budget--;
      }
      out.set(id, base);
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const etats = await charger(ctx, accountId, items.map((x) => x.id));
    for (const { id, inspection } of items) {
      const s = etats.get(id);
      if (!s) { out.set(id, { called: false, service: 'none', result: { skipped: 'DOCUMENT_GONE' } }); continue; }
      // Diagnostic recalculé sur l'état courant : jamais d'écriture sur une donnée qui a bougé.
      const d = diagnoseDocumentClassification(s);
      if (d.repair !== (inspection.detail as { repair?: string } | undefined)?.repair) {
        out.set(id, { called: false, service: 'none', result: { skipped: 'STATE_CHANGED' } });
        continue;
      }
      if (d.repair === 'RECORD_TYPE' && s.rubricCode && d.expectedType) {
        const { applyV2Classification } = await import('@/services/documents/apply-v2-classification.service');
        const sorties = await applyV2Classification({
          fileId: id, accountId,
          proposal: {
            rubricCode: s.rubricCode, documentTypeCode: d.expectedType,
            // Confiance du classement T1 enregistré : la correspondance est
            // certaine, la nature identifiée l'est autant que l'analyse.
            confidence: s.rubricConfidence ?? 1,
            // Lot 87D : aucun extrait — l'extrait est AFFICHÉ sur la carte
            // (contexte de la proposition) ; la provenance est tracée par
            // `pipelineVersion` et le journal de réparation, jamais un code
            // technique visible (« COH-DOC-CLASSIFICATION:… »).
          },
          origin: 'SYSTEM_RULE',
          promptVersion: null,
          pipelineVersion: `coherence:${DOCUMENT_CLASSIFICATION_CHECK_ID}@1`,
        });
        const type = sorties.find((o) => o.fieldKey === 'documentTypeCode');
        out.set(id, {
          called: true, service: 'applyV2Classification', aiCalls: 0,
          result: {
            anomaly: d.anomaly, before: { rubricCode: s.rubricCode, documentTypeCode: s.documentTypeCode },
            proposed: { documentTypeCode: d.expectedType }, decision: type?.recommendedDecision ?? null,
            reason: `nature identifiée ${s.identifiedType ?? s.t1DocumentTypeCode ?? '—'} → seul Type de cette nature dans la Rubrique`,
          },
          rollbackRef: `asset_files:id=${id}:rubric_code=${s.rubricCode ?? ''};document_type_code=${s.documentTypeCode ?? ''}`,
        });
        continue;
      }
      if (d.repair === 'REEVALUATE_T1') {
        const [doc] = await rows(ctx.sql, `
          SELECT c.retry_attempts FROM asset_files f LEFT JOIN document_extraction_coverage c ON c.file_id = f.id
           WHERE f.account_id = $1 AND f.id = $2`, [accountId, id]);
        const jobs = await import('@/services/ai/source-analysis/source-units/jobs');
        const ok = await jobs.requeueDocumentForReread({
          fileId: id, accountId, attempt: Number(doc?.retry_attempts ?? 0) + 1, origin: 'coherence-control', result: 'REQUEUED_T1_CLASSIFICATION',
        });
        if (!ok) throw new Error('réévaluation refusée par la file T1');
        out.set(id, {
          called: true, service: 'requeueDocumentForReread', pending: true, aiCalls: 0,
          result: {
            anomaly: d.anomaly, before: { rubricCode: s.rubricCode, documentTypeCode: s.documentTypeCode, referentialVersion: s.referentialVersion },
            evaluatedWith: d.newRubrics, reason: 'classement automatique antérieur à la Rubrique ; la nature du document en relève : réévaluation par T1',
          },
          rollbackRef: `asset_files:id=${id}:rubric_code=${s.rubricCode ?? ''};document_type_code=${s.documentTypeCode ?? ''}`,
        });
        continue;
      }
      out.set(id, { called: false, service: 'none', result: { skipped: 'NO_REPAIR_FOR_DIAGNOSTIC' } });
    }
    return out;
  },
};
