/**
 * Menu latéral repliable — Direction D v2 §3.1.
 *
 * 240 px déplié, 64 px replié ; l'état est conservé d'une visite à l'autre
 * (même clé qu'avant la refonte : un utilisateur qui avait replié son menu le
 * retrouve replié).
 */

export const SIDEBAR_STORAGE_KEY = 'sidebar-collapsed';
export const SIDEBAR_WIDTH_OPEN = 240;
export const SIDEBAR_WIDTH_COLLAPSED = 64;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function storage(s?: StorageLike | null): StorageLike | null {
  if (s !== undefined) return s;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Menu déplié par défaut ; stockage indisponible : déplié. */
export function readSidebarCollapsed(s?: StorageLike | null): boolean {
  try {
    return storage(s)?.getItem(SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean, s?: StorageLike | null): void {
  try {
    storage(s)?.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
  } catch {
    /* stockage indisponible : l'état vaut pour la visite seulement */
  }
}

export function sidebarWidth(collapsed: boolean): number {
  return collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_OPEN;
}

/** Libellé (et infobulle) du bouton en tête du menu. */
export function sidebarToggleLabel(collapsed: boolean): 'Déployer le menu' | 'Réduire le menu' {
  return collapsed ? 'Déployer le menu' : 'Réduire le menu';
}

/**
 * Pastille « À traiter » : affichée seulement au-delà de zéro (§2) ; au-delà
 * de 99, « 99+ ».
 */
export function badgeLabel(count: number | null | undefined): string | null {
  if (!count || count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}
