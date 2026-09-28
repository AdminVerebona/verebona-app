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
 * ── LE TRI EST GLOBAL ─────────────────────────────────────────────────────
 *
 * Le périmètre entier est chargé (`pageSize=all`) puis trié d'un bloc ;
 * regrouper ne fait que découper la liste triée. Filtres, tri et regroupement
 * sont calculés dans `documents-view.ts` (fonctions pures, testées).
 *
 * ── CE QUI NE CHANGE PAS ──────────────────────────────────────────────────
 *
 * Le clic ouvre le tiroir document (le même que partout ailleurs), où l'on
 * modifie, déplace ou supprime ; l'ajout passe par le dialogue commun, gardé
 * en lecture seule ; aucun champ de recherche local (§4.2, UX-01).
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PdfThumbnail } from '@/components/ui/pdf-thumbnail';
import { apiClient } from '@/lib/api-client';
import { rubricColors } from '@/lib/referential/v2/rubrics';
import { MAX_LOADED_DOCUMENTS } from '@/lib/documents/rubric-page';
import { DocumentDrawer, type DocumentDrawerItem } from '@/components/assets/DocumentDrawer';
import { ActiveFilterChips, DocumentsFilterPanel } from './DocumentsFilterPanel';
import { DocumentsToolbar } from './DocumentsToolbar';
import {
  EMPTY_FILTERS,
  UNFILED,
  activeFilterChips,
  activeFilterCount,
  buildFilterOptions,
  countLabel,
  defaultDirection,
  displayedDate,
  documentSubtitle,
  effectiveSort,
  emptyRubricsLine,
  filterDocuments,
  groupDocuments,
  hasActiveFilters,
  isToClassify,
  limitGroups,
  sortDocuments,
  sortOptionsFor,
  toggleFilter,
  type DocumentItem,
  type DocumentsContext,
  type RubricRef,
  type SortKey,
  type ViewFilters,
} from './documents-view';
import { DEFAULT_PREFS, loadPrefs, savePrefs, type ViewPrefs } from './view-prefs';

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

interface GroupResponse {
  code: string;
  label: string;
  count: number;
  documents: DocumentItem[];
  hasMore: boolean;
}

interface PageResponse {
  groups: GroupResponse[];
  total: number;
  unfiledCount: number;
}

/** Nombre de documents rendus d'un coup ; « Afficher plus » ajoute la suite. */
const RENDER_STEP = 150;

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
            // eslint-disable-next-line @next/next/no-img-element -- flux authentifié, pas d'optimisation Next
            <img
              src={`/api/files/${document.id}/proxy`}
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
 *   - image : le fichier lui-même, plein cadre (`/api/files/:id/proxy`) ;
 *   - PDF : la première page (`PdfThumbnail`, rendue à l'approche de
 *     l'écran puis gardée en mémoire) ;
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
            // eslint-disable-next-line @next/next/no-img-element -- flux authentifié, pas d'optimisation Next
            <img
              src={`/api/files/${document.id}/proxy`}
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

  const [page, setPage] = useState<PageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [documentOuvert, setDocumentOuvert] = useState<DocumentDrawerItem | null>(null);
  const [documentDrawerOpen, setDocumentDrawerOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [assetOptions, setAssetOptions] = useState<Array<{ id: number; name: string }>>([]);

  // ── Préférences d'affichage (mémorisées par contexte) ──────────────────
  // Lues après le montage : le rendu serveur ne connaît pas le stockage du
  // navigateur, et les lire pendant le rendu désaccorderait l'hydratation.
  const [prefs, setPrefs] = useState<ViewPrefs>(DEFAULT_PREFS);
  useEffect(() => {
    setPrefs(loadPrefs(context));
  }, [context]);
  const updatePrefs = useCallback((patch: Partial<ViewPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      savePrefs(context, next);
      return next;
    });
  }, [context]);

  // ── Filtres (jamais mémorisés) et état local ───────────────────────────
  const [filters, setFilters] = useState<ViewFilters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [limit, setLimit] = useState(RENDER_STEP);
  const changeFilters = (next: ViewFilters) => {
    setFilters(next);
    setLimit(RENDER_STEP);
  };

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (assetId) params.set('assets', String(assetId));
    params.set('pageSize', 'all');
    return params.toString();
  }, [assetId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPage(await apiClient.get<PageResponse>(`/api/v2/documents?${query}`));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    // Dans l'onglet d'un bien, le fil d'Ariane est posé par la page du bien.
    if (!assetId) setBreadcrumbs([{ label: 'Mes documents' }]);
  }, [assetId, setBreadcrumbs]);

  useEffect(() => {
    void load();
  }, [load]);

  // Un document ajouté ailleurs (barre d'actions, assistant) apparaît ici aussi.
  useEffect(() => {
    const recharger = () => { void load(); };
    window.addEventListener('document-added', recharger);
    return () => window.removeEventListener('document-added', recharger);
  }, [load]);

  // Biens proposés au dialogue d'ajout : inutile dans l'onglet d'un bien.
  useEffect(() => {
    if (assetId) return;
    apiClient
      .get<{ data: Array<{ id: number; name: string }> }>('/api/assets?limit=100')
      .then((r) => setAssetOptions(r.data ?? []))
      .catch(() => setAssetOptions([]));
  }, [assetId]);

  // ── Données dérivées ───────────────────────────────────────────────────
  // Réponse inattendue (session expirée, proxy) : une page vide, pas une erreur d'affichage.
  const scope = useMemo(() => (page?.groups ?? []).flatMap((g) => g.documents ?? []), [page]);
  const rubrics = useMemo<RubricRef[]>(
    () => (page?.groups ?? []).filter((g) => g.code !== UNFILED).map((g) => ({ code: g.code, label: g.label })),
    [page],
  );
  const rubricLabels = useMemo(() => new Map(rubrics.map((r) => [r.code, r.label])), [rubrics]);
  const sort = effectiveSort(prefs.sort, prefs.grouped, context);
  const filtered = hasActiveFilters(filters);
  const options = useMemo(() => buildFilterOptions(scope, filters, rubrics), [scope, filters, rubrics]);
  const chips = activeFilterChips(filters, options);
  const visibles = useMemo(
    () => sortDocuments(filterDocuments(scope, filters), sort, prefs.dir, rubrics),
    [scope, filters, sort, prefs.dir, rubrics],
  );
  const { groups: allGroups, emptyRubrics } = useMemo(
    () => groupDocuments(visibles, rubrics, prefs.grouped),
    [visibles, rubrics, prefs.grouped],
  );
  // Un groupe replié ne compte pas dans le plafond de rendu.
  const { groups, hidden } = useMemo(() => {
    const ouverts = allGroups.map((g) => (closed.has(g.code) ? { ...g, docs: [] } : g));
    const limited = limitGroups(ouverts, limit);
    return {
      groups: allGroups.map((g) => ({
        ...g,
        docs: limited.groups.find((l) => l.code === g.code)?.docs ?? [],
      })).filter((g) => closed.has(g.code) || g.docs.length > 0),
      hidden: limited.hidden,
    };
  }, [allGroups, closed, limit]);

  // Rubriques vides : seulement sans filtre. Filtré, une Rubrique « sans
  // document » le serait par l'effet du filtre, et la ligne mentirait.
  const emptyLine = prefs.grouped && showEmptyRubrics && !filtered && scope.length > 0
    ? emptyRubricsLine(emptyRubrics)
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

  // Tronquée seulement si le serveur a atteint son plafond de chargement : le
  // total seul ne suffit pas (il peut différer pour d'autres raisons).
  const tronque = !!page && scope.length >= MAX_LOADED_DOCUMENTS && page.total > scope.length;

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
        countLabel={loading && !page ? ' ' : countLabel(visibles.length, scope.length, filtered, context)}
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
      <ActiveFilterChips
        chips={chips}
        onRemove={(dim, value) => changeFilters(toggleFilter(filters, dim, value))}
        onClear={() => changeFilters(EMPTY_FILTERS)}
      />

      {loading && !page && (
        <div className="flex items-center gap-2 py-8 text-sm text-[color:var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Chargement des documents…
        </div>
      )}

      {loadError && !page && (
        <div className="flex flex-col items-center gap-3 py-12 text-center text-sm text-[color:var(--text-muted)]">
          <p>Vos documents n&apos;ont pas pu être chargés.</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>Réessayer</Button>
        </div>
      )}

      {page && scope.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-sm font-medium">
            {assetId ? 'Aucun document rattaché à ce bien pour le moment.' : 'Aucun document pour le moment.'}
          </p>
          <p className="mt-1 text-sm text-[color:var(--text-muted)]">
            Ajoutez une facture, un contrat ou une notice avec « Ajouter un document ».
          </p>
        </div>
      )}

      {page && scope.length > 0 && visibles.length === 0 && (
        <p className="py-12 text-center text-sm text-[color:var(--text-muted)]">
          Aucun document ne correspond à ces filtres.
        </p>
      )}

      <div className="flex flex-col gap-[30px]">
        {groups.map((group) => {
          const ouvert = !closed.has(group.code);
          const listId = `${idBase}-groupe-${group.code}`;
          const total = allGroups.find((g) => g.code === group.code)?.docs.length ?? 0;
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
                      <span className="sr-only">, </span>{total}<span className="sr-only"> document{total > 1 ? 's' : ''}</span>
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

        {hidden > 0 && (
          <Button variant="outline" size="sm" className="self-center" onClick={() => setLimit((l) => l + RENDER_STEP)}>
            Afficher {Math.min(hidden, RENDER_STEP)} documents de plus
          </Button>
        )}

        {emptyLine && (
          <p className="border-t border-dashed border-[color:var(--border-subtle)] pt-1.5 text-xs text-[color:var(--text-muted)]">
            {emptyLine}
          </p>
        )}

        {tronque && (
          <p className="text-xs text-[color:var(--text-muted)]">
            Seuls les {scope.length.toLocaleString('fr-FR')} documents les plus récents sont affichés ici.
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
        onRefresh={() => void load()}
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
