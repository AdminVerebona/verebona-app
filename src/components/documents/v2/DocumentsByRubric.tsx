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
import { ChevronDown, FileText, Image as ImageIcon, Loader2, Plus } from 'lucide-react';
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

interface DocumentView {
  id: number;
  publicId: string;
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
  onOpen,
}: {
  document: DocumentView;
  showAssets: boolean;
  onOpen: (doc: DocumentView) => void;
}) {
  const Icon = document.mimeType?.startsWith('image/') ? ImageIcon : FileText;

  return (
    // §4.7 : la carte entière est cliquable et ouvre le drawer.
    <button
      type="button"
      onClick={() => onOpen(document)}
      className="flex w-full items-start gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{document.title}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {/* §4.3 : Type affiché ; absent et Rubrique présente ⇒ « Type à compléter ». */}
          {document.documentTypeLabel ?? MICROCOPY.missingType}
          {document.documentDate && <> · {document.documentDate}</>}
          {showAssets && document.assetNames.length > 0 && (
            <> · {document.assetNames.join(', ')}</>
          )}
        </p>
      </div>
    </button>
  );
}

function RubricSection({
  group,
  showAssets,
  onOpen,
  onLoadMore,
  loadingMore,
}: {
  group: GroupView;
  showAssets: boolean;
  onOpen: (doc: DocumentView) => void;
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
        <div className="space-y-2 px-4 pb-4">
          {group.documents.map((doc) => (
            <DocumentCardV2
              key={doc.publicId}
              document={doc}
              showAssets={showAssets}
              onOpen={onOpen}
            />
          ))}
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
              className="w-full"
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

  const openDocument = (doc: DocumentView) => {
    setSelected({
      id: doc.id,
      publicId: doc.publicId,
      title: doc.title,
      // La Rubrique courante n'est pas portée par la carte (§4.3) : elle est
      // déduite du Type, ou laissée vide pour « Sans rubrique ».
      rubricCode: null,
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
            onOpen={openDocument}
            onLoadMore={loadMore}
            loadingMore={loadingGroup === group.code}
          />
        ))}
      </div>

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
