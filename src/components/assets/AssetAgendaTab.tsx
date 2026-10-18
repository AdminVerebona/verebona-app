"use client"

import { useState, useEffect, useCallback } from 'react';
import { EFFECTIVE_STATUS_LABELS, attentionFlagLabel, visibleAttentionFlags, type AgendaEffectiveStatus } from '@/lib/agenda/effective-status';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyStateCard } from '@/components/ui/empty-state-card';
import { Plus, CalendarDays, AlertCircle } from 'lucide-react';
import dynamic from 'next/dynamic';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import type { AgendaItemFull } from '@/services/agenda/AgendaQueryService';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { AgendaViewControls, CalendarView, YearView, currentMonth, type AgendaView } from '@/components/agenda/AgendaPeriodViews';

const AgendaItemDrawer = dynamic(
  () => import('@/components/agenda/AgendaItemDrawer').then(m => ({ default: m.AgendaItemDrawer })),
  { ssr: false }
);
const CreateAgendaItemDrawer = dynamic(
  () => import('@/components/agenda/CreateAgendaItemDrawer').then(m => ({ default: m.CreateAgendaItemDrawer })),
  { ssr: false }
);

// Lot 53 (D17) : libellés partagés — « Statut à confirmer » n'est ni réalisé, ni masqué.
type EffectiveStatus = AgendaEffectiveStatus;

const STATUS_LABELS: Record<EffectiveStatus, string> = EFFECTIVE_STATUS_LABELS;

const STATUS_COLORS: Record<EffectiveStatus, string> = {
  a_venir: 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]',
  en_retard: 'bg-[color:var(--danger-soft)] text-[color:var(--danger)]',
  a_confirmer: 'bg-[color:var(--attention-soft)] text-[color:var(--attention-on-soft)]',
  realise: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)]',
  annule: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-secondary)]',
};

function formatShortDate(d: string | null): string {
  if (!d) return 'Sans date';
  return new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

interface Props {
  assetId: number;
}

type PeriodFilter = 'all' | 'upcoming' | 'past';

/**
 * Onglet Agenda d'un bien. Lot 59 (point 5) : mêmes vues que « Mon agenda »
 * — Liste / Mensuel / Annuel, même sélecteur, même grille (composants
 * partagés `AgendaPeriodViews`), desktop et mobile —, limitées au bien.
 */
export function AssetAgendaTab({ assetId }: Props) {
  const [items, setItems] = useState<AgendaItemFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [view, setView] = useState<AgendaView>('list');
  const [month, setMonth] = useState<string>(() => currentMonth());
  const [year, setYear] = useState<number>(() => new Date().getFullYear());
  const [refreshKey, setRefreshKey] = useState(0);
  const [period, setPeriod] = useState<PeriodFilter>('all');
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [selectedItem, setSelectedItem] = useState<AgendaItemFull | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  // Garde au clic (en plus de celle du tiroir) : le chargement dynamique du
  // tiroir ne doit pas précéder la fenêtre de fin d'essai.
  const { garder } = useWriteGuard();
  const ouvrirCreation = () => garder(() => setShowCreate(true));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Mêmes paramètres que « Mon agenda » : le mois pour la vue mensuelle,
      // l'année (toutes périodes) pour la vue annuelle.
      const params = new URLSearchParams({
        assetIds: String(assetId),
        period: view === 'year' ? 'all' : period,
        includeCancelled: String(includeCancelled),
        includeUndated: 'true',
      });
      if (view === 'calendar') params.set('month', month);
      if (view === 'year') params.set('year', String(year));
      const data = await apiClient.get<{ items: AgendaItemFull[] }>(`/api/agenda?${params}`);
      setItems(data.items ?? []);
    } catch {
      toast.error('Erreur lors du chargement');
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, [assetId, period, includeCancelled, refreshKey, view, month, year]);

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

  // Comme « Mon agenda » : sélecteur masqué seulement si l'agenda du bien est
  // RÉELLEMENT vide (vue Liste, aucun filtre) — un mois vide n'est pas un
  // agenda vide.
  const agendaVide = !loading && items.length === 0 && view === 'list' && period === 'all' && !includeCancelled;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Vue annuelle : toute l'année, comme « Mon agenda » — pas de filtre de période. */}
          {view !== 'year' && (['all', 'upcoming', 'past'] as PeriodFilter[]).map(p => (
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
        {(items.length > 0 || view !== 'list') && (
          <Button variant="secondary" size="sm" onClick={ouvrirCreation} className="btn-add">
            <Plus className="h-4 w-4 btn-add-plus-icon" /> Ajouter
          </Button>
        )}
      </div>

      {/* Lot 59 (point 5) : Liste / Mensuel / Annuel, comme « Mon agenda ». */}
      <AgendaViewControls
        view={view}
        month={month}
        year={year}
        hidden={!loadedOnce || agendaVide}
        label="Affichage de l’agenda du bien"
        onView={setView}
        onMonth={setMonth}
        onYear={setYear}
      />

      {/* Content */}
      {loading ? (
        view === 'year' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {[...Array(12)].map((_, i) => <Skeleton key={i} className="h-48 w-full rounded-2xl" />)}
          </div>
        ) : (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
          </div>
        )
      ) : view === 'year' ? (
        <YearView items={items} year={year} onItemClick={setSelectedItem} />
      ) : view === 'calendar' ? (
        <CalendarView items={items} month={month} onItemClick={setSelectedItem} onNew={ouvrirCreation} />
      ) : items.length === 0 ? (
        <EmptyStateCard
          icon={<CalendarDays className="w-4 h-4 text-[color:var(--text-success)]" />}
          iconClassName="bg-[color:var(--bg-success)]"
          title="Aucun élément pour le moment"
          description="Créez votre premier élément d'agenda"
          actionLabel="Ajouter un élément"
          onAction={ouvrirCreation}
        />
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
                  <span className="text-xs text-muted-foreground">{item.occurrenceNature === 'FORECAST' ? `prévu le ${formatShortDate(item.startDate)}` : formatShortDate(item.startDate)}</span>
                  {visibleAttentionFlags(item.attentionFlags).map(f => (
                    <span key={f} className="inline-flex items-center rounded-full px-1.5 py-0.5 text-xs bg-[color:var(--attention-soft)] text-[color:var(--attention-on-soft)]">
                      <AlertCircle className="h-2.5 w-2.5 mr-0.5" />
                      {attentionFlagLabel(f)}
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
