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
 *
 * Lot 91B (version 2) — AUCUNE SORTIE SILENCIEUSE :
 *   · toute issue est persistée dans `property_recovery_runs`, y compris
 *     sans réparation : contrat T3 absent (CONTRACT_PENDING), pannes
 *     répétées (AI_FAILED), campagne à blanc (DRY_RUN), anti-boucle
 *     (REPAIR_SUPPRESSED) — `recordOutcomes`, appelé par le moteur ; le
 *     service de réparation persiste les siennes (budget, panne, nouvelle
 *     tentative pas encore due…) ;
 *   · le constat reste NON RÉSOLU tant qu'une propriété vide applicable n'a
 *     pas de décision dans le contexte courant (preuve FINDING / WOULD_REPAIR
 *     / REPAIR_INEFFECTIVE…), la dernière issue persistée figure au détail ;
 *   · contrat T3 absent, journal inutilisable, pannes répétées : signalés
 *     IMMÉDIATEMENT dans la Supervision (`immediateSupervision`) ;
 *   · RATTRAPAGE (`catchupCandidates`) : objets porteurs de sources jamais
 *     contrôlés (trace NOT_SELECTED) ou constat ouvert sans issue persistée
 *     depuis 20 h → contrôle ciblé demandé, sans attendre un événement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CatchupCandidate, CheckContext, CoherenceCheck, ControlResult, Inspection, RepairResult, UnrepairedOutcome } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';
import type { ObjectRecoveryState } from '@/services/ai/reconciliation/missing-properties/service';
import {
  MISSING_PROPERTIES_CHECK_ID, MISSING_PROPERTIES_CONTRACT_VERSION as MISSING_PROPERTIES_PENDING_CONTRACT_MARKER, MISSING_PROPERTIES_EQUIPMENT_CHECK_ID,
  MISSING_PROPERTIES_PENDING_CONTRACT, contractStateOf, type SubjectType,
} from '@/services/ai/reconciliation/missing-properties/contract';
import { subjectSourcesSql } from '@/services/ai/reconciliation/missing-properties/sql';
import type { GateStatus } from '@/services/ai/reconciliation/missing-properties/store';

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
  const dernier = st.lastOutcome ?? null;
  const detail: Record<string, unknown> = {
    objectType: s.type, objectId: s.id, assetId: s.assetId,
    capability: { available: st.capability.available, reason: st.capability.reason, contractCarried: st.capability.contractCarried, version: st.capability.version },
    counts: { missing: missing.length, pending: st.pending.length, protected: st.catalog.protectedKeys.length, abstentions: abstentions.length },
    // Lot 91B : dernière issue persistée (journal 88B) — « examinée ? quand ? verdict ou cause ? ».
    lastOutcome: dernier ? { status: dernier.status, cause: dernier.cause?.slice(0, 160) ?? null, at: dernier.updatedAt, trigger: dernier.trigger, runId: dernier.id } : null,
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
 * Lot 91B — issue À PERSISTER pour un objet NON réparé (PUR) : chaque
 * résultat sans réparation reçoit un statut et une cause explicites ; null
 * quand rien n'est en attente (aucune propriété vide sans décision).
 */
export function unrepairedIssue(
  o: { result: ControlResult; inspection?: Inspection; previousResult?: string | null },
  st: Pick<ObjectRecoveryState, 'pending' | 'capability' | 'failedRun' | 'lastOutcome'>,
): { status: GateStatus; cause: string } | null {
  if (!st.pending.length) return null;
  const anomalie = o.inspection?.anomaly;
  const etatContrat = contractStateOf(st.capability);
  switch (o.result) {
    case 'FINDING':
      if (anomalie === 'MISSING_PROPERTY_ARBITRATION_PENDING') {
        return { status: 'CONTRACT_PENDING', cause: `${etatContrat}: le prompt T3 actif ne porte pas le contrat ${MISSING_PROPERTIES_PENDING_CONTRACT_MARKER} (demande ${MISSING_PROPERTIES_PENDING_CONTRACT}) — aucun appel, aucune écriture` };
      }
      if (anomalie === 'MISSING_PROPERTY_ARBITRATION_FAILED') {
        return { status: 'AI_FAILED', cause: `MAX_ATTEMPTS_REACHED: ${st.failedRun?.attempts ?? '?'} pannes IA sur ce contexte — reprise à un nouveau contexte ou une nouvelle version du prompt` };
      }
      if (anomalie === 'MISSING_PROPERTY_MEMORY_UNAVAILABLE') return { status: 'MEMORY_UNAVAILABLE', cause: 'RECOVERY_LEDGER_MISSING: journal 88B absent' };
      return { status: 'NOT_EXECUTED', cause: `REPAIR_NOT_PERMITTED: constat ${anomalie ?? 'sans code'} sans réparation dans ce périmètre de compte` };
    case 'WOULD_REPAIR':
      return { status: 'DRY_RUN', cause: 'CAMPAIGN_DRY_RUN: campagne à blanc (COHERENCE_CAMPAIGN_MODE différent de corrective) — réparation prévue, aucun appel T3, aucune écriture' };
    case 'REPAIR_SUPPRESSED': {
      const avant = st.lastOutcome ? ` ; dernière issue ${st.lastOutcome.status}${st.lastOutcome.cause ? ` (${st.lastOutcome.cause.slice(0, 120)})` : ''}` : '';
      return { status: 'REPAIR_SUPPRESSED', cause: `ANTI_LOOP: mêmes entrées déjà tentées aujourd'hui (${o.previousResult ?? 'résultat inconnu'}) — nouvel essai le lendemain ou à un contexte changé${avant}` };
    }
    default:
      return { status: 'NOT_EXECUTED', cause: `${o.result}: réparation non tentée` };
  }
}

/** Lot 91B : états lus à l'inspection, réutilisés pour consigner l'issue (même passage du moteur, aucune relecture). */
const etatsInspectes = new WeakMap<CheckContext, Map<string, ObjectRecoveryState | null>>();

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

/** Fenêtre sans issue persistée au-delà de laquelle un constat ouvert est repris par le rattrapage (au plus une fois par jour). */
const CATCHUP_QUIET_HOURS = 20;
/** Résultats de preuve « constat ouvert » repris par le rattrapage (les erreurs ont leur propre reprise). */
const OPEN_RESULTS = ['FINDING', 'WOULD_REPAIR', 'REPAIR_SUPPRESSED', 'REPAIR_INEFFECTIVE', 'REPAIR_FAILED', 'REPAIR_PENDING'];

/**
 * Lot 91B — RATTRAPAGE : objets porteurs de sources, sans demande en cours,
 * JAMAIS contrôlés par ce contrôle, ou en constat ouvert sans issue 88B
 * persistée ni contrôle depuis `CATCHUP_QUIET_HOURS`. Les comptes non
 * éligibles sont écartés AVANT la sélection (aucune famine). `apply` :
 * l'objet jamais contrôlé reçoit une trace NOT_SELECTED (pourquoi il
 * n'avait pas été examiné) ; la décision reste celle du contrôle ciblé.
 */
async function catchupOf(type: SubjectType, c: { sql: CheckContext['sql']; now: Date; limit: number; accountId?: number | null; apply: boolean; eligible?: (accountId: number) => Promise<boolean> }): Promise<CatchupCandidate[]> {
  const bien = type === 'ASSET';
  const checkId = bien ? MISSING_PROPERTIES_CHECK_ID : MISSING_PROPERTIES_EQUIPMENT_CHECK_ID;
  const depuis = new Date(c.now.getTime() - CATCHUP_QUIET_HOURS * 3_600_000);
  const journal = (await rows(c.sql, `SELECT to_regclass('property_recovery_runs') IS NOT NULL AS ok`))[0]?.ok === true;
  const objet = bien ? 'a.id' : 'e.id';
  const depuisObjet = bien
    ? `FROM assets a WHERE a.deleted_at IS NULL AND ${subjectSourcesSql('ASSET', 'a')}`
    : `FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.deleted_at IS NULL WHERE e.archived_at IS NULL AND ${subjectSourcesSql('EQUIPMENT', 'e')}`;
  const condition = `
      AND NOT EXISTS (SELECT 1 FROM coherence_object_proofs p WHERE p.account_id = a.account_id AND p.check_id = $1 AND p.object_id = ${objet}
                         AND (p.requested_at IS NOT NULL OR NOT (p.last_result = ANY($3::text[]))
                              OR COALESCE(p.last_completed_at, p.last_started_at, '-infinity'::timestamptz) >= $2))
      ${journal ? `AND NOT EXISTS (SELECT 1 FROM property_recovery_runs r WHERE r.account_id = a.account_id AND r.object_type = '${type}' AND r.object_id = ${objet}
                         AND r.updated_at >= $2)` : ''}`;
  // 1. Comptes concernés (bornés), puis éligibilité (règle 82A) : seuls les comptes éligibles sont repris.
  const comptes = (await rows(c.sql, `SELECT DISTINCT a.account_id AS id ${depuisObjet} AND ($4::int IS NULL OR a.account_id = $4) ${condition} ORDER BY 1 LIMIT 500`,
    [checkId, depuis, OPEN_RESULTS, c.accountId ?? null])).map((r) => Number(r.id));
  const eligibles: number[] = [];
  for (const id of comptes) if (!c.eligible || await c.eligible(id)) eligibles.push(id);
  if (!eligibles.length) return [];
  const lignes = await rows(c.sql, `
    SELECT a.account_id, ${objet} AS object_id, a.id AS asset_id,
           NOT EXISTS (SELECT 1 FROM coherence_object_proofs p WHERE p.account_id = a.account_id AND p.check_id = $1 AND p.object_id = ${objet}) AS never
      ${depuisObjet} AND a.account_id = ANY($4::int[]) ${condition}
     ORDER BY a.account_id, ${objet} LIMIT $5`, [checkId, depuis, OPEN_RESULTS, intArray(eligibles), c.limit]);
  const out: CatchupCandidate[] = [];
  for (const l of lignes) {
    const never = l.never === true;
    const cand = { accountId: Number(l.account_id), objectId: Number(l.object_id), reason: never ? 'NEVER_CONTROLLED' : 'NO_RECENT_OUTCOME' };
    out.push(cand);
    if (c.apply && never && journal) {
      const store = await import('@/services/ai/reconciliation/missing-properties/store');
      try {
        await store.saveOutcome({
          accountId: cand.accountId, objectType: type, objectId: cand.objectId, assetId: Number(l.asset_id), contextFp: '', promptVersion: '',
          contractVersion: MISSING_PROPERTIES_PENDING_CONTRACT_MARKER, batchFp: 'not-selected', properties: [], status: 'NOT_SELECTED',
          cause: `NEVER_CONTROLLED: objet porteur de sources jamais contrôlé par ${checkId} — contrôle ciblé demandé par le rattrapage`,
          trigger: 'CATCHUP', runRef: `coherence:catchup:${checkId}`,
        });
      } catch (e) {
        await store.reportRecoveryStorageUnavailable({ accountId: cand.accountId, objectType: type, objectId: cand.objectId, status: 'NOT_SELECTED', error: String((e as Error)?.message ?? e) });
      }
    }
  }
  return out;
}

function controle(type: SubjectType): CoherenceCheck {
  const bien = type === 'ASSET';
  return {
    id: bien ? MISSING_PROPERTIES_CHECK_ID : MISSING_PROPERTIES_EQUIPMENT_CHECK_ID,
    // Lot 91B : version 2 — toute issue persistée ; le stock est réexaminé par la campagne quotidienne suivante (§6.4).
    version: 2,
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
    tests: ['L88B-U-01', 'L88B-U-02', 'L88B-U-03', 'L88B-U-ORDRE', 'L88B-E2E-01', 'L88B-E2E-02', 'L88B-E2E-03', 'L88B-E2E-04',
      'L91B-U-01', 'L91B-U-02', 'L91B-U-03', 'L91B-U-04', 'L91B-E2E-01', 'L91B-E2E-02', 'L91B-E2E-03', 'L91B-E2E-04'],
    immediateSupervision: ['MISSING_PROPERTY_ARBITRATION_PENDING', 'MISSING_PROPERTY_MEMORY_UNAVAILABLE', 'MISSING_PROPERTY_ARBITRATION_FAILED'],

    async listObjects(ctx, accountId, afterId, limit) {
      return idsOf(await rows(ctx.sql, objetsSql(type, (c) => `${c} > $2`, 'LIMIT $3'), [accountId, afterId, limit]));
    },

    async objectsForEvent(ctx, accountId, e) {
      return objetsDeLEvenement(ctx, type, accountId, e);
    },

    async inspect(ctx, accountId, ids) {
      const out = new Map<number, Inspection>();
      const { missingPropertiesState, RECOVERY_MAX_ATTEMPTS } = await import('@/services/ai/reconciliation/missing-properties/service');
      const cache = etatsInspectes.get(ctx) ?? new Map<string, ObjectRecoveryState | null>();
      etatsInspectes.set(ctx, cache);
      for (const id of ids) {
        const st = await missingPropertiesState(accountId, { type, id });
        cache.set(`${accountId}:${id}`, st);
        out.set(id, diagnoseMissingProperties(st, ctx.today, RECOVERY_MAX_ATTEMPTS));
      }
      return out;
    },

    async recordOutcomes(ctx, accountId, items: readonly UnrepairedOutcome[]) {
      const svc = await import('@/services/ai/reconciliation/missing-properties/service');
      for (const it of items) {
        const cle = `${accountId}:${it.id}`;
        const cache = etatsInspectes.get(ctx);
        const st = cache?.has(cle) ? cache.get(cle)! : await svc.missingPropertiesState(accountId, { type, id: it.id });
        if (!st) continue;
        const issue = unrepairedIssue(it, st);
        if (!issue) continue;
        await svc.recordRecoveryOutcome(st, { ...issue, trigger: `COHERENCE:${ctx.trigger ?? 'TARGETED'}`, runRef: ctx.correlationId, campaignId: ctx.campaignId ?? null });
      }
    },

    async catchupCandidates(c) {
      return catchupOf(type, c);
    },

    async repair(ctx, accountId, items) {
      const out = new Map<number, RepairResult>();
      const { recoverMissingProperties } = await import('@/services/ai/reconciliation/missing-properties/service');
      for (const { id } of items) {
        const r = await recoverMissingProperties(accountId, { type, id }, {
          trigger: `COHERENCE:${ctx.trigger ?? 'TARGETED'}`, runRef: ctx.correlationId, campaignId: ctx.campaignId ?? null, today: ctx.today,
        });
        out.set(id, {
          called: true, service: 'recoverMissingProperties', aiCalls: r.calls,
          result: {
            status: r.status, cause: r.cause ?? null, persisted: r.persisted ?? true, written: r.written.map((w) => w.key), abstained: r.abstained.slice(0, 40),
            undecided: r.undecided.slice(0, 40), calls: r.calls, runs: r.runIds.slice(0, 10), contextFingerprint: r.contextFingerprint,
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
