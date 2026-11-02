'use client';

/**
 * Sections repliables du panneau de filtres des documents — lot 103F.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE PRÉSENTATION, JAMAIS UN CRITÈRE
 *
 * L'état ouvert / fermé des sections (et du panneau « Filtres ») est une
 * affaire d'affichage : il vit ici, à côté des filtres et jamais dedans.
 * Ouvrir ou fermer une section ne change ni la requête, ni les résultats, ni
 * les sélections ; un recalcul de l'état (changement de largeur d'écran)
 * n'efface jamais un critère.
 *
 * ── ÉTAT INITIAL ──────────────────────────────────────────────────────────
 *
 *   · Téléphone (< 768 px, sous le point de rupture `md` de la grille du
 *     panneau) : « Bien » ouvert ; les autres sections fermées — sauf une
 *     section qui porte déjà une sélection à l'arrivée (retour sur l'écran),
 *     ouverte pour ne rien cacher.
 *   · Tablette et ordinateur (≥ 768 px, panneau en colonnes) : toutes les
 *     sections ouvertes, comme avant le lot 103F ; chacune se replie.
 *
 * ── CE QUI EST GARDÉ ──────────────────────────────────────────────────────
 *
 * Les choix EXPLICITES de l'utilisateur (section ouverte ou fermée, panneau
 * ouvert ou fermé) sont gardés dans le stockage de SESSION de l'onglet, par
 * écran (« Mes documents », onglet d'un bien) : un retour sur la page dans
 * la même navigation retrouve les sections telles qu'il les a laissées. Ils
 * priment sur l'état initial, y compris après un changement de largeur ;
 * une section jamais touchée suit l'état initial de la largeur courante.
 * Stockage absent, bloqué ou illisible : chaque accès est protégé, l'écran
 * fonctionne avec l'état initial.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { sectionActiveCount, type FilterSectionKey, type ViewFilters } from './documents-view';

export const FILTER_SECTION_KEYS: readonly FilterSectionKey[] = ['bien', 'rubrique', 'type', 'piece', 'equipement', 'dateDocument', 'dateAjout'];

/** Largeur maximale de la présentation « téléphone » (sous `md`, 768 px). */
export const FILTER_SECTIONS_MOBILE_QUERY = '(max-width: 767px)';

export type FilterLayout = 'mobile' | 'wide';

/** Choix explicites gardés pour la session. */
export interface SectionsMemory {
  v: 1;
  panel?: boolean;
  open: Partial<Record<FilterSectionKey, boolean>>;
}

/** État initial d'une section, pour une largeur et les sélections présentes à l'arrivée. */
export function defaultSectionOpen(section: FilterSectionKey, layout: FilterLayout, initial: ViewFilters): boolean {
  if (layout === 'wide') return true;
  return section === 'bien' || sectionActiveCount(initial, section) > 0;
}

/** État effectif : choix explicite s'il existe, sinon l'état initial de la largeur courante. */
export function resolveSectionsOpen(
  layout: FilterLayout,
  initial: ViewFilters,
  memory: SectionsMemory,
): Record<FilterSectionKey, boolean> {
  return Object.fromEntries(FILTER_SECTION_KEYS.map((k) => [
    k,
    typeof memory.open[k] === 'boolean' ? memory.open[k]! : defaultSectionOpen(k, layout, initial),
  ])) as Record<FilterSectionKey, boolean>;
}

const PREFIX = 'verebona.documents.sections.v1.';
export const sectionsStorageKey = (scope: string) => PREFIX + scope;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function storageOrNull(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null; // accès refusé (navigation privée, iframe sandbox)
  }
}

/** Valide une mémoire lue ; tout champ invalide est ignoré. */
export function parseSectionsMemory(raw: unknown): SectionsMemory {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const open = (o.open && typeof o.open === 'object' ? o.open : {}) as Record<string, unknown>;
  return {
    v: 1,
    ...(typeof o.panel === 'boolean' ? { panel: o.panel } : {}),
    open: Object.fromEntries(FILTER_SECTION_KEYS.filter((k) => typeof open[k] === 'boolean').map((k) => [k, open[k] as boolean])),
  };
}

export function loadSectionsMemory(scope: string, storage?: StorageLike | null): SectionsMemory {
  const s = storageOrNull(storage);
  if (!s) return { v: 1, open: {} };
  try {
    const brut = s.getItem(sectionsStorageKey(scope));
    return brut ? parseSectionsMemory(JSON.parse(brut)) : { v: 1, open: {} };
  } catch {
    return { v: 1, open: {} };
  }
}

export function saveSectionsMemory(scope: string, memory: SectionsMemory, storage?: StorageLike | null): void {
  const s = storageOrNull(storage);
  if (!s) return;
  try {
    s.setItem(sectionsStorageKey(scope), JSON.stringify(parseSectionsMemory(memory)));
  } catch {
    /* quota dépassé ou stockage bloqué : l'état vaut pour l'affichage en cours */
  }
}

function currentLayout(): FilterLayout {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia(FILTER_SECTIONS_MOBILE_QUERY).matches ? 'mobile' : 'wide';
  } catch {
    return 'wide';
  }
}

/**
 * État des sections et du panneau pour un écran. `ready` : filtres restaurés
 * (instantané de retour) — l'état initial se calcule sur ces sélections-là.
 */
export function useFilterSections(scope: string, filters: ViewFilters, ready: boolean) {
  const [layout, setLayout] = useState<FilterLayout>('wide');
  const [memory, setMemory] = useState<SectionsMemory>({ v: 1, open: {} });
  const initial = useRef<ViewFilters | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => {
    if (!ready) return;
    initial.current = filtersRef.current;
    setMemory(loadSectionsMemory(scope));
    setLayout(currentLayout());
    let mq: MediaQueryList | null = null;
    try {
      mq = typeof window.matchMedia === 'function' ? window.matchMedia(FILTER_SECTIONS_MOBILE_QUERY) : null;
    } catch { mq = null; }
    if (!mq) return;
    // Changement de largeur : seul l'état initial des sections jamais
    // touchées est recalculé — les choix explicites et les filtres restent.
    const suivre = () => setLayout(currentLayout());
    mq.addEventListener?.('change', suivre);
    return () => mq?.removeEventListener?.('change', suivre);
  }, [ready, scope]);

  const update = useCallback((patch: (m: SectionsMemory) => SectionsMemory) => {
    setMemory((current) => {
      const next = patch(current);
      saveSectionsMemory(scope, next);
      return next;
    });
  }, [scope]);

  const open = resolveSectionsOpen(layout, initial.current ?? filters, memory);
  const setSectionOpen = useCallback((section: FilterSectionKey, value: boolean) => {
    update((m) => ({ ...m, open: { ...m.open, [section]: value } }));
  }, [update]);
  const setPanelOpen = useCallback((value: boolean) => {
    update((m) => ({ ...m, panel: value }));
  }, [update]);

  return {
    layout,
    open,
    setSectionOpen,
    /** Panneau « Filtres » : fermé par défaut (inchangé), choix gardé pour la session. */
    panelOpen: memory.panel ?? false,
    setPanelOpen,
  };
}
