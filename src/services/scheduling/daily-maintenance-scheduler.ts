/**
 * Tâches quotidiennes de maintenance — planification interne.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * COMMENT LES TÂCHES SONT PLANIFIÉES DANS CE DÉPÔT
 *
 * Le dépôt ne contient aucune configuration de planification d'hébergeur
 * (pas de `vercel.json`, `render.yaml`, ni workflow planifié) : les routes
 * `/api/cron/*` sont appelées, le cas échéant, par un planificateur EXTERNE
 * configuré hors dépôt, avec `Authorization: Bearer $CRON_SECRET`.
 *
 * Le seul mécanisme de planification présent DANS le code est celui de la
 * sauvegarde (`database-backup-scheduler.ts`) : un tour périodique démarré
 * par `instrumentation.ts`, une fenêtre horaire à Paris, et un bail en base
 * (`job-lock`) qui garantit une seule exécution par jour quel que soit le
 * nombre d'instances et de redémarrages. Les nouvelles tâches du lot suivent
 * EXACTEMENT ce modèle, pour ne dépendre d'aucune configuration externe
 * qu'on pourrait oublier de créer :
 *
 *   · billing-unpaid      — cycle d'impayé de 90 jours (rappels J-7/J-1,
 *                           suppression à J+90 après revérification Stripe) ;
 *                           même traitement que GET /api/cron/billing-unpaid ;
 *   · account-deletion    — suppressions planifiées arrivées à échéance
 *                           (suppression volontaire J+30 et son rappel J-7,
 *                           rétractation…) et confirmations finales ; même
 *                           traitement que GET /api/cron/account-deletion/
 *                           process ; mode ACCOUNT_DELETION_SWEEP
 *                           (absente : sans l'arriéré > 7 j | live | dry |
 *                           off) ;
 *   · gdpr-exports-purge  — archives « Mes données » expirées ; même
 *                           traitement que GET /api/cron/gdpr-exports-purge ;
 *   · ai-log-archive      — archivage S3 des logs IA > 90 jours (WF-25),
 *                           juste avant la purge de l'assistant ;
 *   · assistant-purge     — historique de l'assistant (90 j, GAP-16) et
 *                           journaux (§29.7) ; même traitement que
 *                           GET /api/cron/ai/purge-assistant-logs ;
 *   · ai-pricing-refresh  — tarifs des modèles, le lundi ; même traitement
 *                           que GET /api/cron/ai/refresh-model-pricing ;
 *   · supervision-sweep   — domaines Exports / IA de la Supervision (SUP-004) ;
 *   · admin-audit-purge   — rétention du journal admin (AUD-004,
 *                           ADMIN_AUDIT_RETENTION_DAYS, désactivée sans valeur) ;
 *   · blob-purge          — file `pending_blob_deletions` (objets S3 à
 *                           supprimer : exports, fichiers de biens
 *                           supprimés…) ; même traitement que
 *                           GET /api/cron/purge-blobs, jusque-là appelée par
 *                           aucun planificateur ; BLOB_PURGE=off la retire ;
 *   · backup-freshness    — ancienneté de la dernière sauvegarde (> 48 h ⇒
 *                           anomalie de Supervision). Jusqu'ici contrôlée
 *                           seulement à l'ouverture de l'écran Supervision :
 *                           un planificateur arrêté passait inaperçu tant que
 *                           personne ne regardait.
 *
 * Les routes restent disponibles pour un déclenchement externe ou manuel :
 * les traitements sont idempotents, un double passage est sans effet.
 *
 * ── BAIL ─────────────────────────────────────────────────────────────────
 * Pris pour 20 h et NON rendu en cas de succès : son expiration cadence le
 * jour suivant. Rendu en cas d'échec, pour qu'un tour suivant de la même
 * fenêtre réessaie.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { acquireJobLock, releaseJobLock } from '@/lib/job-lock';
import { heureDeParis } from '@/services/backup/database-backup-scheduler';
import { parseAuditRetentionDays } from '@/services/admin/audit-retention.service';
import { accountDeletionSweepMode, sweepOptionsFor } from '@/services/account/account-deletion.rules';

const TOUR_MS = 30 * 60 * 1000;
const DELAI_INITIAL_MS = 3 * 60 * 1000;
const BAIL_MS = 20 * 60 * 60 * 1000;

/** Mode du balayage d'impayés — `BILLING_UNPAID_SWEEP`. */
export type UnpaidSweepMode = 'live' | 'dry' | 'off';

/**
 * `live` (défaut) : rappels et suppressions à échéance.
 * `dry`           : simulation journalisée, rien n'est écrit — pour le
 *                   premier passage en production (même rôle que `?dryRun=1`).
 * `off`           : tâche interne désactivée (planificateur externe, ou
 *                   suspension volontaire).
 * Valeur inconnue ⇒ `dry` : une faute de frappe ne doit pas déclencher de
 * suppression de données.
 */
export function unpaidSweepMode(raw: string | undefined = process.env.BILLING_UNPAID_SWEEP): UnpaidSweepMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'live') return 'live';
  if (v === 'off' || v === 'false' || v === 'disabled') return 'off';
  return 'dry';
}

export interface DailyTask {
  /** Nom du bail en base : une exécution par jour et par tâche. */
  lock: string;
  /** Fenêtre d'exécution, heures de Paris, [début, fin[. */
  window: [number, number];
  run: () => Promise<void>;
}

/** Heure `h` dans la fenêtre [début, fin[ ? */
export function dansLaFenetre(h: number, [debut, fin]: [number, number]): boolean {
  return h >= debut && h < fin;
}

/**
 * Tâches du jour. Fenêtres décalées : la purge après la sauvegarde de nuit
 * (1 h – 5 h), le contrôle d'ancienneté après la fin de cette fenêtre, et
 * l'impayé en matinée — ses rappels sont des e-mails aux clients, mieux
 * reçus en journée qu'à 3 h.
 */
export function dailyTasks(env: NodeJS.ProcessEnv = process.env): DailyTask[] {
  const tasks: DailyTask[] = [];

  const mode = unpaidSweepMode(env.BILLING_UNPAID_SWEEP);
  if (mode !== 'off') {
    tasks.push({
      lock: 'daily-billing-unpaid',
      window: [8, 12],
      run: async () => {
        const { runUnpaidCycleSweep } = await import('@/services/billing/unpaid-cycle.service');
        const r = await runUnpaidCycleSweep({ dryRun: mode === 'dry' });
        console.info(`[daily-jobs] billing-unpaid (${mode}) :`, JSON.stringify(r));
        // Échec d'une suppression à échéance : l'anomalie est déjà ouverte
        // par le service ; on rend le bail pour réessayer dans la fenêtre.
        if (r.failed.length > 0) throw new Error(`${r.failed.length} suppression(s) à échéance en échec`);
      },
    });
  }

  // Suppressions de compte à échéance (décision produit : suppression
  // volontaire différée de 30 jours). Matinée, comme l'impayé : le rappel J-7
  // et la confirmation finale sont des e-mails aux clients. Idempotent et
  // reprenable : un double passage (route externe) est sans effet.
  const deletionMode = accountDeletionSweepMode(env.ACCOUNT_DELETION_SWEEP);
  if (deletionMode !== 'off') {
    tasks.push({
      lock: 'daily-account-deletion',
      window: [8, 12],
      run: async () => {
        const { runAccountDeletionSweepExclusive } = await import('@/services/account/voluntary-deletion.service');
        // Anomalies (échec, arriéré, utilisateur non clôturé) signalées par le
        // balayage lui-même, pour la route comme pour la tâche.
        const r = await runAccountDeletionSweepExclusive(sweepOptionsFor(deletionMode));
        if (!r) throw new Error('balayage déjà en cours (route de déclenchement)');
        console.info(`[daily-jobs] account-deletion (${deletionMode}) :`, JSON.stringify(r));
      },
    });
  }

  tasks.push({
    lock: 'daily-gdpr-exports-purge',
    window: [5, 8],
    run: async () => {
      const { purgeAllExpiredExports } = await import('@/services/gdpr/gdpr-export.service');
      const r = await purgeAllExpiredExports();
      if (r.purged > 0) console.info(`[daily-jobs] gdpr-exports-purge : ${r.purged} archive(s) supprimée(s).`);
    },
  });

  // Archivage S3 des logs IA > 90 jours — CDC BO IA WF-25, WF-45. Placé
  // AVANT la purge de l'assistant, même fenêtre (un tour exécute les tâches
  // dans l'ordre) ; le seuil de 88 jours complets garantit de toute façon
  // qu'une étape purgée à 90 jours a été archivée la veille.
  // Désactivable par AI_LOG_ARCHIVE=off.
  if (!['off', 'false', '0'].includes((env.AI_LOG_ARCHIVE ?? '').trim().toLowerCase())) {
    tasks.push({
      lock: 'daily-ai-log-archive',
      window: [5, 8],
      run: async () => {
        const { archiveAiLogs } = await import('@/services/ai/telemetry/log-archive.job');
        console.info('[daily-jobs] ai-log-archive :', JSON.stringify(await archiveAiLogs()));
      },
    });
  }

  // Purge de l'assistant — CDC Assistant §24.1 (« une purge quotidienne
  // supprime les messages plus anciens »), §28.13, §29.7, CA-11. Même
  // traitement que GET /api/cron/ai/purge-assistant-logs, idempotent : un
  // déclenchement externe en plus est sans effet. Désactivable par
  // VEREBONA_ASSISTANT_PURGE=off (purge confiée à un planificateur externe).
  if (!['off', 'false', '0'].includes((env.VEREBONA_ASSISTANT_PURGE ?? '').trim().toLowerCase())) {
    tasks.push({
      lock: 'daily-assistant-purge',
      window: [5, 8],
      run: async () => {
        const { purgeAssistantData } = await import('@/services/ai/assistant/retention/purge-assistant-logs.job');
        const r = await purgeAssistantData();
        console.info('[daily-jobs] assistant-purge :', JSON.stringify(r));
      },
    });
  }

  // Tarifs des modèles — même traitement que GET /api/cron/ai/refresh-model-pricing,
  // hebdomadaire (lundi). Désactivable par AI_PRICING_REFRESH=off.
  if (!['off', 'false', '0'].includes((env.AI_PRICING_REFRESH ?? '').trim().toLowerCase())) {
    tasks.push({
      lock: 'daily-ai-pricing-refresh',
      window: [6, 9],
      run: async () => {
        if (new Date().getUTCDay() !== 1) return;
        const { refreshModelPricing } = await import('@/services/ai/gateway/pricing/refresh-pricing.job');
        const r = await refreshModelPricing();
        console.info(`[daily-jobs] ai-pricing-refresh : ${r.status}`);
        if (r.status === 'failed') throw new Error('rafraîchissement des tarifs en échec');
      },
    });
  }

  if (env.BACKUP_DISABLED !== 'true') {
    tasks.push({
      lock: 'daily-backup-freshness',
      window: [6, 10],
      run: async () => {
        const { latestBackupAt } = await import('@/services/backup/database-backup.service');
        const { checkBackupFreshness } = await import('@/services/admin/anomaly.service');
        await checkBackupFreshness(await latestBackupAt());
      },
    });
  }

  // Supervision — domaines « Exports / transmissions » et « IA » (CDC BO
  // SUP-004, AI-001). Aussi déclenché, au plus toutes les 5 min, à
  // l'ouverture de l'écran ; ce passage quotidien garantit l'ouverture et la
  // résolution automatique même si personne ne consulte la Supervision.
  tasks.push({
    lock: 'daily-supervision-sweep',
    window: [7, 11],
    run: async () => {
      const { runSupervisionSweep } = await import('@/services/admin/supervision-sweep.service');
      console.info('[daily-jobs] supervision-sweep :', JSON.stringify(await runSupervisionSweep()));
    },
  });

  // Rétention du journal technique admin (CDC BO AUD-004) : durée fixée
  // hors BO par ADMIN_AUDIT_RETENTION_DAYS ; sans valeur valide (≥ 30 j),
  // la tâche n'est pas planifiée et rien n'est purgé.
  const auditRetentionDays = parseAuditRetentionDays(env.ADMIN_AUDIT_RETENTION_DAYS);
  if (auditRetentionDays !== null) {
    tasks.push({
      lock: 'daily-admin-audit-purge',
      window: [5, 8],
      run: async () => {
        const { purgeAdminAuditLog } = await import('@/services/admin/audit-retention.service');
        const r = await purgeAdminAuditLog(auditRetentionDays);
        if (r.deleted > 0) console.info(`[daily-jobs] admin-audit-purge : ${r.deleted} ligne(s) antérieure(s) au ${r.cutoff}.`);
      },
    });
  }

  // File de purge du stockage (objets S3 : exports supprimés, fichiers de
  // biens et de comptes supprimés). La route /api/cron/purge-blobs n'était
  // appelée par aucun planificateur du dépôt : sans configuration externe,
  // rien n'était supprimé. Ordonnée, par lots, avec backoff : un objet en
  // échec ne bloque plus la file. Désactivable par BLOB_PURGE=off.
  if (!['off', 'false', '0'].includes((env.BLOB_PURGE ?? '').trim().toLowerCase())) {
    tasks.push({
      lock: 'daily-blob-purge',
      window: [5, 8],
      run: async () => {
        const { purgePendingBlobs } = await import('@/services/storage/blob-purge.service');
        console.info('[daily-jobs] blob-purge :', JSON.stringify(await purgePendingBlobs()));
      },
    });
  }

  return tasks;
}

let demarre = false;

export function startDailyMaintenanceScheduler(): void {
  if (demarre) return;
  demarre = true;

  if (process.env.DAILY_JOBS_DISABLED === 'true') {
    console.info('[daily-jobs] désactivé (DAILY_JOBS_DISABLED=true).');
    return;
  }

  const tasks = dailyTasks();
  console.info(`[daily-jobs] démarré — ${tasks.map((t) => `${t.lock} ${t.window[0]}h-${t.window[1]}h`).join(', ')} (Paris).`);
  setTimeout(() => {
    void tour(tasks);
    setInterval(() => void tour(tasks), TOUR_MS);
  }, DELAI_INITIAL_MS);
}

/** Un tour : chaque tâche dans sa fenêtre dont le bail est libre. */
export async function tour(tasks: DailyTask[], now: Date = new Date()): Promise<void> {
  const h = heureDeParis(now);
  for (const task of tasks) {
    if (!dansLaFenetre(h, task.window)) continue;
    const bail = await acquireJobLock(task.lock, BAIL_MS).catch(() => null);
    if (!bail) continue;
    try {
      await task.run();
      // Bail conservé : il cadence la prochaine exécution.
    } catch (e) {
      console.error(`[daily-jobs] ${task.lock} en échec :`, (e as Error).message);
      await releaseJobLock(bail).catch(() => undefined);
    }
  }
}
