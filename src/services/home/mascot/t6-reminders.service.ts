/**
 * Rappels T6 de l'accueil — « Me le rappeler plus tard » et « Ne plus me
 * rappeler » (lot 60). Préférences PERSONNELLES (`t6_reminder_preferences`) :
 *
 *   · par utilisateur — dans un compte Duo, le choix de l'un ne modifie
 *     jamais celui de l'autre ;
 *   · sur UNE échéance précise (occurrence), ou sur sa série récurrente
 *     (« ne plus rappeler les occurrences futures ») ;
 *   · identifiées de façon stable (`agenda:<id>` / `series:<clé>`), jamais
 *     par un texte IA ; une ligne par (compte, utilisateur, sujet) — un
 *     double clic ou deux onglets ne créent jamais de doublon ;
 *   · sans effet sur les données : l'échéance, ses documents et l'agenda
 *     restent intacts.
 *
 * Toute cible est revalidée dans le compte de la session (aucun identifiant
 * cru sur parole) : un rappel d'un autre compte n'est ni lisible ni modifiable.
 *
 * Lot 71G (T6-07, T6-08) : une préférence d'occurrence retient la date de
 * l'occurrence choisie — une replanification la conserve, un nouveau cycle
 * (identifiant réutilisé par T4) ne l'hérite pas ; un refus de série survit
 * à une absence temporaire d'occurrence ; les dates sont des dates civiles
 * RÉELLES, bornées en Europe/Paris (demain → deux ans).
 */
import { pgClient } from '@/db';
import { todayParis } from './collector';
import { agendaFingerprint, currentT6Fingerprints } from './t6-interpellation.service';
import {
  T6_MAX_SNOOZE_DAYS, T6_NEW_CYCLE_MIN_DAYS, agendaSubjectKey, preferenceAppliesToCycle, seriesSubjectKey, snoozeDateError, suggestReminderDate,
  type T6PreferenceDecision, type T6PreferenceScope,
} from './t6-interpellation';

type Row = Record<string, unknown>;
const rows = async (sql: string, params: unknown[]): Promise<Row[]> =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];

/** Report au plus loin (jours). */
export const MAX_SNOOZE_DAYS = T6_MAX_SNOOZE_DAYS;
/** Lot 71G (T6-07) : un refus de série sans aucune occurrence pendant ce délai est retiré. */
export const SERIES_ORPHAN_RETENTION_DAYS = 365;
/** Lot 71G (T6-08) : contrôle partagé avec l'interface (`t6-interpellation`). */
export { snoozeDateError };

/** Lot 71G : colonnes `occurrence_date` / `orphaned_since` (0507) présentes ? Lue une fois. */
let colonnes0507: Promise<boolean> | null = null;
function hasPreferenceCycleColumns(): Promise<boolean> {
  colonnes0507 ??= rows(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 't6_reminder_preferences' AND column_name = 'orphaned_since' LIMIT 1`, [],
  ).then((r) => r.length > 0).catch(() => { colonnes0507 = null; return false; });
  return colonnes0507;
}

export interface T6ReminderPrefView {
  scope: T6PreferenceScope;
  decision: T6PreferenceDecision;
  remindAt: string | null;
  updatedAt: string;
}

export interface T6ReminderState {
  agendaItemId: number;
  hasSeries: boolean;
  /** Date de rappel proposée (AAAA-MM-JJ). */
  suggestedDate: string;
  occurrence: T6ReminderPrefView | null;
  series: T6ReminderPrefView | null;
}

export type T6ReminderError = { ok: false; code: 'NOT_FOUND' | 'INVALID_DATE' | 'NO_SERIES' | 'INVALID_INPUT'; message: string };

interface AgendaTarget {
  id: number; title: string; date: string | null; forecast: boolean; requiresQualification: boolean; seriesKey: string | null;
}

/** L'échéance, dans le compte de la session — sinon null (jamais d'un autre compte). */
async function targetOf(accountId: number, agendaItemId: number): Promise<AgendaTarget | null> {
  if (!Number.isSafeInteger(agendaItemId) || agendaItemId <= 0) return null;
  const [r] = await rows(
    `SELECT id, title, to_char(start_date, 'YYYY-MM-DD') AS date, occurrence_nature, requires_qualification, series_key
       FROM agenda_items WHERE id = $1 AND account_id = $2`,
    [agendaItemId, accountId],
  );
  if (!r) return null;
  return {
    id: Number(r.id), title: String(r.title ?? ''), date: (r.date as string | null) ?? null,
    forecast: r.occurrence_nature === 'FORECAST', requiresQualification: r.requires_qualification === true,
    seriesKey: (r.series_key as string | null) || null,
  };
}

const view = (r: Row): T6ReminderPrefView => ({
  scope: r.scope === 'SERIES' ? 'SERIES' : 'OCCURRENCE',
  decision: r.decision === 'DISMISSED' ? 'DISMISSED' : 'SNOOZED',
  remindAt: (r.remind_at as string | null) ?? null,
  updatedAt: new Date(String(r.updated_at)).toISOString(),
});

/** État des rappels d'une échéance pour l'utilisateur de la session. */
export async function getT6ReminderState(p: { accountId: number; userId: number; agendaItemId: number; today?: string }): Promise<T6ReminderState | T6ReminderError> {
  const t = await targetOf(p.accountId, p.agendaItemId);
  if (!t) return { ok: false, code: 'NOT_FOUND', message: 'Cette échéance n’est plus disponible.' };
  const today = p.today ?? todayParis();
  const cles = [agendaSubjectKey(t.id), ...(t.seriesKey ? [seriesSubjectKey(t.seriesKey)] : [])];
  const r = await rows(
    `SELECT subject_key, scope, decision, to_char(remind_at, 'YYYY-MM-DD') AS remind_at, updated_at,
            to_jsonb(p) ->> 'occurrence_date' AS occurrence_date
       FROM t6_reminder_preferences p
      WHERE account_id = $1 AND user_id = $2 AND subject_key = ANY($3::text[])`,
    [p.accountId, p.userId, cles],
  );
  // Lot 71G (T6-07) : la préférence d'un cycle précédent n'est ni appliquée ni présentée.
  const occ = r.find((x) => x.subject_key === agendaSubjectKey(t.id)
    && preferenceAppliesToCycle({ scope: 'OCCURRENCE', occurrenceDate: typeof x.occurrence_date === 'string' ? x.occurrence_date.slice(0, 10) : null }, t.date));
  const ser = t.seriesKey ? r.find((x) => x.subject_key === seriesSubjectKey(t.seriesKey!)) : undefined;
  const [a] = await rows(
    `SELECT to_char(action_date, 'YYYY-MM-DD') AS action_date, to_char(reevaluate_on, 'YYYY-MM-DD') AS reevaluate_on
       FROM t6_interpellation_assessments WHERE account_id = $1 AND agenda_item_id = $2`,
    [p.accountId, t.id],
  ).catch(() => [] as Row[]);
  return {
    agendaItemId: t.id,
    hasSeries: !!t.seriesKey,
    suggestedDate: suggestReminderDate({
      today, dueDate: t.date,
      assessment: a ? { actionDate: (a.action_date as string | null) ?? null, reevaluateOn: (a.reevaluate_on as string | null) ?? null } : null,
    }),
    occurrence: occ ? view(occ) : null,
    series: ser ? view(ser) : null,
  };
}

/**
 * Enregistre un choix de rappel (idempotent, sans doublon : une ligne par
 * compte, utilisateur et sujet ; le dernier choix l'emporte).
 *   · SNOOZE : occurrence seulement, date entre demain et deux ans ;
 *   · DISMISS : occurrence, ou série (échéance récurrente seulement).
 */
export async function setT6Reminder(p: {
  accountId: number; userId: number; agendaItemId: number;
  action: 'SNOOZE' | 'DISMISS'; scope?: T6PreferenceScope; remindAt?: string | null; today?: string;
}): Promise<{ ok: true; state: T6ReminderState } | T6ReminderError> {
  const t = await targetOf(p.accountId, p.agendaItemId);
  if (!t) return { ok: false, code: 'NOT_FOUND', message: 'Cette échéance n’est plus disponible.' };
  const today = p.today ?? todayParis();
  const scope: T6PreferenceScope = p.scope === 'SERIES' ? 'SERIES' : 'OCCURRENCE';
  if (p.action === 'SNOOZE') {
    if (scope !== 'OCCURRENCE') return { ok: false, code: 'INVALID_INPUT', message: 'Un rappel se reporte échéance par échéance.' };
    const erreur = snoozeDateError(p.remindAt, today);
    if (erreur) return { ok: false, code: 'INVALID_DATE', message: erreur };
  }
  if (scope === 'SERIES' && !t.seriesKey) {
    return { ok: false, code: 'NO_SERIES', message: 'Cette échéance n’appartient à aucune série.' };
  }
  // Lot 71G (T6-01) : empreinte ENRICHIE (même calcul que la décision) ; à
  // défaut de pouvoir lire les preuves, empreinte historique (relue comme telle).
  const fingerprint = await currentT6Fingerprints(p.accountId, [t.id]).then((m) => m.get(t.id) ?? null).catch(() => null)
    ?? agendaFingerprint({ title: t.title, date: t.date, forecast: t.forecast, requiresQualification: t.requiresQualification });
  const subjectKey = scope === 'SERIES' ? seriesSubjectKey(t.seriesKey!) : agendaSubjectKey(t.id);
  const cycle = await hasPreferenceCycleColumns();
  await rows(
    `INSERT INTO t6_reminder_preferences
       (account_id, user_id, subject_key, scope, agenda_item_id, series_key, decision, remind_at, context_fingerprint${cycle ? ', occurrence_date, orphaned_since' : ''})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9${cycle ? ', $10::date, NULL' : ''})
     ON CONFLICT (account_id, user_id, subject_key) DO UPDATE SET
       scope = EXCLUDED.scope, agenda_item_id = EXCLUDED.agenda_item_id, series_key = EXCLUDED.series_key,
       decision = EXCLUDED.decision, remind_at = EXCLUDED.remind_at, context_fingerprint = EXCLUDED.context_fingerprint,
       ${cycle ? 'occurrence_date = EXCLUDED.occurrence_date, orphaned_since = NULL,' : ''}
       updated_at = now()`,
    [p.accountId, p.userId, subjectKey, scope,
      // Une préférence de SÉRIE ne dépend d'aucune occurrence : elle survit à
      // la suppression de celle d'où elle a été posée.
      scope === 'SERIES' ? null : t.id, scope === 'SERIES' ? t.seriesKey : null,
      p.action === 'SNOOZE' ? 'SNOOZED' : 'DISMISSED', p.action === 'SNOOZE' ? p.remindAt : null, fingerprint,
      // Lot 71G (T6-07) : cycle de l'occurrence choisie (replanification ≠ nouveau cycle).
      ...(cycle ? [scope === 'SERIES' ? null : t.date] : [])],
  );
  const state = await getT6ReminderState({ accountId: p.accountId, userId: p.userId, agendaItemId: t.id, today });
  return 'ok' in state ? state : { ok: true, state };
}

/** Réactive les rappels (occurrence ou série) pour l'utilisateur de la session. */
export async function clearT6Reminder(p: {
  accountId: number; userId: number; agendaItemId: number; scope?: T6PreferenceScope; today?: string;
}): Promise<{ ok: true; state: T6ReminderState } | T6ReminderError> {
  const t = await targetOf(p.accountId, p.agendaItemId);
  if (!t) return { ok: false, code: 'NOT_FOUND', message: 'Cette échéance n’est plus disponible.' };
  const scope: T6PreferenceScope = p.scope === 'SERIES' ? 'SERIES' : 'OCCURRENCE';
  if (scope === 'SERIES' && !t.seriesKey) return { ok: false, code: 'NO_SERIES', message: 'Cette échéance n’appartient à aucune série.' };
  await rows(
    `DELETE FROM t6_reminder_preferences WHERE account_id = $1 AND user_id = $2 AND subject_key = $3`,
    [p.accountId, p.userId, scope === 'SERIES' ? seriesSubjectKey(t.seriesKey!) : agendaSubjectKey(t.id)],
  );
  const state = await getT6ReminderState({ accountId: p.accountId, userId: p.userId, agendaItemId: t.id, today: p.today });
  return 'ok' in state ? state : { ok: true, state };
}

/**
 * Nettoyage quotidien (tâche `mascot-pregeneration-deadlines`) :
 *   · reports échus depuis plus de 90 jours, et reports d'échéances
 *     réalisées ou annulées (ils n'ont plus d'objet) ;
 *   · préférences et évaluations rattachées à une échéance passée dans un
 *     AUTRE compte (déplacement de bien) — jamais appliquées, retirées ;
 *   · lot 71G (T6-07) : refus « cette échéance » d'un cycle PRÉCÉDENT
 *     (identifiant réutilisé par T4, date décalée d'un cycle) — sans objet ;
 *   · préférences de série dont plus aucune échéance du compte ne porte la
 *     clé — lot 71G : seulement après `SERIES_ORPHAN_RETENTION_DAYS` jours
 *     d'absence continue (une régénération T4 ne supprime jamais un refus
 *     de série encore valable) ;
 *   · évaluations d'échéances réalisées ou annulées, ou de plus de 180 jours.
 * Un REFUS sur une échéance encore présente (même cycle) n'est jamais retiré.
 * Les préférences d'une échéance supprimée disparaissent avec elle (ON
 * DELETE CASCADE).
 */
export async function cleanupT6Reminders(today: string): Promise<{ preferences: number; assessments: number; orphanedSeries?: number }> {
  const [ok] = await rows(`SELECT to_regclass('t6_reminder_preferences') IS NOT NULL AND to_regclass('t6_interpellation_assessments') IS NOT NULL AS ok`, []);
  if (!ok?.ok) return { preferences: 0, assessments: 0 };
  const cycle = await hasPreferenceCycleColumns();
  const sansSerie = `NOT EXISTS (SELECT 1 FROM agenda_items i WHERE i.account_id = p.account_id AND i.series_key = p.series_key)`;
  let orphelines = 0;
  if (cycle) {
    // Absence d'occurrence : datée (première constatation), effacée au retour d'une occurrence.
    orphelines = (await rows(
      `UPDATE t6_reminder_preferences p SET orphaned_since = $1::date
        WHERE p.scope = 'SERIES' AND p.orphaned_since IS NULL AND ${sansSerie} RETURNING p.id`,
      [today],
    )).length;
    await rows(
      `UPDATE t6_reminder_preferences p SET orphaned_since = NULL
        WHERE p.scope = 'SERIES' AND p.orphaned_since IS NOT NULL AND NOT (${sansSerie})`,
      [],
    );
  }
  const prefs = await rows(
    `DELETE FROM t6_reminder_preferences p
      WHERE (p.decision = 'SNOOZED' AND p.remind_at < $1::date - 90)
         OR (p.decision = 'SNOOZED' AND p.agenda_item_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM agenda_items i WHERE i.id = p.agenda_item_id AND trim(coalesce(i.manual_status, '')) <> ''))
         OR (p.agenda_item_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM agenda_items i WHERE i.id = p.agenda_item_id AND i.account_id <> p.account_id))
         ${cycle ? `OR (p.scope = 'SERIES' AND p.orphaned_since < $1::date - ${SERIES_ORPHAN_RETENTION_DAYS} AND ${sansSerie})
         OR (p.scope = 'OCCURRENCE' AND p.decision = 'DISMISSED' AND p.occurrence_date IS NOT NULL AND EXISTS (
               SELECT 1 FROM agenda_items i WHERE i.id = p.agenda_item_id AND i.start_date IS NOT NULL
                  AND abs(i.start_date - p.occurrence_date) >= ${T6_NEW_CYCLE_MIN_DAYS}))`
           // Colonnes absentes (déploiement) : règle historique.
           : `OR (p.scope = 'SERIES' AND ${sansSerie})`}
      RETURNING p.id`,
    [today],
  );
  const evals = await rows(
    `DELETE FROM t6_interpellation_assessments a
      WHERE a.assessed_on < $1::date - 180
         OR EXISTS (SELECT 1 FROM agenda_items i WHERE i.id = a.agenda_item_id
                     AND (i.account_id <> a.account_id OR trim(coalesce(i.manual_status, '')) <> ''))
      RETURNING a.id`,
    [today],
  );
  return { preferences: prefs.length, assessments: evals.length, orphanedSeries: orphelines };
}
