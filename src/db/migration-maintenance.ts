/**
 * Planification de la maintenance des index en arrière-plan (lot 24b).
 *
 * Un index optionnel que l'étape de déploiement n'a pas pu construire dans
 * son délai (transactions de l'ancienne version, budget de 20 min du
 * postdeploy) reste « en attente ». Ce planificateur le fait construire plus
 * tard par l'application, sans intervention : `runIndexMaintenance`
 * (`migration-index.ts`), délai long, une construction à la fois.
 *
 * Bornes — pas de boucle agressive :
 *   · premier passage différé (`firstDelayMs` : après le postdeploy sur
 *     Scalingo, voir `indexMaintenanceFirstDelayMs`) ;
 *   · `done` (rien en attente, aucun index invalide) : le planificateur
 *     s'arrête — il ne tourne plus jusqu'au prochain démarrage ;
 *   · `pending` (échec, délai dépassé) : intervalle doublé à chaque passage
 *     infructueux, plafonné à `maxIntervalMs` ;
 *   · `busy` (un autre exécutant a la main) : intervalle de base ;
 *   · jamais deux passages simultanés dans le processus ; minuteries `unref`
 *     (n'empêchent pas l'arrêt du processus).
 *
 * Module pur (aucun accès base) : le passage est injecté.
 */

export type MaintenanceRoundResult = 'done' | 'pending' | 'busy';

export interface MaintenanceSchedule {
  firstDelayMs: number;
  intervalMs: number;
  maxIntervalMs: number;
}

export interface MaintenanceSchedulerOptions extends MaintenanceSchedule {
  run: () => Promise<MaintenanceRoundResult>;
  log?: { warn: (m: string) => void; error: (m: string) => void };
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface MaintenanceScheduler {
  /** Délai du prochain passage programmé (ms), ou null si arrêté. */
  nextDelayMs(): number | null;
  stop(): void;
}

/** Délai suivant après un passage (voir l'en-tête). */
export function nextMaintenanceDelay(result: MaintenanceRoundResult, echecsConsecutifs: number, s: MaintenanceSchedule): number | null {
  if (result === 'done') return null;
  if (result === 'busy') return s.intervalMs;
  const facteur = 2 ** Math.min(Math.max(0, echecsConsecutifs - 1), 10);
  return Math.min(s.intervalMs * facteur, s.maxIntervalMs);
}

export function scheduleIndexMaintenance(o: MaintenanceSchedulerOptions): MaintenanceScheduler {
  const log = o.log ?? console;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  });
  const clearTimer = o.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let prochain: number | null = null;
  let arrete = false;
  let enCours = false;
  let echecs = 0;

  const programmer = (ms: number | null) => {
    prochain = ms;
    if (ms == null || arrete) return;
    timer = setTimer(() => { void tour(); }, ms);
  };

  const tour = async () => {
    if (arrete || enCours) return;
    enCours = true;
    let r: MaintenanceRoundResult;
    try {
      r = await o.run();
    } catch (e) {
      log.error(`[db] maintenance des index : passage en erreur — ${(e as Error).message}`);
      r = 'pending';
    } finally {
      enCours = false;
    }
    echecs = r === 'pending' ? echecs + 1 : 0;
    const suivant = nextMaintenanceDelay(r, echecs, o);
    if (r === 'pending' && suivant != null) {
      log.warn(`[db] maintenance des index : index encore en attente — prochain passage dans ${Math.round(suivant / 60_000)} min.`);
    }
    programmer(suivant);
  };

  if (o.intervalMs > 0) programmer(Math.max(0, o.firstDelayMs));
  return {
    nextDelayMs: () => prochain,
    stop: () => {
      arrete = true;
      prochain = null;
      if (timer != null) clearTimer(timer);
    },
  };
}
