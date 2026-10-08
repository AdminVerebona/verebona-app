/**
 * Catalogue des tâches planifiées internes — lot 25, chantier A.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PLUS AUCUN PLANIFICATEUR EXTERNE
 *
 * Ces tâches étaient des routes `/api/cron/*` appelées par un planificateur
 * d'hébergeur configuré hors dépôt (en-tête `Authorization: Bearer
 * $CRON_SECRET`). Une entrée oubliée ou mal réglée (fuseau UTC) suffisait à
 * ce qu'un traitement ne tourne plus, sans que personne le voie. Elles sont
 * désormais lancées par l'application elle-même (`scheduled-task-runner.ts`),
 * qui appelle DIRECTEMENT les mêmes traitements que les routes — jamais de
 * requête HTTP vers soi-même.
 *
 * Les routes restent disponibles pour un déclenchement manuel (CRON_SECRET
 * inchangé). Un appel externe qui subsisterait est sans effet nuisible :
 * chaque traitement est idempotent, ou protégé par un bail en base partagé
 * avec la tâche (voir la colonne « double exécution » ci-dessous).
 *
 *   code                            calendrier (Paris)            double exécution
 *   notifications-dispatch          toutes les minutes            FOR UPDATE SKIP LOCKED
 *   notifications-to-process-scan   toutes les 10 min             dedupe_key unique
 *   notifications-scheduled-events  /15 min de 8 h 30 à 11 h      dedupe_key par date locale
 *   notifications-purge             chaque jour à 5 h 20          suppressions idempotentes
 *   expire-trials                   toutes les heures             UPDATE … RETURNING atomique
 *   to-process-scan                 toutes les heures (critique)  bail `to-process-scan`
 *   duo-dunning                     chaque jour à 6 h 10          index unique (duo, étape)
 *   withdrawal-process              toutes les heures             bail `withdrawal-sweep`
 *   referral-rewards                chaque jour à 10 h 15         prise atomique par événement
 *   legal-verify-integrity          le lundi à 6 h 40             lecture seule (+ journal)
 *   t3-legacy-transfer              au démarrage, puis /h tant    bail `t3-legacy-transfer`
 *                                   que des demandes subsistent
 *   mascot-pregeneration            toutes les minutes            FOR UPDATE SKIP LOCKED + bail par compte
 *   mascot-pregeneration-deadlines  chaque jour à 5 h 40          une ligne par compte (upsert)
 *   t1-invalid-output-replay        au démarrage, puis /h tant    contrainte unique (document,
 *                                   qu'il reste des rejeux        version de résolution) — 0285
 *   ai-call-diagnostics-purge       chaque jour à 5 h 50          suppressions idempotentes
 *   ai-output-coherence-check       au démarrage                  lecture seule (diagnostic)
 *
 * Créneaux fixes hors de la fenêtre de sauvegarde de nuit (1 h – 5 h) et de
 * la plage ambiguë des changements d'heure (2 h – 3 h).
 *
 * ── ARRÊT D'URGENCE ──────────────────────────────────────────────────────
 *   SCHEDULED_TASKS_DISABLED=true          toutes ces tâches (même convention
 *                                          que DAILY_JOBS_DISABLED, qui garde
 *                                          son périmètre : tâches quotidiennes)
 *   SCHEDULED_TASK_<CODE>=off              une tâche (code en majuscules, `-`
 *                                          → `_`, ex. SCHEDULED_TASK_DUO_DUNNING)
 * Aucune variable n'est obligatoire. Une tâche arrêtée n'est ni planifiée ni
 * exécutable depuis le BO ; sa route reste disponible.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { TaskSchedule } from './task-calendar';
import {
  T3_LEGACY_TRANSFER_TIMEOUT_MS, TO_PROCESS_SCAN_TIMEOUT_MS, WITHDRAWAL_SWEEP_TIMEOUT_MS,
} from './task-timeouts';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Résultat d'une exécution. Une exception vaut `error`. */
export interface TaskRunResult {
  /** Échec « métier » (traitement terminé mais anomalie à signaler). */
  error?: string;
  /** Résumé journalisé (jamais de donnée personnelle). */
  note?: string;
  /** Tâche de démarrage : redemander un passage (travail restant). */
  again?: boolean;
  /**
   * Passage IGNORÉ (verrou interne détenu par la route) : consigné `ok` mais
   * sans avancer le dernier succès ni remettre à zéro les échecs — le chien de
   * garde voit une tâche qui ne fait plus rien.
   */
  skipped?: boolean;
}

export interface TaskRunContext {
  /** Instant au-delà duquel une boucle de traitement doit rendre la main. */
  deadline: number;
  trigger: 'schedule' | 'manual' | 'startup';
}

export interface ScheduledTaskDef {
  code: string;
  label: string;
  schedule: TaskSchedule;
  /** Délai maximal d'une exécution ; le bail vaut le double. */
  timeoutMs: number;
  /** Tâche à intervalle : délai avant la toute première exécution. */
  startupDelayMs?: number;
  /** Tâche critique : alerte de Supervision (échecs consécutifs, arrêt). */
  critical?: { staleAfterMs: number };
  /**
   * Hors de la limite d'exécutions simultanées par instance (envoi des
   * notifications : court, chaque minute, ne doit pas attendre un balayage).
   */
  ownSlot?: boolean;
  run: (ctx: TaskRunContext) => Promise<TaskRunResult | void>;
}

/** Variables d'environnement lues (sous-ensemble de `process.env`). */
export type TaskEnv = Record<string, string | undefined>;

const OFF = new Set(['off', 'false', '0', 'disabled', 'no']);

/** Nom de la variable d'arrêt d'une tâche. */
export function taskEnvVar(code: string): string {
  return `SCHEDULED_TASK_${code.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** Arrêt d'urgence global (`SCHEDULED_TASKS_DISABLED=true`). */
export function schedulerDisabled(env: TaskEnv = process.env): boolean {
  return ['true', '1', 'yes', 'on'].includes((env.SCHEDULED_TASKS_DISABLED ?? '').trim().toLowerCase());
}

/** La tâche est-elle active (ni arrêt global, ni arrêt propre) ? */
export function isTaskEnabled(code: string, env: TaskEnv = process.env): boolean {
  if (schedulerDisabled(env)) return false;
  return !OFF.has((env[taskEnvVar(code)] ?? '').trim().toLowerCase());
}

export const SCHEDULED_TASKS: readonly ScheduledTaskDef[] = [
  {
    code: 'notifications-dispatch',
    label: 'Envoi des notifications',
    schedule: { kind: 'interval', everyMs: MIN },
    timeoutMs: 4 * MIN,
    startupDelayMs: MIN,
    critical: { staleAfterMs: 15 * MIN },
    ownSlot: true,
    // Outbox par lots de 100 jusqu'à épuisement, borné à 50 s : un passage
    // par minute absorbe un pic sans chevaucher le suivant.
    run: async ({ deadline }) => {
      const { processPending } = await import('@/lib/notifications');
      const total = { claimed: 0, sent: 0, partial: 0, failed: 0, skipped: 0 };
      const budget = Math.min(deadline, Date.now() + 50_000);
      for (;;) {
        const s = await processPending(100);
        total.claimed += s.claimed; total.sent += s.sent; total.partial += s.partial;
        total.failed += s.failed; total.skipped += s.skipped;
        if (s.claimed < 100 || Date.now() >= budget) break;
      }
      if (total.claimed > 0) return { note: JSON.stringify(total) };
    },
  },
  {
    code: 'notifications-to-process-scan',
    label: 'Notifications « À traiter »',
    schedule: { kind: 'interval', everyMs: 10 * MIN },
    timeoutMs: 10 * MIN,
    startupDelayMs: 3 * MIN,
    run: async () => {
      const { runToProcessScan } = await import('@/lib/notifications/scheduled/to-process-scan');
      const r = await runToProcessScan();
      if (r.created > 0 || r.resolved > 0) return { note: JSON.stringify(r) };
    },
  },
  {
    code: 'notifications-scheduled-events',
    label: 'Rappels du matin (échéances, récapitulatif, fin d’essai)',
    // Envoi à 8 h 30 ; passages suivants jusqu'à 11 h pour rattraper un
    // échec (dédupliqués par date locale). Jamais d'envoi tardif : hors de
    // la fenêtre, le créneau est sauté.
    schedule: { kind: 'interval', everyMs: 15 * MIN, window: { from: [8, 30], to: [11, 0] } },
    timeoutMs: 15 * MIN,
    startupDelayMs: 2 * MIN,
    run: async () => {
      const { runMorningScheduledEvents } = await import('@/lib/notifications/scheduled/morning-events');
      const r = await runMorningScheduledEvents();
      if (r.skipped) return { note: r.skipped };
    },
  },
  {
    code: 'notifications-purge',
    label: 'Purge des notifications (rétention)',
    schedule: { kind: 'daily', at: [5, 20], graceMs: 6 * HOUR },
    timeoutMs: 15 * MIN,
    run: async () => {
      const { runNotificationPurge } = await import('@/lib/notifications/scheduled/purge');
      return { note: JSON.stringify(await runNotificationPurge()) };
    },
  },
  {
    code: 'expire-trials',
    label: 'Fin des essais gratuits',
    schedule: { kind: 'interval', everyMs: HOUR },
    timeoutMs: 5 * MIN,
    startupDelayMs: 5 * MIN,
    critical: { staleAfterMs: 3 * HOUR },
    run: async () => {
      const { runTrialExpiry } = await import('@/services/trial-expiry.job');
      const r = await runTrialExpiry();
      if (r.expired > 0) return { note: `${r.expired} essai(s) basculé(s) en lecture seule` };
    },
  },
  {
    code: 'to-process-scan',
    label: 'Balayage « À traiter » (production, priorités)',
    schedule: { kind: 'interval', everyMs: HOUR },
    timeoutMs: TO_PROCESS_SCAN_TIMEOUT_MS,
    startupDelayMs: 8 * MIN,
    // Lot 28 : la production des actions nées d'un état de la base (document
    // sans bien, agenda sans date…) en dépend — un arrêt doit se voir.
    critical: { staleAfterMs: 3 * HOUR },
    run: async ({ deadline, trigger }) => {
      const { runToProcessFullScan } = await import('@/services/to-process/to-process-scan.job');
      // Trace détaillée de chaque passage : `to_process_scan_runs` (BO).
      const r = await runToProcessFullScan({ trigger, deadline });
      if (r === null) return { note: 'ignoré : balayage déjà en cours (route)', skipped: true };
      const note = JSON.stringify(r);
      // Tous les comptes en échec : la tâche est en échec (Supervision).
      if (r.errors > 0 && r.accounts > 0 && r.errors >= r.accounts) return { error: `${r.errors} compte(s) en échec`, note };
      return { note };
    },
  },
  {
    code: 'duo-dunning',
    label: 'Jalons d’impayé Premium Duo',
    schedule: { kind: 'daily', at: [6, 10], graceMs: 6 * HOUR },
    timeoutMs: 10 * MIN,
    run: async () => {
      const { runDuoDunning } = await import('@/services/billing/duo-dunning.job');
      return { note: JSON.stringify(await runDuoDunning()) };
    },
  },
  {
    code: 'withdrawal-process',
    label: 'Traitement des rétractations',
    schedule: { kind: 'interval', everyMs: HOUR },
    timeoutMs: WITHDRAWAL_SWEEP_TIMEOUT_MS,
    startupDelayMs: 6 * MIN,
    critical: { staleAfterMs: 3 * HOUR },
    run: async () => {
      const { runWithdrawalSweep } = await import('@/services/withdrawal/withdrawal-sweep.job');
      const r = await runWithdrawalSweep();
      if (r === null) return { note: 'ignoré : balayage déjà en cours (route)', skipped: true };
      const note = JSON.stringify({ processed: r.processed, ...r.outcome, stale: r.stale.length });
      // §21 : une demande en échec après reprise, ou en attente depuis plus de
      // 24 h, est une anomalie — même signal que le 409 de la route.
      if (r.outcome.failed > 0 || r.stale.length > 0) {
        return { note, error: `${r.outcome.failed} demande(s) en échec, ${r.stale.length} en attente depuis plus de 24 h` };
      }
      return { note };
    },
  },
  {
    code: 'referral-rewards',
    label: 'Avantages de parrainage',
    schedule: { kind: 'daily', at: [10, 15], graceMs: 8 * HOUR },
    timeoutMs: 20 * MIN,
    run: async () => {
      const { runReferralRewards } = await import('@/services/referral/referral-rewards.job');
      const r = await runReferralRewards();
      const note = JSON.stringify(r);
      // Chaque échec est déjà signalé par événement (SUP-009) ; l'état de la
      // tâche le reflète aussi.
      if (r.errors > 0) return { note, error: `${r.errors} attribution(s) en échec` };
      return { note };
    },
  },
  {
    code: 'legal-verify-integrity',
    label: 'Intégrité des documents légaux',
    schedule: { kind: 'weekly', isoDay: 1, at: [6, 40], graceMs: 24 * HOUR },
    timeoutMs: 10 * MIN,
    run: async () => {
      const { verifyIntegrity } = await import('@/services/legal');
      const r = await verifyIntegrity();
      if (r.issues.length > 0) return { error: `${r.issues.length} écart(s) d'intégrité sur ${r.checked} version(s)` };
      return { note: `${r.checked} version(s) contrôlée(s)` };
    },
  },
  {
    code: 't3-legacy-transfer',
    label: 'Transfert de l’ancienne file T3',
    schedule: { kind: 'startup', delayMs: 90_000, retryMs: HOUR },
    timeoutMs: T3_LEGACY_TRANSFER_TIMEOUT_MS,
    run: async () => {
      const { transferLegacyT3Queue } = await import('@/services/ai/reconciliation/legacy-queue-transfer');
      const r = await transferLegacyT3Queue();
      if (r === null) return { note: 'ignoré : transfert déjà en cours (route)', again: true, skipped: true };
      if (r.before === 0) return { note: 'aucune demande à transférer' };
      const note = `${r.before - r.remaining} demande(s) transférée(s), ${r.remaining} restante(s)`;
      if (r.remaining === 0) return { note };
      // Lots de 200 : un reste avec progrès n'est pas un échec ; aucun
      // progrès, si (transferts refusés).
      return r.remaining < r.before ? { note, again: true } : { note, again: true, error: note };
    },
  },
  {
    // Lot 32 (décision PO 6) : texte T6 de l'accueil préparé dès que la
    // situation d'un compte change — lot borné, coût plafonné par compte.
    code: 'mascot-pregeneration',
    label: 'Mascotte : pré-génération du texte d’accueil',
    schedule: { kind: 'interval', everyMs: MIN },
    timeoutMs: 4 * MIN,
    startupDelayMs: 2 * MIN,
    // Court (≤ 25 s), chaque minute : ne retient pas les balayages.
    ownSlot: true,
    run: async ({ deadline }) => {
      const { runMascotPregeneration } = await import('@/services/home/mascot/pregen-queue');
      const r = await runMascotPregeneration({ deadline: Math.min(deadline, Date.now() + 25_000) });
      if (r.claimed > 0) return { note: JSON.stringify(r) };
    },
  },
  {
    // Le passage d'une échéance change la situation sans action de personne.
    code: 'mascot-pregeneration-deadlines',
    label: 'Mascotte : échéances du jour (pré-génération)',
    schedule: { kind: 'daily', at: [5, 40], graceMs: 6 * HOUR },
    timeoutMs: 10 * MIN,
    run: async () => {
      const [{ enqueueDeadlineSituations }, { todayParis }, { EXT_ACTION_LOOKBACK_DAYS }] = await Promise.all([
        import('@/services/home/mascot/pregen-queue'),
        import('@/services/home/mascot/collector'),
        import('@/services/home/mascot/signals'),
      ]);
      const n = await enqueueDeadlineSituations(todayParis(), EXT_ACTION_LOOKBACK_DAYS);
      return { note: `${n} compte(s) signalé(s)` };
    },
  },
  {
    // Lot 33D (cas 8) : après un correctif de la résolution des sorties IA,
    // les documents en échec « sortie invalide » repassent dans la file T1,
    // sans action de l'utilisateur — un rejeu par document et par version.
    code: 't1-invalid-output-replay',
    label: 'IA : rejeu des analyses en échec « sortie invalide »',
    schedule: { kind: 'startup', delayMs: 4 * MIN, retryMs: HOUR },
    timeoutMs: 10 * MIN,
    run: async () => {
      const { runInvalidOutputReplay } = await import('@/services/ai/source-analysis/invalid-output-replay.job');
      const r = await runInvalidOutputReplay();
      if (r.disabled) return { note: 'rejeu désactivé (AI_INVALID_OUTPUT_REPLAY=off)' };
      return { note: JSON.stringify(r), again: r.more || r.pending > 0 || r.enqueued > 0 };
    },
  },
  {
    // Lot 33D : diagnostics d'appel et sorties modèle conservées — même
    // horizon que les traces IA (AI_LOG_ARCHIVE_AFTER_DAYS, 88 jours).
    code: 'ai-call-diagnostics-purge',
    label: 'IA : purge des diagnostics et sorties modèle (rétention)',
    schedule: { kind: 'daily', at: [5, 50], graceMs: 6 * HOUR },
    timeoutMs: 15 * MIN,
    run: async ({ deadline }) => {
      const [{ purgeCallDiagnostics }, { archiveAfterDays }] = await Promise.all([
        import('@/services/ai/gateway/diagnostics/diagnostic.repository'),
        import('@/services/ai/telemetry/log-archive.job'),
      ]);
      const n = await purgeCallDiagnostics({ olderThanDays: archiveAfterDays(), deadline });
      return { note: `${n} diagnostic(s) supprimé(s) (plus de ${archiveAfterDays()} jours)` };
    },
  },
  {
    // Lot 33D (§26) : cohérence prompt ↔ schéma ↔ adaptateurs au démarrage.
    // Diagnostic seulement : ne bloque jamais rien (résultat dans la note).
    code: 'ai-output-coherence-check',
    label: 'IA : cohérence prompts / schémas de sortie (diagnostic)',
    schedule: { kind: 'startup', delayMs: 2 * MIN, retryMs: 24 * HOUR },
    timeoutMs: 2 * MIN,
    run: async () => {
      const { runOutputCoherenceCheck } = await import('@/services/ai/governance/output-coherence');
      const r = await runOutputCoherenceCheck();
      const alertes = r.report.flatMap((o) => o.findings.filter((f) => f.severity === 'warning').map((f) => `${o.operationCode} [${f.source}] ${f.message}`));
      if (alertes.length) console.warn(`[ai-coherence] ${alertes.length} adaptation(s) nécessaire(s) :\n${alertes.join('\n')}`);
      return { note: `${r.operations} opération(s) : ${r.warnings} adaptation(s) nécessaire(s), ${r.infos} information(s)${alertes.length ? ` — ${alertes.slice(0, 3).join(' | ').slice(0, 600)}` : ''}` };
    },
  },
];

export function findTask(code: string, tasks: readonly ScheduledTaskDef[] = SCHEDULED_TASKS): ScheduledTaskDef | undefined {
  return tasks.find((t) => t.code === code);
}
