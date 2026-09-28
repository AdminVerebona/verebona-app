/**
 * Biens récemment consultés — Direction D v2 §3.3 (« Mes biens · Récemment
 * consultés »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA CONSULTATION N'EST PAS ENREGISTRÉE CÔTÉ SERVEUR
 *
 * Aucune table ne trace l'ouverture d'une fiche. Plutôt que d'en créer une
 * pour un simple ordre d'affichage, la coquille note localement, sur cet
 * appareil, les fiches ouvertes (`/assets/<id>`). L'accueil place ces biens
 * en tête, puis complète avec les biens les plus récemment créés (ordre du
 * serveur). Un autre appareil repart de l'ordre du serveur.
 * ══════════════════════════════════════════════════════════════════════════
 */

export const RECENT_ASSETS_KEY = 'verebona:recent-assets';
export const RECENT_ASSETS_MAX = 12;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function store(s?: StorageLike | null): StorageLike | null {
  if (s !== undefined) return s;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Identifiant du bien d'une adresse de fiche, ou null. */
export function assetIdFromPath(pathname: string | null | undefined): number | null {
  const m = /^\/assets\/(\d{1,10})(\/|$|\?)/.exec(pathname ?? '');
  return m ? Number(m[1]) : null;
}

export function readRecentAssetIds(s?: StorageLike | null): number[] {
  try {
    const raw = store(s)?.getItem(RECENT_ASSETS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is number => Number.isInteger(x) && x > 0) : [];
  } catch {
    return [];
  }
}

/** Le bien consulté passe en tête, sans doublon, liste bornée. */
export function pushRecentAsset(list: number[], id: number, max = RECENT_ASSETS_MAX): number[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
}

export function recordAssetView(id: number, s?: StorageLike | null): void {
  try {
    const st = store(s);
    if (!st) return;
    st.setItem(RECENT_ASSETS_KEY, JSON.stringify(pushRecentAsset(readRecentAssetIds(st), id)));
  } catch {
    /* stockage indisponible : l'ordre du serveur s'applique */
  }
}

/**
 * Ordre d'affichage : biens consultés d'abord (du plus récent au plus
 * ancien), puis les autres dans l'ordre reçu.
 */
export function orderByRecentViews<T extends { id: number }>(items: T[], recentIds: number[]): T[] {
  const rank = new Map(recentIds.map((id, i) => [id, i]));
  return items
    .map((it, i) => ({ it, i, r: rank.get(it.id) }))
    .sort((a, b) => {
      if (a.r !== undefined && b.r !== undefined) return a.r - b.r;
      if (a.r !== undefined) return -1;
      if (b.r !== undefined) return 1;
      return a.i - b.i;
    })
    .map((x) => x.it);
}

/**
 * Grille bento (§3.3) : 3 colonnes × 2 rangées. Le premier bien AVEC photo
 * occupe 2 rangées (à défaut, le premier bien) ; les 3 suivants en tuiles
 * simples ; la dernière case est « Tous les biens ».
 */
export function pickBento<T extends { id: number; thumbnailUrl?: string | null; signedThumbnailUrl?: string | null }>(
  ordered: T[],
): { big: T | null; small: T[] } {
  if (ordered.length === 0) return { big: null, small: [] };
  const big = ordered.find((a) => !!(a.thumbnailUrl || a.signedThumbnailUrl)) ?? ordered[0];
  return { big, small: ordered.filter((a) => a.id !== big.id).slice(0, 3) };
}
