"use client"

/**
 * Coquille authentifiée — Direction D v2 « La mascotte » §3.1, §4.1.
 *
 * Menu latéral 240 px repliable à 64 px, header de 60 px avec le champ
 * Verebona au centre (sur toutes les pages), barre haute et navigation
 * basse flottante sur mobile. Le champ et l'espace de réponse remplacent la
 * loupe de recherche indépendante et le tiroir latéral de l'assistant.
 */
import { useState, useEffect, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const DocumentDrawer = dynamic(
  () => import('@/components/assets/DocumentDrawer').then(m => ({ default: m.DocumentDrawer })),
  { ssr: false }
);
import { Logo } from './Logo';
import { publicSiteUrl } from '@/lib/external-urls';
import { TrialBanner } from '@/components/subscription/TrialBanner';
import { isUnpaid } from '@/lib/trial-status';
import { LogoLoader } from './LogoLoader';
import { useThemeToggle } from './ThemeToggle';
import { Sun, Moon, User, LogOut, X, HelpCircle, CalendarDays } from 'lucide-react';
import { BottomNavigation } from './mobile/bottom-navigation';
import { MobileActionsSheet } from './mobile/mobile-actions-sheet';
import { TopBar } from './TopBar';
import { NotificationBell } from './NotificationBell';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSession, User as SessionUser } from '@/hooks/useSession';
import { apiClient } from '@/lib/api-client';
import { unsubscribeCurrentDevice } from '@/lib/push/push-client';
import { NavigationProgress } from './NavigationProgress';
const GlobalDrawerHost = dynamic(() => import('./drawers/GlobalDrawerHost').then(m => ({ default: m.GlobalDrawerHost })), { ssr: false });
const HelpModal = dynamic(() => import('./help/HelpModal').then(m => ({ default: m.HelpModal })), { ssr: false });
const WelcomeOnboardingModal = dynamic(() => import('./onboarding/WelcomeOnboardingModal').then(m => ({ default: m.WelcomeOnboardingModal })), { ssr: false });
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { DashboardBreadcrumb } from './DashboardBreadcrumb';
import { SidebarPlanCard } from './premium/SidebarPlanCard';
import { useEntitlements } from '@/hooks/useEntitlements';
import { AnalysisBannerProvider } from '@/contexts/AnalysisBannerContext';
import { MobileAnalysisBanner } from './AnalysisBanner';
import { AppSidebar } from './shell/AppSidebar';
import { readSidebarCollapsed, writeSidebarCollapsed } from '@/lib/shell/sidebar-state';
import { assetIdFromPath, recordAssetView } from '@/lib/home/recent-assets';
import { VerebonaSpaceProvider } from './verebona/space/VerebonaSpaceProvider';
import { VerebonaDesktopPanel, VerebonaMobileField, VerebonaMobileSpace } from './verebona/space/VerebonaField';

interface DashboardLayoutProps {
  children: React.ReactNode;
  user?: SessionUser | null;
}

export function DashboardLayout({ children, user: userProp }: DashboardLayoutProps) {
  const pathname = usePathname();
  const router = useRouter();

  // Si user est passé en prop, on l'utilise directement sans refaire un appel API
  const sessionResult = useSession(userProp ? {} : { required: true });
  const user = userProp ?? sessionResult.user;
  const isLoading = userProp ? false : sessionResult.isLoading;
  const { theme, toggleTheme, mounted: themeMounted } = useThemeToggle();

  const [mounted, setMounted] = useState(true);

  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  // Menu déplié par défaut, état conservé (Direction D v2 §3.1).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => { setSidebarCollapsed(readSidebarCollapsed()); }, []);

  // « Mes biens · Récemment consultés » (§3.3) : la fiche ouverte est notée
  // sur cet appareil ; l'accueil la place en tête.
  useEffect(() => {
    const id = assetIdFromPath(pathname);
    if (id) recordAssetView(id);
  }, [pathname]);

  // Dialogs states
  const [helpModalOpen, setHelpModalOpen] = useState(false);
  const [onboardingForceOpen, setOnboardingForceOpen] = useState(false);


  // Global document drawer — opened from search results without page navigation
  const [globalDocDrawerOpen, setGlobalDocDrawerOpen] = useState(false);
  const [globalDocDrawerId, setGlobalDocDrawerId] = useState<number | null>(null);
  const [globalDocDrawerAutoAnalyze, setGlobalDocDrawerAutoAnalyze] = useState(false);
  const [globalDocDrawerShowAnalysis, setGlobalDocDrawerShowAnalysis] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const { docId, showAnalysisResults } = (e as CustomEvent<{ docId: number; showAnalysisResults?: boolean }>).detail;
      if (docId) {
        setGlobalDocDrawerShowAnalysis(!!showAnalysisResults);
        setGlobalDocDrawerId(docId);
        setGlobalDocDrawerOpen(true);
      }
    };
    window.addEventListener('open-document-drawer', handler);
    return () => window.removeEventListener('open-document-drawer', handler);
  }, []);

  // ══════════════════════════════════════════════════════════════════════
  // PRÉ-GÉNÉRATION DE LA MASCOTTE — CDC Mascotte RUN-007 à RUN-009
  //
  // Un changement validé ailleurs dans l'application (document, échéance,
  // action « À traiter », bien, export, « C'est fait ») prépare la prochaine
  // prise de parole de l'accueil en arrière-plan : au retour sur l'accueil,
  // le texte est déjà prêt. Le serveur temporise 3 s et regroupe les rafales ;
  // sur l'accueil même, la page recalcule elle-même.
  // ══════════════════════════════════════════════════════════════════════
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const events = ['verebona:data-mutated', 'document-added', 'document-deleted', 'document-analysis-complete', 'agenda-mutated', 'refresh-a-traiter'];
    const onChange = () => {
      if (window.location.pathname === '/accueil') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // `fetch` et non `apiClient` : ce POST ne doit pas lui-même compter
        // comme une modification des données du compte.
        void fetch('/api/home/mascot/pregenerate', { method: 'POST', credentials: 'include' }).catch(() => {});
      }, 1_000);
    };
    events.forEach((e) => window.addEventListener(e, onChange));
    return () => {
      events.forEach((e) => window.removeEventListener(e, onChange));
      if (timer) clearTimeout(timer);
    };
  }, []);

  const [availableAssets, setAvailableAssets] = useState<{ id: number; name: string }[]>([]);
  const [aTraiterCount, setATraiterCount] = useState<number | null>(null);

  // Data fetching non-critique différé via requestIdleCallback :
  // les assets pour le dropdown "Ajouter" et le compteur "À traiter"
  // ne doivent pas bloquer le rendu initial de la page.
  useEffect(() => {
    if (!user) return;
    const idle = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback
      : (cb: IdleRequestCallback) => setTimeout(cb, 200);

    idle(() => {
      apiClient.get<{ data: any[] }>('/api/assets?limit=20', { useCache: true }).then(res => {
        setAvailableAssets(res.data || []);
      }).catch(() => {});
    });
  }, [user]);

  const fetchATraiterCount = useCallback(() => {
    const idle = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback
      : (cb: IdleRequestCallback) => setTimeout(cb, 500);

    idle(() => {
      apiClient.get<{ total: number } | { items: any[] }>('/api/to-process', { useCache: true })
        .then(res => {
          const count = 'total' in res ? res.total : ('items' in res ? (res.items?.length ?? 0) : 0);
          setATraiterCount(count);
        })
        .catch(() => {
          // Fallback to old route
          apiClient.get<{ documents: any[]; agendaItems: any[]; equipements: any[] }>('/api/dashboard/a-traiter', { useCache: true })
            .then(main => {
              const count =
                (main.documents?.length ?? 0) +
                (main.agendaItems?.length ?? 0) +
                (main.equipements?.length ?? 0);
              setATraiterCount(count);
            })
            .catch(() => {});
        });
    });
  }, []);

  useEffect(() => {
    if (user) fetchATraiterCount();
  }, [user, fetchATraiterCount]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === 'number') {
        setATraiterCount(detail);
      } else {
        fetchATraiterCount();
      }
    };
    window.addEventListener('update-a-traiter-count', handler);
    return () => window.removeEventListener('update-a-traiter-count', handler);
  }, [fetchATraiterCount]);

  useEffect(() => {
    window.addEventListener('document-added', fetchATraiterCount);
    window.addEventListener('refresh-a-traiter', fetchATraiterCount);
    return () => {
      window.removeEventListener('document-added', fetchATraiterCount);
      window.removeEventListener('refresh-a-traiter', fetchATraiterCount);
    };
  }, [fetchATraiterCount]);

  useEffect(() => {
    const handler = async (e: Event) => {
      const { lotId, autoAnalyze, showAnalysisResults } = (e as CustomEvent).detail ?? {};
      if (!lotId) return;
      try {
        const data = await apiClient.get<{ items: { assetFileId: number }[] }>(`/api/documents/lots/${lotId}`);
        const firstId = data.items?.[0]?.assetFileId;
        if (!firstId) return;
        setGlobalDocDrawerAutoAnalyze(!!autoAnalyze);
        setGlobalDocDrawerShowAnalysis(!!showAnalysisResults);
        setGlobalDocDrawerId(firstId);
        setGlobalDocDrawerOpen(true);
      } catch {}
    };
    window.addEventListener('open-analysis-review', handler);
    return () => window.removeEventListener('open-analysis-review', handler);
  }, []);

  useEffect(() => {
    const openOnboarding = () => {
      setOnboardingForceOpen(true);
      setHelpModalOpen(false);
    };
    window.addEventListener('onboarding:relaunch', openOnboarding);
    return () => window.removeEventListener('onboarding:relaunch', openOnboarding);
  }, []);


  const toggleCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      writeSidebarCollapsed(!prev);
      return !prev;
    });
  }, []);

      const handleLogout = useCallback(async () => {

    // Désassocier le push de cet appareil AVANT d'invalider la session (§10.2) :
    // un appareil partagé ne doit plus recevoir les notifications de ce compte.
    try { await unsubscribeCurrentDevice(); } catch { /* best-effort */ }

    try {
      await apiClient.post('/api/auth/logout');
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      // Nettoyer complètement le localStorage
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('user');
      // Deconnexion : retour au site vitrine (cross-domain)
      window.location.href = publicSiteUrl('/');
    }
  }, [router]);

  const getUserDisplayName = useMemo(() => {
    if (!user) return '';
    return user.accountName || `${user.firstName} ${user.lastName.charAt(0)}.`;
  }, [user]);

  const getUserInitials = useMemo(() => {
    if (!user) return '';
    return `${user.firstName.charAt(0)}${user.lastName.charAt(0)}`.toUpperCase();
  }, [user]);

  const isAdmin = useMemo(() => user?.role === 'ADMIN', [user?.role]);
  const { items: breadcrumbItems } = useBreadcrumb();

  // ══════════════════════════════════════════════════════════════════════════
  // LE « + » GLOBAL DOIT REFUSER AVANT LA SAISIE, COMME LA PAGE « MES BIENS »
  //
  // La page des biens annonce le refus au clic sur « Ajouter ». Le « + » de la
  // barre latérale, celui du menu mobile et celui de la barre du bas, eux,
  // ouvraient le formulaire quoi qu'il arrive : l'utilisateur remplissait, puis
  // se faisait refuser. Trois portes d'entrée pour la même action, deux
  // comportements.
  //
  // Le contrôle serveur reste seul juge : ceci évite une saisie inutile,
  // ce n'est pas une autorisation.
  // ══════════════════════════════════════════════════════════════════════════
  const { entitlements } = useEntitlements();

  /**
   * Statut d'abonnement, toujours affiché.
   *
   * `entitlements` connaît l'état réel — essai en cours, essai terminé,
   * résiliation — là où `user.subscription.plan` ne porte que le type
   * d'offre et affichait « Standard » à quelqu'un en essai.
   */
  const statutAbonnement = useMemo(() => {
    // Impayé d'abord : sinon un abonné dont le paiement a échoué lisait
    // « Essai terminé » ou le nom de son offre, comme si tout allait bien.
    if (isUnpaid(entitlements)) return 'Paiement à régulariser';
    if (entitlements?.trial.status === 'active') return 'Essai en cours';
    if (entitlements?.trial.status === 'expired') return 'Essai terminé';
    const libelles: Record<string, string> = {
      trial: 'Essai en cours',
      standard: 'Standard',
      premium: 'Premium',
      premium_duo: 'Premium Duo',
      none: 'Aucune offre',
    };
    return libelles[entitlements?.plan ?? 'none'] ?? 'Aucune offre';
  }, [entitlements]);

  /** Le nom de l'espace ne distingue quelque chose que s'il y en a plusieurs. */
  const plusieursEspaces = (user as { accountsCount?: number } | null)?.accountsCount
    ? ((user as { accountsCount?: number }).accountsCount ?? 1) > 1
    : false;

  // ══════════════════════════════════════════════════════════════════════
  // « + AJOUTER » EN TÊTE DU MENU LATÉRAL (ORDINATEUR)
  //
  // Rétabli à la demande produit (il avait été retiré avec la Direction D v2
  // §3.1). Il ouvre le même panneau que le « + » central de la barre basse
  // mobile (`MobileActionsSheet`, document / échéance / bien), avec la même
  // garde d'écriture (`useWriteGuard`) : refus annoncé avant la saisie.
  // ══════════════════════════════════════════════════════════════════════
  const [addSheetOpen, setAddSheetOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[color:var(--bg-page)]">
        <LogoLoader size={40} />
      </div>
    );
  }

  // Session terminée et loading fini → rediriger vers login
  if (!user) {
    if (typeof window !== 'undefined') {
      const returnUrl = encodeURIComponent(window.location.pathname);
      window.location.href = `/login?returnUrl=${returnUrl}`;
    }
    return (
      <div className="min-h-screen flex items-center justify-center bg-[color:var(--bg-page)]">
        <LogoLoader size={52} />
      </div>
    );
  }

  const isHome = pathname === '/accueil';
  const nomAffiche = user ? `${user.firstName} ${user.lastName}`.trim() : '';

  return (
    <AnalysisBannerProvider>
    <TooltipProvider delayDuration={300}>
    <VerebonaSpaceProvider
      onOpenHelp={() => setHelpModalOpen(true)}
    >
    <div className="flex h-screen overflow-hidden bg-[color:var(--bg-page)]">
      <NavigationProgress />

      {/* Menu latéral — desktop (§3.1) */}
      <AppSidebar
        pathname={pathname}
        collapsed={sidebarCollapsed}
        onToggle={toggleCollapsed}
        toProcessCount={aTraiterCount}
        userName={nomAffiche}
        initials={getUserInitials}
        planLabel={statutAbonnement}
        footerSlot={<SidebarPlanCard trialDaysLeft={user.subscription?.trialDaysLeft ?? null} />}
        onAdd={() => setAddSheetOpen(true)}
      />

      {/* Colonne de la page : header, espace de réponse superposé, contenu */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <TopBar
          user={user}
          theme={theme}
          onToggleTheme={toggleTheme}
          onLogout={handleLogout}
          isAdmin={isAdmin}
          onOpenHelp={() => setHelpModalOpen(true)}
          showBrand={sidebarCollapsed}
        />

        {/* ══════════════════════════════════════════════════════════════
            BARRE HAUTE MOBILE (§4.1) : LE CHAMP VEREBONA + L'AVATAR

            La loupe, la cloche et le menu à trois barres cèdent la place
            au champ unique. Les notifications et les réglages sont dans le
            panneau du compte, ouvert par l'avatar.
            ══════════════════════════════════════════════════════════════ */}
        <div className="flex flex-shrink-0 items-center gap-2.5 bg-[color:var(--bg-page)] px-3.5 pb-2 pt-[max(8px,env(safe-area-inset-top))] md:hidden">
          <VerebonaMobileField />
          <button
            onClick={() => setIsMobileMenuOpen(true)}
            aria-label="Compte et réglages"
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] text-[12px] font-semibold text-white"
          >
            {getUserInitials}
          </button>
        </div>

        {/* Bandeau d'analyse mobile, sous la barre haute */}
        <MobileAnalysisBanner />

        {/* Espace de réponse desktop : superposé sous le champ (§6.2) */}
        <VerebonaDesktopPanel />

        <div id="main-scroll-container" className="relative flex min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden scroll-smooth">
          {/* Bandeau d'essai / fin d'essai (CDC §9.2) */}
          <TrialBanner />

          {/* Fil d'Ariane : rendu une fois ici, jamais sur l'accueil (§3.1). */}
          {!isHome && <DashboardBreadcrumb items={breadcrumbItems} />}
          <main className={isHome ? 'w-full flex-1' : 'w-full flex-1 p-4 pb-32 md:p-6 md:pb-6 lg:p-8'}>
            {/* `overflow-x-clip` et non `hidden` : `hidden` fait de ce bloc un
                conteneur de défilement, et un élément « sticky » d'une page
                (résumé de la préparation d'un dossier) ne collait plus. */}
            <div className="max-w-full overflow-x-clip">
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>

    {/* ══════════════════════════════════════════════════════════════
        PANNEAU DU COMPTE — MOBILE

        Ce qui relève du compte seulement : la navigation est dans la barre
        basse, masquée pendant l'ouverture (deux navigations actives en même
        temps étaient le défaut).
        ══════════════════════════════════════════════════════════════ */}
    {isMobileMenuOpen && (
      <div className="fixed inset-0 z-[60] md:hidden">
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setIsMobileMenuOpen(false)} />
        <aside className="fixed inset-y-0 right-0 w-[85%] max-w-sm overflow-y-auto border-l border-[color:var(--border-subtle)] bg-[color:var(--sidebar)] shadow-relief-2xl" aria-label="Compte et réglages">
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-[color:var(--border-subtle)] p-5 pt-[max(20px,env(safe-area-inset-top))]">
              <Link href="/accueil" onClick={() => setIsMobileMenuOpen(false)} className="select-none">
                <Logo size={26} withText={true} withBaseline={false} />
              </Link>
              <div className="flex items-center gap-1">
                <NotificationBell />
                <button
                  onClick={() => setIsMobileMenuOpen(false)}
                  aria-label="Fermer"
                  className="rounded-lg p-2 text-[color:var(--text-muted)] hover:bg-[color:var(--accent-soft)]"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="border-b border-[color:var(--border-subtle)] p-5">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] text-sm font-semibold text-white">
                  {getUserInitials}
                </span>
                <div className="min-w-0">
                  {/* Le nom de la personne, non celui du compte. */}
                  <p className="truncate text-sm font-semibold text-[color:var(--text-primary)]">
                    {user ? `${user.firstName} ${user.lastName.charAt(0)}.` : ''}
                  </p>
                  <span className="mt-1 inline-block rounded-full bg-[color:var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--accent)]">
                    {statutAbonnement}
                  </span>
                  {plusieursEspaces && user?.accountName && (
                    <p className="mt-1 truncate text-xs text-[color:var(--text-muted)]">{user.accountName}</p>
                  )}
                </div>
              </div>
            </div>

            <nav className="flex-1 space-y-1 p-3">
              {/* La barre basse garde ses 5 entrées (§4.1) : l'agenda est ici. */}
              <Link
                href="/agenda"
                onClick={() => setIsMobileMenuOpen(false)}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-[color:var(--text-primary)] transition-colors hover:bg-[color:var(--accent-soft)]"
              >
                <CalendarDays className="h-5 w-5 flex-shrink-0" />
                <span className="text-sm">Mon agenda</span>
              </Link>
              <Link
                href="/mon-compte"
                onClick={() => setIsMobileMenuOpen(false)}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-[color:var(--text-primary)] transition-colors hover:bg-[color:var(--accent-soft)]"
              >
                <User className="h-5 w-5 flex-shrink-0" />
                <span className="text-sm">Mon compte</span>
              </Link>
              <button
                onClick={() => { setIsMobileMenuOpen(false); setHelpModalOpen(true); }}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-[color:var(--text-primary)] transition-colors hover:bg-[color:var(--accent-soft)]"
              >
                <HelpCircle className="h-5 w-5 flex-shrink-0" />
                <span className="text-sm">Besoin d&apos;aide ?</span>
              </button>
              <button
                onClick={toggleTheme}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-[color:var(--text-primary)] transition-colors hover:bg-[color:var(--accent-soft)]"
              >
                {theme === 'blue' ? <Sun className="h-5 w-5 flex-shrink-0" /> : <Moon className="h-5 w-5 flex-shrink-0" />}
                <span className="text-sm">{theme === 'blue' ? 'Thème clair' : 'Thème sombre'}</span>
              </button>
            </nav>

            {/* Isolé en bas : une déconnexion mêlée aux réglages s'atteint par mégarde. */}
            <div className="border-t border-[color:var(--border-subtle)] p-3">
              <button
                onClick={() => { setIsMobileMenuOpen(false); handleLogout(); }}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--text-primary)]"
              >
                <LogOut className="h-5 w-5 flex-shrink-0" />
                <span className="text-sm">Se déconnecter</span>
              </button>
            </div>
          </div>
        </aside>
      </div>
    )}

    {/* Navigation basse flottante — mobile (§4.1) */}
    {!isMobileMenuOpen && <BottomNavigation toProcessCount={aTraiterCount} />}

    {/* Panneau du « + Ajouter » du menu latéral (ordinateur) */}
    <MobileActionsSheet open={addSheetOpen} onOpenChange={setAddSheetOpen} allViewports />

    {/* Espace de réponse mobile, plein écran (§6.3) */}
    <VerebonaMobileSpace />

    {/* Tiroir document global — ouvert depuis l'espace de réponse, les notifications… */}
    {globalDocDrawerId !== null && (
      <DocumentDrawer
        open={globalDocDrawerOpen}
        onOpenChange={v => { setGlobalDocDrawerOpen(v); if (!v) { setGlobalDocDrawerId(null); setGlobalDocDrawerAutoAnalyze(false); setGlobalDocDrawerShowAnalysis(false); } }}
        document={{
          id: globalDocDrawerId,
          originalFilename: '',
          mimeType: '',
          documentType: 'AUTRE',
          documentDate: null,
          uploadedAt: null,
          assetId: 0,
        }}
        onRefresh={() => {}}
        autoAnalyze={globalDocDrawerAutoAnalyze}
        showAnalysisResults={globalDocDrawerShowAnalysis}
      />
    )}

    {/* Échéance, équipement, pièce : tiroirs ouverts depuis n'importe quel écran (src/lib/drawers.ts). */}
    <GlobalDrawerHost />

    {/* Modale "Besoin d'aide ?" */}
    <HelpModal open={helpModalOpen} onOpenChange={setHelpModalOpen} />

    {/* Modal d'accueil / onboarding */}
    {user?.id && (
      <WelcomeOnboardingModal
        userId={user.id}
        plan={user.subscription.plan}
        duoRole={user.duoRole}
        forceOpen={onboardingForceOpen}
        onClose={() => setOnboardingForceOpen(false)}
        hasItems={availableAssets.length > 0}
      />
    )}
    </VerebonaSpaceProvider>
    </TooltipProvider>
    </AnalysisBannerProvider>
  );
}
