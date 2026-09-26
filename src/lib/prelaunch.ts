/**
 * Inscription pendant le pré-lancement — interrupteur d'environnement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SIGNUP_MODE = full | prelaunch   (variable serveur, lue à l'exécution)
 *
 *   full       inscription ouverte à tous (comportement historique).
 *   prelaunch  inscription FERMÉE : la page /signup affiche « Verebona ouvre
 *              bientôt » et POST /api/users répond 403 SIGNUP_CLOSED, SAUF
 *              pour une invitation valide (compte partagé ou Premium Duo).
 *
 * Valeurs alignées sur le site public (`VITE_DEFAULT_SITE_MODE=full|prelaunch`,
 * repo verebona-public) : les deux interrupteurs basculent ensemble au
 * lancement commercial. `open` est accepté comme synonyme de `full`.
 *
 * Défauts :
 *   - variable ABSENTE ou vide  → `full` : un environnement existant qui n'a
 *     pas encore la variable n'est pas fermé par surprise ;
 *   - valeur PRÉSENTE mais inconnue (faute de frappe) → `prelaunch` : qui a
 *     voulu configurer le mode n'ouvre jamais l'inscription par erreur.
 *
 * Les comptes créés par un administrateur ou par les scripts de seed
 * n'empruntent pas POST /api/users : ils ne sont pas concernés.
 * ══════════════════════════════════════════════════════════════════════════
 */

export const SIGNUP_MODES = ['full', 'prelaunch'] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

export const SIGNUP_CLOSED_CODE = 'SIGNUP_CLOSED';
export const SIGNUP_CLOSED_MESSAGE =
  'Les inscriptions ne sont pas encore ouvertes : Verebona ouvre bientôt. ' +
  'Seules les personnes invitées peuvent créer un compte pour le moment.';

export function parseSignupMode(raw: unknown): SignupMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === '') return 'full';
  if (value === 'full' || value === 'open') return 'full';
  if (value === 'prelaunch') return 'prelaunch';
  return 'prelaunch';
}

/** Mode courant. Lu à chaque appel : aucun rebuild nécessaire pour basculer. */
export function getSignupMode(env: Record<string, string | undefined> = process.env): SignupMode {
  return parseSignupMode(env.SIGNUP_MODE);
}

export function isPrelaunch(env?: Record<string, string | undefined>): boolean {
  return getSignupMode(env) === 'prelaunch';
}
