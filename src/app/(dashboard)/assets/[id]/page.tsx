"use client"

import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import Link from 'next/link';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  LayoutDashboard, Info, FileText, Activity,
  LayoutGrid, Settings, Download, Trash2, CalendarDays, MoreHorizontal,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { DeleteAssetDialog } from '@/components/assets/DeleteAssetDialog';
// ── Adaptive tabs bar ──────────────────────────────────────────────────────
interface TabDef {
  value: string;
  label: string;
  icon: React.ElementType;
}

function AdaptiveTabsList({
  tabs,
  activeTab,
  onTabChange,
}: {
  tabs: TabDef[];
  activeTab: string;
  onTabChange: (v: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(tabs.length);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const GAP = 4; // px gap between tabs

    const compute = () => {
      const available = container.clientWidth;
      const items = Array.from(measure.children) as HTMLElement[];
      // Measure the "more" button from the hidden row (last child)
      const moreBtnEl = items[items.length - 1];
      const moreBtnWidth = moreBtnEl
        ? (moreBtnEl.getBoundingClientRect().width || moreBtnEl.offsetWidth)
        : 72;
      const tabItems = items.slice(0, -1); // exclude the "more" button placeholder

      let used = 0;
      let count = 0;
      for (let i = 0; i < tabItems.length; i++) {
        const w = tabItems[i].getBoundingClientRect().width || tabItems[i].offsetWidth;
        const gap = count > 0 ? GAP : 0;
        // Check if ALL remaining tabs fit without a "more" button
        const isLast = i === tabItems.length - 1;
        if (isLast && used + gap + w <= available) {
          count++;
          break;
        }
        // Otherwise, reserve space for the "more" button
        if (used + gap + w + GAP + moreBtnWidth > available) break;
        used += gap + w;
        count++;
      }
      setVisibleCount(Math.max(1, count));
    };

    const ro = new ResizeObserver(compute);
    ro.observe(container);
    compute();
    return () => ro.disconnect();
  }, [tabs]);

  const visible = tabs.slice(0, visibleCount);
  const overflow = tabs.slice(visibleCount);
  const overflowHasActive = overflow.some(t => t.value === activeTab);

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0 overflow-hidden">
      {/* Hidden measurement row — all tabs + "more" button placeholder rendered off-screen at natural width */}
      <div
        ref={measureRef}
        aria-hidden
        className="absolute top-0 left-0 flex gap-1 pointer-events-none opacity-0 whitespace-nowrap"
        style={{ visibility: 'hidden' }}
      >
        {tabs.map(t => (
          <button key={t.value} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium whitespace-nowrap shrink-0">
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
        {/* "More" button placeholder for width measurement */}
        <button className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium whitespace-nowrap shrink-0">
          <MoreHorizontal className="w-4 h-4" />
          <span>Plus</span>
        </button>
      </div>

      {/* Visible tab list */}
      <TabsList className="flex flex-nowrap h-auto gap-1 w-full overflow-hidden">
        {visible.map(t => (
          <TabsTrigger
            key={t.value}
            value={t.value}
            className="shrink-0 whitespace-nowrap"
            onClick={() => onTabChange(t.value)}
            {...(t.value === 'details' ? { 'data-guide': 'asset-info-tab' } : {})}
          >
            <t.icon className="w-4 h-4 mr-1 hidden sm:inline" />
            {t.label}
          </TabsTrigger>
        ))}

        {overflow.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={[
                  'inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors shrink-0 ml-auto',
                  overflowHasActive
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                ].join(' ')}
              >
                <MoreHorizontal className="w-4 h-4" />
                <span>Plus</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {overflow.map(t => (
                <DropdownMenuItem key={t.value} onClick={() => onTabChange(t.value)}>
                  <t.icon className="w-4 h-4 mr-2" />
                  {t.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TabsList>
    </div>
  );
}
// ──────────────────────────────────────────────────────────────────────────
import dynamic from 'next/dynamic';
import { useSession } from '@/hooks/useSession';
import { useThumbnailUrl } from '@/hooks/useThumbnailUrl';
import { toast } from 'sonner';
import { getAssetIcon, CATEGORY_LABELS } from '@/lib/asset-icons';
import { apiClient } from '@/lib/api-client';
import type { AssetDetail } from '@/types/asset-detail';
import { ThumbnailEditDrawer } from '@/components/assets/ThumbnailEditDrawer';

// Lazy-load all tab components — only the active tab's code is fetched
const AssetOverviewTab = dynamic(() => import('@/components/assets/AssetOverviewTab').then(m => ({ default: m.AssetOverviewTab })), { ssr: false, loading: () => <TabSkeleton /> });
const AssetDetailsTab = dynamic(() => import('@/components/assets/AssetDetailsTab').then(m => ({ default: m.AssetDetailsTab })), { ssr: false, loading: () => <TabSkeleton /> });
const AssetDocumentsTab = dynamic(() => import('@/components/assets/AssetDocumentsTab').then(m => ({ default: m.AssetDocumentsTab })), { ssr: false, loading: () => <TabSkeleton /> });
const AssetSubstructuresPanel = dynamic(() => import('@/components/assets/asset-substructures-panel').then(m => ({ default: m.AssetSubstructuresPanel })), { ssr: false, loading: () => <TabSkeleton /> });
const AssetEquipmentsPanel = dynamic(() => import('@/components/assets/asset-equipments-panel').then(m => ({ default: m.AssetEquipmentsPanel })), { ssr: false, loading: () => <TabSkeleton /> });
const AssetExportsTab = dynamic(() => import('@/components/assets/AssetExportsTab').then(m => ({ default: m.AssetExportsTab })), { ssr: false, loading: () => <TabSkeleton /> });
const AssetAgendaTab = dynamic(() => import('@/components/assets/AssetAgendaTab').then(m => ({ default: m.AssetAgendaTab })), { ssr: false, loading: () => <TabSkeleton /> });

function TabSkeleton() {
  return (
    <div className="space-y-4 pt-4">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export type { AssetDetail } from '@/types/asset-detail';

const STATUS_LABELS: Record<string, string> = {
  EN_SERVICE: 'En service',
  EN_PANNE: 'En panne',
  EN_REPARATION: 'En réparation',
  VENDU: 'Vendu',
  DETRUIT: 'Détruit',
  INACTIF: 'Inactif',
  ARCHIVED: 'Archivé',
  TRANSMIS: 'Transmis',
};

const STATUS_VARIANTS: Record<string, 'active' | 'sold' | 'inactive' | 'pending' | 'secondary'> = {
  EN_SERVICE: 'active',
  VENDU: 'sold',
  EN_PANNE: 'inactive',
  EN_REPARATION: 'pending',
  TRANSMIS: 'sold',
};

// Subtypes that support rooms + equipments
const SUBTYPES_WITH_ROOMS = ['maison', 'appartement', 'immeuble', 'villa', 'propriété', 'studio', 'local commercial'];

function assetSupportsRooms(asset: AssetDetail) {
  if (asset.category !== 'IMMOBILIER') return false;
  if (!asset.subtype) return false;
  return SUBTYPES_WITH_ROOMS.includes(asset.subtype.toLowerCase());
}

export default function AssetDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoading: isPending } = useSession({ required: true });
  const { setBreadcrumbs } = useBreadcrumb();

  const [asset, setAsset] = useState<AssetDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [thumbnailDrawerOpen, setThumbnailDrawerOpen] = useState(false);
  const [overrideSignedThumbnail, setOverrideSignedThumbnail] = useState<string | null>(null);

  const activeTab = searchParams.get('tab') ?? 'overview';

  const { signedUrl: thumbnailSignedUrl, isLoading: thumbnailLoading } = useThumbnailUrl(
    asset?.id,
    asset?.thumbnailUrl
  );

  const loadAsset = useCallback(async (id: number) => {
    try {
      const data = await apiClient.get<AssetDetail>(`/api/assets?id=${id}`);
      // For archived/transmitted, allow read-only access — do NOT redirect
      if (data.lockState && data.lockState !== 'NONE') {
        toast.info('Ce bien est verrouillé');
        router.replace('/assets');
        return;
      }
      setAsset(data);
    } catch (error: any) {
      console.error('loadAsset error:', error?.status, error?.code, error?.message, error);
      if (error?.status === 403 || error?.code === 'ASSET_UNAVAILABLE') {
        toast.info('Ce bien n\'est pas accessible');
        router.replace('/assets');
      } else if (error?.status === 404) {
        toast.info('Ce bien n\'existe pas');
        router.replace('/assets');
      } else {
        toast.error(`Erreur (${error?.status ?? 0}): ${error?.code ?? error?.message ?? 'inconnue'}`);
      }
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  // Pre-warm asset + overview cache in parallel as soon as assetId is available in URL
  // This runs before the session finishes loading, so by the time user is ready, data is cached
  useEffect(() => {
    const assetId = parseInt(params.id as string);
    if (!params.id || isNaN(assetId)) return;
    const hasToken = typeof window !== 'undefined' && !!localStorage.getItem('bearer_token');
    if (hasToken) {
      apiClient.get<AssetDetail>(`/api/assets?id=${assetId}`, { useCache: true }).catch(() => {});
      apiClient.get(`/api/assets/${assetId}/overview`, { useCache: true }).catch(() => {});
      apiClient.get(`/api/assets/${assetId}/exports?limit=3`, { useCache: true }).catch(() => {});
    }
  }, [params.id]);

  useEffect(() => {
    if (!isPending && user && params.id) {
      setIsLoading(true);
      loadAsset(parseInt(params.id as string));
    }
  }, [params.id, user, isPending, refreshTrigger]);

  useEffect(() => {
    if (asset) {
      setBreadcrumbs([{ label: 'Mes biens', href: '/assets' }, { label: asset.name }]);
    }
  }, [asset, setBreadcrumbs]);

  const handleRefresh = useCallback(() => {
    apiClient.clearCache();
    setRefreshTrigger(prev => prev + 1);
  }, []);

  const handleArchive = useCallback(async () => {
    if (!asset) return;
    setIsArchiving(true);
    try {
      await apiClient.delete(`/api/assets?id=${asset.id}`);
      toast.success('Bien supprimé');
      apiClient.clearCache();
      router.replace('/assets');
    } catch (err: any) {
      toast.error(err?.message ?? 'Erreur lors de la suppression');
      setIsArchiving(false);
    }
  }, [asset, router]);

  const handleTabChange = useCallback((tab: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.pushState({}, '', url.toString());
  }, []);

  const AssetIcon = useMemo(() =>
    asset ? getAssetIcon(asset.category, asset.subtype ?? undefined, asset.name) : null,
    [asset?.category, asset?.subtype, asset?.name]
  );

  const showRoomsAndEquipments = useMemo(() => asset ? assetSupportsRooms(asset) : false, [asset]);
  const isReadOnly = asset?.status === 'ARCHIVED' || asset?.status === 'TRANSMIS';

  const planType: 'freemium' | 'premium' = useMemo(() => {
    return user?.subscription?.plan === 'STANDARD' ? 'freemium' : 'premium';
  }, [user?.subscription?.plan]);

  const assetId = parseInt(params.id as string);
  const isValidId = !isNaN(assetId);

  // Show header skeleton + start fetching overview in parallel while asset loads
  if (isPending || isLoading || !asset || !AssetIcon) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-4">
          <Skeleton className="w-16 h-16 rounded-lg flex-shrink-0" />
          <div className="flex-1 space-y-2 pt-1">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <Skeleton className="h-9 w-full" />
        {/* Mount the overview tab early so its fetch runs while the header loads */}
        {isValidId && activeTab === 'overview' && (
          <AssetOverviewTab assetId={assetId} onTabChange={handleTabChange} />
        )}
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        {/* Header */}
        {isReadOnly && (
          <div className="rounded-lg bg-muted/50 border border-border px-4 py-2.5 text-sm text-muted-foreground">
            Ce bien est {asset.status === 'TRANSMIS' ? 'transmis' : 'archivé'} — consultation uniquement, sans modification possible.
          </div>
        )}
        <div className="flex items-start gap-4">
          {/* Thumbnail */}
          <button
            type="button"
            onClick={isReadOnly ? undefined : () => setThumbnailDrawerOpen(true)}
            className={`group flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden bg-muted flex items-center justify-center relative focus:outline-none ${isReadOnly ? 'cursor-default' : 'cursor-pointer focus-visible:ring-2 focus-visible:ring-primary'}`}
            title={isReadOnly ? undefined : "Modifier la vignette"}
          >
            {thumbnailLoading && !overrideSignedThumbnail ? (
              <Skeleton className="w-full h-full" />
            ) : (overrideSignedThumbnail ?? thumbnailSignedUrl) ? (
              <img
                src={overrideSignedThumbnail ?? thumbnailSignedUrl!}
                alt={asset.name}
                className="absolute inset-0 w-full h-full object-cover"
              />
            ) : (
              <AssetIcon className="w-8 h-8 text-muted-foreground/40" />
            )}
            {/* Edit overlay */}
            {!isReadOnly && (
              <span className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center z-10">
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 012.828 0l.172.172a2 2 0 010 2.828L12 16H9v-3z" />
                </svg>
              </span>
            )}
          </button>

          {/* Name + meta */}
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold leading-tight">{asset.name}</h1>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-sm text-muted-foreground">
                {CATEGORY_LABELS[asset.category] || asset.category}
                {asset.subtype && ` · ${asset.subtype}`}
              </span>
            </div>
          </div>

        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
          <div className="flex items-center gap-2 min-w-0">
            <AdaptiveTabsList
              tabs={isReadOnly ? [
                { value: 'overview', label: 'Aperçu',       icon: LayoutDashboard },
                { value: 'details',  label: 'Informations', icon: Info },
              ] : [
                { value: 'overview',   label: 'Aperçu',        icon: LayoutDashboard },
                { value: 'details',    label: 'Informations',  icon: Info },
                { value: 'documents',  label: 'Documents',     icon: FileText },
                { value: 'agenda',     label: 'Agenda',        icon: CalendarDays },
                ...(showRoomsAndEquipments ? [
                  { value: 'rooms',       label: 'Pièces',       icon: LayoutGrid },
                  { value: 'equipments',  label: 'Équipements',  icon: Settings },
                ] : []),
                { value: 'exports', label: 'Exports', icon: Download },
              ]}
              activeTab={activeTab}
              onTabChange={handleTabChange}
            />
            <button
              onClick={() => setShowArchiveConfirm(true)}
              className="flex-shrink-0 p-1.5 rounded-md text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors btn-delete"
              title="Supprimer ce bien"
              disabled={isArchiving}
            >
              <Trash2 className="w-4 h-4 btn-delete-trash-icon" />
            </button>
          </div>

          <TabsContent value="overview" className="mt-4">
            <AssetOverviewTab assetId={asset.id} onTabChange={handleTabChange} readOnly={isReadOnly} />
          </TabsContent>

          <TabsContent value="details" className="mt-4">
            <AssetDetailsTab asset={asset} onRefresh={handleRefresh} planType={planType} readOnly={isReadOnly} highlightField={searchParams.get('highlight')} />
          </TabsContent>

          <TabsContent value="documents" className="mt-4">
            <AssetDocumentsTab
              assetId={asset.id}
              assetCategory={asset.category}
              assetName={asset.name}
              assetTypeId={asset.assetTypeId ?? undefined}
              assetTypeSubcategoryId={asset.assetTypeSubcategoryId ?? undefined}
              planType={planType}
            />
          </TabsContent>


          {showRoomsAndEquipments && (
            <>
              <TabsContent value="rooms" className="mt-4">
                <AssetSubstructuresPanel
                  assetId={asset.id}
                  substructures={(asset.substructures ?? []) as any}
                  onRefresh={handleRefresh}
                />
              </TabsContent>

              <TabsContent value="equipments" className="mt-4">
                <AssetEquipmentsPanel
                  assetId={asset.id}
                  assetName={asset.name}
                  equipments={((asset.equipments ?? []).filter((e: any) => !e.archivedAt)) as any}
                  substructures={(asset.substructures ?? []) as any}
                  onRefresh={handleRefresh}
                />
              </TabsContent>
            </>
          )}

          <TabsContent value="agenda" className="mt-4">
            <AssetAgendaTab assetId={asset.id} />
          </TabsContent>

          <TabsContent value="exports" className="mt-4">
            <AssetExportsTab
              assetId={asset.id}
              assetCategory={asset.category}
              assetTypeId={asset.assetTypeId ?? undefined}
              planType={planType}
              thumbnailUrl={asset.thumbnailUrl}
            />
          </TabsContent>
        </Tabs>

      </div>

      {/* Thumbnail editor */}
      <ThumbnailEditDrawer
        open={thumbnailDrawerOpen}
        onClose={() => setThumbnailDrawerOpen(false)}
        assetId={asset.id}
        currentThumbnailUrl={thumbnailSignedUrl ?? null}
        onUpdated={(newThumbnailUrl, signedUrl) => {
          setAsset(prev => prev ? { ...prev, thumbnailUrl: newThumbnailUrl } : prev);
          setOverrideSignedThumbnail(signedUrl);
          setThumbnailDrawerOpen(false);
        }}
      />

      <DeleteAssetDialog
        open={showArchiveConfirm}
        onOpenChange={setShowArchiveConfirm}
        assetName={asset.name}
        onConfirm={(deleteRelated) => {
          setShowArchiveConfirm(false);
          handleArchive();
        }}
      />
    </>
  );
}
