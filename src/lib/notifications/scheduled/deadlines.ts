/**
 * Rappels d'échéance (CDC §7.1) — couverture PAR ÉVÉNEMENT (lot 113AH,
 * carte Trello #732).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AVANT (anomalie #732) : un passage à 8 h 30 (puis toutes les 15 min jusqu'à
 * 11 h) cherchait les événements « action » datés EXACTEMENT de J+7, et
 * émettait une notification par compte de clé `deadline:j7:<date>`. Un
 * événement créé après 11 h (J+7 devient J+6 le lendemain) ou après le
 * premier passage (clé déjà prise pour la date) n'était jamais rappelé.
 *
 * DÉSORMAIS : la couverture est mémorisée DURABLEMENT par occurrence
 * d'événement × échéance effective × destinataire (table
 * `agenda_deadline_reminders`, migration 1625 ; compte porté par la ligne) :
 *
 *   · déclenchement après une écriture VALIDÉE (création, changement de date
 *     ou de catégorie — `evaluateDeadlineRemindersAfterWrite`, appelé après la
 *     transaction par `writeAgendaItem` / ses effets d'après validation et les
 *     quelques chemins d'écriture directs) ;
 *   · rattrapage périodique (`runDeadlineReminders`, tâche interne
 *     `notifications-scheduled-events`, toutes les 15 min de 8 h 30 à 21 h) :
 *     le rappel « normal » des événements déjà connus (J+7 au passage de
 *     8 h 30) ET tout événement éligible encore non couvert (J+0 … J+7,
 *     indisponibilité, reprise après arrêt, chemin d'écriture oublié) ;
 *   · une seule transaction par destinataire : verrou consultatif
 *     (destinataire), lignes de couverture (contrainte UNIQUE événement ×
 *     échéance × destinataire, `ON CONFLICT`) ET ligne d'outbox (`emit()` avec
 *     `tx`) — soit les deux, soit rien ; deux passages simultanés ne
 *     couvrent jamais deux fois le même événement ;
 *   · regroupement : les NOUVEAUX événements d'un même destinataire et d'une
 *     même date partent ensemble — ils rejoignent la notification de même
 *     date encore en file (pas encore envoyée), sinon une nouvelle est créée ;
 *     un événement déjà couvert n'est jamais renvoyé ;
 *   · changement de date : l'ancienne couverture encore en file est annulée
 *     (`cancelled`), la nouvelle date est réévaluée — au plus un rappel par
 *     12 h pour un même événement et un même destinataire (anti-rafale) ;
 *     l'envoi re-vérifie chaque événement (supprimé, déplacé, devenu
 *     « information » : retiré de la notification ; aucun restant : rien
 *     n'est envoyé — `deadline-dispatch.ts`) ;
 *   · livraison inchangée : dispatcher, préférences de chaque destinataire
 *     (Duo compris), canaux, restrictions du compte, lien Agenda.
 *
 * Aucune seconde infrastructure : `emit()`, outbox, dispatcher, catalogue
 * (`DEADLINE_DUE_IN_7_DAYS`, délai réel `daysUntil`), PolicyResolver.
 * Lot 113P : aucun statut d'événement n'est lu.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { emit } from '../event-service';
import { resolveRecipients } from '../recipient-resolver';
import {
  DEADLINE_REMINDER_DATE_CHANGE_COOLDOWN_MS, DEADLINE_REMINDER_KEY_PREFIX, DEADLINE_REMINDER_STUCK_AFTER_MS,
  DEADLINE_REMINDER_WRITE_DELAY_MS, LEGACY_DEADLINE_KEY_PREFIX,
  calendarDaysBetween, deadlineReminderRange, isWithinDeadlineSendWindow, parisClock,
} from './deadline-reminder-policy';

const EVENT = 'DEADLINE_DUE_IN_7_DAYS' as const;
/** Espace du verrou consultatif (destinataire) — sérialise les mises en file d'un même destinataire. */
const ADVISORY_LOCK_SPACE = 1136250;

type Trigger = 'WRITE' | 'SWEEP';

interface CoverStats { recipients: number; covered: number; notifications: number; merged: number }

export interface DeadlineRunResult {
  /** Dernière date couverte (J+7) — compatibilité du journal du matin. */
  targetDate: string;
  from: string;
  accounts: number;
  recipients: number;
  /** Événements nouvellement couverts (× destinataire). */
  covered: number;
  /** Notifications créées (une par destinataire et par date) ; `emitted` : alias historique. */
  notifications: number;
  emitted: number;
  /** Événements ajoutés à une notification encore en file. */
  merged: number;
  /** Rappels restés « en cours d'envoi » sans livraison, remis en file. */
  recovered: number;
  /** Couvertures « en attente » dont l'envoi est terminé (rapprochement). */
  reconciled: number;
  errors: number;
}

class NothingEnqueued extends Error {
  constructor(public readonly reason: string) { super(`rappel non mis en file : ${reason}`); }
}

const rows = <T>(r: unknown): T[] => r as T[];

/**
 * Couvre, pour UN destinataire, les échéances éligibles non encore couvertes
 * (toutes celles du compte, ou seulement `itemIds`). Une transaction.
 */
async function coverForRecipient(accountId: number, userId: number, o: {
  now: Date; trigger: Trigger; scheduledFor: Date; itemIds?: number[];
}): Promise<Omit<CoverStats, 'recipients'>> {
  const { today, last } = deadlineReminderRange(o.now);
  const clock = parisClock(o.now);
  const nowIso = o.now.toISOString();
  const cooldownSince = new Date(o.now.getTime() - DEADLINE_REMINDER_DATE_CHANGE_COOLDOWN_MS).toISOString();
  const idsCsv = o.itemIds?.length ? o.itemIds.map((n) => Math.trunc(Number(n))).join(',') : null;
  const stats = { covered: 0, notifications: 0, merged: 0 };

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_SPACE}::int, ${userId}::int)`);

      // Couvertures en file devenues périmées (date changée, plus « action ») :
      // annulées — la nouvelle date est réévaluée ci-dessous.
      await tx.execute(sql`
        UPDATE agenda_deadline_reminders r SET state = 'cancelled', outcome = 'stale', updated_at = now()
         WHERE r.account_id = ${accountId} AND r.recipient_user_id = ${userId} AND r.state = 'pending'
           AND NOT EXISTS (SELECT 1 FROM agenda_items i WHERE i.id = r.agenda_item_id AND i.account_id = r.account_id
                            AND i.start_date = r.due_date AND i.home_category = 'action'
                            -- Lot 114V (#742) : « A eu lieu » — le rappel en file est annulé (plus rien à venir).
                            AND i.situation IS DISTINCT FROM 'A_EU_LIEU')`);

      const candidats = rows<{ id: number; due: string; nature: string | null }>(await tx.execute(sql`
        SELECT i.id, to_char(i.start_date, 'YYYY-MM-DD') AS due, i.occurrence_nature AS nature
          FROM agenda_items i
         WHERE i.account_id = ${accountId} AND i.home_category = 'action'
           AND i.situation IS DISTINCT FROM 'A_EU_LIEU'
           AND i.start_date BETWEEN ${today}::date AND ${last}::date
           AND (${idsCsv}::text IS NULL OR i.id = ANY(string_to_array(${idsCsv}::text, ',')::int[]))
           AND (i.start_date > ${today}::date OR i.start_time IS NULL OR i.start_time > ${clock}::time)
           AND NOT EXISTS (SELECT 1 FROM agenda_deadline_reminders r
                            WHERE r.agenda_item_id = i.id AND r.due_date = i.start_date
                              AND r.recipient_user_id = ${userId} AND r.state <> 'cancelled')
           AND NOT EXISTS (SELECT 1 FROM agenda_deadline_reminders r
                            WHERE r.agenda_item_id = i.id AND r.recipient_user_id = ${userId}
                              AND r.due_date <> i.start_date AND r.state <> 'cancelled'
                              AND r.enqueued_at > ${cooldownSince}::timestamptz)
           AND NOT EXISTS (SELECT 1 FROM notification_outbox o
                            WHERE o.recipient_user_id = ${userId} AND o.event_type = ${EVENT}
                              AND o.dedupe_key LIKE ${`${LEGACY_DEADLINE_KEY_PREFIX}%`}
                              AND o.payload_json ->> 'date' = to_char(i.start_date, 'YYYY-MM-DD')
                              AND (o.payload_json -> 'agendaItemIds') @> to_jsonb(i.id))
         ORDER BY i.start_date, i.id`))
        .map((r) => ({ id: Number(r.id), due: String(r.due), forecast: r.nature === 'FORECAST' }));
      if (candidats.length === 0) return;

      const parDate = new Map<string, Array<{ id: number; forecast: boolean }>>();
      for (const c of candidats) parDate.set(c.due, [...(parDate.get(c.due) ?? []), { id: c.id, forecast: c.forecast }]);

      for (const [due, items] of parDate) {
        const daysUntil = Math.max(0, Math.min(7, calendarDaysBetween(today, due)));
        // Notification de même date encore en file (pas encore envoyée) : les
        // nouveaux événements la rejoignent (regroupement entre nouveaux).
        const [enFile] = rows<{ id: string; dedupe_key: string; payload_json: Record<string, unknown> }>(await tx.execute(sql`
          SELECT id, dedupe_key, payload_json FROM notification_outbox
           WHERE recipient_user_id = ${userId} AND account_id = ${accountId} AND event_type = ${EVENT}
             AND status = 'pending' AND dedupe_key LIKE ${`${DEADLINE_REMINDER_KEY_PREFIX}%`}
             AND payload_json ->> 'date' = ${due}
           ORDER BY created_at DESC LIMIT 1
           FOR UPDATE SKIP LOCKED`));
        const base = `${DEADLINE_REMINDER_KEY_PREFIX}${accountId}:${due}:${randomUUID()}`;
        const cle = enFile ? enFile.dedupe_key : `${base}:u${userId}`;

        const pris = rows<{ id: number; forecast: boolean }>(await tx.execute(sql`
          INSERT INTO agenda_deadline_reminders
                 (account_id, agenda_item_id, due_date, recipient_user_id, state, trigger, days_before, forecast,
                  outbox_dedupe_key, enqueued_at, created_at, updated_at)
          SELECT ${accountId}, x.id, ${due}::date, ${userId}, 'pending', ${o.trigger}, ${daysUntil}, x.forecast,
                 ${cle}, ${nowIso}::timestamptz, now(), now()
            FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS x(id int, forecast boolean)
          ON CONFLICT (agenda_item_id, due_date, recipient_user_id) DO UPDATE
             SET state = 'pending', outcome = NULL, trigger = EXCLUDED.trigger, days_before = EXCLUDED.days_before,
                 forecast = EXCLUDED.forecast, outbox_dedupe_key = EXCLUDED.outbox_dedupe_key,
                 enqueued_at = EXCLUDED.enqueued_at, account_id = EXCLUDED.account_id, processed_at = NULL,
                 revived_count = agenda_deadline_reminders.revived_count + 1, updated_at = now()
           WHERE agenda_deadline_reminders.state = 'cancelled'
          RETURNING agenda_item_id AS id, forecast`)).map((r) => ({ id: Number(r.id), forecast: !!r.forecast }));
        if (pris.length === 0) continue;
        stats.covered += pris.length;

        if (enFile) {
          const p = enFile.payload_json ?? {};
          const ids = [...new Set([...(Array.isArray(p.agendaItemIds) ? (p.agendaItemIds as number[]).map(Number) : []), ...pris.map((x) => x.id)])];
          const payload = {
            ...p, date: due, agendaItemIds: ids, count: ids.length, daysUntil,
            forecastCount: Number(p.forecastCount ?? 0) + pris.filter((x) => x.forecast).length,
          };
          await tx.execute(sql`UPDATE notification_outbox SET payload_json = ${JSON.stringify(payload)}::jsonb WHERE id = ${enFile.id}::uuid AND status = 'pending'`);
          stats.merged += pris.length;
          continue;
        }

        await emit({
          type: EVENT,
          accountId,
          recipientUserIds: [userId], // chaque destinataire : sa couverture, ses préférences (Duo)
          entityType: 'agenda_date',
          entityId: due,
          payload: {
            count: pris.length, date: due, agendaItemIds: pris.map((x) => x.id),
            forecastCount: pris.filter((x) => x.forecast).length, daysUntil,
          },
          dedupeKey: base,
          scheduledFor: o.scheduledFor,
          tx,
        });
        // emit() n'a rien mis en file (compte devenu non éligible, destinataire
        // absent, doublon de clé) : la couverture est annulée avec la transaction —
        // jamais « couvert » sans notification.
        const [ok] = rows<{ id: string }>(await tx.execute(sql`SELECT id FROM notification_outbox WHERE dedupe_key = ${cle}`));
        if (!ok) throw new NothingEnqueued('emit_without_outbox_row');
        stats.notifications += 1;
      }
    });
  } catch (e) {
    if (e instanceof NothingEnqueued) {
      console.info(JSON.stringify({ event: 'deadline_reminder.not_enqueued', accountId, userId, reason: e.reason }));
      return { covered: 0, notifications: 0, merged: 0 };
    }
    throw e;
  }
  return stats;
}

/** Couvre les échéances d'un compte, pour chacun de ses destinataires. */
async function coverAccount(accountId: number, o: { now: Date; trigger: Trigger; scheduledFor: Date; itemIds?: number[] }): Promise<CoverStats> {
  // Lot 82A : compte non actif, suspendu, en lecture seule — rien n'est
  // couvert (il le sera, s'il redevient actif avant l'échéance).
  const { checkAccountProcessingEligibility } = await import('@/services/account/processing-eligibility');
  const e = await checkAccountProcessingEligibility(accountId, { now: o.now });
  if (!e.eligible) {
    console.info(JSON.stringify({ event: 'account.processing_refused', stage: 'deadline_reminder', accountId, reason: e.reason }));
    return { recipients: 0, covered: 0, notifications: 0, merged: 0 };
  }
  const destinataires = await resolveRecipients({ accountId, type: EVENT });
  const total: CoverStats = { recipients: destinataires.length, covered: 0, notifications: 0, merged: 0 };
  for (const userId of destinataires) {
    const s = await coverForRecipient(accountId, userId, o);
    total.covered += s.covered; total.notifications += s.notifications; total.merged += s.merged;
  }
  return total;
}

/**
 * Après une écriture VALIDÉE d'éléments d'agenda (création, date ou
 * catégorie modifiée) : rappel des échéances de J+0 à J+7 sans attendre le
 * prochain passage. Hors plage d'envoi (avant 8 h 30, après 21 h) : rien —
 * le passage de 8 h 30 rattrape. Envoi différé de 2 min (regroupement,
 * modifications successives). Ne lève jamais (le rattrapage périodique reste
 * le filet). Une sauvegarde sans changement ne renvoie rien (couverture
 * existante).
 */
export async function evaluateDeadlineRemindersAfterWrite(
  accountId: number,
  itemIds: readonly number[],
  opts: { now?: Date } = {},
): Promise<{ skipped?: 'outside_send_window' | 'not_eligible' | 'error'; covered?: number }> {
  const now = opts.now ?? new Date();
  const ids = [...new Set(itemIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return { skipped: 'not_eligible' };
  if (!isWithinDeadlineSendWindow(now)) return { skipped: 'outside_send_window' };
  try {
    const { today, last } = deadlineReminderRange(now);
    // Filtre peu coûteux : la plupart des écritures (T4, projections) portent
    // sur des dates lointaines ou des événements « information ».
    const dansLaFenetre = (await pgClient.unsafe(
      `SELECT id FROM agenda_items WHERE account_id = $1 AND id = ANY(string_to_array($2, ',')::int[])
          AND home_category = 'action' AND start_date BETWEEN $3::date AND $4::date`,
      [accountId, ids.join(','), today, last] as never[],
    ) as unknown as Array<{ id: number }>).map((r) => Number(r.id));
    if (!dansLaFenetre.length) return { skipped: 'not_eligible' };
    const s = await coverAccount(accountId, {
      now, trigger: 'WRITE', itemIds: dansLaFenetre,
      scheduledFor: new Date(now.getTime() + DEADLINE_REMINDER_WRITE_DELAY_MS),
    });
    return { covered: s.covered };
  } catch (e) {
    console.error(JSON.stringify({ event: 'deadline_reminder.write_trigger_failed', accountId, itemIds: ids, error: (e as Error).message?.slice(0, 300) }));
    return { skipped: 'error' };
  }
}

/**
 * Rattrapage périodique (et rappel normal à J+7) : toutes les échéances
 * éligibles non couvertes des comptes, de J+0 à J+7. Idempotent : un second
 * passage, un redémarrage ou un double déclenchement ne couvrent rien de plus.
 * Un compte en erreur n'interrompt pas les autres (erreur comptée, journalisée,
 * reprise au passage suivant).
 */
export async function runDeadlineReminders(now: Date = new Date()): Promise<DeadlineRunResult> {
  const { today, last } = deadlineReminderRange(now);
  const recovered = await recoverStuckDeadlineReminders(now);
  const reconciled = await reconcileDeadlineReminderStates();

  const comptes = (await pgClient.unsafe(
    `SELECT DISTINCT account_id AS "accountId" FROM agenda_items
      WHERE home_category = 'action' AND start_date BETWEEN $1::date AND $2::date ORDER BY 1`,
    [today, last] as never[],
  ) as unknown as Array<{ accountId: number }>).map((r) => Number(r.accountId));

  const res: DeadlineRunResult = {
    targetDate: last, from: today, accounts: 0, recipients: 0, covered: 0, notifications: 0, emitted: 0, merged: 0,
    recovered, reconciled, errors: 0,
  };
  for (const accountId of comptes) {
    try {
      const s = await coverAccount(accountId, { now, trigger: 'SWEEP', scheduledFor: now });
      if (s.covered > 0) res.accounts += 1;
      res.recipients += s.recipients; res.covered += s.covered; res.notifications += s.notifications; res.merged += s.merged;
    } catch (e) {
      res.errors += 1;
      console.error(JSON.stringify({ event: 'deadline_reminder.sweep_account_failed', accountId, error: (e as Error).message?.slice(0, 300) }));
    }
  }
  res.emitted = res.notifications;
  return res;
}

/**
 * Rappel resté « en cours d'envoi » (`processing`) sans AUCUNE livraison
 * depuis plus d'une heure : le processus d'envoi s'est arrêté entre la prise
 * en charge et la livraison. Remis en file (trace dans `last_error`) — jamais
 * une ligne qui a déjà livré un canal (pas de doublon).
 */
async function recoverStuckDeadlineReminders(now: Date): Promise<number> {
  const seuil = new Date(now.getTime() - DEADLINE_REMINDER_STUCK_AFTER_MS).toISOString();
  const r = (await pgClient.unsafe(
    `UPDATE notification_outbox o SET status = 'pending', last_error = 'stuck_processing_recovered'
      WHERE o.event_type = $1 AND o.status = 'processing'
        AND o.created_at < $2::timestamptz AND COALESCE(o.scheduled_for, o.created_at) < $2::timestamptz
        AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.outbox_id = o.id)
      RETURNING o.id`,
    [EVENT, seuil] as never[],
  )) as unknown as unknown[];
  if (r.length) console.warn(JSON.stringify({ event: 'deadline_reminder.stuck_recovered', count: r.length }));
  return r.length;
}

/** Couvertures « en attente » dont la notification est terminée (tout chemin de fin, échecs compris). */
async function reconcileDeadlineReminderStates(): Promise<number> {
  const r = (await pgClient.unsafe(
    `UPDATE agenda_deadline_reminders c SET state = 'processed', outcome = o.status,
            processed_at = COALESCE(o.processed_at, now()), updated_at = now()
       FROM notification_outbox o
      WHERE c.state = 'pending' AND o.dedupe_key = c.outbox_dedupe_key
        AND o.status NOT IN ('pending', 'processing')
      RETURNING c.id`,
  )) as unknown as unknown[];
  return r.length;
}
