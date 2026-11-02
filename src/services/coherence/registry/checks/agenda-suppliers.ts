/**
 * COH-AGENDA-SUPPLIERS — fournisseurs / intervenants des éléments d'Agenda
 * (lot 103E, ticket P1 « Agenda / Fournisseurs », §7 « contrôle global de
 * cohérence — sans mécanisme de reprise distinct »).
 *
 * Aucun nouveau planificateur : ce contrôle du registre est exécuté par les
 * contrôles CIBLÉS (élément créé / modifié, document modifié ou analysé) et
 * par la campagne exhaustive QUOTIDIENNE existante, sur les comptes éligibles
 * seulement — événements existants et nouveaux.
 *
 * Objet : élément d'Agenda d'un compte qui possède au moins un fournisseur.
 *   · inspection (lecture seule, sans IA) : preuves PROPRES à l'élément
 *     (`computeAgendaSupplierEvidence`) confrontées aux liens et aux retraits
 *     manuels (`planAgendaSupplierSync`) :
 *       AUTO_LINK_MISSING        preuve fiable sans lien (ni retrait manuel) ;
 *       AUTO_LINK_UNPROVEN       lien automatique dont la preuve a disparu ;
 *       AUTO_LINK_PROVENANCE     provenance automatique dépassée ;
 *       CROSS_ACCOUNT_LINK       lien ou retrait vers un objet d'un autre
 *                                compte (constat, jamais réparé ici) ;
 *   · réparation : `syncAutomaticAgendaSuppliers` (service unique, idempotent,
 *     historique `agenda_item_supplier_history`, corrélation du contrôle).
 * Jamais : retirer un lien USER, recréer un retrait manuel, lier par simple
 * appartenance au même événement de référence ou au même bien.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

export const AGENDA_SUPPLIERS_CHECK_ID = 'COH-AGENDA-SUPPLIERS';

const OBJETS = `i.account_id = $1 AND EXISTS (SELECT 1 FROM suppliers s WHERE s.account_id = $1 AND s.status <> 'deleted')`;

export const agendaSuppliersCheck: CoherenceCheck = {
  id: AGENDA_SUPPLIERS_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Agenda : fournisseurs / intervenants rattachés sur preuve propre à l’élément, décisions manuelles respectées',
  domain: 'agenda',
  level: 'N2',
  objectType: 'agenda_item',
  scope: 'éléments d’Agenda des comptes qui possèdent au moins un fournisseur (passés, à venir, sans date)',
  sources: ['agenda_items', 'agenda_item_suppliers', 'agenda_item_supplier_suppressions', 'agenda_file_links', 'document_suppliers', 'suppliers', 'document_operation_candidates'],
  applicability: 'compte éligible ; élément du compte, fournisseurs du compte',
  invariant: 'chaque fournisseur établi de façon fiable par une preuve PROPRE à l’élément (document directement rattaché, mention explicite non ambiguë) est relié, sauf retrait manuel ; aucun lien automatique sans preuve ; aucun lien intercomptes',
  anomalies: ['AUTO_LINK_MISSING', 'AUTO_LINK_UNPROVEN', 'AUTO_LINK_PROVENANCE', 'CROSS_ACCOUNT_LINK'],
  autoRepairWhen: 'preuve fiable propre à l’élément sans lien ni retrait manuel (lien posé) ; lien automatique dont la preuve a disparu (retiré) ; provenance automatique dépassée (mise à jour)',
  forbiddenRepairs: [
    'retirer ou modifier un lien posé par l’utilisateur',
    'recréer un lien retiré par l’utilisateur',
    'lier par simple appartenance au même événement de référence ou au même bien',
    'réparer un lien intercomptes',
    'appeler l’IA ou relire un document',
  ],
  services: ['agenda/agenda-suppliers#syncAutomaticAgendaSuppliers'],
  chain: ['PERSISTENCE', 'LINK'],
  triggers: ['AGENDA_ITEM_CREATED', 'AGENDA_ITEM_UPDATED', 'DOCUMENT_UPDATED', 'DOCUMENT_DELETED', 'SOURCE_ANALYZED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à la création / modification d’un élément et à la modification ou l’analyse d’un document',
  criticality: 'MEDIUM',
  tests: ['L103E-U-RULES', 'L103E-E2E-AC10'],
  immediateSupervision: ['CROSS_ACCOUNT_LINK'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT i.id FROM agenda_items i WHERE ${OBJETS} AND i.id > $2 ORDER BY i.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    let ids: number[] = [];
    if (e.type === 'AGENDA_ITEM_CREATED' || e.type === 'AGENDA_ITEM_UPDATED') ids = [e.entityId];
    else if (e.type === 'DOCUMENT_UPDATED' || e.type === 'DOCUMENT_DELETED' || e.type === 'SOURCE_ANALYZED') {
      ids = idsOf(await rows(ctx.sql, `SELECT DISTINCT fl.agenda_item_id AS id FROM agenda_file_links fl WHERE fl.asset_file_id = $1`, [e.entityId]));
    }
    if (!ids.length) return [];
    return idsOf(await rows(ctx.sql, `SELECT i.id FROM agenda_items i WHERE ${OBJETS} AND i.id = ANY($2::int[]) ORDER BY i.id`, [accountId, intArray(ids)]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { planAgendaSuppliers } = await import('@/services/agenda/agenda-suppliers');
    const intercomptes = new Set(idsOf(await rows(ctx.sql, `
      SELECT DISTINCT x.agenda_item_id AS id FROM (
        SELECT agenda_item_id, supplier_id, account_id FROM agenda_item_suppliers WHERE agenda_item_id = ANY($2::int[])
        UNION ALL SELECT agenda_item_id, supplier_id, account_id FROM agenda_item_supplier_suppressions WHERE agenda_item_id = ANY($2::int[])
      ) x
      LEFT JOIN suppliers s ON s.id = x.supplier_id
      LEFT JOIN agenda_items i ON i.id = x.agenda_item_id
      WHERE x.account_id <> $1 OR s.account_id IS DISTINCT FROM $1 OR i.account_id IS DISTINCT FROM $1`, [accountId, intArray(ids)])));
    const plans = await planAgendaSuppliers(accountId, ids);
    for (const id of ids) {
      const p = plans.get(id);
      if (!p?.exists) { out.set(id, { verdict: 'GONE' }); continue; }
      if (intercomptes.has(id)) {
        out.set(id, { verdict: 'FINDING', anomaly: 'CROSS_ACCOUNT_LINK', faultyLink: 'LINK', expected: 'liens et retraits du seul compte de l’élément', observed: 'lien vers un objet d’un autre compte', inputHash: hashOf({ id, x: 'cross' }) });
        continue;
      }
      const { add, remove, upgrade, suppressed } = p.plan;
      if (!add.length && !remove.length && !upgrade.length) {
        out.set(id, { verdict: 'CONSISTENT', ...(suppressed.length || p.ambiguousMentions.length ? { detail: { suppressedEvidence: suppressed.length, ambiguousMentions: p.ambiguousMentions.length } } : {}) });
        continue;
      }
      const observed = {
        add: add.map((a) => ({ supplierId: a.supplierId, provenance: a.provenance, documentId: a.documentId ?? null })),
        remove: remove.map((r) => ({ supplierId: r.supplierId, provenance: r.provenance })),
        upgrade: upgrade.map((u) => ({ supplierId: u.supplierId, provenance: u.provenance })),
      };
      out.set(id, {
        verdict: 'REPAIRABLE',
        anomaly: add.length ? 'AUTO_LINK_MISSING' : remove.length ? 'AUTO_LINK_UNPROVEN' : 'AUTO_LINK_PROVENANCE',
        faultyLink: 'LINK',
        expected: 'fournisseurs établis par une preuve propre à l’élément, reliés (hors retrait manuel)',
        observed,
        detail: { add: add.length, remove: remove.length, upgrade: upgrade.length, suppressedEvidence: suppressed.length },
        inputHash: hashOf({ id, observed }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { syncAutomaticAgendaSuppliers } = await import('@/services/agenda/agenda-suppliers');
    const res = await syncAutomaticAgendaSuppliers(accountId, items.map((i) => i.id), { correlationId: ctx.correlationId });
    for (const { id } of items) {
      const r = res.find((x) => x.itemId === id);
      out.set(id, {
        called: true, service: 'syncAutomaticAgendaSuppliers', aiCalls: 0, reevaluation: 'TECHNICAL_REBUILD',
        result: r ? { added: r.added.length, removed: r.removed.length, upgraded: r.upgraded.length } : { skipped: 'GONE' },
        rollbackRef: `agenda_item_supplier_history:correlation_id=${ctx.correlationId}`,
      });
    }
    return out;
  },
};
