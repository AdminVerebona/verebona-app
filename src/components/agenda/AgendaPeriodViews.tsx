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
import { DateChip, type DateChipTone } from '@/components/ui/date-chip';
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

/**
 * Tons des statuts (charte « Sérénité », décision PO lot 66) — libellé
 * TOUJOURS écrit : neutre brume / pétrole (à venir), pétrole (réalisé),
 * cuivre (statut à confirmer = attention), rouge (date échue = retard strict).
 */
export const STATUS_COLORS: Record<EffectiveStatus, string> = {
  a_venir: 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]',
  en_retard: 'bg-[color:var(--danger-soft)] text-[color:var(--danger)]',
  a_confirmer: 'bg-[color:var(--attention-soft)] text-[color:var(--attention-on-soft)]',
  realise: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)]',
  annule: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-secondary)]',
};

export const STATUS_BORDER: Record<EffectiveStatus, string> = {
  a_venir: 'border-[color:var(--border-info)]',
  en_retard: 'border-[color:var(--danger-edge)]',
  a_confirmer: 'border-[color:var(--attention-edge)]',
  realise: 'border-[color:var(--border-success)]',
  annule: 'border-[color:var(--border)]',
};

/**
 * Pastille de date d'une échéance (charte §5, composant DateChip) : brume /
 * pétrole par défaut, rouge pour une date échue (retard strict), cuivre pour
 * un statut à confirmer. Décorative : le statut est écrit à côté.
 */
export function DateBlock({ dateStr, status }: { dateStr: string | null; status?: EffectiveStatus }) {
  if (!dateStr) {
    return (
      <span aria-hidden className="flex h-11 w-11 md:h-12 md:w-12 flex-shrink-0 flex-col items-center justify-center rounded-[10px] border border-[color:var(--border)] bg-[color:var(--bg-subtle)] leading-none text-[color:var(--text-muted)]">
        <span className="text-[15px] md:text-[17px] font-bold">—</span>
        <span className="mt-[3px] text-[9px] font-bold uppercase tracking-[.05em]">Date</span>
      </span>
    );
  }
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDate();
  const month = d.toLocaleDateString('fr-FR', { month: 'short' }).toUpperCase().replace('.', '');
  const tone: DateChipTone = status === 'en_retard' ? 'late' : status === 'a_confirmer' ? 'attention' : 'default';
  return <DateChip day={String(day).padStart(2, '0')} month={month} tone={tone} />;
}

// Repère par bien (vue Mois / Année) — lot 66B1 : la couleur par bien n'est
// pas arbitrée par la charte ; pastille neutre (brume, texte encre) et point
// de couleur pris dans la série « graphiques » de la charte. Le NOM du bien
// reste écrit : la couleur n'est jamais la seule information. Ni rouge ni
// cuivre (réservés au retard et à l'attention).
const ASSET_PALETTE = [
  { pill: 'bg-[color:var(--accent-soft)] text-[color:var(--text-primary)] border-l-2 border-[color:var(--chart-1)]', dot: 'bg-[color:var(--chart-1)]' },
  { pill: 'bg-[color:var(--accent-soft)] text-[color:var(--text-primary)] border-l-2 border-[color:var(--chart-3)]', dot: 'bg-[color:var(--chart-3)]' },
  { pill: 'bg-[color:var(--accent-soft)] text-[color:var(--text-primary)] border-l-2 border-[color:var(--chart-4)]', dot: 'bg-[color:var(--chart-4)]' },
  { pill: 'bg-[color:var(--accent-soft)] text-[color:var(--text-primary)] border-l-2 border-[color:var(--chart-5)]', dot: 'bg-[color:var(--chart-5)]' },
];
const NO_ASSET = { pill: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)]', dot: 'bg-[color:var(--text-muted)]' };

function assetColor(assetId: number | undefined) {
  if (assetId == null) return NO_ASSET;
  return ASSET_PALETTE[(assetId * 2654435761 >>> 0) % ASSET_PALETTE.length];
}

export function itemColor(item: AgendaItemFull) {
  return assetColor(item.assetLinks[0]?.assetId);
}

/** Infobulle d'une échéance compacte : titre, bien, statut écrit. */
function itemTooltip(item: AgendaItemFull): string {
  const bien = item.assetLinks[0]?.assetName;
  return [item.title, bien, STATUS_LABELS[item.effectiveStatus]].filter(Boolean).join(' · ');
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
                    title={itemTooltip(item)}
                    className={`w-full text-left text-xs rounded px-1.5 py-0.5 truncate font-medium hover:opacity-80 transition-opacity ${item.effectiveStatus === 'en_retard' ? 'bg-[color:var(--danger-soft)] text-[color:var(--danger)]' : itemColor(item).pill}`}
                  >
                    {item.startTime ? `${item.startTime.slice(0, 5)} ` : ''}{item.title}
                    {item.effectiveStatus === 'en_retard' && <span className="sr-only"> — {STATUS_LABELS.en_retard}</span>}
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
          <p className="vb-group-label px-1">Sans date · {undated.length}</p>
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

/** Mois `AAAA-MM` d'une carte de la vue annuelle (`monthIndex` : 0 = janvier). */
export function yearMonthKey(year: number, monthIndex: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

/** « janvier 2026 » — nom complet du mois, pour le nom accessible. */
export function monthLongLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m - 1, 15).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
}

/**
 * En-tête d'une carte de la vue annuelle (lot 75H, point 1) : « Janv. » +
 * compteur. Avec `onOpenMonth`, c'est un BOUTON (clavier : Entrée / Espace,
 * anneau de focus de la charte) qui ouvre la vue mensuelle de ce mois ; sans,
 * un simple en-tête comme avant. Sans hook : testable par appel direct.
 */
export function MonthCardHeader({ monthLabel, monthKey, count, isCurrentMonth, onOpenMonth }: {
  monthLabel: string;
  monthKey: string;
  count: number;
  isCurrentMonth: boolean;
  onOpenMonth?: (month: string) => void;
}) {
  const content = (
    <>
      <span className={`text-sm font-semibold ${isCurrentMonth ? 'text-primary' : 'text-foreground'}`}>
        {monthLabel}
      </span>
      {count > 0 && (
        <span aria-hidden={onOpenMonth ? true : undefined} className="text-[11px] font-medium text-muted-foreground bg-muted rounded-full px-2 py-0.5">
          {count}
        </span>
      )}
    </>
  );
  const layout = 'px-4 pt-4 pb-3 flex items-center justify-between border-b border-border/40';
  if (!onOpenMonth) return <div className={layout}>{content}</div>;
  const n = count === 0 ? 'aucun élément' : `${count} élément${count > 1 ? 's' : ''}`;
  return (
    <button
      type="button"
      data-month-header={monthKey}
      onClick={() => onOpenMonth(monthKey)}
      aria-label={`${monthLongLabel(monthKey)}, ${n} — afficher la vue mensuelle`}
      className={`${layout} w-full text-left rounded-t-xl hover:bg-muted/50 transition-colors`}
    >
      {content}
    </button>
  );
}

function MonthCard({ monthLabel, monthKey, monthItems, isCurrentMonth, onItemClick, onOpenMonth }: {
  monthLabel: string;
  monthKey: string;
  monthItems: AgendaItemFull[];
  isCurrentMonth: boolean;
  onItemClick: (item: AgendaItemFull) => void;
  onOpenMonth?: (month: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasItems = monthItems.length > 0;
  const overdue = monthItems.filter(i => i.effectiveStatus === 'en_retard').length;
  const visibleItems = expanded ? monthItems : monthItems.slice(0, PREVIEW_COUNT);
  const hiddenCount = monthItems.length - PREVIEW_COUNT;

  return (
    <div className={`rounded-xl border bg-card flex flex-col ${isCurrentMonth ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border/50'}`}>
      <MonthCardHeader
        monthLabel={monthLabel}
        monthKey={monthKey}
        count={monthItems.length}
        isCurrentMonth={isCurrentMonth}
        onOpenMonth={onOpenMonth}
      />

      {/* Body */}
      <div className="px-3 py-3 flex-1 space-y-0.5">
        {!hasItems ? (
          <p className="text-xs text-muted-foreground text-center py-4">Rien ce mois-ci</p>
        ) : (
          <>
            {visibleItems.map(item => (
              <button
                key={item.id}
                onClick={() => onItemClick(item)}
                title={itemTooltip(item)}
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
              <p className="text-[10px] font-medium text-[color:var(--danger)] pl-4 pt-1">
                {overdue} en retard
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Vue annuelle. `onOpenMonth` (lot 75H) : l'en-tête de chaque mois ouvre la
 * vue mensuelle de ce mois (même année) — l'écran garde ses filtres.
 */
export function YearView({ items, year, onItemClick, onOpenMonth }: {
  items: AgendaItemFull[];
  year: number;
  onItemClick: (item: AgendaItemFull) => void;
  onOpenMonth?: (month: string) => void;
}) {
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
          monthKey={yearMonthKey(year, idx)}
          monthItems={byMonth[idx]}
          isCurrentMonth={new Date().getFullYear() === year && new Date().getMonth() === idx}
          onItemClick={onItemClick}
          onOpenMonth={onOpenMonth}
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
