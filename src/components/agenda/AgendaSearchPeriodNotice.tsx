'use client';

/**
 * Lot 100E (décision PO A8) — ligne d'état « période de la recherche » sous
 * le champ de recherche de l'agenda (« Mon agenda » et onglet Agenda d'un
 * bien, desktop et mobile) : dit ce qui est RÉELLEMENT cherché — toutes les
 * dates (« Tous ») ou la période choisie —, jamais une restriction cachée.
 * Un bouton permet de rétablir la période suspendue (ou de chercher sur
 * toutes les dates) : choix explicite, conservé pendant la recherche.
 *
 * Charte Sérénité : jetons CSS existants ; cible tactile de 44 px sur
 * téléphone.
 */
import { CalendarRange } from 'lucide-react';
import { searchPeriodNotice, type AgendaPeriod, type AgendaSearchPeriod } from '@/lib/agenda/agenda-filters';

export function AgendaSearchPeriodNotice({ q, state, onChoose }: {
  q: string;
  state: AgendaSearchPeriod;
  /** Choix explicite d'une période depuis la ligne d'état. */
  onChoose: (period: AgendaPeriod) => void;
}) {
  const notice = searchPeriodNotice(q, state);
  if (!notice) return null;
  return (
    <div
      className="-mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-[color:var(--text-muted)]"
      data-testid="recherche-agenda-periode-active"
      role="status"
      aria-live="polite"
    >
      <CalendarRange className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{notice.text}</span>
      {notice.action && (
        <button
          type="button"
          onClick={() => onChoose(notice.action!.period)}
          className="inline-flex min-h-[44px] items-center rounded-lg px-1 font-medium text-[color:var(--accent)] underline-offset-2 hover:underline md:min-h-0"
          data-testid="recherche-agenda-periode-action"
        >
          {notice.action.label}
        </button>
      )}
    </div>
  );
}
