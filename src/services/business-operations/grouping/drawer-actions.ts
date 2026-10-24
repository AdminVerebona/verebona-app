/**
 * Gestes du TIROIR d'un élément d'agenda (lot 84B, CDC v5 O-3 : §8, §11.9,
 * §14.2 ; AC01, AC02, AC07, AC27, AC32) — traduction d'un geste utilisateur
 * en appel du SERVICE UNIQUE de regroupement, dans une écriture Opération du
 * compte (`withGroupingWrite` : transaction, verrou 39101, événements après
 * commit, auteur tracé). Aucune écriture SQL ici ; aucune décision
 * sémantique : chaque geste est une décision de l'utilisateur, mémorisée par
 * le service (§10).
 *
 * L'élément du tiroir est relu DANS le compte (un identifiant étranger rend
 * `ITEM_NOT_FOUND` / `CROSS_ACCOUNT`, rien n'est écrit).
 */
import type { GroupingAction } from '@/lib/agenda/grouping-view';
import {
  GroupingError, attachAsset, attachEquipment, attachRoom, designatePrincipal, detachAgendaItem, detachAsset, detachDocumentFromAgendaGroup, detachDocumentFromAgendaItem,
  detachEquipment, detachRoom, linkAgendaItems, linkDocumentToAgendaItem, releasePrincipal, withGroupingWrite, type GroupingContext,
} from './service';

export interface DrawerActionResult { action: GroupingAction; changed: boolean; operationId: number | null; detail?: string }

const R = (a: GroupingAction) => `USER_DRAWER_${a.toUpperCase().replace(/-/g, '_')}`;

async function groupOf(ctx: GroupingContext, itemId: number): Promise<{ op: number | null; role: string | null }> {
  const [i] = await ctx.runner.q<{ op: string | null; role: string | null; account_id: number; active: boolean | null }>(
    `SELECT i.business_operation_id AS op, i.operation_role AS role, i.account_id,
            (o.id IS NOT NULL AND o.account_id = i.account_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS active
       FROM agenda_items i LEFT JOIN business_operations o ON o.id = i.business_operation_id WHERE i.id = $1`, [itemId]);
  if (!i) throw new GroupingError('ITEM_NOT_FOUND', `Élément d'agenda ${itemId} introuvable.`);
  if (Number(i.account_id) !== ctx.accountId) throw new GroupingError('CROSS_ACCOUNT', `Élément d'agenda ${itemId} d'un autre compte.`);
  return { op: i.op !== null && i.active ? Number(i.op) : null, role: i.role };
}

function requireGroup(g: { op: number | null }, itemId: number): number {
  if (g.op === null) throw new GroupingError('NOT_GROUPED', `Élément d'agenda ${itemId} sans regroupement actif.`);
  return g.op;
}

/** Applique un geste du tiroir de l'élément `itemId` (cible `targetId` selon le geste). */
export async function applyAgendaDrawerAction(
  p: { accountId: number; actorUserId: number | null; itemId: number; action: GroupingAction; targetId: number | null },
): Promise<DrawerActionResult> {
  const { accountId, actorUserId, itemId, action } = p;
  const target = () => {
    if (p.targetId === null || !Number.isSafeInteger(p.targetId) || p.targetId <= 0) throw new GroupingError('ITEM_NOT_FOUND', 'Cible du geste absente.');
    return p.targetId;
  };
  return withGroupingWrite(accountId, async (ctx) => {
    const g = await groupOf(ctx, itemId);
    const reasonCode = R(action);
    switch (action) {
      case 'relier-element': {
        const r = await linkAgendaItems(ctx, { itemA: itemId, itemB: target(), reasonCode });
        return { action, changed: r.case !== 'NOOP', operationId: r.operationId, detail: r.case };
      }
      case 'retirer-element': {
        // Depuis le tiroir de l'ensemble : l'élément ciblé doit en faire partie.
        const op = requireGroup(g, itemId);
        const r = await detachAgendaItem(ctx, { itemId: target(), operationId: op, origin: 'USER', reasonCode });
        return { action, changed: r.changed, operationId: op };
      }
      case 'quitter-ensemble': {
        const op = requireGroup(g, itemId);
        const r = await detachAgendaItem(ctx, { itemId, operationId: op, origin: 'USER', reasonCode });
        return { action, changed: r.changed, operationId: op };
      }
      case 'relier-document': {
        const r = await linkDocumentToAgendaItem(ctx, { itemId, fileId: target(), reasonCode });
        return { action, changed: true, operationId: r.operationId, detail: r.case };
      }
      case 'detacher-document': {
        // Lot 86D : détachement INDIVIDUEL du lien (élément ↔ document) ; le document reste dans l'ensemble.
        const r = await detachDocumentFromAgendaItem(ctx, { itemId, fileId: target(), reasonCode });
        return { action, changed: r.removed, operationId: r.operationId };
      }
      case 'retirer-document': {
        const r = await detachDocumentFromAgendaGroup(ctx, { itemId, fileId: target(), reasonCode });
        return { action, changed: true, operationId: r.operationId };
      }
      case 'relier-bien': {
        const op = requireGroup(g, itemId);
        return { action, changed: await attachAsset(ctx, { operationId: op, assetId: target(), origin: 'USER', reasonCode }), operationId: op };
      }
      case 'retirer-bien': {
        const op = requireGroup(g, itemId);
        return { action, changed: await detachAsset(ctx, { operationId: op, assetId: target(), origin: 'USER', reasonCode }), operationId: op };
      }
      case 'relier-piece': {
        const op = requireGroup(g, itemId);
        return { action, changed: (await attachRoom(ctx, { operationId: op, substructureId: target(), origin: 'USER', reasonCode })).changed, operationId: op };
      }
      case 'retirer-piece': {
        const op = requireGroup(g, itemId);
        return { action, changed: await detachRoom(ctx, { operationId: op, substructureId: target(), origin: 'USER', reasonCode }), operationId: op };
      }
      case 'relier-equipement': {
        const op = requireGroup(g, itemId);
        return { action, changed: (await attachEquipment(ctx, { operationId: op, equipmentId: target(), origin: 'USER', reasonCode })).changed, operationId: op };
      }
      case 'retirer-equipement': {
        const op = requireGroup(g, itemId);
        return { action, changed: await detachEquipment(ctx, { operationId: op, equipmentId: target(), origin: 'USER', reasonCode }), operationId: op };
      }
      case 'designer-reference': {
        const op = requireGroup(g, itemId);
        const r = await designatePrincipal(ctx, { operationId: op, itemId, origin: 'USER', reasonCode });
        return { action, changed: r.changed, operationId: op };
      }
      case 'retirer-reference': {
        const op = requireGroup(g, itemId);
        return { action, changed: await releasePrincipal(ctx, { operationId: op, itemId, origin: 'USER', reasonCode }), operationId: op };
      }
    }
  }, { actorUserId });
}
