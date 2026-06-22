"use client"

import { useState, useEffect, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Calendar, List, SlidersHorizontal, Plus, AlertCircle, CalendarDays, CalendarRange } from 'lucide-react';
import dynamic from 'next/dynamic';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import type { AgendaItemFull } from '@/services/agenda/AgendaQueryService';
import { useSession } from '@/hooks/useSession';

const AgendaItemDrawer = dynamic(
  () => import('@/components/agenda/AgendaItemDrawer').then(m => ({ default: m.AgendaItemDrawer })),
  { ssr: false }
);
const CreateAgendaItemDrawer = dynamic(
  () => import('@/components/agenda/CreateAgendaItemDrawer').then(m => ({ default: m.CreateAgendaItemDrawer })),
  { ssr: false }
);
const AgendaFiltersDrawer = dynamic(
  () => import('@/components/agenda/AgendaFiltersDrawer').then(m => ({ default: m.AgendaFiltersDrawer })),
  { ssr: false }
);
const DocumentDrawer = dynamic(
  () => import('@/components/assets/DocumentDrawer').then(m => ({ default: m.DocumentDrawer })),
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
  a_venir: 'bg-amber-500/10 text-amber-400',
  en_retard: 'bg-red-500/10 text-red-400',
  realise: 'bg-teal-500/10 text-teal-400',
  annule: 'bg-muted text-muted-foreground',
};

const STATUS_BORDER: Record<EffectiveStatus, string> = {
  a_venir: 'border-amber-500/20',
  en_retard: 'border-red-500/20',
  realise: 'border-teal-500/20',
  annule: 'border-border/40',
};

function formatShortDate(dateStr: string | null): string {
  if (!dateStr) return 'Sans date';
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

function DateBlock({ dateStr }: { dateStr: string | null }) {
  if (!dateStr) {
    return (
      <div className="flex-shrink-0 w-14 flex flex-col items-center justify-center rounded-xl bg-muted/60 border border-border/40 py-2.5 gap-0.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground leading-none">TBD</span>
        <span className="text-[10px] text-muted-foreground/60 leading-none mt-0.5">—</span>
      </div>
    );
  }
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDate();
  const month = d.toLocaleDateString('fr-FR', { month: 'short' }).toUpperCase().replace('.', '');
  return (
    <div className="flex-shrink-0 w-14 flex flex-col items-center justify-center rounded-xl bg-primary/10 border border-primary/20 py-2.5 gap-0">
      <span className="text-[10px] font-bold uppercase tracking-widest text-primary leading-none">{month}</span>
      <span className="text-2xl font-extrabold text-primary leading-none mt-0.5">{String(day).padStart(2, '0')}</span>
    </div>
  );
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
      <DateBlock dateStr={item.startDate ?? null} />

      {/* Content */}
      <div className="flex-1 min-w-0">
        {item.startDate && (
          <p className="text-[11px] text-muted-foreground mb-0.5">
            {new Date(item.startDate + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
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
          {item.attentionFlags.map(f => (
            <span key={f} className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs bg-orange-500/10 text-orange-400 border border-orange-500/20">
              <AlertCircle className="h-2.5 w-2.5" />
              {f === 'sans_bien' ? 'Sans bien' : f === 'donnee_distincte_a_qualifier' ? 'À qualifier' : f === 'date_incoherente' ? 'Date?' : f}
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

// Colors assigned per asset — avoids brand colors (blue=Premium, green=PremiumDuo, violet=AI)
const ASSET_PALETTE = [
  { pill: 'bg-amber-500/15 text-amber-300',   dot: 'bg-amber-400' },
  { pill: 'bg-orange-500/15 text-orange-300', dot: 'bg-orange-400' },
  { pill: 'bg-rose-500/15 text-rose-300',     dot: 'bg-rose-400' },
  { pill: 'bg-pink-500/15 text-pink-300',     dot: 'bg-pink-400' },
  { pill: 'bg-fuchsia-500/15 text-fuchsia-300', dot: 'bg-fuchsia-400' },
  { pill: 'bg-cyan-500/15 text-cyan-300',     dot: 'bg-cyan-400' },
  { pill: 'bg-red-500/15 text-red-300',       dot: 'bg-red-400' },
  { pill: 'bg-indigo-500/15 text-indigo-300', dot: 'bg-indigo-400' },
];
const NO_ASSET = { pill: 'bg-muted/60 text-muted-foreground', dot: 'bg-muted-foreground/40' };

function assetColor(assetId: number | undefined) {
  if (assetId == null) return NO_ASSET;
  return ASSET_PALETTE[(assetId * 2654435761 >>> 0) % ASSET_PALETTE.length];
}

function itemColor(item: AgendaItemFull) {
  return assetColor(item.assetLinks[0]?.assetId);
}

function CalendarView({ items, month, onItemClick, onNew }: { items: AgendaItemFull[]; month: string; onItemClick: (item: AgendaItemFull) => void; onNew: () => void }) {
  const [year, m] = month.split('-').map(Number);
  const daysInMonth = new Date(year, m, 0).getDate();
  const firstDayOfWeek = new Date(year, m - 1, 1).getDay();
  const today = new Date().toISOString().slice(0, 10);

  const byDay: Record<string, AgendaItemFull[]> = {};
  for (const item of items) {
    if (!item.startDate) continue;
    const key = item.startDate.slice(0, 10);
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push(item);
  }

  // Monday-first padding
  const startPad = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;
  const cells: (number | null)[] = [
    ...Array(startPad).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  // Pad end to complete last row
  while (cells.length % 7 !== 0) cells.push(null);

  const undated = items.filter(i => !i.startDate);

  return (
    <div className="space-y-6">
      {/* Calendar grid */}
      <div className="rounded-xl border overflow-hidden">
        {/* Day headers */}
        <div className="grid grid-cols-7 border-b">
          {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((d, i) => (
            <div key={d} className={`py-2 text-center text-xs font-semibold text-muted-foreground ${i >= 5 ? 'text-muted-foreground/60' : ''}`}>
              {d}
            </div>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7 divide-x divide-y">
          {cells.map((day, idx) => {
            if (!day) return (
              <div key={`pad-${idx}`} className="min-h-[90px] bg-muted/20" />
            );

            const dateStr = `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const dayItems = byDay[dateStr] ?? [];
            const isToday = dateStr === today;
            const isWeekend = (idx % 7) >= 5;

            return (
              <div
                key={dateStr}
                className={`min-h-[90px] p-1.5 flex flex-col gap-0.5 ${isWeekend ? 'bg-muted/10' : 'bg-background'}`}
              >
                {/* Day number */}
                <div className={`w-6 h-6 flex items-center justify-center rounded-full text-xs font-semibold mb-0.5 self-end
                  ${isToday ? 'bg-primary text-primary-foreground' : 'text-foreground/70'}`}>
                  {day}
                </div>

                {/* Events */}
                {dayItems.slice(0, 3).map(item => (
                  <button
                    key={item.id}
                    onClick={() => onItemClick(item)}
                    className={`w-full text-left text-xs rounded px-1.5 py-0.5 truncate font-medium hover:opacity-80 transition-opacity ${itemColor(item).pill}`}
                  >
                    {item.startTime ? `${item.startTime.slice(0, 5)} ` : ''}{item.title}
                  </button>
                ))}
                {dayItems.length > 3 && (
                  <span className="text-xs text-muted-foreground pl-1">+{dayItems.length - 3} autres</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Sans date block */}
      {undated.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1">Sans date · {undated.length}</p>
          {undated.map(item => (
            <button
              key={item.id}
              onClick={() => onItemClick(item)}
              className="w-full flex items-center gap-4 px-4 py-3 rounded-xl border border-border/50 bg-card hover:bg-muted/30 transition-colors text-left"
            >
              <DateBlock dateStr={null} />
              <span className="text-sm flex-1 truncate font-semibold">{item.title}</span>
              {item.assetLinks[0] && (
                <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">{item.assetLinks[0].assetName}</span>
              )}
              <span className={`shrink-0 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium border ${STATUS_BORDER[item.effectiveStatus]} ${STATUS_COLORS[item.effectiveStatus]}`}>
                {STATUS_LABELS[item.effectiveStatus]}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const MONTHS_FR = ['Janv.', 'Févr.', 'Mars', 'Avr.', 'Mai', 'Juin', 'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.'];

const PREVIEW_COUNT = 5;

function MonthCard({ monthLabel, monthItems, isCurrentMonth, onItemClick }: {
  monthLabel: string;
  monthItems: AgendaItemFull[];
  isCurrentMonth: boolean;
  onItemClick: (item: AgendaItemFull) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasItems = monthItems.length > 0;
  const overdue = monthItems.filter(i => i.effectiveStatus === 'en_retard').length;
  const visibleItems = expanded ? monthItems : monthItems.slice(0, PREVIEW_COUNT);
  const hiddenCount = monthItems.length - PREVIEW_COUNT;

  return (
    <div className={`rounded-xl border bg-card flex flex-col ${isCurrentMonth ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border/50'}`}>
      {/* Header */}
      <div className="px-4 pt-4 pb-3 flex items-center justify-between border-b border-border/40">
        <span className={`text-sm font-semibold ${isCurrentMonth ? 'text-primary' : 'text-foreground'}`}>
          {monthLabel}
        </span>
        {hasItems && (
          <span className="text-[11px] font-medium text-muted-foreground bg-muted rounded-full px-2 py-0.5">
            {monthItems.length}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="px-3 py-3 flex-1 space-y-0.5">
        {!hasItems ? (
          <p className="text-xs text-muted-foreground/50 italic text-center py-4">Rien ce mois-ci</p>
        ) : (
          <>
            {visibleItems.map(item => (
              <button
                key={item.id}
                onClick={() => onItemClick(item)}
                className="w-full text-left flex items-start gap-2 group py-1 px-1.5 rounded-lg hover:bg-muted/50 transition-colors"
              >
                <span className={`mt-[5px] h-1.5 w-1.5 flex-shrink-0 rounded-full ${itemColor(item).dot}`} />
                <span className="text-xs leading-snug text-foreground/75 group-hover:text-foreground truncate">
                  {item.title}
                </span>
              </button>
            ))}
            {!expanded && hiddenCount > 0 && (
              <button
                onClick={() => setExpanded(true)}
                className="w-full text-left text-xs text-muted-foreground hover:text-foreground pl-4 py-1 transition-colors"
              >
                +{hiddenCount} autre{hiddenCount > 1 ? 's' : ''}
              </button>
            )}
            {expanded && hiddenCount > 0 && (
              <button
                onClick={() => setExpanded(false)}
                className="w-full text-left text-xs text-muted-foreground hover:text-foreground pl-4 py-1 transition-colors"
              >
                Réduire
              </button>
            )}
            {overdue > 0 && (
              <p className="text-[10px] font-medium text-red-400 pl-4 pt-1">
                {overdue} en retard
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function YearView({ items, year, onItemClick }: { items: AgendaItemFull[]; year: number; onItemClick: (item: AgendaItemFull) => void }) {
  const byMonth: AgendaItemFull[][] = Array.from({ length: 12 }, () => []);
  for (const item of items) {
    if (!item.startDate) continue;
    const d = new Date(item.startDate + 'T12:00:00');
    if (d.getFullYear() === year) {
      byMonth[d.getMonth()].push(item);
    }
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {MONTHS_FR.map((monthLabel, idx) => (
        <MonthCard
          key={idx}
          monthLabel={monthLabel}
          monthItems={byMonth[idx]}
          isCurrentMonth={new Date().getFullYear() === year && new Date().getMonth() === idx}
          onItemClick={onItemClick}
        />
      ))}
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

  const period = (searchParams.get('period') as 'all' | 'past' | 'today' | 'upcoming') ?? 'all';
  const view = (searchParams.get('view') as 'list' | 'calendar' | 'year') ?? 'list';
  const month = searchParams.get('month') ?? new Date().toISOString().slice(0, 7);
  const yearParam = searchParams.get('year');
  const currentYear = new Date().getFullYear();
  const year = yearParam ? parseInt(yearParam, 10) : currentYear;
  const includeCancelled = searchParams.get('includeCancelled') === 'true';
  const assetIdsParam = searchParams.get('assetIds');
  const assetIds = assetIdsParam ? assetIdsParam.split(',').map(Number).filter(Boolean) : [];

  const [items, setItems] = useState<AgendaItemFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedItem, setSelectedItem] = useState<AgendaItemFull | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
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
    if (assetIds.length > 0) params.set('assetIds', assetIds.join(','));

    apiClient.get<{ items: AgendaItemFull[] }>(`/api/agenda?${params}`)
      .then(data => setItems(data.items ?? []))
      .catch(() => toast.error('Erreur lors du chargement'))
      .finally(() => setLoading(false));
  }, [period, view, month, year, includeCancelled, assetIdsParam, refreshKey]);

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

  const activeFiltersCount = (assetIds.length > 0 ? 1 : 0) + (includeCancelled ? 1 : 0) + (period !== 'all' ? 1 : 0);

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
          <div>
            <h1 className="text-xl md:text-3xl font-bold whitespace-nowrap">Mon agenda</h1>
          </div>
          <div className="flex items-center gap-2">
            {isPremium && (
              <Button
                variant="outline"
                size="sm"
                className="hidden sm:flex items-center gap-1.5"
                onClick={() => router.push('/mon-compte/informations#sync-agenda')}
              >
                <CalendarDays className="h-4 w-4" />
                Ajouter à mon agenda personnel
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setShowFilters(true)} className="btn-filter relative">
              <SlidersHorizontal className="btn-filter-sliders-icon h-4 w-4" />
              Filtres
              {activeFiltersCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[#3b82f6] text-white text-[9px] font-bold flex items-center justify-center">
                  {activeFiltersCount}
                </span>
              )}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowCreate(true)} className="btn-add">
              <Plus className="btn-add-plus-icon h-4 w-4" />
              <span className="hidden sm:inline">Ajouter</span>
            </Button>
          </div>
        </div>

        {/* View toggle + month/year nav */}
        <div className="relative flex items-center justify-between mb-4">
          <div className="flex rounded-md border overflow-hidden">
            <button
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 ${view === 'list' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              onClick={() => updateURL({ view: 'list' })}
            >
              <List className="h-3.5 w-3.5" /> Liste
            </button>
            <button
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 ${view === 'calendar' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              onClick={() => updateURL({ view: 'calendar' })}
            >
              <Calendar className="h-3.5 w-3.5" /> Mensuel
            </button>
            <button
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 ${view === 'year' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              onClick={() => updateURL({ view: 'year' })}
            >
              <CalendarRange className="h-3.5 w-3.5" /> Annuel
            </button>
          </div>

          {view === 'calendar' && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => {
                const [y, m] = month.split('-').map(Number);
                const d = new Date(y, m - 2, 1);
                updateURL({ month: d.toISOString().slice(0, 7) });
              }}>←</Button>
              <span className="text-sm font-medium w-28 text-center">
                {new Date(month + '-15').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}
              </span>
              <Button variant="outline" size="sm" onClick={() => {
                const [y, m] = month.split('-').map(Number);
                const d = new Date(y, m, 1);
                updateURL({ month: d.toISOString().slice(0, 7) });
              }}>→</Button>
            </div>
          )}

          {view === 'year' && (
            <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => updateURL({ year: String(year - 1) })}>←</Button>
              <span className="text-sm font-bold w-16 text-center">{year}</span>
              <Button variant="outline" size="sm" onClick={() => updateURL({ year: String(year + 1) })}>→</Button>
            </div>
          )}
        </div>

        {/* Content */}
        {loading ? (
          <div className="space-y-2">
            {view === 'year' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
          <div className="text-center py-16 text-muted-foreground">
            <Calendar className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="font-medium">Aucun élément</p>
            {activeFiltersCount > 0 ? (
              <p className="text-sm mt-1">Aucun résultat avec ces filtres.</p>
            ) : (
              <Button size="sm" className="mt-4" onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4 mr-1" /> Créer un élément
              </Button>
            )}
          </div>
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

      <AgendaFiltersDrawer
        open={showFilters}
        onClose={() => setShowFilters(false)}
        filters={{ assetIds, period, includeCancelled }}
        onApply={f => updateURL({
          assetIds: f.assetIds.length > 0 ? f.assetIds.join(',') : null,
          period: f.period,
          includeCancelled: f.includeCancelled ? 'true' : null,
        })}
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
