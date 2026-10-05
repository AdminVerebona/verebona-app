/**
 * État « guide de bienvenue déjà vu », par utilisateur et par appareil.
 *
 * Module sans dépendance d'interface : la coquille le lit pour décider s'il
 * faut seulement charger la fenêtre d'accueil (APP-PERF-05 / APP-PERF-39).
 * Un utilisateur qui l'a déjà fermée ou qui possède un bien ne télécharge
 * plus ni son code ni la liste de biens qui servait à le décider.
 */
const DISMISSED_KEY_PREFIX = 'onboarding_dismissed_';

export function getWelcomeDismissedKey(userId: number): string {
  return `${DISMISSED_KEY_PREFIX}${userId}`;
}

/** Stockage indisponible (navigation privée stricte) : considéré comme non vu. */
export function isWelcomeDismissed(userId: number): boolean {
  try {
    return globalThis.localStorage?.getItem(getWelcomeDismissedKey(userId)) === '1';
  } catch {
    return false;
  }
}

export function markWelcomeDismissed(userId: number): void {
  try {
    globalThis.localStorage?.setItem(getWelcomeDismissedKey(userId), '1');
  } catch {
    /* stockage indisponible : la fenêtre se représentera, sans gravité */
  }
}
