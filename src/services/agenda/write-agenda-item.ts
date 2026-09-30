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
 *   3. AI_T4_EFFECTS=enabled (0223 présente) : clé fonctionnelle, nature
 *      HISTORICAL | DEADLINE et type métier ; liens source canoniques
 *      (`agenda_file_links`, service unique `agenda-source-links`) ;
 *   4. après validation : recopie « achat » (D-13) et notification.
 *
 * Modes (`AI_T4_EFFECTS`) :
 *   legacy   comportement historique des deux chemins, à l'identique : même
 *            ligne, mêmes liaisons, même recopie « achat » (titre contenant
 *            « achat » → `purchase_date` vide), même notification ;
 *   shadow   comme legacy ; ce qui serait écrit en plus (clé, nature, liens
 *            source, recopie D-13) est journalisé (`t4.agenda_write`) ;
 *   enabled  3 et D-13 : la recopie n'a lieu que pour un événement MANUEL
 *            réalisé, d'achat, sur un champ vide — par `writeCanonicalAssetField`
 *            (origine USER) quand CANONICAL_WRITE_MODE=enabled ; un élément
 *            HISTORICAL n'est jamais notifié (D-14).
 */
import { db } from '@/db';
import {
  agendaItems, agendaAssetLinks, agendaFileLinks, agendaRoomLinks, agendaEquipmentLinks,
  assetFiles, substructures, equipments, assets,
} from '@/db/schema';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { validateTemporalConstraints, validateLinkCoherence, type ResolvedLink } from './AgendaDomainService';
import { t4EffectsMode, canonicalWriteMode, type RolloutMode } from '@/services/canonical/rollout';
import { agendaFunctionalColumnsReady } from './agenda-columns';
import { recordAgendaItemSources, type AgendaSourceRef } from './agenda-source-links';
import { resolveEventSemantics, type AgendaEventNature } from './agenda-functional-key';

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
  /** Force un mode (tests) ; défaut : `AI_T4_EFFECTS`. */
  mode?: RolloutMode;
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
}

export interface WriteAgendaItemResult {
  id: number;
  created: boolean;
  nature: AgendaEventNature | null;
  businessType: string | null;
  /** D-14 : faux pour un élément HISTORICAL (enabled). */
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

/** Contrôles de l'agenda manuel — mêmes messages qu'avant la primitive. */
export async function validateAgendaWrite(
  dates: { startDate?: string | null; startTime?: string | null; endDate?: string | null; endTime?: string | null },
  links: Required<AgendaItemLinks>,
): Promise<void> {
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

/** Liaisons de l'élément : remplacées (état complet) ou ajoutées. */
export async function writeAgendaLinks(
  tx: any,
  agendaItemId: number,
  links: AgendaItemLinks,
  mode: 'replace' | 'add',
): Promise<void> {
  const assetIds = links.assetIds ?? [];
  const fileIds = links.fileIds ?? [];
  const substructureIds = links.substructureIds ?? [];
  const equipmentIds = links.equipmentIds ?? [];
  if (mode === 'replace') {
    await Promise.all([
      tx.delete(agendaAssetLinks).where(eq(agendaAssetLinks.agendaItemId, agendaItemId)),
      tx.delete(agendaFileLinks).where(eq(agendaFileLinks.agendaItemId, agendaItemId)),
      tx.delete(agendaRoomLinks).where(eq(agendaRoomLinks.agendaItemId, agendaItemId)),
      tx.delete(agendaEquipmentLinks).where(eq(agendaEquipmentLinks.agendaItemId, agendaItemId)),
    ]);
  }
  if (assetIds.length > 0) {
    await tx.insert(agendaAssetLinks).values(assetIds.map((id) => ({ agendaItemId, assetId: id }))).onConflictDoNothing();
  }
  if (fileIds.length > 0) {
    await tx.insert(agendaFileLinks).values(fileIds.map((id) => ({ agendaItemId, assetFileId: id }))).onConflictDoNothing();
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
  const mode = opts.mode ?? t4EffectsMode();
  const effets = mode === 'enabled' && await agendaFunctionalColumnsReady();

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
    );
  }

  const creation = input.itemId === undefined;
  const id = await (opts.client ?? db).transaction(async (tx): Promise<number | null> => {
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
          ] : []),
        ))
        .returning({ id: agendaItems.id });
      // Élément modifié par l'utilisateur entre le plan et l'écriture : protégé.
      if (opts.onlyIfUntouched && touchees.length === 0) return null;
    }
    if (input.links) await writeAgendaLinks(tx, itemId, input.links, opts.linkMode ?? 'replace');

    if (effets) {
      // Colonnes 0223 (non déclarées dans Drizzle) : SQL direct, même transaction.
      await tx.execute(sql`UPDATE agenda_items
          SET event_nature = COALESCE(${semantics.nature}, event_nature),
              business_type = COALESCE(${semantics.businessType}, business_type),
              functional_key = COALESCE(${input.functionalKey ?? null}, functional_key)
        WHERE id = ${itemId} AND account_id = ${opts.accountId}`);
      await recordAgendaItemSources(tx, itemId, input.sources ?? []);
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

  if (mode === 'shadow') {
    console.info(JSON.stringify({
      event: 't4.agenda_write', mode, channel: opts.channel, accountId: opts.accountId, itemId: id, created: creation,
      wouldSet: { nature: semantics.nature, businessType: semantics.businessType, functionalKey: input.functionalKey ?? null },
      wouldLinkSources: (input.sources ?? []).map((x) => ({ fileId: x.fileId, role: x.role })), dryRun: true,
    }));
  }

  if (opts.purchaseSync) {
    await syncPurchaseDate({
      itemId: id, accountId: opts.accountId, actorUserId: opts.actorUserId ?? null, mode,
      manualStatus: opts.purchaseSync.manualStatus, businessType: semantics.businessType,
    });
  }

  const notifiable = mode === 'enabled' ? semantics.notifiable : true;
  if (opts.notify && creation && notifiable) {
    const { emitAgendaItemCreated } = await import('@/services/coherence/impact-propagation.service');
    for (const aid of input.links?.assetIds ?? []) {
      emitAgendaItemCreated(opts.accountId, aid, id).catch(() => {});
    }
  }

  // D-15 : un événement historique « vente » ou « sinistre » créé en enabled
  // propose le changement de statut du bien (carte À traiter ASSET-STATUS) ;
  // le statut n'est JAMAIS écrit automatiquement. Non bloquant.
  if (effets && creation && !opts.client && semantics.nature === 'HISTORICAL' && semantics.businessType) {
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
 * bien lié.
 *
 *   legacy / shadow : comportement historique À L'IDENTIQUE — titre
 *   contenant « achat », création / édition ou marqué réalisé, recopie vers
 *   `purchase_date` des biens liés qui n'en ont pas (écriture directe) ;
 *   en shadow, la règle D-13 est en plus évaluée et journalisée.
 *
 *   enabled (D-13) : jamais pour un événement AUTOMATIQUE (la date
 *   d'acquisition relève de T3, pas de l'agenda) ; pour un événement MANUEL
 *   réalisé (statut « réalisé », ou date passée sans statut), d'achat, et
 *   seulement si le champ est vide — par `writeCanonicalAssetField`
 *   (`acquisitionDate`, origine USER, valeur attendue vide) quand
 *   CANONICAL_WRITE_MODE=enabled, sinon par la recopie historique.
 */
export async function syncPurchaseDate(p: {
  itemId: number;
  accountId: number;
  actorUserId: number | null;
  mode: RolloutMode;
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

  if (p.mode !== 'enabled') {
    // Historique, inchangé.
    if (item.title.toLowerCase().includes('achat')
      && (p.manualStatus === undefined || p.manualStatus === 'realise' || p.manualStatus === null)) {
      for (const { assetId } of links) {
        await db.update(assets).set({ purchaseDate: item.startDate })
          .where(and(eq(assets.id, assetId), isNull(assets.purchaseDate)));
      }
    }
    if (p.mode === 'shadow') {
      console.info(JSON.stringify({
        event: 't4.purchase_sync', mode: 'shadow', itemId: p.itemId,
        wouldSync: purchaseSyncAllowed(item, p.businessType ?? null), dryRun: true,
      }));
    }
    return;
  }

  if (!purchaseSyncAllowed(item, p.businessType ?? null)) return;
  for (const { assetId } of links) {
    if (canonicalWriteMode() === 'enabled') {
      const { writeCanonicalAssetField } = await import('@/services/canonical/asset-state');
      // Valeur attendue vide : si une date d'acquisition existe (fiche,
      // colonne ou alias), rien n'est écrit (conflit optimiste).
      await writeCanonicalAssetField({
        assetId, accountId: p.accountId, key: 'acquisitionDate', value: item.startDate, origin: 'USER',
        expectedCurrent: null, actorUserId: p.actorUserId, source: { type: 'agenda_item', id: p.itemId }, mode: 'enabled',
      }).catch((e: Error) => console.error('[agenda] recopie « achat » :', e.message));
    } else {
      await db.update(assets).set({ purchaseDate: item.startDate })
        .where(and(eq(assets.id, assetId), eq(assets.accountId, p.accountId), isNull(assets.purchaseDate)));
    }
  }
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
 *   · D-15 proposition de statut du bien (enabled : événement historique
 *     « vente » / « sinistre » créé, ou marqué réalisé) ;
 *   · notification de création (D-14 : jamais un HISTORICAL en enabled).
 * Ne lève jamais.
 */
export async function agendaEffectsAfterCommit(p: {
  accountId: number;
  itemId: number;
  actorUserId: number | null;
  created: boolean;
  manualStatus?: 'realise' | 'annule' | null;
  mode?: RolloutMode;
}): Promise<void> {
  const mode = p.mode ?? t4EffectsMode();
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
        itemId: p.itemId, accountId: p.accountId, actorUserId: p.actorUserId, mode,
        ...(p.created ? {} : { manualStatus: p.manualStatus }), businessType,
      });
    }
    const assetIds = (await db.select({ assetId: agendaAssetLinks.assetId }).from(agendaAssetLinks)
      .where(eq(agendaAssetLinks.agendaItemId, p.itemId))).map((r) => r.assetId);
    if (mode === 'enabled' && businessType && ((p.created && nature === 'HISTORICAL') || p.manualStatus === 'realise')) {
      const { proposeAssetStatusChange, ASSET_STATUS_BY_EVENT } = await import('@/services/to-process/agenda-status-cards');
      if (ASSET_STATUS_BY_EVENT[businessType]) {
        for (const assetId of assetIds) {
          await proposeAssetStatusChange({ accountId: p.accountId, assetId, agendaItemId: p.itemId, businessType });
        }
      }
    }
    if (p.created && !(mode === 'enabled' && nature === 'HISTORICAL')) {
      const { emitAgendaItemCreated } = await import('@/services/coherence/impact-propagation.service');
      for (const assetId of assetIds) await emitAgendaItemCreated(p.accountId, assetId, p.itemId).catch(() => {});
    }
  } catch (e) {
    console.error(`[agenda] effets après validation de l'élément ${p.itemId} :`, (e as Error).message);
  }
}
