"use client"

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Logo } from './Logo';
import {
  LayoutDashboard,
  Users,
  LogOut,
  Home,
  FileType,
  Building2,
  Menu,
  X,
  Gift,
  SlidersHorizontal,
  ListOrdered,
  ScrollText,
  Coins,
  KeyRound,
  Gauge,
  CreditCard,
  BookOpen,
  Mail,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Navigation cible du back-office — CDC Back-Office V1 §3, REC-NAV-01/02/03.
 *
 * EXACTEMENT les 15 entrées du CDC, dans son ordre. Toutes directement
 * visibles : aucune section repliable, aucun badge de compteur (UX-001).
 *
 * Retirées (§3 encadré, §14, §15) : « Gestion IA » (/admin/document-ai) et
 * « Suivi IA » (/admin/ai-usage), ainsi que Webhooks Stripe, Biens,
 * Documents, Types de biens, Types de documents, Exports, Logos système,
 * Templates Email, Backups et Journal d'audit. Leurs pages restent
 * accessibles par URL tant que les écrans cibles (Supervision, Référentiels,
 * Communications) ne les ont pas absorbées.
 *
 * Toute modification de cette liste doit rester alignée sur le test
 * `src/components/__tests__/admin-sidebar.test.ts`.
 */
export const ADMIN_NAVIGATION = [
  { name: 'Dashboard', href: '/admin', icon: LayoutDashboard },
  { name: 'Comptes', href: '/admin/accounts', icon: Building2 },
  { name: 'Utilisateurs', href: '/admin/users', icon: Users },
  { name: 'Abonnements & paiements', href: '/admin/subscriptions', icon: CreditCard },
  { name: 'Parrainages & promotions', href: '/admin/referrals', icon: Gift },
  { name: 'Référentiels', href: '/admin/referentials', icon: BookOpen },
  { name: 'Communications', href: '/admin/communications', icon: Mail },
  { name: 'Modèles d\'export', href: '/admin/export-templates', icon: FileType },
  { name: 'RGPD', href: '/admin/gdpr', icon: ShieldCheck },
  // Écrans IA conservés (§14) — contenu défini par le CDC IA.
  { name: 'Tableau de bord IA', href: '/admin/ai-dashboard', icon: Gauge },
  { name: 'Configuration IA', href: '/admin/ai-config', icon: SlidersHorizontal },
  { name: 'File IA', href: '/admin/ai-queue', icon: ListOrdered },
  { name: 'Exécutions IA', href: '/admin/ai-executions', icon: ScrollText },
  { name: 'Coûts IA', href: '/admin/ai-costs', icon: Coins },
  { name: 'Fournisseur IA', href: '/admin/ai-provider', icon: KeyRound },
] as const;

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();

  const handleBackToApp = () => {
    onNavigate?.();
    router.push('/accueil');
  };

  const handleLogout = async () => {
    onNavigate?.();
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('user');
      router.push('/');
    }
  };

  return (
    <div className="flex h-full flex-col bg-card border-r">
      {/* Logo/Header */}
      <div className="flex h-16 items-center border-b px-6 flex-shrink-0">
        <div className="flex flex-col">
          <Logo size={32} withText={true} />
          <p className="text-xs text-muted-foreground ml-11">Administration</p>
        </div>
      </div>

      {/* Scrollable Nav */}
      <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
        <nav className="flex-1 space-y-1 px-3 py-4">
          {ADMIN_NAVIGATION.map((item) => {
            const isActive = pathname === item.href ||
              (item.href !== '/admin' && pathname.startsWith(item.href));
            return (
              <Link
                key={item.name}
                href={item.href}
                onClick={onNavigate}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                }`}
              >
                <item.icon className="h-5 w-5 flex-shrink-0" />
                {item.name}
              </Link>
            );
          })}
        </nav>

        {/* Footer Actions */}
        <div className="border-t p-3 space-y-2 mt-auto flex-shrink-0">
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={handleBackToApp}
          >
            <Home className="h-4 w-4 mr-2" />
            Retour au site
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start text-destructive hover:text-destructive"
            onClick={handleLogout}
          >
            <LogOut className="h-4 w-4 mr-2" />
            Se déconnecter
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AdminSidebar() {
  return (
    <div className="h-full">
      <SidebarContent />
    </div>
  );
}

export function AdminMobileHeader() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile top bar */}
      <div className="flex items-center justify-between h-14 px-4 border-b bg-card md:hidden flex-shrink-0">
        <div className="flex flex-col">
          <Logo size={24} withText={true} />
          <p className="text-[10px] text-muted-foreground ml-9">Administration</p>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="p-2 rounded-lg hover:bg-accent transition-colors"
          aria-label="Ouvrir le menu"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      {/* Mobile drawer overlay */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={() => setOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 w-72 md:hidden">
            <div className="relative h-full">
              <button
                onClick={() => setOpen(false)}
                className="absolute top-3 right-3 z-10 p-1.5 rounded-lg hover:bg-accent transition-colors"
                aria-label="Fermer le menu"
              >
                <X className="h-4 w-4" />
              </button>
              <SidebarContent onNavigate={() => setOpen(false)} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
