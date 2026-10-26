/**
 * COH-MISSING-PROPERTIES (biens) et COH-MISSING-PROPERTIES-EQUIPMENT
 * (équipements) — une propriété métier ABSENTE est elle-même un cas à
 * contrôler (lot 88B, ticket P1 « Contrôle de cohérence — Détecter et
 * réparer les propriétés métier manquantes à partir de l'ensemble des
 * preuves » ; arbitrages C-Q1, C-Q2, C-Q7, C-Q10, C-Q11).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ARTICULATION (aucun doublon)
 *   · T3 « Informations » 76J : décide les champs à partir des preuves DÉJÀ
 *     projetées sur leur clé. Ici : une propriété VIDE sans candidat est
 *     reprise à partir de TOUT ce que Verebona sait de l'objet (faits,
 *     preuves de champs voisins, documents et classement, Opérations et
 *     composantes, Agenda, valeurs existantes, décisions) — seconde chance
 *     quand le premier passage T1 ou la projection a raté une information.
 *   · COH-T1-KNOWLEDGE-CONSUMPTION (85F) : connaissance T1 d'UN document
 *     pour une carte « À traiter ». Ici : un OBJET métier et ses propriétés
 *     canoniques ; même branche T3 (KNOWLEDGE_QUERY), contrat d'entrée v2.
 *
 * Objet : bien (resp. équipement actif) du compte qui porte au moins une
 * source à examiner (document rattaché, Opération, Agenda, preuve de champ).
 * Inspection (lecture seule, sans IA, mode à blanc compris) :
 *   · aucune propriété vide soumissible → CONSISTENT ;
 *   · propriétés vides déjà DÉCIDÉES dans le contexte courant (empreinte du
 *     contexte, version du prompt T3) → CONSISTENT (valeur absente ou non
 *     établie, abstention tracée) ou AMBIGUOUS (ambiguïté, contradiction,
 *     confiance insuffisante : aucune écriture, aucune carte) ;
 *   · propriétés vides NON examinées dans ce contexte :
 *       REPAIRABLE `MISSING_PROPERTIES_UNEXAMINED` (contrat T3 porté par le
 *       prompt actif, ou contexte vide : abstention sans IA) ;
 *       FINDING `MISSING_PROPERTY_ARBITRATION_PENDING` (le prompt actif ne
 *       porte pas le contrat : demande `88B-t3-proprietes-manquantes`) ;
 *       FINDING `MISSING_PROPERTY_ARBITRATION_FAILED` (pannes répétées).
 * Réparation : `recoverMissingProperties` — arbitrage T3, écriture par le
 * writer canonique des seules valeurs établies, preuves et décisions
 * tracées ; jamais d'écriture du contrôle lui-même.
 *
 * Coût IA borné : budget du compte PARTAGÉ avec 85F
 * (`T3_KNOWLEDGE_QUERY_DAILY_MAX`), mémoire par contexte (aucun rappel sur un
 * contexte inchangé), un essai par jour au plus pour un même contexte (le
 * jour entre dans l'empreinte des entrées : anti-boucle du moteur).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CheckContext, CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';
import type { ObjectRecoveryState } from '@/services/ai/reconciliation/missing-properties/service';
import {
  MISSING_PROPERTIES_CHECK_ID, MISSING_PROPERTIES_EQUIPMENT_CHECK_ID, MISSING_PROPERTIES_PENDING_CONTRACT, type SubjectType,
} from '@/services/ai/reconciliation/missing-properties/contract';
import { subjectSourcesSql } from '@/services/ai/reconciliation/missing-properties/sql';

const OPERATION_CHANGED = 'BUSINESS_OPERATION_CHANGED';
/** Abstentions qui laissent une ambiguïté (aucune écriture, aucune carte) : verdict AMBIGUOUS. */
export const AMBIGUOUS_CAUSES: ReadonlySet<string> = new Set(['AMBIGUOUS', 'CONTRADICTION', 'INSUFFICIENT_CONFIDENCE', 'DATE_ORDER_AMBIGUOUS']);

type MissingPropertiesAnomaly =
  | 'MISSING_PROPERTIES_UNEXAMINED' | 'MISSING_PROPERTY_ARBITRATION_PENDING' | 'MISSING_PROPERTY_ARBITRATION_FAILED'
  | 'MISSING_PROPERTY_MEMORY_UNAVAILABLE' | 'MISSING_PROPERTY_ABSTENTION';

/**
 * Diagnostic d'un objet (PUR, testé sans base) à partir de son état en
 * lecture seule. `today` : date de référence (un essai par jour au plus).
 */
export function diagnoseMissingProperties(st: ObjectRecoveryState | null, today: string, maxAttempts = 3): Inspection {
  if (!st) return { verdict: 'GONE' };
  const s = st.subject;
  const missing = st.catalog.missing.map((m) => m.key);
  const abstentions = [...st.decided.values()].filter((d) => d.decision === 'ABSTAINED').map((d) => ({ key: d.fieldKey, cause: d.cause }));
  // Détail BORNÉ (preuve de contrôle : 1 500 caractères) — informations décisives d'abord, listes courtes.
  const detail: Record<string, unknown> = {
    objectType: s.type, objectId: s.id, assetId: s.assetId,
    capability: { available: st.capability.available, reason: st.capability.reason, contractCarried: st.capability.contractCarried, version: st.capability.version },
    counts: { missing: missing.length, pending: st.pending.length, protected: st.catalog.protectedKeys.length, abstentions: abstentions.length },
    context: {
      fingerprint: st.contextFingerprint, elements: st.plan.elements, documents: st.documents.length, complete: st.complete,
      truncation: { paging: st.plan.droppedByLayer, collection: st.collected.collectionDropped },
    },
    protected: st.catalog.protectedKeys.slice(0, 8), abstentions: abstentions.slice(0, 10), pending: st.pending.map((p) => p.key).slice(0, 12),
  };
  if (!missing.length) return { verdict: 'CONSISTENT', detail: { objectType: s.type, objectId: s.id, protected: detail.protected } };
  if (!st.pending.length) {
    const ambigues = abstentions.filter((a) => a.cause && AMBIGUOUS_CAUSES.has(a.cause));
    if (!ambigues.length) return { verdict: 'CONSISTENT', detail };
    return {
      verdict: 'AMBIGUOUS', anomaly: 'MISSING_PROPERTY_ABSTENTION', faultyLink: 'T3',
      observed: { properties: ambigues.slice(0, 20) }, detail,
      inputHash: hashOf({ t: s.type, id: s.id, a: ambigues, fp: st.contextFingerprint }),
    };
  }
  const pending = st.pending.map((p) => p.key);
  const constat = (anomaly: MissingPropertiesAnomaly, extra: Record<string, unknown> = {}): Inspection => ({
    verdict: 'FINDING', anomaly, faultyLink: 'T3', observed: { pending: pending.slice(0, 12), count: pending.length }, detail: { ...extra, ...detail },
    inputHash: hashOf({ t: s.type, id: s.id, anomaly, pending, fp: st.contextFingerprint, cap: st.capability.reason, v: st.capability.version }),
  });
  if (st.plan.elements > 0) {
    if (!st.memoryReady) return constat('MISSING_PROPERTY_MEMORY_UNAVAILABLE');
    if (!st.capability.contractCarried) return constat('MISSING_PROPERTY_ARBITRATION_PENDING', { pendingContract: MISSING_PROPERTIES_PENDING_CONTRACT });
    if (st.failedRun && st.failedRun.attempts >= maxAttempts) return constat('MISSING_PROPERTY_ARBITRATION_FAILED', { attempts: st.failedRun.attempts });
  }
  return {
    verdict: 'REPAIRABLE', anomaly: 'MISSING_PROPERTIES_UNEXAMINED', faultyLink: 'T3',
    expected: { decisionPerMissingProperty: true }, observed: { pending: pending.slice(0, 12), count: pending.length }, detail,
    // Un essai par jour au plus pour un même contexte (budget IA, anti-boucle du moteur).
    inputHash: hashOf({ t: s.type, id: s.id, pending, fp: st.contextFingerprint, v: st.decisionPromptVersion, jour: today }),
  };
}

/**
 * Objets du compte porteurs d'au moins une source (SQL partagé : énumération
 * et contrôle ciblé). `filtre` reçoit la colonne d'identifiant de l'objet.
 */
function objetsSql(type: SubjectType, filtre: (col: string) => string, limite: string): string {
  return type === 'ASSET'
    ? `SELECT a.id FROM assets a WHERE a.account_id = $1 AND a.deleted_at IS NULL AND ${filtre('a.id')} AND ${subjectSourcesSql('ASSET', 'a')} ORDER BY a.id ${limite}`
    : `SELECT e.id FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
        WHERE e.archived_at IS NULL AND ${filtre('e.id')} AND ${subjectSourcesSql('EQUIPMENT', 'e')} ORDER BY e.id ${limite}`;
}

/** Objets touchés par un événement métier (documents, Opérations, Agenda, objet lui-même, carte). */
async function objetsDeLEvenement(ctx: CheckContext, type: SubjectType, accountId: number, e: { type: string; entityId: number | null; assetId?: number | null }): Promise<number[]> {
  if (e.entityId == null) return [];
  const id = e.entityId;
  let candidats: number[] = [];
  const bien = type === 'ASSET';
  switch (e.type) {
    case 'ASSET_UPDATED':
      candidats = bien ? [id] : idsOf(await rows(ctx.sql, `SELECT id FROM equipments WHERE asset_id = $1`, [id]));
      break;
    case 'SOURCE_ANALYZED': case 'DOCUMENT_UPDATED': case 'DOCUMENT_UPLOADED': case 'DOCUMENT_DELETED':
      candidats = bien
        ? idsOf(await rows(ctx.sql, `
            SELECT asset_id AS id FROM asset_files WHERE id = $1 AND account_id = $2 AND asset_id IS NOT NULL
            UNION SELECT asset_id FROM document_asset_links WHERE file_id = $1 AND account_id = $2 AND asset_id IS NOT NULL AND status = 'ACTIVE'`, [id, accountId]))
          .concat(e.assetId ? [e.assetId] : [])
        : idsOf(await rows(ctx.sql, `SELECT equipment_id AS id FROM document_asset_links WHERE file_id = $1 AND account_id = $2 AND equipment_id IS NOT NULL AND status = 'ACTIVE'`, [id, accountId]));
      break;
    case OPERATION_CHANGED:
      candidats = idsOf(await rows(ctx.sql, bien
        ? `SELECT asset_id AS id FROM business_operation_asset_links WHERE operation_id = $1 AND account_id = $2`
        : `SELECT equipment_id AS id FROM business_operation_equipment_links WHERE operation_id = $1 AND account_id = $2`, [id, accountId]));
      break;
    case 'AGENDA_ITEM_CREATED': case 'AGENDA_ITEM_UPDATED':
      candidats = idsOf(await rows(ctx.sql, bien
        ? `SELECT l.asset_id AS id FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $2 WHERE l.agenda_item_id = $1`
        : `SELECT l.equipment_id AS id FROM agenda_equipment_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $2 WHERE l.agenda_item_id = $1`, [id, accountId]));
      break;
    case 'TO_PROCESS_ITEM_UPDATED':
      candidats = idsOf(await rows(ctx.sql, `SELECT target_id AS id FROM to_process_actions WHERE id = $1 AND account_id = $2 AND target_type = $3 AND field_key IS NOT NULL`,
        [id, accountId, type]));
      break;
    default:
      return [];
  }
  if (!candidats.length) return [];
  return idsOf(await rows(ctx.sql, objetsSql(type, (c) => `${c} = ANY($2::int[])`, ''), [accountId, intArray(candidats)]));
}

function controle(type: SubjectType): CoherenceCheck {
  const bien = type === 'ASSET';
  return {
    id: bien ? MISSING_PROPERTIES_CHECK_ID : MISSING_PROPERTIES_EQUIPMENT_CHECK_ID,
    version: 1,
    status: 'ACTIVE',
    title: bien
      ? 'Biens : propriétés métier manquantes reprises à partir de l’ensemble des preuves (arbitrage T3)'
      : 'Équipements : propriétés métier manquantes reprises à partir de l’ensemble des preuves (arbitrage T3)',
    domain: bien ? 'biens' : 'equipements',
    level: 'N3',
    objectType: bien ? 'asset' : 'equipment',
    scope: bien
      ? 'biens du compte portant au moins une source (document rattaché, Opération, élément d’Agenda, preuve de champ) — propriétés canoniques VIDES du registre de leur famille'
      : 'équipements actifs portant au moins une source — propriétés canoniques VIDES du registre (cible ÉQUIPEMENT)',
    sources: ['assets', 'equipments', 'field_evidence', 'document_facts', 'document_unresolved_facts', 'document_source_units', 'document_extractions',
      'asset_files', 'document_asset_links', 'business_operations', 'business_operation_financial_components', 'business_operation_sources',
      'business_operation_documents', 'agenda_items', 'reconciliation_decisions', 'canonical_field_writes', 'to_process_actions',
      'property_recovery_runs', 'property_recovery_decisions'],
    applicability: 'compte éligible ; propriétés du registre applicables à l’objet, hors saisie seule, texte libre, donnée sensible et valeur composée',
    invariant: 'chaque propriété canonique vide d’un objet a été examinée par T3 sur TOUT le contexte connu de Verebona (contexte courant) : valeur établie écrite par le writer canonique avec ses preuves, ou abstention motivée tracée ; une correction de l’utilisateur n’est jamais écrasée',
    anomalies: ['MISSING_PROPERTIES_UNEXAMINED', 'MISSING_PROPERTY_ARBITRATION_PENDING', 'MISSING_PROPERTY_ARBITRATION_FAILED',
      'MISSING_PROPERTY_MEMORY_UNAVAILABLE', 'MISSING_PROPERTY_ABSTENTION'],
    autoRepairWhen: 'le prompt T3 actif porte le contrat d’entrée t3-knowledge-query-v2 (ou contexte vide : abstention sans IA), dans le budget IA du compte ; écriture seulement d’une valeur ÉTABLIE par T3 et validée par le serveur',
    forbiddenRepairs: ['écrire une valeur sans décision T3 établie', 'règle métier codée (type de document, mot, montant, fournisseur)',
      'écraser ou ré-écrire une valeur effacée ou tranchée par l’utilisateur', 'écrire hors du writer canonique', 'créer une carte « À traiter »',
      'relancer T1', 'conclure « absente » sur un contexte tronqué', 'appeler l’IA sur un contexte déjà examiné'],
    services: ['ai/reconciliation/missing-properties/service#recoverMissingProperties', 'ai/reconciliation/knowledge-query/model#callKnowledgeQueryModel',
      bien ? 'canonical/asset-state#writeCanonicalAssetFields' : 'canonical/entity-state#writeCanonicalEntityFields', 'ai/evidence/field-evidence.service#recordEvidence'],
    chain: ['T1', 'T3', 'PERSISTENCE'],
    triggers: ['ASSET_UPDATED', 'SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_UPLOADED', 'DOCUMENT_DELETED', OPERATION_CHANGED, 'AGENDA_ITEM_CREATED',
      'AGENDA_ITEM_UPDATED', 'TO_PROCESS_ITEM_UPDATED'],
    frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque changement d’une source de l’objet',
    criticality: 'MEDIUM',
    semanticReevaluation: ['T3'],
    tests: ['L88B-U-01', 'L88B-U-02', 'L88B-U-03', 'L88B-U-ORDRE', 'L88B-E2E-01', 'L88B-E2E-02', 'L88B-E2E-03', 'L88B-E2E-04'],

    async listObjects(ctx, accountId, afterId, limit) {
      return idsOf(await rows(ctx.sql, objetsSql(type, (c) => `${c} > $2`, 'LIMIT $3'), [accountId, afterId, limit]));
    },

    async objectsForEvent(ctx, accountId, e) {
      return objetsDeLEvenement(ctx, type, accountId, e);
    },

    async inspect(ctx, accountId, ids) {
      const out = new Map<number, Inspection>();
      const { missingPropertiesState, RECOVERY_MAX_ATTEMPTS } = await import('@/services/ai/reconciliation/missing-properties/service');
      for (const id of ids) {
        const st = await missingPropertiesState(accountId, { type, id });
        out.set(id, diagnoseMissingProperties(st, ctx.today, RECOVERY_MAX_ATTEMPTS));
      }
      return out;
    },

    async repair(ctx, accountId, items) {
      const out = new Map<number, RepairResult>();
      const { recoverMissingProperties } = await import('@/services/ai/reconciliation/missing-properties/service');
      for (const { id } of items) {
        const r = await recoverMissingProperties(accountId, { type, id }, { trigger: 'COHERENCE', runRef: ctx.correlationId, today: ctx.today });
        out.set(id, {
          called: true, service: 'recoverMissingProperties', aiCalls: r.calls,
          result: {
            status: r.status, written: r.written.map((w) => w.key), abstained: r.abstained.slice(0, 40), undecided: r.undecided.slice(0, 40),
            calls: r.calls, runs: r.runIds.slice(0, 10), contextFingerprint: r.contextFingerprint,
          },
          rollbackRef: `canonical_field_writes:source=coherence_missing_property;property_recovery_decisions:${type}=${id}`,
          reevaluation: 'SEMANTIC_REEVALUATION_T3',
        });
      }
      return out;
    },
  };
}

export const missingPropertiesCheck: CoherenceCheck = controle('ASSET');
export const missingPropertiesEquipmentCheck: CoherenceCheck = controle('EQUIPMENT');
