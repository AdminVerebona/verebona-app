/**
 * Scan « À traiter » (CDC §7.3.1 / §7.3 détection).
 *
 * Compare la vue calculée à l'état persistant `to_process_item_state` pour
 * notifier UNE fois lorsqu'un élément devient réellement actif — et à nouveau
 * s'il a été résolu puis réapparaît (nouveau cycle). Ne notifie pas :
 *  - un simple recalcul de la page ;
 *  - un élément déjà actif ;
 *  - un élément mis de côté (snoozed) ou résolu.
 * La clé de déduplication inclut le cycle.
 */

import { db } from '@/db';
import { accounts, toProcessItemState } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '@/lib/notifications';
import { getToProcessItems } from '@/services/to-process.service';
import type { ToProcessItem } from '@/types/to-process';

export interface ScanRunResult { accountsProcessed: number; created: number; resolved: number; capped: boolean }

async function emitCreated(accountId: number, item: ToProcessItem, cycle: number, now: Date): Promise<void> {
  await emit({
    type: 'TO_PROCESS_ITEM_CREATED',
    accountId,
    entityType: 'to_process_item',
    entityId: item.id,
    payload: { family: item.family, itemKey: item.id },
    // Le cycle permet de re-notifier un problème résolu puis réapparu (§7.3).
    dedupeKey: `to-process:item-created:${item.id}:c${cycle}`,
    scheduledFor: now,
  });
}

export async function runToProcessScan(now: Date = new Date(), limit = 1000): Promise<ScanRunResult> {
  const accountList = await db.select({ id: accounts.id }).from(accounts).limit(limit + 1);
  const capped = accountList.length > limit;
  const toScan = capped ? accountList.slice(0, limit) : accountList;

  let created = 0;
  let resolved = 0;

  for (const acc of toScan) {
    try {
      const view = await getToProcessItems(acc.id);
      const active = view.items.filter((i) => i.status === 'active');
      const activeKeys = new Set(active.map((i) => i.id));

      const states = await db.select().from(toProcessItemState)
        .where(eq(toProcessItemState.accountId, acc.id));
      const stateByKey = new Map(states.map((s) => [s.itemKey, s]));

      // Entrées : nouvel élément actif, ou réapparition après résolution.
      for (const item of active) {
        const st = stateByKey.get(item.id);
        if (!st) {
          await db.insert(toProcessItemState).values({
            accountId: acc.id, itemKey: item.id, problemKey: item.family,
            activeSince: now, lastSeenAt: now, isActive: true, cycleNumber: 1,
          }).onConflictDoNothing({ target: [toProcessItemState.accountId, toProcessItemState.itemKey] });
          await emitCreated(acc.id, item, 1, now);
          created++;
        } else if (!st.isActive) {
          const nextCycle = st.cycleNumber + 1;
          await db.update(toProcessItemState).set({
            isActive: true, activeSince: now, resolvedAt: null, lastSeenAt: now,
            cycleNumber: nextCycle, problemKey: item.family, updatedAt: now,
          }).where(eq(toProcessItemState.id, st.id));
          await emitCreated(acc.id, item, nextCycle, now);
          created++;
        } else {
          await db.update(toProcessItemState)
            .set({ lastSeenAt: now, updatedAt: now })
            .where(eq(toProcessItemState.id, st.id));
        }
      }

      // Sorties : un élément actif absent de la vue est considéré résolu.
      for (const st of states) {
        if (st.isActive && !activeKeys.has(st.itemKey)) {
          await db.update(toProcessItemState)
            .set({ isActive: false, resolvedAt: now, updatedAt: now })
            .where(eq(toProcessItemState.id, st.id));
          resolved++;
        }
      }
    } catch (err) {
      console.error('[to-process-scan] compte', acc.id, err);
    }
  }

  return { accountsProcessed: toScan.length, created, resolved, capped };
}
