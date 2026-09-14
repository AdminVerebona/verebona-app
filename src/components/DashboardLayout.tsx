"use client"

import { useState, useEffect, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const DocumentDrawer = dynamic(
  () => import('@/components/assets/DocumentDrawer').then(m => ({ default: m.DocumentDrawer })),
  { ssr: false }
);
// Verebona Assistant — drawer monté une seule fois dans la coquille authentifiée (CDC §7.1).
const VerebonaDrawer = dynamic(
  () => import('@/components/verebona').then(m => ({ default: m.VerebonaDrawer })),
  { ssr: false }
);
import { suggestionsForRoute } from '@/services/verebona-assistant/registries/capability-registry';
import { Logo } from './Logo';
import { publicSiteUrl } from '@/lib/external-urls';
import { TrialBanner } from '@/components/subscription/TrialBanner';
import { LogoLoader } from './LogoLoader';
import { useThemeToggle } from './ThemeToggle';
import { Sun, Moon } from 'lucide-react';
import { BottomNavigation } from './mobile/bottom-navigation';
const MobileSearchOverlay = dynamic(() => import('./mobile/MobileSearchOverlay').then(m => ({ default: m.MobileSearchOverlay })), { ssr: false });
import {
    House,
    Package,
    FileText,
    CalendarDays,
    CircleAlert,
    User,
    LogOut,
    Menu,
    X,
    Plus,
    Search,
  } from 'lucide-react';
import { TopBar } from './TopBar';
import { NotificationBell } from './NotificationBell';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useSession, User as SessionUser } from '@/hooks/useSession';
import { apiClient } from '@/lib/api-client';
import { unsubscribeCurrentDevice } from '@/lib/push/push-client';
import { isPremiumPlan } from '@/types/domain';
const AssetFormDialog = dynamic(() => import('./AssetFormDialog').then(m => ({ default: m.AssetFormDialog })), { ssr: false });
const UnifiedDocumentDialog = dynamic(() => import('./documents/unified-document-dialog').then(m => ({ default: m.UnifiedDocumentDialog })), { ssr: false });
const CreateAgendaItemDrawer = dynamic(() => import('./agenda/CreateAgendaItemDrawer').then(m => ({ default: m.CreateAgendaItemDrawer })), { ssr: false });
import { NavigationProgress } from './NavigationProgress';
const HelpModal = dynamic(() => import('./help/HelpModal').then(m => ({ default: m.HelpModal })), { ssr: false });
const WelcomeOnboardingModal = dynamic(() => import('./onboarding/WelcomeOnboardingModal').then(m => ({ default: m.WelcomeOnboardingModal })), { ssr: false });
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { DashboardBreadcrumb } from './DashboardBreadcrumb';
import { SidebarPlanCard } from './premium/SidebarPlanCard';
import { useEntitlements } from '@/hooks/useEntitlements';
import { HelpCircle } from 'lucide-react';
import { AnalysisBannerProvider } from '@/contexts/AnalysisBannerContext';
import { MobileAnalysisBanner } from './AnalysisBanner';
import { useWriteGuard } from '@/contexts/WriteGuardContext';

const navigation = [
  { name: 'Accueil', href: '/accueil', icon: House, dataGuide: undefined },
  { name: 'Mes biens', href: '/assets', icon: Package, dataGuide: undefined },
  { name: 'Mon agenda', href: '/agenda', icon: CalendarDays, dataGuide: undefined },
  { name: 'Mes documents', href: '/documents', icon: FileText, dataGuide: undefined },
  { name: 'À traiter', href: '/accueil/a-traiter', icon: CircleAlert, dataGuide: 'treat-incomplete' },
];

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
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('sidebar-collapsed');
      // Maquette : sidebar dépliée par défaut
      return stored === null ? false : stored === 'true';
    }
    return false;
  });

  // Dialogs states
  const [showAssetDialog, setShowAssetDialog] = useState(false);
  const [showDocumentDialog, setShowDocumentDialog] = useState(false);
  const [showAgendaDrawer, setShowAgendaDrawer] = useState(false);
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


  const toggleCollapsed = useCallback((value: boolean) => {
    setSidebarCollapsed(value);
    localStorage.setItem('sidebar-collapsed', String(value));
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
  const { entitlements, isRestricted } = useEntitlements();

  /**
   * Statut d'abonnement, toujours affiché.
   *
   * `entitlements` connaît l'état réel — essai en cours, essai terminé,
   * résiliation — là où `user.subscription.plan` ne porte que le type
   * d'offre et affichait « Standard » à quelqu'un en essai.
   */
  const statutAbonnement = useMemo(() => {
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

  /**
   * Garde déportée dans `WriteGuardContext`.
   *
   * La logique était recopiée ici et dans le menu mobile, et n'affichait
   * qu'un bandeau. Un bandeau disparaît : l'utilisateur qui vient de cliquer
   * sur « Ajouter » ne comprend pas pourquoi rien ne s'ouvre.
   */
  const { garder } = useWriteGuard();
  const refuserEcriture = useCallback((quota?: 'assets' | 'documents'): boolean => {
    let bloque = true;
    garder(() => { bloque = false; }, quota);
    return bloque;
  }, [garder]);

  const ouvrirAjoutBien = useCallback(() => {
    if (refuserEcriture('assets')) return;
    setShowAssetDialog(true);
  }, [refuserEcriture]);

  /**
   * L'agenda manquait : les deux autres entrées du menu « + » passaient par
   * `refuserEcriture`, celle-ci ouvrait le tiroir directement. Ajouter une
   * échéance est une écriture que le serveur refuse comme les autres.
   */
  const ouvrirAjoutAgenda = useCallback(() => {
    if (refuserEcriture()) return;
    setShowAgendaDrawer(true);
  }, [refuserEcriture]);

  const ouvrirAjoutDocument = useCallback(() => {
    if (refuserEcriture('documents')) return;
    setShowDocumentDialog(true);
  }, [refuserEcriture]);

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

  return (
    <AnalysisBannerProvider>
    <TooltipProvider delayDuration={300}>
    <div className="h-screen bg-[color:var(--bg-page)] flex flex-col overflow-hidden">
      <NavigationProgress />

      {/* TopBar Desktop - pleine largeur, au-dessus de tout */}
      <TopBar
        user={user}
        theme={theme}
        onToggleTheme={toggleTheme}
        onLogout={handleLogout}
        isAdmin={isAdmin}
      />


      <div className="flex flex-1 flex-col md:flex-row overflow-hidden">
        {/* Sidebar - Desktop */}
        <aside className={`hidden md:flex md:flex-col border-r border-[color:var(--border-subtle)] bg-[color:var(--sidebar)] flex-shrink-0 transition-all duration-300 ease-in-out shadow-relief-sm ${sidebarCollapsed ? 'md:w-16' : 'md:w-64'}`}>
          <div className="flex flex-col h-full">

            {/* Hamburger + logo — le menu porte son propre toggle (maquette) */}
            <div className={`flex items-center gap-2.5 p-3 pb-1 ${sidebarCollapsed ? 'justify-center' : ''}`}>
              <button
                onClick={() => toggleCollapsed(!sidebarCollapsed)}
                aria-label={sidebarCollapsed ? 'Ouvrir le menu' : 'Réduire le menu'}
                className="flex items-center justify-center w-9 h-9 rounded-lg hover:bg-[color:var(--accent-soft)] text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-all flex-shrink-0"
              >
                <Menu className="w-5 h-5" />
              </button>
              {/* Logo déplacé dans `TopBar` : ici il disparaissait dès que le
                  menu était replié. Le garder aux deux endroits afficherait
                  deux logos côte à côte, menu ouvert. */}
            </div>

            {/* Navigation */}
            <nav className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden space-y-1 p-3">
              {/* Bouton Ajouter */}
              <div className={`relative flex mb-4 ${sidebarCollapsed ? 'justify-center' : 'justify-center px-1'}`}>
                {sidebarCollapsed ? (
                  <div className="relative">
                    <DropdownMenu>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <button className="w-10 h-10 rounded-full shadow-relief-lg bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8] flex items-center justify-center hover:scale-105 transition-all group">
                              <Plus className="w-5 h-5 text-white transition-transform duration-[250ms] ease-[cubic-bezier(.34,1.56,.64,1)] group-hover:rotate-90" />
                            </button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent side="right">Ajouter un bien, un document ou un événement</TooltipContent>
                      </Tooltip>
                      <DropdownMenuContent side="right" align="start" className="w-56 shadow-relief-lg">
                        <DropdownMenuItem onClick={ouvrirAjoutBien} className="cursor-pointer py-2.5">
                          <Package className="mr-2 h-4 w-4" /><span>Ajouter un bien</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={ouvrirAjoutDocument} className="cursor-pointer py-2.5" data-guide="add-document">
                          <FileText className="mr-2 h-4 w-4" /><span>Ajouter un document</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={ouvrirAjoutAgenda} className="cursor-pointer py-2.5" data-guide="add-agenda-item">
                          <CalendarDays className="mr-2 h-4 w-4" /><span>Ajouter à l'agenda</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ) : (
                  <div className="relative w-full">
                    <DropdownMenu>
                      {/* ══════════════════════════════════════════════════
                          L'ORDRE D'IMBRICATION DÉCIDE SI LE BOUTON RÉPOND

                          `DropdownMenuTrigger asChild` transmet ses gestionnaires
                          à son unique enfant. Il enveloppait `<Tooltip>`, qui est
                          un fournisseur de contexte et non un élément du DOM :
                          le `onClick` n'atteignait jamais le bouton, et le menu
                          ne s'ouvrait pas.

                          La branche « menu replié », quinze lignes plus haut,
                          imbriquait déjà correctement — d'où un bouton qui
                          fonctionnait d'un côté seulement.
                          ══════════════════════════════════════════════════ */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <button
                              aria-label="Ajouter"
                              className="h-11 w-11 rounded-full shadow-relief-lg hover:shadow-relief-glow bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8] flex items-center justify-center hover:scale-105 transition-all group"
                            >
                              <Plus className="w-5 h-5 text-white transition-transform duration-[250ms] ease-[cubic-bezier(.34,1.56,.64,1)] group-hover:rotate-90" />
                            </button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent side="right">Ajouter un bien, un document ou un événement</TooltipContent>
                      </Tooltip>
                      <DropdownMenuContent align="center" className="w-56 shadow-relief-lg">
                        <DropdownMenuItem onClick={ouvrirAjoutBien} className="cursor-pointer py-2.5">
                          <Package className="mr-2 h-4 w-4" /><span>Ajouter un bien</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={ouvrirAjoutDocument} className="cursor-pointer py-2.5">
                          <FileText className="mr-2 h-4 w-4" /><span>Ajouter un document</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={ouvrirAjoutAgenda} className="cursor-pointer py-2.5">
                          <CalendarDays className="mr-2 h-4 w-4" /><span>Ajouter à l'agenda</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </div>

              {/* Nav items */}
              {navigation.map((item) => {
                const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
                if (sidebarCollapsed) {
                  return (
                    <Tooltip key={item.name}>
                      <TooltipTrigger asChild>
                        <Link
                          href={item.href}
                          className={`flex items-center justify-center w-10 h-10 mx-auto rounded-xl transition-all ${
                            isActive
                              ? 'bg-[color:var(--accent-soft)] text-[color:var(--accent)] shadow-relief-sm'
                              : 'text-[color:var(--text-primary)] hover:bg-[color:var(--bg-card)] hover:shadow-relief-sm'
                          }`}
                        >
                          <item.icon className="w-5 h-5" />
                        </Link>
                      </TooltipTrigger>
                      <TooltipContent side="right">{item.name}</TooltipContent>
                    </Tooltip>
                  );
                }
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    {...(item.dataGuide ? { 'data-guide': item.dataGuide } : {})}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                      isActive
                        ? 'bg-[color:var(--accent-soft)] text-[color:var(--accent)] shadow-relief-sm border-l-2 border-[color:var(--accent)]'
                        : 'text-[color:var(--text-primary)] hover:bg-[color:var(--bg-card)] hover:shadow-relief-sm'
                    }`}
                  >
                    <item.icon className="w-5 h-5 flex-shrink-0" />
                    {item.href === '/accueil/a-traiter' && aTraiterCount !== null && aTraiterCount > 0
                      ? <span>{item.name} <span className="text-white">({aTraiterCount})</span></span>
                      : item.name
                    }
                  </Link>
                );
              })}
            </nav>

            {/* Carte plan (essai / standard) — masquée sidebar repliée */}
            {!sidebarCollapsed && user && (
              <SidebarPlanCard
                plan={(user.subscription?.plan || 'STANDARD').toUpperCase()}
                trialDaysLeft={user.subscription?.trialDaysLeft ?? null}
                assetsUsed={entitlements?.quotas?.assets?.used}
                assetsMax={entitlements?.quotas?.assets?.limit}
              />
            )}

            {/* Guide + Help — always visible at bottom */}
            <div className="flex-shrink-0 border-t border-[color:var(--border-subtle)] p-3 space-y-1">
              {sidebarCollapsed ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setHelpModalOpen(true)}
                      className="w-full flex items-center justify-center p-2.5 rounded-xl text-[color:var(--text-primary)] hover:bg-[color:var(--bg-card)] hover:shadow-relief-sm transition-all"
                    >
                      <HelpCircle className="w-5 h-5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Besoin d'aide ?</TooltipContent>
                </Tooltip>
              ) : (
                <button
                  onClick={() => setHelpModalOpen(true)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-[color:var(--text-primary)] hover:bg-[color:var(--bg-card)] hover:shadow-relief-sm transition-all"
                >
                  <HelpCircle className="w-5 h-5 flex-shrink-0" />
                  <span>Besoin d'aide ?</span>
                </button>
              )}
            </div>
          </div>
        </aside>

        {/* Mobile Header - Fixed */}
        <header className="md:hidden fixed top-0 left-0 right-0 z-40 w-full bg-[color:var(--bg-page)]/75 backdrop-blur-xl border-b border-[color:var(--border-subtle)] min-h-16 pt-[env(safe-area-inset-top)]">
            <div className="relative flex items-center justify-center h-16 px-6">
              {/* Logo - Centered & Small */}
              <Link href="/accueil" className="block">
                <Logo size={24} withText={true} />
              </Link>

            {/* Menu Button - Left side */}
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="absolute left-4 p-2.5 rounded-xl hover:bg-[color:var(--accent-soft)] bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] shadow-relief-md"
            >
              {isMobileMenuOpen ? <X className="w-5 h-5 text-[color:var(--text-primary)]" /> : <Menu className="w-5 h-5 text-[color:var(--text-primary)]" />}
            </button>

            {/* Actions - Right side */}
            <div className="absolute right-4 flex items-center gap-2">
              <NotificationBell />
              <button
                onClick={() => setMobileSearchOpen(true)}
                className="p-2.5 rounded-xl hover:bg-[color:var(--accent-soft)] bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] shadow-relief-md"
              >
                <Search className="w-5 h-5 text-[color:var(--text-primary)]" />
              </button>
            </div>
          </div>
        </header>

        {/* Floating Menu Button - Removed redundant button */}

        {/* Mobile Analysis Banner — thin bar below header */}
        <MobileAnalysisBanner />

        {/* Mobile Sidebar */}
        {/* ══════════════════════════════════════════════════════════════
            PANNEAU DE COMPTE — PLUS UNE SECONDE NAVIGATION

            Il reprenait « Mes biens », « Mon agenda », « Mes documents »,
            « À traiter » et « Ajouter » — les cinq rubriques de la barre
            inférieure. Deux systèmes de navigation coexistaient, utilisables
            en même temps puisque la barre restait au-dessus en z-50.

            Il ne contient plus que ce qui relève du compte. La barre
            inférieure est masquée pendant l'ouverture : laisser deux
            navigations actives était le défaut lui-même.
            ══════════════════════════════════════════════════════════════ */}
        {isMobileMenuOpen && (
          <div className="fixed inset-0 z-[60] md:hidden">
            <div
              className="fixed inset-0 bg-black/50 backdrop-blur-sm"
              onClick={() => setIsMobileMenuOpen(false)}
            />
            {/* Largeur relative plafonnée : `w-64` fixe tronquait les noms
                longs sur les petits écrans. */}
            <aside className="fixed inset-y-0 left-0 w-[85%] max-w-sm bg-[color:var(--sidebar)] border-r border-[color:var(--border-subtle)] shadow-relief-2xl overflow-y-auto">
              <div className="flex flex-col h-full">

                <div className="flex items-center justify-between p-5 border-b border-[color:var(--border-subtle)]">
                  <span className="text-sm font-semibold text-[color:var(--text-primary)]">
                    Compte et réglages
                  </span>
                  {/* Fermeture explicite : le panneau n'en offrait aucune,
                      hors le geste de toucher le fond. */}
                  <button
                    onClick={() => setIsMobileMenuOpen(false)}
                    aria-label="Fermer"
                    className="p-2 rounded-lg hover:bg-[color:var(--accent-soft)] text-[color:var(--text-muted)]"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="p-5 border-b border-[color:var(--border-subtle)]">
                  <div className="flex items-center gap-3">
                    <Avatar className="w-11 h-11 flex-shrink-0">
                      <AvatarFallback className="bg-[#3b82f6] text-white text-sm font-semibold">
                        {getUserInitials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      {/* Le nom de la personne, non celui du compte. Celui-ci
                          vaut « Compte de Prénom Nom » — un identifiant
                          technique, pas un libellé d'interface. */}
                      <p className="text-sm font-semibold text-[color:var(--text-primary)] truncate">
                        {user ? `${user.firstName} ${user.lastName.charAt(0)}.` : ''}
                      </p>
                      <span className="inline-block mt-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[color:var(--accent-soft)] text-[color:var(--accent)]">
                        {statutAbonnement}
                      </span>
                      {/* Le nom de l'espace ne s'affiche qu'avec plusieurs
                          espaces : seul, il n'a rien à distinguer. */}
                      {plusieursEspaces && user?.accountName && (
                        <p className="text-xs text-[color:var(--text-muted)] truncate mt-1">
                          {user.accountName}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <nav className="flex-1 p-3 space-y-1">
                  {/* Accès direct aux réglages : la fiche ouvrait jusqu'ici
                      un sous-menu, soit deux gestes pour une destination. */}
                  <Link
                    href="/mon-compte"
                    onClick={() => setIsMobileMenuOpen(false)}
                    className="flex items-center gap-3 px-3 py-3 rounded-xl text-[color:var(--text-primary)] hover:bg-[color:var(--accent-soft)] transition-colors"
                  >
                    <User className="w-5 h-5 flex-shrink-0" />
                    <span className="text-sm">Mon compte</span>
                  </Link>

                  <button
                    onClick={() => { setIsMobileMenuOpen(false); setHelpModalOpen(true); }}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-[color:var(--text-primary)] hover:bg-[color:var(--accent-soft)] transition-colors"
                  >
                    <HelpCircle className="w-5 h-5 flex-shrink-0" />
                    <span className="text-sm">Besoin d&apos;aide ?</span>
                  </button>

                  <button
                    onClick={toggleTheme}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-[color:var(--text-primary)] hover:bg-[color:var(--accent-soft)] transition-colors"
                  >
                    {theme === 'blue'
                      ? <Sun className="w-5 h-5 flex-shrink-0" />
                      : <Moon className="w-5 h-5 flex-shrink-0" />}
                    <span className="text-sm">Apparence</span>
                  </button>
                </nav>

                {/* Isolé en bas : une déconnexion mêlée aux réglages
                    s'atteint par mégarde. */}
                <div className="p-3 border-t border-[color:var(--border-subtle)]">
                  <button
                    onClick={() => { setIsMobileMenuOpen(false); handleLogout(); }}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-[color:var(--text-muted)] hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--text-primary)] transition-colors"
                  >
                    <LogOut className="w-5 h-5 flex-shrink-0" />
                    <span className="text-sm">Se déconnecter</span>
                  </button>
                </div>
              </div>
            </aside>
          </div>
        )}

          {/* Main Content */}
          <div id="main-scroll-container" className="flex-1 flex flex-col min-w-0 overflow-x-hidden pt-16 md:pt-0 overflow-y-auto relative scroll-smooth">
            {/* Bandeau d'essai / fin d'essai (CDC §9.2) */}
            <TrialBanner />

            {/* ══════════════════════════════════════════════════════════════
                LE FIL D'ARIANE N'ÉTAIT RENDU NULLE PART

                Onze pages appellent `setBreadcrumbs(...)`, le composant
                `DashboardBreadcrumb` existe, et `breadcrumbItems` était même
                lu ici — sans jamais être affiché. Un commentaire annonçait un
                rendu « dans chaque page, au-dessus du H1 » : aucune page ne
                l'a jamais fait. Le fil d'ariane a disparu à ce déplacement.

                Il est rendu une fois, ici : c'est le seul endroit qui voie à
                la fois le contexte et toutes les pages, et il n'y a plus onze
                occasions d'oublier.
                ══════════════════════════════════════════════════════════ */}
            <DashboardBreadcrumb items={breadcrumbItems} />
            <main className="flex-1 p-4 md:p-6 lg:p-8 w-full">
              <div className="max-w-full overflow-x-hidden">
                {children}
              </div>
            </main>
        </div>
      </div>

          {/* Mobile Action Button - Bottom Navigation */}
          {/* Masquée pendant l'ouverture du panneau : elle est en z-50 et
              restait au-dessus, laissant deux navigations utilisables en même
              temps. Surenchérir sur le plan du panneau n'aurait pas réglé le
              fond — c'est la simultanéité qui est le défaut. */}
          {!isMobileMenuOpen && <BottomNavigation />}

          {/* Mobile Search Overlay */}
          <MobileSearchOverlay
            open={mobileSearchOpen}
            onClose={() => setMobileSearchOpen(false)}
            isPaidPlan={isPremiumPlan(user?.subscription?.plan ?? '')}
            planCode={user?.subscription?.plan ?? ''}
          />

          {/* Global document drawer — for search results, no page navigation needed */}
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

          {/* Action Dialogs */}
          {user?.id && (
            <>
              <AssetFormDialog
                open={showAssetDialog}
                onOpenChange={setShowAssetDialog}
                userId={user.id}
                onSuccess={() => setShowAssetDialog(false)}
              />
              <UnifiedDocumentDialog
                open={showDocumentDialog}
                onOpenChange={setShowDocumentDialog}
                onSuccess={() => setShowDocumentDialog(false)}
              />
              <CreateAgendaItemDrawer
                open={showAgendaDrawer}
                onClose={() => setShowAgendaDrawer(false)}
                onMutated={() => setShowAgendaDrawer(false)}
              />
            </>
          )}
        </div>

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

        {/* Assistant Verebona — bouton flottant + drawer (CDC §7). */}
        <VerebonaDrawer
          pageContext={{ route: pathname }}
          suggestions={suggestionsForRoute(pathname).map((s) => ({ id: s.id, label: s.label }))}
        />


    </TooltipProvider>
    </AnalysisBannerProvider>
  );
}
