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
    return ecrireChampDeBien(action, ctx, p);
  },

  /**
   * Lot 114F (#753, W27) — effacement volontaire d'une caractéristique : MÊME écriture que la modification
   * (service de la fiche, origine USER, valeur présentée revérifiée sous verrou, colonnes miroirs), avec la
   * valeur `null` — le marqueur d'effacement de l'utilisateur est celui du formulaire. Annulable 15 minutes,
   * comme une modification (les caractéristiques d'avant sont rétablies).
   */
  async CLEAR_ASSET_FIELD(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'asset_field_clear' }>;
    return ecrireChampDeBien(action, ctx, { assetId: p.clearAssetId, section: p.clearSection, field: p.clearedField, value: null, previous: p.clearedPrevious });
  },

  /**
   * Lot 114F (#753, W02) — nom d'un bien, par le service de la fiche (`updateAssetDetails`, section commune),
   * comme `PATCH /api/assets/[id]/details/common` : bien du compte, disponible, non suspendu par le quota. Le nom
   * présenté à la confirmation est relu, puis revérifié SOUS VERROU par le service (`expectedCurrent.name`).
   */
  async RENAME_ASSET(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'asset_rename' }>;
    const { updateAssetDetails, AssetDetailsError } = await import('@/services/asset-details-write.service');
    const { sqlLookup } = await import('./plan.service');
    const change = `Le nom de ce bien a changé depuis l’aperçu : rien n’a été écrit. Refaites votre demande.`;
    try {
      const etat = await sqlLookup.getAssetState!(ctx.accountId, p.renamedAssetId);
      if (!etat) return refuse(action, 'Bien introuvable ou hors de votre compte.');
      if (etat.name !== p.expectedName) return ko(action, change);
      await updateAssetDetails({
        assetId: p.renamedAssetId, accountId: ctx.accountId, section: 'common', fields: { name: p.assetNewName },
        origin: 'USER', actorUserId: ctx.userId, expectedCurrent: { name: p.expectedName },
        source: { type: 'assistant_command', id: action.actionId },
        // Cache de l'assistant : aucune route ne publie ASSET_UPDATED ici.
        emitEvent: true,
      });
    } catch (e) {
      if (e instanceof AssetDetailsError) {
        if (e.code === 'CONFLICT') return ko(action, change);
        if (e.code === 'NOT_FOUND') return refuse(action, 'Bien introuvable ou hors de votre compte.');
        // Bien archivé, verrouillé par l'offre, modification suspendue (quota) : refus du service, tel quel.
        if (e.code === 'ASSET_UNAVAILABLE' || e.code === 'WRITE_BLOCKED') return refuse(action, e.message);
        return ko(action, 'Ce nom ne peut pas être enregistré tel quel : rien n’a été modifié.');
      }
      throw e;
    }
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'bien renommé : à corriger par une nouvelle demande' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Bien « ${p.expectedName} » renommé en « ${p.assetNewName} ».`, entity: { type: 'asset', id: p.renamedAssetId } };
  },

  /**
   * Lot 114F (#753, W13) — biens d'un document, par la façade métier (celle de `PUT /api/documents/[id]`) : le
   * corps envoyé est celui du tiroir (nom et date actuels repris, liste complète des biens). L'état présenté —
   * document et biens rattachés — est recontrôlé ; la façade valide les biens pour le compte (anti-énumération,
   * bien verrouillé), écrit les liens dans une transaction, journalise et publie `DOCUMENT_UPDATED`.
   */
  async UPDATE_DOCUMENT_TARGETS(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'document_targets' }>;
    const { sqlLookup, documentTargetsVersion } = await import('./plan.service');
    const etat = await sqlLookup.getDocumentState!(ctx.accountId, p.documentId);
    const cibles = etat ? await sqlLookup.getDocumentAssetTargets!(ctx.accountId, p.documentId) : null;
    if (!etat || !cibles) return refuse(action, 'Document introuvable ou hors de votre compte.');
    if (documentTargetsVersion(etat.version, cibles.chosen.map((a) => a.id)) !== p.expectedVersion) return ko(action, DOCUMENT_CHANGED_SINCE_PREVIEW);
    const body: Record<string, unknown> = { fileName: etat.originalFilename || etat.title, documentDate: etat.documentDate, assetIds: p.targetAssetIds };
    const { updateDocumentForAccount } = await import('@/services/documents/document-write.facade');
    const res = await updateDocumentForAccount({ userId: ctx.userId, currentAccountId: ctx.accountId }, p.documentId, body);
    if (res.status === 404) return refuse(action, 'Document ou bien introuvable dans votre compte : rien n’a été modifié.');
    if (res.status === 409) return refuse(action, 'Ce bien ne peut pas recevoir de nouveau document pour le moment : rien n’a été modifié.');
    if (res.status !== 200) return ko(action, 'Ce rattachement ne peut pas être enregistré tel quel : rien n’a été modifié.');
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'rattachement d’un document : à corriger depuis le document ou par une nouvelle demande' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Rattachements du document « ${etat.title} » mis à jour.`, entity: { type: 'document', id: p.documentId } };
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
   * Lot 114 (#753, W07) — pièce créée par la façade métier (celle de `POST /api/assets/[id]/substructures`), après
   * les mêmes contrôles : bien du compte, type de bien compatible, quota, offre Premium — revérifiés à l'exécution.
   */
  async CREATE_ROOM(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'room_create' }>;
    const refus = await refusStructure(ctx.accountId, p.roomAssetId, 'room');
    if (refus) return refuse(action, refus);
    const { createRoomForAccount } = await import('@/services/assets/structure-write.facade');
    const cree = await createRoomForAccount(ctx.accountId, p.roomAssetId, p.roomName);
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'pièce créée : elle se supprime depuis le bien' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Pièce « ${cree.name} » créée.`, entity: { type: 'room', id: Number(cree.id) } };
  },

  /** Lot 114 (#753, W08) — pièce renommée par la façade métier (celle de `PUT …/substructures/[subId]`). */
  async RENAME_ROOM(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'room_rename' }>;
    const { sqlLookup } = await import('./plan.service');
    const etat = await sqlLookup.getRoomState!(ctx.accountId, p.roomId);
    if (!etat || etat.assetId !== p.roomAssetId) return refuse(action, 'Pièce introuvable ou hors de votre compte.');
    if (etat.version !== p.expectedVersion) return ko(action, STRUCTURE_CHANGED_SINCE_PREVIEW);
    const { renameRoomForAccount } = await import('@/services/assets/structure-write.facade');
    const row = await renameRoomForAccount(ctx.accountId, etat.assetId, p.roomId, p.roomName);
    if (!row) return refuse(action, 'Pièce introuvable ou hors de votre compte.');
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'pièce renommée : à corriger depuis le bien ou par une nouvelle demande' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Pièce « ${etat.name} » renommée en « ${row.name} ».`, entity: { type: 'room', id: p.roomId } };
  },

  /**
   * Lot 114 (#753, W09) — pièce supprimée par la façade métier (celle de `DELETE …/substructures/[subId]`). Ce qui
   * y était rattaché reste dans le bien ; le décompte présenté est recontrôlé.
   */
  async DELETE_ROOM(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'room_delete' }>;
    const { sqlLookup } = await import('./plan.service');
    const etat = await sqlLookup.getRoomState!(ctx.accountId, p.roomId);
    if (!etat || etat.assetId !== p.roomAssetId) return refuse(action, 'Pièce introuvable ou hors de votre compte.');
    if (etat.version !== p.expectedVersion) return ko(action, STRUCTURE_CHANGED_SINCE_PREVIEW);
    const { deleteRoomForAccount } = await import('@/services/assets/structure-write.facade');
    if (!(await deleteRoomForAccount(ctx.accountId, etat.assetId, p.roomId))) return refuse(action, 'Pièce introuvable ou hors de votre compte.');
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'suppression définitive d’une pièce' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Pièce « ${etat.name} » supprimée.`, entity: { type: 'room', id: p.roomId } };
  },

  /**
   * Lot 114 (#753, W04) — équipement créé par la façade métier (celle de `POST /api/assets/[id]/equipments`), après
   * les mêmes contrôles d'accès et d'offre, revérifiés à l'exécution.
   */
  async CREATE_EQUIPMENT(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'equipment_create' }>;
    const refus = await refusStructure(ctx.accountId, p.equipmentAssetId, 'equipment');
    if (refus) return refuse(action, refus);
    const { createEquipmentForAccount } = await import('@/services/assets/structure-write.facade');
    const res = await createEquipmentForAccount({ userId: ctx.userId, currentAccountId: ctx.accountId }, p.equipmentAssetId,
      { name: p.equipmentName, ...(p.equipmentRoomId ? { substructureId: p.equipmentRoomId } : {}) });
    if (res.status !== 201) return ko(action, 'Cet équipement ne peut pas être créé avec ces informations : rien n’a été créé.');
    const cree = await res.json() as { id: number; name: string };
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'équipement créé : il se retire depuis le bien' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Équipement « ${cree.name} » créé.`, entity: { type: 'equipment', id: Number(cree.id) } };
  },

  /** Lot 114 (#753, W05) — équipement renommé par la façade métier (celle de `PUT …/equipments/[equipId]`). */
  async RENAME_EQUIPMENT(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'equipment_rename' }>;
    const { sqlLookup } = await import('./plan.service');
    const etat = await sqlLookup.getEquipmentState!(ctx.accountId, p.equipmentId);
    if (!etat || etat.assetId !== p.equipmentAssetId) return refuse(action, 'Équipement introuvable ou hors de votre compte.');
    if (etat.version !== p.expectedVersion) return ko(action, STRUCTURE_CHANGED_SINCE_PREVIEW);
    // Même garde que la route : modification suspendue au-dessus du quota de biens (GAP-11).
    const { refuserSiModificationBiensSuspendue } = await import('@/lib/asset-quota-guard');
    const suspendu = await refuserSiModificationBiensSuspendue(ctx.accountId);
    if (suspendu) return refuse(action, ((await suspendu.json().catch(() => ({}))) as { message?: string }).message ?? 'Modification non autorisée.');
    const { updateEquipmentForAccount } = await import('@/services/assets/structure-write.facade');
    const res = await updateEquipmentForAccount({ userId: ctx.userId, currentAccountId: ctx.accountId }, etat.assetId, p.equipmentId, { name: p.equipmentName });
    if (res.status === 404) return refuse(action, 'Équipement introuvable ou hors de votre compte.');
    if (res.status !== 200) return ko(action, 'Ce nom ne peut pas être enregistré tel quel : rien n’a été modifié.');
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'équipement renommé : à corriger depuis le bien ou par une nouvelle demande' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Équipement « ${etat.name} » renommé en « ${p.equipmentName} ».`, entity: { type: 'equipment', id: p.equipmentId } };
  },

  /** Lot 114 (#753, W06) — équipement retiré = ARCHIVÉ, par la façade métier (celle de `DELETE …/equipments/[equipId]`). */
  async ARCHIVE_EQUIPMENT(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'equipment_archive' }>;
    const { sqlLookup } = await import('./plan.service');
    const etat = await sqlLookup.getEquipmentState!(ctx.accountId, p.equipmentId);
    if (!etat || etat.assetId !== p.equipmentAssetId) return refuse(action, 'Équipement introuvable ou hors de votre compte.');
    if (etat.version !== p.expectedVersion) return ko(action, STRUCTURE_CHANGED_SINCE_PREVIEW);
    const { archiveEquipmentForAccount } = await import('@/services/assets/structure-write.facade');
    if (!(await archiveEquipmentForAccount(ctx.accountId, etat.assetId, p.equipmentId))) return refuse(action, 'Équipement introuvable ou hors de votre compte.');
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'équipement archivé' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Équipement « ${etat.name} » retiré de ${etat.assetName}. Ses documents et ses échéances sont conservés.`, entity: { type: 'equipment', id: p.equipmentId } };
  },

  /**
   * Lot 114 (#753, W10) — lien web, par la façade métier (celle de `POST /api/web-links`) : mêmes contrôles
   * (adresse http(s), titre, bien du compte). Le lien est enregistré tel quel, la page n'est jamais lue.
   */
  async CREATE_WEB_DOCUMENT(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'document_web_create' }>;
    const { createWebDocumentForAccount } = await import('@/services/documents/document-write.facade');
    const r = await createWebDocumentForAccount({ userId: ctx.userId, currentAccountId: ctx.accountId }, { url: p.url, title: p.linkTitle, assetId: p.linkAssetId });
    if (!r.ok) return r.error === 'ASSET_NOT_FOUND' ? refuse(action, 'Bien introuvable ou hors de votre compte.') : ko(action, 'Ce lien ne peut pas être enregistré avec ces informations : rien n’a été créé.');
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'lien créé : il se supprime depuis vos documents' });
    // Événement existant d'un document ajouté au compte (caches de l'Assistant) — la route ne l'émet pas.
    await publier([{ type: 'DOCUMENT_UPLOADED', accountId: ctx.accountId, entityId: r.webLink.id }]);
    return { actionId: action.actionId, status: 'SUCCESS', message: `Lien « ${p.linkTitle} » ajouté à vos documents.`, entity: { type: 'document', id: r.webLink.id } };
  },

  /**
   * Lot 114 (#753, W12) — titre, date ou note d'un document, par la façade métier (celle de
   * `PUT /api/documents/[id]`) : le corps envoyé est celui du tiroir du document (nom et date actuels repris,
   * seul le champ demandé change). L'état présenté à la confirmation est recontrôlé.
   */
  async UPDATE_DOCUMENT(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'document_update' }>;
    const { sqlLookup } = await import('./plan.service');
    const etat = await sqlLookup.getDocumentState!(ctx.accountId, p.documentId);
    if (!etat) return refuse(action, 'Document introuvable ou hors de votre compte.');
    if (etat.version !== p.expectedVersion) return ko(action, DOCUMENT_CHANGED_SINCE_PREVIEW);
    // Nom de fichier et date ACTUELS repris : la route attend l'état complet (une date absente serait effacée).
    const body: Record<string, unknown> = { fileName: etat.originalFilename || etat.title, documentDate: etat.documentDate };
    if (p.documentField === 'date') body.documentDate = p.newValue;
    if (p.documentField === 'notes') body.notesDescription = p.newValue ?? '';
    if (p.documentField === 'title') {
      // Lien web : son titre est son nom ; fichier : titre retenu de l'utilisateur, nom d'origine conservé.
      if (etat.isWebLink) { body.fileName = p.newValue; body.webLinkUrl = etat.webLinkUrl ?? ''; }
      else body.retainedTitle = p.newValue;
    }
    const { updateDocumentForAccount } = await import('@/services/documents/document-write.facade');
    const res = await updateDocumentForAccount({ userId: ctx.userId, currentAccountId: ctx.accountId }, p.documentId, body);
    if (res.status === 404) return refuse(action, 'Document introuvable ou hors de votre compte.');
    if (res.status !== 200) return ko(action, 'Cette modification ne peut pas être enregistrée telle quelle : rien n’a été modifié.');
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'modification d’un document : à corriger depuis le document ou par une nouvelle demande' });
    const titre = p.documentField === 'title' && p.newValue ? p.newValue : etat.title;
    return { actionId: action.actionId, status: 'SUCCESS', message: `Document « ${titre} » modifié.`, entity: { type: 'document', id: p.documentId } };
  },

  /**
   * Lot 114 (#753, W14) — suppression logique d'un document, par la façade métier (celle de
   * `DELETE /api/files/[id]`) : événement, preuves retirées, fiches concernées réconciliées.
   */
  async DELETE_DOCUMENT(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'document_delete' }>;
    const { sqlLookup } = await import('./plan.service');
    const etat = await sqlLookup.getDocumentState!(ctx.accountId, p.documentId);
    if (!etat) return refuse(action, 'Document introuvable ou hors de votre compte.');
    if (etat.version !== p.expectedVersion) return ko(action, DOCUMENT_CHANGED_SINCE_PREVIEW);
    const { softDeleteDocument } = await import('@/services/documents/document-write.facade');
    await softDeleteDocument({ fileId: p.documentId, fileAccountId: ctx.accountId, userId: ctx.userId });
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'suppression d’un document' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Document « ${etat.title} » supprimé.`, entity: { type: 'document', id: p.documentId } };
  },

  /**
   * Lot 114 (#753, W18) — création par la façade métier (celle de `POST /api/suppliers`). Le doublon est
   * recontrôlé : une fiche devenue CERTAINE entre l'aperçu et la confirmation n'est jamais doublée ; les fiches
   * proches annoncées sont mémorisées comme DISTINCTES (décision de l'utilisateur, lot 113G).
   */
  async CREATE_SUPPLIER(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'supplier_create' }>;
    const { sqlLookup } = await import('./plan.service');
    const doublon = await sqlLookup.supplierDuplicates!(ctx.accountId, p.name);
    if (doublon.decision === 'certain' && doublon.candidates[0]) {
      return refuse(action, `Le fournisseur « ${doublon.candidates[0].name} » existe déjà dans votre compte : rien n’a été créé.`);
    }
    const proches = doublon.decision === 'uncertain' ? doublon.candidates.map((c) => c.id) : [];
    if (proches.some((id) => !p.distinctFrom.includes(id))) {
      return ko(action, 'Un fournisseur proche est apparu depuis l’aperçu : rien n’a été créé. Refaites votre demande.');
    }
    const { createSupplierForAccount } = await import('@/services/suppliers/supplier-write.facade');
    const cree = await createSupplierForAccount({
      accountId: ctx.accountId, userId: ctx.userId,
      input: { name: p.name, phone: p.phone, email: p.email, website: p.website, source: 'manual' },
      confirmedDistinctFrom: p.distinctFrom,
    });
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'fournisseur créé : il s’archive depuis sa fiche' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Fournisseur « ${cree.name} » créé.`, entity: { type: 'supplier', id: cree.id } };
  },

  /**
   * Lot 114 (#753, W19) — une coordonnée d'une fiche, par la façade métier (celle de `PATCH /api/suppliers/[id]`) :
   * même validation, même protection par champ (SET / CLEARED). L'état présenté est recontrôlé.
   */
  async UPDATE_SUPPLIER(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'supplier_update' }>;
    const { sqlLookup } = await import('./plan.service');
    const etat = await sqlLookup.getSupplierState!(ctx.accountId, p.supplierId);
    if (!etat) return refuse(action, 'Fournisseur introuvable ou hors de votre compte.');
    if (etat.version !== p.expectedVersion) return ko(action, SUPPLIER_CHANGED_SINCE_PREVIEW);
    const { updateSupplierForAccount } = await import('@/services/suppliers/supplier-write.facade');
    // Une chaîne vide efface la valeur : même convention que le formulaire de la fiche.
    const body = Object.fromEntries(Object.entries(p.patch).map(([k, v]) => [k, v ?? '']));
    const r = await updateSupplierForAccount({ accountId: ctx.accountId, userId: ctx.userId, supplierId: p.supplierId, body });
    if (!r.ok) return r.code === 'NOT_FOUND' ? refuse(action, 'Fournisseur introuvable ou hors de votre compte.') : ko(action, 'Cette valeur ne peut pas être enregistrée telle quelle : rien n’a été modifié.');
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'modification d’un fournisseur : à corriger depuis sa fiche ou par une nouvelle demande' });
    const nom = typeof p.patch.name === 'string' ? p.patch.name : etat.name;
    return { actionId: action.actionId, status: 'SUCCESS', message: `Fournisseur « ${nom} » modifié.`, entity: { type: 'supplier', id: p.supplierId } };
  },

  /**
   * Lot 114 (#753, W20) — retrait d'un fournisseur = ARCHIVAGE, par la façade métier (celle de
   * `POST /api/suppliers/[id]/archive`) : aucune suppression, relations conservées, fiche réactivable.
   */
  async ARCHIVE_SUPPLIER(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'supplier_archive' }>;
    const { sqlLookup } = await import('./plan.service');
    const etat = await sqlLookup.getSupplierState!(ctx.accountId, p.supplierId);
    if (!etat) return refuse(action, 'Fournisseur introuvable ou hors de votre compte.');
    if (etat.version !== p.expectedVersion) return ko(action, SUPPLIER_CHANGED_SINCE_PREVIEW);
    const { setSupplierArchived } = await import('@/services/suppliers/supplier-write.facade');
    const r = await setSupplierArchived({ accountId: ctx.accountId, supplierId: p.supplierId });
    if (!r.ok) return refuse(action, 'Fournisseur introuvable ou hors de votre compte.');
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'fournisseur archivé : il se réactive depuis sa fiche' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Fournisseur « ${etat.name} » archivé. Ses documents et ses liens sont conservés.`, entity: { type: 'supplier', id: p.supplierId } };
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

/**
 * Écriture d'UNE caractéristique d'un bien (modification, ou effacement quand `value` est `null`) — corps commun
 * de UPDATE_ASSET_FIELD et de CLEAR_ASSET_FIELD (lot 114F : extrait tel quel de UPDATE_ASSET_FIELD).
 */
async function ecrireChampDeBien(
  action: PlannedAction, ctx: ExecutionContext,
  p: { assetId: number; section: string; field: string; value: string | number | null; previous: unknown },
): Promise<ActionResult> {
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
    message: p.value === null ? `« ${label} » de ${cible} effacé.` : `« ${label} » de ${cible} mis à jour.`,
    entity: { type: 'asset', id: p.assetId },
  };
}

const STRUCTURE_CHANGED_SINCE_PREVIEW = 'Cet élément a été modifié depuis l’aperçu : rien n’a été fait. Refaites votre demande.';
/** Création d'une pièce ou d'un équipement : bien du compte et contrôles d'offre de la façade métier, relus à l'exécution. */
async function refusStructure(accountId: number, assetId: number, kind: 'room' | 'equipment'): Promise<string | null> {
  const { sqlLookup } = await import('./plan.service');
  const nature = await sqlLookup.getAssetKind!(accountId, assetId);
  if (!nature) return 'Bien introuvable ou hors de votre compte.';
  return sqlLookup.structureRefusal!(accountId, nature, kind);
}
const DOCUMENT_CHANGED_SINCE_PREVIEW = 'Ce document a été modifié depuis l’aperçu : rien n’a été fait. Refaites votre demande.';
const SUPPLIER_CHANGED_SINCE_PREVIEW = 'Ce fournisseur a été modifié depuis l’aperçu : rien n’a été fait. Refaites votre demande.';
const CHANGED_SINCE_PREVIEW = 'Cette échéance a été modifiée depuis l’aperçu : rien n’a été fait. Refaites votre demande.';
const refuse = (a: PlannedAction, message: string): ActionResult => ({ actionId: a.actionId, status: 'REFUSED', message });
/** Événement métier après une écriture réussie (caches de l'assistant) — jamais bloquant. */
async function publier(events: Array<{ type: 'AGENDA_ITEM_UPDATED' | 'AGENDA_ITEM_DELETED' | 'DOCUMENT_UPLOADED'; accountId: number; entityId: number }>): Promise<void> {
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
