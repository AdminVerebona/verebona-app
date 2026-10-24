/**
 * writeAgendaItem() — primitive d'écriture UNIQUE d'un élément d'agenda
 * (CDC 15 T4-09, SVC-07, §12 « AgendaWriteService unifié » ; lot 14).
 *
 * Utilisée par l'agenda manuel (`AgendaWriteService`) ET par T4
 * (`agenda-persistence`) : mêmes validations, mêmes liens, mêmes effets.
 *
 *   1. validations (dates ; cohérence des liens bien / document / pièce /
 *      équipement) — demandées par l'appelant (`validate`) ;
 *   2. une transaction : ligne `agenda_items` (création ou mise à jour) et
 *      liaisons (remplacées pour l'agenda manuel, ajoutées pour T4) ;
 *   3. colonnes 0223 présentes : clé fonctionnelle, nature HISTORICAL |
 *      DEADLINE et type métier ; liens source canoniques (`agenda_file_links`,
 *      service unique `agenda-source-links`) ;
 *   4. après validation : recopie « achat » (D-13) — seulement pour un
 *      événement MANUEL réalisé, d'achat, sur un champ vide, par
 *      `writeCanonicalAssetField` (origine USER) — et notification (jamais
 *      pour un élément HISTORICAL, D-14).
 *
 * Lot 16b-2 : commutateur AI_T4_EFFECTS retiré, comportement = ancien
 * `enabled` (les écritures historiques legacy / shadow n'existent plus) ;
 * lot 16b-3 : CANONICAL_WRITE_MODE retiré de même.
 *
 * Lot 49 (SEC-07) — CONTRÔLE D'APPARTENANCE TOUJOURS ACTIF : biens,
 * documents (liens et sources), pièces et équipements référencés doivent
 * exister et appartenir au compte de l'élément. Le contrôle est fait DANS la
 * transaction de l'écriture, AVANT elle, que l'appelant demande ou non les
 * validations métier (`validate: false` désactive les règles de dates et de
 * cohérence, JAMAIS la sécurité) : une seule référence invalide fait refuser
 * l'opération entière (`AgendaOwnershipError`, rien n'est écrit). Les liens
 * remplacés (`replace`) ne suppriment que des liens vers des objets du
 * compte : une relation incorrecte historique n'est jamais effacée
 * automatiquement (elle reste visible du contrôle d'exploitation, et n'est
 * jamais lue — voir `AgendaQueryService`).
 */
import { db } from '@/db';
import {
  agendaItems, agendaAssetLinks, agendaRoomLinks, agendaEquipmentLinks,
  assets, assetFiles, substructures, equipments,
} from '@/db/schema';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { validateTemporalConstraints, validateLinkCoherence, type ResolvedLink } from './AgendaDomainService';
import { agendaFunctionalColumnsReady } from './agenda-columns';
import { recordAgendaItemSources, type AgendaSourceRef } from './agenda-source-links';
import { resolveEventSemantics, type AgendaEventNature } from './agenda-functional-key';
import { findRejectedRefs, logCrossAccountRefusal, type SqlExecutor } from '@/services/security/account-ownership';
import { addFileLinkProvenance, replaceDirectFileLinks } from '@/services/business-operations/grouping/provenance';
import { liftLinkRejections, recordGroupingDecision, recordLinkDecision } from '@/services/business-operations/grouping/decisions';
import { drizzleRunner } from '@/services/business-operations/grouping/runner';

type ItemInsert = typeof agendaItems.$inferInsert;

/** Colonnes d'un élément (forme Drizzle, sans identifiant ni compte). */
export type AgendaItemValues = Omit<ItemInsert, 'id' | 'publicId' | 'accountId' | 'createdAt'>;

export interface AgendaItemLinks {
  assetIds?: number[];
  fileIds?: number[];
  substructureIds?: number[];
  equipmentIds?: number[];
}

export interface AgendaItemWriteInput {
  /** Création, ou mise à jour de l'élément `itemId` (valeurs partielles). */
  itemId?: number;
  values: Partial<AgendaItemValues>;
  links?: AgendaItemLinks;
  /** Documents de l'élément (service unique de liaison T4-07, X-04 ; enabled). */
  sources?: AgendaSourceRef[];
  /** Type métier et nature explicites ; à défaut déduits du champ d'origine. */
  semantics?: { businessType?: string | null; nature?: AgendaEventNature | null };
  /** Clé fonctionnelle (T4-08) — éléments automatiques d'une source. */
  functionalKey?: string | null;
}

export interface WriteAgendaItemOptions {
  accountId: number;
  actorUserId?: number | null;
  /** Chemin appelant : agenda manuel (fiche, assistant) ou T4. */
  channel: 'MANUAL' | 'T4';
  /** Liaisons : `replace` (agenda manuel : l'état complet) ou `add` (T4). */
  linkMode?: 'replace' | 'add';
  /** Contrôles de dates et de cohérence des liens (agenda manuel). */
  validate?: boolean;
  /** Notification de création (propagation d'impact par bien lié). */
  notify?: boolean;
  /**
   * Recopie « achat » (D-13). `undefined` : pas de recopie. Sinon le statut
   * transmis décide, comme l'historique (`manualStatus` absent = création /
   * édition ; 'realise' = marqué réalisé).
   */
  purchaseSync?: { manualStatus?: 'realise' | 'annule' | null };
  /**
   * Transaction englobante (résolution d'une carte « À traiter », §13.5) :
   * l'écriture y est faite (SAVEPOINT), jamais sur le client global. Les
   * effets d'après validation (recopie, notification, proposition D-15)
   * restent à la charge de l'appelant dans ce cas.
   */
  client?: { transaction: typeof db.transaction };
  /**
   * Mise à jour AUTOMATIQUE : n'écrit que si l'élément n'a pas été modifié par
   * l'utilisateur (`is_automatic_modified = false`, `manual_status` vide),
   * condition portée par le WHERE lui-même (pas de course avec une édition
   * concurrente). 0 ligne touchée = élément protégé, rien d'autre n'est écrit.
   */
  onlyIfUntouched?: boolean;
  /**
   * D-15 : proposition de statut du bien pour un événement historique
   * « vente » créé (défaut : oui). Faux pour une projection d'Opération
   * (lot 46, O7) : la cession vient déjà de la fiche ou des documents.
   */
  statusProposal?: boolean;
}

export interface WriteAgendaItemResult {
  id: number;
  created: boolean;
  nature: AgendaEventNature | null;
  businessType: string | null;
  /** D-14 : faux pour un élément HISTORICAL. */
  notifiable: boolean;
  functionalKey: string | null;
  /** Élément modifié par l'utilisateur : rien n'a été écrit (`onlyIfUntouched`). */
  protected?: boolean;
}

export class AgendaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgendaValidationError';
  }
}

/**
 * Lot 49 (SEC-07) : une référence de l'élément (bien, document, pièce,
 * équipement) n'existe pas dans le compte. Sous-classe de
 * `AgendaValidationError` (même traitement par les appelants : refus 400,
 * rien n'est écrit) ; le message ne révèle rien d'un autre compte.
 */
export class AgendaOwnershipError extends AgendaValidationError {
  readonly code = 'CROSS_ACCOUNT_REFERENCE';
  constructor() {
    super('Cohérence des liens : référence introuvable dans le compte');
    this.name = 'AgendaOwnershipError';
  }
}

/**
 * Contrôle de SÉCURITÉ de l'élément : toutes les références (liens et
 * documents sources) appartiennent au compte. Indépendant de `validate`.
 */
export async function assertAgendaRefsInAccount(
  accountId: number,
  links: AgendaItemLinks | undefined,
  sources: ReadonlyArray<{ fileId: number }> | undefined,
  exec?: SqlExecutor,
): Promise<void> {
  const rejected = await findRejectedRefs(accountId, {
    asset: links?.assetIds ?? [],
    file: [...(links?.fileIds ?? []), ...(sources ?? []).map((s) => s.fileId)],
    substructure: links?.substructureIds ?? [],
    equipment: links?.equipmentIds ?? [],
  }, exec);
  if (rejected.length) {
    logCrossAccountRefusal('agenda.write', { accountId, rejected });
    throw new AgendaOwnershipError();
  }
}

/** Liens indirects (document, pièce, équipement) → bien porteur, pour la cohérence. */
export async function resolveIndirectLinks(
  fileIds: number[],
  substructureIds: number[],
  equipmentIds: number[],
): Promise<{ fileLinks: ResolvedLink[]; roomLinks: ResolvedLink[]; equipmentLinks: ResolvedLink[] }> {
  const [files, rooms, equips] = await Promise.all([
    fileIds.length > 0
      ? db.select({ id: assetFiles.id, assetId: assetFiles.assetId }).from(assetFiles).where(inArray(assetFiles.id, fileIds))
      : [],
    substructureIds.length > 0
      ? db.select({ id: substructures.id, assetId: substructures.assetId }).from(substructures).where(inArray(substructures.id, substructureIds))
      : [],
    equipmentIds.length > 0
      ? db.select({ id: equipments.id, assetId: equipments.assetId }).from(equipments).where(inArray(equipments.id, equipmentIds))
      : [],
  ]);
  return {
    fileLinks: files.map((f) => ({ id: f.id, resolvedAssetId: f.assetId ?? null })),
    roomLinks: rooms.map((r) => ({ id: r.id, resolvedAssetId: r.assetId })),
    equipmentLinks: equips.map((e) => ({ id: e.id, resolvedAssetId: e.assetId })),
  };
}

/**
 * Contrôles de l'agenda manuel — mêmes messages qu'avant la primitive.
 * `accountId` (lot 49) : appartenance des références vérifiée d'abord.
 */
export async function validateAgendaWrite(
  dates: { startDate?: string | null; startTime?: string | null; endDate?: string | null; endTime?: string | null },
  links: Required<AgendaItemLinks>,
  accountId?: number,
): Promise<void> {
  if (accountId !== undefined) await assertAgendaRefsInAccount(accountId, links, undefined);
  const temporalErrors = validateTemporalConstraints(dates);
  if (temporalErrors.length > 0) {
    throw new AgendaValidationError(`Validation temporelle : ${temporalErrors.map((e) => e.message).join(', ')}`);
  }
  const { fileLinks, roomLinks, equipmentLinks } = await resolveIndirectLinks(links.fileIds, links.substructureIds, links.equipmentIds);
  const linkErrors = validateLinkCoherence(links.assetIds, fileLinks, roomLinks, equipmentLinks);
  if (linkErrors.length > 0) {
    throw new AgendaValidationError(`Cohérence des liens : ${linkErrors.map((e) => e.message).join(', ')}`);
  }
}

/**
 * Liaisons de l'élément : remplacées (état complet) ou ajoutées.
 * Lot 49 : références contrôlées (compte) dans la transaction AVANT toute
 * écriture ; `replace` ne retire que les liens vers des objets du compte.
 */
export async function writeAgendaLinks(
  tx: any,
  agendaItemId: number,
  links: AgendaItemLinks,
  mode: 'replace' | 'add',
  accountId: number,
  /**
   * Lot 82D (CDC v5 §7.4) : provenance des liens DOCUMENT écrits (agenda
   * manuel : MANUAL_DIRECT ; T4 : AI_DIRECT). Liens documents : `fileIds`
   * absent = inchangés (la propagation vers le principal relève du service de
   * regroupement) ; en `replace`, un document retiré par l'UTILISATEUR perd
   * toutes ses provenances (le refus de propagation est mémorisé) ; retiré
   * par T4, seule la provenance AI_DIRECT est retirée.
   */
  fileProvenance: 'MANUAL_DIRECT' | 'AI_DIRECT' = 'MANUAL_DIRECT',
): Promise<void> {
  const assetIds = links.assetIds ?? [];
  const fileIds = links.fileIds ?? [];
  const substructureIds = links.substructureIds ?? [];
  const equipmentIds = links.equipmentIds ?? [];
  await assertAgendaRefsInAccount(accountId, links, undefined, tx);
  if (mode === 'replace') {
    const biensDuCompte = tx.select({ id: assets.id }).from(assets).where(eq(assets.accountId, accountId));
    await Promise.all([
      tx.delete(agendaAssetLinks).where(and(eq(agendaAssetLinks.agendaItemId, agendaItemId), inArray(agendaAssetLinks.assetId, biensDuCompte))),
      tx.delete(agendaRoomLinks).where(and(eq(agendaRoomLinks.agendaItemId, agendaItemId),
        inArray(agendaRoomLinks.substructureId, tx.select({ id: substructures.id }).from(substructures).where(inArray(substructures.assetId, biensDuCompte))))),
      tx.delete(agendaEquipmentLinks).where(and(eq(agendaEquipmentLinks.agendaItemId, agendaItemId),
        inArray(agendaEquipmentLinks.equipmentId, tx.select({ id: equipments.id }).from(equipments).where(inArray(equipments.assetId, biensDuCompte))))),
    ]);
  }
  if (assetIds.length > 0) {
    await tx.insert(agendaAssetLinks).values(assetIds.map((id) => ({ agendaItemId, assetId: id }))).onConflictDoNothing();
  }
  if (links.fileIds !== undefined && (mode === 'replace' || fileIds.length > 0)) {
    const runner = drizzleRunner(tx);
    if (mode === 'replace') {
      const user = fileProvenance === 'MANUAL_DIRECT';
      const { removedPrincipalFileIds, removedFileIds } = await replaceDirectFileLinks(runner, agendaItemId, fileIds, fileProvenance, accountId, { userRemovesAll: user });
      // Lot 86D (ticket « Documents / Agenda » §5) : décisions de l'utilisateur mémorisées sur le LIEN —
      // document retiré : détachement (aucune provenance automatique ne le recrée) ; document présent : rattachement
      // explicite (lève un détachement antérieur).
      if (user) {
        for (const fileId of removedFileIds) {
          await recordLinkDecision(runner, { accountId, itemId: agendaItemId, fileId, decision: 'REJECTED', reasonCode: 'USER_AGENDA_LINK_REMOVED' });
        }
        await liftLinkRejections(runner, accountId, agendaItemId, fileIds);
      }
      // Lien propagé retiré par l'utilisateur : la propagation ne le recrée pas (§10).
      if (user && removedPrincipalFileIds.length) {
        const [it] = (await tx.execute(sql`SELECT business_operation_id AS op FROM agenda_items WHERE id = ${agendaItemId} AND account_id = ${accountId}`)) as Array<{ op: number | null }>;
        if (it?.op != null) {
          for (const fileId of removedPrincipalFileIds) {
            await recordGroupingDecision(runner, { accountId, operationId: Number(it.op), subject: 'PRINCIPAL_LINK', entityId: fileId, decision: 'REJECTED', reasonCode: 'USER_AGENDA_LINK_REMOVED' });
          }
        }
      }
    } else {
      await addFileLinkProvenance(runner, agendaItemId, fileIds, fileProvenance);
    }
  }
  if (substructureIds.length > 0) {
    await tx.insert(agendaRoomLinks).values(substructureIds.map((id) => ({ agendaItemId, substructureId: id }))).onConflictDoNothing();
  }
  if (equipmentIds.length > 0) {
    await tx.insert(agendaEquipmentLinks).values(equipmentIds.map((id) => ({ agendaItemId, equipmentId: id }))).onConflictDoNothing();
  }
}

/**
 * Écrit un élément d'agenda (création ou mise à jour). Voir l'en-tête.
 * Lève `AgendaValidationError` (contrôles) — rien n'est écrit dans ce cas.
 */
export async function writeAgendaItem(
  input: AgendaItemWriteInput,
  opts: WriteAgendaItemOptions,
): Promise<WriteAgendaItemResult> {
  const effets = await agendaFunctionalColumnsReady();

  const semantics = resolveEventSemantics({
    originFieldKey: (input.values.originFieldKey as string | null | undefined) ?? null,
    businessType: input.semantics?.businessType ?? null,
    nature: input.semantics?.nature ?? null,
  });

  if (opts.validate) {
    await validateAgendaWrite(
      { startDate: input.values.startDate, startTime: input.values.startTime, endDate: input.values.endDate, endTime: input.values.endTime },
      {
        assetIds: input.links?.assetIds ?? [], fileIds: input.links?.fileIds ?? [],
        substructureIds: input.links?.substructureIds ?? [], equipmentIds: input.links?.equipmentIds ?? [],
      },
      // Lot 49 : appartenance d'abord (aucune règle métier évaluée sur un
      // objet d'un autre compte) ; recontrôlée dans la transaction.
      opts.accountId,
    );
  }

  const creation = input.itemId === undefined;
  const id = await (opts.client ?? db).transaction(async (tx): Promise<number | null> => {
    // SÉCURITÉ (lot 49, SEC-07) : toujours, même avec `validate: false`, dans
    // la transaction et AVANT toute écriture — refus entier sinon.
    await assertAgendaRefsInAccount(opts.accountId, input.links, input.sources, tx as unknown as SqlExecutor);
    let itemId: number;
    if (creation) {
      const [inserted] = await tx.insert(agendaItems)
        .values({ ...(input.values as AgendaItemValues), accountId: opts.accountId } as ItemInsert)
        .returning({ id: agendaItems.id });
      itemId = inserted.id;
    } else {
      itemId = input.itemId!;
      const touchees = await tx.update(agendaItems).set(input.values as never)
        .where(and(
          eq(agendaItems.id, itemId), eq(agendaItems.accountId, opts.accountId),
          ...(opts.onlyIfUntouched ? [
            eq(agendaItems.isAutomaticModified, false),
            or(isNull(agendaItems.manualStatus), eq(agendaItems.manualStatus, '')),
            // Lot 75F (§A) : prévision confirmée par l'utilisateur — protégée.
            sql`${agendaItems.confirmationMode} IS DISTINCT FROM 'USER'`,
          ] : []),
        ))
        .returning({ id: agendaItems.id });
      // Élément modifié par l'utilisateur entre le plan et l'écriture : protégé.
      if (opts.onlyIfUntouched && touchees.length === 0) return null;
      // Élément d'un autre compte (ou disparu) : aucun lien n'est écrit.
      if (touchees.length === 0) throw new AgendaValidationError('Validation : élément introuvable dans le compte');
    }
    if (input.links) await writeAgendaLinks(tx, itemId, input.links, opts.linkMode ?? 'replace', opts.accountId, opts.channel === 'T4' ? 'AI_DIRECT' : 'MANUAL_DIRECT');

    if (effets) {
      // Colonnes 0223 (non déclarées dans Drizzle) : SQL direct, même transaction.
      await tx.execute(sql`UPDATE agenda_items
          SET event_nature = COALESCE(${semantics.nature}, event_nature),
              business_type = COALESCE(${semantics.businessType}, business_type),
              functional_key = COALESCE(${input.functionalKey ?? null}, functional_key)
        WHERE id = ${itemId} AND account_id = ${opts.accountId}`);
      await recordAgendaItemSources(tx, itemId, input.sources ?? [], opts.channel === 'T4' ? 'AI_DIRECT' : 'MANUAL_DIRECT');
    }
    return itemId;
  });

  if (id === null) {
    console.info(`[agenda] élément ${input.itemId} modifié par l'utilisateur — mise à jour automatique sans effet`);
    return {
      id: input.itemId!, created: false, protected: true, nature: semantics.nature, businessType: semantics.businessType,
      notifiable: false, functionalKey: input.functionalKey ?? null,
    };
  }

  if (opts.purchaseSync) {
    await syncPurchaseDate({
      itemId: id, accountId: opts.accountId, actorUserId: opts.actorUserId ?? null,
      manualStatus: opts.purchaseSync.manualStatus, businessType: semantics.businessType,
    });
  }

  const notifiable = semantics.notifiable;
  if (opts.notify && creation && notifiable && (input.links?.assetIds ?? []).length > 0) {
    // Lot 82B : événement métier publié directement (l'ancien relais par la file
    // `impact_queue`, sans plus aucune règle à appliquer, est retiré — C-Q9).
    await publierCreationAgenda(opts.accountId, id);
  }

  // D-15 : un événement historique « vente » ou « sinistre » créé
  // propose le changement de statut du bien (carte À traiter ASSET-STATUS) ;
  // le statut n'est JAMAIS écrit automatiquement. Non bloquant.
  if (effets && creation && !opts.client && opts.statusProposal !== false && semantics.nature === 'HISTORICAL' && semantics.businessType) {
    const assetIds = input.links?.assetIds ?? [];
    if (assetIds.length > 0) {
      const { proposeAssetStatusChange, ASSET_STATUS_BY_EVENT } = await import('@/services/to-process/agenda-status-cards');
      if (ASSET_STATUS_BY_EVENT[semantics.businessType]) {
        for (const assetId of assetIds) {
          await proposeAssetStatusChange({
            accountId: opts.accountId, assetId, agendaItemId: id, businessType: semantics.businessType,
          }).catch((e: Error) => console.error(`[agenda] proposition de statut du bien ${assetId} :`, e.message));
        }
      }
    }
  }

  return {
    id, created: creation, nature: semantics.nature, businessType: semantics.businessType,
    notifiable, functionalKey: input.functionalKey ?? null,
  };
}

// ── Recopie « achat » (D-13) ────────────────────────────────────────────────

const estAchat = (title: string, businessType: string | null) =>
  businessType === 'purchase' || title.toLowerCase().includes('achat');

/**
 * Recopie de la date d'un événement « achat » vers la date d'acquisition du
 * bien lié (D-13) : jamais pour un événement AUTOMATIQUE (la date
 *   d'acquisition relève de T3, pas de l'agenda) ; pour un événement MANUEL
 *   réalisé (statut « réalisé », ou date passée sans statut), d'achat, et
 *   seulement si le champ est vide — par `writeCanonicalAssetField`
 *   (`acquisitionDate`, origine USER, valeur attendue vide).
 */
export async function syncPurchaseDate(p: {
  itemId: number;
  accountId: number;
  actorUserId: number | null;
  manualStatus?: 'realise' | 'annule' | null;
  businessType?: string | null;
}): Promise<void> {
  const [item] = await db.select({
    title: agendaItems.title, startDate: agendaItems.startDate, isAutomatic: agendaItems.isAutomatic,
    manualStatus: agendaItems.manualStatus,
  }).from(agendaItems).where(and(eq(agendaItems.id, p.itemId), eq(agendaItems.accountId, p.accountId))).limit(1);
  if (!item || !item.title || !item.startDate) return;

  const links = await db.select({ assetId: agendaAssetLinks.assetId })
    .from(agendaAssetLinks).where(eq(agendaAssetLinks.agendaItemId, p.itemId));
  // Lot 71A (BUG P1 bien / équipement) : équipements liés à l'événement, bornés au compte.
  const equipementsLies = await db.select({ id: equipments.id, assetId: equipments.assetId })
    .from(agendaEquipmentLinks)
    .innerJoin(equipments, eq(equipments.id, agendaEquipmentLinks.equipmentId))
    .innerJoin(assets, and(eq(assets.id, equipments.assetId), eq(assets.accountId, p.accountId)))
    .where(eq(agendaEquipmentLinks.agendaItemId, p.itemId));

  if (!purchaseSyncAllowed(item, p.businessType ?? null)) return;
  const cibles = purchaseSyncTargets(links.map((l) => l.assetId), equipementsLies);
  if (cibles.equipmentIds.length) {
    // Achat d'un ÉQUIPEMENT : sa date d'achat (vide seulement), jamais celle du bien.
    const { writeCanonicalEntityField } = await import('@/services/canonical/entity-state');
    for (const id of cibles.equipmentIds) {
      await writeCanonicalEntityField({
        target: { type: 'EQUIPMENT', id }, accountId: p.accountId, key: 'acquisitionDate', value: item.startDate, origin: 'USER',
        expectedCurrent: null, actorUserId: p.actorUserId, source: { type: 'agenda_item', id: p.itemId },
      }).catch((e: Error) => console.error('[agenda] recopie « achat » (équipement) :', e.message));
    }
  }
  const { writeCanonicalAssetField } = await import('@/services/canonical/asset-state');
  for (const assetId of cibles.assetIds) {
    // Valeur attendue vide : si une date d'acquisition existe (fiche,
    // colonne ou alias), rien n'est écrit (conflit optimiste).
    const ecrit = await writeCanonicalAssetField({
      assetId, accountId: p.accountId, key: 'acquisitionDate', value: item.startDate, origin: 'USER',
      expectedCurrent: null, actorUserId: p.actorUserId, source: { type: 'agenda_item', id: p.itemId },
    }).catch((e: Error) => { console.error('[agenda] recopie « achat » :', e.message); return null; });
    // Lot 46 (O7) : date d'acquisition saisie → TRG-008 (`asset_updated`),
    // comme une saisie sur la fiche. La projection de l'ACQUISITION qui en
    // résulte RELIE cet événement (rapprochement C16.1) sans le réécrire ni
    // redéclencher T3 : la boucle agenda → fiche → T3 → agenda s'arrête là.
    if (ecrit?.field?.outcome === 'written') {
      const { notifyOperationsEvent } = await import('@/services/business-operations/consolidation/queue');
      notifyOperationsEvent(p.accountId, { trigger: 'asset_updated', assetId });
    }
  }
}

/**
 * Lot 71A (BUG P1) — cibles de la recopie « achat » (pure) : un événement lié
 * à un ou plusieurs ÉQUIPEMENTS d'un bien est l'achat de ces équipements —
 * leur date d'achat, JAMAIS celle du bien porteur ; un bien lié sans aucun de
 * ses équipements reçoit la date (règle D-13 inchangée).
 */
export function purchaseSyncTargets(
  assetIds: readonly number[],
  linkedEquipments: ReadonlyArray<{ id: number; assetId: number }>,
): { assetIds: number[]; equipmentIds: number[] } {
  const biensDesEquipements = new Set(linkedEquipments.map((e) => e.assetId));
  return {
    assetIds: [...new Set(assetIds)].filter((a) => !biensDesEquipements.has(a)),
    equipmentIds: [...new Set(linkedEquipments.map((e) => e.id))],
  };
}

/** D-13 : événement manuel, d'achat, réalisé (statut, ou date passée sans statut). */
export function purchaseSyncAllowed(
  item: { title: string; startDate: string | null; isAutomatic: boolean; manualStatus: string | null },
  businessType: string | null,
  today: string = new Date().toISOString().slice(0, 10),
): boolean {
  if (item.isAutomatic || !item.startDate || !estAchat(item.title, businessType)) return false;
  if (item.manualStatus === 'annule') return false;
  return item.manualStatus === 'realise' || item.startDate <= today;
}

// ── Effets d'après validation, pour une écriture faite dans la transaction
// d'un appelant (résolution d'une carte « À traiter ») ────────────────────

/**
 * Mêmes effets que `writeAgendaItem` hors transaction englobante, à appeler
 * APRÈS la validation de celle-ci (relecture de lot 14) :
 *   · D-13 recopie « achat » (création, ou élément marqué réalisé) ;
 *   · D-15 proposition de statut du bien (événement historique « vente » /
 *     « sinistre » créé, ou marqué réalisé) ;
 *   · notification de création (D-14 : jamais un HISTORICAL).
 * Ne lève jamais.
 */
export async function agendaEffectsAfterCommit(p: {
  accountId: number;
  itemId: number;
  actorUserId: number | null;
  created: boolean;
  manualStatus?: 'realise' | 'annule' | null;
}): Promise<void> {
  try {
    let nature: string | null = null;
    let businessType: string | null = null;
    if (await agendaFunctionalColumnsReady()) {
      const { pgClient } = await import('@/db');
      const [r] = (await pgClient.unsafe(
        `SELECT event_nature AS n, business_type AS b FROM agenda_items WHERE id = $1 AND account_id = $2`,
        [p.itemId, p.accountId] as never[],
      )) as unknown as Array<{ n: string | null; b: string | null }>;
      nature = r?.n ?? null;
      businessType = r?.b ?? null;
    }
    if (p.created || p.manualStatus === 'realise') {
      await syncPurchaseDate({
        itemId: p.itemId, accountId: p.accountId, actorUserId: p.actorUserId,
        ...(p.created ? {} : { manualStatus: p.manualStatus }), businessType,
      });
    }
    const assetIds = (await db.select({ assetId: agendaAssetLinks.assetId }).from(agendaAssetLinks)
      .where(eq(agendaAssetLinks.agendaItemId, p.itemId))).map((r) => r.assetId);
    if (businessType && ((p.created && nature === 'HISTORICAL') || p.manualStatus === 'realise')) {
      const { proposeAssetStatusChange, ASSET_STATUS_BY_EVENT } = await import('@/services/to-process/agenda-status-cards');
      if (ASSET_STATUS_BY_EVENT[businessType]) {
        for (const assetId of assetIds) {
          await proposeAssetStatusChange({ accountId: p.accountId, assetId, agendaItemId: p.itemId, businessType });
        }
      }
    }
    if (p.created && nature !== 'HISTORICAL' && assetIds.length > 0) await publierCreationAgenda(p.accountId, p.itemId);
  } catch (e) {
    console.error(`[agenda] effets après validation de l'élément ${p.itemId} :`, (e as Error).message);
  }
}

/**
 * Événement métier AGENDA_ITEM_CREATED (CDC Assistant §25.7 : caches, mascotte,
 * contrôle de cohérence ciblé). Import différé, jamais bloquant.
 */
async function publierCreationAgenda(accountId: number, itemId: number): Promise<void> {
  try {
    const { emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
    // Émis sans être attendu : l'écriture d'agenda ne patiente pas pour ses abonnés.
    void emitBusinessEvent({ type: 'AGENDA_ITEM_CREATED', accountId, entityId: itemId }).catch(() => { /* non bloquant */ });
  } catch { /* non bloquant */ }
}
