/**
 * COH-OPERATION-RELATIONS — relations métier autour de l'Opération pivot
 * (lot 109A, ticket P1 « Relations métier », §7). Étend le registre existant
 * (aucun moteur parallèle) : exécuté par les contrôles CIBLÉS (document
 * modifié / analysé / supprimé) et par la campagne exhaustive QUOTIDIENNE sur
 * les comptes éligibles seulement — c'est aussi la REPRISE HISTORIQUE du
 * stock (pagination du moteur, curseur par compte, reprise sur erreur,
 * historique avant / après dans les preuves et les réparations ; la version
 * du contrôle rend tout le stock à réexaminer).
 *
 * Objet : Opération du compte — active, ou absorbée / invalidée qui porte
 * encore un lien fournisseur actif.
 *   · inspection (lecture seule, sans IA) : fournisseurs PROUVÉS de
 *     l'Opération (`inspectOperationSuppliers`, règle unique de T3) confrontés
 *     aux liens persistés et aux décisions de l'utilisateur :
 *       OPERATION_SUPPLIER_MISSING   relation certaine non persistée (dont le
 *                                    stock antérieur au lot 109A) ;
 *       OPERATION_SUPPLIER_UNPROVEN  lien automatique dont la preuve a disparu ;
 *       OPERATION_SUPPLIER_OUTDATED  rôle ou preuve d'un lien automatique dépassés ;
 *       INHERITED_LINK_AFTER_MERGE   lien encore actif sur une Opération absorbée
 *                                    (héritage fantôme) ;
 *       CROSS_ACCOUNT_LINK           lien vers une fiche d'un autre compte
 *                                    (constat, signalé immédiatement) ;
 *   · réparation : `syncOperationSuppliersForAccount` (service unique,
 *     verrou des Opérations du compte, idempotent, historique
 *     `business_operation_supplier_history`, corrélation du contrôle).
 * Jamais : recréer un lien refusé ou retiré par l'utilisateur, modifier un
 * lien USER, lier un fournisseur sur un nom lu dans un texte, propager un
 * document en lien direct vers les équipements / fournisseurs de
 * l'Opération (anti-cartésien : la lecture VIA_OPERATION suffit), appeler l'IA.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

export const OPERATION_RELATIONS_CHECK_ID = 'COH-OPERATION-RELATIONS';

const TABLE_PRETE = `to_regclass('business_operation_suppliers') IS NOT NULL`;
/** Objets : Opérations actives, ou absorbées / invalidées portant encore un lien actif. */
const OBJETS = `o.account_id = $1 AND (
  (o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL)
  OR EXISTS (SELECT 1 FROM business_operation_suppliers l WHERE l.operation_id = o.id AND l.status = 'ACTIVE' AND o.merged_into_operation_id IS NOT NULL))`;

export const operationRelationsCheck: CoherenceCheck = {
  id: OPERATION_RELATIONS_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Opérations : fournisseurs prouvés persistés, sans héritage fantôme, décisions de l’utilisateur respectées',
  domain: 'operations',
  level: 'N2',
  objectType: 'business_operation',
  scope: 'Opérations actives des comptes éligibles, et Opérations absorbées portant encore un lien fournisseur actif',
  sources: ['business_operations', 'business_operation_sources', 'business_operation_documents', 'business_operation_suppliers',
    'business_operation_supplier_history', 'document_suppliers', 'suppliers', 'document_operation_candidates'],
  applicability: 'compte éligible ; Opération du compte, fournisseurs du compte',
  invariant: 'chaque fournisseur ÉTABLI par un document émis membre de l’Opération (lien document → fiche fiable) est relié à l’Opération avec son rôle (prestataire / émetteur d’une pièce), sauf refus de l’utilisateur ; aucun lien automatique sans preuve ; aucun lien actif sur une Opération absorbée ; aucun lien intercomptes',
  anomalies: ['OPERATION_SUPPLIER_MISSING', 'OPERATION_SUPPLIER_UNPROVEN', 'OPERATION_SUPPLIER_OUTDATED', 'INHERITED_LINK_AFTER_MERGE', 'CROSS_ACCOUNT_LINK'],
  autoRepairWhen: 'relation démontrée absente (posée) ; lien automatique sans preuve (retiré) ; rôle / preuve dépassés (mis à jour) ; lien hérité d’une Opération absorbée (décision de l’utilisateur rapatriée, lien automatique retiré)',
  forbiddenRepairs: [
    'recréer un lien refusé ou retiré par l’utilisateur',
    'modifier ou retirer un lien posé par l’utilisateur',
    'déduire un fournisseur d’un nom lu dans un texte ou du même bien',
    'créer un lien direct document → équipement / fournisseur par simple appartenance à l’Opération',
    'réparer un lien intercomptes',
    'appeler l’IA ou relire un document',
  ],
  services: ['relations/operation-suppliers#syncOperationSuppliersForAccount'],
  chain: ['T3', 'PERSISTENCE', 'LINK'],
  triggers: ['DOCUMENT_UPDATED', 'DOCUMENT_DELETED', 'SOURCE_ANALYZED'],
  frequency: 'campagne exhaustive quotidienne (reprise historique du stock) + contrôle ciblé à la modification ou l’analyse d’un document',
  criticality: 'MEDIUM',
  tests: ['L109A-U-PLAN', 'L109A-E2E-COH'],
  immediateSupervision: ['CROSS_ACCOUNT_LINK'],

  async listObjects(ctx, accountId, afterId, limit) {
    const [t] = await rows(ctx.sql, `SELECT ${TABLE_PRETE} AS ok`);
    if (t?.ok !== true) return [];
    return idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE ${OBJETS} AND o.id > $2 ORDER BY o.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    const [t] = await rows(ctx.sql, `SELECT ${TABLE_PRETE} AS ok`);
    if (t?.ok !== true) return [];
    if (e.type !== 'DOCUMENT_UPDATED' && e.type !== 'DOCUMENT_DELETED' && e.type !== 'SOURCE_ANALYZED') return [];
    return idsOf(await rows(ctx.sql, `
      SELECT DISTINCT o.id FROM business_operation_sources s JOIN business_operations o ON o.id = s.operation_id
       WHERE s.account_id = $1 AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = $2::text AND ${OBJETS}
       ORDER BY o.id`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { inspectOperationSuppliers } = await import('@/services/relations/operation-suppliers');
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    const res = await inspectOperationSuppliers(postgresRunner(ctx.sql as never), accountId, intArray(ids));
    for (const id of ids) {
      const x = res.get(id);
      if (!x?.exists) { out.set(id, { verdict: 'GONE' }); continue; }
      if (x.crossAccount.length) {
        out.set(id, { verdict: 'FINDING', anomaly: 'CROSS_ACCOUNT_LINK', faultyLink: 'LINK', expected: 'fournisseurs du seul compte de l’Opération', observed: { suppliers: x.crossAccount }, inputHash: hashOf({ id, cross: x.crossAccount }) });
        continue;
      }
      if (x.inheritedOnMerged.length) {
        out.set(id, {
          verdict: 'REPAIRABLE', anomaly: 'INHERITED_LINK_AFTER_MERGE', faultyLink: 'LINK',
          expected: 'aucun lien actif sur une Opération absorbée (décisions de l’utilisateur rapatriées sur la canonique)',
          observed: { mergedInto: x.mergedInto, suppliers: x.inheritedOnMerged }, inputHash: hashOf({ id, merged: x.mergedInto, s: x.inheritedOnMerged }),
        });
        continue;
      }
      const { add, remove, update, restore, suppressed } = x.plan;
      if (!x.active || (!add.length && !remove.length && !update.length && !restore.length)) {
        out.set(id, { verdict: 'CONSISTENT', ...(suppressed.length ? { detail: { refusedByUser: suppressed.length } } : {}) });
        continue;
      }
      const observed = {
        add: [...add, ...restore].map((a) => ({ supplierId: a.supplierId, role: a.role, files: a.evidence.files })),
        remove: remove.map((r) => ({ supplierId: r.supplierId, role: r.role })),
        update: update.map((u) => ({ supplierId: u.supplierId, role: u.role, files: u.evidence.files })),
      };
      out.set(id, {
        verdict: 'REPAIRABLE',
        anomaly: add.length || restore.length ? 'OPERATION_SUPPLIER_MISSING' : remove.length ? 'OPERATION_SUPPLIER_UNPROVEN' : 'OPERATION_SUPPLIER_OUTDATED',
        faultyLink: 'LINK',
        expected: 'fournisseurs établis par les documents émis de l’Opération, reliés (hors refus de l’utilisateur)',
        observed,
        detail: { add: add.length + restore.length, remove: remove.length, update: update.length, refusedByUser: suppressed.length, linked: x.linked.filter((l) => l.status === 'ACTIVE').length },
        inputHash: hashOf({ id, observed }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { syncOperationSuppliersForAccount } = await import('@/services/relations/operation-suppliers');
    const res = await syncOperationSuppliersForAccount(accountId, items.map((i) => i.id), { correlationId: ctx.correlationId, reasonCode: 'COHERENCE_REPAIR' });
    for (const { id } of items) {
      out.set(id, {
        called: true, service: 'syncOperationSuppliersForAccount', aiCalls: 0, reevaluation: 'TECHNICAL_REBUILD',
        result: { added: res.added, restored: res.restored, removed: res.removed, updated: res.updated, transferred: res.transferred, refusedByUser: res.suppressed },
        rollbackRef: `business_operation_supplier_history:correlation_id=${ctx.correlationId}`,
      });
    }
    return out;
  },
};
