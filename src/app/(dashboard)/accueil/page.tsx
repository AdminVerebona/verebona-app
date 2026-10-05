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
import { MascotSpeaks } from '@/components/home/MascotSpeaks';
import { HomeAssets, RecentDocuments, UpcomingEvents, VerebonaWork } from '@/components/home/HomeBlocks';
import { useSession } from '@/hooks/useSession';
import { apiClient } from '@/lib/api-client';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { toast } from 'sonner';
import { markAccountDataMutated } from '@/lib/data-freshness';
import { useRouter } from 'next/navigation';
import { duoJoinErrorMessage, joinDuo, takePendingDuoJoin } from '@/lib/duo/pending-duo-join';
import { useHomeSummary } from '@/components/home/useHomeSummary';
// Mêmes chunks et même préchargement que le panneau « Ajouter » (APP-PERF-05).
import { LazyAssetFormDialog as AssetFormDialog, LazyUnifiedDocumentDialog as UnifiedDocumentDialog } from '@/components/mobile/add-forms';
import { orderByRecentViews, readRecentAssetIds } from '@/lib/home/recent-assets';
import { suggestionsForRoute } from '@/services/verebona-assistant/registries/capability-registry';

// Fenêtre affichée seulement après un retour de paiement interrompu : son
// code n'a rien à faire dans le chargement initial de l'accueil.
const PendingCheckoutModal = dynamic(
  () => import('@/components/subscription/PendingCheckoutModal').then(mod => ({ default: mod.PendingCheckoutModal })),
  { ssr: false }
);

export default function DashboardPage() {
  const router = useRouter();
  const { user, isLoading: isSessionLoading } = useSession({ required: true });
  const { setBreadcrumbs } = useBreadcrumb();

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

  // Lancé dès le montage, sans attendre la résolution de la session : le
  // résumé et la session partent en parallèle. Les événements métier
  // (document, agenda, « À traiter »…) sont écoutés par le hook et
  // REGROUPÉS : une action qui en émet plusieurs ne coûte qu'une relecture,
  // et une réponse plus ancienne n'écrase jamais une plus récente
  // (APP-PERF-09). Un résumé frais n'est demandé qu'après une modification.
  const { summary, status, refreshing, refreshError, invalidate, retry } = useHomeSummary();

  useEffect(() => {
    setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  /** Après une action : l'état a changé, on relit un résumé frais (regroupé). */
  const refreshSummary = useCallback(() => {
    markAccountDataMutated();
    invalidate();
  }, [invalidate]);

  // Synchronisation Stripe à la volée si session_id est présent
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    if (!sessionId) return;

    // Retour de paiement : constat côté serveur, puis renouvellement du jeton
    // (offre à jour dans la session). Le rechargement complet ci-dessous est
    // le rafraîchissement explicite : session (`SessionProvider`) et droits
    // (`EntitlementsProvider`) sont relus une fois, par leurs fournisseurs —
    // plus de lecture directe de `/api/users/me` ni de copie locale ici.
    const syncPayment = async () => {
      try {
        await apiClient.get(`/api/billing/me?session_id=${encodeURIComponent(sessionId)}`, {
          onAuthFailure: 'silent',
        });
        await apiClient.refreshToken();
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
        refreshSummary();
      } else {
        toast.error(duoJoinErrorMessage(result.error));
      }
    });
  }, [user, refreshSummary]);

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
          refreshSummary();
        } else if (data.error === 'RECIPIENT_EMAIL_MISMATCH' || data.conflict) {
          // L'acceptation est faite par la session, et seulement si son
          // adresse est celle invitée. Un refus (autre adresse, doublon) est
          // dit, pas avalé : sinon le destinataire attend un bien qui ne
          // viendra pas. Le lien reçu par e-mail reste utilisable.
          toast.error(data.message ?? 'La transmission n’a pas pu être acceptée automatiquement. Rouvrez le lien reçu par e-mail.');
        }
      })
      .catch(() => {});
  }, [user, refreshSummary]);

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

        {status === 'error' && !summary ? (
          /* Erreur sans données : état explicite et reprise, jamais un
             squelette permanent (APP-PERF-39). La mascotte, au-dessus, a son
             propre chargement et reste affichée. */
          <div role="alert" className="flex flex-col items-start gap-3 rounded-[18px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-5">
            <p className="text-sm text-[color:var(--text-primary)]">
              Impossible de charger vos biens et documents pour le moment.
            </p>
            <button
              type="button"
              onClick={retry}
              className="rounded-full bg-[color:var(--accent)] px-4 py-2 text-sm font-medium text-white"
            >
              Réessayer
            </button>
          </div>
        ) : !summary ? (
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
          <div className="@container flex flex-col gap-[26px] md:gap-9" aria-busy={refreshing || undefined}>
            {/* Revalidation en échec : les données affichées restent, un
                message discret le signale (APP-PERF-39). */}
            {refreshError && (
              <p role="status" className="flex items-center gap-3 text-xs text-[color:var(--text-muted)]">
                Actualisation impossible, affichage des dernières données reçues.
                <button type="button" onClick={retry} className="font-medium text-[color:var(--accent)] underline-offset-2 hover:underline">
                  Réessayer
                </button>
              </p>
            )}
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
