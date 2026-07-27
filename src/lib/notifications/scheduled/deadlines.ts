/**
 * Rappels d'échéance à J-7 (CDC §7.1).
 *
 * À 8 h 30 Europe/Paris, pour chaque compte ayant des éléments d'agenda de
 * catégorie « action » dont la date de début tombe exactement 7 jours après la
 * date locale du jour, et qui ne sont ni réalisés ni annulés : une seule
 * notification par utilisateur regroupant les échéances du jour (§7.1 « regroupées
 * en un seul push et un seul email »). Déduplication par date locale.
 */

import { db } from '@/db';
import { agendaItems } from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { emit } from '@/lib/notifications';
import { todayParisDateStr, addDaysToDateStr } from '../time-paris';

export interface DeadlineRunResult { targetDate: string; accounts: number; emitted: number }

export async function runDeadlineReminders(now: Date = new Date()): Promise<DeadlineRunResult> {
  const targetDate = addDaysToDateStr(todayParisDateStr(now), 7);

  const rows = await db
    .select({ id: agendaItems.id, accountId: agendaItems.accountId })
    .from(agendaItems)
    .where(and(
      eq(agendaItems.startDate, targetDate),
      eq(agendaItems.homeCategory, 'action'),
      isNull(agendaItems.manualStatus), // ni 'realise' ni 'annule'
    ));

  const byAccount = new Map<number, number[]>();
  for (const r of rows) {
    const list = byAccount.get(r.accountId) ?? [];
    list.push(r.id);
    byAccount.set(r.accountId, list);
  }

  let emitted = 0;
  for (const [accountId, ids] of byAccount) {
    await emit({
      type: 'DEADLINE_DUE_IN_7_DAYS',
      accountId, // → tous les membres actifs, chacun selon ses préférences
      entityType: 'agenda_date',
      entityId: targetDate,
      payload: { count: ids.length, date: targetDate, agendaItemIds: ids },
      // Clé stable par date locale (le moteur ajoute l'utilisateur).
      dedupeKey: `deadline:j7:${targetDate}`,
      scheduledFor: now, // livraison assurée par le dispatcher (pas de traitement immédiat en masse)
    });
    emitted++;
  }

  return { targetDate, accounts: byAccount.size, emitted };
}
