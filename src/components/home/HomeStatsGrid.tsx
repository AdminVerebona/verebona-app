"use client"

import { CalendarDays, CircleAlert, FileText, Package } from 'lucide-react';
import Link from 'next/link';

interface HomeStatsGridProps {
  biens: number;
  evenements: number;
  documents: number;
  aTraiter: number;
}

const TILE = [
  { key: 'biens', label: 'Mes biens', href: '/assets', icon: Package, cls: 'text-blue-400 bg-blue-500/15 border-blue-500/30' },
  { key: 'evenements', label: 'Événements', href: '/agenda', icon: CalendarDays, cls: 'text-amber-400 bg-amber-500/15 border-amber-500/30' },
  { key: 'documents', label: 'Documents', href: '/documents', icon: FileText, cls: 'text-emerald-400 bg-emerald-500/15 border-emerald-500/30' },
  { key: 'aTraiter', label: 'À traiter', href: '/accueil/a-traiter', icon: CircleAlert, cls: 'text-red-400 bg-red-500/15 border-red-500/30' },
] as const;

/** « En un coup d'œil » — 4 compteurs cliquables, grille 2×2, s'étire à la hauteur de la colonne voisine. */
export function HomeStatsGrid(props: HomeStatsGridProps) {
  return (
    <div className="flex flex-col h-full">
      <span className="text-xs font-semibold uppercase tracking-widest text-[color:var(--text-muted)] mb-2.5">
        En un coup d'œil
      </span>
      <div className="grid grid-cols-2 auto-rows-fr gap-3 flex-1">
        {TILE.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            className="flex items-center gap-3 px-4 py-3.5 rounded-xl bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] hover:border-[color:var(--text-muted)] transition-all"
          >
            <span className={`w-9 h-9 rounded-lg border flex items-center justify-center flex-shrink-0 ${t.cls}`}>
              <t.icon className="w-4 h-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-[10.5px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">{t.label}</span>
              <span className="block text-xl font-semibold text-[color:var(--text-primary)]">{props[t.key]}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
