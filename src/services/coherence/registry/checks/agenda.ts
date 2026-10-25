/**
 * Contrôles Agenda du registre (lot 82B — V-Q4, C-Q2, C-Q9).
 *
 * COH-AGENDA-OCCURRENCES — représentation Agenda des Opérations (lot 76H ;
 *   lot 87B v2, ticket « orchestration T3/T4 », CODE-03 à CODE-07, CODE-11).
 *   SÉLECTION (signaux, jamais décision) : détection du rattrapage 76H
 *   (`detectOperations`, lecture seule) élargie aux sinistres, achats,
 *   cessions et aux anciennes consolidations non validées ; PLAN simulé de la
 *   projection (`projectAccountOperations`, `dryRun`). Deux natures de
 *   réparation, distinguées au journal (`reevaluation`) :
 *     · TECHNICAL_REBUILD : rattachement par provenance (l'unique
 *       représentation T4 issue d'un document de l'Opération), projection
 *       technique qui lui cède la place — la projection est rejouée ;
 *     · SEMANTIC_REEVALUATION_T4 : plusieurs représentations possibles
 *       (doublons ? étapes distinctes ?), ou consolidation historique décidée
 *       par l'ancienne règle du code (provenance + type + date) — une NOUVELLE
 *       décision est demandée à T4 (contexte multi-événements, validation,
 *       application atomique, mémoire anti-rappel) ; jamais la même règle
 *       rejouée (CODE-06). Sans capacité T4 (contrat multi-événements non
 *       livré : `87B-t4-representation-agenda-multi-evenements`), CONSTAT
 *       qualifié — aucune fusion, aucune séparation par le code.
 *   Une décision appliquée n'est jamais redemandée sur l'état qu'elle a
 *   produit (convergence) ; une décision refusée ne l'est pas tant que le
 *   contexte ne change pas. Remplace la tâche de démarrage
 *   `agenda-intervention-duplicates-reprise` (retirée) : une seule chaîne.
 *
 * COH-AGENDA-ORPHANS — éléments automatiques issus d'un champ de fiche
 *   (`origin_type = 'asset_field'`) — lot 83E (v2) : ou d'un document qualifié
 *   (`qualified_document`, événement OBSOLÈTE dont le document SOURCE connu a
 *   été retiré ; sans source connue : jamais retiré) —
 *   qui ne sont plus rattachés à RIEN (bien,
 *   équipement, pièce, document source, Opération active) : retrait TRACÉ et
 *   restaurable (`removeAgendaItemsTraced`, trace 0223 ; gardes : élément
 *   automatique, jamais modifié ni confirmé par l'utilisateur). Remplace
 *   l'écriture directe de l'ancienne maintenance horaire, qui posait le
 *   STATUT UTILISATEUR « annulé » sans trace — retirée. Un élément encore
 *   rattaché seulement à un bien supprimé logiquement est un CONSTAT (aucune
 *   écriture).
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

// ── COH-AGENDA-OCCURRENCES ──────────────────────────────────────────────────

/** Lot 83E (v2) : origines des éléments automatiques contrôlés (la projection des Opérations a son propre contrôle). */
const ORIGINES_ORPHELINS = ['asset_field', 'qualified_document'];

const OPERATIONS_SQL = `
  o.account_id = $1 AND o.type_code IN ('INTERVENTION', 'CLAIM', 'ACQUISITION', 'DISPOSAL')
  AND ((o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL)
       OR EXISTS (SELECT 1 FROM agenda_items i WHERE i.account_id = o.account_id AND i.business_operation_id = o.id))`;

/** Lot 87B : anomalies qui demandent une décision SÉMANTIQUE T4 (réparation `SEMANTIC_REEVALUATION_T4`). */
export const SEMANTIC_T4_ANOMALIES: ReadonlySet<string> = new Set(['REPRESENTATION_DECISION_REQUIRED', 'HISTORICAL_CONSOLIDATION_UNVALIDATED']);

export const agendaOccurrencesCheck: CoherenceCheck = {
  id: 'COH-AGENDA-OCCURRENCES',
  // v2 (lot 87B) : plus aucune fusion décidée par le code — décision T4 multi-événements, ou constat.
  version: 2,
  status: 'ACTIVE',
  title: 'Agenda : représentation des Opérations décidée par T4 (doublons, étapes distinctes, rattachements, principal)',
  domain: 'agenda',
  level: 'N2',
  objectType: 'business_operation',
  scope: 'Opérations d’intervention, de sinistre, d’achat et de cession du compte (actives, ou fusionnées / invalidées encore citées par un événement)',
  sources: ['business_operations', 'business_operation_sources', 'agenda_items', 'agenda_item_sources', 'agenda_intervention_consolidations',
    'business_operation_match_decisions', 'operation_semantic_reevaluations'],
  applicability: 'compte éligible ; journaux 0591 et 0752 présents (sinon aucune décision appliquée)',
  invariant: 'la représentation Agenda d’une Opération est celle que T4 a décidée (une occurrence = un événement, les étapes distinctes restent distinctes, les corrections de l’utilisateur sont respectées) ; aucune fusion ni séparation décidée par une règle du code',
  anomalies: ['OCCURRENCE_NOT_LINKED', 'REPRESENTATION_DECISION_REQUIRED', 'HISTORICAL_CONSOLIDATION_UNVALIDATED', 'REPRESENTATION_DECISION_UNAVAILABLE',
    'REPRESENTATION_DECISION_REJECTED', 'REPRESENTATION_DECISION_ABSTAINED', 'REPRESENTATION_DECISION_RETRY', 'OCCURRENCE_IDENTITY_UNCERTAIN'],
  autoRepairWhen: 'rattachement par provenance (technique) ; décision T4 multi-événements VALIDÉE (sémantique) — mutations protégées par les décisions de l’utilisateur, appliquées atomiquement',
  forbiddenRepairs: ['fusionner sur « même date + même titre » ou « même bien + même catégorie + date proche »', 'fusionner des étapes distinctes ou l’événement principal et ses échéances',
    'rejouer l’ancienne consolidation sur une décision historique suspecte', 'remplacer une réponse IA invalide par une règle du code',
    'rétablir un lien que l’utilisateur a détaché', 'créer une Opération artificielle'],
  services: ['business-operations/agenda-projection/service#projectAccountOperations', 'agenda-projection/duplicates-reprise#detectOperations',
    'business-operations/semantic/orchestrator#reevaluateRepresentation'],
  chain: ['T3', 'T4', 'PROJECTION'],
  triggers: ['AGENDA_ITEM_CREATED', 'AGENDA_ITEM_UPDATED', 'SOURCE_ANALYZED', 'BUSINESS_OPERATION_CHANGED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque changement',
  criticality: 'MEDIUM',
  tests: ['L82B-E2E-06', 'L76H-E01', 'L87B-E2E-04', 'L87B-E2E-05', 'L87B-E2E-08'],
  semanticReevaluation: ['T4'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE ${OPERATIONS_SQL} AND o.id > $2 ORDER BY o.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (e.type === 'BUSINESS_OPERATION_CHANGED') {
      return idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE ${OPERATIONS_SQL} AND o.id = $2`, [accountId, e.entityId]));
    }
    if (e.type === 'SOURCE_ANALYZED') {
      return idsOf(await rows(ctx.sql, `
        SELECT DISTINCT o.id FROM business_operations o
          JOIN business_operation_sources s ON s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = $2::text
         WHERE ${OPERATIONS_SQL} ORDER BY o.id`, [accountId, e.entityId]));
    }
    // Événement d'agenda : Opération liée, ou Opérations dont le document source a produit l'élément.
    return idsOf(await rows(ctx.sql, `
      SELECT DISTINCT o.id FROM business_operations o
       WHERE ${OPERATIONS_SQL}
         AND (o.id IN (SELECT i.business_operation_id FROM agenda_items i WHERE i.account_id = $1 AND i.id = $2)
              OR o.id IN (SELECT s.operation_id FROM business_operation_sources s
                            JOIN agenda_items i ON i.account_id = s.account_id AND i.id = $2 AND i.origin_ref_type = 'asset_file'
                           WHERE s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = i.origin_ref_id::text))
       ORDER BY o.id`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { detectOperations } = await import('@/services/business-operations/agenda-projection/duplicates-reprise');
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    const { reevaluateRepresentation, REPRESENTATION_AI_CONTRACT } = await import('@/services/business-operations/semantic/orchestrator');
    const candidats = new Set((await detectOperations(ctx.sql, accountId)).ids);
    const vivantes = new Set(idsOf(await rows(ctx.sql, `SELECT id FROM business_operations WHERE account_id = $1 AND id = ANY($2::bigint[])`, [accountId, intArray(ids)])));
    // Anciennes consolidations décidées par l'ancienne règle du code, jamais validées par T4 (CODE-06, CODE-07).
    const { historicalConsolidationSql, semanticJournalReady } = await import('@/services/business-operations/semantic/store');
    const { consolidationJournalReady } = await import('@/services/business-operations/agenda-projection/consolidation');
    const absorptions = (await consolidationJournalReady(ctx.sql)) ? new Set(idsOf(await rows(ctx.sql, `
      SELECT o.id FROM business_operations o WHERE o.account_id = $1 AND o.id = ANY($2::bigint[])
         AND ${historicalConsolidationSql('o', await semanticJournalReady(ctx.sql))}`, [accountId, intArray(ids)]))) : new Set<number>();
    for (const id of ids) {
      if (!vivantes.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      if (!candidats.has(id)) { out.set(id, { verdict: 'CONSISTENT' }); continue; }
      // Plan SIMULÉ du moteur de projection (aucune écriture).
      const plan = await projectAccountOperations(accountId, { operationIds: [id], dryRun: true, correlationId: ctx.correlationId, today: ctx.today });
      const actions = (plan.plans ?? []).filter((p) => p.operationId === id).flatMap((p) => p.actions);
      const techniques = actions.filter((a) => a.kind === 'LINK' || (a.kind === 'REMOVE' && a.reason === 'PROJECTION_YIELDS_TO_T4_REPRESENTATION'));
      const demandes = (plan.representationRequired ?? []).filter((r) => r.operationId === id);
      const detail: Record<string, unknown> = { actions: actions.map((a) => a.kind) };
      if (techniques.length) {
        out.set(id, {
          verdict: 'REPAIRABLE', anomaly: 'OCCURRENCE_NOT_LINKED', faultyLink: 'PROJECTION',
          expected: 'l’unique représentation T4 de l’Opération lui est rattachée', observed: techniques, detail: { ...detail, nature: 'TECHNICAL_REBUILD' },
          inputHash: hashOf({ id, techniques }),
        });
        continue;
      }
      const historique = absorptions.has(id);
      if (!demandes.length && !historique) {
        if (actions.some((a) => a.kind === 'ABSTAIN' && (a.candidates?.length ?? 0) > 0)) {
          out.set(id, { verdict: 'AMBIGUOUS', anomaly: 'OCCURRENCE_IDENTITY_UNCERTAIN', faultyLink: 'T4', detail, inputHash: hashOf({ id, actions }) });
        } else {
          out.set(id, { verdict: 'CONSISTENT', detail });
        }
        continue;
      }
      // Décision sémantique T4 : diagnostic sans appel ni écriture (mode à blanc de l'orchestration).
      const extraItemIds = [...new Set(demandes.flatMap((d) => d.itemIds))];
      const r = await reevaluateRepresentation({
        accountId, operationId: id, trigger: 'COHERENCE', triggerRef: ctx.correlationId, correlationId: ctx.correlationId, extraItemIds, today: ctx.today, mode: 'DRY_RUN',
        deps: { sql: ctx.sql },
      });
      const semantic = { ...detail, nature: 'SEMANTIC_REEVALUATION_T4', extraItemIds, fingerprint: r.fingerprint, orchestration: r.status, reason: r.reason ?? null };
      const anomalie = historique && !demandes.length ? 'HISTORICAL_CONSOLIDATION_UNVALIDATED' : 'REPRESENTATION_DECISION_REQUIRED';
      if (r.status === 'NOT_NEEDED') { out.set(id, { verdict: 'CONSISTENT', detail: semantic }); continue; }
      if (r.status === 'SETTLED') {
        const s = r.settledBy?.status;
        if (s === 'REJECTED') out.set(id, { verdict: 'AMBIGUOUS', anomaly: 'REPRESENTATION_DECISION_REJECTED', faultyLink: 'T4', detail: { ...semantic, journalId: r.journalId }, inputHash: hashOf({ id, fp: r.fingerprint, s }) });
        else if (s === 'ABSTAINED') out.set(id, { verdict: 'AMBIGUOUS', anomaly: 'REPRESENTATION_DECISION_ABSTAINED', faultyLink: 'T4', detail: { ...semantic, journalId: r.journalId }, inputHash: hashOf({ id, fp: r.fingerprint, s }) });
        else if (s === 'AI_FAILED' || s === 'FAILED') out.set(id, { verdict: 'AMBIGUOUS', anomaly: 'REPRESENTATION_DECISION_RETRY', faultyLink: 'T4', detail: { ...semantic, journalId: r.journalId }, inputHash: hashOf({ id, fp: r.fingerprint, s }) });
        else out.set(id, { verdict: 'CONSISTENT', detail: { ...semantic, journalId: r.journalId, decision: s } });
        continue;
      }
      if (r.status === 'UNAVAILABLE') {
        out.set(id, {
          verdict: 'FINDING', anomaly: 'REPRESENTATION_DECISION_UNAVAILABLE', faultyLink: 'T4',
          expected: 'décision T4 multi-événements', observed: anomalie,
          detail: { ...semantic, aiContract: REPRESENTATION_AI_CONTRACT, repairChain: 'aucune fusion ni séparation par le code tant que T4 ne peut pas décider' },
          inputHash: hashOf({ id, fp: r.fingerprint, u: r.reason }),
        });
        continue;
      }
      if (r.status === 'DEFERRED') { out.set(id, { verdict: 'AMBIGUOUS', anomaly: anomalie, faultyLink: 'T4', detail: semantic, inputHash: hashOf({ id, fp: r.fingerprint, d: r.reason }) }); continue; }
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly: anomalie, faultyLink: 'T4',
        expected: 'représentation décidée par T4 (doublons consolidés, étapes distinctes conservées, principal désigné)', observed: { extraItemIds, historicalConsolidation: historique },
        detail: semantic, inputHash: hashOf({ id, fp: r.fingerprint }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    const { reevaluateRepresentation } = await import('@/services/business-operations/semantic/orchestrator');
    const passCalls = { n: 0 };
    for (const { id, inspection } of items) {
      if (SEMANTIC_T4_ANOMALIES.has(inspection.anomaly ?? '')) {
        const extraItemIds = ((inspection.detail as { extraItemIds?: number[] } | undefined)?.extraItemIds ?? []).filter((x) => Number.isSafeInteger(x));
        const r = await reevaluateRepresentation({
          accountId, operationId: id, trigger: 'COHERENCE', triggerRef: `${inspection.anomaly}`, correlationId: ctx.correlationId, extraItemIds, today: ctx.today,
          passCalls, deps: { sql: ctx.sql },
        });
        out.set(id, {
          called: true, service: 'reevaluateRepresentation', aiCalls: r.aiCalls, reevaluation: 'SEMANTIC_REEVALUATION_T4',
          // Report (plafond) : la décision viendra à une tentative suivante — jamais une réparation « inefficace ».
          ...(r.status === 'DEFERRED' ? { pending: true } : {}),
          result: { status: r.status, journalId: r.journalId, applied: r.applied, refused: r.refused, reason: r.reason ?? null, identityConcern: r.identityConcern ?? null },
          rollbackRef: r.journalId ? `operation_semantic_reevaluations:id=${r.journalId}` : null,
        });
        continue;
      }
      const r = await projectAccountOperations(accountId, { operationIds: [id], correlationId: ctx.correlationId, today: ctx.today });
      out.set(id, {
        called: true, service: 'projectAccountOperations', aiCalls: 0, reevaluation: 'TECHNICAL_REBUILD',
        result: { linked: r.linked, removed: r.removed, retitled: r.retitled ?? 0, changes: r.changes },
        rollbackRef: `agenda_item_removals:correlation=${ctx.correlationId}`,
      });
    }
    return out;
  },
};

// ── COH-AGENDA-ORPHANS ──────────────────────────────────────────────────────

export const agendaOrphansCheck: CoherenceCheck = {
  id: 'COH-AGENDA-ORPHANS',
  // v2 (lot 83E) : événements documentaires (source retirée) inclus.
  version: 2,
  status: 'ACTIVE',
  title: 'Agenda : échéances de fiche ou documentaires sans plus aucun rattachement',
  domain: 'agenda',
  level: 'N1',
  objectType: 'agenda_item',
  scope: 'éléments d’agenda du compte issus d’un champ de fiche ou d’un document qualifié (origin_type = asset_field, qualified_document)',
  sources: ['agenda_items', 'agenda_asset_links', 'agenda_equipment_links', 'agenda_room_links', 'agenda_file_links', 'assets', 'business_operations'],
  applicability: 'compte éligible ; trace 0223 présente (sinon aucun retrait)',
  invariant: 'une échéance de fiche est rattachée à un bien, un équipement, une pièce, un document ou une Opération vivants',
  anomalies: ['ORPHAN_ASSET_FIELD_ITEM', 'ORPHAN_DOCUMENT_ITEM', 'LINKED_TO_DELETED_ASSET'],
  autoRepairWhen: 'élément automatique intact (jamais modifié, ni statut ni confirmation utilisateur) sans aucun rattachement vivant',
  forbiddenRepairs: ['poser un statut utilisateur (« annulé »)', 'retirer un élément modifié ou confirmé par l’utilisateur', 'retirer sans trace restaurable'],
  services: ['agenda/agenda-removal-trace#removeAgendaItemsTraced'],
  chain: ['PERSISTENCE', 'PROJECTION'],
  triggers: ['AGENDA_ITEM_CREATED', 'AGENDA_ITEM_UPDATED', 'ASSET_DELETED', 'DOCUMENT_DELETED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque changement',
  criticality: 'LOW',
  tests: ['L82B-E2E-08', 'L83E-E2E-02'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT i.id FROM agenda_items i WHERE i.account_id = $1 AND i.origin_type = ANY($4::text[]) AND i.id > $2 ORDER BY i.id LIMIT $3`,
    [accountId, afterId, limit, ORIGINES_ORPHELINS]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.type === 'ASSET_DELETED' || e.type === 'DOCUMENT_DELETED') {
      // Le bien / document a disparu : ses échéances de fiche sans plus aucun lien.
      return idsOf(await rows(ctx.sql, `
        SELECT i.id FROM agenda_items i WHERE i.account_id = $1 AND i.origin_type = ANY($2::text[])
           AND NOT EXISTS (SELECT 1 FROM agenda_asset_links l JOIN assets a ON a.id = l.asset_id AND a.deleted_at IS NULL WHERE l.agenda_item_id = i.id)
         ORDER BY i.id`, [accountId, ORIGINES_ORPHELINS]));
    }
    if (e.entityId == null) return [];
    return idsOf(await rows(ctx.sql, `SELECT i.id FROM agenda_items i WHERE i.account_id = $1 AND i.id = $2 AND i.origin_type = ANY($3::text[])`, [accountId, e.entityId, ORIGINES_ORPHELINS]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const r = await rows(ctx.sql, `
      SELECT i.id, i.origin_type,
             (SELECT count(*)::int FROM agenda_asset_links l JOIN assets a ON a.id = l.asset_id WHERE l.agenda_item_id = i.id AND a.deleted_at IS NULL) AS live_assets,
             (SELECT array_agg(a.id ORDER BY a.id) FROM agenda_asset_links l JOIN assets a ON a.id = l.asset_id WHERE l.agenda_item_id = i.id AND a.deleted_at IS NOT NULL) AS deleted_assets,
             (SELECT count(*)::int FROM agenda_equipment_links l WHERE l.agenda_item_id = i.id) AS equipments,
             (SELECT count(*)::int FROM agenda_room_links l WHERE l.agenda_item_id = i.id) AS rooms,
             (SELECT count(*)::int FROM agenda_file_links l JOIN asset_files f ON f.id = l.asset_file_id AND f.deleted_at IS NULL WHERE l.agenda_item_id = i.id) AS files,
             (i.origin_ref_type = 'asset_file' AND EXISTS (SELECT 1 FROM asset_files f WHERE f.id = i.origin_ref_id AND f.account_id = i.account_id AND f.deleted_at IS NULL)) AS source_alive,
             (i.origin_ref_type = 'asset_file' AND i.origin_ref_id IS NOT NULL) AS has_source,
             (i.business_operation_id IS NOT NULL AND EXISTS (SELECT 1 FROM business_operations o WHERE o.id = i.business_operation_id
                                                              AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL)) AS operation_alive,
             (i.is_automatic AND NOT i.is_automatic_modified AND (i.manual_status IS NULL OR i.manual_status = '')
              AND i.confirmation_mode IS DISTINCT FROM 'USER') AS untouched
        FROM agenda_items i WHERE i.account_id = $1 AND i.id = ANY($2::int[])`, [accountId, intArray(ids)]);
    const parId = new Map(r.map((x) => [Number(x.id), x]));
    for (const id of ids) {
      const x = parId.get(id);
      if (!x) { out.set(id, { verdict: 'GONE' }); continue; }
      const vivant = Number(x.live_assets) + Number(x.equipments) + Number(x.rooms) + Number(x.files) > 0 || x.source_alive === true || x.operation_alive === true;
      const morts = ((x.deleted_assets as number[] | null) ?? []).map(Number);
      if (vivant) { out.set(id, { verdict: 'CONSISTENT' }); continue; }
      if (morts.length) {
        out.set(id, { verdict: 'FINDING', anomaly: 'LINKED_TO_DELETED_ASSET', faultyLink: 'PERSISTENCE', observed: { deletedAssetIds: morts }, inputHash: hashOf({ id, morts }) });
        continue;
      }
      if (x.untouched !== true) {
        // Élément modifié ou confirmé par l'utilisateur : son choix, jamais retiré automatiquement.
        out.set(id, { verdict: 'CONSISTENT', detail: { userOwned: true } });
        continue;
      }
      const documentaire = x.origin_type === 'qualified_document';
      if (documentaire && x.has_source !== true) {
        // Lot 83E : un événement documentaire n'est OBSOLÈTE que si sa source a été retirée — sans source connue, aucun retrait.
        out.set(id, { verdict: 'CONSISTENT', detail: { noKnownSource: true } });
        continue;
      }
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly: documentaire ? 'ORPHAN_DOCUMENT_ITEM' : 'ORPHAN_ASSET_FIELD_ITEM', faultyLink: 'PROJECTION',
        expected: 'échéance rattachée à sa source', observed: 'aucun rattachement vivant', detail: { originType: x.origin_type },
        inputHash: hashOf({ id, orphan: true }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { removeAgendaItemsTraced } = await import('@/services/agenda/agenda-removal-trace');
    const ids = items.map((x) => x.id);
    const doc = items.filter((x) => (x.inspection.detail as { originType?: string } | undefined)?.originType === 'qualified_document').map((x) => x.id);
    const fiche = ids.filter((id) => !doc.includes(id));
    const gone = new Set([
      ...(fiche.length ? await removeAgendaItemsTraced(ctx.sql, { accountId, ids: fiche, reason: 'ORPHAN_ASSET_FIELD' }) : []),
      ...(doc.length ? await removeAgendaItemsTraced(ctx.sql, { accountId, ids: doc, reason: 'ORPHAN_SOURCE_DELETED' }) : []),
    ]);
    for (const id of ids) {
      out.set(id, {
        called: true, service: 'removeAgendaItemsTraced', aiCalls: 0, result: { removed: gone.has(id) },
        rollbackRef: gone.has(id) ? `agenda_item_removals:agenda_item_id=${id}` : null,
      });
    }
    return out;
  },
};
