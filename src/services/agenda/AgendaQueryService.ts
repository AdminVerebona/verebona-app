/**
 * AgendaQueryService — read-only DB queries
 */
import { db } from '@/db';
import {
  agendaItems, agendaAssetLinks, agendaFileLinks, agendaRoomLinks, agendaEquipmentLinks,
  agendaDataConflicts, assets, assetFiles, substructures, equipments, agendaItemSources,
} from '@/db/schema';
import { eq, and, or, isNull, isNotNull, gte, lte, inArray, sql } from 'drizzle-orm';
import { computeEffectiveStatus, computeAttentionFlags, type EffectiveStatus, type AttentionFlag } from './AgendaDomainService';

export interface AgendaQueryParams {
  accountId: number;
  assetIds?: number[];
  fileId?: number;
  period?: 'all' | 'past' | 'today' | 'upcoming';
  includeCancelled?: boolean;
  month?: string; // 'YYYY-MM'
  year?: string;  // 'YYYY'
  includeUndated?: boolean;
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
  createdAt: Date;
  updatedAt: Date;
  assetLinks: { id: number; assetId: number; assetName: string }[];
  fileLinks: { id: number; assetFileId: number; filename: string | null; retainedTitle: string | null; originalFilename: string | null; resolvedAssetId: number | null }[];
  roomLinks: { id: number; substructureId: number; name: string; resolvedAssetId: number | null }[];
  equipmentLinks: { id: number; equipmentId: number; name: string; resolvedAssetId: number | null }[];
  attentionFlags: AttentionFlag[];
}

export interface AgendaSearchResult {
  type: 'agenda';
  id: number;
  publicId: string;
  title: string;
  effectiveStatus: EffectiveStatus;
  contextLabel: string;
}

async function loadLinks(itemIds: number[]) {
  if (itemIds.length === 0) return { assetLinks: [], fileLinks: [], roomLinks: [], equipLinks: [] };

  const [assetLinksRows, fileLinksRows, aiFileLinksRows, roomLinksRows, equipLinksRows] = await Promise.all([
    db.select({
      id: agendaAssetLinks.id,
      agendaItemId: agendaAssetLinks.agendaItemId,
      assetId: agendaAssetLinks.assetId,
      assetName: assets.name,
    })
    .from(agendaAssetLinks)
    .leftJoin(assets, eq(agendaAssetLinks.assetId, assets.id))
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
    .leftJoin(assetFiles, eq(agendaFileLinks.assetFileId, assetFiles.id))
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
    .leftJoin(assetFiles, eq(agendaItemSources.assetFileId, assetFiles.id))
    .where(and(
      isNotNull(agendaItemSources.agendaItemId),
      inArray(agendaItemSources.agendaItemId, itemIds),
      inArray(agendaItemSources.effectType, ['created', 'resolved_existing']),
    )),

    db.select({
      id: agendaRoomLinks.id,
      agendaItemId: agendaRoomLinks.agendaItemId,
      substructureId: agendaRoomLinks.substructureId,
      name: substructures.name,
      resolvedAssetId: substructures.assetId,
    })
    .from(agendaRoomLinks)
    .leftJoin(substructures, eq(agendaRoomLinks.substructureId, substructures.id))
    .where(inArray(agendaRoomLinks.agendaItemId, itemIds)),

    db.select({
      id: agendaEquipmentLinks.id,
      agendaItemId: agendaEquipmentLinks.agendaItemId,
      equipmentId: agendaEquipmentLinks.equipmentId,
      name: equipments.name,
      resolvedAssetId: equipments.assetId,
    })
    .from(agendaEquipmentLinks)
    .leftJoin(equipments, eq(agendaEquipmentLinks.equipmentId, equipments.id))
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

    const effectiveStatus = computeEffectiveStatus({
      startDate: item.startDate,
      startTime: item.startTime,
      endDate: item.endDate,
      endTime: item.endTime,
      manualStatus: item.manualStatus as 'realise' | 'annule' | null,
    }, now);

    const attentionFlags = computeAttentionFlags(
      {
        startDate: item.startDate,
        startTime: item.startTime,
        endDate: item.endDate,
        endTime: item.endTime,
        manualStatus: item.manualStatus as 'realise' | 'annule' | null,
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
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      assetLinks: itemAssets.map(a => ({ id: a.id, assetId: a.assetId, assetName: a.assetName ?? '' })),
      fileLinks: itemFiles.map(f => ({ id: f.id, assetFileId: f.assetFileId, filename: f.filename ?? null, retainedTitle: f.retainedTitle ?? null, originalFilename: f.originalFilename ?? null, resolvedAssetId: f.resolvedAssetId ?? null })),
      roomLinks: itemRooms.map(r => ({ id: r.id, substructureId: r.substructureId, name: r.name ?? '', resolvedAssetId: r.resolvedAssetId ?? null })),
      equipmentLinks: itemEquips.map(e => ({ id: e.id, equipmentId: e.equipmentId, name: e.name ?? '', resolvedAssetId: e.resolvedAssetId ?? null })),
      attentionFlags,
    };
  });
}

export async function getAgendaItems(params: AgendaQueryParams): Promise<AgendaItemFull[]> {
  const { accountId, assetIds, fileId, period, includeCancelled = false, month, year, includeUndated } = params;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  let rows: typeof agendaItems.$inferSelect[];

  if (fileId) {
    // Get item ids linked to a specific file via agendaFileLinks (manual) OR agendaItemSources (AI analysis)
    const [manualLinks, aiLinks] = await Promise.all([
      db.selectDistinct({ id: agendaFileLinks.agendaItemId })
        .from(agendaFileLinks)
        .where(eq(agendaFileLinks.assetFileId, fileId)),
      db.selectDistinct({ id: agendaItemSources.agendaItemId })
        .from(agendaItemSources)
        .where(and(
          isNotNull(agendaItemSources.agendaItemId),
          eq(agendaItemSources.assetFileId, fileId),
          inArray(agendaItemSources.effectType, ['created', 'resolved_existing']),
        )),
    ]);
    const idsSet = new Set<number>();
    manualLinks.forEach(r => idsSet.add(r.id));
    aiLinks.forEach(r => { if (r.id !== null) idsSet.add(r.id); });
    const ids = [...idsSet];
    if (ids.length === 0) return [];
    rows = await db.select().from(agendaItems).where(
      and(eq(agendaItems.accountId, accountId), inArray(agendaItems.id, ids))
    );
  } else if (assetIds && assetIds.length > 0) {
    // Get item ids that have links to the requested assets
    const linkedIds = await db.selectDistinct({ id: agendaAssetLinks.agendaItemId })
      .from(agendaAssetLinks)
      .where(inArray(agendaAssetLinks.assetId, assetIds));
    const ids = linkedIds.map(r => r.id);
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
  .innerJoin(assets, eq(agendaAssetLinks.assetId, assets.id))
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
  return combined.slice(0, 20).map(item => {
    const effectiveStatus = computeEffectiveStatus({
      startDate: item.startDate,
      startTime: item.startTime,
      endDate: item.endDate,
      endTime: item.endTime,
      manualStatus: item.manualStatus as 'realise' | 'annule' | null,
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
  const active = enriched.filter(item =>
    !item.manualStatus || (item.manualStatus !== 'realise' && item.manualStatus !== 'annule')
  );

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
