/**
 * Exécution des commandes d'écriture — par les SERVICES MÉTIER existants.
 *
 * Aucune règle métier n'est réécrite ici : création et changement de statut
 * d'une échéance passent par `AgendaWriteService`, exactement comme depuis
 * l'agenda. Seul le contrôle d'appartenance des cibles au compte est refait
 * à l'exécution — une commande préparée il y a quelques minutes ne vaut pas
 * autorisation.
 *
 * « Annuler » (undo.service) : quand `ctx.recordUndo` est fourni, chaque
 * exécuteur décrit, pour une action RÉUSSIE, sa commande inverse et l'état
 * antérieur de sa cible — ou pourquoi elle est irréversible. Cette capture
 * ne fait jamais échouer l'action : en cas d'erreur, l'action est seulement
 * déclarée irréversible.
 */
import { pgClient } from '@/db';
import type { CommandParams, PlannedAction, ActionResult } from './catalog';
import {
  ACHAT_SYNC_REASON, achatSyncWillWrite, agendaVersion, assetVersion, readAgendaSnapshot, readAssetSnapshot,
  type UndoCapture,
} from './undo.service';

export interface ExecutionContext {
  accountId: number;
  userId: number;
  /** Reçoit la description d'annulation de chaque action réussie (undo.service). */
  recordUndo?: (capture: UndoCapture) => void;
}

/** Capture sans risque : une erreur rend l'action irréversible, jamais en échec. */
async function capturer(
  ctx: ExecutionContext,
  actionId: string,
  fn: () => Promise<UndoCapture>,
): Promise<void> {
  if (!ctx.recordUndo) return;
  try {
    ctx.recordUndo(await fn());
  } catch (e) {
    console.warn('[verebona] état antérieur non capturé :', (e as Error).message);
    ctx.recordUndo({ actionId, reversible: false, reason: 'état antérieur non capturé' });
  }
}

/** Lecture avant écriture, sans jamais faire échouer l'action. */
async function avant<T>(ctx: ExecutionContext, fn: () => Promise<T>): Promise<T | null | 'ERREUR'> {
  if (!ctx.recordUndo) return null;
  try { return await fn(); } catch { return 'ERREUR'; }
}

export type Executor = (action: PlannedAction, ctx: ExecutionContext) => Promise<ActionResult>;

async function assetsDuCompte(accountId: number, ids: number[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const rows = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM assets WHERE id = ANY($1::int[]) AND account_id = $2 AND deleted_at IS NULL`,
    [ids, accountId] as never[],
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n === ids.length;
}

const ok = (a: PlannedAction, message: string, id?: number): ActionResult =>
  ({ actionId: a.actionId, status: 'SUCCESS', message, entity: id ? { type: 'agenda_item', id } : null });
const ko = (a: PlannedAction, message: string): ActionResult =>
  ({ actionId: a.actionId, status: 'FAILED', message });

export const EXECUTORS: Record<PlannedAction['command'], Executor> = {
  async CREATE_AGENDA_ITEM(action, ctx) {
    const p = action.params as Extract<CommandParams, { title: string }>;
    if (!(await assetsDuCompte(ctx.accountId, p.assetIds))) return ko(action, 'Bien introuvable dans votre compte.');
    // Échéance « achat » sur un bien sans date d'achat : la date sera
    // recopiée sur la fiche (synchronisation échéance → bien) — irréversible.
    const achat = await avant(ctx, () => achatSyncWillWrite(pgClient, { title: p.title, startDate: p.startDate, assetIds: p.assetIds }));
    const { createAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const item = await createAgendaItem(
      { title: p.title, startDate: p.startDate, assetIds: p.assetIds, originType: 'manual' },
      ctx.accountId,
      ctx.userId,
    );
    await capturer(ctx, action.actionId, async () => {
      if (achat === 'ERREUR') return { actionId: action.actionId, reversible: false, reason: 'état antérieur non capturé' };
      if (achat) return { actionId: action.actionId, reversible: false, reason: ACHAT_SYNC_REASON };
      const apres = await readAgendaSnapshot(pgClient, ctx.accountId, item.id);
      if (!apres) return { actionId: action.actionId, reversible: false, reason: 'échéance créée introuvable' };
      return {
        actionId: action.actionId, reversible: true, command: action.command,
        targetType: 'agenda_item', targetId: item.id, inverseOp: 'DELETE_AGENDA_ITEM',
        before: {}, versionBefore: null, versionAfter: agendaVersion(apres), label: `l’échéance « ${p.title} »`,
      };
    });
    return ok(action, `Échéance « ${p.title} » créée.`, item.id);
  },

  async MARK_AGENDA_DONE(action, ctx) {
    const p = action.params as Extract<CommandParams, { agendaItemId: number }>;
    const etat = await avant(ctx, () => etatStatut(ctx, p.agendaItemId, true));
    const { updateManualStatus } = await import('@/services/agenda/AgendaWriteService');
    const item = await updateManualStatus(p.agendaItemId, 'realise', ctx.accountId);
    await capturer(ctx, action.actionId, () => captureStatut(action, ctx, etat));
    return ok(action, `« ${item.title} » marquée comme réalisée.`, item.id);
  },

  /**
   * Caractéristique d'un bien : par le service de la fiche bien, avec ses
   * contrôles (bien du compte, disponible, section applicable, dates).
   * La valeur actuelle est relue : si elle n'est plus celle présentée à la
   * confirmation, rien n'est écrit — l'utilisateur a validé « A → B », pas
   * « valeur quelconque → B ».
   *
   * CDC 15 T2-38 : une commande confirmée est une écriture HUMAINE — origine
   * USER, auteur et commande journalisés (`writeCanonicalAssetField` via la
   * façade, selon `CANONICAL_WRITE_MODE`). En mode enabled, les colonnes
   * miroirs sont capturées pour que « Annuler » les rétablisse aussi, et la
   * valeur présentée à la confirmation est revérifiée SOUS VERROU.
   */
  async UPDATE_ASSET_FIELD(action, ctx) {
    const p = action.params as Extract<CommandParams, { field: string }>;
    const { loadWritableAsset, updateAssetDetails, AssetDetailsError } =
      await import('@/services/asset-details-write.service');
    const { sqlLookup } = await import('./plan.service');
    const label = action.effects.find((e) => e.startsWith('Champ : '))?.slice(8) ?? p.field;
    const cible = action.targets[0]?.label ?? 'le bien';
    try {
      await loadWritableAsset(p.assetId, ctx.accountId);
      const state = await sqlLookup.getAssetState?.(ctx.accountId, p.assetId);
      const actuelle = state?.characteristics[p.field] ?? null;
      if (String(actuelle ?? '') !== String(p.previous ?? '')) {
        return ko(action, `« ${label} » a été modifié entre-temps : rien n’a été écrit. Refaites votre demande.`);
      }
      const precedent = await avant(ctx, () => readAssetSnapshot(pgClient, ctx.accountId, p.assetId));
      const { canonicalWriteMode } = await import('@/services/canonical/rollout');
      const actif = canonicalWriteMode() === 'enabled';
      const miroirs = !actif ? null : await avant(ctx, async () => {
        const { readMirrorColumns } = await import('@/services/canonical/asset-state/mirror-columns');
        return readMirrorColumns(pgClient, ctx.accountId, p.assetId);
      });
      await updateAssetDetails({
        assetId: p.assetId, accountId: ctx.accountId, section: p.section, fields: { [p.field]: p.value },
        origin: 'USER', actorUserId: ctx.userId,
        ...(actif ? { expectedCurrent: { [p.field]: p.previous ?? null } } : {}),
        source: { type: 'assistant_command', id: action.actionId },
        // Cache de l'assistant : aucune route ne publie ASSET_UPDATED ici.
        emitEvent: true,
      });
      // Commande inverse : rétablir les caractéristiques telles qu'elles
      // étaient (valeur du champ, et ce que l'écriture a pu y ajouter :
      // historique de valorisation, alertes levées).
      await capturer(ctx, action.actionId, async () => {
        const apres = await readAssetSnapshot(pgClient, ctx.accountId, p.assetId);
        if (!precedent || precedent === 'ERREUR' || !apres || miroirs === 'ERREUR') {
          return { actionId: action.actionId, reversible: false, reason: 'état antérieur non capturé' };
        }
        return {
          actionId: action.actionId, reversible: true, command: action.command,
          targetType: 'asset', targetId: p.assetId, inverseOp: 'RESTORE_ASSET_FIELDS',
          before: {
            keyCharacteristics: precedent.keyCharacteristics,
            registrationNumber: precedent.registrationNumber,
            display: action.effects.find((e) => e.startsWith('Valeur actuelle : '))?.slice(18) ?? null,
            ...(miroirs ? { mirrors: miroirs } : {}),
          },
          versionBefore: assetVersion(precedent), versionAfter: assetVersion(apres),
          label: `« ${label} » de ${cible}`,
        };
      });
    } catch (e) {
      if (e instanceof AssetDetailsError) {
        if (e.code === 'CONFLICT') {
          return ko(action, `« ${label} » a été modifié entre-temps : rien n’a été écrit. Refaites votre demande.`);
        }
        if (e.code === 'NOT_FOUND') {
          return { actionId: action.actionId, status: 'REFUSED', message: 'Bien introuvable ou hors de votre compte.' };
        }
        return ko(action, e.message);
      }
      throw e;
    }
    return {
      actionId: action.actionId, status: 'SUCCESS',
      message: `« ${label} » de ${cible} mis à jour.`,
      entity: { type: 'asset', id: p.assetId },
    };
  },

  async CANCEL_AGENDA_ITEM(action, ctx) {
    const p = action.params as Extract<CommandParams, { agendaItemId: number }>;
    const { updateManualStatus } = await import('@/services/agenda/AgendaWriteService');
    const etat = await avant(ctx, () => etatStatut(ctx, p.agendaItemId, false));
    const item = await updateManualStatus(p.agendaItemId, 'annule', ctx.accountId);
    await capturer(ctx, action.actionId, () => captureStatut(action, ctx, etat));
    return ok(action, `« ${item.title} » annulée.`, item.id);
  },
};

/** État d'une échéance avant changement de statut (et synchronisation « achat » à venir). */
async function etatStatut(ctx: ExecutionContext, agendaItemId: number, marquerRealisee: boolean) {
  const snap = await readAgendaSnapshot(pgClient, ctx.accountId, agendaItemId);
  if (!snap) return null;
  // Marquée réalisée, une échéance « achat » recopie sa date sur les biens
  // rattachés sans date d'achat (synchronisation échéance → bien).
  const achat = marquerRealisee
    && await achatSyncWillWrite(pgClient, { title: snap.title, startDate: snap.startDate, agendaItemId });
  return { snap, achat };
}

/** Commande inverse d'un changement de statut : rétablir le statut précédent. */
async function captureStatut(
  action: PlannedAction,
  ctx: ExecutionContext,
  etat: Awaited<ReturnType<typeof etatStatut>> | 'ERREUR',
): Promise<UndoCapture> {
  const p = action.params as Extract<CommandParams, { agendaItemId: number }>;
  if (!etat || etat === 'ERREUR') return { actionId: action.actionId, reversible: false, reason: 'état antérieur non capturé' };
  if (etat.achat) return { actionId: action.actionId, reversible: false, reason: ACHAT_SYNC_REASON };
  const apres = await readAgendaSnapshot(pgClient, ctx.accountId, p.agendaItemId);
  if (!apres) return { actionId: action.actionId, reversible: false, reason: 'échéance introuvable après exécution' };
  return {
    actionId: action.actionId, reversible: true, command: action.command,
    targetType: 'agenda_item', targetId: p.agendaItemId, inverseOp: 'RESTORE_AGENDA_STATUS',
    before: { manualStatus: etat.snap.manualStatus },
    versionBefore: agendaVersion(etat.snap), versionAfter: agendaVersion(apres),
    label: `l’échéance « ${etat.snap.title} »`,
  };
}

/** Exécute une action, sans jamais lever : une erreur devient un résultat FAILED. */
export async function runAction(action: PlannedAction, ctx: ExecutionContext, executors = EXECUTORS): Promise<ActionResult> {
  try {
    return await executors[action.command](action, ctx);
  } catch (e) {
    const msg = (e as Error).message ?? 'Erreur';
    // « Item not found » : l'échéance a disparu ou n'est pas du compte — un
    // refus d'accès, distinct d'une erreur de validation.
    if (msg === 'Item not found') {
      return { actionId: action.actionId, status: 'REFUSED', message: 'Échéance introuvable ou hors de votre compte.' };
    }
    return ko(action, msg);
  }
}
