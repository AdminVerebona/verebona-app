"use client";

/**
 * Panneau du compte — mobile, ouvert par l'avatar de la barre haute.
 *
 * Direction D v2, maquette mobile : la barre haute porte le champ Verebona et
 * l'avatar ; la barre basse porte les CINQ onglets (Agenda compris,
 * répartition 2b) et le « + ». Ce panneau ne contient donc que le compte :
 * identité, notifications, Mon compte, aide, administration (si admin),
 * thème, déconnexion confirmée. La mascotte accueille, comme sur l'accueil.
 */
import { useState } from 'react';
import Link from 'next/link';
import { Bell, ChevronRight, HelpCircle, LogOut, Moon, Shield, Sun, User, X } from 'lucide-react';
import { NotificationBell } from '@/components/NotificationBell';
import { ConfirmLogoutDialog } from '@/components/ConfirmLogoutDialog';
import { MascotPose } from '@/components/verebona/space/MascotPose';

export interface MobileAccountPanelProps {
  open: boolean;
  onClose: () => void;
  pathname: string;
  /** « Bonjour, … » : nom d'utilisateur, à défaut prénom. */
  greetingName: string;
  /** Nom de la personne (prénom + initiale), jamais celui du compte. */
  personName: string;
  initials: string;
  planLabel: string;
  /** Espace courant, affiché seulement si l'utilisateur en a plusieurs. */
  accountName?: string | null;
  isAdmin: boolean;
  theme: string;
  onToggleTheme: () => void;
  onOpenHelp: () => void;
  onLogout: () => void;
  /** Cloche des notifications (désactivable pour un aperçu sans session). */
  showBell?: boolean;
}

export function MobileAccountPanel({
  open, onClose, pathname, greetingName, personName, initials, planLabel, accountName, isAdmin,
  theme, onToggleTheme, onOpenHelp, onLogout, showBell = true,
}: MobileAccountPanelProps) {
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  return (
    <>
      {open && (
        <div className="fixed inset-0 z-[60] md:hidden">
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={() => onClose()} />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Compte et réglages"
            className="fixed inset-y-0 right-0 flex w-[86%] max-w-sm flex-col overflow-y-auto rounded-l-[28px] border-l border-[color:var(--border-subtle)] bg-[color:var(--sidebar)] shadow-relief-2xl [animation:vb-slide-in-right_.25s_cubic-bezier(.16,1,.3,1)]"
          >
            {/* En-tête : la mascotte salue, cloche et fermeture */}
            <div className="flex items-start gap-3 px-5 pb-4 pt-[max(18px,env(safe-area-inset-top))]">
              <div className="relative flex h-[58px] w-[58px] flex-shrink-0 items-end justify-center">
                <span aria-hidden className="absolute -inset-1.5 rounded-full" style={{ background: 'radial-gradient(closest-side, rgba(59,130,246,.32), rgba(59,130,246,0))' }} />
                <MascotPose pose="welcome-wave" size={56} style={{ position: 'relative', filter: 'drop-shadow(0 10px 14px rgba(4,10,26,.55))' }} />
              </div>
              <div className="min-w-0 flex-1 pt-1.5">
                <p className="m-0 truncate text-[17px] font-semibold tracking-[-0.01em] text-[color:var(--text-primary)]">
                  Bonjour{greetingName ? `, ${greetingName}` : ''}
                </p>
                <p className="m-0 mt-0.5 text-[12.5px] text-[color:var(--text-muted)]">Compte et réglages</p>
              </div>
              <div className="flex flex-shrink-0 items-center">
                {showBell && <NotificationBell />}
                <button
                  onClick={() => onClose()}
                  aria-label="Fermer"
                  className="flex h-11 w-11 items-center justify-center rounded-xl text-[color:var(--text-muted)] hover:bg-[color:var(--accent-soft)]"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Identité : la personne, son offre, l'espace courant */}
            <Link
              href="/mon-compte"
              onClick={() => onClose()}
              className="mx-4 flex items-center gap-3 rounded-[18px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3.5 transition-colors hover:border-[color:var(--border)]"
            >
              <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] text-sm font-semibold text-white">
                {initials}
              </span>
              <span className="min-w-0 flex-1">
                {/* Le nom de la personne, non celui du compte. */}
                <span className="block truncate text-sm font-semibold text-[color:var(--text-primary)]">
                  {personName}
                </span>
                <span className="mt-1 inline-block rounded-full bg-[color:var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--accent)]">
                  {planLabel}
                </span>
                {accountName && (
                  <span className="mt-1 block truncate text-xs text-[color:var(--text-muted)]">{accountName}</span>
                )}
              </span>
              <ChevronRight className="h-4 w-4 flex-shrink-0 text-[color:var(--text-muted)]" aria-hidden />
            </Link>

            <nav className="flex-1 space-y-0.5 p-3 pt-4" aria-label="Compte">
              {[
                { href: '/mon-compte', label: 'Mon compte', icon: User },
                { href: '/mon-compte/notifications', label: 'Notifications', icon: Bell },
                ...(isAdmin ? [{ href: '/admin', label: 'Administration', icon: Shield }] : []),
              ].map((e) => (
                <Link
                  key={e.href}
                  href={e.href}
                  onClick={() => onClose()}
                  aria-current={pathname === e.href ? 'page' : undefined}
                  className={`flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm transition-colors hover:bg-[color:var(--accent-soft)] ${pathname === e.href ? 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]' : 'text-[color:var(--text-primary)]'}`}
                >
                  <e.icon className="h-5 w-5 flex-shrink-0" aria-hidden />
                  <span>{e.label}</span>
                </Link>
              ))}
              <button
                onClick={() => { onClose(); onOpenHelp(); }}
                className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-sm text-[color:var(--text-primary)] transition-colors hover:bg-[color:var(--accent-soft)]"
              >
                <HelpCircle className="h-5 w-5 flex-shrink-0" aria-hidden />
                <span>Besoin d&apos;aide ?</span>
              </button>
              <button
                onClick={onToggleTheme}
                className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-sm text-[color:var(--text-primary)] transition-colors hover:bg-[color:var(--accent-soft)]"
              >
                {theme === 'blue' ? <Sun className="h-5 w-5 flex-shrink-0" aria-hidden /> : <Moon className="h-5 w-5 flex-shrink-0" aria-hidden />}
                <span>{theme === 'blue' ? 'Thème clair' : 'Thème sombre'}</span>
              </button>
            </nav>

            {/* Isolé en bas, et confirmé : une déconnexion s'atteint vite par mégarde. */}
            <div className="border-t border-[color:var(--border-subtle)] p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
              <button
                onClick={() => setLogoutConfirm(true)}
                className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-sm text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--text-primary)]"
              >
                <LogOut className="h-5 w-5 flex-shrink-0" aria-hidden />
                <span>Se déconnecter</span>
              </button>
            </div>
          </aside>
        </div>
      )}
      <ConfirmLogoutDialog
        open={logoutConfirm}
        onOpenChange={setLogoutConfirm}
        onConfirm={() => { onClose(); onLogout(); }}
      />
    </>
  );
}
