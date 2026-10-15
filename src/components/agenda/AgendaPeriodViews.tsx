"use client"

/**
 * Vues de l'agenda — Liste / Mensuel / Annuel — partagées par « Mon agenda »
 * (`/agenda`) et l'onglet Agenda d'un bien (lot 59, point 5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL SÉLECTEUR, UNE SEULE GRILLE
 *
 * Le sélecteur (`AgendaViewControls`), la vue mensuelle (`CalendarView`) et
 * la vue annuelle (`YearView`) ont été déplacés TELS QUELS depuis la page
 * « Mon agenda » (lot 34, points 3/4 : sélecteur pleine largeur sur mobile,
 * trois parts égales, navigation de période dessous ; desktop sur une
 * ligne) : l'onglet Agenda d'un bien affiche exactement les mêmes vues,
 * desktop et mobile, au lieu d'une copie qui divergerait.
 *
 * Navigation de mois : calcul sur la chaîne `AAAA-MM` (`shiftMonth`), plus
 * par `toISOString()` d'une date locale — en France (UTC+1/+2), le 1er du
 * mois à minuit local tombe la veille en UTC : « Mois suivant » restait sur
 * le même mois et « Mois précédent » en sautait deux.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Calendar, List, CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react';
import type { AgendaItemFull } from '@/services/agenda/AgendaQueryService';
import { EFFECTIVE_STATUS_LABELS, type AgendaEffectiveStatus } from '@/lib/agenda/effective-status';

// Lot 53 (D17) : cinq états distincts, libellés partagés (desktop et mobile : même ligne).
type EffectiveStatus = AgendaEffectiveStatus;

const STATUS_LABELS: Record<EffectiveStatus, string> = EFFECTIVE_STATUS_LABELS;

export type AgendaView = 'list' | 'calendar' | 'year';

/** Vue demandée (paramètre d'URL ou état local) : « Liste » par défaut. */
export function parseAgendaView(v: string | null | undefined): AgendaView {
  return v === 'calendar' || v === 'year' ? v : 'list';
}

/** Mois `AAAA-MM` décalé de `delta` mois — arithmétique pure, sans fuseau horaire. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const base = (Number.isFinite(y) ? y : new Date().getFullYear()) * 12 + ((Number.isFinite(m) ? m : 1) - 1) + delta;
  const year = Math.floor(base / 12);
  return `${year}-${String(base - year * 12 + 1).padStart(2, '0')}`;
}

/** Mois courant `AAAA-MM`, à l'heure locale. */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export const STATUS_COLORS: Record<EffectiveStatus, string> = {
  a_venir: 'bg-amber-500/10 text-amber-400',
  en_retard: 'bg-red-500/10 text-red-400',
  a_confirmer: 'bg-orange-500/10 text-orange-400',
  realise: 'bg-teal-500/10 text-teal-400',
  annule: 'bg-muted text-muted-foreground',
};

export const STATUS_BORDER: Record<EffectiveStatus, string> = {
  a_venir: 'border-amber-500/20',
  en_retard: 'border-red-500/20',
  a_confirmer: 'border-orange-500/20',
  realise: 'border-teal-500/20',
  annule: 'border-border/40',
};

export function DateBlock({ dateStr }: { dateStr: string | null }) {
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

// Colors assigned per asset — avoids brand colors (blue=Premium, green=PremiumDuo, violet=AI)
const ASSET_PALETTE = [
  { pill: 'bg-amber-500/15 text-[color:var(--text-warning)]',   dot: 'bg-amber-400' },
  { pill: 'bg-orange-500/15 text-orange-300', dot: 'bg-orange-400' },
  { pill: 'bg-rose-500/15 text-[color:var(--text-danger)]',     dot: 'bg-rose-400' },
  { pill: 'bg-pink-500/15 text-pink-300',     dot: 'bg-pink-400' },
  { pill: 'bg-fuchsia-500/15 text-fuchsia-300', dot: 'bg-fuchsia-400' },
  { pill: 'bg-cyan-500/15 text-cyan-300',     dot: 'bg-cyan-400' },
  { pill: 'bg-red-500/15 text-[color:var(--text-danger)]',       dot: 'bg-red-400' },
  { pill: 'bg-indigo-500/15 text-indigo-300', dot: 'bg-indigo-400' },
];
const NO_ASSET = { pill: 'bg-muted/60 text-muted-foreground', dot: 'bg-muted-foreground/40' };

function assetColor(assetId: number | undefined) {
  if (assetId == null) return NO_ASSET;
  return ASSET_PALETTE[(assetId * 2654435761 >>> 0) % ASSET_PALETTE.length];
}

export function itemColor(item: AgendaItemFull) {
  return assetColor(item.assetLinks[0]?.assetId);
}

export function CalendarView({ items, month, onItemClick, onNew }: { items: AgendaItemFull[]; month: string; onItemClick: (item: AgendaItemFull) => void; onNew: () => void }) {
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

/**
 * Bouton du sélecteur de vue (lot 34, points 3/4) : sur mobile, trois parts
 * égales de la ligne, libellé jamais coupé ; desktop (md+) : taille du
 * contenu, comme avant.
 */
export const VIEW_TAB = 'flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-2 py-1.5 text-sm md:flex-none md:px-3';

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

export function YearView({ items, year, onItemClick }: { items: AgendaItemFull[]; year: number; onItemClick: (item: AgendaItemFull) => void }) {
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

/**
 * Sélecteur « Liste / Mensuel / Annuel » et navigation de période (lot 34,
 * points 3/4). `hidden` : commandes masquées tant qu'il n'y a rien à voir.
 */
export function AgendaViewControls({ view, month, year, onView, onMonth, onYear, hidden = false, label = 'Affichage de l’agenda' }: {
  view: AgendaView;
  month: string;
  year: number;
  onView: (v: AgendaView) => void;
  onMonth: (month: string) => void;
  onYear: (year: number) => void;
  hidden?: boolean;
  label?: string;
}) {
  return (
    <>
    {/* View toggle + month/year nav — inutile tant qu'il n'y a rien à voir.
        Lot 34 (points 3/4) — mobile : le sélecteur occupe une ligne pleine
        largeur (trois boutons égaux, jamais tronqués), la navigation de
        période passe dessous, centrée. Desktop (md+) : une seule ligne,
        sélecteur à gauche, navigation à droite (année centrée dès lg). */}
    <div
      data-agenda-view-controls
      className={`relative mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between ${hidden ? 'hidden' : ''}`}
    >
      <div className="flex w-full overflow-hidden rounded-md border md:w-auto" role="group" aria-label={label}>
        <button
          type="button"
          aria-pressed={view === 'list'}
          className={`${VIEW_TAB} ${view === 'list' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
          onClick={() => onView('list')}
        >
          <List className="h-3.5 w-3.5 shrink-0" /> Liste
        </button>
        <button
          type="button"
          aria-pressed={view === 'calendar'}
          className={`${VIEW_TAB} ${view === 'calendar' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
          onClick={() => onView('calendar')}
        >
          <Calendar className="h-3.5 w-3.5 shrink-0" /> Mensuel
        </button>
        <button
          type="button"
          aria-pressed={view === 'year'}
          className={`${VIEW_TAB} ${view === 'year' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
          onClick={() => onView('year')}
        >
          <CalendarRange className="h-3.5 w-3.5 shrink-0" /> Annuel
        </button>
      </div>

      {view === 'calendar' && (
        <div data-agenda-period-nav className="flex items-center justify-center gap-2">
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => onMonth(shiftMonth(month, -1))} aria-label="Mois précédent"><ChevronLeft className="h-4 w-4" /></Button>
          <span className="min-w-[9rem] whitespace-nowrap text-center text-sm font-medium" aria-live="polite">
            {new Date(month + '-15').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}
          </span>
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => onMonth(shiftMonth(month, 1))} aria-label="Mois suivant"><ChevronRight className="h-4 w-4" /></Button>
        </div>
      )}

      {view === 'year' && (
        <div data-agenda-period-nav className="flex items-center justify-center gap-2 lg:absolute lg:left-1/2 lg:-translate-x-1/2">
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => onYear(year - 1)} aria-label="Année précédente"><ChevronLeft className="h-4 w-4" /></Button>
          <span className="w-16 text-center text-sm font-bold" aria-live="polite">{year}</span>
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => onYear(year + 1)} aria-label="Année suivante"><ChevronRight className="h-4 w-4" /></Button>
        </div>
      )}
    </div>
    </>
  );
}
