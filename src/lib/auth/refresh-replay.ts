/**
 * Présentation d'un jeton de renouvellement déjà révoqué — lot 37 (C2),
 * CDC 18 §19.3 et §37 (« Refresh concurrent : une seule rotation gagne ;
 * l'autre est gérée sans créer deux sessions valides »).
 *
 *   concurrent : jeton TOURNÉ il y a moins de REFRESH_REUSE_GRACE_MS. Cas
 *                légitime : plusieurs onglets, ou l'application mobile
 *                (Capacitor) qui relance plusieurs appels au retour au
 *                premier plan, présentent le même cookie en même temps. La
 *                requête perdante n'obtient AUCUN jeton : elle est invitée à
 *                rejouer avec les cookies déposés par la gagnante ;
 *   reuse      : jeton tourné il y a plus longtemps : un successeur existe et
 *                quelqu'un présente l'ancien — vol probable de l'un des deux.
 *                Incident : toutes les sessions de l'utilisateur sont
 *                révoquées ;
 *   ended      : jeton révoqué par une déconnexion (aucun successeur), ou
 *                avant le lot 37 (motif inconnu) : refus simple.
 *
 * La fenêtre ne donne rien à un attaquant : rejouer un jeton volé dans les
 * 30 s ne rend aucun cookie ; au-delà, il déclenche la révocation globale.
 */

/** Fenêtre de grâce des renouvellements concurrents. */
export const REFRESH_REUSE_GRACE_MS = 30_000;

type RefreshReplayVerdict = 'concurrent' | 'reuse' | 'ended';

export function classifyRefreshReplay(
  revoked: { revokedAt: Date; reason: 'rotated' | 'logout' | null },
  now: number,
  graceMs: number = REFRESH_REUSE_GRACE_MS,
): RefreshReplayVerdict {
  if (revoked.reason !== 'rotated') return 'ended';
  const age = now - revoked.revokedAt.getTime();
  // Horloges application / base légèrement décalées : un âge négatif est « tout récent ».
  return age <= graceMs ? 'concurrent' : 'reuse';
}
