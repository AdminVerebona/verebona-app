"use client"
/**
 * TopBar — maquette « Accueil Assistant » :
 * - Plus de logo/hamburger ici (ils vivent dans la sidebar).
 * - Le champ central est l'entrée de l'assistant : mascotte + « Demander à Verebona »
 *   (clic → drawer via l'événement global `verebona:open`).
 * - Cloche à point rouge (NotificationBell), avatar initiales seul → menu
 *   (Mon compte, thème, déconnexion avec confirmation).
 */
import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { User, LogOut, Shield, Sun, Moon } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { getPlanTheme } from '@/lib/plan-theme'
import { NotificationBell } from './NotificationBell'
import { AnalysisBanner } from './AnalysisBanner'
import { ConfirmLogoutDialog } from './ConfirmLogoutDialog'

interface TopBarUser {
  firstName: string
  lastName: string
  username?: string | null
  email: string
  accountName?: string
  role?: string
  subscription: { plan: string }
  duoRole?: 'BILLING_OWNER' | 'MEMBER'
}

function getPlanLabel(plan: string, duoRole?: 'BILLING_OWNER' | 'MEMBER'): string {
  if (plan === 'PREMIUM_DUO') return duoRole === 'MEMBER' ? 'Premium Duo (membre)' : 'Premium Duo'
  const labels: Record<string, string> = {
    STANDARD: 'Standard',
    PREMIUM: 'Premium',
    PREMIUM_DUO: 'Premium Duo',
    PREMIUM_PRO: 'Premium Pro',
  }
  return labels[plan] ?? plan.toLowerCase()
}

interface TopBarProps {
  user: TopBarUser
  theme: string
  onToggleTheme: () => void
  onLogout: () => void
  isAdmin: boolean
}

export function TopBar({ user, theme, onToggleTheme, onLogout, isAdmin }: TopBarProps) {
  const [logoutConfirm, setLogoutConfirm] = useState(false)

  const displayName = user.username || `${user.firstName} ${user.lastName.charAt(0)}.`
  const initials = `${user.firstName.charAt(0)}${user.lastName.charAt(0)}`.toUpperCase()
  const plan = (user.subscription.plan || 'STANDARD').toUpperCase()

  return (
    <header className="hidden md:flex items-center gap-3 h-14 px-4 border-b border-[color:var(--border-subtle)] bg-[color:var(--sidebar)] flex-shrink-0 sticky top-0 z-30">

      {/* Entrée assistant — remplace la recherche (maquette) */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('verebona:open', { detail: {} }))}
        className="flex items-center gap-2.5 flex-1 max-w-sm h-9 pl-1.5 pr-4 rounded-full bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] text-sm text-[color:var(--text-muted)] hover:border-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-all text-left"
      >
        <Image src="/mascot/welcome-wave.webp" alt="" width={26} height={26} className="select-none flex-shrink-0" />
        <span className="flex-1 truncate">Demander à Verebona</span>
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bandeau analyse en cours */}
      <AnalysisBanner />

      {/* Notifications (point rouge) */}
      <NotificationBell />

      {/* Avatar initiales seul → menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button aria-label="Mon compte" className="rounded-full hover:ring-2 hover:ring-[color:var(--accent-soft)] transition-all">
            <Avatar className="w-8 h-8 shadow-relief-sm">
              <AvatarFallback className={`${getPlanTheme(plan).colors.badge || 'bg-slate-600'} text-white text-sm font-semibold`}>
                {initials}
              </AvatarFallback>
            </Avatar>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60 shadow-relief-lg">
          <div className="px-3 py-2.5 flex items-center gap-3">
            <Avatar className="w-9 h-9 flex-shrink-0">
              <AvatarFallback className={`${getPlanTheme(plan).colors.badge || 'bg-slate-600'} text-white text-sm font-semibold`}>
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{displayName}</p>
              <p className="text-xs text-[color:var(--text-muted)] truncate">{user.email}</p>
              <p className={`text-xs ${getPlanTheme(plan).colors.text} font-medium mt-0.5`}>
                Plan {getPlanLabel(plan, user.duoRole)}
              </p>
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/mon-compte" className="cursor-pointer flex items-center">
              <User className="mr-2 h-4 w-4" /><span>Mon compte</span>
            </Link>
          </DropdownMenuItem>
          {isAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/admin" className="cursor-pointer flex items-center">
                  <Shield className="mr-2 h-4 w-4" /><span>Administration</span>
                </Link>
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onToggleTheme} className="cursor-pointer">
            {theme === 'blue' ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}
            <span>Thème {theme === 'blue' ? 'clair' : 'sombre'}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setLogoutConfirm(true)} className="cursor-pointer text-red-500 focus:text-red-500">
            <LogOut className="mr-2 h-4 w-4" /><span>Se déconnecter</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmLogoutDialog open={logoutConfirm} onOpenChange={setLogoutConfirm} onConfirm={onLogout} />
    </header>
  )
}
