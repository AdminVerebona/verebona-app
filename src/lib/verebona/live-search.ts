/**
 * Suggestions pendant la frappe — Direction D v2 §1, §5, §9 (1. navigation
 * directe ou recherche d'un objet par son nom).
 *
 * Un seul champ pour chercher ET demander : taper affiche les biens,
 * documents, échéances, équipements, pièces (lot 71) et pages qui correspondent (recherche SQL `/api/search`
 * en mode `instant`, sans appel modèle) ; « Entrée » sans suggestion choisie
 * envoie la demande complète à Verebona.
 */
import type { DrawerTarget } from '@/lib/drawers';
import { localSearchHref } from '@/lib/search/local-search';

export interface LiveResult {
  id: string;
  kind: 'nav' | 'asset' | 'document' | 'agenda' | 'equipment' | 'room';
  title: string;
  sub: string | null;
  href: string;
  drawer?: DrawerTarget;
  /** Lot 71 : le nom EST la requête (normalisée) — présenté avant les rapprochements. */
  exact?: boolean;
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
  /** Lot 71 : libellé = requête normalisée (prioritaire, jamais masqué par le plafond). */
  exact?: boolean;
}

const KIND: Record<string, LiveResult['kind']> = {
  Bien: 'asset', Document: 'document', Agenda: 'agenda', 'Équipement': 'equipment', 'Pièce': 'room',
};

/** Tiroirs qu'une suggestion peut ouvrir (lien profond validé, jamais une valeur libre). */
const TIROIRS = new Set<DrawerTarget['kind']>(['document', 'echeance', 'equipement', 'piece']);
const tiroirValide = (d: DrawerTarget | undefined): d is DrawerTarget =>
  !!d && TIROIRS.has(d.kind) && Number.isSafeInteger(d.id) && d.id > 0;

/**
 * Réponse de `/api/search` → suggestions bornées : pages d'abord, puis les
 * correspondances EXACTES (lot 71, AC12 — le plafond de six ne masque jamais
 * un élément dont le nom est la requête), puis les autres dans l'ordre servi.
 */
export function toLiveResults(q: string, rows: ApiSearchRow[] | null | undefined): LiveResult[] {
  const api = (rows ?? [])
    .filter((r) => r && r.label && r.href && KIND[r.category ?? ''])
    .map((r) => ({
      id: String(r.id), kind: KIND[r.category!], title: r.label!, sub: r.sublabel ?? null, href: r.href!,
      ...(tiroirValide(r.drawer) ? { drawer: { kind: r.drawer.kind, id: r.drawer.id } } : {}),
      ...(r.exact === true ? { exact: true } : {}),
    }));
  const exacts = api.filter((r) => r.exact);
  const autres = api.filter((r) => !r.exact);
  const nav = navMatches(q);
  // Pages bornées pour laisser toujours la place aux correspondances exactes.
  const pages = nav.slice(0, Math.max(0, LIVE_MAX_RESULTS - Math.min(exacts.length, LIVE_MAX_RESULTS)));
  return [...pages, ...exacts, ...autres].slice(0, LIVE_MAX_RESULTS);
}

/** Nature affichée de chaque suggestion. */
const LIVE_KIND_LABELS: Readonly<Record<LiveResult['kind'], string>> = {
  nav: 'Page', asset: 'Bien', document: 'Document', agenda: 'Échéance', equipment: 'Équipement', room: 'Pièce',
};

/** Sous-titre : nature puis contexte (« Équipement · Maison Lyon »). */
export function liveSubtitle(r: Pick<LiveResult, 'kind' | 'sub'>): string {
  return [LIVE_KIND_LABELS[r.kind], r.sub].filter(Boolean).join(' · ');
}

/** Flèches haut/bas : -1 = aucune suggestion choisie (Entrée demande à Verebona). */
export function moveActive(current: number, delta: 1 | -1, length: number): number {
  if (length === 0) return -1;
  const next = current + delta;
  if (next < -1) return length - 1;
  if (next >= length) return -1;
  return next;
}

/**
 * Lot 97C — « Voir tous » de la recherche générale : quand les suggestions
 * contiennent des documents (ou des éléments d'agenda), l'écran complet
 * s'ouvre avec la recherche PRÉREMPLIE (`/documents?q=…`,
 * `/agenda?q=…&view=list`) — le critère, jamais les quelques identifiants
 * des suggestions (plafonnées). Pur.
 */
export interface LiveSeeAll {
  id: 'voir-documents' | 'voir-agenda';
  label: string;
  href: string;
}

export function seeAllLinks(q: string, rows: ApiSearchRow[] | null | undefined): LiveSeeAll[] {
  const saisie = q.trim();
  if (saisie.length < LIVE_MIN_CHARS) return [];
  const cats = new Set((rows ?? []).map((r) => r?.category));
  const out: LiveSeeAll[] = [];
  if (cats.has('Document')) out.push({ id: 'voir-documents', label: 'Voir tous les documents', href: localSearchHref('document', saisie) });
  if (cats.has('Agenda')) out.push({ id: 'voir-agenda', label: 'Voir tous les éléments d’agenda', href: localSearchHref('agenda', saisie) });
  return out;
}
