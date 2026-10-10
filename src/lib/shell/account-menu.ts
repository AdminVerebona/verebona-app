/**
 * Entrées du menu du compte — source unique ordinateur / mobile (lot 35, L35-4).
 *
 * Le menu de l'avatar sur ordinateur (`TopBar`) et le panneau du compte sur
 * mobile (`MobileAccountPanel`) avaient chacun leur liste : le mobile
 * affichait « Notifications » (doublon de la cloche) et plus « Mon compte »
 * (retiré au lot 26 au profit de la carte d'identité). Les deux lisent
 * désormais cette fonction : mêmes entrées, même ordre, mêmes libellés.
 *
 * Ordre (celui du menu desktop) :
 *   Mon compte · Besoin d'aide ? | Administration (admin) | Thème | Se déconnecter
 * `group` porte les séparateurs du menu desktop.
 *
 * Les notifications restent accessibles par la cloche (en-tête du menu
 * desktop comme du panneau mobile) ; leurs réglages, depuis Mon compte.
 */
import type { LucideIcon } from 'lucide-react';
import { HelpCircle, LogOut, Moon, Shield, Sun, User } from 'lucide-react';

export type AccountMenuEntryId = 'account' | 'help' | 'admin' | 'theme' | 'logout';

export interface AccountMenuEntry {
  id: AccountMenuEntryId;
  label: string;
  icon: LucideIcon;
  /** Lien interne ; absent pour une action (aide, thème, déconnexion). */
  href?: string;
  /** Bloc du menu : un séparateur entre deux blocs différents. */
  group: number;
}

export interface AccountMenuOptions {
  isAdmin: boolean;
  /** Thème courant (`blue` = sombre : l'entrée propose le thème clair). */
  theme: string;
  /** « Besoin d'aide ? » affiché seulement si l'appelant sait l'ouvrir. */
  withHelp?: boolean;
}

export function themeEntryLabel(theme: string): string {
  return theme === 'blue' ? 'Thème clair' : 'Thème sombre';
}

export function accountMenuEntries({ isAdmin, theme, withHelp = true }: AccountMenuOptions): AccountMenuEntry[] {
  return [
    { id: 'account', label: 'Mon compte', icon: User, href: '/mon-compte', group: 0 },
    ...(withHelp ? [{ id: 'help' as const, label: 'Besoin d’aide ?', icon: HelpCircle, group: 0 }] : []),
    ...(isAdmin ? [{ id: 'admin' as const, label: 'Administration', icon: Shield, href: '/admin', group: 1 }] : []),
    { id: 'theme', label: themeEntryLabel(theme), icon: theme === 'blue' ? Sun : Moon, group: 2 },
    { id: 'logout', label: 'Se déconnecter', icon: LogOut, group: 3 },
  ];
}
