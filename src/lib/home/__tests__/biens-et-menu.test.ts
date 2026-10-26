/**
 * Coquille et « Mes biens » — Direction D v2 §3.1, §3.3.
 *
 * Menu latéral repliable (état conservé), pastille « À traiter » seulement
 * au-delà de zéro ; biens récemment consultés et grille bento.
 */
import { describe, it, expect } from 'vitest';
import {
  SIDEBAR_STORAGE_KEY, badgeLabel, readSidebarCollapsed, sidebarToggleLabel, sidebarWidth, writeSidebarCollapsed,
} from '@/lib/shell/sidebar-state';
import {
  RECENT_ASSETS_KEY, assetIdFromPath, orderByRecentViews, pickBento, pushRecentAsset, readRecentAssetIds, recordAssetView,
} from '../recent-assets';
import { NAV_ENTRIES, isNavActive } from '@/components/shell/AppSidebar';

function memoire(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

describe('menu latéral (§3.1)', () => {
  it('240 px déplié, 64 px replié ; libellés du bouton', () => {
    expect(sidebarWidth(false)).toBe(240);
    expect(sidebarWidth(true)).toBe(64);
    expect(sidebarToggleLabel(false)).toBe('Réduire le menu');
    expect(sidebarToggleLabel(true)).toBe('Déployer le menu');
  });

  it('état conservé, déplié par défaut, même clé qu’avant la refonte', () => {
    const s = memoire();
    expect(readSidebarCollapsed(s)).toBe(false);
    writeSidebarCollapsed(true, s);
    expect(s.data.get(SIDEBAR_STORAGE_KEY)).toBe('true');
    expect(readSidebarCollapsed(s)).toBe(true);
    writeSidebarCollapsed(false, s);
    expect(readSidebarCollapsed(s)).toBe(false);
    expect(SIDEBAR_STORAGE_KEY).toBe('sidebar-collapsed');
  });

  it('stockage indisponible : déplié, sans erreur', () => {
    const cassé = { getItem: () => { throw new Error('bloqué'); }, setItem: () => { throw new Error('bloqué'); } };
    expect(readSidebarCollapsed(cassé)).toBe(false);
    expect(() => writeSidebarCollapsed(true, cassé)).not.toThrow();
    expect(readSidebarCollapsed(null)).toBe(false);
  });

  it('pastille « À traiter » seulement au-delà de zéro', () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(null)).toBeNull();
    expect(badgeLabel(2)).toBe('2');
    expect(badgeLabel(120)).toBe('99+');
  });

  it('entrées et élément actif', () => {
    expect(NAV_ENTRIES.map((e) => e.name)).toEqual(['Accueil', 'Mes biens', 'Mon agenda', 'Mes documents', 'À traiter']);
    const [accueil, biens, , , aTraiter] = NAV_ENTRIES;
    expect(isNavActive(accueil, '/accueil')).toBe(true);
    // « À traiter » est une sous-page de l'accueil : un seul élément actif.
    expect(isNavActive(accueil, '/accueil/a-traiter')).toBe(false);
    expect(isNavActive(aTraiter, '/accueil/a-traiter')).toBe(true);
    expect(isNavActive(biens, '/assets/42')).toBe(true);
    expect(isNavActive(biens, '/assetsx')).toBe(false);
  });
});

describe('biens récemment consultés (§3.3)', () => {
  it('fiche consultée → identifiant', () => {
    expect(assetIdFromPath('/assets/42')).toBe(42);
    expect(assetIdFromPath('/assets/42/edit')).toBe(42);
    expect(assetIdFromPath('/assets')).toBeNull();
    expect(assetIdFromPath('/documents/42')).toBeNull();
  });

  it('le dernier consulté passe en tête, sans doublon, liste bornée', () => {
    expect(pushRecentAsset([1, 2, 3], 2)).toEqual([2, 1, 3]);
    expect(pushRecentAsset([1, 2, 3], 4, 3)).toEqual([4, 1, 2]);
    const s = memoire();
    recordAssetView(5, s);
    recordAssetView(7, s);
    recordAssetView(5, s);
    expect(readRecentAssetIds(s)).toEqual([5, 7]);
    s.data.set(RECENT_ASSETS_KEY, 'pas du json');
    expect(readRecentAssetIds(s)).toEqual([]);
  });

  it('ordre : consultés d’abord, puis l’ordre du serveur', () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    expect(orderByRecentViews(items, [3, 9, 1]).map((x) => x.id)).toEqual([3, 1, 2, 4]);
  });

  it('bento : le premier bien avec photo occupe 2 rangées, puis 3 tuiles', () => {
    const a = [{ id: 1, thumbnailUrl: null }, { id: 2, thumbnailUrl: 'x.jpg' }, { id: 3 }, { id: 4 }, { id: 5 }];
    const b = pickBento(a);
    expect(b.big?.id).toBe(2);
    expect(b.small.map((x) => x.id)).toEqual([1, 3, 4]);
    expect(pickBento([{ id: 1 }]).big?.id).toBe(1);
    expect(pickBento([])).toEqual({ big: null, small: [] });
  });
});
