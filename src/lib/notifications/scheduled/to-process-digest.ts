/**
 * Récapitulatif quotidien « À traiter » à 8 h 30 Europe/Paris (CDC §7.3.2).
 *
 * Pour chaque compte ayant au moins un élément actif (les éléments mis de côté
 * ou résolus sont exclus), une notification récapitulative par utilisateur, par
 * jour et par canal. Aucun récapitulatif vide. Jamais dans la cloche.
 */

import { db } from '@/db';
import { accounts } from '@/db/schema';
import { emit } from '@/lib/notifications';
import { getToProcessItems } from '@/services/to-process.service';
import { todayParisDateStr } from '../time-paris';

export interface DigestRunResult { accountsProcessed: number; emitted: number; capped: boolean }

export async function runToProcessDigest(now: Date = new Date(), limit = 1000): Promise<DigestRunResult> {
  const localDate = todayParisDateStr(now);
  const accountList = await db.select({ id: accounts.id }).from(accounts).limit(limit + 1);
  const capped = accountList.length > limit;
  const toScan = capped ? accountList.slice(0, limit) : accountList;

  let emitted = 0;
  for (const acc of toScan) {
    try {
      const view = await getToProcessItems(acc.id);
      const active = view.items.filter((i) => i.status === 'active');
      if (active.length === 0) continue; // pas de récapitulatif vide (§7.3.2)

      const byFamily: Record<string, number> = { arbitrate: 0, attach: 0, confirm: 0, complete: 0 };
      for (const it of active) byFamily[it.family] = (byFamily[it.family] ?? 0) + 1;

      await emit({
        type: 'TO_PROCESS_DAILY_DIGEST',
        accountId: acc.id,
        entityType: 'to_process_digest',
        entityId: localDate,
        payload: { total: active.length, byFamily },
        dedupeKey: `to-process:digest:${localDate}`,
        scheduledFor: now,
      });
      emitted++;
    } catch (err) {
      console.error('[to-process-digest] compte', acc.id, err);
    }
  }

  return { accountsProcessed: toScan.length, emitted, capped };
}
