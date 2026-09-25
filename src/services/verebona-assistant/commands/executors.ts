/**
 * Exécution des commandes d'écriture — par les SERVICES MÉTIER existants.
 *
 * Aucune règle métier n'est réécrite ici : création et changement de statut
 * d'une échéance passent par `AgendaWriteService`, exactement comme depuis
 * l'agenda. Seul le contrôle d'appartenance des cibles au compte est refait
 * à l'exécution — une commande préparée il y a quelques minutes ne vaut pas
 * autorisation.
 */
import { pgClient } from '@/db';
import type { CommandParams, PlannedAction, ActionResult } from './catalog';

export interface ExecutionContext {
  accountId: number;
  userId: number;
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
    const { createAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const item = await createAgendaItem(
      { title: p.title, startDate: p.startDate, assetIds: p.assetIds, originType: 'manual' },
      ctx.accountId,
      ctx.userId,
    );
    return ok(action, `Échéance « ${p.title} » créée.`, item.id);
  },

  async MARK_AGENDA_DONE(action, ctx) {
    const p = action.params as Extract<CommandParams, { agendaItemId: number }>;
    const { updateManualStatus } = await import('@/services/agenda/AgendaWriteService');
    const item = await updateManualStatus(p.agendaItemId, 'realise', ctx.accountId);
    return ok(action, `« ${item.title} » marquée comme réalisée.`, item.id);
  },

  /**
   * Caractéristique d'un bien : par le service de la fiche bien, avec ses
   * contrôles (bien du compte, disponible, section applicable, dates).
   * La valeur actuelle est relue : si elle n'est plus celle présentée à la
   * confirmation, rien n'est écrit — l'utilisateur a validé « A → B », pas
   * « valeur quelconque → B ».
   */
  async UPDATE_ASSET_FIELD(action, ctx) {
    const p = action.params as Extract<CommandParams, { field: string }>;
    const { loadWritableAsset, updateAssetDetails, AssetDetailsError } =
      await import('@/services/assets/asset-details-write.service');
    const { sqlLookup } = await import('./plan.service');
    const label = action.effects.find((e) => e.startsWith('Champ : '))?.slice(8) ?? p.field;
    try {
      await loadWritableAsset(p.assetId, ctx.accountId);
      const state = await sqlLookup.getAssetState?.(ctx.accountId, p.assetId);
      const actuelle = state?.characteristics[p.field] ?? null;
      if (String(actuelle ?? '') !== String(p.previous ?? '')) {
        return ko(action, `« ${label} » a été modifié entre-temps : rien n’a été écrit. Refaites votre demande.`);
      }
      await updateAssetDetails({
        assetId: p.assetId, accountId: ctx.accountId, section: p.section, fields: { [p.field]: p.value },
      });
    } catch (e) {
      if (e instanceof AssetDetailsError) {
        if (e.code === 'NOT_FOUND') {
          return { actionId: action.actionId, status: 'REFUSED', message: 'Bien introuvable ou hors de votre compte.' };
        }
        return ko(action, e.message);
      }
      throw e;
    }
    const cible = action.targets[0]?.label ?? 'le bien';
    return {
      actionId: action.actionId, status: 'SUCCESS',
      message: `« ${label} » de ${cible} mis à jour.`,
      entity: { type: 'asset', id: p.assetId },
    };
  },

  async CANCEL_AGENDA_ITEM(action, ctx) {
    const p = action.params as Extract<CommandParams, { agendaItemId: number }>;
    const { updateManualStatus } = await import('@/services/agenda/AgendaWriteService');
    const item = await updateManualStatus(p.agendaItemId, 'annule', ctx.accountId);
    return ok(action, `« ${item.title} » annulée.`, item.id);
  },
};

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
