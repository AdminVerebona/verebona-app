/**
 * COH-DOC-DATE-FALLBACK — date du document issue d'un mauvais repli sur le
 * jour d'import (lot 108D, ticket P1 « Listes de documents : une seule date,
 * la date du document, sinon « – » », §4 reprise de l'existant).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ORIGINE DU DÉFAUT (démontrée, voir `services/documents/upload-document-date`)
 *
 * La fenêtre d'ajout pré-remplissait la date du document avec le JOUR
 * COURANT ; `/api/files/confirm` la posait dans `asset_files.document_date`.
 * Quand T1 ne lisait aucune date fiable, le jour d'import restait la « date
 * du document » (listes, filtres, tris).
 *
 * SIGNATURE PROUVABLE (lecture seule, sans IA)
 *
 *   `document_date` = jour civil (UTC ou Paris) de la création ou de la
 *   confirmation du dépôt (`created_at`, `uploaded_at`),
 *   ET jamais saisie / validée par l'utilisateur
 *      (`user_edited_fields.documentDate` ≠ true),
 *   ET aucune preuve documentaire ne porte cette date : la connaissance T1
 *      persistée (`document_extractions.document_date` + sa confiance dans
 *      `structural_evidence.documentDate`) ne la lit pas.
 *
 * Une date que T1 a lue (non contradictoire) et qui tombe le jour de
 * l'import est un vrai document du jour : CONSISTENT, aucune écriture. Les
 * documents d'un même jour d'import ne sont donc PAS présumés erronés.
 *
 * RÉPARATION (déterministe, conditionnelle, journalisée)
 *
 *   · RESTORE_EXTRACTED_DATE  T1 a lu une autre date, non contradictoire →
 *     elle est posée (preuve : extraction persistée) ;
 *   · CLEAR_IMPORT_DAY        aucune date fiable lue (absente, contradictoire
 *     sur une autre valeur, document jamais analysé) → la valeur est retirée :
 *     la liste affiche « – » (jamais la date d'ajout), sans sollicitation de
 *     l'utilisateur.
 *   · AMBIGUOUS               T1 a lu le jour d'import comme date CONTESTÉE :
 *     aucune écriture (suivi technique par la preuve de contrôle).
 *   · analyse en cours        constat FINDING : T1 tranchera.
 *
 * L'écriture passe par `repairDocumentDateFallback` : mise à jour
 * CONDITIONNELLE (valeur courante inchangée, aucune marque utilisateur) —
 * jamais une correction manuelle écrasée. La date d'ajout, les fichiers,
 * relations, Opérations et événements ne sont pas touchés. Avant / après dans
 * `coherence_repairs` (retour arrière : `rollbackRef`). Idempotent : après
 * réparation, la signature disparaît.
 *
 * Aucune règle propre à un bien, un type ou un fournisseur.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CheckContext, CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows, type Row } from '../util';
import { OPEN_DOCUMENT_SQL } from './document-links';

export const DOCUMENT_DATE_FALLBACK_CHECK_ID = 'COH-DOC-DATE-FALLBACK';
export const DOCUMENT_DATE_FALLBACK_CHECK_VERSION = 1;

/** Fuseau de présentation (jour civil de l'utilisateur), en plus du jour UTC du pré-remplissage. */
const PRESENTATION_TIME_ZONE = 'Europe/Paris';

type DateFallbackAnomaly = 'IMPORT_DAY_AS_DOCUMENT_DATE';
type DateFallbackRepair = 'RESTORE_EXTRACTED_DATE' | 'CLEAR_IMPORT_DAY';

/** État lu d'un document (lecture seule). */
export interface DocumentDateState {
  fileId: number;
  documentDate: string | null;
  /** Jours civils d'import (UTC et Paris, création et confirmation). */
  importDays: string[];
  userEdited: boolean;
  analysisInProgress: boolean;
  /** Connaissance T1 persistée présente. */
  hasExtraction: boolean;
  extractedDate: string | null;
  /** Confiance T1 de la date lue (`certain`, `probable`, `conflictual`…). */
  extractedConfidence: string | null;
}

export interface DocumentDateDiagnosis {
  verdict: Inspection['verdict'];
  anomaly?: DateFallbackAnomaly;
  repair?: DateFallbackRepair;
  /** Valeur à poser (RESTORE) ou null (CLEAR). */
  expected?: string | null;
  reason?: string;
}

/** Diagnostic PUR (testé sans base). */
export function diagnoseDocumentDateFallback(s: DocumentDateState): DocumentDateDiagnosis {
  if (s.userEdited || !s.documentDate) return { verdict: 'CONSISTENT' };
  if (!s.importDays.includes(s.documentDate)) return { verdict: 'CONSISTENT' };
  const anomaly: DateFallbackAnomaly = 'IMPORT_DAY_AS_DOCUMENT_DATE';
  if (s.analysisInProgress) return { verdict: 'FINDING', anomaly, reason: 'ANALYSIS_IN_PROGRESS' };
  const lue = s.hasExtraction ? s.extractedDate : null;
  const contestee = s.extractedConfidence === 'conflictual';
  if (lue && lue === s.documentDate) {
    // Le document est réellement daté du jour d'import (preuve T1) — ou T1 le
    // conteste : dans ce second cas, rien n'est prouvé, aucune écriture.
    return contestee ? { verdict: 'AMBIGUOUS', anomaly, reason: 'IMPORT_DAY_IS_CONTESTED_CANDIDATE' } : { verdict: 'CONSISTENT' };
  }
  if (lue && !contestee) {
    return { verdict: 'REPAIRABLE', anomaly, repair: 'RESTORE_EXTRACTED_DATE', expected: lue, reason: 'T1_READ_ANOTHER_DATE' };
  }
  return {
    verdict: 'REPAIRABLE', anomaly, repair: 'CLEAR_IMPORT_DAY', expected: null,
    reason: !s.hasExtraction ? 'NEVER_ANALYZED_NO_EVIDENCE' : lue ? 'T1_DATE_CONTESTED_NO_RELIABLE_DATE' : 'T1_READ_NO_DATE',
  };
}

/** Jours civils d'import d'un document, calculés en SQL (UTC et Paris). */
const IMPORT_DAYS_SQL = (col: string) => `
  ARRAY_REMOVE(ARRAY[
    (${col}.uploaded_at AT TIME ZONE 'UTC')::date::text, (${col}.uploaded_at AT TIME ZONE '${PRESENTATION_TIME_ZONE}')::date::text,
    (${col}.created_at AT TIME ZONE 'UTC')::date::text, (${col}.created_at AT TIME ZONE '${PRESENTATION_TIME_ZONE}')::date::text
  ], NULL)`;

/** Signature SQL (périmètre des objets examinés). */
const SIGNATURE_SQL = `f.document_date IS NOT NULL
  AND COALESCE(f.user_edited_fields ->> 'documentDate', 'false') <> 'true'
  AND f.document_date::text = ANY(${IMPORT_DAYS_SQL('f')})`;

const ETAT_SQL = `
  SELECT f.id, f.document_date::text AS document_date, ${IMPORT_DAYS_SQL('f')} AS import_days,
         COALESCE(f.user_edited_fields ->> 'documentDate', 'false') = 'true' AS user_edited,
         f.analysis_state, (e.id IS NOT NULL) AS has_extraction, e.document_date::text AS extracted_date,
         e.structural_evidence -> 'documentDate' ->> 'confidence' AS extracted_confidence
    FROM asset_files f
    LEFT JOIN document_extractions e ON e.file_id = f.id AND e.account_id = f.account_id
   WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND ${OPEN_DOCUMENT_SQL}`;

function etatDe(r: Row): DocumentDateState {
  return {
    fileId: Number(r.id),
    documentDate: (r.document_date as string | null) ?? null,
    importDays: Array.isArray(r.import_days) ? (r.import_days as string[]) : [],
    userEdited: r.user_edited === true,
    analysisInProgress: ['UPLOADING', 'UPLOADED', 'ANALYZING'].includes(String(r.analysis_state ?? '')),
    hasExtraction: r.has_extraction === true,
    extractedDate: (r.extracted_date as string | null) ?? null,
    extractedConfidence: (r.extracted_confidence as string | null) ?? null,
  };
}

async function charger(ctx: Pick<CheckContext, 'sql'>, accountId: number, ids: readonly number[]): Promise<Map<number, DocumentDateState>> {
  return new Map((await rows(ctx.sql, ETAT_SQL, [accountId, intArray(ids)])).map((r) => [Number(r.id), etatDe(r)]));
}

export const documentDateFallbackCheck: CoherenceCheck = {
  id: DOCUMENT_DATE_FALLBACK_CHECK_ID,
  version: DOCUMENT_DATE_FALLBACK_CHECK_VERSION,
  status: 'ACTIVE',
  title: 'Date du document : jamais le jour d’import par repli',
  domain: 'documents',
  level: 'N2',
  objectType: 'document',
  scope: 'documents visibles du compte dont la date du document est égale au jour de leur import, sans validation utilisateur',
  sources: ['asset_files', 'document_extractions', 'coherence_repairs'],
  applicability: 'compte éligible',
  invariant: 'la date du document (asset_files.document_date) est la date métier lue ou saisie ; elle n’est jamais le jour d’import posé par repli ; sans date fiable elle est vide (« – » en liste)',
  anomalies: ['IMPORT_DAY_AS_DOCUMENT_DATE'],
  autoRepairWhen: 'jour d’import non validé par l’utilisateur et non porté par la connaissance T1 : date lue par T1 (non contradictoire) reposée, sinon valeur retirée ; jour d’import lu comme date contestée : aucune écriture (ambigu)',
  forbiddenRepairs: [
    'remplacer une date saisie ou validée par l’utilisateur', 'poser la date d’ajout, d’analyse ou de modification comme date du document',
    'déduire une date d’un nom de fichier ou d’un titre', 'inventer un jour pour une date partielle',
    'modifier la date d’ajout, les relations, les Opérations ou les événements', 'appeler l’IA',
  ],
  services: ['documents/document-date-repair.service#repairDocumentDateFallback'],
  chain: ['T1', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_UPLOADED'],
  frequency: 'campagne exhaustive quotidienne (lecture seule, sans IA) + contrôle ciblé après analyse, dépôt ou modification du document',
  criticality: 'MEDIUM',
  tests: ['L108D-U-COH', 'L108D-E2E-01', 'L108D-E2E-02', 'L108D-E2E-03'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f
       WHERE f.account_id = $1 AND f.id > $2 AND ${OPEN_DOCUMENT_SQL} AND ${SIGNATURE_SQL}
       ORDER BY f.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f
       WHERE f.account_id = $1 AND f.id = $2 AND ${OPEN_DOCUMENT_SQL} AND ${SIGNATURE_SQL}`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const etats = await charger(ctx, accountId, ids);
    for (const id of ids) {
      const s = etats.get(id);
      if (!s) { out.set(id, { verdict: 'GONE' }); continue; }
      const d = diagnoseDocumentDateFallback(s);
      if (d.verdict === 'CONSISTENT') { out.set(id, { verdict: 'CONSISTENT', detail: { fileId: id } }); continue; }
      const observed = { documentDate: s.documentDate, importDays: s.importDays, extractedDate: s.extractedDate, extractedConfidence: s.extractedConfidence, hasExtraction: s.hasExtraction };
      out.set(id, {
        verdict: d.verdict, anomaly: d.anomaly, faultyLink: 'PERSISTENCE',
        expected: d.repair ? { documentDate: d.expected ?? null } : undefined,
        observed,
        detail: { fileId: id, repair: d.repair ?? null, reason: d.reason ?? null },
        inputHash: hashOf({ id, o: observed, r: d.repair ?? null, e: d.expected ?? null }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const etats = await charger(ctx, accountId, items.map((x) => x.id));
    const { repairDocumentDateFallback } = await import('@/services/documents/document-date-repair.service');
    for (const { id, inspection } of items) {
      const s = etats.get(id);
      if (!s) { out.set(id, { called: false, service: 'none', result: { skipped: 'DOCUMENT_GONE' } }); continue; }
      // Diagnostic recalculé sur l'état courant : jamais d'écriture sur une donnée qui a bougé.
      const d = diagnoseDocumentDateFallback(s);
      if (!d.repair || d.repair !== (inspection.detail as { repair?: string } | undefined)?.repair) {
        out.set(id, { called: false, service: 'none', result: { skipped: 'STATE_CHANGED' } });
        continue;
      }
      const r = await repairDocumentDateFallback(ctx.sql, {
        accountId, fileId: id, currentDate: s.documentDate!, newDate: d.expected ?? null,
      });
      out.set(id, {
        called: true, service: 'repairDocumentDateFallback', aiCalls: 0,
        result: { anomaly: d.anomaly, repair: d.repair, reason: d.reason, before: { documentDate: s.documentDate }, after: { documentDate: r.changed ? (d.expected ?? null) : s.documentDate }, changed: r.changed },
        rollbackRef: `asset_files:id=${id}:document_date=${s.documentDate}`,
        reevaluation: 'TECHNICAL_REBUILD',
      });
    }
    return out;
  },
};
