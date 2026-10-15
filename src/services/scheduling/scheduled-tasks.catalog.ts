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
 *   mascot-pregeneration-deadlines  chaque jour à 5 h 40          une ligne par compte (upsert) ; nettoyage rappels T6 (lot 60)
 *   t1-invalid-output-replay        au démarrage, puis /h tant    contrainte unique (document,
 *                                   qu'il reste des rejeux        version de résolution) — 0285
 *   ai-call-diagnostics-purge       chaque jour à 5 h 50          suppressions idempotentes
 *   ai-output-coherence-check       au démarrage                  lecture seule (diagnostic)
 *   t1-source-units-backfill        au démarrage, puis /h tant    NOT EXISTS + remplacement par
 *                                   qu'il reste des documents     document (idempotent) — 0295
 *   t1-completeness-retry           toutes les 15 min             tentatives comptées par document,
 *                                                                 `next_retry_at` (0295)
 *   ai-catalog-sync                 toutes les 6 h                bail `ai-catalog-sync` (même
 *                                                                 fonction que « Actualiser le
 *                                                                 catalogue »), upserts idempotents
 *   stripe-catalog-sync             toutes les 5 min              bail `stripe-catalog-sync:<contexte>`
 *                                                                 (lot 35C, catalogue lookup_key)
 *   stripe-catalog-publish          toutes les 5 min              bail `stripe-catalog-publication:<ctx>`
 *                                                                 + état partagé (aucun dégel sur échec)
 *   stripe-price-revaluation        toutes les heures             index unique campagne × item,
 *                                                                 clés d'idempotence Stripe
 *   auth-rate-limits-purge          chaque jour à 5 h 30          suppressions idempotentes
 *                                                                 (lot 37, limiteur d'authentification)
 *   transactional-emails-retry      toutes les minutes            prise atomique par demande (UPDATE
 *                                                                 conditionnel), une demande ouverte par
 *                                                                 compte / Duo (lot 57A, 0405)
 *   asset-account-backfill          au démarrage, puis /h tant    verrou de ligne du bien ; ne touche
 *                                   qu'il reste des biens         que ce qui est resté dans l'ancien
 *                                   déplacés incohérents          compte (lot 40, Duo)
 *   operations-structured-migration au démarrage, puis toutes      verrou Opération du compte ; repère
 *                                   les heures (rien à faire :     par bien × version (0322) — rejouée,
 *                                   une seule requête)             aucune écriture (lot 43, C23.1)
 *   operations-claim-migration      au démarrage, puis toutes      verrou Opération du compte ; repère
 *                                   les heures (rien à faire :     par bien × version × empreinte
 *                                   une seule requête)             (0323) — rejouée, aucune écriture
 *                                                                  (lot 44, C14.3)
 *   operations-quality-check        chaque jour à 6 h 50          lecture seule (READ ONLY) ; alerte de
 *                                                                 Supervision par empreinte (lot 47A, C26.2)
 *   cross-account-relations-check   chaque jour à 7 h 05          lecture seule (READ ONLY) ; alerte de
 *                                                                 Supervision par type (lot 49, SEC-P0) ;
 *                                                                 jamais de correction
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
      // Lot 60 (T6) : nettoyage des rappels et évaluations sans objet
      // (reports échus, échéances réalisées, déplacées ou séries disparues).
      const { cleanupT6Reminders } = await import('@/services/home/mascot/t6-reminders.service');
      const c = await cleanupT6Reminders(todayParis()).catch((e) => ({ error: (e as Error).message }));
      return { note: `${n} compte(s) signalé(s) ; rappels T6 : ${JSON.stringify(c)}` };
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
      // Lot 58C : rapports d'exécution T1 / T3 — même horizon que les traces.
      const { purgeExecutionReports } = await import('@/services/ai/execution-report/repository');
      const r = await purgeExecutionReports({ olderThanDays: archiveAfterDays(), deadline });
      return { note: `${n} diagnostic(s), ${r} rapport(s) d’exécution supprimé(s) (plus de ${archiveAfterDays()} jours)` };
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
  {
    // Lot 34F (ticket T1 « extraction exhaustive ») : couche A des documents
    // analysés avant le lot, construite depuis les données DÉJÀ persistées —
    // aucune réanalyse, aucun appel IA, lots bornés (T1_BACKFILL_BATCH).
    code: 't1-source-units-backfill',
    label: 'IA : couche source des documents historiques (sans réanalyse)',
    schedule: { kind: 'startup', delayMs: 6 * MIN, retryMs: HOUR },
    timeoutMs: 10 * MIN,
    run: async ({ deadline }) => {
      const { runSourceUnitsBackfill } = await import('@/services/ai/source-analysis/source-units/jobs');
      const r = await runSourceUnitsBackfill({ deadline: Math.min(deadline, Date.now() + 8 * MIN) });
      if (r.disabled) return { note: 'migrations 0295-0297 absentes : rien à faire' };
      return { note: JSON.stringify(r), again: r.more, ...(r.failed > 0 && r.processed === 0 ? { error: `${r.failed} document(s) en échec` } : {}) };
    },
  },
  {
    // Lot 34F : reprise CIBLÉE des documents INCOMPLETE_RETRYABLE (unités en
    // échec seulement), bornée (T1_COMPLETENESS_MAX_RETRIES, T1_RETRY_BATCH).
    code: 't1-completeness-retry',
    label: 'IA : reprise ciblée des analyses T1 incomplètes',
    schedule: { kind: 'interval', everyMs: 15 * MIN },
    timeoutMs: 10 * MIN,
    startupDelayMs: 8 * MIN,
    run: async ({ deadline }) => {
      const { runCompletenessRetry } = await import('@/services/ai/source-analysis/source-units/jobs');
      const r = await runCompletenessRetry({ deadline: Math.min(deadline, Date.now() + 8 * MIN) });
      if (r.disabled) return { note: 'migrations 0295-0297 absentes : rien à faire' };
      if (r.examined > 0) return { note: JSON.stringify(r) };
    },
  },
  {
    // Lot 35B (ticket « Catalogue IA dynamique Google ») : catalogue modèles
    // (`GET /v1beta/models`), qualification automatique, statut opérationnel,
    // tarifs de la page officielle, alertes sur modèle actif disparu — la
    // MÊME fonction métier que le bouton « Actualiser le catalogue » du BO.
    code: 'ai-catalog-sync',
    label: 'IA : synchronisation du catalogue (modèles, qualification, tarifs)',
    schedule: { kind: 'interval', everyMs: 6 * HOUR },
    timeoutMs: 15 * MIN,
    startupDelayMs: 10 * MIN,
    run: async ({ trigger }) => {
      const { syncAiCatalog, summaryOf } = await import('@/services/ai/provider/ai-catalog-sync.service');
      const r = await syncAiCatalog({ trigger: trigger === 'manual' ? 'manual' : trigger === 'startup' ? 'startup' : 'schedule' });
      if (r.skipped) return { note: 'ignoré : synchronisation déjà en cours (bouton du BO)', skipped: true };
      const note = JSON.stringify(summaryOf(r)).slice(0, 1500);
      // Sans clé active (poste local), rien à synchroniser : pas une panne.
      if (!r.catalog.ok && /Aucune clé fournisseur/i.test(r.catalog.error ?? '')) return { note };
      if (!r.catalog.ok) return { note, error: `catalogue fournisseur : ${r.catalog.error ?? 'échec'}` };
      return { note };
    },
  },
  {
    // Lot 35C (CDC lookup_key V4) : projections du catalogue Stripe et
    // reprise historique automatique — aucune commande d'exploitation.
    code: 'stripe-catalog-sync',
    label: 'Stripe : catalogue des prix (clés stables) et reprise historique',
    schedule: { kind: 'interval', everyMs: 5 * MIN },
    timeoutMs: 10 * MIN,
    startupDelayMs: 3 * MIN,
    run: async (ctx) => {
      const { runCatalogSyncTask } = await import('@/services/billing/catalog-tasks');
      return runCatalogSyncTask(ctx);
    },
  },
  {
    // Publication de la grille du code (LK-102) : jamais au démarrage d'une
    // instance (EX-006) — bail partagé, état FAILED bloquant (LK-27).
    code: 'stripe-catalog-publish',
    label: 'Stripe : publication de la grille tarifaire du code',
    schedule: { kind: 'interval', everyMs: 5 * MIN },
    timeoutMs: 15 * MIN,
    startupDelayMs: 12 * MIN,
    run: async () => {
      const { runCatalogPublishTask } = await import('@/services/billing/catalog-tasks');
      return runCatalogPublishTask();
    },
  },
  {
    // Revalorisation des abonnés existants à leur prochain renouvellement
    // (§24.2, §25.3) : seulement les lignes à information préalable PROUVÉE.
    code: 'stripe-price-revaluation',
    label: 'Stripe : revalorisation des abonnements au renouvellement',
    schedule: { kind: 'interval', everyMs: HOUR },
    timeoutMs: 10 * MIN,
    startupDelayMs: 15 * MIN,
    run: async (ctx) => {
      const { runRevaluationTask } = await import('@/services/billing/catalog-tasks');
      return runRevaluationTask(ctx);
    },
  },
  {
    // Lot 37 (C4) : compteurs du limiteur d'authentification partagé
    // (`auth_rate_limits`, migration 0313) — lignes inactives depuis 48 h et
    // sans verrou en cours. Suppressions idempotentes.
    code: 'auth-rate-limits-purge',
    label: 'Sécurité : purge des compteurs de tentatives de connexion',
    schedule: { kind: 'daily', at: [5, 30], graceMs: 6 * HOUR },
    timeoutMs: 5 * MIN,
    run: async () => {
      const { purgeAuthRateLimits } = await import('@/lib/auth/auth-rate-limit');
      const n = await purgeAuthRateLimits();
      return { note: `${n} compteur(s) de tentatives supprimé(s)` };
    },
  },
  {
    // Lot 57A (ticket P0 e-mails) : e-mails indispensables au parcours
    // (vérification d'adresse, invitation Duo) dont la demande est enregistrée
    // en base (`transactional_email_jobs`, 0405) — reprise des demandes jamais
    // tentées (processus arrêté), des échecs temporaires et des tentatives
    // interrompues. Bornée (6 tentatives), sans doublon (prise atomique).
    code: 'transactional-emails-retry',
    label: 'E-mails indispensables : vérification d’adresse et invitations Duo (reprise)',
    schedule: { kind: 'interval', everyMs: MIN },
    timeoutMs: 4 * MIN,
    startupDelayMs: MIN,
    critical: { staleAfterMs: 30 * MIN },
    ownSlot: true,
    run: async ({ deadline }) => {
      const { runTransactionalEmailRetry } = await import('@/services/email/transactional-email-jobs.service');
      const r = await runTransactionalEmailRetry({ deadline: Math.min(deadline, Date.now() + 50_000) });
      if (r.processed > 0) return { note: JSON.stringify(r) };
    },
  },
  {
    // Lot 40 (volet B, décision PO) : biens déplacés entre comptes AVANT le
    // correctif — documents et données restés dans l'ancien compte, remis
    // avec leur bien (même règle qu'un déplacement Duo). Idempotent ; aussi
    // pilotable depuis le BO (Exploitation › Rattrapages, simulation).
    code: 'asset-account-backfill',
    label: 'Duo : données des biens déplacés restées dans l’ancien compte',
    schedule: { kind: 'startup', delayMs: 4 * MIN, retryMs: HOUR },
    timeoutMs: 10 * MIN,
    run: async ({ deadline }) => {
      const { runAssetAccountBackfill } = await import('@/services/assets/asset-account-backfill');
      const r = await runAssetAccountBackfill({ apply: true, deadline: Math.min(deadline, Date.now() + 8 * MIN) });
      // Lot 54 : seuls les déplacements PROUVÉS sont rattrapés ; les autres
      // écarts restent des anomalies d'isolation (jamais transférés ici).
      const sansPreuve = r.unproven ? ` ; ${r.unproven} écart(s) sans preuve de déplacement, non transféré(s) (Isolation des comptes)` : '';
      if (r.detected === 0) return { note: `aucun bien déplacé incohérent${sansPreuve}` };
      const note = `${r.processed} bien(s) remis en cohérence, ${r.failed.length} en échec${r.more ? ', reste à traiter' : ''}${sansPreuve}`;
      return { note, again: r.more || r.failed.length > 0, ...(r.processed === 0 && r.failed.length > 0 ? { error: note } : {}) };
    },
  },
  {
    // Lot 43 (O4, CDC Opérations V1 C23.1, B24) : migration STRUCTURÉE de
    // l'existant — achat, statut / vente, assurance de chaque bien réconciliés
    // en Opérations (sources ASSET_DATA), sans réanalyser aucun document (P19).
    // Idempotente (repère bien × version, 0322) ; reprend aussi un bien
    // modifié dont l'événement `asset_updated` aurait été perdu. Toutes les
    // heures dès le démarrage : sans bien à traiter, une seule requête.
    // Aussi pilotable depuis le BO (Exploitation › Rattrapages, simulation).
    code: 'operations-structured-migration',
    label: 'Opérations : données structurées des biens (achat, vente, assurance)',
    schedule: { kind: 'interval', everyMs: HOUR },
    timeoutMs: 10 * MIN,
    run: async ({ deadline }) => {
      const { runStructuredOperationsMigration } = await import('@/services/business-operations/consolidation/asset-data-consolidator');
      const r = await runStructuredOperationsMigration({ apply: true, deadline: Math.min(deadline, Date.now() + 8 * MIN) });
      if (r.scanned === 0) return { note: 'aucun bien à examiner' };
      const crees = Object.values(r.outcomes).reduce((n, o) => n + (o.CREATE_NEW ?? 0), 0);
      const enrichies = Object.values(r.outcomes).reduce((n, o) => n + (o.MATCH_AND_ENRICH ?? 0), 0);
      const note = `${r.processed} bien(s) examiné(s), ${crees} Opération(s) créée(s), ${enrichies} enrichie(s), `
        + `${r.failed.length} en échec${r.more ? ', reste à traiter' : ''}`;
      return { note, ...(r.processed === 0 && r.failed.length > 0 ? { error: note } : {}) };
    },
  },
  {
    // Lot 44 (O5, CDC Opérations V1 C14.3, décision PO Q11) : l'ancien
    // formulaire Sinistre (`claim_json`, un sinistre par bien) devient une
    // Opération CLAIM — seuil minimal (type, date, référence ou montant),
    // « trouver avant de créer », élément d'agenda lié sans doublon, pièces et
    // photos rattachées. Reprend aussi une écriture de l'ancien JSON par un
    // ancien client (retour arrière) — report sur le sinistre reflété.
    // Idempotente (repère bien × version × empreinte, 0323). Toutes les heures
    // dès le démarrage : sans bien à traiter, une seule requête. Aussi
    // pilotable depuis le BO (Exploitation › Rattrapages, simulation).
    code: 'operations-claim-migration',
    label: 'Sinistres : reprise de l’ancien formulaire',
    schedule: { kind: 'interval', everyMs: HOUR },
    timeoutMs: 10 * MIN,
    run: async ({ deadline }) => {
      const { runClaimMigration } = await import('@/services/business-operations/consolidation/claim-migration');
      const r = await runClaimMigration({ apply: true, deadline: Math.min(deadline, Date.now() + 8 * MIN) });
      if (r.scanned === 0) return { note: 'aucun bien à examiner' };
      const note = `${r.processed} bien(s) examiné(s), ${r.outcomes.CREATED ?? 0} sinistre(s) créé(s), ${(r.outcomes.MATCHED ?? 0) + (r.outcomes.LINKED ?? 0)} rapproché(s), `
        + `${r.outcomes.RESYNCED ?? 0} resynchronisé(s), ${(r.outcomes.BELOW_THRESHOLD ?? 0) + (r.outcomes.HOLD_AMBIGUOUS ?? 0)} sans création, `
        + `${r.failed.length} en échec${r.more ? ', reste à traiter' : ''}`;
      return { note, ...(r.processed === 0 && r.failed.length > 0 ? { error: note } : {}) };
    },
  },
  {
    // Lot 47A (O9, CDC Opérations V1 C26.2, ACC-022) : anomalies dures des
    // Opérations (active sans source, composante sans source, lien inter-
    // comptes, cycle / profondeur parent, montant négatif, OTHER en repli).
    // Lecture seule ; chaque code non nul ouvre ou consolide une anomalie de
    // Supervision, résolue d'elle-même à 0. Jamais de réparation (Q9).
    code: 'operations-quality-check',
    label: 'Opérations : contrôle des anomalies dures (alerte de Supervision)',
    schedule: { kind: 'daily', at: [6, 50], graceMs: 6 * HOUR },
    timeoutMs: 10 * MIN,
    run: async () => {
      const { runOperationsQualityCheck } = await import('@/services/business-operations/diagnostics/alerts');
      const r = await runOperationsQualityCheck();
      const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
      return { note: `${total} anomalie(s) dure(s) — ${JSON.stringify(r.counts)} ; ${r.reported} signalée(s), ${r.resolved} résolue(s)`.slice(0, 1500) };
    },
  },
  {
    // Lot 49 (ticket SEC-P0 §5, AC08) : relations intercomptes déjà présentes
    // en base (documents, fournisseurs, événements, agenda, preuves, jobs IA
    // en attente). Lecture seule ; chaque type non nul ouvre ou consolide une
    // anomalie de Supervision (nombre, comptes, identifiants), résolue d'elle-
    // même à 0. JAMAIS de correction ni de suppression automatique : rapport
    // complet dans BO › Exploitation › Relations intercomptes.
    code: 'cross-account-relations-check',
    label: 'Sécurité : contrôle de l’isolation des comptes (alerte de Supervision)',
    schedule: { kind: 'daily', at: [7, 5], graceMs: 6 * HOUR },
    timeoutMs: 15 * MIN,
    run: async ({ trigger }) => {
      const { runCrossAccountCheck } = await import('@/services/security/cross-account/alerts');
      const { ISOLATION_STATUS_LABELS } = await import('@/services/security/cross-account/detection');
      const r = await runCrossAccountCheck(undefined, trigger === 'manual' ? 'manual' : 'scheduled');
      const erreurs = Object.keys(r.errors);
      const note = `${ISOLATION_STATUS_LABELS[r.status]} — ${r.total} relation(s) intercomptes — ${JSON.stringify(Object.fromEntries(Object.entries(r.counts).filter(([, n]) => n > 0)))} ; `
        + `${r.reported} signalée(s), ${r.resolved} résolue(s)${erreurs.length ? ` ; contrôles non exécutés : ${erreurs.join(', ')}` : ''}`;
      // Lot 54 (SEC-07) : un seul contrôle non exécuté = échec global du diagnostic.
      return { note: note.slice(0, 1500), ...(r.status === 'INCOMPLET' ? { error: note.slice(0, 500) } : {}) };
    },
  },
];

export function findTask(code: string, tasks: readonly ScheduledTaskDef[] = SCHEDULED_TASKS): ScheduledTaskDef | undefined {
  return tasks.find((t) => t.code === code);
}
