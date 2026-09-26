/**
 * Déclenchement nocturne de la sauvegarde de la base.
 *
 * Un tour toutes les 30 minutes ; la sauvegarde part au premier tour situé
 * dans la fenêtre de nuit (01 h – 05 h, heure de Paris) dont le bail est
 * libre. Le bail est pris pour 20 heures et n'est pas rendu en cas de succès :
 * son expiration cadence le jour suivant, quel que soit le nombre d'instances
 * et de redémarrages. En cas d'échec, il est rendu pour qu'un tour suivant de
 * la même nuit réessaie.
 *
 * `/api/cron/backup` et le bouton de la page d'administration restent
 * disponibles pour un déclenchement explicite.
 */
import { acquireJobLock, releaseJobLock } from '@/lib/job-lock';
import { runDatabaseBackup } from './database-backup.service';
import { reportBackupFailure, resolveBackupFailure } from '@/services/admin/anomaly.service';

const TOUR_MS = 30 * 60 * 1000;
const DELAI_INITIAL_MS = 2 * 60 * 1000;
const BAIL_MS = 20 * 60 * 60 * 1000;
export const BACKUP_DAILY_LOCK = 'database-backup-daily';

let demarre = false;

/** Heure courante à Paris (0-23). */
export function heureDeParis(d: Date = new Date()): number {
  // `formatToParts` : le format français rend « 03 h », que `Number()` lit NaN.
  const partie = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Paris' })
    .formatToParts(d)
    .find((p) => p.type === 'hour');
  return Number(partie?.value ?? NaN);
}

export function dansLaFenetreDeNuit(d: Date = new Date()): boolean {
  const h = heureDeParis(d);
  return h >= 1 && h < 5;
}

export function startDatabaseBackupScheduler(): void {
  if (demarre) return;
  demarre = true;

  if (process.env.BACKUP_DISABLED === 'true') {
    console.info('[backup-scheduler] désactivé (BACKUP_DISABLED=true).');
    return;
  }
  if (!process.env.OVH_S3_ACCESS_KEY_ID || !process.env.OVH_S3_SECRET_ACCESS_KEY) {
    console.warn('[backup-scheduler] identifiants de stockage absents : sauvegarde quotidienne inactive.');
    return;
  }

  console.info('[backup-scheduler] démarré — sauvegarde quotidienne entre 1 h et 5 h (Paris).');
  setTimeout(() => {
    void tour();
    setInterval(() => void tour(), TOUR_MS);
  }, DELAI_INITIAL_MS);
}

async function tour(): Promise<void> {
  if (!dansLaFenetreDeNuit()) return;
  const bail = await acquireJobLock(BACKUP_DAILY_LOCK, BAIL_MS);
  if (!bail) return;
  try {
    await runDatabaseBackup('scheduler');
    await resolveBackupFailure();
    // Bail conservé : il cadence la prochaine sauvegarde.
  } catch (e) {
    console.error('[backup-scheduler] sauvegarde échouée :', (e as Error).message);
    await reportBackupFailure('scheduler', e);
    await releaseJobLock(bail);
  }
}
