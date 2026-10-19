"use client"

import { useState, useEffect, useId, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyStateCard } from '@/components/ui/empty-state-card';
import { Calendar, Plus, AlertCircle, CalendarDays } from 'lucide-react';
import {
  AgendaViewControls, CalendarView, DateBlock, STATUS_BORDER, STATUS_COLORS, YearView, currentMonth, parseAgendaView,
} from '@/components/agenda/AgendaPeriodViews';
import dynamic from 'next/dynamic';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import type { AgendaItemFull } from '@/services/agenda/AgendaQueryService';
import { EFFECTIVE_STATUS_LABELS, attentionFlagLabel, visibleAttentionFlags, type AgendaEffectiveStatus } from '@/lib/agenda/effective-status';
import { useSession } from '@/hooks/useSession';
import {
  ActiveFilterChips, FilterChoiceSection, FilterPanel, FilterPillSection, FiltersToggleButton,
} from '@/components/filters/FilterControls';
import { EquipmentFilterSection } from '@/components/filters/EquipmentFilterSection';
import {
  buildEquipmentFilterModel, equipmentFilterParam, type EquipmentFacet,
} from '@/lib/filters/equipment-filter';
import { AGENDA_PERIOD_OPTIONS, agendaFilterChips, parseAgendaPeriod } from '@/lib/agenda/agenda-filters';

const AgendaItemDrawer = dynamic(
  () => import('@/components/agenda/AgendaItemDrawer').then(m => ({ default: m.AgendaItemDrawer })),
  { ssr: false }
);
const CreateAgendaItemDrawer = dynamic(
  () => import('@/components/agenda/CreateAgendaItemDrawer').then(m => ({ default: m.CreateAgendaItemDrawer })),
  { ssr: false }
);
const DocumentDrawer = dynamic(
  () => import('@/components/assets/DocumentDrawer').then(m => ({ default: m.DocumentDrawer })),
  { ssr: false }
);

// Lot 53 (D17) : cinq états distincts, libellés partagés (desktop et mobile : même ligne).
type EffectiveStatus = AgendaEffectiveStatus;

const STATUS_LABELS: Record<EffectiveStatus, string> = EFFECTIVE_STATUS_LABELS;

function formatShortDate(dateStr: string | null): string {
  if (!dateStr) return 'Sans date';
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

function AgendaItemRow({ item, onClick }: { item: AgendaItemFull; onClick: () => void }) {
  const firstAsset = item.assetLinks[0];
  const extraAssets = item.assetLinks.length - 1;

  return (
    <div
      className="flex items-center gap-4 px-4 py-3 rounded-xl border border-border/50 bg-card hover:bg-muted/30 cursor-pointer transition-colors"
      onClick={onClick}
    >
      {/* Date block */}
      <DateBlock dateStr={item.startDate ?? null} status={item.effectiveStatus} />

      {/* Content */}
      <div className="flex-1 min-w-0">
        {item.startDate && (
          <p className="text-[11px] text-muted-foreground mb-0.5">
            {item.occurrenceNature === 'FORECAST' && <span className="italic">Prévu le </span>}
            {new Date(item.startDate + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            {item.occurrenceNature === 'FORECAST' && <span className="italic"> · date estimée</span>}
          </p>
        )}
        <p className="text-sm font-semibold leading-snug truncate">{item.title}</p>
        <div className="flex flex-wrap items-center gap-1.5 mt-1">
          {firstAsset && (
            <span className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground border border-border/40">
              {firstAsset.assetName}
            </span>
          )}
          {extraAssets > 0 && (
            <span className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground border border-border/40">
              +{extraAssets}
            </span>
          )}
          {visibleAttentionFlags(item.attentionFlags).map(f => (
            <span key={f} className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs bg-[color:var(--attention-soft)] text-[color:var(--attention-on-soft)] border border-[color:var(--attention-edge)]">
              <AlertCircle className="h-2.5 w-2.5" />
              {attentionFlagLabel(f)}
            </span>
          ))}
        </div>
      </div>

      {/* Status badge */}
      <span className={`shrink-0 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium border ${STATUS_BORDER[item.effectiveStatus]} ${STATUS_COLORS[item.effectiveStatus]}`}>
        {STATUS_LABELS[item.effectiveStatus]}
      </span>
    </div>
  );
}

function AgendaPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setBreadcrumbs } = useBreadcrumb();
  const { user } = useSession();

  useEffect(() => {
    setBreadcrumbs([{ label: 'Mon agenda' }]);
  }, [setBreadcrumbs]);

  const isPremium = user?.subscription?.plan === 'PREMIUM' || user?.subscription?.plan === 'PREMIUM_DUO' || user?.subscription?.plan === 'PREMIUM_PRO';

  const period = parseAgendaPeriod(searchParams.get('period'));
  const view = parseAgendaView(searchParams.get('view'));
  const month = searchParams.get('month') ?? currentMonth();
  const yearParam = searchParams.get('year');
  const currentYear = new Date().getFullYear();
  const year = yearParam ? parseInt(yearParam, 10) : currentYear;
  const includeCancelled = searchParams.get('includeCancelled') === 'true';
  const assetIdsParam = searchParams.get('assetIds');
  const assetIds = assetIdsParam ? assetIdsParam.split(',').map(Number).filter(Boolean) : [];
  // Lot 71 (71C) : filtre Équipement, dans l'URL comme les autres filtres de l'agenda.
  const equipment = equipmentFilterParam(searchParams.get('equipment'));

  const [items, setItems] = useState<AgendaItemFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedItem, setSelectedItem] = useState<AgendaItemFull | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  // Lot 71 : panneau de filtres intégré à la page (le tiroir a disparu,
  // téléphone compris), replié par défaut comme sur « Mes documents ».
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersPanelId = `${useId()}-filtres`;
  const [assetOptions, setAssetOptions] = useState<Array<{ id: number; name: string }>>([]);
  const [equipmentFacet, setEquipmentFacet] = useState<EquipmentFacet | null>(null);
  const [docDrawerFileId, setDocDrawerFileId] = useState<number | null>(null);

  const updateURL = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    Object.entries(updates).forEach(([k, v]) => {
      if (v === null) params.delete(k);
      else params.set(k, v);
    });
    router.push(`/agenda?${params.toString()}`, { scroll: false });
  };

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set('period', period);
    params.set('includeCancelled', String(includeCancelled));
    if (view === 'calendar') params.set('month', month);
    if (view === 'year') { params.set('year', String(year)); params.set('period', 'all'); }
    if (assetIds.length > 0) {
      params.set('assetIds', assetIds.join(','));
      // Équipements des biens retenus (options et compteurs du filtre).
      params.set('equipmentFacet', '1');
      if (equipment) params.set('equipment', equipment);
    }

    // Filtres enchaînés au clavier : seule la DERNIÈRE réponse est appliquée.
    let actuel = true;
    apiClient.get<{ items: AgendaItemFull[]; equipmentFacet?: EquipmentFacet | null }>(`/api/agenda?${params}`)
      .then(data => {
        if (!actuel) return;
        setItems(data.items ?? []);
        setEquipmentFacet(data.equipmentFacet ?? null);
      })
      .catch(() => { if (actuel) toast.error('Erreur lors du chargement'); })
      .finally(() => { if (actuel) { setLoading(false); setLoadedOnce(true); } });
    return () => { actuel = false; };
  }, [period, view, month, year, includeCancelled, assetIdsParam, equipment, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Biens proposés au filtre (et libellés des pastilles « Filtré par … »).
  useEffect(() => {
    apiClient.get<{ data: Array<{ id: number; name: string }> }>('/api/assets?limit=100')
      .then(d => setAssetOptions(d.data ?? []))
      .catch(() => setAssetOptions([]));
  }, []);

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

  const equipmentModel = buildEquipmentFilterModel(equipmentFacet, equipment, assetIds.length);
  const chips = agendaFilterChips({
    period, assetIds, includeCancelled, assetOptions,
    equipmentChipLabel: equipment ? (equipmentModel.chipLabel ?? (loading ? null : 'Équipement indisponible')) : null,
  });
  const activeFiltersCount = chips.length;
  // Changer de bien réinitialise toujours le filtre Équipement (« Tous »).
  const toggleAsset = (id: number) => {
    const next = assetIds.includes(id) ? assetIds.filter(a => a !== id) : [...assetIds, id];
    updateURL({ assetIds: next.length > 0 ? next.join(',') : null, equipment: null });
  };
  const removeChip = (key: string) => {
    if (key === 'period') updateURL({ period: null });
    else if (key === 'cancelled') updateURL({ includeCancelled: null });
    else if (key === 'equipment') updateURL({ equipment: null });
    else if (key.startsWith('bien:')) toggleAsset(Number(key.slice(5)));
  };
  const clearFilters = () => updateURL({ period: null, assetIds: null, equipment: null, includeCancelled: null });

  // ══════════════════════════════════════════════════════════════════════════
  // « AGENDA VIDE » N'EST PAS « AUCUN RÉSULTAT »
  //
  // Les filtres et les vues ne sont masqués que lorsque l'agenda est
  // RÉELLEMENT vide : liste complète, aucun filtre actif. Masquer le bouton
  // Filtres dès que la liste affichée est vide enfermerait l'utilisateur —
  // un filtre trop restrictif deviendrait impossible à retirer.
  //
  // La vue mensuelle ou annuelle restreint par elle-même : un mois sans
  // événement n'est pas un agenda sans événement. D'où la condition sur la
  // vue liste.
  // ══════════════════════════════════════════════════════════════════════════
  const agendaVide = !loading && items.length === 0 && activeFiltersCount === 0 && view === 'list';

  // Pendant le PREMIER chargement, on ne sait pas encore : on n'affiche pas
  // des commandes pour les retirer une seconde plus tard. Lot 71 : les
  // rechargements suivants (changement de filtre) ne les masquent plus — le
  // panneau de filtres resterait sinon à éclipses, et le focus clavier
  // serait perdu à chaque pastille.
  const masquerCommandes = (loading && !loadedOnce) || agendaVide;

  // Group items by date for list view
  const grouped = useMemo(() => {
    const filtered = items;

    const undated = filtered.filter(i => !i.startDate);
    const dated = filtered.filter(i => !!i.startDate);
    dated.sort((a, b) => {
      const d = (b.startDate ?? '').localeCompare(a.startDate ?? '');
      if (d !== 0) return d;
      return (a.startTime ?? 'zzz').localeCompare(b.startTime ?? 'zzz');
    });

    const groups: { date: string | null; label: string; items: AgendaItemFull[] }[] = [];
    if (undated.length > 0) groups.push({ date: null, label: 'Sans date', items: undated });

    const byDate: Record<string, AgendaItemFull[]> = {};
    for (const item of dated) {
      const key = item.startDate!;
      if (!byDate[key]) byDate[key] = [];
      byDate[key].push(item);
    }
    for (const [date, dateItems] of Object.entries(byDate)) {
      groups.push({
        date,
        label: formatShortDate(date),
        items: dateItems,
      });
    }
    return groups;
  }, [items]);

  return (
    <>
      <div className="space-y-6 w-full max-w-full overflow-x-hidden">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="min-w-0">
            <h1 className="vb-app-title whitespace-nowrap">Mon agenda</h1>
            {/* Même en-tête que « Mes biens » : titre puis décompte. */}
            <p className="text-muted-foreground mt-1">
              {loading ? '\u00a0' : `${items.length} ${items.length > 1 ? 'éléments' : 'élément'}`}
            </p>
          </div>
          <div className={`flex items-center gap-2 ${masquerCommandes ? 'hidden' : ''}`}>
            {isPremium && (
              <Button
                variant="outline"
                size="sm"
                className="hidden sm:flex items-center gap-1.5"
                onClick={() => router.push('/mon-compte#sync-agenda')}
              >
                <CalendarDays className="h-4 w-4" />
                Ajouter à mon agenda personnel
              </Button>
            )}
            {/* Lot 71 : même bouton que « Mes documents » ; il déplie le panneau
                ci-dessous, jamais un tiroir. */}
            <FiltersToggleButton
              count={activeFiltersCount}
              open={filtersOpen}
              panelId={filtersPanelId}
              onToggle={() => setFiltersOpen(v => !v)}
            />
            <Button variant="outline" size="sm" onClick={() => setShowCreate(true)} className="btn-add">
              <Plus className="btn-add-plus-icon h-4 w-4" />
              <span className="hidden sm:inline">Ajouter</span>
            </Button>
          </div>
        </div>

        {/* Filtres dans la page (lot 71) : mêmes composants, mêmes conventions
            que « Mes documents ». Période et statut restent propres à l'agenda. */}
        {filtersOpen && !masquerCommandes && (
          <FilterPanel id={filtersPanelId} testId="agenda-filtres" columns="md:grid-cols-2 lg:grid-cols-[1fr_1.4fr_.8fr]">
            <FilterChoiceSection
              id={`${filtersPanelId}-periode`}
              title="Période"
              options={AGENDA_PERIOD_OPTIONS.map(o => ({ ...o, active: o.value === period }))}
              onSelect={(v) => updateURL({ period: v === 'all' ? null : v })}
            />
            <FilterPillSection
              id={`${filtersPanelId}-bien`}
              title="Bien"
              options={assetOptions.map(a => ({ value: String(a.id), label: a.name, active: assetIds.includes(a.id) }))}
              onToggle={(v) => toggleAsset(Number(v))}
            />
            <FilterPillSection
              id={`${filtersPanelId}-statut`}
              title="Statut"
              options={[{ value: 'cancelled', label: 'Afficher les annulés', active: includeCancelled }]}
              onToggle={() => updateURL({ includeCancelled: includeCancelled ? null : 'true' })}
            />
            <EquipmentFilterSection
              id={`${filtersPanelId}-equipement`}
              model={equipmentModel}
              onSelect={(v) => updateURL({ equipment: equipmentFilterParam(v) })}
              className="border-t border-[color:var(--border-subtle)] pt-4 md:col-span-full"
            />
          </FilterPanel>
        )}
        {!masquerCommandes && <ActiveFilterChips chips={chips} onRemove={removeChip} onClear={clearFilters} />}

        {/* Sélecteur Liste / Mensuel / Annuel et navigation de période —
            inutile tant qu'il n'y a rien à voir. Composant partagé avec
            l'onglet Agenda d'un bien (lot 59, point 5). */}
        <AgendaViewControls
          view={view}
          month={month}
          year={year}
          hidden={masquerCommandes}
          onView={(v) => updateURL({ view: v })}
          onMonth={(m) => updateURL({ month: m })}
          onYear={(y) => updateURL({ year: String(y) })}
        />

        {/* Content */}
        {loading ? (
          <div className="space-y-2">
            {view === 'year' ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {[...Array(12)].map((_, i) => <Skeleton key={i} className="h-48 w-full rounded-2xl" />)}
              </div>
            ) : (
              [...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)
            )}
          </div>
        ) : view === 'year' ? (
          <YearView items={items} year={year} onItemClick={setSelectedItem} />
        ) : view === 'calendar' ? (
          <CalendarView items={items} month={month} onItemClick={setSelectedItem} onNew={() => setShowCreate(true)} />
        ) : items.length === 0 ? (
          activeFiltersCount > 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Calendar className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="font-medium">Aucun élément</p>
              <p className="text-sm mt-1">Aucun résultat avec ces filtres.</p>
            </div>
          ) : (
            /* Même bloc que « Mes biens » : une ligne, une explication, une action. */
            <EmptyStateCard
              icon={<Calendar className="w-4 h-4 text-[color:var(--accent)]" />}
              title="Aucun élément pour le moment"
              description="Ajoutez votre premier élément pour commencer"
              actionLabel="Ajouter mon premier élément"
              onAction={() => setShowCreate(true)}
            />
          )
        ) : (
          <div className="space-y-2">
            {grouped.map(group => (
              <div key={group.date ?? 'undated'} className="space-y-2">
                {group.items.map(item => (
                  <AgendaItemRow key={item.id} item={item} onClick={() => setSelectedItem(item)} />
                ))}
              </div>
            ))}
          </div>
        )}

      </div>

      {/* Drawers */}
      <AgendaItemDrawer
        item={selectedItem}
        open={!!selectedItem}
        onClose={() => setSelectedItem(null)}
        onMutated={onMutated}
        onOpenDocument={(fileId) => setDocDrawerFileId(fileId)}
      />

      {docDrawerFileId && (
        <DocumentDrawer
          open={!!docDrawerFileId}
          onOpenChange={(v) => { if (!v) setDocDrawerFileId(null); }}
          document={{ id: docDrawerFileId, originalFilename: '', mimeType: '', documentType: '', assetId: 0 }}
          onRefresh={() => setRefreshKey(k => k + 1)}
        />
      )}

      <CreateAgendaItemDrawer
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onMutated={() => setRefreshKey(k => k + 1)}
      />
    </>
  );
}

export default function AgendaPage() {
  return (
    <Suspense>
      <AgendaPageInner />
    </Suspense>
  );
}
