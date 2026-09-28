/**
 * Suppression volontaire du compte — règles pures (sans base), lues par le
 * planificateur interne sans charger le service complet.
 */

export type SweepMode = 'live' | 'safe' | 'dry' | 'off';

/**
 * Mode du balayage — `ACCOUNT_DELETION_SWEEP` :
 *   absente / vide  : `safe` — rappels et suppressions dont l'échéance date de
 *                     moins de 7 jours ; un ARRIÉRÉ plus ancien (ex. au
 *                     premier déploiement) n'est pas exécuté : il est signalé
 *                     une fois en anomalie d'administration ;
 *   `live`          : explicite — tout, arriéré compris ;
 *   `dry`           : simulation journalisée, rien n'est écrit ni envoyé —
 *                     pour le premier passage en production ;
 *   `off`           : tâche interne désactivée (planificateur externe
 *                     appelant GET /api/cron/account-deletion/process).
 * Valeur inconnue ⇒ `dry` : une faute de frappe ne doit pas supprimer de
 * données.
 */
export function accountDeletionSweepMode(raw: string | undefined = process.env.ACCOUNT_DELETION_SWEEP): SweepMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return 'safe';
  if (v === 'live') return 'live';
  if (v === 'off' || v === 'false' || v === 'disabled') return 'off';
  return 'dry';
}

/** Options du balayage pour un mode (`off` exclu). */
export function sweepOptionsFor(mode: SweepMode): { dryRun: boolean; includeBacklog: boolean } {
  return { dryRun: mode === 'dry', includeBacklog: mode === 'live' };
}
