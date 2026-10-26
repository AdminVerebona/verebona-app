'use client';
/**
 * Menu latéral — Direction D v2 §3.1.
 *
 * 240 px, repliable à 64 px par le bouton en tête, à droite du logo
 * (« Réduire le menu » / « Déployer le menu »). Replié : icônes seules,
 * libellés en infobulle, pastille « À traiter » sur l'icône ; le logo et le
 * nom Verebona passent alors en tête du header (TopBar `showBrand`) : la
 * marque reste toujours visible en haut à gauche.
 * En tête de la navigation, le bouton « + Ajouter » (document, échéance, bien),
 * qui ouvre le même panneau que le « + » de la barre basse mobile.
 * Élément actif : fond `accent-soft`, texte accent, bordure gauche 2 px.
 * Charte « Sérénité » 2026 (lot 66) : fond `--sidebar` (#F2F0EA / #161F23),
 * « + Ajouter » en bouton primaire pétrole plein (sans dégradé), pastille
 * « À traiter » cuivre texte (#AA4E38 ; sombre #D66B53, chiffre encre).
 * Pas de pied de compte (bouton bas-gauche retiré le 5 oct. 2026, doublon de
 * l'avatar du header) : le compte s'ouvre par l'avatar du header.
 */
import Link from 'next/link';
import { CalendarDays, CircleAlert, FileText, House, Package, Plus, type LucideIcon } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { badgeLabel, sidebarToggleLabel, sidebarWidth } from '@/lib/shell/sidebar-state';

interface NavEntry {
  name: string;
  href: string;
  icon: LucideIcon;
  /** Repère du parcours guidé (onboarding). */
  dataGuide?: string;
  /** Entrée active : `exact` pour l'accueil (« À traiter » en est une sous-page). */
  exact?: boolean;
}

export const NAV_ENTRIES: NavEntry[] = [
  { name: 'Accueil', href: '/accueil', icon: House, exact: true },
  { name: 'Mes biens', href: '/assets', icon: Package },
  { name: 'Mon agenda', href: '/agenda', icon: CalendarDays },
  { name: 'Mes documents', href: '/documents', icon: FileText },
  { name: 'À traiter', href: '/accueil/a-traiter', icon: CircleAlert, dataGuide: 'treat-incomplete' },
];

export function isNavActive(entry: Pick<NavEntry, 'href' | 'exact'>, pathname: string): boolean {
  if (entry.exact) return pathname === entry.href;
  if (entry.href === '/accueil/a-traiter' && pathname.startsWith('/dashboard/a-traiter')) return true;
  return pathname === entry.href || pathname.startsWith(`${entry.href}/`);
}

/** Icône « panneau » du prototype (rectangle + séparation verticale). */
function PanelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16" />
    </svg>
  );
}

interface AppSidebarProps {
  pathname: string;
  collapsed: boolean;
  onToggle: () => void;
  toProcessCount: number | null;
  /** Carte d'essai, affichée menu déplié. */
  footerSlot?: React.ReactNode;
  /** Bouton « + Ajouter » en tête de la navigation (absent si non fourni). */
  /** Reçoit le clic : le menu « Ajouter » s'accroche au bouton (lot 53b). */
  onAdd?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export function AppSidebar({ pathname, collapsed, onToggle, toProcessCount, footerSlot, onAdd }: AppSidebarProps) {
  const label = sidebarToggleLabel(collapsed);
  const badge = badgeLabel(toProcessCount);

  return (
    <aside
      aria-label="Navigation principale"
      className="hidden flex-shrink-0 flex-col overflow-hidden border-r border-[color:var(--border-subtle)] bg-[color:var(--sidebar)] transition-[width] duration-[180ms] ease-[cubic-bezier(.2,.7,.2,1)] md:flex"
      style={{ width: sidebarWidth(collapsed) }}
    >
      <div className={`flex h-[60px] flex-shrink-0 items-center gap-2 ${collapsed ? 'justify-center px-2.5' : 'pl-[18px] pr-2.5'}`}>
        {!collapsed && (
          <Link href="/accueil" className="min-w-0 flex-1 select-none whitespace-nowrap" aria-label="Verebona, accueil">
            <Logo size={24} withText />
          </Link>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggle}
              aria-label={label}
              aria-expanded={!collapsed}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] text-[color:var(--text-muted)] transition-colors duration-[180ms] hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--text-primary)]"
            >
              <PanelIcon />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      </div>

      {onAdd && (
        <div className="flex-shrink-0 px-2.5 pb-3 pt-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onAdd}
                aria-label={collapsed ? 'Ajouter un document, une échéance ou un bien' : undefined}
                className={`flex h-10 w-full items-center gap-2 whitespace-nowrap rounded-[12px] bg-[color:var(--accent)] text-[14px] font-bold text-[color:var(--on-accent)] transition-colors duration-[180ms] hover:bg-[color:var(--accent-hover)] ${collapsed ? 'justify-center px-0' : 'justify-center px-3'}`}
              >
                <Plus className="h-[18px] w-[18px] flex-shrink-0" strokeWidth={2.4} aria-hidden />
                {!collapsed && <span>Ajouter</span>}
              </button>
            </TooltipTrigger>
            {collapsed && <TooltipContent side="right">Ajouter</TooltipContent>}
          </Tooltip>
        </div>
      )}

      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-2.5 py-1">
        {NAV_ENTRIES.map((item) => {
          const active = isNavActive(item, pathname);
          const itemBadge = item.href === '/accueil/a-traiter' ? badge : null;
          const link = (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              aria-label={collapsed ? (itemBadge ? `${item.name}, ${itemBadge}` : item.name) : undefined}
              {...(item.dataGuide ? { 'data-guide': item.dataGuide } : {})}
              className={`relative flex h-10 items-center gap-3 whitespace-nowrap rounded-[12px] border-l-2 px-3 text-[14px] transition-colors duration-[180ms] ${
                collapsed ? 'justify-center px-0' : ''
              } ${
                active
                  ? 'border-[color:var(--accent)] bg-[color:var(--accent-soft)] font-semibold text-[color:var(--accent)]'
                  : 'border-transparent font-medium text-[color:var(--text-muted)] hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--text-primary)]'
              }`}
            >
              <item.icon className="h-4 w-4 flex-shrink-0" aria-hidden />
              {!collapsed && <span className="flex-1">{item.name}</span>}
              {itemBadge && (
                <span
                  data-badge="a-traiter"
                  className={`inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[color:var(--badge-todo)] px-[5px] text-[10px] font-bold tabular-nums text-[color:var(--on-badge-todo)] ${collapsed ? 'absolute right-1 top-1' : ''}`}
                  aria-hidden={collapsed ? true : undefined}
                >
                  {itemBadge}
                </span>
              )}
            </Link>
          );
          if (!collapsed) return link;
          return (
            <Tooltip key={item.href}>
              <TooltipTrigger asChild>{link}</TooltipTrigger>
              <TooltipContent side="right">{item.name}</TooltipContent>
            </Tooltip>
          );
        })}
      </nav>

      {!collapsed && footerSlot}

      {/* Pied du menu (avatar, nom, offre) retiré le 5 oct. 2026 : doublon de
          l'avatar du header, et il affichait « Aucune offre » tant que les
          droits n'étaient pas chargés. Le compte s'ouvre par l'avatar. */}
      <div className="mt-auto" />
    </aside>
  );
}
