/**
 * analysis-recovery-scheduler.ts
 * Scheduler interne — tourne toutes les INTERVAL_MS (5 min par défaut).
 * Appelé depuis instrumentation.ts au démarrage du serveur Next.js.
 *
 * Singleton : ne démarre qu'une seule fois même si le module est importé plusieurs fois.
 */

import { runAnalysisRecovery } from './analysis-recovery.service';

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
}
