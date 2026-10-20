"use client"
/**
 * Header desktop — Direction D v2 §3.1, §5.
 *
 * 60 px, sans fil d'Ariane ni titre de page sur l'accueil. Au centre, le
 * champ Verebona (le même sur toutes les pages) ; à droite, l'analyse en
 * cours, les notifications et l'avatar (menu du compte).
 *
 * Le logo vit dans le menu latéral (§3.1) ; menu replié (64 px, trop étroit
 * pour le nom), il passe ici, à gauche (`showBrand`) : icône et nom Verebona
 * restent toujours visibles. « Bonjour, … » seulement dans la bulle de la
 * mascotte, sur l'accueil (§2).
 */
import { Fragment, useState } from 'react'
import Link from 'next/link'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Logo } from './Logo'
import { NotificationBell } from './NotificationBell'
import { AnalysisBanner } from './AnalysisBanner'
import { ConfirmLogoutDialog } from './ConfirmLogoutDialog'
import { getPlanLabel } from '@/lib/plan-label'
import { formatUserDisplayName, formatUserInitials } from '@/lib/user-display-name'
import { VerebonaHeaderField } from './verebona/space/VerebonaField'
import { accountMenuEntries } from '@/lib/shell/account-menu'
import { AccountSwitcher } from './account/AccountSwitcher'

interface TopBarUser {
  firstName: string
  lastName: string
  username?: string | null
  email: string
  accountName?: string
  role?: string
  subscription: {
    plan: string
    trialStatus?: 'none' | 'active' | 'expired' | 'converted'
    trialDaysLeft?: number | null
  }
  duoRole?: 'BILLING_OWNER' | 'MEMBER'
  /** Lot 72D : nombre d'espaces (sélecteur visible à partir de 2). */
  accountsCount?: number
}

interface TopBarProps {
  user: TopBarUser
  theme: string
  onToggleTheme: () => void
  onLogout: () => void
  isAdmin: boolean
  onOpenHelp?: () => void
  /** Logo + nom Verebona à gauche (quand le menu latéral est replié). */
  showBrand?: boolean
}

export function TopBar({ user, theme, onToggleTheme, onLogout, isAdmin, onOpenHelp, showBrand = false }: TopBarProps) {
  const [logoutConfirm, setLogoutConfirm] = useState(false)

  // Même source et même format que le panneau du compte mobile (L33-2).
  const displayName = formatUserDisplayName(user)
  const initials = formatUserInitials(user)
  const plan = (user.subscription.plan || 'STANDARD').toUpperCase()

  return (
    <header className="relative z-[33] hidden h-[60px] flex-shrink-0 items-center gap-3.5 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-page)] px-7 md:flex">
      {showBrand && (
        <Link href="/accueil" className="flex-shrink-0 select-none whitespace-nowrap" aria-label="Verebona, accueil">
          <Logo size={24} withText />
        </Link>
      )}
      <VerebonaHeaderField />

      <div className="relative z-[33] ml-auto flex items-center gap-2.5">
        <AnalysisBanner />
        <NotificationBell />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Mon compte"
              className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[color:var(--accent)] text-[12px] font-bold text-[color:var(--on-accent)] transition-colors duration-[180ms] hover:bg-[color:var(--accent-hover)]"
            >
              {initials}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <div className="flex items-center gap-3 px-3 py-2.5">
              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] text-sm font-bold text-[color:var(--on-accent)]">
                {initials}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{displayName}</p>
                <p className="truncate text-xs text-[color:var(--text-muted)]">{user.email}</p>
                <p className="mt-0.5 text-xs font-semibold text-[color:var(--accent)]">
                  {getPlanLabel({
                    plan,
                    duoRole: user.duoRole,
                    trialStatus: user.subscription.trialStatus,
                    trialDaysLeft: user.subscription.trialDaysLeft,
                  })}
                </p>
              </div>
            </div>
            {/* Lot 72D (Q6) : changement d'espace, dès deux espaces — même
                composant que le panneau du compte mobile. */}
            {(user.accountsCount ?? 1) >= 2 && (
              <>
                <DropdownMenuSeparator />
                <AccountSwitcher accountsCount={user.accountsCount} variant="menu" />
              </>
            )}
            {/* Entrées : source unique partagée avec le panneau mobile (L35-4). */}
            {accountMenuEntries({ isAdmin, theme, withHelp: !!onOpenHelp }).map((e, i, all) => {
              const Icon = e.icon
              const sep = i === 0 || all[i - 1].group !== e.group
              const item = e.href ? (
                <DropdownMenuItem asChild>
                  <Link href={e.href} className="flex cursor-pointer items-center">
                    <Icon className="mr-2 h-4 w-4" /><span>{e.label}</span>
                  </Link>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onClick={e.id === 'help' ? onOpenHelp : e.id === 'theme' ? onToggleTheme : () => setLogoutConfirm(true)}
                  // Charte 2026 : le rouge est réservé aux retards stricts et aux erreurs
                  // bloquantes ; la déconnexion (confirmée) reste neutre.
                  className="cursor-pointer"
                >
                  <Icon className="mr-2 h-4 w-4" /><span>{e.label}</span>
                </DropdownMenuItem>
              )
              return (
                <Fragment key={e.id}>
                  {sep && <DropdownMenuSeparator />}
                  {item}
                </Fragment>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ConfirmLogoutDialog open={logoutConfirm} onOpenChange={setLogoutConfirm} onConfirm={onLogout} />
    </header>
  )
}
