/**
 * Contrôles Agenda du registre (lot 82B — V-Q4, C-Q2, C-Q9).
 *
 * COH-AGENDA-OCCURRENCES — doublons d'occurrence d'une intervention (lot
 *   76H). Réutilise la DÉTECTION du rattrapage 76H (`detectOperations`,
 *   lecture seule) et la PROJECTION Opérations → Agenda (`projectAccount
 *   Operations`) : plan simulé (`dryRun`) pour le diagnostic, puis même
 *   moteur appliqué pour la réparation (consolidation certaine, journal 0591
 *   restaurable). Seules les représentations établies comme la MÊME
 *   occurrence par l'identité T3 sont fusionnées : deux étapes distinctes,
 *   l'événement principal et ses échéances restent distincts (V-Q4) ; une
 *   identité incertaine reste à l'arbitrage existant (jamais tranchée ici).
 *   Remplace la tâche de démarrage `agenda-intervention-duplicates-reprise`
 *   (retirée) : une seule chaîne corrige ces doublons.
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
  o.account_id = $1 AND o.type_code = 'INTERVENTION'
  AND ((o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL)
       OR EXISTS (SELECT 1 FROM agenda_items i WHERE i.account_id = o.account_id AND i.business_operation_id = o.id))`;

export const agendaOccurrencesCheck: CoherenceCheck = {
  id: 'COH-AGENDA-OCCURRENCES',
  version: 1,
  status: 'ACTIVE',
  title: 'Agenda : une occurrence d’intervention = un seul événement (76H)',
  domain: 'agenda',
  level: 'N2',
  objectType: 'business_operation',
  scope: 'Opérations d’intervention du compte (actives, ou fusionnées / invalidées encore citées par un événement)',
  sources: ['business_operations', 'business_operation_sources', 'agenda_items', 'agenda_item_sources', 'agenda_intervention_consolidations'],
  applicability: 'compte éligible ; journal 0591 présent (sinon la projection s’abstient)',
  invariant: 'une occurrence établie par T3 n’a qu’un événement d’agenda ; les étapes distinctes et les échéances restent distinctes',
  anomalies: ['DUPLICATE_OCCURRENCE', 'OCCURRENCE_NOT_LINKED', 'OCCURRENCE_IDENTITY_UNCERTAIN'],
  autoRepairWhen: 'plan de projection certain (CONSOLIDATE / LINK) fondé sur l’identité T3 ; éléments touchés par l’utilisateur protégés par les gardes SQL',
  forbiddenRepairs: ['fusionner sur « même date + même titre »', 'fusionner des étapes distinctes ou l’événement principal et ses échéances', 'créer une Opération artificielle'],
  services: ['business-operations/agenda-projection/service#projectAccountOperations', 'agenda-projection/duplicates-reprise#detectOperations'],
  chain: ['T3', 'T4', 'PROJECTION'],
  triggers: ['AGENDA_ITEM_CREATED', 'AGENDA_ITEM_UPDATED', 'SOURCE_ANALYZED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque changement',
  criticality: 'MEDIUM',
  tests: ['L82B-E2E-06', 'L76H-E01'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE ${OPERATIONS_SQL} AND o.id > $2 ORDER BY o.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
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
    const candidats = new Set((await detectOperations(ctx.sql, accountId)).ids);
    const vivantes = new Set(idsOf(await rows(ctx.sql, `SELECT id FROM business_operations WHERE account_id = $1 AND id = ANY($2::bigint[])`, [accountId, intArray(ids)])));
    for (const id of ids) {
      if (!vivantes.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      if (!candidats.has(id)) { out.set(id, { verdict: 'CONSISTENT' }); continue; }
      // Plan SIMULÉ du moteur de projection (aucune écriture).
      const plan = await projectAccountOperations(accountId, { operationIds: [id], dryRun: true, correlationId: ctx.correlationId, today: ctx.today });
      const actions = (plan.plans ?? []).flatMap((p) => p.actions);
      const certaines = actions.filter((a) => a.kind === 'CONSOLIDATE' || a.kind === 'LINK');
      const detail = { actions: actions.map((a) => a.kind) };
      if (certaines.length) {
        const consolide = certaines.some((a) => a.kind === 'CONSOLIDATE');
        out.set(id, {
          verdict: 'REPAIRABLE', anomaly: consolide ? 'DUPLICATE_OCCURRENCE' : 'OCCURRENCE_NOT_LINKED', faultyLink: 'PROJECTION',
          expected: 'un seul événement lié à l’intervention', observed: certaines, detail,
          inputHash: hashOf({ id, certaines }),
        });
      } else if (actions.some((a) => a.kind === 'ABSTAIN' && (a.candidates?.length ?? 0) > 0)) {
        out.set(id, { verdict: 'AMBIGUOUS', anomaly: 'OCCURRENCE_IDENTITY_UNCERTAIN', faultyLink: 'T3', detail, inputHash: hashOf({ id, actions }) });
      } else {
        out.set(id, { verdict: 'CONSISTENT', detail });
      }
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    for (const { id } of items) {
      const r = await projectAccountOperations(accountId, { operationIds: [id], correlationId: ctx.correlationId, today: ctx.today });
      out.set(id, {
        called: true, service: 'projectAccountOperations', aiCalls: 0,
        result: { consolidated: r.consolidated ?? 0, linked: r.linked, retitled: r.retitled ?? 0, protected: r.consolidationProtected ?? 0, changes: r.changes },
        // Restauration : journal 0591 (`agenda_intervention_consolidations`, corrélation), BO › Rattrapages.
        rollbackRef: `agenda_intervention_consolidations:correlation_id=${ctx.correlationId}`,
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
