'use client';

/**
 * Documents groupés par Rubrique — CDC V2.0 §4.2, §4.3, §4.4, §4.7, §17.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL NIVEAU DE REGROUPEMENT VISIBLE
 *
 * §4.2 : « Un seul niveau de regroupement visible : la Rubrique. Le Type ne
 * crée jamais de sous-groupe. » C'est la rupture avec l'arborescence que la V1
 * laissait deviner — catégorie puis type — et qui obligeait à deux clics pour
 * atteindre un document dont on connaissait déjà la nature.
 *
 * ── CE COMPOSANT NE TRIE RIEN ─────────────────────────────────────────────
 *
 * L'ordre des groupes vient du serveur : « Sans rubrique » d'abord et
 * seulement s'il contient quelque chose, « Autres documents » en dernier, les
 * Rubriques métier visibles même à 0 (§3.3, §4.4). Les recalculer ici
 * produirait un second jeu de règles, qui divergerait du premier.
 *
 * ── LE DOCUMENT QUITTE « SANS RUBRIQUE » SANS RECHARGEMENT ────────────────
 *
 * §4.4, dernier alinéa. Le drawer enregistre, la page se recharge en arrière-
 * plan et le drawer reste ouvert (§4.7) : l'utilisateur voit le déplacement
 * s'opérer sans perdre le document des yeux.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { ChevronDown, FileText, Grid3x3, Image as ImageIcon, List, Loader2, Plus, Tags } from 'lucide-react';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import {
  DEFAULT_V2_FILTERS,
  DocumentsFilterDrawer,
  type DocumentsV2Filters,
} from './DocumentsFilterDrawer';

/**
 * Le téléversement RÉUTILISE le dialogue existant, il n'est pas réécrit.
 *
 * Le §4.1 veut des composants communs, et le lot 3B notait que dupliquer
 * l'ajout créerait deux chemins pour la même action. `UnifiedDocumentDialog`
 * porte déjà fichier, lien web, rattachements et analyse : en refaire une
 * version V2 garantirait qu'elles divergent.
 */
const UnifiedDocumentDialog = dynamic(
  () => import('@/components/documents/unified-document-dialog').then(
    (m) => ({ default: m.UnifiedDocumentDialog }),
  ),
  { ssr: false },
);
import {
  ASSET_DOCUMENTS_HEADLINE,
  MICROCOPY,
  myDocumentsHeadline,
} from '@/lib/referential/v2/microcopy';
import {
  RubricClassificationDrawer,
  type DocumentClassificationDraft,
} from './RubricClassificationDrawer';
import { DocumentDrawer, type DocumentDrawerItem } from '@/components/assets/DocumentDrawer';

/** Mode d'affichage des documents, mémorisé d'une visite à l'autre. */
type ViewMode = 'list' | 'grid';
const VIEW_MODE_KEY = 'documentsViewMode';

interface DocumentView {
  id: number;
  publicId: string;
  /** Nom du fichier d'origine — l'en-tête du tiroir document s'en sert. */
  originalFilename: string | null;
  /** Bien rattaché, quand il y en a un. */
  assetId: number | null;
  /** Rubrique de classement, `null` pour « Sans rubrique ». */
  rubricCode: string | null;
  title: string;
  documentTypeCode: string | null;
  documentTypeLabel: string | null;
  documentDate: string | null;
  mimeType: string | null;
  assetNames: string[];
}

interface GroupView {
  code: string;
  label: string;
  count: number;
  documents: DocumentView[];
  hasMore: boolean;
}

interface PageResponse {
  groups: GroupView[];
  typeOptions: Array<{ code: string; label: string }>;
  total: number;
  unfiledCount: number;
}

/**
 * Carte document — §4.3.
 *
 * Le tableau du §4.3 énumère ce qui s'affiche ET ce qui ne s'affiche pas. Les
 * absences sont aussi normatives que les présences : pas de Rubrique (portée
 * par le regroupement), pas de fournisseur ni de montant (réservés au drawer),
 * pas de statut d'analyse (« ne pas encombrer le composant »).
 */
function DocumentCardV2({
  document,
  showAssets,
  viewMode,
  onOpen,
  onClassify,
}: {
  document: DocumentView;
  showAssets: boolean;
  viewMode: ViewMode;
  onOpen: (doc: DocumentView) => void;
  onClassify: (doc: DocumentView) => void;
}) {
  const Icon = document.mimeType?.startsWith('image/') ? ImageIcon : FileText;
  const sousTitre = (
    <>
      {/* §4.3 : Type affiché ; absent et Rubrique présente ⇒ « Type à compléter ». */}
      {document.documentTypeLabel ?? MICROCOPY.missingType}
      {document.documentDate && <> · {document.documentDate}</>}
      {showAssets && document.assetNames.length > 0 && <> · {document.assetNames.join(', ')}</>}
    </>
  );

  // Le bouton « Classer » est posé À CÔTÉ de la zone cliquable, jamais
  // dedans : un bouton dans un bouton n'est pas du HTML valide, et le clic
  // se propagerait aux deux.
  const classer = (
    <button
      type="button"
      onClick={() => onClassify(document)}
      title="Classer dans une rubrique"
      aria-label={`Classer ${document.title}`}
      className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Tags className="h-4 w-4" aria-hidden />
    </button>
  );

  if (viewMode === 'grid') {
    return (
      <div className="relative flex flex-col rounded-lg border bg-card transition-colors hover:bg-accent/40">
        <div className="absolute right-1 top-1 z-10">{classer}</div>
        <button
          type="button"
          onClick={() => onOpen(document)}
          className="flex flex-1 flex-col items-center gap-2 rounded-lg p-4 text-center focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex h-16 w-full items-center justify-center rounded-md bg-muted/50">
            <Icon className="h-7 w-7 text-muted-foreground" aria-hidden />
          </span>
          <span className="line-clamp-2 w-full text-sm font-medium">{document.title}</span>
          <span className="line-clamp-2 w-full text-xs text-muted-foreground">{sousTitre}</span>
        </button>
      </div>
    );
  }

  return (
    // §4.7 : la carte entière est cliquable et ouvre le drawer.
    <div className="flex items-start gap-1 rounded-lg border bg-card transition-colors hover:bg-accent/40">
      <button
        type="button"
        onClick={() => onOpen(document)}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg p-3 text-left focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{document.title}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{sousTitre}</p>
        </div>
      </button>
      <span className="p-2">{classer}</span>
    </div>
  );
}

function RubricSection({
  group,
  showAssets,
  viewMode,
  onOpen,
  onClassify,
  onLoadMore,
  loadingMore,
}: {
  group: GroupView;
  showAssets: boolean;
  viewMode: ViewMode;
  onOpen: (doc: DocumentView) => void;
  onClassify: (doc: DocumentView) => void;
  onLoadMore: (code: string) => void;
  loadingMore: boolean;
}) {
  // Ouvert quand la Rubrique contient quelque chose : une Rubrique vide n'a
  // rien à déplier.
  const [open, setOpen] = useState(group.count > 0);
  const empty = group.count === 0;

  return (
    <section className="rounded-lg border">
      <button
        type="button"
        onClick={() => !empty && setOpen((v) => !v)}
        aria-expanded={open}
        // §3.3 : une Rubrique métier à 0 reste VISIBLE, mais inerte — la
        // montrer sans inviter à un clic qui ne mènerait nulle part.
        disabled={empty}
        className="flex w-full items-center justify-between px-4 py-3 text-left disabled:cursor-default"
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          {group.label}
          <span className="text-xs font-normal text-muted-foreground">{group.count}</span>
        </span>
        {!empty && (
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden
          />
        )}
      </button>

      {open && !empty && (
        <div className="px-4 pb-4">
          <div
            className={
              viewMode === 'grid'
                ? 'grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4'
                : 'space-y-2'
            }
          >
            {group.documents.map((doc) => (
              <DocumentCardV2
                key={doc.publicId}
                document={doc}
                showAssets={showAssets}
                viewMode={viewMode}
                onOpen={onOpen}
                onClassify={onClassify}
              />
            ))}
          </div>
          {group.hasMore && (
            // §16.3 : chargement progressif SANS perdre la structure des
            // Rubriques. Le bouton ajoute à la suite, il ne remplace pas la
            // page précédente — l'utilisateur ne doit pas perdre de vue le
            // document qu'il venait de repérer.
            <Button
              variant="ghost"
              size="sm"
              disabled={loadingMore}
              onClick={() => onLoadMore(group.code)}
              className="mt-2 w-full"
            >
              {loadingMore
                ? 'Chargement…'
                : `Voir les ${group.count - group.documents.length} autres`}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function DocumentsByRubric({ assetId }: { assetId?: number }) {
  const { setBreadcrumbs } = useBreadcrumb();
  const [page, setPage] = useState<PageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingGroup, setLoadingGroup] = useState<string | null>(null);
  const [selected, setSelected] = useState<DocumentClassificationDraft | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [documentOuvert, setDocumentOuvert] = useState<DocumentDrawerItem | null>(null);
  const [documentDrawerOpen, setDocumentDrawerOpen] = useState(false);
  // Choix d'affichage conservé d'une visite à l'autre, comme dans l'onglet
  // Documents d'un bien (même clé de lecture pour l'utilisateur, clé de
  // stockage distincte : les deux écrans ne montrent pas le même périmètre).
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  useEffect(() => {
    const enregistre = localStorage.getItem(VIEW_MODE_KEY);
    if (enregistre === 'grid' || enregistre === 'list') setViewMode(enregistre);
  }, []);
  const changerAffichage = (mode: ViewMode) => {
    setViewMode(mode);
    try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch { /* navigation privée */ }
  };
  const [uploadOpen, setUploadOpen] = useState(false);
  const [filters, setFilters] = useState<DocumentsV2Filters>(DEFAULT_V2_FILTERS);
  // Décalages par groupe : « Voir les N autres » n'affecte que sa Rubrique.
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [assetOptions, setAssetOptions] = useState<Array<{ id: number; name: string }>>([]);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    const assets = assetId ? [assetId] : filters.assetIds;
    if (assets.length > 0) params.set('assets', assets.join(','));
    if (filters.typeCodes.length > 0) params.set('types', filters.typeCodes.join(','));
    params.set('sort', filters.sort);
    params.set('direction', filters.direction);
    const pairs = Object.entries(offsets).filter(([, v]) => v > 0);
    if (pairs.length > 0) {
      params.set('offsets', pairs.map(([code, value]) => `${code}:${value}`).join(','));
    }
    return params.toString();
  }, [assetId, filters, offsets]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPage(await apiClient.get<PageResponse>(`/api/v2/documents?${query}`));
    } finally {
      setLoading(false);
      setLoadingGroup(null);
    }
  }, [query]);

  useEffect(() => {
    // Dans l'onglet d'un bien, le fil d'Ariane est posé par la page du bien.
    if (!assetId) setBreadcrumbs([{ label: 'Mes documents' }]);
  }, [assetId, setBreadcrumbs]);

  useEffect(() => {
    void load();
  }, [load]);

  // Liste des biens pour le filtre : inutile dans l'onglet d'un bien, où le
  // périmètre est déjà fixé.
  useEffect(() => {
    if (assetId) return;
    apiClient
      .get<{ data: Array<{ id: number; name: string }> }>('/api/assets?limit=100')
      .then((r) => setAssetOptions(r.data ?? []))
      .catch(() => setAssetOptions([]));
  }, [assetId]);

  const loadMore = (code: string) => {
    setLoadingGroup(code);
    setOffsets((current) => ({ ...current, [code]: (current[code] ?? 0) + 6 }));
  };

  /**
   * Application d'un filtre.
   *
   * Les décalages sont remis à zéro : conserver « Voir les N autres » d'un
   * filtrage précédent afficherait une page profonde d'un ensemble qui n'a
   * plus la même taille — et parfois une Rubrique vide alors qu'elle contient
   * des documents.
   */
  const applyFilters = (next: DocumentsV2Filters) => {
    setFilters(next);
    setOffsets({});
  };

  const deleteDocument = async (document: DocumentClassificationDraft & { id?: number }) => {
    if (!document.id) return;
    try {
      await apiClient.post('/api/documents/bulk-delete', { documentIds: [document.id] });
      toast.success('Document supprimé.');
      setDrawerOpen(false);
      await load();
    } catch {
      toast.error('Le document n’a pas pu être supprimé.');
    }
  };

  // ══════════════════════════════════════════════════════════════════════
  // LE CLIC OUVRE LE DOCUMENT, PAS SON CLASSEMENT
  //
  // La carte ouvrait le tiroir de classement (rubrique et type) : un panneau
  // par le bas avec deux listes déroulantes, là où l'utilisateur attend son
  // document — aperçu, informations, échéances liées, modification.
  //
  // Le clic ouvre donc le tiroir document, le même que partout ailleurs
  // (accueil, agenda, onglet Documents d'un bien, fournisseur). Le classement
  // reste accessible par l'icône dédiée de la carte.
  // ══════════════════════════════════════════════════════════════════════
  const openDocument = (doc: DocumentView) => {
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

  const classifyDocument = (doc: DocumentView) => {
    setSelected({
      id: doc.id,
      publicId: doc.publicId,
      title: doc.title,
      // ⚠️ La Rubrique COURANTE est transmise. Elle était forcée à `null` :
      // le tiroir s'ouvrait sur « Sans rubrique » pour un document pourtant
      // classé, et sa liste de Types — dérivée de la Rubrique — restait vide,
      // masquant le Type déjà renseigné. La carte ne l'affiche pas (§4.3),
      // mais ne pas l'afficher n'est pas une raison de l'ignorer.
      rubricCode: doc.rubricCode,
      documentTypeCode: doc.documentTypeCode,
    });
    setDrawerOpen(true);
  };

  const total = page?.total ?? 0;

  return (
    <div className="space-y-6 w-full max-w-full overflow-x-hidden">
      {/* En-tête au format des autres pages : titre, décompte, commandes à
          droite. Masqué dans l'onglet d'un bien, où la page porte déjà son
          propre titre (§4.1 : mêmes composants, seul le contexte change). */}
      {!assetId && (
        <div className="flex items-center justify-between mb-6">
          <div className="min-w-0">
            <h1 className="text-xl md:text-3xl font-bold whitespace-nowrap">Mes documents</h1>
            <p className="text-muted-foreground mt-1">
              {loading && !page
                ? '\u00a0'
                : total === 0
                  ? 'Aucun document pour le moment'
                  : `${total} ${total > 1 ? 'documents' : 'document'}`}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* Choix d'affichage — liste ou vignettes. Il manquait ici, alors
                qu'il existe dans l'onglet Documents d'un bien : une même
                collection se consultait de deux façons selon la page. */}
            <div className="flex items-center overflow-hidden rounded-md border border-border">
              <button
                type="button"
                onClick={() => changerAffichage('grid')}
                title="Vue vignettes"
                aria-label="Vue vignettes"
                aria-pressed={viewMode === 'grid'}
                className={`p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                <Grid3x3 className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => changerAffichage('list')}
                title="Vue liste"
                aria-label="Vue liste"
                aria-pressed={viewMode === 'list'}
                className={`p-1.5 transition-colors ${viewMode === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                <List className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <DocumentsFilterDrawer
              filters={filters}
              onApply={applyFilters}
              assetOptions={assetOptions}
              typeOptions={page?.typeOptions ?? []}
              hideAssetFilter={false}
            />
            <Button variant="outline" size="sm" onClick={() => setUploadOpen(true)} className="btn-add">
              <Plus className="btn-add-plus-icon h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Ajouter</span>
            </Button>
          </div>
        </div>
      )}

      {/* Onglet d'un bien : les commandes seules, sans titre ni décompte. */}
      {assetId && (
        <div className="flex items-center justify-end gap-2">
            {/* Choix d'affichage — liste ou vignettes. Il manquait ici, alors
              qu'il existe dans l'onglet Documents d'un bien : une même
              collection se consultait de deux façons selon la page. */}
          <div className="flex items-center overflow-hidden rounded-md border border-border">
            <button
              type="button"
              onClick={() => changerAffichage('grid')}
              title="Vue vignettes"
              aria-label="Vue vignettes"
              aria-pressed={viewMode === 'grid'}
              className={`p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <Grid3x3 className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => changerAffichage('list')}
              title="Vue liste"
              aria-label="Vue liste"
              aria-pressed={viewMode === 'list'}
              className={`p-1.5 transition-colors ${viewMode === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <List className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <DocumentsFilterDrawer
            filters={filters}
            onApply={applyFilters}
            assetOptions={assetOptions}
            typeOptions={page?.typeOptions ?? []}
            hideAssetFilter
          />
          <Button variant="outline" size="sm" onClick={() => setUploadOpen(true)} className="btn-add">
            <Plus className="btn-add-plus-icon h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Ajouter</span>
          </Button>
        </div>
      )}

      {/* §17.3 — un message global, adapté au contexte et au nombre. */}
      {total > 0 && (
        <p className="text-sm text-muted-foreground -mt-2">
          {assetId ? ASSET_DOCUMENTS_HEADLINE : myDocumentsHeadline(page?.unfiledCount ?? 0)}
        </p>
      )}

      {loading && !page && (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Chargement des documents…
        </div>
      )}

      <div className="space-y-3">
        {page?.groups.map((group) => (
          <RubricSection
            key={group.code}
            group={group}
            // §4.1 : le bien n'est affiché que sur « Mes documents » ; dans
            // l'onglet d'un bien, le contexte est déjà explicite.
            showAssets={!assetId}
            viewMode={viewMode}
            onOpen={openDocument}
            onClassify={classifyDocument}
            onLoadMore={loadMore}
            loadingMore={loadingGroup === group.code}
          />
        ))}
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

      <RubricClassificationDrawer
        document={selected}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        // §4.7 : la page se met à jour en arrière-plan, le drawer reste ouvert
        // le temps que l'utilisateur constate le déplacement.
        onSaved={() => void load()}
        onDelete={selected ? () => void deleteDocument(selected) : undefined}
      />

      {uploadOpen && (
        <UnifiedDocumentDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          availableAssets={assetOptions as never}
          onSuccess={() => void load()}
        />
      )}
    </div>
  );
}
