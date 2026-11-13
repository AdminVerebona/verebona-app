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
      // Lot 114B (#753, W15) : date facultative ; « Sans échéance » seulement si demandé.
      { title: p.title, startDate: p.startDate ?? null, assetIds: p.assetIds, originType: 'manual', ...(p.noDeadline ? { noDeadline: true } : {}) },
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

  /**
   * Caractéristique d'un bien : par le service de la fiche bien, avec ses
   * contrôles (bien du compte, disponible, section applicable, dates).
   * La valeur actuelle est relue : si elle n'est plus celle présentée à la
   * confirmation, rien n'est écrit — l'utilisateur a validé « A → B », pas
   * « valeur quelconque → B ».
   *
   * CDC 15 T2-38 : une commande confirmée est une écriture HUMAINE — origine
   * USER, auteur et commande journalisés (`writeCanonicalAssetField` via la
   * façade). Les colonnes miroirs sont capturées pour que « Annuler » les
   * rétablisse aussi, et la valeur présentée à la confirmation est
   * revérifiée SOUS VERROU.
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
      // CDC 15 T2-40 : la valeur relue est la valeur CANONIQUE, celle que
      // l'assistant lit et que la fiche affiche.
      const commandes = await import('../canonical/commands');
      const inchangee = commandes.unchangedSinceConfirmation(
        p.previous,
        (await commandes.commandAssetState(ctx.accountId, p.assetId))?.characteristics[p.field] ?? null,
        actuelle,
      );
      if (!inchangee) {
        return ko(action, `« ${label} » a été modifié entre-temps : rien n’a été écrit. Refaites votre demande.`);
      }
      const precedent = await avant(ctx, () => readAssetSnapshot(pgClient, ctx.accountId, p.assetId));
      const miroirs = await avant(ctx, async () => {
        const { readMirrorColumns } = await import('@/services/canonical/asset-state/mirror-columns');
        return readMirrorColumns(pgClient, ctx.accountId, p.assetId);
      });
      await updateAssetDetails({
        assetId: p.assetId, accountId: ctx.accountId, section: p.section, fields: { [p.field]: p.value },
        origin: 'USER', actorUserId: ctx.userId,
        expectedCurrent: { [p.field]: p.previous ?? null },
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

  /**
   * Lot 114B (#753, W01) — création d'un bien par la façade métier (celle de
   * `POST /api/assets`) : quota et droits de l'offre recontrôlés à l'exécution.
   */
  async CREATE_ASSET(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'asset_create' }>;
    const { createAssetForAccount } = await import('@/services/assets/asset-write.facade');
    const r = await createAssetForAccount({ accountId: ctx.accountId, userId: ctx.userId }, {
      category: p.category, name: p.name,
      ...(p.subtype ? { subtype: p.subtype } : {}),
      ...(p.objectCategory ? { objectCategory: p.objectCategory } : {}),
    });
    if (!r.ok) {
      // Refus de droit ou de quota : message de l'offre ; autre refus : jamais un texte technique.
      return refuse(action, r.status === 403 ? r.message : 'Ce bien ne peut pas être créé avec ces informations. Refaites votre demande.');
    }
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'bien créé : il se supprime depuis sa fiche' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Bien « ${r.asset.name} » créé.`, entity: { type: 'asset', id: r.asset.id } };
  },

  /**
   * Lot 114B (#753, W03) — suppression DÉFINITIVE d'un bien et de son contenu,
   * par la façade métier (celle de `DELETE /api/assets`). Le décompte présenté
   * à la confirmation est relu : s'il a changé, rien n'est supprimé.
   */
  async DELETE_ASSET(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'asset_delete' }>;
    const { readAssetDeletionSummary, deleteAssetForAccount } = await import('@/services/assets/asset-write.facade');
    const resume = await readAssetDeletionSummary(ctx.accountId, p.assetId);
    if (!resume) return refuse(action, 'Bien introuvable ou hors de votre compte.');
    const change = Object.keys(p.expectedSummary).some((k) => Number((resume as unknown as Record<string, number>)[k] ?? 0) !== p.expectedSummary[k]);
    if (change) return ko(action, `Le contenu de « ${resume.name} » a changé depuis l’aperçu : rien n’a été supprimé. Refaites votre demande.`);
    const [bien] = (await pgClient.unsafe(
      `SELECT id, thumbnail_url AS "thumbnailUrl" FROM assets WHERE id = $1 AND account_id = $2`,
      [p.assetId, ctx.accountId] as never[],
    )) as unknown as Array<{ id: number; thumbnailUrl: string | null }>;
    if (!bien) return refuse(action, 'Bien introuvable ou hors de votre compte.');
    await deleteAssetForAccount({ accountId: ctx.accountId, userId: ctx.userId }, bien);
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'suppression définitive d’un bien' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Bien « ${resume.name} » supprimé définitivement, avec tout son contenu.`, entity: null };
  },

  /**
   * Lot 114B (#753, W16) — titre et/ou date d'une échéance, par le service de
   * l'Agenda (mêmes validations que son tiroir). L'état présenté à la
   * confirmation est recontrôlé : modifié entre-temps, rien n'est écrit.
   */
  async UPDATE_AGENDA_ITEM(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'agenda_update' }>;
    const avantEcriture = await readAgendaSnapshot(pgClient, ctx.accountId, p.agendaItemId);
    if (!avantEcriture) return refuse(action, 'Échéance introuvable ou hors de votre compte.');
    if (agendaVersion(avantEcriture) !== p.expectedVersion) return ko(action, CHANGED_SINCE_PREVIEW);
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const item = await updateAgendaItem(p.agendaItemId, {
      ...(p.patch.title !== undefined ? { title: p.patch.title } : {}),
      ...(p.patch.startDate !== undefined ? { startDate: p.patch.startDate } : {}),
    }, ctx.accountId, ctx.userId);
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'modification d’une échéance : à corriger depuis l’Agenda ou par une nouvelle demande' });
    await publier([{ type: 'AGENDA_ITEM_UPDATED', accountId: ctx.accountId, entityId: item.id }]);
    return ok(action, `Échéance « ${item.title} » modifiée.`, item.id);
  },

  /**
   * Lot 114B (#753, W17) — suppression par le service de l'Agenda : cette
   * échéance, ou toute la série si elle a été annoncée. La portée et le nombre
   * d'échéances ne changent pas entre l'aperçu et l'exécution.
   */
  async DELETE_AGENDA_ITEM(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'agenda_delete' }>;
    const avantEcriture = await readAgendaSnapshot(pgClient, ctx.accountId, p.agendaItemId);
    if (!avantEcriture) return refuse(action, 'Échéance introuvable ou hors de votre compte.');
    if (agendaVersion(avantEcriture) !== p.expectedVersion) return ko(action, CHANGED_SINCE_PREVIEW);
    if (p.scope === 'SERIES') {
      const [{ n }] = (await pgClient.unsafe(
        `SELECT count(*)::int AS n FROM agenda_items s
          WHERE s.account_id = $2 AND s.series_key = (SELECT series_key FROM agenda_items WHERE id = $1 AND account_id = $2)`,
        [p.agendaItemId, ctx.accountId] as never[],
      )) as unknown as Array<{ n: number }>;
      if (n !== p.expectedCount) {
        return ko(action, `La série ne compte plus ${p.expectedCount} échéances (${n} aujourd’hui) : rien n’a été supprimé. Refaites votre demande.`);
      }
    }
    const { deleteAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const { deletedIds } = await deleteAgendaItem(p.agendaItemId, ctx.accountId, ctx.userId, { scope: p.scope });
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'suppression définitive d’une échéance' });
    await publier(deletedIds.map((entityId) => ({ type: 'AGENDA_ITEM_DELETED' as const, accountId: ctx.accountId, entityId })));
    return {
      actionId: action.actionId, status: 'SUCCESS',
      message: deletedIds.length > 1 ? `Série « ${avantEcriture.title} » supprimée : ${deletedIds.length} échéances.` : `Échéance « ${avantEcriture.title} » supprimée.`,
      // L'identifiant supprimé est rendu pour que l'Agenda ouvert sous l'assistant se remette à jour.
      entity: { type: 'agenda_item', id: p.agendaItemId },
    };
  },
};

// Lot 113P (#715) : plus de commande de STATUT d'échéance (réalisée / annulée) ni d'inverse associé.

const CHANGED_SINCE_PREVIEW = 'Cette échéance a été modifiée depuis l’aperçu : rien n’a été fait. Refaites votre demande.';
const refuse = (a: PlannedAction, message: string): ActionResult => ({ actionId: a.actionId, status: 'REFUSED', message });
/** Événement métier après une écriture réussie (caches de l'assistant) — jamais bloquant. */
async function publier(events: Array<{ type: 'AGENDA_ITEM_UPDATED' | 'AGENDA_ITEM_DELETED'; accountId: number; entityId: number }>): Promise<void> {
  try {
    const { emitBusinessEvents } = await import('../events/business-events');
    await emitBusinessEvents(events as never);
  } catch (e) {
    console.warn('[verebona] événement métier non publié :', (e as Error).message);
  }
}

/** Exécute une action, sans jamais lever : une erreur devient un résultat FAILED. */
/** #715 (lot 113P) : commande d'un plan ancien retirée (statut d'échéance) — refusée, rien n'est écrit. */
export const RETIRED_COMMAND_MESSAGE = 'Cette action n’existe plus : modifiez la date ou supprimez l’événement depuis l’Agenda.';

export async function runAction(action: PlannedAction, ctx: ExecutionContext, executors: Partial<Record<PlannedAction['command'], Executor>> = EXECUTORS): Promise<ActionResult> {
  const executer = executors[action.command];
  if (typeof executer !== 'function') {
    return { actionId: action.actionId, status: 'REFUSED', message: RETIRED_COMMAND_MESSAGE };
  }
  try {
    return await executer(action, ctx);
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
