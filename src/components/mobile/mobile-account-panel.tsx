"use client";

/**
 * Panneau du compte — mobile, ouvert par l'avatar de la barre haute.
 *
 * Direction D v2, maquette mobile : la barre haute porte le champ Verebona et
 * l'avatar ; la barre basse porte les CINQ onglets (Agenda compris,
 * répartition 2b) et le « + ». Ce panneau ne contient donc que le compte :
 * identité, notifications, aide, administration (si admin), thème,
 * déconnexion confirmée.
 *
 * Lot 26 :
 *  · l'en-tête « Bonjour, … / Compte et réglages » et sa mascotte sont
 *    retirés — seules la cloche et la fermeture restent, alignées à droite ;
 *  · la carte d'identité (initiales, nom, offre, chevron) ET l'entrée
 *    « Mon compte » menaient au même endroit : l'entrée est retirée. La carte
 *    reste, comme l'en-tête d'identité du menu de l'avatar sur ordinateur
 *    (TopBar), et elle est l'accès à Mon compte (libellé accessible
 *    « Mon compte », état courant marqué).
 *
 * Lot 33 (L33-2) : la carte affiche la même identité que le menu de l'avatar
 * sur ordinateur — nom d'affichage (`formatUserDisplayName`, partagé avec
 * TopBar) puis e-mail.
 *
 * Lot 35 (L35-4) : « Menu mobile non conforme : il y a les notifications et
 * il n'y a pas mon compte ». Les entrées viennent de la MÊME source que le
 * menu de l'avatar sur ordinateur (`accountMenuEntries`,
 * src/lib/shell/account-menu.ts) : Mon compte, Besoin d'aide ?,
 * Administration (admin), thème, déconnexion — dans cet ordre. L'entrée
 * « Notifications » (doublon de la cloche, gardée en en-tête) disparaît.
 * La carte d'identité redevient un en-tête non cliquable, comme sur
 * ordinateur : l'accès à Mon compte est l'entrée explicite.
 */
import { useState } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { NotificationBell } from '@/components/NotificationBell';
import { ConfirmLogoutDialog } from '@/components/ConfirmLogoutDialog';
import { accountMenuEntries } from '@/lib/shell/account-menu';

export interface MobileAccountPanelProps {
  open: boolean;
  onClose: () => void;
  pathname: string;
  /**
   * @deprecated Lot 26 : l'en-tête « Bonjour, … » est retiré ; la valeur est
   * ignorée (conservée pour ne pas modifier l'appelant, DashboardLayout).
   */
  greetingName?: string;
  /**
   * Nom d'affichage de la personne, jamais celui du compte : la valeur de
   * `formatUserDisplayName` (src/lib/user-display-name.ts), la même que le
   * menu de l'avatar sur ordinateur (TopBar) — lot 33, L33-2.
   */
  personName: string;
  /** E-mail de connexion, affiché sous le nom comme sur ordinateur (L33-2). */
  email?: string | null;
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
  open, onClose, pathname, personName, email, initials, planLabel, accountName, isAdmin,
  theme, onToggleTheme, onOpenHelp, onLogout, showBell = true,
}: MobileAccountPanelProps) {
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const entries = accountMenuEntries({ isAdmin, theme });
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
            {/* En-tête : cloche et fermeture, alignées à droite (lot 26). */}
            <div className="flex items-center justify-end gap-1 px-3 pb-2 pt-[max(12px,env(safe-area-inset-top))]">
              {showBell && <NotificationBell />}
              <button
                onClick={() => onClose()}
                aria-label="Fermer"
                className="flex h-11 w-11 items-center justify-center rounded-xl text-[color:var(--text-muted)] hover:bg-[color:var(--accent-soft)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Identité : la personne, son offre, l'espace courant. En-tête non
                cliquable, comme celui du menu de l'avatar sur ordinateur
                (L35-4) ; Mon compte est l'entrée explicite ci-dessous. */}
            <div
              data-testid="account-identity"
              className="mx-4 flex items-center gap-3 rounded-[18px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3.5"
            >
              <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] text-sm font-semibold text-white">
                {initials}
              </span>
              <span className="min-w-0 flex-1">
                {/* Le nom de la personne, non celui du compte. */}
                <span className="block truncate text-sm font-semibold text-[color:var(--text-primary)]">
                  {personName}
                </span>
                {email && (
                  <span className="block truncate text-xs text-[color:var(--text-muted)]">{email}</span>
                )}
                {planLabel && (
                  <span className="mt-1 inline-block rounded-full bg-[color:var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--accent)]">
                    {planLabel}
                  </span>
                )}
                {accountName && (
                  <span className="mt-1 block truncate text-xs text-[color:var(--text-muted)]">{accountName}</span>
                )}
              </span>
            </div>

            {/* Entrées : même source et même ordre que le menu desktop (L35-4).
                La déconnexion, dernière entrée, reste isolée en bas. */}
            <nav className="flex-1 space-y-0.5 p-3 pt-4" aria-label="Compte">
              {entries.filter((e) => e.id !== 'logout').map((e) => {
                const Icon = e.icon;
                const actif = e.href !== undefined && pathname === e.href;
                const cls = `flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-sm transition-colors hover:bg-[color:var(--accent-soft)] ${actif ? 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]' : 'text-[color:var(--text-primary)]'}`;
                const contenu = (<><Icon className="h-5 w-5 flex-shrink-0" aria-hidden /><span>{e.label}</span></>);
                return e.href ? (
                  <Link key={e.id} href={e.href} onClick={() => onClose()} aria-current={actif ? 'page' : undefined} className={cls}>
                    {contenu}
                  </Link>
                ) : (
                  <button
                    key={e.id}
                    type="button"
                    onClick={e.id === 'help' ? () => { onClose(); onOpenHelp(); } : onToggleTheme}
                    className={cls}
                  >
                    {contenu}
                  </button>
                );
              })}
            </nav>

            {/* Isolé en bas, et confirmé : une déconnexion s'atteint vite par mégarde. */}
            <div className="border-t border-[color:var(--border-subtle)] p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
              {entries.filter((e) => e.id === 'logout').map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setLogoutConfirm(true)}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-sm text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--text-primary)]"
                >
                  <e.icon className="h-5 w-5 flex-shrink-0" aria-hidden />
                  <span>{e.label}</span>
                </button>
              ))}
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
