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
import { LOCAL_SEARCH_PARAM, localSearchHref, normalizeLocalQuery } from '@/lib/search/local-search';
import { AGENDA_EVENT_LABELS } from '@/lib/agenda/grouping-view';

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
  /** Lot 113AC : document — période principale (même ligne que la fiche). */
  periodLine?: string;
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

/** Contexte d'une suggestion : sous-titre servi, puis (document) sa période principale — lot 113AC. Pur. */
function liveSub(r: Pick<ApiSearchRow, 'sublabel' | 'periodLine' | 'category'>): string | null {
  const parts = [r.sublabel, r.category === 'Document' ? r.periodLine : null].filter((x): x is string => !!x && x.trim().length > 0);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Réponse de `/api/search` → suggestions bornées : pages d'abord, puis les
 * correspondances EXACTES (lot 71, AC12 — le plafond de six ne masque jamais
 * un élément dont le nom est la requête), puis les autres dans l'ordre servi.
 */
export function toLiveResults(q: string, rows: ApiSearchRow[] | null | undefined): LiveResult[] {
  const api = (rows ?? [])
    .filter((r) => r && r.label && r.href && KIND[r.category ?? ''])
    .map((r) => ({
      id: String(r.id), kind: KIND[r.category!], title: r.label!, sub: liveSub(r), href: r.href!,
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
 *
 * Lot 105A (ticket « Voir tous les documents (N) ») : le lien des documents
 * annonce le nombre TOTAL de documents correspondants, calculé par le serveur
 * sur EXACTEMENT l'ensemble que « Mes documents » listera
 * (`GET /api/v2/documents?count=1&q=…`, même fonction serveur que la liste) —
 * jamais le nombre de suggestions affichées.
 *   · total connu et > 0 → « Voir tous les documents (N) » ;
 *   · total connu = 0 (ou saisie sans mot exploitable) → aucun lien ;
 *   · total en cours → lien sans chiffre, marqué « en cours » (jamais un
 *     chiffre provisoire), seulement si des documents sont déjà suggérés ;
 *   · total indisponible (erreur) → lien sans chiffre si des documents sont
 *     suggérés, rien sinon.
 */
export interface LiveSeeAll {
  id: 'voir-documents' | 'voir-agenda';
  label: string;
  href: string;
  /** Lot 105A : total exact des documents correspondants (lien des documents). */
  count?: number;
  /** Lot 105A : total en cours de calcul — aucun chiffre affiché. */
  pending?: true;
}

/** Lot 105A — état du décompte des documents pour la saisie courante. */
export type DocumentsCountState =
  | { status: 'loading' }
  | { status: 'ready'; total: number; searchApplied: boolean }
  | { status: 'error' };

export const SEE_ALL_DOCUMENTS_LABEL = 'Voir tous les documents';

const ENTIER_FR = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

/** « Voir tous les documents (12) » — `null` : libellé sans chiffre. */
export function seeAllDocumentsLabel(total: number | null): string {
  return total === null ? SEE_ALL_DOCUMENTS_LABEL : `${SEE_ALL_DOCUMENTS_LABEL} (${ENTIER_FR.format(total)})`;
}

/**
 * Adresse du décompte : MÊME normalisation de la saisie que le lien
 * (`localSearchHref` → `normalizeLocalQuery`) et que l'écran d'arrivée
 * (`readLocalQuery`), mêmes paramètres que la liste — sans filtre : « Voir
 * tous » ouvre « Mes documents » sans autre critère que la recherche.
 */
export function documentsCountUrl(q: string): string | null {
  const valeur = normalizeLocalQuery(q);
  if (valeur.length < LIVE_MIN_CHARS) return null;
  return `/api/v2/documents?${new URLSearchParams({ count: '1', [LOCAL_SEARCH_PARAM]: valeur })}`;
}

/** Réponse du décompte validée ; `null` si elle est illisible (traitée comme une erreur). */
export function parseDocumentsCount(body: unknown): { total: number; searchApplied: boolean } | null {
  const o = body as { total?: unknown; searchApplied?: unknown } | null;
  if (!o || typeof o !== 'object') return null;
  if (typeof o.total !== 'number' || !Number.isSafeInteger(o.total) || o.total < 0) return null;
  return { total: o.total, searchApplied: o.searchApplied !== false };
}

export function seeAllLinks(q: string, rows: ApiSearchRow[] | null | undefined, documents?: DocumentsCountState): LiveSeeAll[] {
  const saisie = q.trim();
  if (saisie.length < LIVE_MIN_CHARS) return [];
  const cats = new Set((rows ?? []).map((r) => r?.category));
  const out: LiveSeeAll[] = [];
  const href = localSearchHref('document', saisie);
  if (!documents) {
    // Sans décompte (appelant historique) : comportement du lot 97C.
    if (cats.has('Document')) out.push({ id: 'voir-documents', label: SEE_ALL_DOCUMENTS_LABEL, href });
  } else if (documents.status === 'ready') {
    if (documents.searchApplied && documents.total > 0) {
      out.push({ id: 'voir-documents', label: seeAllDocumentsLabel(documents.total), href, count: documents.total });
    }
  } else if (cats.has('Document')) {
    out.push({ id: 'voir-documents', label: SEE_ALL_DOCUMENTS_LABEL, href, ...(documents.status === 'loading' ? { pending: true as const } : {}) });
  }
  if (cats.has('Agenda')) out.push({ id: 'voir-agenda', label: AGENDA_EVENT_LABELS.seeAll, href: localSearchHref('agenda', saisie) });
  return out;
}

// ── Requêtes de la frappe : jamais de réponse périmée (lot 105A) ──────────

/** Lecture JSON d'une URL (`null` : échec réseau, statut non 2xx, corps illisible). */
export type LiveFetchJson = (url: string, signal: AbortSignal) => Promise<unknown | null>;

export interface LiveSearchHandlers {
  /** Réponse de `/api/search` pour la saisie `q` (`null` : indisponible). */
  onResults: (q: string, rows: ApiSearchRow[] | null) => void;
  /** État du décompte des documents pour la saisie `q`. */
  onDocumentsCount: (q: string, state: DocumentsCountState) => void;
}

export interface LiveSearchRunner {
  /** Lance suggestions et décompte pour `q` ; la recherche précédente est annulée. */
  run: (q: string) => void;
  /** Annule tout (nouvelle frappe, saisie trop courte, démontage). */
  cancel: () => void;
}

/**
 * Suggestions et décompte partent EN PARALLÈLE (le décompte ne retarde jamais
 * les suggestions). Chaque recherche reçoit un numéro et son propre
 * `AbortController` : une nouvelle frappe annule les requêtes en vol, et une
 * réponse arrivée malgré tout (ordre réseau quelconque) dont le numéro n'est
 * plus le dernier est ignorée — aucun total d'une ancienne saisie ne peut
 * s'afficher.
 */
export function createLiveSearchRunner(fetchJson: LiveFetchJson, handlers: LiveSearchHandlers): LiveSearchRunner {
  let seq = 0;
  let controller: AbortController | null = null;
  const cancel = () => {
    seq += 1;
    controller?.abort();
    controller = null;
  };
  return {
    cancel,
    run: (q) => {
      cancel();
      const mine = seq;
      const ctrl = new AbortController();
      controller = ctrl;
      const actuel = () => mine === seq && !ctrl.signal.aborted;
      const lire = (url: string) => fetchJson(url, ctrl.signal).catch(() => null);
      const countUrl = documentsCountUrl(q);
      handlers.onDocumentsCount(q, { status: 'loading' });
      // Mode `instant` : recherche SQL seule, jamais d'appel modèle à la frappe.
      void lire(`/api/search?instant=1&q=${encodeURIComponent(q)}`).then((data) => {
        if (!actuel()) return;
        const rows = (data as { results?: ApiSearchRow[] } | null)?.results;
        handlers.onResults(q, Array.isArray(rows) ? rows : null);
      });
      if (!countUrl) {
        handlers.onDocumentsCount(q, { status: 'ready', total: 0, searchApplied: false });
        return;
      }
      void lire(countUrl).then((data) => {
        if (!actuel()) return;
        const parsed = parseDocumentsCount(data);
        handlers.onDocumentsCount(q, parsed ? { status: 'ready', ...parsed } : { status: 'error' });
      });
    },
  };
}
