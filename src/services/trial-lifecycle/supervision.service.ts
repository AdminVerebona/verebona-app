/**
 * Lot 100G — supervision de la séquence de fin d'essai (BO › Communications ›
 * Fin d'essai) : SYNTHÈSE (état OK / À surveiller / Incident, par jalon), puis
 * DÉTAIL (journal filtrable). Lecture seule ; aucune adresse e-mail renvoyée.
 */
import { pgClient } from '@/db';
import {
  MILESTONES, TRIAL_RETENTION_PURGE_IMPLEMENTED, envSwitches, offsetDaysOf, reasonLabel, retentionLockState,
  type MilestoneCode, type TrialLifecycleSettings,
} from './milestones';
import { appBaseUrl, buildOffersUrl, unsubscribeSecret } from './links';
import { loadTrialLifecycleSettings } from './settings.service';
import { OBSOLETE_TRIAL_MENTION } from './templates';

export type Health = 'OK' | 'WATCH' | 'INCIDENT';
export const HEALTH_LABELS: Record<Health, string> = { OK: 'OK', WATCH: 'À surveiller', INCIDENT: 'Incident' };

export const TRIAL_LIFECYCLE_TASK_CODE = 'trial-lifecycle-emails';

export interface MilestoneSummary {
  code: MilestoneCode;
  label: string;
  nature: string;
  templateCode: string;
  offsetDays: number;
  catchUpHours: number;
  /** Actif / désactivé / bloqué (libellé simple). */
  state: { active: boolean; label: string };
  template: { exists: boolean; version: number | null; customized: boolean; newerShipped: boolean };
  counts: { sent: number; failed: number; skipped: number; waiting: number; blocked: number; conversions: number };
  topReasons: Array<{ reason: string; label: string; count: number }>;
}

export interface TrialLifecycleSummary {
  health: Health;
  healthLabel: string;
  reasons: string[];
  periodDays: number;
  settings: TrialLifecycleSettings;
  settingsUpdatedAt: string | null;
  settingsUpdatedBy: string | null;
  env: { allOff: boolean; commercialOff: boolean; unsubscribeAvailable: boolean; appUrl: boolean; offersUrl: string | null };
  retention: { locked: boolean; label: string };
  task: { status: string | null; lastSuccessAt: string | null; lastError: string | null; suspended: boolean } | null;
  obsoleteTemplates: string[];
  totals: { sent: number; failed: number; skipped: number; waiting: number; blocked: number; conversions: number; unsubscribes: number };
  milestones: MilestoneSummary[];
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

function milestoneState(code: MilestoneCode, s: TrialLifecycleSettings, sw: { allOff: boolean; commercialOff: boolean }): { active: boolean; label: string } {
  const m = MILESTONES.find((x) => x.code === code)!;
  if (sw.allOff) return { active: false, label: 'Coupé (variable TRIAL_LIFECYCLE_EMAILS)' };
  if (m.nature === 'conditional') {
    const lock = retentionLockState({ retentionPurgeImplemented: TRIAL_RETENTION_PURGE_IMPLEMENTED });
    if (lock.locked) return { active: false, label: lock.label };
  }
  if (m.nature === 'service') return s.serviceEnabled ? { active: true, label: 'Actif' } : { active: false, label: 'Désactivé (réglage)' };
  if (sw.commercialOff) return { active: false, label: 'Coupé (variable TRIAL_COMMERCIAL_EMAILS)' };
  if (!s.commercialEnabled) return { active: false, label: 'Désactivé (campagne commerciale non activée)' };
  return { active: true, label: s.legalBasis === 'consent' ? 'Actif — destinataires ayant consenti' : 'Actif — base « client existant » déclarée' };
}

export async function getTrialLifecycleSummary(now: Date = new Date(), periodDays = 30): Promise<TrialLifecycleSummary> {
  const { settings, updatedAt, updatedByEmail } = await loadTrialLifecycleSettings();
  const sw = envSwitches();
  const since = new Date(now.getTime() - periodDays * 86_400_000).toISOString();
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  const byStatus = await pgClient<{ milestone: string; status: string; reason: string | null; n: number }[]>`
    SELECT milestone, status, reason, count(*)::int AS n FROM trial_lifecycle_messages
     WHERE updated_at >= ${since} GROUP BY milestone, status, reason`;
  const conv = await pgClient<{ milestone: string | null; n: number }[]>`
    SELECT milestone, count(*)::int AS n FROM trial_lifecycle_events WHERE event_type = 'conversion' AND created_at >= ${since} GROUP BY milestone`;
  const [unsub] = await pgClient<{ n: number }[]>`
    SELECT count(*)::int AS n FROM trial_lifecycle_events WHERE event_type = 'unsubscribe' AND created_at >= ${since}`;
  const [recent] = await pgClient<{ final_failed: number; retrying: number; missed: number; stuck: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'failed' AND decided_at IS NOT NULL AND updated_at >= ${week})::int AS final_failed,
           count(*) FILTER (WHERE status = 'failed' AND decided_at IS NULL)::int AS retrying,
           count(*) FILTER (WHERE status = 'skipped' AND reason IN ('out_of_window', 'technical_error') AND updated_at >= ${week})::int AS missed,
           count(*) FILTER (WHERE status = 'sending' AND claimed_at < ${new Date(now.getTime() - 3_600_000).toISOString()})::int AS stuck
      FROM trial_lifecycle_messages`;
  const templates = await pgClient<{ type: string; subject: string; body: string; is_customized: boolean; shipped_updated_at: Date | null; version: number | null }[]>`
    SELECT upper(t.type) AS type, t.subject, t.body, t.is_customized, t.shipped_updated_at,
           (SELECT max(v.version_no) FROM email_template_versions v WHERE v.template_type = upper(t.type)) AS version
      FROM email_templates t`;
  const tplByCode = new Map(templates.map((t) => [t.type, t]));
  const obsoleteTemplates = templates.filter((t) => OBSOLETE_TRIAL_MENTION.test(`${t.subject}\n${t.body}`)).map((t) => t.type).sort();
  const [task] = await pgClient<{ last_status: string | null; last_success_at: Date | null; last_error: string | null; admin_disabled: boolean | null }[]>`
    SELECT last_status, last_success_at, last_error, admin_disabled FROM scheduled_task_state WHERE code = ${TRIAL_LIFECYCLE_TASK_CODE}`.catch(() => [] as never[]);

  const totals = { sent: 0, failed: 0, skipped: 0, waiting: 0, blocked: 0, conversions: 0, unsubscribes: unsub?.n ?? 0 };
  const milestones: MilestoneSummary[] = MILESTONES.map((m) => {
    const rows = byStatus.filter((r) => r.milestone === m.code);
    const sum = (st: string[]) => rows.filter((r) => st.includes(r.status)).reduce((a, r) => a + r.n, 0);
    const counts = {
      sent: sum(['sent']), failed: sum(['failed']), skipped: sum(['skipped']), waiting: sum(['pending', 'sending', 'deferred']),
      blocked: sum(['blocked']), conversions: conv.filter((c) => c.milestone === m.code).reduce((a, c) => a + c.n, 0),
    };
    for (const k of Object.keys(counts) as Array<keyof typeof counts>) totals[k] += counts[k];
    const reasonCounts = new Map<string, number>();
    for (const r of rows) if (r.reason && r.status !== 'sent') reasonCounts.set(r.reason, (reasonCounts.get(r.reason) ?? 0) + r.n);
    const tpl = tplByCode.get(m.templateCode);
    return {
      code: m.code, label: m.label, nature: m.nature, templateCode: m.templateCode,
      offsetDays: offsetDaysOf(m, settings), catchUpHours: settings.catchUpHours[m.code],
      state: milestoneState(m.code, settings, sw),
      template: { exists: !!tpl, version: tpl?.version ?? null, customized: !!tpl?.is_customized, newerShipped: !!tpl?.is_customized && !!tpl?.shipped_updated_at },
      counts,
      topReasons: [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([reason, count]) => ({ reason, label: reasonLabel(reason), count })),
    };
  });
  totals.conversions = conv.reduce((a, c) => a + c.n, 0);

  // ── État global ──────────────────────────────────────────────────────────
  const incident: string[] = [];
  const watch: string[] = [];
  if ((recent?.final_failed ?? 0) > 0) incident.push(`${recent.final_failed} e-mail(s) en échec définitif sur 7 jours (voir le détail).`);
  if (obsoleteTemplates.length) incident.push(`Mention obsolète (essai de 60 jours, 2 mois offerts ou 59 €) dans : ${obsoleteTemplates.join(', ')}.`);
  for (const ms of milestones) {
    if (ms.state.active && !ms.template.exists) incident.push(`${ms.label} : modèle ${ms.templateCode} absent.`);
  }
  if (task?.last_status === 'error') incident.push(`Dernier passage de la tâche en erreur : ${String(task.last_error ?? '').slice(0, 160)}`);
  if (settings.commercialEnabled && !sw.commercialOff && !(unsubscribeSecret() && appBaseUrl())) {
    incident.push('Campagne commerciale active mais lien de désinscription impossible (secret ou adresse de l’application absents) : relances en attente.');
  }
  if ((recent?.retrying ?? 0) > 0) watch.push(`${recent.retrying} envoi(s) en échec, nouvelle tentative au prochain passage.`);
  if ((recent?.missed ?? 0) > 0) watch.push(`${recent.missed} jalon(s) non envoyé(s) hors fenêtre sur 7 jours (tâche arrêtée ou erreur ?).`);
  if ((recent?.stuck ?? 0) > 0) watch.push(`${recent.stuck} envoi(s) « en cours » depuis plus d’une heure (repris automatiquement).`);
  for (const ms of milestones) if (ms.template.newerShipped) watch.push(`${ms.label} : modèle personnalisé, un texte livré plus récent est disponible (BO › Communications › Comparer).`);
  if (task?.admin_disabled) watch.push('Tâche « Séquence de fin d’essai » suspendue dans Exploitation › Tâches planifiées.');
  if (sw.allOff) watch.push('Séquence coupée par la variable TRIAL_LIFECYCLE_EMAILS.');
  if (!settings.serviceEnabled) watch.push('Notifications de service J−2 / J0 désactivées dans les réglages.');
  if (!buildOffersUrl(settings)) watch.push('Adresse de l’application inconnue (NEXT_PUBLIC_APP_URL) : aucun lien « offres » possible.');

  const health: Health = incident.length ? 'INCIDENT' : watch.length ? 'WATCH' : 'OK';
  return {
    health, healthLabel: HEALTH_LABELS[health], reasons: [...incident, ...watch], periodDays,
    settings, settingsUpdatedAt: updatedAt, settingsUpdatedBy: updatedByEmail,
    env: { allOff: sw.allOff, commercialOff: sw.commercialOff, unsubscribeAvailable: !!unsubscribeSecret() && !!appBaseUrl(), appUrl: !!appBaseUrl(), offersUrl: buildOffersUrl(settings) },
    retention: retentionLockState({ retentionPurgeImplemented: TRIAL_RETENTION_PURGE_IMPLEMENTED }),
    task: task ? { status: task.last_status, lastSuccessAt: iso(task.last_success_at), lastError: task.last_error, suspended: !!task.admin_disabled } : null,
    obsoleteTemplates, totals, milestones,
  };
}

export interface JournalRow {
  id: number;
  at: string;
  eventType: string;
  milestone: string | null;
  accountId: number | null;
  userId: number | null;
  templateCode: string | null;
  templateVersion: number | null;
  reason: string | null;
  reasonLabel: string;
  actor: string;
  detail: Record<string, unknown>;
}

const EVENT_TYPES = new Set(['sent', 'failed', 'not_sent', 'deferred', 'blocked', 'conversion', 'unsubscribe', 'settings_changed']);

/** Journal détaillé (plus récent d'abord), filtres optionnels. */
export async function listTrialLifecycleJournal(q: { milestone?: string | null; eventType?: string | null; reason?: string | null; accountId?: number | null; page?: number; pageSize?: number }):
  Promise<{ rows: JournalRow[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(q.pageSize ?? 50, 1), 200);
  const page = Math.max(q.page ?? 1, 1);
  const milestone = q.milestone && MILESTONES.some((m) => m.code === q.milestone) ? q.milestone : null;
  const eventType = q.eventType && EVENT_TYPES.has(q.eventType) ? q.eventType : null;
  const reason = q.reason && /^[a-z_]{2,40}$/.test(q.reason) ? q.reason : null;
  const accountId = q.accountId && Number.isSafeInteger(q.accountId) ? q.accountId : null;
  const where = pgClient`
    WHERE (${milestone}::text IS NULL OR milestone = ${milestone})
      AND (${eventType}::text IS NULL OR event_type = ${eventType})
      AND (${reason}::text IS NULL OR reason = ${reason})
      AND (${accountId}::int IS NULL OR account_id = ${accountId})`;
  const [{ n }] = await pgClient<{ n: number }[]>`SELECT count(*)::int AS n FROM trial_lifecycle_events ${where}`;
  const rows = await pgClient<{
    id: number; created_at: Date; event_type: string; milestone: string | null; account_id: number | null; user_id: number | null;
    template_code: string | null; template_version: number | null; reason: string | null; actor: string; detail: Record<string, unknown>;
  }[]>`
    SELECT id, created_at, event_type, milestone, account_id, user_id, template_code, template_version, reason, actor, detail
      FROM trial_lifecycle_events ${where}
     ORDER BY created_at DESC, id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
  return {
    total: n, page, pageSize,
    rows: rows.map((r) => ({
      id: Number(r.id), at: new Date(r.created_at).toISOString(), eventType: r.event_type, milestone: r.milestone,
      accountId: r.account_id, userId: r.user_id, templateCode: r.template_code, templateVersion: r.template_version,
      reason: r.reason, reasonLabel: reasonLabel(r.reason), actor: r.actor,
      // Jamais d'adresse e-mail d'utilisateur ; l'administrateur auteur d'un réglage reste visible.
      detail: r.detail ?? {},
    })),
  };
}
