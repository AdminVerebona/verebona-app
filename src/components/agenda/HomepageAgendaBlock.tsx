"use client"

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { CalendarDays, AlertCircle, Plus } from 'lucide-react';
import dynamic from 'next/dynamic';
import { apiClient } from '@/lib/api-client';
import type { AgendaItemFull } from '@/services/agenda/AgendaQueryService';
import { CreateAgendaItemDrawer } from './CreateAgendaItemDrawer';

const AgendaItemDrawer = dynamic(
  () => import('@/components/agenda/AgendaItemDrawer').then(m => ({ default: m.AgendaItemDrawer })),
  { ssr: false }
);

type EffectiveStatus = 'a_venir' | 'en_retard' | 'realise' | 'annule';

const STATUS_STYLES: Record<EffectiveStatus, { label: string; className: string }> = {
  a_venir:   { label: 'À venir',   className: 'bg-[rgba(59,130,246,0.15)] text-[#93c5fd] border border-[rgba(59,130,246,0.25)]' },
  en_retard: { label: 'En retard', className: 'bg-[rgba(239,68,68,0.15)] text-[#fca5a5] border border-[rgba(239,68,68,0.25)]' },
  realise:   { label: 'Réalisé',   className: 'bg-[rgba(34,197,94,0.15)] text-[#86efac] border border-[rgba(34,197,94,0.25)]' },
  annule:    { label: 'Annulé',    className: 'bg-[rgba(148,163,184,0.12)] text-[#94a3b8] border border-[rgba(148,163,184,0.2)]' },
};

function parseDateParts(d: string | null): { day: string; month: string; dayLabel: string } {
  if (!d) return { day: 'TBD', month: '', dayLabel: '' };

  const date = new Date(d + 'T12:00:00');
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const todayStr = today.toISOString().slice(0, 10);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const day = date.getDate().toString().padStart(2, '0');
  const month = date.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '').toUpperCase();

  let dayLabel = '';
  if (d === todayStr) dayLabel = "Aujourd'hui";
  else if (d === tomorrowStr) dayLabel = 'Demain';
  else dayLabel = date.toLocaleDateString('fr-FR', { weekday: 'long' });
  // Capitalize first letter
  dayLabel = dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1);

  return { day, month, dayLabel };
}

interface Props {
  onMutated?: () => void;
}

export function HomepageAgendaBlock({ onMutated }: Props) {
  const [items, setItems] = useState<AgendaItemFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedItem, setSelectedItem] = useState<AgendaItemFull | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    setLoading(true);
    apiClient.get<{ items: AgendaItemFull[] }>('/api/agenda/homepage')
      .then(d => setItems(d.items ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const handleMutated = () => {
    setRefreshKey(k => k + 1);
    setSelectedItem(null);
    onMutated?.();
  };

  // Refresh when any agenda mutation happens elsewhere (e.g. from DocumentDrawer)
  useEffect(() => {
    const handler = () => setRefreshKey(k => k + 1);
    window.addEventListener('agenda-mutated', handler);
    return () => window.removeEventListener('agenda-mutated', handler);
  }, []);

  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-[72px] w-full rounded-xl" />)}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-[color:var(--text-muted)]">
          Mon agenda
        </h3>
        <Link href="/agenda" className="text-xs text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors">
          Tout afficher
        </Link>
      </div>

      {items.length === 0 ? (
        <div className="bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] rounded-2xl shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 py-4 px-5">
            <div className="flex items-center gap-4 min-w-0">
              <div className="w-8 h-8 rounded-full bg-[rgba(34,197,94,0.12)] flex items-center justify-center flex-shrink-0">
                <CalendarDays className="w-4 h-4 text-[#22c55e]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[color:var(--text-primary)]">Aucun élément pour le moment</p>
                <p className="text-xs text-[color:var(--text-muted)] mt-0.5">Créez votre premier élément d'agenda</p>
              </div>
            </div>
            <Button onClick={() => setShowCreate(true)} className="btn-add px-4 w-full sm:w-auto flex-shrink-0">
              <Plus className="btn-add-plus-icon w-4 h-4 mr-2" />
              Ajouter un élément
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {items.map(item => {
            const { day, month, dayLabel } = parseDateParts(item.startDate);
            const status = STATUS_STYLES[item.effectiveStatus];
            const isTbd = !item.startDate;

            return (
              <div
                key={item.id}
                className="flex items-center gap-3 bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] rounded-xl px-4 py-3 cursor-pointer transition-all duration-200 hover:border-[rgba(59,130,246,0.35)] hover:bg-[rgba(59,130,246,0.04)] hover:shadow-[0_4px_20px_rgba(0,0,0,0.25)]"
                onClick={() => setSelectedItem(item)}
              >
                {/* Date block */}
                <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-[rgba(59,130,246,0.15)] border border-[rgba(59,130,246,0.2)] flex flex-col items-center justify-center">
                  {isTbd ? (
                    <>
                      <span className="text-[11px] font-bold text-[#93c5fd] leading-none">TBD</span>
                      {month && <span className="text-[9px] font-semibold text-[#93c5fd]/60 uppercase mt-0.5">{month}</span>}
                    </>
                  ) : (
                    <>
                      <span className="text-[18px] font-bold text-[#93c5fd] leading-none">{day}</span>
                      <span className="text-[9px] font-semibold text-[#93c5fd]/70 uppercase tracking-wide mt-0.5">{month}</span>
                    </>
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  {dayLabel && (
                    <p className="text-[10px] font-medium text-[color:var(--text-muted)] leading-none mb-1">{dayLabel}</p>
                  )}
                  <div className="flex items-center gap-1.5 min-w-0">
                    <p className="text-sm font-semibold text-[color:var(--text-primary)] truncate leading-snug">{item.title}</p>
                    {item.attentionFlags.length > 0 && (
                      <AlertCircle className="h-3.5 w-3.5 text-orange-400 shrink-0" />
                    )}
                  </div>
                  {item.assetLinks[0] && (
                    <span className="inline-flex items-center mt-1 text-[10px] font-medium text-[color:var(--text-muted)] bg-[color:var(--bg-page)] border border-[color:var(--border-subtle)] rounded-md px-1.5 py-0.5 leading-none">
                      {item.assetLinks[0].assetName}
                      {item.assetLinks.length > 1 && (
                        <span className="ml-1 text-[color:var(--text-muted)]/60">+{item.assetLinks.length - 1}</span>
                      )}
                    </span>
                  )}
                </div>

                {/* Status badge */}
                <span className={`flex-shrink-0 text-[10px] font-semibold rounded-full px-2.5 py-1 leading-none ${status.className}`}>
                  {status.label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <AgendaItemDrawer
        item={selectedItem}
        open={!!selectedItem}
        onClose={() => setSelectedItem(null)}
        onMutated={handleMutated}
        onOpenDocument={(fileId) => {
          setSelectedItem(null);
          window.dispatchEvent(new CustomEvent('open-document-drawer', { detail: { docId: fileId } }));
        }}
      />

      <CreateAgendaItemDrawer
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onMutated={handleMutated}
      />
    </div>
  );
}
