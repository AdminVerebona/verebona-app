"use client"

import Link from 'next/link';
import type { HomeItem } from '@/services/home/HomeSummaryService';

interface Props {
  items: HomeItem[];
  total: number;
  onItemClick?: (item: HomeItem) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDateParts(dateStr: string): { day: string; month: string; year: string | null } {
  const d = new Date(dateStr + 'T12:00:00');
  const currentYear = new Date().getFullYear();
  return {
    day: d.getDate().toString(),
    month: d.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', ''),
    year: d.getFullYear() !== currentYear ? String(d.getFullYear()) : null,
  };
}

// ── Styles des badges ─────────────────────────────────────────────────────────

interface BadgeConfig {
  dot: string;
  text: string;
  container: string;
}

const BADGE_CONFIG: Record<string, BadgeConfig> = {
  'Action attendue': {
    dot: 'bg-amber-400',
    text: 'text-amber-300',
    container: 'bg-amber-500/15 border border-amber-500/25',
  },
  'À prévoir': {
    dot: 'bg-blue-400',
    text: 'text-blue-300',
    container: 'bg-blue-500/15 border border-blue-500/25',
  },
  'Information': {
    dot: 'bg-teal-400',
    text: 'text-teal-300',
    container: 'bg-teal-500/15 border border-teal-500/25',
  },
  'Terminé': {
    dot: 'bg-[#64748b]',
    text: 'text-[#64748b]',
    container: 'bg-[rgba(100,116,139,0.1)] border border-[rgba(100,116,139,0.15)]',
  },
  'En retard': {
    dot: 'bg-red-400',
    text: 'text-red-400',
    container: 'bg-red-500/15 border border-red-500/25',
  },
  'Sans date': {
    dot: 'bg-[#64748b]',
    text: 'text-[#64748b]',
    container: 'bg-[rgba(100,116,139,0.1)] border border-[rgba(100,116,139,0.15)]',
  },
};

function getBadgeConfig(badge: string): BadgeConfig {
  return BADGE_CONFIG[badge] ?? BADGE_CONFIG['Information'];
}

// ── Couleur de la date selon le statut ────────────────────────────────────────

function dateColor(displayStatus: string): { day: string; month: string } {
  if (displayStatus === 'terminee' || displayStatus === 'passee') {
    return { day: 'text-[#475569]', month: 'text-[#334155]' };
  }
  if (displayStatus === 'en_retard') {
    return { day: 'text-red-400', month: 'text-red-400/60' };
  }
  if (displayStatus === 'a_faire') {
    return { day: 'text-amber-400', month: 'text-amber-400/60' };
  }
  if (displayStatus === 'a_prevoir') {
    return { day: 'text-blue-400', month: 'text-blue-400/60' };
  }
  if (displayStatus === 'information') {
    return { day: 'text-teal-400', month: 'text-teal-400/60' };
  }
  // fallback
  return { day: 'text-[#60a5fa]', month: 'text-[#60a5fa]/60' };
}

// ── Style de carte selon le badge ──────────────────────────────────────────────

function cardBorderHover(badge: string): string {
  if (badge === 'À prévoir') return 'hover:border-blue-500/30';
  if (badge === 'Information') return 'hover:border-teal-500/30';
  return 'hover:border-[#3b82f6]/30';
}

function cardBg(badge: string): string {
  if (badge === 'À prévoir') return 'bg-blue-500/[0.04]';
  if (badge === 'Information') return 'bg-teal-500/[0.04]';
  return '';
}

// ── Carte item (partagée mobile + desktop) ─────────────────────────────────────

function ItemCard({ item, onItemClick }: { item: HomeItem; onItemClick?: (item: HomeItem) => void }) {
  const cfg = getBadgeConfig(item.badge);
  const colors = dateColor(item.displayStatus);
  const hoverBorder = cardBorderHover(item.badge);
  const extraBg = cardBg(item.badge);

  return (
    <button
      onClick={() => onItemClick?.(item)}
      className={`rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3 text-left cursor-pointer transition-colors group ${hoverBorder} ${extraBg}`}
    >
      {/* Date row */}
      <div className="flex items-center gap-2 mb-1.5">
        {item.date ? (
          <span className={`text-sm font-bold ${colors.day} leading-none`}>
            {parseDateParts(item.date).day}
            <span className={`text-[10px] font-medium uppercase ml-0.5 ${colors.month}`}>
              {parseDateParts(item.date).month}
            </span>
            {parseDateParts(item.date).year && (
              <span className={`text-[9px] font-medium ml-0.5 ${colors.month}`}>
                {parseDateParts(item.date).year}
              </span>
            )}
          </span>
        ) : (
          <span className="text-xs font-bold text-[#475569]">—</span>
        )}
      </div>

      {/* Title */}
      <p className="text-sm font-semibold text-[color:var(--text-primary)] leading-snug truncate mb-1">
        {item.title}
      </p>

      {/* Badge + context */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <div className={`flex-shrink-0 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${cfg.container}`}>
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cfg.dot}`} />
          <span className={cfg.text}>{item.badge}</span>
        </div>
        {item.context && (
          <span className="text-[11px] text-[color:var(--text-muted)] truncate">{item.context}</span>
        )}
      </div>
    </button>
  );
}

export function ProchainsDatesBlock({ items, total, onItemClick }: Props) {
  if (total === 0) return null;

  // — Vue mobile : 1 "À prévoir" + 1 "Information"
  const mobileActionItem = items.find(i => i.badge === 'À prévoir');
  const mobileInfoItem = items.find(i => i.badge === 'Information');
  const mobileItems = [mobileActionItem, mobileInfoItem].filter(Boolean) as HomeItem[];

  // — Vue desktop : colonnes séparées
  const aPrevoirItems = items.filter(i => i.badge === 'À prévoir').slice(0, 3);
  const infoItems = items.filter(i => i.badge === 'Information').slice(0, 3);
  const hasDesktopContent = aPrevoirItems.length > 0 || infoItems.length > 0;

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-[color:var(--text-muted)]">Prochaines dates</h3>
        <Link
          href="/agenda"
          className="flex items-center gap-1 text-xs text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors"
        >
          Tout afficher
        </Link>
      </div>

      {/* Mobile : 2 items max (1 à prévoir + 1 information) */}
      {mobileItems.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:hidden">
          {mobileItems.map(item => (
            <ItemCard key={item.id} item={item} onItemClick={onItemClick} />
          ))}
        </div>
      )}

      {/* Desktop : 2 colonnes séparées */}
      {hasDesktopContent && (
        <div className="hidden sm:grid sm:grid-cols-2 gap-6">
          {/* Colonne À prévoir */}
          <div className="flex flex-col gap-3">
            <h4 className="text-[10px] font-semibold uppercase tracking-widest text-blue-400/70">À prévoir</h4>
            {aPrevoirItems.length > 0 ? (
              aPrevoirItems.map(item => (
                <ItemCard key={item.id} item={item} onItemClick={onItemClick} />
              ))
            ) : (
              <p className="text-xs text-[color:var(--text-muted)] italic">Aucune échéance à prévoir</p>
            )}
          </div>

          {/* Colonne Information */}
          <div className="flex flex-col gap-3">
            <h4 className="text-[10px] font-semibold uppercase tracking-widest text-teal-400/70">Information</h4>
            {infoItems.length > 0 ? (
              infoItems.map(item => (
                <ItemCard key={item.id} item={item} onItemClick={onItemClick} />
              ))
            ) : (
              <p className="text-xs text-[color:var(--text-muted)] italic">Aucune information</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

