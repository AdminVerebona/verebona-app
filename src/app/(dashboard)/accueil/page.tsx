"use client"

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Plus, Package, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AssetCard } from '@/components/dashboard/AssetCard';
import { AssetLimitReachedDialog } from '@/components/premium/AssetLimitReachedDialog';
import { PendingCheckoutModal } from '@/components/subscription/PendingCheckoutModal';
import { SituationMessage } from '@/components/home/SituationMessage';
import { ATfaireBlock } from '@/components/home/ATfaireBlock';
import { ProchainsDatesBlock } from '@/components/home/ProchainsDatesBlock';
import { ASavoirBlock } from '@/components/home/ASavoirBlock';
import { ActiviteRecenteBlock } from '@/components/home/ActiviteRecenteBlock';
import { EnrichissementAutomatiqueBlock } from '@/components/home/EnrichissementAutomatiqueBlock';
import { useSession } from '@/hooks/useSession';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { useRouter } from 'next/navigation';
import type { HomeSummaryPayload, HomeItem } from '@/services/home/HomeSummaryService';

// ⚡ Lazy load des dialogs lourds
const UnifiedDocumentDialog = dynamic(
  () => import('@/components/documents/unified-document-dialog').then(mod => ({ default: mod.UnifiedDocumentDialog })),
  { ssr: false }
);

const AssetFormDialog = dynamic(
  () => import('@/components/AssetFormDialog').then(mod => ({ default: mod.AssetFormDialog })),
  { ssr: false }
);

const DocumentDrawer = dynamic(
  () => import('@/components/assets/DocumentDrawer').then(mod => ({ default: mod.DocumentDrawer })),
  { ssr: false }
);

const AgendaItemDrawer = dynamic(
  () => import('@/components/agenda/AgendaItemDrawer').then(m => ({ default: m.AgendaItemDrawer })),
  { ssr: false }
);

const CreateAgendaItemDrawer = dynamic(
  () => import('@/components/agenda/CreateAgendaItemDrawer').then(m => ({ default: m.CreateAgendaItemDrawer })),
  { ssr: false }
);

// ── Types locaux ──────────────────────────────────────────────────────────────

interface DrawerDocState {
  id: number;
  originalFilename: string;
  mimeType: string;
  documentType: string;
  documentDate: string | null;
  uploadedAt: string | null;
  size?: number;
  assetId: number;
}

export default function DashboardPage() {
  const router = useRouter();
  const { user, isLoading: isSessionLoading } = useSession({ required: true });
  const { setBreadcrumbs } = useBreadcrumb();

  const [summary, setSummary] = useState<HomeSummaryPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingCheckoutPlan, setPendingCheckoutPlan] = useState<'premium' | 'premium_duo' | null>(null);

  // Dialogs
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [showAssetDialog, setShowAssetDialog] = useState(false);
  const [showAssetLimitDialog, setShowAssetLimitDialog] = useState(false);

  // Drawers
  const [drawerDoc, setDrawerDoc] = useState<DrawerDocState | null>(null);
  const [drawerDocOpen, setDrawerDocOpen] = useState(false);
  const [drawerAgendaItem, setDrawerAgendaItem] = useState<any | null>(null);
  const [drawerAgendaOpen, setDrawerAgendaOpen] = useState(false);
  const [drawerAgendaInitialMode, setDrawerAgendaInitialMode] = useState<'view' | 'edit'>('view');
  const [showCreateAgenda, setShowCreateAgenda] = useState(false);

  // ── Chargement ────────────────────────────────────────────────────────────

  const loadSummary = useCallback(async () => {
    try {
      const data = await apiClient.get<HomeSummaryPayload>('/api/home/summary', { useCache: true });
      setSummary(data);
    } catch (error) {
      console.error('Error loading home summary:', error);
      toast.error('Erreur lors du chargement');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  // Lance le fetch immédiatement si un token existe, sans attendre la résolution de la session.
  // Si le token est expiré, l'API retournera 401 et l'api-client déclenchera le refresh normal.
  useEffect(() => {
    const hasToken = typeof window !== 'undefined' && !!localStorage.getItem('bearer_token');
    if (hasToken) loadSummary();
  }, [loadSummary]);

  // Re-fetch sur événements — invalide le cache avant de recharger
  useEffect(() => {
    const handler = () => {
      apiClient.invalidateCache('/api/home/summary');
      loadSummary();
    };
    window.addEventListener('document-added', handler);
    window.addEventListener('document-deleted', handler);
    window.addEventListener('document-analysis-complete', handler);
    window.addEventListener('agenda-mutated', handler);
    window.addEventListener('notifications-refresh', handler);
    window.addEventListener('refresh-a-traiter', handler);
    return () => {
      window.removeEventListener('document-added', handler);
      window.removeEventListener('document-deleted', handler);
      window.removeEventListener('document-analysis-complete', handler);
      window.removeEventListener('agenda-mutated', handler);
      window.removeEventListener('notifications-refresh', handler);
      window.removeEventListener('refresh-a-traiter', handler);
    };
  }, [loadSummary]);

  // Synchronisation Stripe à la volée si session_id est présent
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    if (!sessionId) return;

    const syncPayment = async () => {
      try {
        const token = localStorage.getItem('bearer_token');
        // Forcer la synchronisation avec l'API
        const res = await fetch(`/api/billing/me?session_id=${encodeURIComponent(sessionId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          // Rafraîchir le JWT token pour que middleware.ts l'accepte lors des prochaines navigations
          const refreshRes = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
          if (refreshRes.ok) {
            const refreshData = await refreshRes.json();
            if (refreshData.accessToken) {
              localStorage.setItem('bearer_token', refreshData.accessToken);
              // Récupérer et mettre à jour le profil de l'utilisateur
              const userRes = await fetch('/api/users/me', {
                headers: { Authorization: `Bearer ${refreshData.accessToken}` },
              });
              if (userRes.ok) {
                const userData = await userRes.json();
                localStorage.setItem('user', JSON.stringify(userData));
              }
            }
          }
        }
      } catch (err) {
        console.error('[Accueil Sync] Failed to sync payment:', err);
      } finally {
        // Nettoyer l'URL
        const newUrl = window.location.pathname;
        window.history.replaceState({}, '', newUrl);
        // Recharger l'état de la page
        window.location.reload();
      }
    };

    syncPayment();
  }, []);

  // Pending checkout
  useEffect(() => {
    const currentPlan = (user?.subscription?.plan || '').toUpperCase();
    if (!user || currentPlan !== 'STANDARD') return;
    const p = localStorage.getItem('pending_checkout_plan');
    if (p === 'premium' || p === 'premium_duo' || p === 'duo') {
      const normalized = p === 'duo' ? 'premium_duo' : p as 'premium' | 'premium_duo';
      setPendingCheckoutPlan(normalized);
    }
  }, [user]);

  // Transfer token
  useEffect(() => {
    if (!user) return;
    const transferToken = localStorage.getItem('pending_transfer_token');
    if (!transferToken) return;
    localStorage.removeItem('pending_transfer_token');
    fetch(`/api/transmission/${transferToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept' }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          toast.success('Un bien vous a été transmis et ajouté à votre portefeuille !');
          loadSummary();
        }
      })
      .catch(() => {});
  }, [user, loadSummary]);

  // ── Handlers items ────────────────────────────────────────────────────────

  const handleItemClick = useCallback(async (item: HomeItem) => {
    if (item.objectType === 'document') {
      try {
        const doc = await apiClient.get<any>(`/api/files/${item.objectId}`);
        setDrawerDoc({
          id: item.objectId,
          originalFilename: doc.originalFilename ?? item.title,
          mimeType: doc.mimeType ?? 'application/octet-stream',
          documentType: doc.documentType ?? 'AUTRE',
          documentDate: doc.documentDate ?? null,
          uploadedAt: doc.uploadedAt ?? null,
          size: doc.size,
          assetId: doc.assetId ?? 0,
        });
        setDrawerDocOpen(true);
      } catch {
        toast.error('Impossible d\'ouvrir le document');
      }
    } else if (item.objectType === 'agenda') {
      try {
        const data = await apiClient.get<{ item: any }>(`/api/agenda/${item.objectId}`);
        setDrawerAgendaItem(data.item);
        setDrawerAgendaInitialMode(item.reason === 'missing_date' ? 'edit' : 'view');
        setDrawerAgendaOpen(true);
      } catch {
        toast.error('Impossible d\'ouvrir l\'élément d\'agenda');
      }
    } else if (item.objectType === 'asset' && item.reason === 'coherence_alert') {
      const params = new URLSearchParams();
      params.set('tab', 'details');
      if (item.fieldKey) params.set('highlight', item.fieldKey);
      router.push(`/assets/${item.objectId}?${params.toString()}`);
    }
  }, []);

  const handleAssetLimitReached = useCallback(() => {
    setShowAssetDialog(false);
    setShowAssetLimitDialog(true);
  }, []);

  // ── Loading ───────────────────────────────────────────────────────────────

  if (isSessionLoading || isLoading) {
    return (
      <div className="space-y-6 w-full max-w-full pb-12">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-72 mt-1" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            {[...Array(2)].map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-14 w-full rounded-xl" />
          </div>
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-20" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-56 rounded-2xl" />)}
          </div>
        </div>
      </div>
    );
  }

  if (!user) return null;

  const assets = summary?.assets.items ?? [];
  const totalAssets = summary?.assets.total ?? 0;
  const isEmpty = summary?.situation.status === 'empty';

  return (
    <>
      <div className="space-y-6 w-full max-w-full overflow-x-hidden pb-12">

        {/* Message de situation */}
        {summary && (
          <SituationMessage
            situation={summary.situation}
            userName={user.username || user.firstName}
          />
        )}


        {/* Bloc À faire */}
        {summary && !isEmpty && (
          <ATfaireBlock
            items={summary.blocks.todo.items}
            total={summary.blocks.todo.total}
            onItemClick={handleItemClick}
          />
        )}

        {/* Prochaines dates + À savoir — 2 colonnes sur desktop */}
        {summary && !isEmpty && (
          summary.blocks.upcoming.total > 0 || summary.blocks.toKnow.items.length > 0
        ) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <ProchainsDatesBlock
              items={summary.blocks.upcoming.items}
              total={summary.blocks.upcoming.total}
              onItemClick={handleItemClick}
            />
            <ASavoirBlock items={summary.blocks.toKnow.items} />
          </div>
        )}

        {/* Bloc Mes biens */}
        <div className="w-full">
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs font-semibold uppercase tracking-widest text-[color:var(--text-muted)]">
              Mes biens
            </span>
            {totalAssets > 4 && (
              <Link
                href="/assets"
                className="flex items-center gap-1 text-xs text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors"
              >
                Tout afficher
                <ChevronRight className="w-3 h-3" />
              </Link>
            )}
          </div>

          {assets.length === 0 ? (
            <Card className="border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] rounded-2xl shadow-sm">
              <CardContent className="flex flex-col sm:flex-row sm:items-center gap-4 py-4 px-5">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-8 h-8 rounded-full bg-[color:var(--accent-soft)] flex items-center justify-center flex-shrink-0">
                    <Package className="w-4 h-4 text-[color:var(--accent)]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[color:var(--text-primary)]">
                      Aucun bien pour le moment
                    </p>
                    <p className="text-xs text-[color:var(--text-muted)] mt-0.5">
                      Ajoutez votre premier bien pour commencer
                    </p>
                  </div>
                </div>
                <Button
                  onClick={() => setShowAssetDialog(true)}
                  className="btn-add px-4 w-full sm:w-auto flex-shrink-0"
                >
                  <Plus className="btn-add-plus-icon w-4 h-4 mr-2" />
                  Ajouter mon premier bien
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4 w-full">
              {assets.map((asset, idx) => (
                <AssetCard
                  key={asset.id}
                  id={asset.id}
                  name={asset.name}
                  category={asset.category}
                  subtype={asset.subtype ?? undefined}
                  status={asset.status ?? undefined}
                  thumbnailUrl={asset.thumbnailUrl}
                  signedThumbnailUrl={asset.signedThumbnailUrl}
                  documentCount={asset.documentCount}
                  documentLabels={asset.documentLabels}
                  priority={idx < 2}
                  todoCount={asset.todoCount}
                  nextDate={asset.nextDate}
                  nextDateTitle={asset.nextDateTitle}
                />
              ))}
            </div>
          )}
        </div>

        {/* Activité récente + Enrichissement automatique — 2 colonnes desktop */}
        {summary && (() => {
          const isStandard = user?.subscription?.plan === 'STANDARD';
          const hasActivity = summary.blocks.recentActivity.items.length > 0;
          const hasEvents = summary.blocks.autoEnrichment.events.length > 0;
          const showEnrich = !isEmpty && hasEvents;

          if (!hasActivity && !showEnrich) return null;

          return (
            <div className={`grid grid-cols-1 gap-6 ${hasActivity && showEnrich ? 'md:grid-cols-2' : ''}`}>
              {hasActivity && (
                <ActiviteRecenteBlock
                  items={summary.blocks.recentActivity.items}
                  onItemClick={handleItemClick}
                />
              )}
              {showEnrich && (
                  <EnrichissementAutomatiqueBlock
                    events={summary.blocks.autoEnrichment.events}
                    locked={false}
                  />
              )}
            </div>
          );
        })()}

      </div>

      {/* ── Dialogs ─────────────────────────────────────────────────────────── */}

      {showUploadDialog && (
        <UnifiedDocumentDialog
          open={showUploadDialog}
          onOpenChange={setShowUploadDialog}
          availableAssets={assets.map(a => ({ id: a.id, name: a.name }))}
          onSuccess={loadSummary}
        />
      )}

      {showAssetDialog && user?.id && (
        <AssetFormDialog
          open={showAssetDialog}
          onOpenChange={setShowAssetDialog}
          onSuccess={loadSummary}
          onLimitReached={handleAssetLimitReached}
          userId={user.id}
        />
      )}

      <AssetLimitReachedDialog
        open={showAssetLimitDialog}
        onOpenChange={setShowAssetLimitDialog}
      />

      {pendingCheckoutPlan && (
        <PendingCheckoutModal
          plan={pendingCheckoutPlan}
          onDismiss={() => {
            localStorage.removeItem('pending_checkout_plan');
            setPendingCheckoutPlan(null);
          }}
        />
      )}

      {/* Drawer document */}
      {drawerDoc && (
        <DocumentDrawer
          open={drawerDocOpen}
          onOpenChange={(v) => {
            setDrawerDocOpen(v);
            if (!v) {
              setDrawerDoc(null);
            }
          }}
          document={drawerDoc}
          onRefresh={() => {
            apiClient.invalidateCache('/api/home/summary');
            loadSummary();
          }}
        />
      )}

      {/* Drawer agenda */}
      {drawerAgendaItem && (
        <AgendaItemDrawer
          item={drawerAgendaItem}
          open={drawerAgendaOpen}
          initialMode={drawerAgendaInitialMode}
          onClose={() => {
            setDrawerAgendaOpen(false);
            setDrawerAgendaItem(null);
            loadSummary();
          }}
          onMutated={() => {
            setDrawerAgendaOpen(false);
            setDrawerAgendaItem(null);
            loadSummary();
          }}
          onOpenDocument={(fileId) => {
            setDrawerAgendaOpen(false);
            setDrawerAgendaItem(null);
            window.dispatchEvent(new CustomEvent('open-document-drawer', { detail: { docId: fileId } }));
          }}
        />
      )}

      <CreateAgendaItemDrawer
        open={showCreateAgenda}
        onClose={() => setShowCreateAgenda(false)}
        onMutated={() => {
          setShowCreateAgenda(false);
          loadSummary();
        }}
      />
    </>
  );
}
