/**
 * Suggestions pendant la frappe — Direction D v2 §1, §5, §9 (1. navigation
 * directe ou recherche d'un objet par son nom).
 *
 * Un seul champ pour chercher ET demander : taper affiche les biens,
 * documents, échéances et pages qui correspondent (recherche SQL `/api/search`
 * en mode `instant`, sans appel modèle) ; « Entrée » sans suggestion choisie
 * envoie la demande complète à Verebona.
 */
import type { DrawerTarget } from '@/lib/drawers';

export interface LiveResult {
  id: string;
  kind: 'nav' | 'asset' | 'document' | 'agenda';
  title: string;
  sub: string | null;
  href: string;
  drawer?: DrawerTarget;
}

/** Pages de l'application, proposées par leur nom. */
export const NAV_PAGES: LiveResult[] = [
  { id: 'nav-accueil', kind: 'nav', title: 'Accueil', sub: 'Page', href: '/accueil' },
  { id: 'nav-biens', kind: 'nav', title: 'Mes biens', sub: 'Page', href: '/assets' },
  { id: 'nav-agenda', kind: 'nav', title: 'Mon agenda', sub: 'Page', href: '/agenda' },
  { id: 'nav-documents', kind: 'nav', title: 'Mes documents', sub: 'Page', href: '/documents' },
  { id: 'nav-a-traiter', kind: 'nav', title: 'À traiter', sub: 'Page', href: '/accueil/a-traiter' },
  { id: 'nav-compte', kind: 'nav', title: 'Mon compte', sub: 'Page', href: '/mon-compte' },
];

export const LIVE_MIN_CHARS = 2;
export const LIVE_MAX_RESULTS = 6;
export const LIVE_DEBOUNCE_MS = 220;

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function navMatches(q: string): LiveResult[] {
  const n = norm(q);
  if (n.length < LIVE_MIN_CHARS) return [];
  return NAV_PAGES.filter((p) => norm(p.title).includes(n));
}

interface ApiSearchRow {
  id: string;
  category?: string;
  label?: string;
  sublabel?: string;
  href?: string;
  drawer?: DrawerTarget;
}

const KIND: Record<string, LiveResult['kind']> = { Bien: 'asset', Document: 'document', Agenda: 'agenda' };

/** Réponse de `/api/search` → suggestions (pages d'abord, bornées). */
export function toLiveResults(q: string, rows: ApiSearchRow[] | null | undefined): LiveResult[] {
  const api = (rows ?? [])
    .filter((r) => r && r.label && r.href && KIND[r.category ?? ''])
    .map((r) => ({
      id: String(r.id), kind: KIND[r.category!], title: r.label!, sub: r.sublabel ?? null, href: r.href!,
      ...(r.drawer ? { drawer: r.drawer } : {}),
    }));
  return [...navMatches(q), ...api].slice(0, LIVE_MAX_RESULTS);
}

/** Flèches haut/bas : -1 = aucune suggestion choisie (Entrée demande à Verebona). */
export function moveActive(current: number, delta: 1 | -1, length: number): number {
  if (length === 0) return -1;
  const next = current + delta;
  if (next < -1) return length - 1;
  if (next >= length) return -1;
  return next;
}
