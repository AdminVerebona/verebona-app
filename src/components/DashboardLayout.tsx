"use client"

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
    Shield,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
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
import { HelpCircle } from 'lucide-react';
import { AnalysisBannerProvider } from '@/contexts/AnalysisBannerContext';
import { MobileAnalysisBanner } from './AnalysisBanner';

function getPlanLabel(plan: string, duoRole?: 'BILLING_OWNER' | 'MEMBER'): string {
  if (plan === 'PREMIUM_DUO') return duoRole === 'MEMBER' ? 'Premium Duo (membre)' : 'Premium Duo';
  const labels: Record<string, string> = { STANDARD: 'Standard', PREMIUM: 'Premium', PREMIUM_DUO: 'Premium Duo', PREMIUM_PRO: 'Premium Pro' };
  return labels[plan] ?? plan.toLowerCase();
}

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
      return stored === null ? true : stored === 'true';
    }
    return true;
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
      localStorage.removeItem('bearer_token');
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
        onMenuToggle={() => toggleCollapsed(!sidebarCollapsed)}
        sidebarCollapsed={sidebarCollapsed}
        user={user}
        theme={theme}
        onToggleTheme={toggleTheme}
        onLogout={handleLogout}
        isAdmin={isAdmin}
      />

      {/* Breadcrumb */}
      {breadcrumbItems.length > 0 && <DashboardBreadcrumb items={breadcrumbItems} />}

      <div className="flex flex-1 flex-col md:flex-row overflow-hidden">
        {/* Sidebar - Desktop */}
        <aside className={`hidden md:flex md:flex-col border-r border-[color:var(--border-subtle)] bg-[color:var(--sidebar)] flex-shrink-0 transition-all duration-300 ease-in-out shadow-relief-sm ${sidebarCollapsed ? 'md:w-16' : 'md:w-64'}`}>
          <div className="flex flex-col h-full">

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
                              <Plus className="w-5 h-5 text-white transition-transform group-hover:rotate-90" />
                            </button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent side="right">Ajouter</TooltipContent>
                      </Tooltip>
                      <DropdownMenuContent side="right" align="start" className="w-56 shadow-relief-lg">
                        <DropdownMenuItem onClick={() => setShowAssetDialog(true)} className="cursor-pointer py-2.5">
                          <Package className="mr-2 h-4 w-4" /><span>Ajouter un bien</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setShowDocumentDialog(true)} className="cursor-pointer py-2.5" data-guide="add-document">
                          <FileText className="mr-2 h-4 w-4" /><span>Ajouter un document</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setShowAgendaDrawer(true)} className="cursor-pointer py-2.5" data-guide="add-agenda-item">
                          <CalendarDays className="mr-2 h-4 w-4" /><span>Ajouter à l'agenda</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ) : (
                  <div className="relative w-full">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="lg" className="w-full h-11 rounded-xl shadow-relief-lg hover:shadow-relief-glow bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8] hover:scale-[1.02] transition-all group flex items-center justify-center gap-2">
                          <Plus className="w-5 h-5 text-white transition-transform group-hover:rotate-90" />
                          <span className="font-semibold text-white">Ajouter</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="center" className="w-56 shadow-relief-lg">
                        <DropdownMenuItem onClick={() => setShowAssetDialog(true)} className="cursor-pointer py-2.5">
                          <Package className="mr-2 h-4 w-4" /><span>Ajouter un bien</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setShowDocumentDialog(true)} className="cursor-pointer py-2.5">
                          <FileText className="mr-2 h-4 w-4" /><span>Ajouter un document</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setShowAgendaDrawer(true)} className="cursor-pointer py-2.5">
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
        {isMobileMenuOpen && (
          <div className="fixed inset-0 z-50 md:hidden">
            <div
              className="fixed inset-0 bg-black/50 backdrop-blur-sm"
              onClick={() => setIsMobileMenuOpen(false)}
            />
            <aside className="fixed inset-y-0 left-0 w-64 bg-[color:var(--sidebar)] border-r border-[color:var(--border-subtle)] shadow-relief-2xl overflow-y-auto">
              <div className="flex flex-col h-full">
                {/* Logo en haut */}
                <div className="p-6 border-b border-[color:var(--border-subtle)]">
                  <Link href="/accueil" className="hover-lift block" onClick={() => setIsMobileMenuOpen(false)}>
                    <Logo size={40} withText={true} />
                  </Link>
                </div>

                  {/* User menu & theme toggle en haut */}
                  <div className="p-4 space-y-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                      <button className="w-full flex items-center gap-3 hover:bg-[color:var(--accent-soft)] hover:shadow-relief-md rounded-xl px-3 py-2 transition-all shadow-relief-sm border border-transparent hover:border-[color:var(--border-subtle)]">
                            <Avatar className="w-8 h-8 shadow-relief-sm">
                              <AvatarFallback className="bg-[color:var(--accent)] text-white text-sm font-medium">
                                {getUserInitials}
                              </AvatarFallback>
                            </Avatar>
                            <div className="flex-1 text-left">
                              <div className="text-sm font-medium text-[color:var(--text-primary)] truncate">
                                {getUserDisplayName}
                              </div>
                              <div className="text-xs text-[color:var(--accent)] font-medium">
                                {getPlanLabel(user.subscription.plan, user.duoRole)}
                              </div>
                            </div>
                          </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56 shadow-relief-lg">
                        <div className="px-2 py-1.5 text-sm">
                          <div className="font-medium">{getUserDisplayName}</div>
                          <div className="text-xs text-[color:var(--text-muted)]">{user.email}</div>
                          <div className="text-xs text-[color:var(--text-muted)] mt-1">
                            Plan: <span className="font-medium">{getPlanLabel(user.subscription.plan, user.duoRole)}</span>
                          </div>
                        </div>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild>
                          <Link href="/mon-compte" className="cursor-pointer flex items-center" onClick={() => setIsMobileMenuOpen(false)}>
                            <User className="mr-2 h-4 w-4" />
                            <span>Compte</span>
                          </Link>
                        </DropdownMenuItem>
                        {isAdmin && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild>
                              <Link href="/admin" className="cursor-pointer flex items-center" onClick={() => setIsMobileMenuOpen(false)}>
                                <Shield className="mr-2 h-4 w-4" />
                                <span>Administration</span>
                              </Link>
                            </DropdownMenuItem>
                          </>
                        )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={toggleTheme} className="cursor-pointer">
                            {theme === 'blue' ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}
                            <span>Thème {theme === 'blue' ? 'clair' : 'sombre'}</span>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={handleLogout}
                            className="cursor-pointer"
                          >
                            <LogOut className="mr-2 h-4 w-4" />
                            <span>Se déconnecter</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>


                </div>

                  {/* Séparateur */}
                  <div className="mx-4 border-t border-[color:var(--border-subtle)]" />

                  {/* Navigation Mobile */}
                  <nav className="flex-1 space-y-1 p-4 overflow-y-auto">
                    <div className="flex justify-center mb-6 px-3">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="lg"
                            className="w-full h-12 rounded-xl shadow-relief-lg hover:shadow-relief-glow bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8] hover:scale-[1.02] transition-all group flex items-center justify-center gap-2"
                          >
                            <Plus className="w-5 h-5 text-white transition-transform group-hover:rotate-90" />
                            <span className="font-semibold text-white">Ajouter</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="center" className="w-56 shadow-relief-lg">
                          <DropdownMenuItem onClick={() => { setShowAssetDialog(true); setIsMobileMenuOpen(false); }} className="cursor-pointer py-2.5">
                            <Package className="mr-2 h-4 w-4" />
                            <span>Ajouter un bien</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => { setShowDocumentDialog(true); setIsMobileMenuOpen(false); }} className="cursor-pointer py-2.5">
                            <FileText className="mr-2 h-4 w-4" />
                            <span>Ajouter un document</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => { setShowAgendaDrawer(true); setIsMobileMenuOpen(false); }} className="cursor-pointer py-2.5">
                            <CalendarDays className="mr-2 h-4 w-4" />
                            <span>Ajouter à l'agenda</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {navigation.map((item) => {
                      const isActive = pathname === item.href;
                      return (
                        <Link
                          key={item.name}
                          href={item.href}
                          onClick={() => setIsMobileMenuOpen(false)}
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

                    {/* Help */}
                    <div className="border-t border-[color:var(--border-subtle)] pt-2 mt-2 space-y-1">
                      <button
                        onClick={() => { setHelpModalOpen(true); setIsMobileMenuOpen(false); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-[color:var(--text-primary)] hover:bg-[color:var(--bg-card)] hover:shadow-relief-sm transition-all"
                      >
                        <HelpCircle className="w-5 h-5 flex-shrink-0" />
                        <span>Besoin d'aide ?</span>
                      </button>
                    </div>
                  </nav>
                </div>
              </aside>
            </div>
          )}

          {/* Main Content */}
          <div id="main-scroll-container" className="flex-1 flex flex-col min-w-0 overflow-x-hidden pt-16 md:pt-0 overflow-y-auto relative scroll-smooth">
            {/* Bandeau d'essai / fin d'essai (CDC §9.2) */}
            <TrialBanner />
            <main className="flex-1 p-4 md:p-6 lg:p-8 w-full">
              <div className="max-w-full overflow-x-hidden">
                {children}
              </div>
            </main>
        </div>
      </div>

          {/* Mobile Action Button - Bottom Navigation */}
          <BottomNavigation />

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


    </TooltipProvider>
    </AnalysisBannerProvider>
  );
}
