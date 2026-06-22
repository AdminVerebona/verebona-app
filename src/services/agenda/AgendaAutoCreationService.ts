/**
 * AgendaAutoCreationService — automatic agenda item creation from asset fields and documents
 */
import { db } from '@/db';
import { agendaItems } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { createAgendaItem } from './AgendaWriteService';
import { createConflict } from './AgendaConflictService';
import { getAgendaItemById, type AgendaItemFull } from './AgendaQueryService';

const FIELD_LABELS: Record<string, string> = {
  warrantyEndDate: 'Fin de garantie',
  lastMaintenanceDate: 'Dernier entretien',
  purchaseDate: 'Date d\'achat',
};

export async function createFromAssetField(
  assetId: number,
  fieldKey: string,
  fieldValue: string,
  accountId: number
): Promise<AgendaItemFull | null> {
  if (!fieldValue) return null;

  // Idempotency: check if an item already exists for this asset + field
  const existing = await db.select().from(agendaItems).where(
    and(
      eq(agendaItems.accountId, accountId),
      eq(agendaItems.originType, 'asset_field'),
      eq(agendaItems.originRefId, assetId),
      eq(agendaItems.originFieldKey, fieldKey)
    )
  ).limit(1);

  if (existing.length > 0) {
    // If the field date changed, create a date_mismatch conflict
    const existingItem = existing[0];
    if (existingItem.startDate && existingItem.startDate !== fieldValue) {
      await createConflict({
        accountId,
        agendaItemId: existingItem.id,
        conflictType: 'date_mismatch',
        fieldKey,
        sourceTypeA: 'agenda_item',
        sourceRefIdA: existingItem.id,
        valueDateA: existingItem.startDate,
        sourceTypeB: 'asset_field',
        sourceRefIdB: assetId,
        valueDateB: fieldValue,
      });
    }
    return getAgendaItemById(existingItem.id, accountId);
  }

  const label = FIELD_LABELS[fieldKey] ?? fieldKey;
  return createAgendaItem(
    {
      title: label,
      startDate: fieldValue,
      assetIds: [assetId],
      originType: 'asset_field',
      originRefType: 'asset',
      originRefId: assetId,
      originFieldKey: fieldKey,
      isAutomatic: true,
    },
    accountId,
    null
  );
}

export async function createFromQualifiedDocument(
  fileId: number,
  documentDate: string,
  label: string,
  accountId: number
): Promise<AgendaItemFull | null> {
  if (!documentDate) return null;

  const existing = await db.select().from(agendaItems).where(
    and(
      eq(agendaItems.accountId, accountId),
      eq(agendaItems.originType, 'qualified_document'),
      eq(agendaItems.originRefId, fileId)
    )
  ).limit(1);

  if (existing.length > 0) {
    const existingItem = existing[0];
    if (existingItem.startDate && existingItem.startDate !== documentDate) {
      await createConflict({
        accountId,
        agendaItemId: existingItem.id,
        conflictType: 'date_mismatch',
        fieldKey: 'documentDate',
        sourceTypeA: 'agenda_item',
        sourceRefIdA: existingItem.id,
        valueDateA: existingItem.startDate,
        sourceTypeB: 'qualified_document',
        sourceRefIdB: fileId,
        valueDateB: documentDate,
      });
    }
    return getAgendaItemById(existingItem.id, accountId);
  }

  return createAgendaItem(
    {
      title: label,
      startDate: documentDate,
      fileIds: [fileId],
      originType: 'qualified_document',
      originRefType: 'asset_file',
      originRefId: fileId,
      isAutomatic: true,
    },
    accountId,
    null
  );
}

export async function inferNextOccurrence(
  agendaItemId: number,
  ruleKey: string,
  accountId: number
): Promise<AgendaItemFull> {
  const source = await getAgendaItemById(agendaItemId, accountId);
  if (!source) throw new Error('Source agenda item not found');

  if (!source.startDate) throw new Error('Source item has no start date');

  let nextDate: string;
  if (ruleKey === 'ct_2years') {
    const d = new Date(source.startDate);
    d.setFullYear(d.getFullYear() + 2);
    nextDate = d.toISOString().slice(0, 10);
  } else {
    throw new Error(`Unknown rule key: ${ruleKey}`);
  }

  return createAgendaItem(
    {
      title: source.title,
      description: source.description,
      startDate: nextDate,
      assetIds: source.assetLinks.map(l => l.assetId),
      originType: 'deduced_rule',
      originRefType: 'agenda_item',
      originRefId: agendaItemId,
      originFieldKey: ruleKey,
      isAutomatic: true,
    },
    accountId,
    null
  );
}
