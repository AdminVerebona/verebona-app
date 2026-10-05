'use client';

/**
 * « Mes documents » et onglet Documents d'un bien — CDC V2.0 §4, maquette
 * « Mes documents » (2026-09), direction 1a « Flux continu ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES RUBRIQUES SONT DES TITRES, PLUS DES BOÎTES
 *
 * L'écran précédent enfermait chaque Rubrique dans un cadre repliable, avec
 * son propre « Voir les N autres » : huit boîtes, dont plusieurs vides, et un
 * tri qui ne valait qu'à l'intérieur de chacune.
 *
 * Désormais un seul flux : les Rubriques sont des titres de section (petites
 * capitales, compteur, filet), jamais des boîtes. Désactiver « Par rubrique »
 * retire les titres, rien d'autre ne bouge. Les Rubriques vides n'ont pas de
 * section ; elles sont citées en une ligne à la fin (« Rubriques sans
 * document : … »), ce qui garde visible la structure du référentiel (§3.3)
 * sans la faire peser sur la page.
 *
 * ── LE TRI EST GLOBAL, LE CHARGEMENT PROGRESSIF (DOC-PERF) ─────────────────
 *
 * Le serveur trie et filtre TOUT le périmètre, puis le découpe en lots de
 * 50 ; le lot suivant part quand une sentinelle approche du bas de la liste
 * (`IntersectionObserver`). Aucun numéro de page, aucun « Page suivante ».
 * Regroupé, l'ordre serveur est « Rubrique, puis tri » : les lots remplissent
 * les sections de haut en bas, et regrouper ne fait que découper la liste
 * reçue. Les compteurs (sections, filtres, total) viennent du serveur et
 * portent sur l'ensemble filtré, pas sur les documents déjà chargés. État du
 * chargement : `documents-feed.ts` ; retour sur l'écran : `list-restore.ts`.
 *
 * ── CE QUI NE CHANGE PAS ──────────────────────────────────────────────────
 *
 * Le clic ouvre le tiroir document (le même que partout ailleurs), où l'on
 * modifie, déplace ou supprime ; l'ajout passe par le dialogue commun, gardé
 * en lecture seule ; aucun champ de recherche local (§4.2, UX-01).
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PdfThumbnail } from '@/components/ui/pdf-thumbnail';
import { apiClient } from '@/lib/api-client';
import { rubricColors } from '@/lib/referential/v2/rubrics';
import { DocumentDrawer, type DocumentDrawerItem } from '@/components/assets/DocumentDrawer';
import { ActiveFilterChips, DocumentsFilterPanel } from './DocumentsFilterPanel';
import { DocumentsToolbar } from './DocumentsToolbar';
import {
  EMPTY_FILTERS,
  UNFILED,
  activeFilterChips,
  activeFilterCount,
  countLabel,
  defaultDirection,
  displayedDate,
  documentSubtitle,
  effectiveSort,
  emptyRubricsLine,
  filterOptionsFromFacets,
  groupDocuments,
  hasActiveFilters,
  isToClassify,
  libelleResultats,
  parseSearchResults,
  sortOptionsFor,
  toggleFilter,
  type DocumentItem,
  type DocumentsContext,
  type RubricRef,
  type SortKey,
  type ViewFilters,
} from './documents-view';
import { DEFAULT_PREFS, loadPrefs, savePrefs, type ViewPrefs } from './view-prefs';
import { saveListSnapshot, takeListSnapshot, type ListSnapshot } from './list-restore';
import { useDocumentsFeed, type FeedQuery } from './useDocumentsFeed';

/**
 * Le téléversement RÉUTILISE le dialogue existant, il n'est pas réécrit.
 *
 * Le §4.1 veut des composants communs : `UnifiedDocumentDialog` porte déjà
 * fichier, lien web, rattachements et analyse.
 */
const UnifiedDocumentDialog = dynamic(
  () => import('@/components/documents/unified-document-dialog').then(
    (m) => ({ default: m.UnifiedDocumentDialog }),
  ),
  { ssr: false },
);

/** Lignes de la mini-page (maquette) : quelques longueurs, choisies par document. */
const LINES = [[92, 78, 85, 40], [70, 88, 60, 82, 45], [85, 85, 55], [60, 90, 90, 70, 30], [88, 45, 80, 75]];

function kindOf(document: DocumentItem) {
  const mime = document.mimeType ?? '';
  const isImage = mime.startsWith('image/');
  // Type parfois imprécis à l'import (« application/x-pdf », octet-stream) :
  // l'extension compte aussi, sinon la vignette retombe sur la mini-page.
  const isPdf = /pdf/i.test(mime) || /\.pdf$/i.test(document.originalFilename ?? '');
  const extension = (document.originalFilename?.split('.').pop() ?? '').slice(0, 5).toUpperCase();
  return { isImage, isPdf, extension };
}

/**
 * Mini-page stylisée : trait de la couleur de la Rubrique, lignes de texte.
 * Aperçu des documents qui n'en ont pas de réel (lien web, bureautique), et
 * miniature de la vue liste.
 */
function MiniPage({ document, size }: { document: DocumentItem; size: 'row' | 'tile' }) {
  const accent = rubricColors(document.rubricCode).accent;
  const lines = LINES[Math.abs(document.id) % LINES.length];
  const tile = size === 'tile';
  return (
    <span aria-hidden className={`flex h-full w-full flex-col ${tile ? 'gap-[5px] px-3 py-3.5' : 'gap-[2.5px] px-1 py-[5px]'}`}>
      <span
        className={`block ${tile ? 'mb-1 h-[7px] rounded-sm' : 'mb-0.5 h-[3px] rounded-[1px]'} w-[55%]`}
        style={{ background: accent }}
      />
      {lines.map((w, i) => (
        <span
          key={i}
          className={`block bg-[#CBD5E1] ${tile ? 'h-[3px] rounded-sm' : 'h-[1.5px] rounded-[1px]'}`}
          style={{ width: `${w}%` }}
        />
      ))}
    </span>
  );
}

function ToClassifyBadge({ onPreview = false }: { onPreview?: boolean }) {
  return (
    <Badge
      variant="pending"
      // Sur un aperçu (page blanche, photo), un fond opaque garde le badge lisible.
      className={`px-2 py-0.5 text-[11px] leading-4 ${onPreview ? 'bg-[#2A1F08] backdrop-blur-sm' : ''}`}
    >
      À classer
    </Badge>
  );
}

/**
 * Ligne de la vue liste — maquette 1a.
 *
 * Miniature (photo réelle pour une image, mini-page sinon), titre, sous-titre
 * « Type · date · bien », puis à droite : la Rubrique quand les titres de
 * section ne la disent pas, « À classer » pour un document sans Rubrique, et
 * la date du tri.
 */
function DocumentRow({
  document,
  sort,
  context,
  showRubric,
  rubricLabel,
  onOpen,
}: {
  document: DocumentItem;
  sort: SortKey;
  context: DocumentsContext;
  showRubric: boolean;
  rubricLabel: string;
  onOpen: (doc: DocumentItem) => void;
}) {
  const { isImage } = kindOf(document);
  const [imageKo, setImageKo] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(document)}
        className="flex w-full items-center gap-3.5 rounded-xl border border-transparent px-3 py-[9px] text-left transition-all duration-150 hover:border-[rgba(148,163,184,.3)] hover:bg-[color:var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative h-[38px] w-[30px] shrink-0 overflow-hidden rounded bg-white shadow-[0_1px_3px_rgba(0,0,0,.5)]">
          {isImage && !imageKo ? (
            // eslint-disable-next-line @next/next/no-img-element -- miniature autorisée (APP-PERF-06), placeholder si absente
            <img
              src={`/api/files/${document.id}/thumbnail`}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setImageKo(true)}
              className="block h-full w-full object-cover"
            />
          ) : (
            <MiniPage document={document} size="row" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{document.title}</span>
          <span className="mt-0.5 block truncate text-xs text-[color:var(--text-muted)]">
            {documentSubtitle(document, sort, context)}
          </span>
        </span>
        {showRubric && !isToClassify(document) && (
          <span className="hidden shrink-0 text-xs text-[color:var(--text-muted)] md:block">{rubricLabel}</span>
        )}
        {isToClassify(document) && <ToClassifyBadge />}
        <span className="hidden w-[90px] shrink-0 text-right text-xs text-[color:var(--text-muted)] sm:block">
          {displayedDate(document, sort)}
        </span>
      </button>
    </li>
  );
}

/**
 * Vignette — maquette 1a : cadre 4:3, la page posée en bas comme une feuille
 * sortant d'un classeur, titre et sous-titre SOUS l'aperçu.
 *
 * L'aperçu est réel quand il peut l'être :
 *   - image : sa miniature serveur, plein cadre (`/api/files/:id/thumbnail`,
 *     APP-PERF-06) — jamais l'original ; mini-page tant qu'elle manque ;
 *   - PDF : la première page (`PdfThumbnail` : miniature serveur, sinon
 *     rendu navigateur borné à l'approche de l'écran) ;
 *   - autre (lien web, bureautique…) : la mini-page stylisée et l'extension.
 */
function DocumentTile({
  document,
  sort,
  context,
  onOpen,
}: {
  document: DocumentItem;
  sort: SortKey;
  context: DocumentsContext;
  onOpen: (doc: DocumentItem) => void;
}) {
  const { isImage, isPdf, extension } = kindOf(document);
  const [imageKo, setImageKo] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(document)}
        className="group flex w-full flex-col gap-[9px] rounded-xl text-left transition-transform duration-150 hover:-translate-y-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
      >
        <span className="relative flex aspect-[4/3] w-full items-end justify-center overflow-hidden rounded-xl border border-[rgba(148,163,184,.3)] bg-[color:var(--bg-card)] px-[18px] pt-3.5 [.theme-beige_&]:bg-[#F1F5F9]">
          {isImage && !imageKo ? (
            // eslint-disable-next-line @next/next/no-img-element -- miniature autorisée (APP-PERF-06), placeholder si absente
            <img
              src={`/api/files/${document.id}/thumbnail`}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setImageKo(true)}
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <span className="relative block h-full w-full overflow-hidden rounded-t bg-white shadow-[0_-2px_12px_rgba(0,0,0,.4)]">
              {isPdf ? (
                <PdfThumbnail
                  fileId={String(document.id)}
                  className="absolute inset-0 h-full w-full"
                  fallback={<MiniPage document={document} size="tile" />}
                />
              ) : (
                <>
                  <MiniPage document={document} size="tile" />
                  {extension && (
                    <span className="absolute bottom-2 right-2.5 text-[9px] font-bold tracking-wider text-slate-400">
                      {extension}
                    </span>
                  )}
                </>
              )}
            </span>
          )}
          {isToClassify(document) && (
            <span className="absolute left-2 top-2">
              <ToClassifyBadge onPreview />
            </span>
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium">{document.title}</span>
          <span className="mt-0.5 block truncate text-[11.5px] text-[color:var(--text-muted)]">
            {documentSubtitle(document, sort, context)}
          </span>
        </span>
      </button>
    </li>
  );
}

export function DocumentsByRubric({
  assetId,
  assetName,
  showEmptyRubrics = true,
}: {
  assetId?: number;
  assetName?: string;
  /** Maquette : « afficherRubriquesVides », activé par défaut. */
  showEmptyRubrics?: boolean;
}) {
  const context: DocumentsContext = assetId ? 'fiche-bien' : 'mes-documents';
  const { setBreadcrumbs } = useBreadcrumb();
  // Lecture seule / offre : l'ajout est gardé ici, pour les deux écrans.
  const { garder } = useWriteGuard();
  const ajouter = () => garder(() => setUploadOpen(true), 'documents');
  const idBase = useId();
  const filtersPanelId = `${idBase}-filtres`;
  /** Instantané de retour propre à l'écran (Mes documents, ou ce bien). */
  const restoreScope = assetId ? `bien-${assetId}` : 'mes-documents';

  const [documentOuvert, setDocumentOuvert] = useState<DocumentDrawerItem | null>(null);
  const [documentDrawerOpen, setDocumentDrawerOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [assetOptions, setAssetOptions] = useState<Array<{ id: number; name: string }>>([]);

  // ── Préférences d'affichage (mémorisées par contexte) ──────────────────
  // Lues après le montage : le rendu serveur ne connaît pas le stockage du
  // navigateur, et les lire pendant le rendu désaccorderait l'hydratation.
  // Aucun lot ne part avant (`ready`) : sinon le premier serait demandé avec
  // le tri par défaut, puis aussitôt jeté.
  const [prefs, setPrefs] = useState<ViewPrefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);
  const restoreRef = useRef<ListSnapshot | null>(null);
  // ── Résultats de recherche de l'assistant (Mes documents seulement) ──────
  const [resultIds, setResultIds] = useState<number[] | null>(null);
  // ── Filtres (jamais mémorisés d'une visite à l'autre) et état local ──────
  const [filters, setFilters] = useState<ViewFilters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setPrefs(loadPrefs(context));
    if (!assetId && typeof window !== 'undefined') {
      setResultIds(parseSearchResults(new URLSearchParams(window.location.search).get('resultats')));
    }
    // Retour depuis une fiche : filtres et lots déjà chargés repris (borné).
    const snapshot = takeListSnapshot(restoreScope);
    if (snapshot) {
      restoreRef.current = snapshot;
      setFilters(snapshot.filters);
    }
    setReady(true);
  }, [context, assetId, restoreScope]);

  const updatePrefs = useCallback((patch: Partial<ViewPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      savePrefs(context, next);
      return next;
    });
  }, [context]);

  const effacerResultats = () => {
    setResultIds(null);
    window.history.replaceState(null, '', window.location.pathname);
  };
  const changeFilters = (next: ViewFilters) => setFilters(next);

  // ── Requête : tri, filtres et recherche appliqués CÔTÉ SERVEUR ───────────
  // Tout changement produit une nouvelle clé : liste vidée, curseur oublié,
  // premier lot des nouveaux critères (`useDocumentsFeed`).
  const sort = effectiveSort(prefs.sort, prefs.grouped, context);
  const query = useMemo<FeedQuery | null>(() => (ready ? {
    assetIds: assetId ? [assetId] : [],
    sort,
    direction: prefs.dir,
    grouped: prefs.grouped,
    filters,
    ids: resultIds,
  } : null), [ready, assetId, sort, prefs.dir, prefs.grouped, filters, resultIds]);
  const feed = useDocumentsFeed(query, restoreRef);
  const { documents: charges, meta, state: feedState } = feed;
  const load = feed.refresh;

  useEffect(() => {
    // Dans l'onglet d'un bien, le fil d'Ariane est posé par la page du bien.
    if (!assetId) setBreadcrumbs([{ label: 'Mes documents' }]);
  }, [assetId, setBreadcrumbs]);

  // Un document ajouté ailleurs (barre d'actions, assistant) apparaît ici aussi,
  // à la place que lui donnent le tri et les filtres actifs.
  useEffect(() => {
    const recharger = () => { void load(); };
    window.addEventListener('document-added', recharger);
    return () => window.removeEventListener('document-added', recharger);
  }, [load]);

  // Suppression (tiroir) : le document disparaît tout de suite, les compteurs
  // suivent, la position est conservée — pas de rechargement complet. Le
  // tiroir appelle ensuite `onRefresh` : cet appel-là est sauté.
  const suppressionRecente = useRef(false);
  useEffect(() => {
    const retirer = (e: Event) => {
      const id = Number((e as CustomEvent<{ fileId?: number }>).detail?.fileId);
      if (!Number.isInteger(id)) return;
      suppressionRecente.current = true;
      feed.remove(id);
    };
    window.addEventListener('document-deleted', retirer);
    return () => window.removeEventListener('document-deleted', retirer);
  }, [feed.remove]); // eslint-disable-line react-hooks/exhaustive-deps
  const apresModification = () => {
    if (suppressionRecente.current) {
      suppressionRecente.current = false;
      return;
    }
    void load();
  };

  // Biens proposés au dialogue d'ajout : inutile dans l'onglet d'un bien.
  useEffect(() => {
    if (assetId) return;
    apiClient
      .get<{ data: Array<{ id: number; name: string }> }>('/api/assets?limit=100')
      .then((r) => setAssetOptions(r.data ?? []))
      .catch(() => setAssetOptions([]));
  }, [assetId]);

  // ── Position de défilement : suivie, sauvegardée au départ, restaurée ────
  const scrollTopRef = useRef(0);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  useEffect(() => {
    const conteneur = scrollContainer();
    const cible: HTMLElement | Window = conteneur ?? window;
    const suivre = () => { scrollTopRef.current = conteneur ? conteneur.scrollTop : window.scrollY; };
    cible.addEventListener('scroll', suivre, { passive: true });
    const sauver = () => {
      const s = feed.snapshot();
      if (s) saveListSnapshot(restoreScope, { ...s, filters: filtersRef.current, scrollTop: scrollTopRef.current, savedAt: Date.now() });
    };
    window.addEventListener('pagehide', sauver);
    return () => {
      cible.removeEventListener('scroll', suivre);
      window.removeEventListener('pagehide', sauver);
      sauver();
    };
  }, [restoreScope]); // eslint-disable-line react-hooks/exhaustive-deps

  const restoredScrollTop = feed.restoredScrollTop;
  useEffect(() => {
    if (restoredScrollTop === null) return;
    // Après le rendu des lots restaurés ; `instant` : le conteneur défile en
    // douceur par défaut, et une animation depuis le haut serait un saut.
    const frame = requestAnimationFrame(() => {
      const conteneur = scrollContainer();
      if (conteneur) conteneur.scrollTo({ top: restoredScrollTop, behavior: 'instant' as ScrollBehavior });
      else window.scrollTo({ top: restoredScrollTop, behavior: 'instant' as ScrollBehavior });
      feed.clearRestoredScroll();
    });
    return () => cancelAnimationFrame(frame);
  }, [restoredScrollTop]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sentinelle : le lot suivant part à l'approche du bas ─────────────────
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [sentinelVisible, setSentinelVisible] = useState(false);
  const [observerOk, setObserverOk] = useState(true);
  const hasDocuments = charges.length > 0;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setObserverOk(false);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setSentinelVisible(entry.isIntersecting),
      // Placée sous la liste, elle « s'allume » 600 px avant d'être visible :
      // le lot suivant arrive avant que l'utilisateur n'atteigne le bas.
      { root: scrollContainer(), rootMargin: '0px 0px 600px 0px' },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      // Liste vidée (nouveaux critères) : l'ancienne visibilité ne vaut plus.
      setSentinelVisible(false);
    };
  }, [hasDocuments]);
  // Après chaque lot : si la sentinelle est encore en vue (grand écran,
  // section repliée), le suivant part — l'observateur, lui, ne se manifeste
  // qu'aux changements.
  useEffect(() => {
    if (sentinelVisible && feed.canLoadMore) void feed.loadNext();
  }, [sentinelVisible, feed.canLoadMore, charges.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Données dérivées (compteurs : serveur, ensemble filtré complet) ──────
  // Réponse inattendue (session expirée, proxy) : une page vide, pas une erreur d'affichage.
  const rubrics = useMemo<RubricRef[]>(
    () => (meta?.rubrics ?? []).map((r) => ({ code: r.code, label: r.label })),
    [meta],
  );
  const rubricLabels = useMemo(() => new Map(rubrics.map((r) => [r.code, r.label])), [rubrics]);
  const groupCounts = useMemo(() => {
    const m = new Map<string, number>((meta?.rubrics ?? []).map((r) => [r.code, r.count]));
    m.set(UNFILED, meta?.unfiledCount ?? 0);
    return m;
  }, [meta]);
  const filtered = hasActiveFilters(filters);
  const options = useMemo(() => filterOptionsFromFacets(meta?.facets, filters, rubrics), [meta, filters, rubrics]);
  const chips = activeFilterChips(filters, options);
  // Les documents arrivent triés et filtrés par le serveur, sur tout le
  // périmètre : l'écran ne retrie jamais un lot, il le découpe en sections.
  const { groups: allGroups } = useMemo(
    () => groupDocuments(charges, rubrics, prefs.grouped),
    [charges, rubrics, prefs.grouped],
  );
  const groups = allGroups;
  const total = meta?.total ?? 0;
  const scopeTotal = meta?.scopeTotal ?? 0;

  // Rubriques vides : seulement sans filtre. Filtré, une Rubrique « sans
  // document » le serait par l'effet du filtre, et la ligne mentirait.
  const emptyLine = prefs.grouped && showEmptyRubrics && !filtered && scopeTotal > 0
    ? emptyRubricsLine((meta?.rubrics ?? []).filter((r) => r.scopeCount === 0).map((r) => r.label))
    : '';

  const toggleGroup = (code: string) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });

  // ══════════════════════════════════════════════════════════════════════
  // LE CLIC OUVRE LE DOCUMENT, PAS SON CLASSEMENT
  //
  // Le tiroir document est le même que partout ailleurs (accueil, agenda,
  // fournisseur) : aperçu, informations, échéances liées, Rubrique et Type,
  // déplacement et suppression.
  // ══════════════════════════════════════════════════════════════════════
  const openDocument = (doc: DocumentItem) => {
    setDocumentOuvert({
      id: doc.id,
      originalFilename: doc.originalFilename ?? doc.title,
      mimeType: doc.mimeType ?? '',
      documentType: doc.documentTypeCode ?? 'AUTRE',
      documentDate: doc.documentDate,
      assetId: doc.assetId ?? 0,
    });
    setDocumentDrawerOpen(true);
  };

  const premierChargement = !meta && feedState.status !== 'error';
  const erreurInitiale = feedState.error === 'first' && !meta;
  const chargementSuite = feedState.pending?.kind === 'next';
  const erreurSuite = feedState.error === 'next';

  return (
    <div className="w-full max-w-full overflow-x-hidden">
      {/* Titre de page : « Mes documents » seulement. Dans l'onglet d'un bien,
          la fiche porte déjà le nom du bien et ses onglets. */}
      {!assetId && (
        <div className="mb-[18px] flex items-center gap-3">
          <h1 className="m-0 text-2xl font-semibold tracking-[-.02em]">Mes documents</h1>
        </div>
      )}

      <DocumentsToolbar
        countLabel={!meta ? ' ' : countLabel(total, scopeTotal, filtered, context)}
        grouped={prefs.grouped}
        onGroupedChange={(v) => updatePrefs({ grouped: v })}
        view={prefs.view}
        onViewChange={(v) => updatePrefs({ view: v })}
        sort={sort}
        sortOptions={sortOptionsFor(prefs.grouped, context)}
        onSortChange={(v) => updatePrefs({ sort: v, dir: defaultDirection(v) })}
        dir={prefs.dir}
        onDirToggle={() => updatePrefs({ dir: prefs.dir === 'desc' ? 'asc' : 'desc' })}
        filterCount={activeFilterCount(filters)}
        filtersOpen={filtersOpen}
        filtersPanelId={filtersPanelId}
        onFiltersToggle={() => setFiltersOpen((v) => !v)}
        onAdd={ajouter}
      />

      {filtersOpen && (
        <DocumentsFilterPanel
          id={filtersPanelId}
          context={context}
          options={options}
          onToggle={(dim, value) => changeFilters(toggleFilter(filters, dim, value))}
        />
      )}
      {resultIds && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-[color:var(--text-secondary)]" data-testid="search-results-filter">
          {/* Compte des documents réellement trouvés dans le compte, pas des identifiants de l'URL. */}
          <span>
            Résultats de la recherche Verebona
            {meta ? ` · ${libelleResultats(scopeTotal)}` : ''}
          </span>
          <Button size="sm" variant="ghost" onClick={effacerResultats}>Tout afficher</Button>
        </div>
      )}
      <ActiveFilterChips
        chips={chips}
        onRemove={(dim, value) => changeFilters(toggleFilter(filters, dim, value))}
        onClear={() => changeFilters(EMPTY_FILTERS)}
      />

      {premierChargement && (
        <div role="status" className="flex items-center gap-2 py-8 text-sm text-[color:var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Chargement des documents…
        </div>
      )}

      {erreurInitiale && (
        <div className="flex flex-col items-center gap-3 py-12 text-center text-sm text-[color:var(--text-muted)]">
          <p>Vos documents n&apos;ont pas pu être chargés.</p>
          <Button size="sm" variant="outline" onClick={feed.retry}>Réessayer</Button>
        </div>
      )}

      {meta && scopeTotal === 0 && (
        <div className="py-12 text-center">
          <p className="text-sm font-medium">
            {assetId ? 'Aucun document rattaché à ce bien pour le moment.' : 'Aucun document pour le moment.'}
          </p>
          <p className="mt-1 text-sm text-[color:var(--text-muted)]">
            Ajoutez une facture, un contrat ou une notice avec « Ajouter un document ».
          </p>
        </div>
      )}

      {meta && scopeTotal > 0 && total === 0 && (
        <p className="py-12 text-center text-sm text-[color:var(--text-muted)]">
          Aucun document ne correspond à ces filtres.
        </p>
      )}

      <div className="flex flex-col gap-[30px]">
        {groups.map((group) => {
          const ouvert = !closed.has(group.code);
          const listId = `${idBase}-groupe-${group.code}`;
          // Compteur de section : ensemble filtré complet, pas les seuls documents chargés.
          const count = groupCounts.get(group.code) ?? group.docs.length;
          return (
            <section key={group.code} className="flex flex-col gap-3" aria-label={group.showHeader ? undefined : 'Tous les documents'}>
              {group.showHeader && (
                <h2 className="m-0">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.code)}
                    aria-expanded={ouvert}
                    aria-controls={listId}
                    className="flex w-full select-none items-center gap-2.5 rounded py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronDown
                      className={`h-3.5 w-3.5 shrink-0 text-[color:var(--text-muted)] transition-transform duration-200 ${ouvert ? '' : '-rotate-90'}`}
                      aria-hidden
                    />
                    <span className="text-[11px] font-semibold uppercase tracking-[.05em] text-[color:var(--text-muted)]">
                      {group.label}
                    </span>
                    <span className="text-[11px] text-[color:var(--text-muted)] opacity-70">
                      <span className="sr-only">, </span>{count}<span className="sr-only"> document{count > 1 ? 's' : ''}</span>
                    </span>
                    <span aria-hidden className="h-px flex-1 bg-[color:var(--border-subtle)]" />
                  </button>
                </h2>
              )}
              {ouvert && group.docs.length > 0 && (prefs.view === 'list' ? (
                <ul id={listId} className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {group.docs.map((doc) => (
                    <DocumentRow
                      key={doc.publicId}
                      document={doc}
                      sort={sort}
                      context={context}
                      showRubric={!prefs.grouped}
                      rubricLabel={doc.rubricCode ? (rubricLabels.get(doc.rubricCode) ?? '') : ''}
                      onOpen={openDocument}
                    />
                  ))}
                </ul>
              ) : (
                <ul
                  id={listId}
                  className="m-0 grid list-none grid-cols-2 gap-4 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
                >
                  {group.docs.map((doc) => (
                    <DocumentTile key={doc.publicId} document={doc} sort={sort} context={context} onOpen={openDocument} />
                  ))}
                </ul>
              ))}
            </section>
          );
        })}

        {/* Bas de liste : sentinelle (invisible), indicateur discret, erreur
            locale. Hauteur réservée : l'apparition de l'indicateur ne fait
            pas sauter le contenu. Aucun numéro de page. */}
        {hasDocuments && (
          <div className="flex min-h-[40px] flex-col items-center justify-center gap-2" data-testid="documents-bas-de-liste">
            <div ref={sentinelRef} aria-hidden className="h-px w-full" />
            {chargementSuite && (
              <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-[color:var(--text-muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Chargement des documents…
              </p>
            )}
            {erreurSuite && (
              <div role="alert" className="flex flex-wrap items-center justify-center gap-2 text-xs text-[color:var(--text-muted)]">
                <span>Impossible de charger les documents suivants.</span>
                <Button size="sm" variant="outline" onClick={feed.retry}>Réessayer</Button>
              </div>
            )}
            {/* Secours : sans observateur, ou au clavier (visible au focus).
                Le parcours normal reste le chargement automatique. */}
            {feed.canLoadMore && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void feed.loadNext()}
                className={observerOk ? 'sr-only focus:not-sr-only' : ''}
              >
                Charger les documents suivants
              </Button>
            )}
          </div>
        )}

        {emptyLine && feedState.status === 'end' && (
          <p className="border-t border-dashed border-[color:var(--border-subtle)] pt-1.5 text-xs text-[color:var(--text-muted)]">
            {emptyLine}
          </p>
        )}
      </div>

      {/* Tiroir document : le même composant que sur les autres écrans, avec
          son aperçu, ses informations et ses échéances liées. */}
      <DocumentDrawer
        open={documentDrawerOpen}
        onOpenChange={(ouvert) => {
          setDocumentDrawerOpen(ouvert);
          if (!ouvert) setDocumentOuvert(null);
        }}
        document={documentOuvert}
        onRefresh={apresModification}
      />

      {uploadOpen && (assetId ? (
        // Onglet d'un bien : le document est rattaché à CE bien.
        <UnifiedDocumentDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          preselectedAssetId={assetId}
          availableAssets={[{ id: assetId, name: assetName ?? '' }] as never}
          allowAssetSelection={false}
          allowEventCreation
          allowEventAssociation={false}
          onSuccess={() => { setUploadOpen(false); void load(); }}
        />
      ) : (
        <UnifiedDocumentDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          availableAssets={assetOptions as never}
          onSuccess={() => void load()}
        />
      ))}
    </div>
  );
}

/** Conteneur de défilement du tableau de bord (`DashboardLayout`), sinon la fenêtre. */
function scrollContainer(): HTMLElement | null {
  return typeof document !== 'undefined' ? document.getElementById('main-scroll-container') : null;
}
