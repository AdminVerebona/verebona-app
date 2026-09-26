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
 *   · gdpr-exports-purge  — archives « Mes données » expirées ; même
 *                           traitement que GET /api/cron/gdpr-exports-purge ;
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

  tasks.push({
    lock: 'daily-gdpr-exports-purge',
    window: [5, 8],
    run: async () => {
      const { purgeAllExpiredExports } = await import('@/services/gdpr/gdpr-export.service');
      const r = await purgeAllExpiredExports();
      if (r.purged > 0) console.info(`[daily-jobs] gdpr-exports-purge : ${r.purged} archive(s) supprimée(s).`);
    },
  });

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
