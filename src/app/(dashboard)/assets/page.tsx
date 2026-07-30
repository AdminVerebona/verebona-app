"use client"

import { useState, useEffect, useMemo, useCallback, Suspense } from 'react';
import React from 'react';
import Link from 'next/link';
import { useRouter as useNextRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';


import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { Plus, AlertCircle, Lock, Package, Check, ArrowRight, Loader2, Crown, SlidersHorizontal } from 'lucide-react';


import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/hooks/useSession';
import { useFeatureFlags } from '@/hooks/useFeatureFlags';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { apiClient } from '@/lib/api-client';
import { getAssetIcon, CATEGORY_LABELS } from '@/lib/asset-icons';
import { useThumbnailUrl } from '@/hooks/useThumbnailUrl';

// ⚡ Lazy load AssetFormDialog
const AssetFormDialog = dynamic(
  () => import('@/components/AssetFormDialog').then(mod => ({ default: mod.AssetFormDialog })),
  { ssr: false }
);

interface Asset {
  id: number;
  name: string;
  category: string;
  subtype?: string;
  purchaseDate?: string;
  status: string;
  thumbnailUrl?: string | null;
  lockState?: 'NONE' | 'PENDING_MOVE' | 'PENDING_DELETE';
}

// ⚡ Utility function mémoïsée en dehors du composant
const formatDate = (dateStr?: string) => {
  if (!dateStr) return 'Non renseignée';
  return new Date(dateStr).toLocaleDateString('fr-FR');
};

// ✅ FIXED: Pass onDelete as prop instead of using global variable
const AssetCardWithThumbnail = React.memo(function AssetCardWithThumbnail({
  asset,
  onDelete,
  onLockedClick
}: {
  asset: Asset;
  onDelete: (id: number) => void;
  onLockedClick: () => void;
}) {
  const router = useNextRouter();
  const [isNavigating, setIsNavigating] = useState(false);
  const Icon = getAssetIcon(asset.category, asset.subtype, asset.name);
  const { signedUrl, isLoading: thumbnailLoading } = useThumbnailUrl(asset.id, asset.thumbnailUrl);
  const isInactive = asset.status === 'INACTIF';
  const isArchived = asset.status === 'ARCHIVED' || asset.status === 'TRANSMIS';
  const isLocked = asset.lockState && asset.lockState !== 'NONE';
  const isBlocked = isInactive || isArchived || isLocked;

  const handleMouseEnter = () => {
    // Pre-warm cache on hover so data is ready before click
    const hasToken = typeof window !== 'undefined' && true;
    if (hasToken && !isBlocked) {
      apiClient.get(`/api/assets?id=${asset.id}`, { useCache: true }).catch(() => {});
      apiClient.get(`/api/assets/${asset.id}/overview`, { useCache: true }).catch(() => {});
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (isNavigating) return;
    setIsNavigating(true);
    router.push(`/assets/${asset.id}${isArchived ? '?readonly=1' : ''}`);
  };

  const statusLabel = asset.status === 'EN_SERVICE' ? 'Actif' :
    asset.status === 'VENDU' ? 'Vendu' :
    asset.status === 'EN_PANNE' ? 'En panne' :
    asset.status === 'EN_REPARATION' ? 'En réparation' :
    asset.status === 'DETRUIT' ? 'Détruit' :
    asset.status === 'INACTIF' ? 'Inactif' :
    asset.status === 'TRANSMIS' ? 'Transmis' : 'Archivé';

  const statusVariant: 'active' | 'sold' | 'secondary' =
    asset.status === 'EN_SERVICE' ? 'active' :
    (asset.status === 'VENDU' || asset.status === 'TRANSMIS') ? 'sold' : 'secondary';

  const cardContent = (
    <div className={`relative rounded-2xl overflow-hidden h-64 transform-gpu transition-all duration-300 ${
      isBlocked
        ? 'opacity-60 grayscale cursor-default'
        : 'cursor-pointer hover:scale-[1.02] hover:-translate-y-1 hover:shadow-[0_20px_48px_rgba(0,0,0,0.4)]'
    }`} onMouseEnter={handleMouseEnter}>
      {/* Background: photo or gradient */}
      {thumbnailLoading ? (
        <Skeleton className="absolute inset-0 w-full h-full rounded-2xl" />
      ) : signedUrl ? (
        <img
          src={signedUrl}
          alt={asset.name}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-muted to-muted/60 flex items-center justify-center">
          <Icon className="w-20 h-20 text-muted-foreground/20" />
        </div>
      )}

      {/* Dark overlay gradient — always present for text legibility */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-black/10" />

      {/* Blocked overlays */}
      {isArchived && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/30 backdrop-blur-[2px]">
          <div className="bg-black/70 text-white px-3 py-1.5 rounded-full text-xs font-medium">
            {asset.status === 'TRANSMIS' ? 'Transmis' : 'Archivé'}
          </div>
        </div>
      )}
      {!isArchived && isLocked && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
          <div className="bg-black/70 text-white px-3 py-1.5 rounded-full flex items-center gap-1.5 text-xs font-medium">
            <Lock className="w-3 h-3" />Verrouillé
          </div>
        </div>
      )}
      {!isArchived && !isLocked && isInactive && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
          <div className="bg-black/70 p-2 rounded-full"><Lock className="w-5 h-5 text-white" /></div>
        </div>
      )}

      {/* Content overlay */}
      <div className="absolute inset-0 z-10 flex flex-col justify-between p-4">
        {/* Top: icon + category */}
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-white/15 backdrop-blur-sm flex items-center justify-center">
            <Icon className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-white/80 text-xs font-medium uppercase tracking-wider drop-shadow">
            {CATEGORY_LABELS[asset.category] || asset.category}
            {asset.subtype && ` · ${asset.subtype}`}
          </span>
        </div>

        {/* Bottom: name + meta */}
        <div className="space-y-2">
          <h3 className="text-white font-bold text-xl leading-tight drop-shadow-lg">{asset.name}</h3>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1 text-white/70 text-xs">
              <span>{formatDate(asset.purchaseDate)}</span>
            </div>
            <Badge variant={statusVariant} className="text-[10px] px-2 py-0.5 bg-white/15 backdrop-blur-sm border-white/20 text-white">
              {statusLabel}
            </Badge>
          </div>
        </div>
      </div>

      {/* Navigation loader overlay */}
      {isNavigating && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 backdrop-blur-[1px] rounded-2xl">
          <Loader2 className="w-8 h-8 text-white animate-spin" />
        </div>
      )}
    </div>
  );

  if (isArchived) {
    return (
      <div className="relative group" onClick={handleClick} style={{ cursor: 'pointer' }}>
        {cardContent}
      </div>
    );
  }

  if (isBlocked) {
    return (
      <div onClick={isLocked ? onLockedClick : undefined}>
        {cardContent}
      </div>
    );
  }

  return (
    <div className="relative group" onClick={handleClick}>
      {cardContent}
    </div>
  );
});

function AssetsPageContent() {
  const { setBreadcrumbs } = useBreadcrumb();

  useEffect(() => {
    setBreadcrumbs([{ label: 'Mes biens' }]);
  }, [setBreadcrumbs]);

  const { user, isLoading: isSessionLoading } = useSession({ required: true });
  const { 
    canCreateAsset: checkCanCreateAsset, 
    getRemainingAssets, 
    isOverAssetLimit,
    isStandard,
    isPremium,
    isExpired,
    features,
    isLoading: isFeaturesLoading 
  } = useFeatureFlags();
  
  const [assets, setAssets] = useState<Asset[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pre-warm assets list cache immediately (token available before session resolves)
  useEffect(() => {
    const hasToken = typeof window !== 'undefined' && true;
    if (hasToken) {
      apiClient.get(`/api/assets?limit=100&includeArchived=true`, { useCache: true }).catch(() => {});
    }
  }, []);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [deleteAssetId, setDeleteAssetId] = useState<number | null>(null);
  const [showLimitModal, setShowLimitModal] = useState(false);
  const [showAssetDialog, setShowAssetDialog] = useState(false);
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [pendingShowArchived, setPendingShowArchived] = useState(false);

  // ⚡ Mémoïser loadAssets
  const loadAssets = useCallback(async () => {
    if (!user) return;
    
    try {
      setIsLoading(true);
      setError(null);
      setErrorCode(null);
      
      const data = await apiClient.get<any>(`/api/assets?userId=${user.id}&limit=100&includeArchived=true`, { useCache: true });
      
      const assetsList = Array.isArray(data) ? data : (data.data || []);
      setAssets(assetsList);
    } catch (error: any) {
      console.error('Error loading assets:', error);
      setError('Erreur lors du chargement des données.');
      setErrorCode(error.code || null);
      setAssets([]);
      
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      loadAssets();
    }
  }, [user, loadAssets]);

  const ARCHIVED_STATUSES = ['ARCHIVED', 'TRANSMIS'];

  // Active assets = non archivés/transmis — utilisés pour les compteurs freemium
  const activeAssets = useMemo(
    () => (Array.isArray(assets) ? assets : []).filter(a => !ARCHIVED_STATUSES.includes(a.status)),
    [assets]
  );

  // ⚡ Mémoïser le filtrage
  const filteredAssets = useMemo(() => {
    let filtered = Array.isArray(assets) ? assets : [];

    // Masquer les archivés/transmis par défaut
    if (!showArchived) {
      filtered = filtered.filter(a => !ARCHIVED_STATUSES.includes(a.status));
    }

    if (searchTerm.trim()) {
      const terms = searchTerm.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const STATUS_LABELS_SEARCH: Record<string, string> = {
        EN_SERVICE: 'en service actif', EN_PANNE: 'en panne', EN_REPARATION: 'en réparation',
        VENDU: 'vendu', DETRUIT: 'détruit', INACTIF: 'inactif', ARCHIVED: 'archivé', TRANSMIS: 'transmis',
      };
      filtered = filtered.filter(asset => {
        const haystack = [
          asset.name,
          CATEGORY_LABELS[asset.category] ?? asset.category,
          asset.subtype ?? '',
          STATUS_LABELS_SEARCH[asset.status] ?? asset.status,
        ].join(' ').toLowerCase();
        return terms.every(t => haystack.includes(t));
      });
    }

    if (categoryFilter !== 'all') {
      filtered = filtered.filter(asset => asset.category === categoryFilter);
    }

    return filtered;
  }, [assets, searchTerm, categoryFilter, showArchived]);

  // ⚡ Mémoïser les handlers
  const handleAddAsset = useCallback(() => {
    if (!checkCanCreateAsset(activeAssets.length)) {
      setShowLimitModal(true);
    } else {
      setShowAssetDialog(true);
    }
  }, [checkCanCreateAsset, assets.length]);

  const handleDeleteAsset = useCallback(async (id: number) => {
    try {
      await apiClient.delete(`/api/assets?id=${id}`);
      setAssets(assets.filter(a => a.id !== id));
      setDeleteAssetId(null);
    } catch (error) {
      console.error('Error deleting asset:', error);
    }
  }, [assets]);

  // ✅ FIXED: Use callback to open delete dialog
  const openDeleteDialog = useCallback((id: number) => {
    setDeleteAssetId(id);
  }, []);

  if (isSessionLoading || isLoading || isFeaturesLoading) {
    return (
      <>
        <div className="space-y-6">
          <Skeleton className="h-10 w-64" />
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
          </div>
        </div>
      </>
    );
  }

  if (!user) {
    return null;
  }

  const remaining = getRemainingAssets(activeAssets.length);
  const isOverLimit = isOverAssetLimit(activeAssets.length);

  // Message pour la limite selon les specs V1
  let limitMessage = '';
  if (isExpired && isOverLimit) {
    limitMessage = 'Votre abonnement Premium est expiré. Vous dépassez la limite de 3 biens du plan gratuit. Pour retrouver toutes vos fonctionnalités et ajouter de nouveaux biens, passez à Premium.';
  } else if (isStandard && !checkCanCreateAsset(activeAssets.length)) {
    limitMessage = 'Vous avez atteint la limite de 3 biens du plan gratuit. Supprimez un bien ou passez au plan Premium pour gérer tous vos biens.';
  }

  return (
    <>
      <div className="space-y-6 w-full max-w-full overflow-x-hidden">
        {/* Warning banner si limite dépassée (cas expiration Premium) */}
        {isOverLimit && (
          <Card className="border-destructive bg-destructive/10">
            <CardContent className="py-4">
              <div className="flex flex-col sm:flex-row items-start gap-3">
                <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-destructive font-medium break-words">
                    {limitMessage}
                  </p>
                </div>
                <Button asChild size="sm" variant="destructive" className="w-full sm:w-auto flex-shrink-0">
                  <Link href="/mon-compte/offres">
                    Passer en Premium
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl md:text-3xl font-bold whitespace-nowrap">Mes biens</h1>
            <p className="text-muted-foreground mt-1">
              {activeAssets.length} {activeAssets.length > 1 ? 'biens' : 'bien'}
            </p>
          </div>
          {activeAssets.length > 0 && (
            <div className="flex items-center gap-2 flex-shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPendingShowArchived(showArchived);
                  setFilterDrawerOpen(true);
                }}
                className="btn-filter relative"
              >
                <SlidersHorizontal className="btn-filter-sliders-icon w-4 h-4" />
                Filtres
                {showArchived && (
                  <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[#3b82f6] text-white text-[9px] font-bold flex items-center justify-center">
                    1
                  </span>
                )}
              </Button>
              <Button variant="outline" size="sm" onClick={handleAddAsset} data-guide="create-asset" className="btn-add">
                <Plus className="btn-add-plus-icon w-4 h-4" />
                <span className="hidden sm:inline">Ajouter</span>
              </Button>
            </div>
          )}
        </div>


        {error && (
          <Card className="border-destructive bg-destructive/10">
            <CardContent className="py-3 px-4 flex items-start gap-3">
              <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-destructive">{error}</p>
                {errorCode && (
                  <p className="text-xs text-destructive/70 font-mono mt-0.5">Code : {errorCode}</p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {filteredAssets.length === 0 ? (
          <Card className="border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] rounded-2xl shadow-sm">
            <CardContent className="flex items-center gap-4 py-4 px-5">
              <div className="w-8 h-8 rounded-full bg-[color:var(--accent-soft)] flex items-center justify-center flex-shrink-0">
                <Package className="w-4 h-4 text-[color:var(--accent)]" />
              </div>
              <div>
                <p className="text-sm font-medium text-[color:var(--text-primary)]">Aucun bien pour le moment</p>
                <p className="text-xs text-[color:var(--text-muted)] mt-0.5">Ajoutez votre premier bien pour commencer</p>
              </div>
              <Button onClick={handleAddAsset} className="btn-add px-4 flex-shrink-0 ml-auto">
                <Plus className="btn-add-plus-icon w-4 h-4 mr-2" />
                Ajouter mon premier bien
              </Button>
            </CardContent>
          </Card>
        ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 w-full">
              {filteredAssets.map((asset, idx) => (
                <div key={asset.id} {...(idx === 0 ? { 'data-guide': 'asset-list-most-recent', 'data-asset-id': String(asset.id) } : {})}>
                  <AssetCardWithThumbnail
                    asset={asset}
                    onDelete={openDeleteDialog}
                    onLockedClick={() => setShowLimitModal(true)}
                  />
                </div>
              ))}
            </div>
        )}

        <AlertDialog open={deleteAssetId !== null} onOpenChange={() => setDeleteAssetId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Supprimer ce bien ?</AlertDialogTitle>
              <AlertDialogDescription>
                La suppression est définitive et irréversible. Tous les documents, photos, équipements et événements associés à ce bien seront également supprimés.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Annuler</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteAssetId && handleDeleteAsset(deleteAssetId)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90 btn-delete"
              >
                Supprimer
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Premium upsell modal */}
        <Dialog open={showLimitModal} onOpenChange={setShowLimitModal}>
          <DialogContent className="p-0 overflow-hidden sm:max-w-md border-0">
            {/* Header gradient */}
            <div className="relative px-6 pt-8 pb-6 text-center" style={{ background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e3a5f 100%)' }}>
              <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'radial-gradient(circle at 30% 20%, #6366f1 0%, transparent 50%), radial-gradient(circle at 70% 80%, #3b82f6 0%, transparent 50%)' }} />
              <div className="relative z-10">
                <div className="w-14 h-14 rounded-2xl mx-auto mb-4 flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #6366f1, #3b82f6)' }}>
                  <Crown className="w-7 h-7 text-white" />
                </div>
                <h2 className="text-xl font-bold text-white mb-1">
                  {isExpired ? 'Abonnement expiré' : 'Limite atteinte'}
                </h2>
                <p className="text-sm text-white/70">
                  {isExpired
                    ? 'Renouvelez pour retrouver tous vos biens'
                    : 'Vous avez utilisé vos 3 biens gratuits'}
                </p>
              </div>
            </div>

            {/* Body */}
            <div className="px-6 py-5 space-y-4 bg-[color:var(--bg-card)]">
              <p className="text-sm text-muted-foreground text-center">
                Passez à <strong className="text-foreground">Premium</strong> pour gérer un nombre illimité de biens et débloquer toutes les fonctionnalités.
              </p>

              <div className="space-y-2.5">
                {[
                  'Tout Standard inclus',
                  'Biens et documents illimités',
                  'Rappels avancés',
                  'Export PDF',
                ].map((text) => (
                  <div key={text} className="flex items-center gap-3 text-sm">
                    <div className="w-6 h-6 rounded-full bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                      <Check className="w-3.5 h-3.5 text-blue-500" />
                    </div>
                    <span className="text-foreground/80">{text}</span>
                  </div>
                ))}
              </div>

              <div className="pt-1 space-y-2">
                <Link
                  href="/mon-compte/offres"
                  onClick={() => setShowLimitModal(false)}
                  className="flex items-center justify-center gap-2 w-full py-3 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98]"
                  style={{ background: 'linear-gradient(135deg, #6366f1, #3b82f6)' }}
                >
                  <Crown className="w-4 h-4" />
                  Passer à Premium
                  <ArrowRight className="w-4 h-4" />
                </Link>
                <button
                  onClick={() => setShowLimitModal(false)}
                  className="w-full py-2.5 rounded-xl text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Continuer sans Premium
                </button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* ⚡ Dialog chargé uniquement quand showAssetDialog est true */}
        {showAssetDialog && user?.id && (
            <AssetFormDialog
              open={showAssetDialog}
              onOpenChange={setShowAssetDialog}
              onSuccess={loadAssets}
              userId={user.id}
            />
          )}
        </div>

        {/* Filter Drawer */}
        <Sheet open={filterDrawerOpen} onOpenChange={setFilterDrawerOpen}>
          <SheetContent side="right" className="w-80 flex flex-col p-0">
            <SheetHeader className="px-5 py-4 border-b">
              <SheetTitle>Filtres</SheetTitle>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="py-4">
                <p className="text-sm font-semibold mb-3">Statut des biens</p>
                <label className="flex items-center gap-3 cursor-pointer group">
                  <div
                    className={[
                      'w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors',
                      pendingShowArchived ? 'bg-[#3b82f6] border-[#3b82f6]' : 'border-muted-foreground/40 group-hover:border-[#3b82f6]/60',
                    ].join(' ')}
                    onClick={() => setPendingShowArchived(!pendingShowArchived)}
                  >
                    {pendingShowArchived && (
                      <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  <span className="text-sm text-foreground" onClick={() => setPendingShowArchived(!pendingShowArchived)}>
                    Afficher les biens transmis/archivés
                  </span>
                </label>
              </div>
            </div>

            <div className="px-5 py-4 border-t space-y-2">
              <Button
                className="w-full"
                onClick={() => {
                  setShowArchived(pendingShowArchived);
                  setFilterDrawerOpen(false);
                }}
              >
                Appliquer
              </Button>
              <button
                onClick={() => setPendingShowArchived(false)}
                className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors py-1"
              >
                Réinitialiser
              </button>
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
}

export default function AssetsPage() {
  return (
    <Suspense fallback={
      <>
        <div className="space-y-6">
          <Skeleton className="h-10 w-64" />
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
          </div>
        </div>
      </>
    }>
      <AssetsPageContent />
    </Suspense>
  );
}
