"use client"

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { Plus, CalendarDays, AlertCircle } from 'lucide-react';
import dynamic from 'next/dynamic';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import type { AgendaItemFull } from '@/services/agenda/AgendaQueryService';

const AgendaItemDrawer = dynamic(
  () => import('@/components/agenda/AgendaItemDrawer').then(m => ({ default: m.AgendaItemDrawer })),
  { ssr: false }
);
const CreateAgendaItemDrawer = dynamic(
  () => import('@/components/agenda/CreateAgendaItemDrawer').then(m => ({ default: m.CreateAgendaItemDrawer })),
  { ssr: false }
);

type EffectiveStatus = 'a_venir' | 'en_retard' | 'realise' | 'annule';

const STATUS_LABELS: Record<EffectiveStatus, string> = {
  a_venir: 'À venir',
  en_retard: 'En retard',
  realise: 'Réalisé',
  annule: 'Annulé',
};

const STATUS_COLORS: Record<EffectiveStatus, string> = {
  a_venir: 'bg-blue-100 text-blue-800',
  en_retard: 'bg-red-100 text-red-800',
  realise: 'bg-green-100 text-green-800',
  annule: 'bg-gray-100 text-gray-600',
};

function formatShortDate(d: string | null): string {
  if (!d) return 'Sans date';
  return new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

interface Props {
  assetId: number;
}

type PeriodFilter = 'all' | 'upcoming' | 'past';

export function AssetAgendaTab({ assetId }: Props) {
  const [items, setItems] = useState<AgendaItemFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [period, setPeriod] = useState<PeriodFilter>('all');
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [selectedItem, setSelectedItem] = useState<AgendaItemFull | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        assetIds: String(assetId),
        period,
        includeCancelled: String(includeCancelled),
        includeUndated: 'true',
      });
      const data = await apiClient.get<{ items: AgendaItemFull[] }>(`/api/agenda?${params}`);
      setItems(data.items ?? []);
    } catch {
      toast.error('Erreur lors du chargement');
    } finally {
      setLoading(false);
    }
  }, [assetId, period, includeCancelled, refreshKey]);

  useEffect(() => { load(); }, [load]);

  const onMutated = () => {
    setRefreshKey(k => k + 1);
    setSelectedItem(null);
  };

  // Refresh when any agenda mutation happens elsewhere (e.g. from DocumentDrawer)
  useEffect(() => {
    const handler = () => setRefreshKey(k => k + 1);
    window.addEventListener('agenda-mutated', handler);
    return () => window.removeEventListener('agenda-mutated', handler);
  }, []);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {(['all', 'upcoming', 'past'] as PeriodFilter[]).map(p => (
            <button
              key={p}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${period === p ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'}`}
              onClick={() => setPeriod(p)}
            >
              {p === 'all' ? 'Tout' : p === 'upcoming' ? 'À venir' : 'Passés'}
            </button>
          ))}
          <button
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${includeCancelled ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'}`}
            onClick={() => setIncludeCancelled(v => !v)}
          >
            Annulés
          </button>
        </div>
        {items.length > 0 && (
          <Button variant="secondary" size="sm" onClick={() => setShowCreate(true)} className="btn-add">
            <Plus className="h-4 w-4 btn-add-plus-icon" /> Ajouter
          </Button>
        )}
      </div>

      {/* List */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
        </div>
      ) : items.length === 0 ? (
        <Card className="border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] rounded-2xl shadow-sm">
          <CardContent className="flex items-center gap-4 py-4 px-5">
            <div className="w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
              <CalendarDays className="w-4 h-4 text-emerald-500" />
            </div>
            <div>
              <p className="text-sm font-medium text-[color:var(--text-primary)]">Aucun élément pour le moment</p>
              <p className="text-xs text-[color:var(--text-muted)] mt-0.5">Créez votre premier élément d'agenda</p>
            </div>
            <Button onClick={() => setShowCreate(true)} className="btn-add px-4 flex-shrink-0">
              <Plus className="btn-add-plus-icon w-4 h-4 mr-2" />
              Ajouter un élément
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          {items.map(item => (
            <div
              key={item.id}
              className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40 cursor-pointer border-b last:border-b-0"
              onClick={() => setSelectedItem(item)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{item.title}</span>
                  {item.isAutomatic && !item.isAutomaticModified && (
                    <Badge variant="secondary" className="text-xs shrink-0">Auto</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-muted-foreground">{formatShortDate(item.startDate)}</span>
                  {item.attentionFlags.map(f => (
                    <span key={f} className="inline-flex items-center rounded-full px-1.5 py-0.5 text-xs bg-orange-100 text-orange-800">
                      <AlertCircle className="h-2.5 w-2.5 mr-0.5" />
                      {f === 'sans_bien' ? 'Sans bien' : f === 'donnee_distincte_a_qualifier' ? 'À qualifier' : f}
                    </span>
                  ))}
                </div>
              </div>
              <span className={`shrink-0 mt-0.5 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[item.effectiveStatus]}`}>
                {STATUS_LABELS[item.effectiveStatus]}
              </span>
            </div>
          ))}
        </div>
      )}

      <AgendaItemDrawer
        item={selectedItem}
        open={!!selectedItem}
        onClose={() => setSelectedItem(null)}
        onMutated={onMutated}
        onOpenDocument={(fileId) => {
          setSelectedItem(null);
          window.dispatchEvent(new CustomEvent('open-document-drawer', { detail: { docId: fileId } }));
        }}
      />

      <CreateAgendaItemDrawer
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onMutated={() => setRefreshKey(k => k + 1)}
        prefilledAssetId={assetId}
      />
    </div>
  );
}
