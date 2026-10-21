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
 * Lot 71G (T6-07, T6-08) : un refus de série survit à une absence
 * temporaire d'occurrence ; les dates sont des dates civiles RÉELLES,
 * bornées en Europe/Paris (demain → deux ans).
 *
 * Lot 75E (D) : une préférence d'occurrence retient le CYCLE PERSISTANT de
 * l'occurrence choisie (`t6CycleKey`, cohérent avec T4 : une ligne = une
 * occurrence ; nouveau cycle = nouvelle occurrence, ou occurrence réalisée
 * puis rouverte) — une replanification la conserve quel que soit l'écart, le
 * cycle suivant ne l'hérite pas ; plus aucun écart de 183 jours. Un refus de
 * série n'est plus retiré au bout de 365 jours sans occurrence : seulement à
 * la demande de l'utilisateur, ou quand son invalidité métier est ÉTABLIE (le
 * bien d'où il a été posé n'existe plus dans le compte).
 */
import { pgClient } from '@/db';
import { todayParis } from './collector';
import { agendaFingerprint, currentT6Fingerprints } from './t6-interpellation.service';
import {
  T6_MAX_SNOOZE_DAYS, agendaSubjectKey, preferenceAppliesToCycle, seriesSubjectKey, snoozeDateError, suggestReminderDate, t6CycleKeySql,
  type T6PreferenceDecision, type T6PreferenceScope,
} from './t6-interpellation';

type Row = Record<string, unknown>;
const rows = async (sql: string, params: unknown[]): Promise<Row[]> =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];

/** Report au plus loin (jours). */
export const MAX_SNOOZE_DAYS = T6_MAX_SNOOZE_DAYS;
/*
 * Lot 75E (D) : `SERIES_ORPHAN_RETENTION_DAYS` (retrait automatique d'un refus
 * de série après 365 jours sans occurrence, lot 71G) est SUPPRIMÉ.
 */
/** Lot 71G (T6-08) : contrôle partagé avec l'interface (`t6-interpellation`). */
export { snoozeDateError };

/** Lot 75E : colonnes `cycle_key` / `series_asset_id` (0551) présentes ? Lue une fois. */
let colonnes0551: Promise<boolean> | null = null;
export function hasPreferenceIdentityColumns(): Promise<boolean> {
  colonnes0551 ??= rows(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 't6_reminder_preferences' AND column_name = 'series_asset_id' LIMIT 1`, [],
  ).then((r) => r.length > 0).catch(() => { colonnes0551 = null; return false; });
  return colonnes0551;
}

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
  /** Lot 75E (D) : cycle persistant courant de l'occurrence. */
  cycleKey: string;
  /** Lot 75E (D) : bien de l'échéance (du compte) — rattachement d'un refus de série. */
  assetId: number | null;
}

/** L'échéance, dans le compte de la session — sinon null (jamais d'un autre compte). */
async function targetOf(accountId: number, agendaItemId: number): Promise<AgendaTarget | null> {
  if (!Number.isSafeInteger(agendaItemId) || agendaItemId <= 0) return null;
  const [r] = await rows(
    `SELECT i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS date, i.occurrence_nature, i.requires_qualification, i.series_key,
            ${t6CycleKeySql('i')} AS cycle_key,
            (SELECT min(l.asset_id) FROM agenda_asset_links l JOIN assets a ON a.id = l.asset_id AND a.account_id = i.account_id
              WHERE l.agenda_item_id = i.id) AS asset_id
       FROM agenda_items i WHERE i.id = $1 AND i.account_id = $2`,
    [agendaItemId, accountId],
  );
  if (!r) return null;
  return {
    id: Number(r.id), title: String(r.title ?? ''), date: (r.date as string | null) ?? null,
    forecast: r.occurrence_nature === 'FORECAST', requiresQualification: r.requires_qualification === true,
    seriesKey: (r.series_key as string | null) || null,
    cycleKey: String(r.cycle_key), assetId: r.asset_id == null ? null : Number(r.asset_id),
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
            to_jsonb(p) ->> 'cycle_key' AS cycle_key
       FROM t6_reminder_preferences p
      WHERE account_id = $1 AND user_id = $2 AND subject_key = ANY($3::text[])`,
    [p.accountId, p.userId, cles],
  );
  // Lot 75E (D) : la préférence d'un cycle précédent n'est ni appliquée ni présentée (même règle que la décision).
  const occ = r.find((x) => x.subject_key === agendaSubjectKey(t.id)
    && preferenceAppliesToCycle({ scope: 'OCCURRENCE', cycleKey: typeof x.cycle_key === 'string' ? x.cycle_key : null }, t.cycleKey));
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
  const [cycle, identite] = await Promise.all([hasPreferenceCycleColumns(), hasPreferenceIdentityColumns()]);
  const cols: string[] = [];
  const vals: string[] = [];
  const maj: string[] = [];
  const extra: unknown[] = [];
  const add = (col: string, cast: string, v: unknown) => { extra.push(v); cols.push(col); vals.push(`$${9 + extra.length}${cast}`); maj.push(`${col} = EXCLUDED.${col}`); };
  if (cycle) {
    // Lot 71G : date de l'occurrence choisie (traçabilité) ; absence d'occurrence de la série effacée.
    add('occurrence_date', '::date', scope === 'SERIES' ? null : t.date);
    add('orphaned_since', '::date', null);
  }
  if (identite) {
    // Lot 75E (D) : cycle PERSISTANT de l'occurrence choisie ; bien d'un refus de série.
    add('cycle_key', '', scope === 'SERIES' ? null : t.cycleKey);
    add('series_asset_id', '::int', scope === 'SERIES' ? t.assetId : null);
  }
  await rows(
    `INSERT INTO t6_reminder_preferences
       (account_id, user_id, subject_key, scope, agenda_item_id, series_key, decision, remind_at, context_fingerprint${cols.map((c) => `, ${c}`).join('')})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9${vals.map((v) => `, ${v}`).join('')})
     ON CONFLICT (account_id, user_id, subject_key) DO UPDATE SET
       scope = EXCLUDED.scope, agenda_item_id = EXCLUDED.agenda_item_id, series_key = EXCLUDED.series_key,
       decision = EXCLUDED.decision, remind_at = EXCLUDED.remind_at, context_fingerprint = EXCLUDED.context_fingerprint,
       ${maj.map((m) => `${m},`).join(' ')}
       updated_at = now()`,
    [p.accountId, p.userId, subjectKey, scope,
      // Une préférence de SÉRIE ne dépend d'aucune occurrence : elle survit à
      // la suppression de celle d'où elle a été posée.
      scope === 'SERIES' ? null : t.id, scope === 'SERIES' ? t.seriesKey : null,
      p.action === 'SNOOZE' ? 'SNOOZED' : 'DISMISSED', p.action === 'SNOOZE' ? p.remindAt : null, fingerprint,
      ...extra],
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
 *   · lot 75E (D) : préférence d'occurrence d'un cycle PRÉCÉDENT (cycle
 *     persistant différent du cycle courant : occurrence réalisée puis
 *     rouverte) — sans objet. Plus aucun écart de dates (183 jours) ;
 *   · lot 75E (D) : refus de série dont l'invalidité métier est ÉTABLIE —
 *     plus aucune occurrence de la série ET le bien d'où il a été posé
 *     n'existe plus dans le compte. Plus de retrait après 365 jours sans
 *     occurrence : une régénération T4, même longue, ne supprime jamais un
 *     refus de série ; une série sans bien connu (préférence antérieure)
 *     n'est jamais retirée automatiquement ;
 *   · évaluations d'échéances réalisées ou annulées, ou de plus de 180 jours.
 * Un REFUS sur une échéance encore présente (même cycle) n'est jamais retiré.
 * Les préférences d'une échéance supprimée disparaissent avec elle (ON
 * DELETE CASCADE).
 */
export async function cleanupT6Reminders(today: string): Promise<{ preferences: number; assessments: number; orphanedSeries?: number }> {
  const [ok] = await rows(`SELECT to_regclass('t6_reminder_preferences') IS NOT NULL AND to_regclass('t6_interpellation_assessments') IS NOT NULL AS ok`, []);
  if (!ok?.ok) return { preferences: 0, assessments: 0 };
  const [cycle, identite] = await Promise.all([hasPreferenceCycleColumns(), hasPreferenceIdentityColumns()]);
  const sansSerie = `NOT EXISTS (SELECT 1 FROM agenda_items i WHERE i.account_id = p.account_id AND i.series_key = p.series_key)`;
  let orphelines = 0;
  if (cycle) {
    // Absence d'occurrence : datée (première constatation, supervision), effacée au retour d'une occurrence.
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
         ${identite ? `OR (p.scope = 'OCCURRENCE' AND p.cycle_key IS NOT NULL AND EXISTS (
               SELECT 1 FROM agenda_items i WHERE i.id = p.agenda_item_id AND i.account_id = p.account_id
                  AND trim(coalesce(i.manual_status, '')) = '' AND ${t6CycleKeySql('i')} <> p.cycle_key))
         OR (p.scope = 'SERIES' AND p.series_asset_id IS NOT NULL AND ${sansSerie}
             AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = p.series_asset_id AND a.account_id = p.account_id))` : ''}
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
