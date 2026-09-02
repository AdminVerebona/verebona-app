/**
 * analysis-recovery-scheduler.ts
 * Scheduler interne — tourne toutes les INTERVAL_MS (5 min par défaut).
 * Appelé depuis instrumentation.ts au démarrage du serveur Next.js.
 *
 * Singleton : ne démarre qu'une seule fois même si le module est importé plusieurs fois.
 */

import { runAnalysisRecovery } from './analysis-recovery.service';
import { purgePendingUploads } from '@/services/documents/pending-uploads-purge.service';
import { acquireJobLock } from '@/lib/job-lock';

const INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes
/** Délai avant le premier tour — laisser le serveur démarrer */
const INITIAL_DELAY_MS = 30 * 1_000; // 30 secondes

let started = false;

export function startAnalysisRecoveryScheduler(): void {
  if (started) return;
  started = true;

  console.info('[analysis-recovery-scheduler] Démarrage — premier tour dans 30s, puis toutes les 5 min.');

  // Premier tour après le délai initial (serveur complètement démarré)
  setTimeout(async () => {
    await runOnce();

    // Tours suivants toutes les INTERVAL_MS
    setInterval(runOnce, INTERVAL_MS);
  }, INITIAL_DELAY_MS);
}

async function runOnce(): Promise<void> {
  try {
    const result = await runAnalysisRecovery();
    if (result.found > 0) {
      console.info(
        `[analysis-recovery-scheduler] Tour terminé — ${result.found} trouvé(s), ${result.retried} relancé(s), ${result.errors} erreur(s).`,
      );
    }
  } catch (err) {
    console.error('[analysis-recovery-scheduler] Erreur inattendue:', (err as Error).message);
  }

  await purgeQuotidienne();
}

/**
 * Purge des téléversements jamais confirmés, une fois par jour.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE BAIL SERT ICI DE CADENCEUR, ET C'EST VOLONTAIRE
 *
 * Le bail est pris pour 23 heures et N'EST JAMAIS RENDU : sa date
 * d'expiration devient l'intervalle. Le tour suivant qui tombe dans la
 * fenêtre n'obtient rien et passe son chemin ; le premier tour après 23
 * heures reprend le bail et relance la purge.
 *
 * Un `setInterval` de 24 h ne conviendrait pas : il repartirait de zéro à
 * chaque redémarrage, et compterait autant de fois qu'il y a d'instances.
 * Le bail, lui, est partagé et survit aux redémarrages.
 *
 * `/api/cron/purge-pending-uploads` reste disponible pour un déclenchement
 * explicite — sous un autre nom de bail, pour qu'un appel manuel ne soit
 * jamais refusé par le cadenceur quotidien.
 * ══════════════════════════════════════════════════════════════════════════
 */
async function purgeQuotidienne(): Promise<void> {
  const bail = await acquireJobLock('pending-uploads-purge-daily', 23 * 60 * 60 * 1000);
  if (!bail) return;

  try {
    await purgePendingUploads();
  } catch (err) {
    console.error('[analysis-recovery-scheduler] purge des téléversements échouée:', (err as Error).message);
  }
  // Bail volontairement non rendu : son expiration cadence le prochain tour.
}
