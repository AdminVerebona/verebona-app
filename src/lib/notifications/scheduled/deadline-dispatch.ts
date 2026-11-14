/**
 * Rappels d'échéance — contrôle À L'ENVOI (lot 113AH, #732), appelé par le
 * dispatcher pour `DEADLINE_DUE_IN_7_DAYS`.
 *
 * Entre la mise en file et la livraison (envoi différé de 2 min après une
 * écriture, file chargée, reprise après panne), un événement peut avoir été
 * supprimé, déplacé ou être devenu « information ». Juste avant l'envoi :
 *   · chaque événement de la notification est relu (même compte, même date,
 *     catégorie « action ») ; les autres en sont retirés et leur couverture
 *     annulée (`cancelled` / `stale` : la nouvelle date est réévaluée) ;
 *   · plus aucun événement valable → rien n'est envoyé (`deadline_stale`) ;
 *   · échéance passée → rien n'est envoyé (`deadline_passed`) ;
 *   · le délai est RECALCULÉ à l'envoi en jours calendaires de Paris (une
 *     notification mise en file à 23 h 59 et envoyée après minuit dit
 *     « demain », pas « dans 2 jours »).
 * Les lignes mises en file avant 113AH (`deadline:j7:`, avec `agendaItemIds`) suivent la même
 * règle ; une ligne sans liste d'événements (émission directe) est envoyée telle quelle.
 */
import { pgClient } from '@/db';
import { DEADLINE_REMINDER_LEAD_DAYS, daysUntilDeadline } from './deadline-reminder-policy';

export const DEADLINE_STALE_SKIP_REASON = 'deadline_stale';
export const DEADLINE_PASSED_SKIP_REASON = 'deadline_passed';

interface DispatchCheck {
  skipReason?: string;
  payloadPatch?: Record<string, unknown>;
}

async function cancelCoverage(dedupeKey: string, itemIds: number[] | null, outcome: string): Promise<void> {
  try {
    await pgClient.unsafe(
      `UPDATE agenda_deadline_reminders SET state = 'cancelled', outcome = $3, updated_at = now()
        WHERE outbox_dedupe_key = $1 AND state = 'pending'
          AND ($2::text IS NULL OR agenda_item_id = ANY(string_to_array($2::text, ',')::int[]))`,
      [dedupeKey, itemIds ? itemIds.join(',') : null, outcome] as never[],
    );
  } catch (e) {
    // Suivi de couverture seulement : jamais bloquant pour l'envoi.
    console.error('[notifications] couverture des rappels (annulation) :', (e as Error).message);
  }
}

export async function checkDeadlineReminderAtDispatch(
  row: { account_id?: number | null; dedupe_key: string },
  payload: Record<string, unknown>,
  now: Date = new Date(),
): Promise<DispatchCheck> {
  const date = typeof payload.date === 'string' ? payload.date : null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return {};
  const ids = Array.isArray(payload.agendaItemIds)
    ? [...new Set((payload.agendaItemIds as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : null;
  // Rappel sans événements identifiés (émission directe hors producteur,
  // réémission ancienne) : rendu et envoi inchangés (compatibilité).
  if (!ids || row.account_id == null) return {};

  const daysUntil = daysUntilDeadline(date, now);
  if (daysUntil < 0) {
    await cancelCoverage(row.dedupe_key, null, 'expired');
    return { skipReason: DEADLINE_PASSED_SKIP_REASON };
  }
  const patch: Record<string, unknown> = { daysUntil: Math.min(daysUntil, DEADLINE_REMINDER_LEAD_DAYS) };

  const valides = (await pgClient.unsafe(
    `SELECT id, occurrence_nature AS nature FROM agenda_items
      WHERE id = ANY(string_to_array($1, ',')::int[]) AND account_id = $2
        AND start_date = $3::date AND home_category = 'action'
        AND situation IS DISTINCT FROM 'A_EU_LIEU'
      ORDER BY id`,
    [ids.join(','), Number(row.account_id), date] as never[],
  )) as unknown as Array<{ id: number; nature: string | null }>;
  const ok = valides.map((v) => Number(v.id));
  const perimes = ids.filter((id) => !ok.includes(id));
  if (perimes.length) await cancelCoverage(row.dedupe_key, perimes, 'stale');
  if (ok.length === 0) return { skipReason: DEADLINE_STALE_SKIP_REASON };
  return {
    payloadPatch: {
      ...patch,
      agendaItemIds: ok,
      count: ok.length,
      forecastCount: valides.filter((v) => v.nature === 'FORECAST').length,
    },
  };
}

/** Fin de l'envoi : couverture « traitée » (statut final de la notification). */
export async function recordDeadlineReminderOutcome(dedupeKey: string, status: string): Promise<void> {
  try {
    await pgClient.unsafe(
      `UPDATE agenda_deadline_reminders SET state = 'processed', outcome = $2, processed_at = now(), updated_at = now()
        WHERE outbox_dedupe_key = $1 AND state = 'pending'`,
      [dedupeKey, status] as never[],
    );
  } catch (e) {
    console.error('[notifications] couverture des rappels (fin d’envoi) :', (e as Error).message);
  }
}
