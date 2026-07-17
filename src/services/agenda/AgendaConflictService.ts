/**
 * AgendaConflictService — conflict creation and resolution
 */
import { db } from '@/db';
import { agendaDataConflicts } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { createAgendaItem } from './AgendaWriteService';

export interface CreateConflictParams {
  accountId: number;
  agendaItemId?: number | null;
  conflictType: 'date_mismatch' | 'distinct_data_unqualified';
  fieldKey?: string | null;
  sourceTypeA: string;
  sourceRefIdA?: number | null;
  valueDateA?: string | null;
  sourceTypeB: string;
  sourceRefIdB?: number | null;
  valueDateB?: string | null;
}

export type ConflictDecision = 'kept_existing' | 'kept_new' | 'declared_distinct' | 'skipped';

export async function createConflict(params: CreateConflictParams) {
  const [conflict] = await db.insert(agendaDataConflicts).values({
    accountId: params.accountId,
    agendaItemId: params.agendaItemId ?? null,
    conflictType: params.conflictType,
    fieldKey: params.fieldKey ?? null,
    sourceTypeA: params.sourceTypeA,
    sourceRefIdA: params.sourceRefIdA ?? null,
    valueDateA: params.valueDateA ?? null,
    sourceTypeB: params.sourceTypeB,
    sourceRefIdB: params.sourceRefIdB ?? null,
    valueDateB: params.valueDateB ?? null,
    currentDecision: 'pending',
    requiresQualification: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning();
  return conflict;
}

export async function resolveConflict(
  conflictId: number,
  decision: ConflictDecision,
  accountId: number,
  resolvedByUserId?: number | null
) {
  const [conflict] = await db.select().from(agendaDataConflicts).where(
    and(eq(agendaDataConflicts.id, conflictId), eq(agendaDataConflicts.accountId, accountId))
  );
  if (!conflict) throw new Error('Conflict not found');

  let resultAgendaItemId: number | null = null;

  if (decision === 'declared_distinct') {
    // Create new item with temporary non-empty title — MVP qualification rule
    const newItem = await createAgendaItem(
      {
        title: 'Nouvelle donnée à qualifier',
        description: null,
        startDate: conflict.valueDateB ?? conflict.valueDateA ?? null,
        requiresQualification: true,
        originType: 'manual',
      },
      accountId,
      null
    );
    resultAgendaItemId = newItem.id;

    // Create a distinct_data_unqualified conflict on the new item
    await createConflict({
      accountId,
      agendaItemId: newItem.id,
      conflictType: 'distinct_data_unqualified',
      sourceTypeA: conflict.sourceTypeA,
      sourceRefIdA: conflict.sourceRefIdA,
      sourceTypeB: conflict.sourceTypeB,
      sourceRefIdB: conflict.sourceRefIdB,
    });
  }

  const [updated] = await db.update(agendaDataConflicts).set({
    currentDecision: decision,
    resultAgendaItemId,
    requiresQualification: decision === 'declared_distinct',
    resolvedAt: decision !== 'skipped' ? new Date() : null,
    resolvedBy: resolvedByUserId ?? null,
    updatedAt: new Date(),
  }).where(eq(agendaDataConflicts.id, conflictId)).returning();

  return updated;
}

export async function getPendingConflicts(accountId: number) {
  return db.select().from(agendaDataConflicts).where(
    and(
      eq(agendaDataConflicts.accountId, accountId),
      eq(agendaDataConflicts.currentDecision, 'pending')
    )
  );
}
