"use client"

/**
 * Accueil — Direction D v2 « La mascotte » (§2 à §4, §12ter).
 *
 * Ordre (décision produit) : la mascotte parle, Mes biens, puis
 * [Ce que j'ai fait | Prochaines échéances] côte à côte si la place le
 * permet (empilés sinon, échéances d'abord), et Documents récents. Plus de cartes
 * statistiques : le seul chiffre conservé est la pastille « À traiter » de
 * la navigation. Le champ Verebona est dans le header (coquille).
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import type { WriteBlockedInfo } from '@/lib/write-blocked';
import { PendingCheckoutModal } from '@/components/subscription/PendingCheckoutModal';
import { MascotSpeaks } from '@/components/home/MascotSpeaks';
import { HomeAssets, RecentDocuments, UpcomingEvents, VerebonaWork } from '@/components/home/HomeBlocks';
import { useSession } from '@/hooks/useSession';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { FRESH_HEADER, markAccountDataMutated, mutatedSince } from '@/lib/data-freshness';
import { useRouter } from 'next/navigation';
import { duoJoinErrorMessage, joinDuo, takePendingDuoJoin } from '@/lib/duo/pending-duo-join';
import type { HomeSummaryPayload } from '@/services/home/HomeSummaryService';
import { orderByRecentViews, readRecentAssetIds } from '@/lib/home/recent-assets';
import { suggestionsForRoute } from '@/services/verebona-assistant/registries/capability-registry';

// ⚡ Lazy load des dialogs lourds
const UnifiedDocumentDialog = dynamic(
  () => import('@/components/documents/unified-document-dialog').then(mod => ({ default: mod.UnifiedDocumentDialog })),
  { ssr: false }
);

const AssetFormDialog = dynamic(
  () => import('@/components/AssetFormDialog').then(mod => ({ default: mod.AssetFormDialog })),
  { ssr: false }
);

/**
 * Instant du dernier chargement du résumé, conservé entre deux visites de
 * l'accueil (navigation client) : une modification faite ailleurs depuis
 * déclenche un résumé frais. Voir `lib/data-freshness.ts`.
 */
let lastHomeSummaryLoadAt = 0;

export default function DashboardPage() {
  const router = useRouter();
  const { user, isLoading: isSessionLoading } = useSession({ required: true });
  const { setBreadcrumbs } = useBreadcrumb();

  const [summary, setSummary] = useState<HomeSummaryPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingCheckoutPlan, setPendingCheckoutPlan] = useState<'premium' | 'premium_duo' | null>(null);

  // Dialogs
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  // Bien présélectionné quand l'ajout vient d'une action mascotte (ONB-DOC).
  const [uploadAssetId, setUploadAssetId] = useState<number | null>(null);
  const [showAssetDialog, setShowAssetDialog] = useState(false);
  // Refus d'ajout d'un bien : même fenêtre que partout ailleurs (motif serveur).
  const { signalerRefus } = useWriteGuard();

  // Biens consultés sur cet appareil (« Récemment consultés », §3.3).
  const [recentIds, setRecentIds] = useState<number[]>([]);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setRecentIds(readRecentAssetIds()); setHydrated(true); }, []);

  // ── Chargement ────────────────────────────────────────────────────────────

  // Plus de cache client sur le résumé : il masquait toute action faite sur
  // une autre page (jusqu'à 5 min). Un résumé frais est demandé au serveur
  // dès qu'une modification a eu lieu depuis le dernier chargement.
  const loadSummary = useCallback(async () => {
    try {
      const startedAt = Date.now();
      const fresh = mutatedSince(lastHomeSummaryLoadAt);
      const data = await apiClient.get<HomeSummaryPayload>('/api/home/summary', {
        headers: fresh ? { [FRESH_HEADER]: '1' } : undefined,
      });
      lastHomeSummaryLoadAt = startedAt;
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
  useEffect(() => {
    const hasToken = typeof window !== 'undefined' && true;
    if (hasToken) loadSummary();
  }, [loadSummary]);

  /** Après une action : l'état a changé, on recharge un résumé frais. */
  const refreshSummary = useCallback(() => {
    markAccountDataMutated();
    void loadSummary();
  }, [loadSummary]);

  // Re-fetch sur événements (la modification est notée par data-freshness)
  useEffect(() => {
    const handler = () => refreshSummary();
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
  }, [refreshSummary]);

  // Synchronisation Stripe à la volée si session_id est présent
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    if (!sessionId) return;

    const syncPayment = async () => {
      try {
        const res = await fetch(`/api/billing/me?session_id=${encodeURIComponent(sessionId)}`, {
          credentials: 'include',
        });
        if (res.ok) {
          const refreshRes = await fetch('/api/auth/refresh', {
            credentials: 'include',
            method: 'POST',
          });
          if (refreshRes.ok) {
            const refreshData = await refreshRes.json();
            if (refreshData.accessToken) {
              const userRes = await fetch('/api/users/me', {
                credentials: 'include',
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
        const newUrl = window.location.pathname;
        window.history.replaceState({}, '', newUrl);
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

  // Invitation Premium Duo mémorisée avant l'inscription : l'invité est
  // rattaché dès sa première arrivée sur l'accueil, sans repasser par le lien.
  useEffect(() => {
    if (!user) return;
    const duoToken = takePendingDuoJoin();
    if (!duoToken) return;
    void joinDuo(duoToken).then((result) => {
      if (result.ok) {
        toast.success('Vous avez rejoint l’espace Premium Duo.');
        loadSummary();
      } else {
        toast.error(duoJoinErrorMessage(result.error));
      }
    });
  }, [user, loadSummary]);

  // Transfer token
  useEffect(() => {
    if (!user) return;
    const transferToken = localStorage.getItem('pending_transfer_token');
    if (!transferToken) return;
    localStorage.removeItem('pending_transfer_token');
    fetch(`/api/transmission/${transferToken}`, {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept' }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          toast.success('Un bien vous a été transmis et ajouté à votre portefeuille !');
          loadSummary();
        } else if (data.error === 'RECIPIENT_EMAIL_MISMATCH' || data.conflict) {
          // L'acceptation est faite par la session, et seulement si son
          // adresse est celle invitée. Un refus (autre adresse, doublon) est
          // dit, pas avalé : sinon le destinataire attend un bien qui ne
          // viendra pas. Le lien reçu par e-mail reste utilisable.
          toast.error(data.message ?? 'La transmission n’a pas pu être acceptée automatiquement. Rouvrez le lien reçu par e-mail.');
        }
      })
      .catch(() => {});
  }, [user, loadSummary]);

  // ⚠️ L'ancienne fenêtre locale annonçait « limite de 3 biens du plan
  // gratuit » et « Passer à Premium » quel que soit le motif — y compris pour
  // un compte recréé dont l'essai était déjà consommé. Le refus serveur
  // (fin d'essai, quota, abonnement) est désormais affiché tel quel.
  const handleAssetLimitReached = useCallback((info: WriteBlockedInfo) => {
    setShowAssetDialog(false);
    signalerRefus(info);
  }, [signalerRefus]);

  const pageSuggestions = useMemo(() => suggestionsForRoute('/accueil').map((x) => x.label), []);
  const orderedAssets = useMemo(
    () => orderByRecentViews(summary?.assets.items ?? [], recentIds),
    [summary, recentIds],
  );

  // Premier rendu identique au serveur (squelette) : l'utilisateur en cache
  // n'est lu qu'après l'hydratation.
  if (!hydrated || isSessionLoading || !user) {
    if (hydrated && !isSessionLoading && !user) return null;
    return (
      <div className="flex flex-col gap-6 px-4 pt-2.5 md:gap-9 md:px-10 md:pt-8">
        <div className="flex items-end gap-4">
          <Skeleton className="h-[88px] w-[96px] rounded-full md:h-[136px] md:w-[136px]" />
          <Skeleton className="h-40 flex-1 rounded-[28px]" />
        </div>
      </div>
    );
  }

  // Compte vide (§12ter) : aucun bien, aucun document.
  const isEmpty = !!summary && summary.assets.total === 0 && summary.documents.total === 0;
  // Salutation : le nom d'utilisateur par défaut ; le prénom seulement s'il
  // n'a pas été choisi (2 oct. 2026).
  const greetingName = user.username?.trim() || user.firstName || '';

  return (
    <>
      <div className="vb-home-halo flex min-h-full flex-col gap-[26px] px-4 pb-36 pt-2.5 md:gap-9 md:px-10 md:pb-10 md:pt-8">
        {/* 1. La mascotte parle — sa prise de parole a son propre chargement
            (GET /api/home/mascot) et ne retarde pas le reste de la page. */}
        <MascotSpeaks
          greetingName={greetingName}
          empty={isEmpty}
          pageSuggestions={pageSuggestions}
          onCreateAsset={() => setShowAssetDialog(true)}
          onUploadDocument={(assetId) => { setUploadAssetId(assetId ?? null); setShowUploadDialog(true); }}
        />

        {isLoading || !summary ? (
          <div className="flex flex-col gap-6 md:gap-8" aria-busy="true">
            <div className="grid grid-cols-3 gap-3" style={{ gridAutoRows: '132px' }}>
              <Skeleton className="row-span-2 rounded-[18px]" />
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="rounded-[18px]" />)}
            </div>
            <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 rounded-2xl" />)}</div>
          </div>
        ) : (
          /* ══════════════════════════════════════════════════════════════
             ORDRE (décision produit, lot 8c)
             Mascotte → Mes biens (bento du lot 8) → [Ce que j'ai fait |
             Prochaines échéances] → Documents récents.
             La paire se place côte à côte selon la largeur DISPONIBLE du
             contenu (requête de conteneur, ≥ 1040 px), et non selon l'écran :
             menu déplié ou replié, la décision suit la place réelle. En
             dessous (tablette, bureau étroit, mobile), elle s'empile, les
             échéances d'abord, comme sur mobile.
             ══════════════════════════════════════════════════════════════ */
          <div className="@container flex flex-col gap-[26px] md:gap-9">
            <HomeAssets assets={orderedAssets} onAddAsset={() => setShowAssetDialog(true)} />
            <div className="flex flex-col gap-[26px] md:gap-9 @min-[1040px]:grid @min-[1040px]:grid-cols-2 @min-[1040px]:items-start @min-[1040px]:gap-8">
              <VerebonaWork className="order-2 @min-[1040px]:order-none" items={summary.blocks.verebonaWork?.items ?? []} onNavigate={(href) => router.push(href)} />
              <UpcomingEvents className="order-1 @min-[1040px]:order-none" items={summary.blocks.upcoming?.items ?? []} />
            </div>
            <RecentDocuments
              docs={summary.blocks.recentDocuments?.items ?? []}
              onUpload={() => { setUploadAssetId(null); setShowUploadDialog(true); }}
            />
          </div>
        )}
      </div>

      {/* ── Parcours existants ─────────────────────────────────────────────── */}

      {showUploadDialog && (
        <UnifiedDocumentDialog
          open={showUploadDialog}
          onOpenChange={(open) => { setShowUploadDialog(open); if (!open) setUploadAssetId(null); }}
          preselectedAssetId={uploadAssetId ?? undefined}
          availableAssets={orderedAssets.map(a => ({ id: a.id, name: a.name }))}
          onSuccess={refreshSummary}
        />
      )}

      {showAssetDialog && user?.id && (
        <AssetFormDialog
          open={showAssetDialog}
          onOpenChange={setShowAssetDialog}
          onSuccess={refreshSummary}
          onLimitReached={handleAssetLimitReached}
          userId={user.id}
        />
      )}

      {pendingCheckoutPlan && (
        <PendingCheckoutModal
          plan={pendingCheckoutPlan}
          onDismiss={() => {
            localStorage.removeItem('pending_checkout_plan');
            setPendingCheckoutPlan(null);
          }}
        />
      )}
    </>
  );
}
