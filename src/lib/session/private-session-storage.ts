/**
 * Données de consultation PRIVÉES gardées en stockage de session (onglet) —
 * lot 97C (critère AC17 : « rechercher sur un compte puis changer de compte :
 * aucune donnée du premier compte accessible sur le second »).
 *
 * L'instantané de retour de « Mes documents » (`list-restore.ts` : titres,
 * biens, recherche dans la clé) survivait au changement d'espace et à la
 * déconnexion : la clé de requête d'un autre compte, identique (« Mes
 * documents », mêmes critères), l'aurait repris. Il est effacé à chaque
 * transition de session (déconnexion, session expirée) et à chaque
 * changement d'espace.
 */
export const PRIVATE_SESSION_PREFIXES = ['verebona.documents.liste.'] as const;

type StorageLike = Pick<Storage, 'length' | 'key' | 'removeItem'>;

/** Efface les clés privées ; rend le nombre de clés supprimées. */
export function clearPrivateSessionStorage(storage?: StorageLike | null): number {
  let s: StorageLike | null = storage ?? null;
  if (storage === undefined) {
    try { s = typeof window !== 'undefined' ? window.sessionStorage : null; } catch { s = null; }
  }
  if (!s) return 0;
  try {
    const cles: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && PRIVATE_SESSION_PREFIXES.some((p) => k.startsWith(p))) cles.push(k);
    }
    for (const k of cles) s.removeItem(k);
    return cles.length;
  } catch {
    return 0; // stockage indisponible (navigation privée, iframe)
  }
}
