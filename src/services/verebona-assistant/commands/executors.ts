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
  /** Lot 114X : plan en cours d'exécution — sert de clé d'idempotence aux façades qui en acceptent une (événements de référence). */
  planId?: string;
  /**
   * Lot 114X : version des événements de référence déjà écrits PAR CE PLAN (identifiant → version après écriture).
   * Deux actions d'un même plan sur le même événement ne se refusent pas l'une l'autre ; toute autre modification
   * survenue depuis l'aperçu reste un refus.
   */
  referenceEventVersions?: Map<number, number>;
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
/**
 * Carte #807 (E07) — refus pour CONFLIT DE VERSION : la cible a changé depuis l'aperçu, rien n'a été écrit. Le
 * marqueur `conflict` fait relire les données et reproposer l'action (nouvelle confirmation, `plan.service`).
 */
const conflit = (a: PlannedAction, message: string): ActionResult =>
  ({ actionId: a.actionId, status: 'FAILED', message, conflict: true });

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
   * Passage 114AA (#753, W02) — « Catégorie de bien » (colonne `subtype`), par le service de la fiche
   * (`updateAssetDetails`, section commune, champ `subCategory`), comme le sélecteur de la fiche. La catégorie
   * présentée à l'aperçu est RELUE avant d'écrire : si elle a changé entre-temps, rien n'est écrit.
   */
  async UPDATE_ASSET_CATEGORY(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'asset_category' }>;
    const { normalizeAssetCategory } = await import('@/lib/asset-taxonomy');
    // Passage 114AB (#753, W02) : un bien de la famille OBJET porte sa catégorie sur un champ canonique de sa
    // fiche (`objectCategory`, section « Identification »), et non sur la colonne `subtype`. Même service, même
    // confirmation, même relecture — seul le champ écrit diffère, selon ce que la préparation a figé.
    if (p.objectCategory === true) {
      const { getField } = await import('@/services/canonical/registry');
      const def = getField('objectCategory');
      const libelleObjet = def?.enumLabels?.[p.categoryValue] ?? p.categoryValue;
      return ecrireClassement(action, ctx, {
        assetId: p.classifiedAssetId, field: 'objectCategory', section: 'object_identification',
        value: p.categoryValue, libelle: 'La catégorie de ce bien',
        relire: (etat) => (etat.characteristics.objectCategory as string | null) ?? etat.objectCategory ?? null,
        attendu: p.expectedCategory,
        succes: (nom) => `Catégorie de « ${nom} » : ${libelleObjet}.`,
      });
    }
    return ecrireClassement(action, ctx, {
      assetId: p.classifiedAssetId, field: 'subCategory', section: 'common', value: p.categoryValue, libelle: 'La catégorie de ce bien',
      relire: (etat) => normalizeAssetCategory(etat.subtype ?? null), attendu: p.expectedCategory,
      succes: (nom) => `Catégorie de « ${nom} » : ${p.categoryValue}.`,
    });
  },

  /**
   * Passage 114AA (#753, W02) — STATUT d'un bien, par le même service de la fiche (champ `status`, liste fermée
   * du référentiel ; l'archivage n'arrive jamais ici). Statut relu avant d'écrire.
   */
  async UPDATE_ASSET_STATUS(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'asset_status' }>;
    const { normalizeAssetStatus, ASSET_STATUS_LABELS } = await import('@/lib/asset-status');
    const libelleStatut = ASSET_STATUS_LABELS[p.statusValue as keyof typeof ASSET_STATUS_LABELS] ?? p.statusValue;
    return ecrireClassement(action, ctx, {
      assetId: p.classifiedAssetId, field: 'status', section: 'common', value: p.statusValue, libelle: 'Le statut de ce bien',
      relire: (etat) => normalizeAssetStatus(etat.status), attendu: p.expectedStatus,
      succes: (nom) => `Statut de « ${nom} » : ${libelleStatut}.`,
    });
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
    // Carte #843 (E07) : version d'écriture relue AVANT l'état présenté, puis exigée dans l'instruction d'écriture.
    const jeton = await jetonDeVersion('document', ctx.accountId, p.documentId);
    const etat = await sqlLookup.getDocumentState!(ctx.accountId, p.documentId);
    const cibles = etat ? await sqlLookup.getDocumentAssetTargets!(ctx.accountId, p.documentId) : null;
    if (!etat || !cibles || !jeton) return refuse(action, 'Document introuvable ou hors de votre compte.');
    // Passage 114AA (W13) : l'empreinte couvre les trois niveaux dès que l'un d'eux porte une pièce ou un
    // équipement — un changement de ce niveau depuis l'aperçu empêche l'écriture, comme pour les biens.
    const relue = documentTargetsVersion(
      etat.version, cibles.chosen.map((a) => a.id), (cibles.rooms ?? []).map((s) => s.id), (cibles.equipments ?? []).map((s) => s.id),
    );
    if (relue !== p.expectedVersion) return conflit(action, DOCUMENT_CHANGED_SINCE_PREVIEW);
    const body: Record<string, unknown> = { fileName: etat.originalFilename || etat.title, documentDate: etat.documentDate, assetIds: p.targetAssetIds };
    // Niveau pièce ou équipement : seule sa liste est envoyée ; les deux autres niveaux gardent leur sélection.
    if (p.level === 'room') body.substructureIds = p.targetStructureIds ?? [];
    if (p.level === 'equipment') body.equipmentIds = p.targetStructureIds ?? [];
    const { updateDocumentForAccount } = await import('@/services/documents/document-write.facade');
    const res = await updateDocumentForAccount({ userId: ctx.userId, currentAccountId: ctx.accountId }, p.documentId, body, { expectedUpdatedAtMicros: jeton });
    if (res.status === 409 && ((await res.clone().json().catch(() => ({}))) as { error?: string }).error === 'CONFLICT') return conflit(action, DOCUMENT_CHANGED_SINCE_PREVIEW);
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
    // #849 : empreinte de l'inventaire présenté recalculée sous verrou — écart → rien n'est supprimé.
    const { AssetDeletionInventoryChangedError } = await import('@/services/assets/asset-deletion.service');
    try {
      await deleteAssetForAccount({ accountId: ctx.accountId, userId: ctx.userId }, bien, { expectedFingerprint: p.expectedFingerprint ?? null });
    } catch (e) {
      if (e instanceof AssetDeletionInventoryChangedError) {
        return ko(action, `Le contenu de « ${resume.name} » a changé depuis l’aperçu : rien n’a été supprimé. Refaites votre demande.`);
      }
      throw e;
    }
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
    // Carte #843 (E07) : version relue avant l'état, puis exigée dans l'instruction d'écriture.
    const jeton = await jetonDeVersion('room', ctx.accountId, p.roomId);
    const etat = await sqlLookup.getRoomState!(ctx.accountId, p.roomId);
    if (!etat || !jeton || etat.assetId !== p.roomAssetId) return refuse(action, 'Pièce introuvable ou hors de votre compte.');
    if (etat.version !== p.expectedVersion) return conflit(action, STRUCTURE_CHANGED_SINCE_PREVIEW);
    const { renameRoomForAccount, StructureVersionConflictError } = await import('@/services/assets/structure-write.facade');
    let row: Awaited<ReturnType<typeof renameRoomForAccount>>;
    try {
      row = await renameRoomForAccount(ctx.accountId, etat.assetId, p.roomId, p.roomName, { expectedUpdatedAtMicros: jeton });
    } catch (e) {
      if (e instanceof StructureVersionConflictError) return conflit(action, STRUCTURE_CHANGED_SINCE_PREVIEW);
      throw e;
    }
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
    // Carte #843 (E07) : version relue avant l'état, puis exigée dans l'instruction de suppression.
    const jeton = await jetonDeVersion('room', ctx.accountId, p.roomId);
    const etat = await sqlLookup.getRoomState!(ctx.accountId, p.roomId);
    if (!etat || !jeton || etat.assetId !== p.roomAssetId) return refuse(action, 'Pièce introuvable ou hors de votre compte.');
    if (etat.version !== p.expectedVersion) return conflit(action, STRUCTURE_CHANGED_SINCE_PREVIEW);
    const { deleteRoomForAccount, StructureVersionConflictError } = await import('@/services/assets/structure-write.facade');
    try {
      if (!(await deleteRoomForAccount(ctx.accountId, etat.assetId, p.roomId, { expectedUpdatedAtMicros: jeton }))) return refuse(action, 'Pièce introuvable ou hors de votre compte.');
    } catch (e) {
      if (e instanceof StructureVersionConflictError) return conflit(action, STRUCTURE_CHANGED_SINCE_PREVIEW);
      throw e;
    }
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
    // Règle remplacée (carte #843, E02) : « création, PUIS fiche par une seconde écriture » — une panne de la
    // seconde laissait une fiche incomplète annoncée « créée ». Désormais UNE écriture atomique par la façade :
    // équipement, colonnes, fiche (marque, modèle, n° de série…) et montants, ou RIEN. Offre et quota revérifiés
    // sous le verrou du bien ; un équipement de même nom apparu entre-temps (double envoi, autre membre) : refus.
    const { createEquipmentWithDetailsForAccount } = await import('@/services/assets/structure-write.facade');
    const r = await createEquipmentWithDetailsForAccount({ userId: ctx.userId, currentAccountId: ctx.accountId }, p.equipmentAssetId, {
      ...(p.details ?? {}), name: p.equipmentName, ...(p.equipmentRoomId ? { substructureId: p.equipmentRoomId } : {}),
    }, { refuseHomonym: true, sourceId: ctx.planId ? `${ctx.planId}.${action.actionId}` : action.actionId });
    if (!r.ok) {
      if (r.code === 'NOT_FOUND') return refuse(action, 'Bien introuvable ou hors de votre compte : rien n’a été créé.');
      if (r.code === 'FORBIDDEN') return refuse(action, `${r.message} Rien n’a été créé.`);
      if (r.code === 'DUPLICATE') return refuse(action, `Un équipement « ${p.equipmentName} » existe déjà dans ce bien : rien n’a été créé en double.`);
      if (r.code === 'INVALID_INPUT') return ko(action, 'Cet équipement ne peut pas être créé avec ces informations : rien n’a été créé.');
      return ko(action, EQUIPMENT_CREATION_FAILED);
    }
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'équipement créé : il se retire depuis le bien' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Équipement « ${r.name} » créé.`, entity: { type: 'equipment', id: r.id } };
  },

  /** Lot 114 (#753, W05) — équipement renommé par la façade métier (celle de `PUT …/equipments/[equipId]`). */
  async RENAME_EQUIPMENT(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'equipment_rename' }>;
    const { sqlLookup } = await import('./plan.service');
    // Carte #843 (E07) — règle remplacée : « version relue, PUIS écriture sans garde ». La version d'écriture
    // (horodatage) est relue AVANT l'état présenté, puis exigée par la façade DANS son instruction d'écriture.
    const jeton = await jetonDeVersion('equipment', ctx.accountId, p.equipmentId);
    const etat = await sqlLookup.getEquipmentState!(ctx.accountId, p.equipmentId);
    if (!etat || !jeton || etat.assetId !== p.equipmentAssetId) return refuse(action, 'Équipement introuvable ou hors de votre compte.');
    if (etat.version !== p.expectedVersion) return conflit(action, STRUCTURE_CHANGED_SINCE_PREVIEW);
    // Même garde que la route : modification suspendue au-dessus du quota de biens (GAP-11).
    const { refuserSiModificationBiensSuspendue } = await import('@/lib/asset-quota-guard');
    const suspendu = await refuserSiModificationBiensSuspendue(ctx.accountId, etat.assetId); // #849 : bien transmis refusé
    if (suspendu) return refuse(action, ((await suspendu.json().catch(() => ({}))) as { message?: string }).message ?? 'Modification non autorisée.');
    const { updateEquipmentForAccount } = await import('@/services/assets/structure-write.facade');
    const res = await updateEquipmentForAccount({ userId: ctx.userId, currentAccountId: ctx.accountId }, etat.assetId, p.equipmentId, { name: p.equipmentName },
      { expectedUpdatedAtMicros: jeton });
    if (res.status === 409) return conflit(action, STRUCTURE_CHANGED_SINCE_PREVIEW);
    if (res.status === 404) return refuse(action, 'Équipement introuvable ou hors de votre compte.');
    if (res.status !== 200) return ko(action, 'Ce nom ne peut pas être enregistré tel quel : rien n’a été modifié.');
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'équipement renommé : à corriger depuis le bien ou par une nouvelle demande' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Équipement « ${etat.name} » renommé en « ${p.equipmentName} ».`, entity: { type: 'equipment', id: p.equipmentId } };
  },

  /**
   * Carte #807 (E01, W05 ; E07) — équipement modifié par la façade métier (celle de `PUT …/equipments/[equipId]`) :
   * mêmes validations que le tiroir, origine USER des valeurs, rapprochement relancé sur renommage ou déplacement.
   *
   * L'état présenté est relu (empreinte) ; puis la façade exige la version présentée DANS son instruction
   * d'écriture, sous verrou de ligne : une modification survenue entre la relecture et l'écriture est un
   * conflit, jamais un écrasement. Bien de destination : compte, disponibilité et offre recontrôlés ici.
   */
  async UPDATE_EQUIPMENT(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'equipment_update' }>;
    const { readEquipmentFullState, equipmentDiff } = await import('./rich-edits');
    const etat = await readEquipmentFullState(ctx.accountId, p.equipmentId);
    if (!etat) return refuse(action, 'Équipement introuvable ou hors de votre compte.');
    if (etat.version !== p.expectedVersion || etat.assetId !== p.equipmentAssetId) return conflit(action, STRUCTURE_CHANGED_SINCE_PREVIEW);
    const { sqlLookup } = await import('./plan.service');
    if (p.newAssetId !== undefined) {
      if (!(await sqlLookup.getAsset(ctx.accountId, p.newAssetId))) return refuse(action, 'Bien de destination introuvable ou indisponible dans votre compte : rien n’a été modifié.');
      const refus = await refusStructure(ctx.accountId, p.newAssetId, 'equipment');
      if (refus) return refuse(action, refus);
    }
    // Même garde que la route : modification suspendue au-dessus du quota de biens (GAP-11).
    const { refuserSiModificationBiensSuspendue } = await import('@/lib/asset-quota-guard');
    const suspendu = await refuserSiModificationBiensSuspendue(ctx.accountId, etat.assetId); // #849 : bien transmis refusé
    if (suspendu) return refuse(action, ((await suspendu.json().catch(() => ({}))) as { message?: string }).message ?? 'Modification non autorisée.');
    const { body } = equipmentDiff(etat, p.requested, p.roomId, p.newAssetId);
    if (Object.keys(body).length === 0) return ko(action, 'Cet équipement a déjà ces valeurs : rien n’a été modifié.');
    const { updateEquipmentForAccount } = await import('@/services/assets/structure-write.facade');
    const res = await updateEquipmentForAccount({ userId: ctx.userId, currentAccountId: ctx.accountId }, etat.assetId, p.equipmentId, body,
      { expectedUpdatedAtMicros: p.expectedUpdatedAt });
    if (res.status === 409) return conflit(action, STRUCTURE_CHANGED_SINCE_PREVIEW);
    if (res.status === 404) return refuse(action, 'Équipement ou bien introuvable dans votre compte : rien n’a été modifié.');
    if (res.status !== 200) return ko(action, 'Ces informations ne peuvent pas être enregistrées telles quelles : rien n’a été modifié.');
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'équipement modifié : à corriger depuis le bien ou par une nouvelle demande' });
    const nom = typeof body.name === 'string' ? body.name : etat.name;
    return {
      actionId: action.actionId, status: 'SUCCESS', entity: { type: 'equipment', id: p.equipmentId },
      message: p.newAssetId !== undefined
        ? `Équipement « ${nom} » déplacé. Ses documents, ses échéances et son historique sont conservés.`
        : `Équipement « ${nom} » modifié.`,
    };
  },

  /** Lot 114 (#753, W06) — équipement retiré = ARCHIVÉ, par la façade métier (celle de `DELETE …/equipments/[equipId]`). */
  async ARCHIVE_EQUIPMENT(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'equipment_archive' }>;
    const { sqlLookup } = await import('./plan.service');
    // Carte #843 (E07) : version relue avant l'état, puis exigée dans l'instruction d'archivage.
    const jeton = await jetonDeVersion('equipment', ctx.accountId, p.equipmentId);
    const etat = await sqlLookup.getEquipmentState!(ctx.accountId, p.equipmentId);
    if (!etat || !jeton || etat.assetId !== p.equipmentAssetId) return refuse(action, 'Équipement introuvable ou hors de votre compte.');
    if (etat.version !== p.expectedVersion) return conflit(action, STRUCTURE_CHANGED_SINCE_PREVIEW);
    const { archiveEquipmentForAccount, StructureVersionConflictError } = await import('@/services/assets/structure-write.facade');
    try {
      if (!(await archiveEquipmentForAccount(ctx.accountId, etat.assetId, p.equipmentId, { expectedUpdatedAtMicros: jeton }))) return refuse(action, 'Équipement introuvable ou hors de votre compte.');
    } catch (e) {
      if (e instanceof StructureVersionConflictError) return conflit(action, STRUCTURE_CHANGED_SINCE_PREVIEW);
      throw e;
    }
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
    // Carte #843 (E07) : version d'écriture relue AVANT l'état présenté, puis exigée dans l'instruction d'écriture.
    const jeton = await jetonDeVersion('document', ctx.accountId, p.documentId);
    const etat = await sqlLookup.getDocumentState!(ctx.accountId, p.documentId);
    if (!etat || !jeton) return refuse(action, 'Document introuvable ou hors de votre compte.');
    if (etat.version !== p.expectedVersion) return conflit(action, DOCUMENT_CHANGED_SINCE_PREVIEW);
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
    const res = await updateDocumentForAccount({ userId: ctx.userId, currentAccountId: ctx.accountId }, p.documentId, body, { expectedUpdatedAtMicros: jeton });
    if (res.status === 409 && ((await res.clone().json().catch(() => ({}))) as { error?: string }).error === 'CONFLICT') return conflit(action, DOCUMENT_CHANGED_SINCE_PREVIEW);
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
    // Carte #843 (E07) : version relue avant l'état, puis exigée SOUS VERROU dans la transaction de la suppression.
    const jeton = await jetonDeVersion('document', ctx.accountId, p.documentId);
    const etat = await sqlLookup.getDocumentState!(ctx.accountId, p.documentId);
    if (!etat || !jeton) return refuse(action, 'Document introuvable ou hors de votre compte.');
    if (etat.version !== p.expectedVersion) return conflit(action, DOCUMENT_CHANGED_SINCE_PREVIEW);
    const { softDeleteDocumentsGuarded } = await import('@/services/documents/document-write.facade');
    const issue = await softDeleteDocumentsGuarded({ accountId: ctx.accountId, userId: ctx.userId, documents: [{ fileId: p.documentId, expectedUpdatedAtMicros: jeton }] });
    if (issue === 'CONFLICT') return conflit(action, DOCUMENT_CHANGED_SINCE_PREVIEW);
    if (issue === 'NOT_FOUND') return refuse(action, 'Document introuvable ou hors de votre compte.');
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'suppression d’un document' });
    return { actionId: action.actionId, status: 'SUCCESS', message: `Document « ${etat.title} » supprimé.`, entity: { type: 'document', id: p.documentId } };
  },

  /**
   * Passage 114AB (#753, W12) — NATURE d'un document (Rubrique et Type V2), par le point d'écriture unique
   * de la façade métier (`updateDocumentClassificationForAccount`, celui du tiroir du document) : origine
   * USER, cartes « À traiter » du classement fermées, données documentaires réévaluées, `DOCUMENT_UPDATED`.
   *
   * L'état est relu DEUX fois : ici (empreinte du document et de son classement, celle de l'aperçu), puis
   * par la façade elle-même (`expectedCurrent`) — si la Rubrique ou le Type a changé, rien n'est écrit.
   */
  async UPDATE_DOCUMENT_CLASSIFICATION(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'document_classification' }>;
    const { sqlLookup, documentClassificationVersion } = await import('./plan.service');
    const etat = await sqlLookup.getDocumentState!(ctx.accountId, p.documentId);
    if (!etat) return refuse(action, 'Document introuvable ou hors de votre compte.');
    if (documentClassificationVersion(etat) !== p.expectedVersion) return ko(action, DOCUMENT_CLASSIFICATION_CHANGED);
    const { updateDocumentClassificationForAccount } = await import('@/services/documents/document-write.facade');
    const r = await updateDocumentClassificationForAccount(
      { userId: ctx.userId, currentAccountId: ctx.accountId }, { documentId: p.documentId },
      {
        ...(p.rubricValue !== undefined ? { rubricCode: p.rubricValue } : {}),
        ...(p.typeValue !== undefined ? { documentTypeCode: p.typeValue } : {}),
        expectedCurrent: { rubricCode: p.expectedRubric, documentTypeCode: p.expectedType },
      },
    );
    if (!r.ok) {
      if (r.error === 'NOT_FOUND') return refuse(action, 'Document introuvable ou hors de votre compte.');
      if (r.error === 'STATE_CHANGED') return ko(action, DOCUMENT_CLASSIFICATION_CHANGED);
      return ko(action, 'Ce classement ne peut pas être enregistré tel quel : rien n’a été modifié.');
    }
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'classement d’un document : à corriger depuis le document ou par une nouvelle demande' });
    const { rubricLabelOf, typeLabelOf } = await import('./document-classification');
    const message = p.classificationLevel === 'rubric'
      ? `Rubrique du document « ${etat.title} » : ${rubricLabelOf(r.classification.rubricCode)}.`
      : `Type du document « ${etat.title} » : ${typeLabelOf(r.classification.documentTypeCode)}.`;
    return { actionId: action.actionId, status: 'SUCCESS', message, entity: { type: 'document', id: p.documentId } };
  },

  /**
   * Passage 114AB (#753, W14) — suppression de PLUSIEURS documents : action destructive, TOUT OU RIEN.
   *
   * Les documents sont TOUS relus et comparés à l'aperçu AVANT la première suppression : un seul écart
   * (document disparu, hors du compte, modifié depuis) et aucun n'est supprimé. Les suppressions passent
   * ensuite par le même point d'écriture que la suppression d'un document (`softDeleteDocument`).
   */
  async DELETE_DOCUMENTS(action, ctx) {
    const p = action.params as Extract<CommandParams, { kind: 'documents_delete' }>;
    const { sqlLookup } = await import('./plan.service');
    const relus: Array<{ id: number; title: string; jeton: string }> = [];
    for (const d of p.documents) {
      // Carte #843 (E07) : version relue avant l'état de CHAQUE document.
      const jeton = await jetonDeVersion('document', ctx.accountId, d.documentId);
      const etat = await sqlLookup.getDocumentState!(ctx.accountId, d.documentId);
      if (!etat || !jeton) return refuse(action, `« ${d.title} » est introuvable dans votre compte : aucun document n’a été supprimé.`);
      if (etat.version !== d.expectedVersion) {
        return conflit(action, `« ${etat.title} » a été modifié depuis l’aperçu : aucun document n’a été supprimé. Refaites votre demande.`);
      }
      relus.push({ id: etat.id, title: etat.title, jeton });
    }
    // Carte #843 (E07) — règle remplacée : « suppressions successives après relecture ». Désormais UNE transaction :
    // toutes les versions revérifiées sous verrou, tout ou rien.
    const { softDeleteDocumentsGuarded } = await import('@/services/documents/document-write.facade');
    const issue = await softDeleteDocumentsGuarded({ accountId: ctx.accountId, userId: ctx.userId, documents: relus.map((d) => ({ fileId: d.id, expectedUpdatedAtMicros: d.jeton })) });
    if (issue === 'CONFLICT') return conflit(action, 'Un de ces documents a été modifié depuis l’aperçu : aucun document n’a été supprimé. Refaites votre demande.');
    if (issue === 'NOT_FOUND') return refuse(action, 'Un de ces documents est introuvable dans votre compte : aucun document n’a été supprimé.');
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'suppression de plusieurs documents' });
    return {
      actionId: action.actionId, status: 'SUCCESS',
      message: `${relus.length} documents supprimés : ${relus.map((d) => `« ${d.title} »`).join(', ')}.`,
      entity: { type: 'document', id: relus[0].id },
    };
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
    if (etat.version !== p.expectedVersion) return conflit(action, SUPPLIER_CHANGED_SINCE_PREVIEW);
    const { updateSupplierForAccount } = await import('@/services/suppliers/supplier-write.facade');
    // Une chaîne vide efface la valeur : même convention que le formulaire de la fiche.
    const body: Record<string, string> = Object.fromEntries(Object.entries(p.patch).map(([k, v]) => [k, v ?? '']));
    // Carte #843 (E04) : l'IBAN n'est PAS dans la proposition (forme masquée seulement) — il est descellé ici, au
    // moment de l'écriture, depuis la valeur chiffrée de CETTE proposition. Purgé, échu ou illisible : rien n'est écrit.
    if (p.ibanSealed) {
      const { unsealPlanSecret, BANKING_SECRET_GONE } = await import('./plan-secrets');
      const iban = ctx.planId ? await unsealPlanSecret({ planId: ctx.planId, accountId: ctx.accountId, actionId: action.actionId }) : null;
      if (!iban) return refuse(action, BANKING_SECRET_GONE);
      body.iban = iban;
    }
    // Carte #807 (E07) : version complète de la fiche exigée SOUS VERROU par la façade, dans la transaction de
    // l'écriture — une modification concurrente (autre membre, autre onglet) est un conflit, jamais un écrasement.
    // Carte #843 (E07) : un plan sans version complète (préparé avant #807) exige la version RELUE à l'instant
    // (même lecture que l'état contrôlé ci-dessus) — jamais une écriture sans garde.
    const versionExigee = p.expectedRowVersion ?? etat.rowVersion;
    if (!versionExigee) return refuse(action, 'Fournisseur introuvable ou hors de votre compte.');
    const r = await updateSupplierForAccount({
      accountId: ctx.accountId, userId: ctx.userId, supplierId: p.supplierId, body, expectedVersion: versionExigee,
    });
    if (!r.ok && r.code === 'CONFLICT') return conflit(action, SUPPLIER_CHANGED_SINCE_PREVIEW);
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
    if (etat.version !== p.expectedVersion) return conflit(action, SUPPLIER_CHANGED_SINCE_PREVIEW);
    if (!etat.rowVersion) return refuse(action, 'Fournisseur introuvable ou hors de votre compte.');
    const { setSupplierArchived } = await import('@/services/suppliers/supplier-write.facade');
    // Carte #843 (E07) : version complète (lue avec l'état contrôlé) exigée SOUS VERROU dans la transaction.
    const r = await setSupplierArchived({ accountId: ctx.accountId, supplierId: p.supplierId, expectedVersion: etat.rowVersion });
    if (!r.ok && r.code === 'CONFLICT') return conflit(action, SUPPLIER_CHANGED_SINCE_PREVIEW);
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
    if (agendaVersion(avantEcriture) !== p.expectedVersion) return conflit(action, CHANGED_SINCE_PREVIEW);
    // Carte #807 (E03) : entrée du service = seulement ce qui CHANGE par rapport à l'échéance relue (champs du
    // tiroir ; liens : ceux de l'échéance, plus les ajouts demandés — jamais un lien retiré ni écrasé).
    const { getAgendaItemById } = await import('@/services/agenda/AgendaQueryService');
    const relue = await getAgendaItemById(p.agendaItemId, ctx.accountId);
    if (!relue) return refuse(action, 'Échéance introuvable ou hors de votre compte.');
    const { agendaDiff } = await import('./rich-edits');
    const { input } = agendaDiff(relue, p.patch);
    if (Object.keys(input).length === 0) return ko(action, 'Cette échéance a déjà ces valeurs : rien n’a été modifié.');
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const { AgendaConcurrentUpdateError } = await import('@/services/agenda/write-agenda-item');
    let item: Awaited<ReturnType<typeof updateAgendaItem>>;
    try {
      // Carte #807 (E07) : version présentée exigée par le service DANS son écriture (plans préparés depuis
      // cette carte) — une modification concurrente est un conflit, jamais un écrasement.
      // Carte #843 (E07) : un plan sans version d'écriture (préparé avant #807) exige celle RELUE ci-dessus avec
      // l'état contrôlé — jamais une écriture sans garde.
      item = await updateAgendaItem(p.agendaItemId, input, ctx.accountId, ctx.userId, {},
        { expectedUpdatedAtMicros: p.expectedUpdatedAt ?? avantEcriture.updatedAt });
    } catch (e) {
      if (e instanceof AgendaConcurrentUpdateError) return conflit(action, CHANGED_SINCE_PREVIEW);
      throw e;
    }
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
    if (agendaVersion(avantEcriture) !== p.expectedVersion) return conflit(action, CHANGED_SINCE_PREVIEW);
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
    const { AgendaConcurrentUpdateError } = await import('@/services/agenda/write-agenda-item');
    let deletedIds: number[];
    try {
      // Carte #843 (E07) : version relue avec l'état contrôlé, exigée SOUS VERROU dans la transaction de suppression.
      ({ deletedIds } = await deleteAgendaItem(p.agendaItemId, ctx.accountId, ctx.userId, { scope: p.scope, expectedUpdatedAtMicros: avantEcriture.updatedAt }));
    } catch (e) {
      if (e instanceof AgendaConcurrentUpdateError) return conflit(action, CHANGED_SINCE_PREVIEW);
      throw e;
    }
    ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'suppression définitive d’une échéance' });
    await publier(deletedIds.map((entityId) => ({ type: 'AGENDA_ITEM_DELETED' as const, accountId: ctx.accountId, entityId })));
    return {
      actionId: action.actionId, status: 'SUCCESS',
      message: deletedIds.length > 1 ? `Série « ${avantEcriture.title} » supprimée : ${deletedIds.length} échéances.` : `Échéance « ${avantEcriture.title} » supprimée.`,
      // L'identifiant supprimé est rendu pour que l'Agenda ouvert sous l'assistant se remette à jour.
      entity: { type: 'agenda_item', id: p.agendaItemId },
    };
  },

  // Lot 114X (#753, W21 – W26) — événements de référence : exécuteurs de `reference-events.ts`, qui n'écrivent que par
  // la façade métier du graphe (`operation-write.facade`, carte #744) et traduisent chacun de ses résultats.
  async CREATE_REFERENCE_EVENT(action, ctx) { return (await import('./reference-events')).REFERENCE_EVENT_EXECUTORS.CREATE_REFERENCE_EVENT(action, ctx); },
  async UPDATE_REFERENCE_EVENT(action, ctx) { return (await import('./reference-events')).REFERENCE_EVENT_EXECUTORS.UPDATE_REFERENCE_EVENT(action, ctx); },
  async INVALIDATE_REFERENCE_EVENT(action, ctx) { return (await import('./reference-events')).REFERENCE_EVENT_EXECUTORS.INVALIDATE_REFERENCE_EVENT(action, ctx); },
  async ASSOCIATE_REFERENCE_EVENTS(action, ctx) { return (await import('./reference-events')).REFERENCE_EVENT_EXECUTORS.ASSOCIATE_REFERENCE_EVENTS(action, ctx); },
  async LINK_DOCUMENT_REFERENCE_EVENT(action, ctx) { return (await import('./reference-events')).REFERENCE_EVENT_EXECUTORS.LINK_DOCUMENT_REFERENCE_EVENT(action, ctx); },
  async LINK_SUPPLIER_REFERENCE_EVENT(action, ctx) { return (await import('./reference-events')).REFERENCE_EVENT_EXECUTORS.LINK_SUPPLIER_REFERENCE_EVENT(action, ctx); },

  // Passage 114AB (#753) — GESTES INVERSES : exécuteurs de `reference-events-inverse.ts`, qui n'écrivent eux
  // aussi que par la façade métier du graphe (`operation-write.facade`, carte #744).
  async RESTORE_REFERENCE_EVENT(action, ctx) { return (await import('./reference-events-inverse')).INVERSE_REFERENCE_EVENT_EXECUTORS.RESTORE_REFERENCE_EVENT(action, ctx); },
  async DISSOCIATE_REFERENCE_EVENTS(action, ctx) { return (await import('./reference-events-inverse')).INVERSE_REFERENCE_EVENT_EXECUTORS.DISSOCIATE_REFERENCE_EVENTS(action, ctx); },
  async UNLINK_DOCUMENT_REFERENCE_EVENT(action, ctx) { return (await import('./reference-events-inverse')).INVERSE_REFERENCE_EVENT_EXECUTORS.UNLINK_DOCUMENT_REFERENCE_EVENT(action, ctx); },
  async UNLINK_SUPPLIER_REFERENCE_EVENT(action, ctx) { return (await import('./reference-events-inverse')).INVERSE_REFERENCE_EVENT_EXECUTORS.UNLINK_SUPPLIER_REFERENCE_EVENT(action, ctx); },
  async LINK_AGENDA_REFERENCE_EVENT(action, ctx) { return (await import('./reference-events-inverse')).INVERSE_REFERENCE_EVENT_EXECUTORS.LINK_AGENDA_REFERENCE_EVENT(action, ctx); },
};

// Lot 113P (#715) : plus de commande de STATUT d'échéance (réalisée / annulée) ni d'inverse associé.

/**
 * Passage 114AA (#753, W02) — écriture du CLASSEMENT d'un bien (catégorie de bien, statut) : corps commun de
 * UPDATE_ASSET_CATEGORY et de UPDATE_ASSET_STATUS.
 *
 * Ces deux valeurs sont portées par des colonnes d'identité, hors du registre canonique : l'état est donc RELU
 * ici (`getAssetState`, la même lecture que l'aperçu) et comparé à la valeur présentée avant d'appeler le
 * service de la fiche. Le service refuse de son côté un bien archivé, verrouillé ou hors du compte, et une
 * valeur hors de la liste fermée du référentiel.
 */
async function ecrireClassement(
  action: PlannedAction, ctx: ExecutionContext,
  p: {
    assetId: number;
    /**
     * Passage 114AB (#753, W02) : `objectCategory` — la catégorie d'un bien de la famille OBJET, portée par un
     * champ CANONIQUE de sa fiche (section « Identification »), et non par la colonne d'identité `subtype`.
     */
    field: 'subCategory' | 'status' | 'objectCategory';
    /** Section de la fiche qui porte le champ (« common », ou « object_identification » pour un objet). */
    section: string;
    value: string; libelle: string;
    relire: (etat: import('./plan.service').AssetState) => string | null; attendu: string | null;
    succes: (nom: string) => string;
  },
): Promise<ActionResult> {
  const { loadWritableAsset, updateAssetDetails, AssetDetailsError } = await import('@/services/asset-details-write.service');
  const { sqlLookup } = await import('./plan.service');
  const change = `${p.libelle} a changé depuis l’aperçu : rien n’a été écrit. Refaites votre demande.`;
  const texte = (v: string | null) => (v === null ? '' : v);
  try {
    await loadWritableAsset(p.assetId, ctx.accountId);
    const etat = await sqlLookup.getAssetState!(ctx.accountId, p.assetId);
    if (!etat) return refuse(action, 'Bien introuvable ou hors de votre compte.');
    if (texte(p.relire(etat)) !== texte(p.attendu)) return ko(action, change);
    await updateAssetDetails({
      assetId: p.assetId, accountId: ctx.accountId, section: p.section, fields: { [p.field]: p.value },
      origin: 'USER', actorUserId: ctx.userId,
      // Passage 114AB (#753) : la valeur présentée à l'aperçu est en plus revérifiée SOUS VERROU par le
      // service de la fiche, dans la même transaction que l'écriture (ajout du passage 114AB) — deux onglets
      // qui écrivent à la seconde près ne peuvent plus se croiser.
      expectedCurrent: { [p.field]: p.attendu },
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
      return ko(action, 'Cette valeur ne peut pas être enregistrée telle quelle : rien n’a été modifié.');
    }
    throw e;
  }
  ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason: 'classement du bien modifié : à corriger par une nouvelle demande' });
  return {
    actionId: action.actionId, status: 'SUCCESS',
    message: p.succes(action.targets[0]?.label ?? 'ce bien'), entity: { type: 'asset', id: p.assetId },
  };
}

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
/** Carte #843 (E02) : panne pendant la création atomique — la transaction est annulée, rien n'est à moitié écrit. */
export const EQUIPMENT_CREATION_FAILED = 'L’équipement n’a pas pu être créé : rien n’a été enregistré (ni l’équipement, ni sa fiche). Vous pouvez refaire votre demande.';

/**
 * Carte #843 (E07) — VERSION D'ÉCRITURE d'une cible (horodatage de dernière modification, microsecondes en texte),
 * bornée au compte. Elle est relue AVANT l'état présenté : si cet état est encore celui de l'aperçu ET que la
 * façade trouve, dans son instruction d'écriture, la même version, aucune écriture n'a eu lieu entre l'aperçu et
 * la nôtre. `null` : cible absente du compte.
 */
export async function jetonDeVersion(kind: 'equipment' | 'room' | 'document', accountId: number, id: number): Promise<string | null> {
  const sql = kind === 'equipment'
    ? `SELECT (extract(epoch FROM e.updated_at) * 1000000)::bigint::text AS v FROM equipments e
         JOIN assets a ON a.id = e.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL WHERE e.id = $1 AND e.archived_at IS NULL`
    : kind === 'room'
      ? `SELECT (extract(epoch FROM r.updated_at) * 1000000)::bigint::text AS v FROM substructures r
           JOIN assets a ON a.id = r.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL WHERE r.id = $1`
      : `SELECT (extract(epoch FROM updated_at) * 1000000)::bigint::text AS v FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`;
  const [r] = (await pgClient.unsafe(sql, [id, accountId] as never[])) as unknown as Array<{ v: string | null }>;
  return r?.v ?? null;
}
/** Création d'une pièce ou d'un équipement : bien du compte et contrôles d'offre de la façade métier, relus à l'exécution. */
async function refusStructure(accountId: number, assetId: number, kind: 'room' | 'equipment'): Promise<string | null> {
  const { sqlLookup } = await import('./plan.service');
  const nature = await sqlLookup.getAssetKind!(accountId, assetId);
  if (!nature) return 'Bien introuvable ou hors de votre compte.';
  return sqlLookup.structureRefusal!(accountId, nature, kind);
}
const DOCUMENT_CHANGED_SINCE_PREVIEW = 'Ce document a été modifié depuis l’aperçu : rien n’a été fait. Refaites votre demande.';
/** Passage 114AB (W12) : la Rubrique ou le Type a changé entre l'aperçu et la confirmation — rien n'est écrit. */
const DOCUMENT_CLASSIFICATION_CHANGED = 'Le classement de ce document a changé depuis l’aperçu : rien n’a été écrit. Refaites votre demande.';
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
