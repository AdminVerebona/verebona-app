/**
 * Transitions de session côté navigateur — APP-PERF-04 / 21 / 23.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE « ÉPOQUE » PAR CONTEXTE DE SESSION
 *
 * Connexion, déconnexion, refus d'authentification définitif, changement de
 * compte : chaque transition incrémente l'époque. Tout ce qui a été lancé sous
 * une époque antérieure — lecture partagée en cours, réponse tardive à
 * mettre en cache, chargement d'identité ou de droits — est écarté au lieu de
 * repeupler l'interface avec les données de l'ancien contexte.
 *
 * Les magasins (identité, droits) et le client HTTP s'abonnent ici, sans
 * s'importer les uns les autres.
 *
 * ⚠️ Ceci ne touche ni aux cookies HttpOnly ni à la session serveur : c'est un
 * nettoyage de l'état du navigateur, pas une révocation.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type SessionTransitionReason =
  /** Retour d'une page d'authentification (connexion, inscription…). */
  | 'login'
  /** Déconnexion demandée par l'utilisateur. */
  | 'logout'
  /** Session refusée définitivement (renouvellement impossible). */
  | 'auth-failure'
  /** Le compte ou l'utilisateur servi par le serveur a changé. */
  | 'account-change';

export interface SessionTransition {
  reason: SessionTransitionReason;
  epoch: number;
}

let epoch = 0;
const listeners = new Set<(t: SessionTransition) => void>();

/** Époque courante : à capturer au départ d'une opération, à comparer à l'arrivée. */
export function getSessionEpoch(): number {
  return epoch;
}

/** S'abonne aux transitions. Rend la fonction de désabonnement. */
export function onSessionTransition(fn: (t: SessionTransition) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Ouvre une nouvelle époque et prévient les abonnés (purge des caches).
 * Un abonné qui lève n'empêche pas les autres d'être prévenus.
 */
export function beginSessionTransition(reason: SessionTransitionReason): SessionTransition {
  epoch += 1;
  const t = { reason, epoch };
  for (const fn of [...listeners]) {
    try { fn(t); } catch (e) { console.error('[session] nettoyage en échec :', (e as Error).message); }
  }
  // Modules sans dépendance vers ce fichier (cache des vignettes PDF, listes
  // de documents restaurées) : même signal, par un événement de fenêtre.
  if (typeof window !== 'undefined') {
    try { window.dispatchEvent(new CustomEvent('verebona:session-changed', { detail: t })); } catch { /* jamais bloquant */ }
  }
  return t;
}
