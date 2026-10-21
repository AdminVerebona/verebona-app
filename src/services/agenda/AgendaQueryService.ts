/**
 * AgendaQueryService — read-only DB queries
 */
import { db } from '@/db';
import {
  agendaItems, agendaAssetLinks, agendaFileLinks, agendaRoomLinks, agendaEquipmentLinks,
  agendaDataConflicts, assets, assetFiles, substructures, equipments, agendaItemSources,
} from '@/db/schema';
import { eq, and, or, isNull, isNotNull, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { computeEffectiveStatus, computeAttentionFlags, type EffectiveStatus, type AttentionFlag } from './AgendaDomainService';
import { agendaFunctionalColumnsReady } from './agenda-columns';
import { listAgendaItemIdsForSource, SOURCE_LINK_EFFECTS } from './agenda-source-links';
import {
  countItemsByEquipment, filterItemsByEquipment, listEquipmentsOfAssets,
} from '@/services/equipments/equipment-filter-scope';
import { isEquipmentFilterActive, type EquipmentFacet } from '@/lib/filters/equipment-filter';
import { selectedRoomId, type RoomFacet } from '@/lib/filters/room-filter';
import { agendaItemIdsByRoom, listRoomsOfAssets, type AssetRoom } from '@/services/rooms/room-scope.service';

export interface AgendaQueryParams {
  accountId: number;
  assetIds?: number[];
  fileId?: number;
  period?: 'all' | 'past' | 'today' | 'upcoming';
  includeCancelled?: boolean;
  month?: string; // 'YYYY-MM'
  year?: string;  // 'YYYY'
  includeUndated?: boolean;
  /**
   * Lot 71 (71C) — filtre « Équipement » (`asset` | identifiant ; absent ou
   * `all` = tous). Sans effet sans `assetIds` ou si ces biens n'ont aucun
   * équipement. Voir `lib/filters/equipment-filter.ts`.
   */
  equipment?: string;
  /**
   * Lot 75 (75B) — filtre « Pièce » (identifiant ; absent = toutes) :
   * échéances liées à la pièce, à ses équipements ou à ses documents (directs
   * ou via un équipement). Sans effet sans `assetIds`. Voir
   * `services/rooms/room-scope.service.ts`.
   */
  piece?: string;
}

export interface AgendaItemFull {
  id: number;
  publicId: string;
  accountId: number;
  createdByUserId: number | null;
  title: string;
  description: string | null;
  startDate: string | null;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  manualStatus: 'realise' | 'annule' | null;
  effectiveStatus: EffectiveStatus;
  isAutomatic: boolean;
  isAutomaticModified: boolean;
  requiresQualification: boolean;
  originType: string;
  originRefType: string | null;
  originRefId: number | null;
  originFieldKey: string | null;
  /**
   * Nature de l'occurrence — FORECAST (date estimée d'une récurrence) ou
   * CONFIRMED. Indépendante de l'état temporel (`effectiveStatus`).
   */
  occurrenceNature: 'FORECAST' | 'CONFIRMED';
  /** Date prévisionnelle d'origine, conservée après confirmation. */
  forecastInitialDate: string | null;
  confirmedAt: Date | null;
  confirmationMode: string | null;
  /** Règle de récurrence ayant produit la prévision (libellé). */
  recurrenceRule: string | null;
  /**
   * Lot 77A : tâche « Sans échéance » déclarée par l'utilisateur (aucune date
   * à réclamer). Toujours renseignée par `enrichItems` ; optionnelle pour les
   * objets construits ailleurs (tests, projections).
   */
  noDeadline?: boolean;
  createdAt: Date;
  updatedAt: Date;
  assetLinks: { id: number; assetId: number; assetName: string }[];
  fileLinks: { id: number; assetFileId: number; filename: string | null; retainedTitle: string | null; originalFilename: string | null; resolvedAssetId: number | null }[];
  roomLinks: { id: number; substructureId: number; name: string; resolvedAssetId: number | null }[];
  equipmentLinks: { id: number; equipmentId: number; name: string; resolvedAssetId: number | null }[];
  attentionFlags: AttentionFlag[];
  /**
   * HISTORICAL | DEADLINE (0223, CDC 15 D-14) — renseigné quand la
   * migration 0223 est appliquée ; absent sinon.
   */
  eventNature?: 'HISTORICAL' | 'DEADLINE' | null;
  /**
   * Lot 46 (O7) : l'événement représente un SINISTRE (projeté depuis lui, ou
   * relié) — le tiroir propose de l'ouvrir dans la rubrique Sinistres du bien.
   */
  claimSource?: { assetId: number; claimId: number } | null;
}

export interface AgendaSearchResult {
  type: 'agenda';
  id: number;
  publicId: string;
  title: string;
  effectiveStatus: EffectiveStatus;
  contextLabel: string;
}

/**
 * Liens des éléments. Lot 49 (SEC-07) : seul un objet du COMPTE DE
 * L'ÉLÉMENT est rendu — une association incorrecte déjà en base (bien,
 * document, pièce ou équipement d'un autre compte) n'est jamais exposée.
 */
async function loadLinks(itemIds: number[]) {
  if (itemIds.length === 0) return { assetLinks: [], fileLinks: [], roomLinks: [], equipLinks: [] };
  const bienPorteur = alias(assets, 'bien_porteur');

  const [assetLinksRows, fileLinksRows, aiFileLinksRows, roomLinksRows, equipLinksRows] = await Promise.all([
    db.select({
      id: agendaAssetLinks.id,
      agendaItemId: agendaAssetLinks.agendaItemId,
      assetId: agendaAssetLinks.assetId,
      assetName: assets.name,
    })
    .from(agendaAssetLinks)
    .innerJoin(agendaItems, eq(agendaItems.id, agendaAssetLinks.agendaItemId))
    .innerJoin(assets, and(eq(agendaAssetLinks.assetId, assets.id), eq(assets.accountId, agendaItems.accountId)))
    .where(inArray(agendaAssetLinks.agendaItemId, itemIds)),

    db.select({
      id: agendaFileLinks.id,
      agendaItemId: agendaFileLinks.agendaItemId,
      assetFileId: agendaFileLinks.assetFileId,
      filename: assetFiles.filename,
      retainedTitle: assetFiles.retainedTitle,
      originalFilename: assetFiles.originalFilename,
      resolvedAssetId: assetFiles.assetId,
    })
    .from(agendaFileLinks)
    .innerJoin(agendaItems, eq(agendaItems.id, agendaFileLinks.agendaItemId))
    .innerJoin(assetFiles, and(eq(agendaFileLinks.assetFileId, assetFiles.id), eq(assetFiles.accountId, agendaItems.accountId)))
    .where(inArray(agendaFileLinks.agendaItemId, itemIds)),

    // AI-sourced links from document analysis (created or resolved_existing)
    db.select({
      id: agendaItemSources.id,
      agendaItemId: agendaItemSources.agendaItemId,
      assetFileId: agendaItemSources.assetFileId,
      filename: assetFiles.filename,
      retainedTitle: assetFiles.retainedTitle,
      originalFilename: assetFiles.originalFilename,
      resolvedAssetId: assetFiles.assetId,
    })
    .from(agendaItemSources)
    .innerJoin(agendaItems, eq(agendaItems.id, agendaItemSources.agendaItemId))
    .innerJoin(assetFiles, and(eq(agendaItemSources.assetFileId, assetFiles.id), eq(assetFiles.accountId, agendaItems.accountId)))
    .where(and(
      isNotNull(agendaItemSources.agendaItemId),
      inArray(agendaItemSources.agendaItemId, itemIds),
      // 'linked' : liens du service unique (0223), seulement écrits en enabled.
      inArray(agendaItemSources.effectType, [...SOURCE_LINK_EFFECTS]),
    )),

    db.select({
      id: agendaRoomLinks.id,
      agendaItemId: agendaRoomLinks.agendaItemId,
      substructureId: agendaRoomLinks.substructureId,
      name: substructures.name,
      resolvedAssetId: substructures.assetId,
    })
    .from(agendaRoomLinks)
    .innerJoin(agendaItems, eq(agendaItems.id, agendaRoomLinks.agendaItemId))
    .innerJoin(substructures, eq(agendaRoomLinks.substructureId, substructures.id))
    .innerJoin(bienPorteur, and(eq(bienPorteur.id, substructures.assetId), eq(bienPorteur.accountId, agendaItems.accountId)))
    .where(inArray(agendaRoomLinks.agendaItemId, itemIds)),

    db.select({
      id: agendaEquipmentLinks.id,
      agendaItemId: agendaEquipmentLinks.agendaItemId,
      equipmentId: agendaEquipmentLinks.equipmentId,
      name: equipments.name,
      resolvedAssetId: equipments.assetId,
    })
    .from(agendaEquipmentLinks)
    .innerJoin(agendaItems, eq(agendaItems.id, agendaEquipmentLinks.agendaItemId))
    .innerJoin(equipments, eq(agendaEquipmentLinks.equipmentId, equipments.id))
    .innerJoin(bienPorteur, and(eq(bienPorteur.id, equipments.assetId), eq(bienPorteur.accountId, agendaItems.accountId)))
    .where(inArray(agendaEquipmentLinks.agendaItemId, itemIds)),
  ]);

  // Merge manual + AI file links, deduplicating by (agendaItemId, assetFileId)
  type FileLink = { id: number; agendaItemId: number; assetFileId: number; filename: string | null; retainedTitle: string | null; originalFilename: string | null; resolvedAssetId: number | null };
  const mergedFileLinks: FileLink[] = fileLinksRows.map(f => ({
    id: f.id,
    agendaItemId: f.agendaItemId,
    assetFileId: f.assetFileId,
    filename: f.filename ?? null,
    retainedTitle: f.retainedTitle ?? null,
    originalFilename: f.originalFilename ?? null,
    resolvedAssetId: f.resolvedAssetId ?? null,
  }));
  const existingFileLinkKeys = new Set(mergedFileLinks.map(f => `${f.agendaItemId}:${f.assetFileId}`));
  for (const ai of aiFileLinksRows) {
    if (ai.agendaItemId === null) continue;
    const key = `${ai.agendaItemId}:${ai.assetFileId}`;
    if (!existingFileLinkKeys.has(key)) {
      existingFileLinkKeys.add(key);
      mergedFileLinks.push({
        id: ai.id,
        agendaItemId: ai.agendaItemId,
        assetFileId: ai.assetFileId,
        filename: ai.filename ?? null,
        retainedTitle: ai.retainedTitle ?? null,
        originalFilename: ai.originalFilename ?? null,
        resolvedAssetId: ai.resolvedAssetId ?? null,
      });
    }
  }

  return {
    assetLinks: assetLinksRows,
    fileLinks: mergedFileLinks,
    roomLinks: roomLinksRows,
    equipLinks: equipLinksRows,
  };
}

async function enrichItems(rows: typeof agendaItems.$inferSelect[]): Promise<AgendaItemFull[]> {
  if (rows.length === 0) return [];

  const ids = rows.map(r => r.id);
  const { assetLinks, fileLinks, roomLinks, equipLinks } = await loadLinks(ids);
  const natures = await loadEventNatures(ids);
  const claims = await loadClaimSources(rows);

  // Load pending conflicts for attention flags
  const conflicts = await db.select({
    id: agendaDataConflicts.id,
    agendaItemId: agendaDataConflicts.agendaItemId,
    requiresQualification: agendaDataConflicts.requiresQualification,
    currentDecision: agendaDataConflicts.currentDecision,
  })
  .from(agendaDataConflicts)
  .where(
    and(
      inArray(agendaDataConflicts.agendaItemId, ids),
      eq(agendaDataConflicts.currentDecision, 'pending')
    )
  );

  const now = new Date();

  return rows.map(item => {
    const itemAssets = assetLinks.filter(l => l.agendaItemId === item.id);
    const itemFiles = fileLinks.filter(l => l.agendaItemId === item.id);
    const itemRooms = roomLinks.filter(l => l.agendaItemId === item.id);
    const itemEquips = equipLinks.filter(l => l.agendaItemId === item.id);
    const itemConflicts = conflicts.filter(c => c.agendaItemId === item.id);

    // Lot 47B : nature lue pour la règle « un fait passé n'est jamais en retard ».
    const signaux = {
      eventNature: natures?.get(item.id)?.nature ?? null,
      businessType: natures?.get(item.id)?.businessType ?? null,
      originFieldKey: item.originFieldKey,
    };
    const effectiveStatus = computeEffectiveStatus({
      startDate: item.startDate,
      startTime: item.startTime,
      endDate: item.endDate,
      endTime: item.endTime,
      manualStatus: item.manualStatus as 'realise' | 'annule' | null,
      ...signaux,
    }, now);

    const attentionFlags = computeAttentionFlags(
      {
        startDate: item.startDate,
        startTime: item.startTime,
        endDate: item.endDate,
        endTime: item.endTime,
        manualStatus: item.manualStatus as 'realise' | 'annule' | null,
        ...signaux,
        directAssetIds: itemAssets.map(a => a.assetId),
        fileLinks: itemFiles.map(f => ({ id: f.id, resolvedAssetId: f.resolvedAssetId ?? null })),
        roomLinks: itemRooms.map(r => ({ id: r.id, resolvedAssetId: r.resolvedAssetId ?? null })),
        equipmentLinks: itemEquips.map(e => ({ id: e.id, resolvedAssetId: e.resolvedAssetId ?? null })),
        requiresQualification: item.requiresQualification,
      },
      itemConflicts.map(c => ({
        id: c.id,
        requiresQualification: c.requiresQualification,
        currentDecision: c.currentDecision,
      })),
      now
    );

    return {
      id: item.id,
      publicId: item.publicId,
      accountId: item.accountId,
      createdByUserId: item.createdByUserId,
      title: item.title,
      description: item.description,
      startDate: item.startDate,
      startTime: item.startTime,
      endDate: item.endDate,
      endTime: item.endTime,
      manualStatus: item.manualStatus as 'realise' | 'annule' | null,
      effectiveStatus,
      isAutomatic: item.isAutomatic,
      isAutomaticModified: item.isAutomaticModified,
      requiresQualification: item.requiresQualification,
      originType: item.originType,
      originRefType: item.originRefType,
      originRefId: item.originRefId,
      originFieldKey: item.originFieldKey,
      occurrenceNature: (item.occurrenceNature as 'FORECAST' | 'CONFIRMED' | null) ?? 'CONFIRMED',
      forecastInitialDate: item.forecastInitialDate ?? null,
      confirmedAt: item.confirmedAt ?? null,
      confirmationMode: item.confirmationMode ?? null,
      recurrenceRule: (item.recurrenceJson as { rule?: string } | null)?.rule ?? null,
      noDeadline: item.noDeadline === true,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      assetLinks: itemAssets.map(a => ({ id: a.id, assetId: a.assetId, assetName: a.assetName ?? '' })),
      fileLinks: itemFiles.map(f => ({ id: f.id, assetFileId: f.assetFileId, filename: f.filename ?? null, retainedTitle: f.retainedTitle ?? null, originalFilename: f.originalFilename ?? null, resolvedAssetId: f.resolvedAssetId ?? null })),
      roomLinks: itemRooms.map(r => ({ id: r.id, substructureId: r.substructureId, name: r.name ?? '', resolvedAssetId: r.resolvedAssetId ?? null })),
      equipmentLinks: itemEquips.map(e => ({ id: e.id, equipmentId: e.equipmentId, name: e.name ?? '', resolvedAssetId: e.resolvedAssetId ?? null })),
      attentionFlags,
      ...(natures ? { eventNature: natures.get(item.id)?.nature ?? null } : {}),
      claimSource: item.businessOperationId != null ? claims.get(Number(item.businessOperationId)) ?? null : null,
    };
  });
}

/**
 * Sinistres représentés par des éléments (lot 46, O7) : Opération CLAIM
 * active liée, et son bien principal (lien de la rubrique Sinistres). Ne
 * lève jamais (lecture accessoire du tiroir).
 */
async function loadClaimSources(rows: Array<{ businessOperationId: number | null }>): Promise<Map<number, { assetId: number; claimId: number }>> {
  const out = new Map<number, { assetId: number; claimId: number }>();
  const ops = [...new Set(rows.map((r) => r.businessOperationId).filter((x): x is number => x != null).map(Number))];
  if (ops.length === 0) return out;
  try {
    const r = (await db.execute(sql`
      SELECT o.id, (SELECT l.asset_id FROM business_operation_asset_links l
                     WHERE l.operation_id = o.id AND l.active ORDER BY (l.link_role = 'PRIMARY') DESC, l.asset_id LIMIT 1) AS asset_id
        FROM business_operations o
       WHERE o.id = ANY(${`{${ops.join(',')}}`}::bigint[]) AND o.type_code = 'CLAIM'
         AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`)) as unknown as Array<{ id: number; asset_id: number | null }>;
    for (const x of r) if (x.asset_id != null) out.set(Number(x.id), { assetId: Number(x.asset_id), claimId: Number(x.id) });
  } catch (e) {
    console.error('[agenda] sinistres liés :', (e as Error).message);
  }
  return out;
}

/**
 * Nature et type métier des éléments (colonnes 0223, non déclarées dans
 * Drizzle) ; null si la migration n'est pas appliquée (rien n'est lu).
 * Lot 47B : exportée pour les routes qui calculent le statut effectif.
 */
export async function loadEventNatures(ids: number[]): Promise<Map<number, { nature: 'HISTORICAL' | 'DEADLINE' | null; businessType: string | null }> | null> {
  if (ids.length === 0 || !(await agendaFunctionalColumnsReady())) return null;
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT id, event_nature AS nature, business_type AS "businessType" FROM agenda_items WHERE id = ANY($1::int[])`,
    [ids] as never[],
  )) as unknown as Array<{ id: number; nature: 'HISTORICAL' | 'DEADLINE' | null; businessType: string | null }>;
  return new Map(rows.map((r) => [Number(r.id), { nature: r.nature, businessType: r.businessType ?? null }]));
}

// ── Prochaines échéances (CDC 15 D-14) — helpers pour l'accueil (C) ─────────

/**
 * Un élément entre-t-il dans les « prochaines échéances » ? Jamais un
 * élément HISTORICAL (fait passé : achat, entretien réalisé, sinistre,
 * vente…), ni un élément réalisé ou annulé. `eventNature` absent (élément
 * antérieur à la 0223) : échéance.
 */
export function isUpcomingDeadlineCandidate(item: {
  eventNature?: 'HISTORICAL' | 'DEADLINE' | null;
  manualStatus?: string | null;
}): boolean {
  if (item.eventNature === 'HISTORICAL') return false;
  return !item.manualStatus || (item.manualStatus !== 'realise' && item.manualStatus !== 'annule');
}

/**
 * Fragment SQL à ajouter au WHERE d'une requête « prochaines échéances » sur
 * `agenda_items` : exclut les éléments HISTORICAL quand la 0223 est
 * appliquée ; chaîne vide sinon (requête valide sans la colonne). `alias` :
 * alias de `agenda_items` dans la requête.
 */
export async function upcomingDeadlinesSqlFilter(alias = ''): Promise<string> {
  if (!(await agendaFunctionalColumnsReady())) return '';
  const a = alias ? `${alias}.` : '';
  return ` AND (${a}event_nature IS DISTINCT FROM 'HISTORICAL')`;
}

/**
 * Prochaines échéances d'un compte (à partir d'aujourd'hui), HISTORICAL
 * exclus, réalisées et annulées exclues — prête pour l'accueil.
 */
export async function getUpcomingDeadlines(
  accountId: number,
  opts: { from?: string; limit?: number; assetIds?: number[] } = {},
): Promise<AgendaItemFull[]> {
  const from = opts.from ?? new Date().toISOString().slice(0, 10);
  const items = await getAgendaItems({ accountId, assetIds: opts.assetIds, includeCancelled: false, includeUndated: false });
  return items
    .filter((i) => i.startDate !== null && i.startDate >= from && isUpcomingDeadlineCandidate(i))
    .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? '') || (a.startTime ?? 'zzz').localeCompare(b.startTime ?? 'zzz'))
    .slice(0, opts.limit ?? 20);
}

export async function getAgendaItems(params: AgendaQueryParams): Promise<AgendaItemFull[]> {
  return (await queryAgenda(params, false)).items;
}

/**
 * Lot 71 (71C) — « Mon agenda » : éléments ET options du filtre Équipement
 * (équipements des biens retenus, comptés sur les éléments retenus par les
 * AUTRES filtres — période, dates, annulés, pièce). Facette absente sans bien
 * retenu ou sans équipement : le filtre est alors masqué.
 *
 * Lot 75 (75B) : rend aussi les options du filtre Pièce (`roomFacet`), avec
 * leurs compteurs — échéances directes + indirectes, dédupliquées, comptées
 * sous le filtre Équipement courant (Bien + Pièce + Équipement = intersection).
 */
export async function getAgendaItemsWithEquipmentFacet(
  params: AgendaQueryParams,
): Promise<{ items: AgendaItemFull[]; equipmentFacet: EquipmentFacet | null; roomFacet: RoomFacet | null }> {
  return queryAgenda(params, true);
}

/**
 * Pièces des biens retenus et leurs échéances (résolution centrale), ou
 * `null` hors périmètre de biens (document, compte entier).
 */
async function loadRoomScope(params: AgendaQueryParams): Promise<{ rooms: AssetRoom[]; byRoom: Map<number, Set<number>> } | null> {
  if (!params.assetIds?.length || params.fileId) return null;
  const rooms = await listRoomsOfAssets(params.accountId, params.assetIds);
  if (rooms.length === 0) return { rooms, byRoom: new Map() };
  return { rooms, byRoom: await agendaItemIdsByRoom(params.accountId, rooms.map((r) => r.id)) };
}

async function queryAgenda(
  params: AgendaQueryParams,
  withFacets: boolean,
): Promise<{ items: AgendaItemFull[]; equipmentFacet: EquipmentFacet | null; roomFacet: RoomFacet | null }> {
  const roomScope = await loadRoomScope(params);
  // Lot 75B : une échéance liée à une PIÈCE du bien (directement, par un
  // équipement ou un document de la pièce) appartient au bien, comme celles
  // de ses équipements (lot 71).
  const roomItemIds = roomScope ? [...new Set([...roomScope.byRoom.values()].flatMap((v) => [...v]))] : [];
  const inScope = await getAgendaItemsInScope(params, roomItemIds);

  // Filtre Pièce : pièce des biens retenus, sinon aucun résultat (lien abîmé).
  const pieceId = roomScope ? selectedRoomId(params.piece) : null;
  const roomSet = pieceId === null ? null : (roomScope!.byRoom.get(pieceId) ?? new Set<number>());
  const inRoom = roomSet ? inScope.filter((i) => roomSet.has(i.id)) : inScope;

  const equipmentActive = isEquipmentFilterActive(params.equipment);
  const assetEquipments = params.assetIds?.length && (equipmentActive || (withFacets && !params.fileId))
    ? await listEquipmentsOfAssets(params.accountId, params.assetIds)
    : [];
  const eqIds = assetEquipments.map((e) => e.id);
  const items = filterItemsByEquipment(inRoom, params.equipment, eqIds);
  if (!withFacets) return { items, equipmentFacet: null, roomFacet: null };

  let equipmentFacet: EquipmentFacet | null = null;
  if (assetEquipments.length > 0 && !params.fileId) {
    const counts = countItemsByEquipment(inRoom, eqIds);
    equipmentFacet = {
      all: counts.all,
      assetOnly: counts.assetOnly,
      items: assetEquipments.map((e) => ({ ...e, count: counts.byEquipment.get(e.id) ?? 0 })),
    };
  }
  let roomFacet: RoomFacet | null = null;
  if (roomScope && roomScope.rooms.length > 0) {
    const sousEquipement = filterItemsByEquipment(inScope, params.equipment, eqIds);
    roomFacet = {
      items: roomScope.rooms.map((r) => {
        const set = roomScope.byRoom.get(r.id) ?? new Set<number>();
        return { ...r, count: sousEquipement.filter((i) => set.has(i.id)).length };
      }),
    };
  }
  return { items, equipmentFacet, roomFacet };
}

/**
 * Éléments retenus par tous les filtres SAUF les filtres Équipement et Pièce.
 * `extraIds` (lot 75B) : éléments rattachés aux pièces des biens retenus.
 */
async function getAgendaItemsInScope(params: AgendaQueryParams, extraIds: readonly number[] = []): Promise<AgendaItemFull[]> {
  const { accountId, assetIds, fileId, period, includeCancelled = false, month, year, includeUndated } = params;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  let rows: typeof agendaItems.$inferSelect[];

  if (fileId) {
    // Éléments liés au document : service unique de liaison source ↔ agenda
    // (CDC 15 T4-07, X-04) — liens `agenda_file_links`, traces
    // `agenda_item_sources` et éléments automatiques issus de ce document
    // (`origin_ref`).
    const ids = await listAgendaItemIdsForSource(accountId, fileId);
    if (ids.length === 0) return [];
    rows = await db.select().from(agendaItems).where(
      and(eq(agendaItems.accountId, accountId), inArray(agendaItems.id, ids))
    );
  } else if (assetIds && assetIds.length > 0) {
    // Get item ids that have links to the requested assets
    // Lot 49 : biens du compte seulement.
    //
    // Lot 71 (71C) — évolution EXPLICITE du rattachement : un élément lié à
    // un ÉQUIPEMENT du bien (`agenda_equipment_links`) figure aussi dans les
    // résultats du bien parent, même sans lien direct au bien (cohérence
    // avec les documents, ticket « filtres Documents / Agenda » §4). Les
    // règles de statut, de période et d'attention ne changent pas.
    const [linkedIds, equipmentLinkedIds] = await Promise.all([
      db.selectDistinct({ id: agendaAssetLinks.agendaItemId })
        .from(agendaAssetLinks)
        .innerJoin(assets, and(eq(assets.id, agendaAssetLinks.assetId), eq(assets.accountId, accountId)))
        .where(inArray(agendaAssetLinks.assetId, assetIds)),
      db.selectDistinct({ id: agendaEquipmentLinks.agendaItemId })
        .from(agendaEquipmentLinks)
        .innerJoin(equipments, eq(equipments.id, agendaEquipmentLinks.equipmentId))
        .innerJoin(assets, and(eq(assets.id, equipments.assetId), eq(assets.accountId, accountId)))
        .where(inArray(equipments.assetId, assetIds)),
    ]);
    const ids = [...new Set([...linkedIds, ...equipmentLinkedIds].map(r => r.id).concat(extraIds))];
    if (ids.length === 0) return [];
    rows = await db.select().from(agendaItems).where(
      and(eq(agendaItems.accountId, accountId), inArray(agendaItems.id, ids))
    );
  } else {
    rows = await db.select().from(agendaItems).where(eq(agendaItems.accountId, accountId));
  }

  // Filter by period
  if (period && period !== 'all') {
    rows = rows.filter(item => {
      if (!item.startDate) return includeUndated ?? true;
      if (period === 'past') return item.startDate < today;
      if (period === 'today') return item.startDate === today;
      if (period === 'upcoming') return item.startDate >= today;
      return true;
    });
  }

  // Filter by month (keep undated items — they appear in the calendar's "sans date" block)
  if (month) {
    rows = rows.filter(item => {
      if (!item.startDate) return true;
      return item.startDate.startsWith(month);
    });
  }

  // Filter by year
  if (year && !month) {
    rows = rows.filter(item => {
      if (!item.startDate) return false;
      return item.startDate.startsWith(year);
    });
  }

  // Exclude undated if not requested
  if (includeUndated === false) {
    rows = rows.filter(item => item.startDate !== null);
  }

  const enriched = await enrichItems(rows);

  // Filter cancelled
  if (!includeCancelled) {
    return enriched.filter(item => item.effectiveStatus !== 'annule' && item.manualStatus !== 'annule');
  }

  return enriched;
}

export async function getAgendaItemById(id: number, accountId: number): Promise<AgendaItemFull | null> {
  const rows = await db.select().from(agendaItems).where(
    and(eq(agendaItems.id, id), eq(agendaItems.accountId, accountId))
  );
  if (rows.length === 0) return null;
  const enriched = await enrichItems(rows);
  return enriched[0] ?? null;
}

/**
 * searchAgendaItems
 * MVP V4: GIN index on title + description. JOIN on linked objects.
 * Note: search on linked object names is via SQL JOIN, not a consolidated index — acceptable for MVP.
 */
export async function searchAgendaItems(query: string, accountId: number): Promise<AgendaSearchResult[]> {
  if (!query || query.trim().length < 2) return [];

  const q = query.trim();

  // Full-text on title + description
  const rows = await db.select().from(agendaItems).where(
    and(
      eq(agendaItems.accountId, accountId),
      sql`to_tsvector('french', ${agendaItems.title} || ' ' || coalesce(${agendaItems.description}, '')) @@ plainto_tsquery('french', ${q})`
    )
  ).limit(20);

  // Also search on linked asset names via JOIN
  const assetNameRows = await db.selectDistinct({
    id: agendaItems.id,
    publicId: agendaItems.publicId,
    title: agendaItems.title,
    startDate: agendaItems.startDate,
    startTime: agendaItems.startTime,
    endDate: agendaItems.endDate,
    endTime: agendaItems.endTime,
    manualStatus: agendaItems.manualStatus,
  })
  .from(agendaItems)
  .innerJoin(agendaAssetLinks, eq(agendaAssetLinks.agendaItemId, agendaItems.id))
  // Lot 49 : bien du compte seulement (un lien incorrect ne fait pas
  // correspondre le nom d'un bien d'un autre compte).
  .innerJoin(assets, and(eq(agendaAssetLinks.assetId, assets.id), eq(assets.accountId, accountId)))
  .where(
    and(
      eq(agendaItems.accountId, accountId),
      sql`${assets.name} ILIKE ${'%' + q + '%'}`
    )
  ).limit(10);

  // Deduplicate
  const seen = new Set<number>();
  const combined = [...rows];
  for (const row of assetNameRows) {
    if (!seen.has(row.id) && !combined.find(r => r.id === row.id)) {
      combined.push({
        ...row,
        description: null,
        isAutomatic: false,
        isAutomaticModified: false,
        requiresQualification: false,
        originType: 'manual',
        originRefType: null,
        originRefId: null,
        originFieldKey: null,
        accountId,
        createdByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as typeof agendaItems.$inferSelect);
    }
    seen.add(row.id);
  }

  const now = new Date();
  const retenus = combined.slice(0, 20);
  const natures = await loadEventNatures(retenus.map((r) => r.id));
  return retenus.map(item => {
    const effectiveStatus = computeEffectiveStatus({
      startDate: item.startDate,
      startTime: item.startTime,
      endDate: item.endDate,
      endTime: item.endTime,
      manualStatus: item.manualStatus as 'realise' | 'annule' | null,
      eventNature: natures?.get(item.id)?.nature ?? null,
      businessType: natures?.get(item.id)?.businessType ?? null,
      originFieldKey: item.originFieldKey ?? null,
    }, now);
    return {
      type: 'agenda' as const,
      id: item.id,
      publicId: item.publicId,
      title: item.title,
      effectiveStatus,
      contextLabel: 'Agenda',
    };
  });
}

/**
 * getHomepageAgendaItems
 * 2-pass priority algorithm per plan §2.7
 */
export async function getHomepageAgendaItems(accountId: number): Promise<AgendaItemFull[]> {
  const rows = await db.select().from(agendaItems).where(
    and(
      eq(agendaItems.accountId, accountId),
      or(isNull(agendaItems.manualStatus), eq(agendaItems.manualStatus, ''))
    )
  );

  const enriched = await enrichItems(rows);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Exclude realise and annule (treat empty string as null — DB may store '')
  // CDC 15 D-14 : un élément HISTORICAL n'est pas une échéance — ni « en
  // retard », ni « à venir ». Nature absente (avant la 0223) : échéance.
  const active = enriched.filter(isUpcomingDeadlineCandidate);

  // Pass 1 — classify
  const overdue: AgendaItemFull[] = [];
  const todayItems: AgendaItemFull[] = [];
  const upcoming: AgendaItemFull[] = [];
  const undated: AgendaItemFull[] = [];

  for (const item of active) {
    if (item.effectiveStatus === 'en_retard') {
      overdue.push(item);
    } else if (!item.startDate) {
      undated.push(item);
    } else if (item.startDate === today || (item.startDate <= today && item.endDate !== null && item.endDate >= today)) {
      todayItems.push(item);
    } else if (item.startDate > today) {
      upcoming.push(item);
    }
  }

  // Pass 2 — sort within groups
  overdue.sort((a, b) => {
    const d = (a.startDate ?? '').localeCompare(b.startDate ?? '');
    if (d !== 0) return d;
    return (a.startTime ?? 'zzz').localeCompare(b.startTime ?? 'zzz');
  });

  todayItems.sort((a, b) => (a.startTime ?? 'zzz').localeCompare(b.startTime ?? 'zzz'));

  upcoming.sort((a, b) => {
    const d = (a.startDate ?? '').localeCompare(b.startDate ?? '');
    if (d !== 0) return d;
    return (a.startTime ?? 'zzz').localeCompare(b.startTime ?? 'zzz');
  });

  undated.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return [...overdue, ...todayItems, ...upcoming, ...undated].slice(0, 5);
}

export async function getAgendaAttentionItems(accountId: number): Promise<AgendaItemFull[]> {
  const all = await getAgendaItems({ accountId, includeCancelled: false, includeUndated: true });
  return all.filter(item => item.attentionFlags.length > 0);
}
