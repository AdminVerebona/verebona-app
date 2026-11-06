/**
 * Rappels d'échéance à J-7 (CDC §7.1).
 *
 * À 8 h 30 Europe/Paris, pour chaque compte ayant des éléments d'agenda de
 * catégorie « action » dont la date de début tombe exactement 7 jours après la
 * date locale du jour, et qui ne sont ni réalisés ni annulés (statut effectif commun, lot 112G) : une seule
 * notification par utilisateur regroupant les échéances du jour (§7.1 « regroupées
 * en un seul push et un seul email »). Déduplication par date locale.
 */

import { pgClient } from '@/db';
import { emit } from '@/lib/notifications';
import { todayParisDateStr, addDaysToDateStr } from '../time-paris';
import { effectiveStatusColumns, effectiveStatusOfSelected, isSettledStatus } from '@/services/agenda/effective-status-read';

interface DeadlineRunResult { targetDate: string; accounts: number; emitted: number }

export async function runDeadlineReminders(now: Date = new Date()): Promise<DeadlineRunResult> {
  const targetDate = addDaysToDateStr(todayParisDateStr(now), 7);

  // Lot 112G : « ni réalisée ni annulée » selon le STATUT EFFECTIF COMMUN (111R :
  // `computeEffectiveStatus` + preuve de réalisation 103D), plus le seul statut manuel
  // (un statut manuel vide ou fait d'espaces n'écarte plus l'échéance à tort).
  const lignes = (await pgClient.unsafe(
    `SELECT i.id, i.account_id AS "accountId", i.occurrence_nature AS nature, ${await effectiveStatusColumns('i')}
       FROM agenda_items i
      WHERE i.start_date = $1::date AND i.home_category = 'action'
        AND (i.manual_status IS NULL OR trim(i.manual_status) = '')`,
    [targetDate] as never[],
  )) as unknown as Array<Record<string, unknown>>;
  const rows = lignes
    .filter((r) => !isSettledStatus(effectiveStatusOfSelected(r, now)))
    .map((r) => ({ id: Number(r.id), accountId: Number(r.accountId), nature: (r.nature as string | null) ?? null }));

  const byAccount = new Map<number, number[]>();
  // Occurrences prévisionnelles : le rappel le dit — une prévision n'est
  // jamais présentée comme une date certaine.
  const forecasts = new Map<number, number>();
  for (const r of rows) {
    const list = byAccount.get(r.accountId) ?? [];
    list.push(r.id);
    byAccount.set(r.accountId, list);
    if (r.nature === 'FORECAST') forecasts.set(r.accountId, (forecasts.get(r.accountId) ?? 0) + 1);
  }

  let emitted = 0;
  for (const [accountId, ids] of byAccount) {
    await emit({
      type: 'DEADLINE_DUE_IN_7_DAYS',
      accountId, // → tous les membres actifs, chacun selon ses préférences
      entityType: 'agenda_date',
      entityId: targetDate,
      payload: { count: ids.length, date: targetDate, agendaItemIds: ids, forecastCount: forecasts.get(accountId) ?? 0 },
      // Clé stable par date locale (le moteur ajoute l'utilisateur).
      dedupeKey: `deadline:j7:${targetDate}`,
      scheduledFor: now, // livraison assurée par le dispatcher (pas de traitement immédiat en masse)
    });
    emitted++;
  }

  return { targetDate, accounts: byAccount.size, emitted };
}
