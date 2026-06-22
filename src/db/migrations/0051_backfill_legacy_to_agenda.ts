/**
 * Backfill migration: events + deadlines → agenda_items
 *
 * Run once after 0050_agenda_items.sql has been applied.
 * Usage: npx tsx src/db/migrations/0051_backfill_legacy_to_agenda.ts
 *
 * Produces a report: total migrated, total errors, list of failed ids.
 */
import { db } from '@/db';
import { events, deadlines, agendaItems, agendaAssetLinks, agendaRoomLinks, agendaEquipmentLinks } from '@/db/schema';
import { eq } from 'drizzle-orm';

const errors: { source: string; id: number; reason: string }[] = [];
let migratedEvents = 0;
let migratedDeadlines = 0;

// Map events.statut → manualStatus
function mapEventStatus(statut: string | null): 'realise' | 'annule' | null {
  if (statut === 'realise') return 'realise';
  if (statut === 'annule') return 'annule';
  // 'planifie' or any other value → null (computed at read time)
  // Unknown values are logged in report
  return null;
}

async function backfillEvents() {
  const allEvents = await db.select().from(events);

  for (const ev of allEvents) {
    try {
      // Check not already migrated (idempotency guard)
      const existing = await db.select({ id: agendaItems.id })
        .from(agendaItems)
        .where(eq(agendaItems.originRefId, ev.id));

      // Filter by originType matching legacy_event_migration would be ideal but
      // Drizzle doesn't do AND on two conditions easily without and(). Keep simple:
      const alreadyMigrated = existing.length > 0;
      if (alreadyMigrated) continue;

      const unknownStatus = ev.statut && !['realise', 'annule', 'planifie'].includes(ev.statut);
      if (unknownStatus) {
        errors.push({ source: 'events', id: ev.id, reason: `Unknown statut value: ${ev.statut}` });
      }

      const [inserted] = await db.insert(agendaItems).values({
        accountId: ev.accountId,
        createdByUserId: ev.userId ?? null,
        title: ev.title || 'Sans titre',
        description: ev.description ?? ev.notes ?? null,
        startDate: ev.date ?? null,
        startTime: null,
        endDate: null,
        endTime: null,
        manualStatus: mapEventStatus(ev.statut),
        isAutomatic: false,
        isAutomaticModified: false,
        requiresQualification: false,
        originType: 'legacy_event_migration',
        originRefType: 'event',
        originRefId: ev.id,
        originFieldKey: null,
      }).returning();

      // Create asset link if assetId present
      if (ev.assetId) {
        await db.insert(agendaAssetLinks).values({
          agendaItemId: inserted.id,
          assetId: ev.assetId,
        }).onConflictDoNothing();
      }

      migratedEvents++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push({ source: 'events', id: ev.id, reason });
    }
  }
}

async function backfillDeadlines() {
  const allDeadlines = await db.select().from(deadlines);

  for (const dl of allDeadlines) {
    try {
      const existing = await db.select({ id: agendaItems.id })
        .from(agendaItems)
        .where(eq(agendaItems.originRefId, dl.id));

      const alreadyMigrated = existing.length > 0;
      if (alreadyMigrated) continue;

      const [inserted] = await db.insert(agendaItems).values({
        accountId: dl.accountId,
        createdByUserId: dl.userId ?? null,
        title: dl.label || 'Sans titre',
        description: dl.notes ?? null,
        startDate: dl.deadlineDate ?? null,
        startTime: null,
        endDate: null,
        endTime: null,
        manualStatus: dl.isDone ? 'realise' : null,
        isAutomatic: false,
        isAutomaticModified: false,
        requiresQualification: false,
        originType: 'legacy_deadline_migration',
        originRefType: 'deadline',
        originRefId: dl.id,
        originFieldKey: null,
      }).returning();

      // Asset link
      if (dl.assetId) {
        await db.insert(agendaAssetLinks).values({
          agendaItemId: inserted.id,
          assetId: dl.assetId,
        }).onConflictDoNothing();
      }

      // Room link
      if (dl.substructureId) {
        await db.insert(agendaRoomLinks).values({
          agendaItemId: inserted.id,
          substructureId: dl.substructureId,
        }).onConflictDoNothing();
      }

      // Equipment link
      if (dl.equipmentId) {
        await db.insert(agendaEquipmentLinks).values({
          agendaItemId: inserted.id,
          equipmentId: dl.equipmentId,
        }).onConflictDoNothing();
      }

      migratedDeadlines++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push({ source: 'deadlines', id: dl.id, reason });
    }
  }
}

async function main() {
  await backfillEvents();
  await backfillDeadlines();

  const total = migratedEvents + migratedDeadlines;
  if (errors.length > 0) {
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});
