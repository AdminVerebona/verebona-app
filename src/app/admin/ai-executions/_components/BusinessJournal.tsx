"use client";

/**
 * Exécutions & logs — cartes « Échecs » / « Incomplètes » et Journal complet
 * (lot 84D, CDC Pilotage IA V2 P3 : BO-01, BO-02, BO-04, BO-05, BO-07, BO-08).
 *
 * Composants de PRÉSENTATION (rendu pur, testables sans réseau) ; la page
 * porte l'état et les lectures. Une seule source pour les trois vues : la
 * réponse de `/api/admin/ai/business-executions` (cartes, liste, total) —
 * mêmes nombres et mêmes identifiants entre la carte, la liste filtrée sur
 * son issue et l'export (R24).
 *
 * Desktop et mobile : cartes en une colonne puis deux, filtres et lignes qui
 * s'enroulent, aucune largeur fixe (`min-w-0`, `break-words`), cibles
 * tactiles ≥ 40 px.
 */
import { AlertOctagon, CircleDashed } from 'lucide-react';
import type { BusinessExecutionDto } from '@/services/ai/business-execution/dto';
import type { CardKind, ExecutionCards, JournalView } from '@/services/ai/business-execution/journal';
import { BUSINESS_ORIGINS } from '@/services/ai/business-execution/journal';
import { BUSINESS_TREATMENTS, ORIGIN_LABELS, OUTCOME_LABELS, type BusinessOrigin, type BusinessOutcome } from '@/services/ai/business-execution/types';
import { BusinessOutcomeBadge } from './BusinessExecutionsPanel';

const SELECT = 'min-w-0 rounded-lg border border-[color:var(--input)] bg-[color:var(--bg-input)] px-3 py-2 text-sm text-[color:var(--text-primary)]';

/** Périodes proposées (la règle temporelle est celle de P2 : fin si finale, sinon dernière activité). */
export const JOURNAL_PERIODS: ReadonlyArray<{ days: string; label: string }> = [
  { days: '1', label: '24 h' }, { days: '7', label: '7 jours' }, { days: '30', label: '30 jours' }, { days: '90', label: '90 jours' },
];

/** BO-01 / BO-07 : deux cartes, un clic ouvre le journal filtré sur l'issue (vue métier). */
export function ExecutionCardsView({ cards, periodLabel, active, onOpen, error }: {
  cards: ExecutionCards | null; periodLabel: string; active: CardKind | null; onOpen: (c: CardKind) => void; error?: string | null;
}) {
  const card = (kind: CardKind, label: string, n: number | null, tone: string, Icon: typeof AlertOctagon) => (
    <button type="button" onClick={() => onOpen(kind)} aria-pressed={active === kind} data-testid={kind === 'FAILED' ? 'card-failed' : 'card-incomplete'}
      className={`min-w-0 min-h-[64px] text-left rounded-xl border p-4 transition-colors bg-[color:var(--bg-card)] hover:bg-[color:var(--bg-hover)] ${
        active === kind ? 'border-[color:var(--accent)] ring-1 ring-[color:var(--accent)]' : 'border-[color:var(--border-subtle)]'}`}>
      <span className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
        <Icon className={`w-4 h-4 shrink-0 ${tone}`} aria-hidden />
        <span className="break-words">{label}</span>
      </span>
      <span className={`block mt-1 text-2xl font-semibold ${n ? tone : 'text-[color:var(--text-primary)]'}`} data-testid="card-count">
        {n === null ? '—' : n.toLocaleString('fr-FR')}
      </span>
      <span className="block text-xs text-[color:var(--text-muted)]">{periodLabel} · exécutions métier, issue finale</span>
    </button>
  );
  return (
    <div className="space-y-1.5" data-testid="execution-cards">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {card('FAILED', 'Échecs', cards?.failed ?? null, 'text-[color:var(--text-danger)]', AlertOctagon)}
        {card('INCOMPLETE', 'Exécutions incomplètes', cards?.incomplete ?? null, 'text-[color:var(--text-warning-soft)]', CircleDashed)}
      </div>
      {error && <p className="text-xs text-[color:var(--text-danger)] break-words">Cartes indisponibles : {error}</p>}
    </div>
  );
}

export interface JournalFilterState {
  days: string;
  from: string;
  to: string;
  treatment: string;
  outcome: string;
  origin: string;
  accountId: string;
}

/** Paramètres d'API du journal (mêmes clés que la route et l'export). */
export function journalParams(f: JournalFilterState, nature: 'BUSINESS' | 'TECHNICAL', extra: Record<string, string> = {}): URLSearchParams {
  const q = new URLSearchParams();
  if (f.from || f.to) { if (f.from) q.set('from', f.from); if (f.to) q.set('to', f.to); } else q.set('days', f.days || '7');
  if (f.treatment) q.set('treatment', f.treatment);
  if (f.outcome) q.set('outcome', f.outcome);
  if (f.origin) q.set('origin', f.origin);
  if (f.accountId) q.set('accountId', f.accountId);
  q.set('nature', nature);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q;
}

/** Libellé de période (cartes, en-tête du journal). */
export function periodLabelOf(f: Pick<JournalFilterState, 'days' | 'from' | 'to'>): string {
  if (f.from || f.to) return `du ${f.from || '…'} au ${f.to || 'aujourd’hui'}`;
  return f.days === '1' ? 'dernières 24 h' : `${f.days || '7'} derniers jours`;
}

/** Filtres du journal (BO-08) : période, traitement, issue, origine, compte — partagés par les deux vues. */
export function JournalFiltersView({ f, onChange, view }: { f: JournalFilterState; onChange: (p: Partial<JournalFilterState>) => void; view: JournalView }) {
  return (
    <div className="flex flex-wrap gap-2 items-center" data-testid="journal-filters">
      <div role="group" aria-label="Période" className="inline-flex flex-wrap rounded-lg border border-[color:var(--border-subtle)] p-0.5">
        {JOURNAL_PERIODS.map((p) => (
          <button key={p.days} type="button" aria-pressed={!f.from && !f.to && f.days === p.days}
            onClick={() => onChange({ days: p.days, from: '', to: '' })}
            className={`px-2.5 py-1.5 text-xs rounded-md ${!f.from && !f.to && f.days === p.days
              ? 'bg-[color:var(--accent-soft)] text-[color:var(--text-primary)] font-medium' : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]'}`}>
            {p.label}
          </button>
        ))}
      </div>
      <label className="text-sm text-[color:var(--text-secondary)] flex items-center gap-1 min-w-0">
        Du <input type="date" value={f.from} onChange={(e) => onChange({ from: e.target.value })} className={SELECT} />
      </label>
      <label className="text-sm text-[color:var(--text-secondary)] flex items-center gap-1 min-w-0">
        au <input type="date" value={f.to} onChange={(e) => onChange({ to: e.target.value })} className={SELECT} />
      </label>
      <select aria-label="Traitement" value={f.treatment} onChange={(e) => onChange({ treatment: e.target.value })} className={SELECT}>
        <option value="">Tous les traitements</option>
        {BUSINESS_TREATMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <select aria-label="Issue" value={f.outcome} onChange={(e) => onChange({ outcome: e.target.value })} className={SELECT}>
        <option value="">Toutes les issues</option>
        {(Object.keys(OUTCOME_LABELS) as BusinessOutcome[]).map((o) => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}
      </select>
      <select aria-label="Origine" value={f.origin} onChange={(e) => onChange({ origin: e.target.value })} className={SELECT}>
        <option value="">Toutes les origines</option>
        {BUSINESS_ORIGINS.map((o: BusinessOrigin) => <option key={o} value={o}>{ORIGIN_LABELS[o]}</option>)}
      </select>
      <input aria-label="Compte" placeholder="Compte" inputMode="numeric" value={f.accountId}
        onChange={(e) => onChange({ accountId: e.target.value.replace(/\D/g, '') })} className={`${SELECT} w-28`} />
      <span className="text-xs text-[color:var(--text-muted)]">{view === 'metier' ? 'Vue métier' : 'Vue technique'}</span>
    </div>
  );
}

/**
 * Lignes du journal (BO-07 : « pas un roman par document ») — une ligne par
 * exécution : issue, traitement, objet, compte, origine, date de référence,
 * cause en une ou deux lignes. Un clic ouvre le détail.
 */
export function JournalRowsView({ rows, view, onOpen }: { rows: BusinessExecutionDto[]; view: JournalView; onOpen: (id: string) => void }) {
  if (rows.length === 0) {
    return (
      <p className="p-6 text-sm text-[color:var(--text-muted)]" data-testid="journal-empty">
        {view === 'metier' ? 'Aucune exécution métier ne correspond à ces filtres sur la période.' : 'Aucune exécution technique (sonde, qualification, test, balayage) sur la période.'}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-[color:var(--border-subtle)]" data-testid="journal-rows">
      {rows.map((x) => (
        <li key={x.id}>
          <button type="button" onClick={() => onOpen(x.id)} data-testid="journal-row"
            className="w-full min-w-0 text-left px-4 py-3 space-y-1 hover:bg-[color:var(--bg-hover)]">
            <span className="flex flex-wrap items-center gap-2 min-w-0">
              <BusinessOutcomeBadge x={x} />
              <span className="text-sm font-medium text-[color:var(--text-primary)]">{x.treatment}{x.mode ? ` · ${x.mode}` : ''}</span>
              {x.objectType && <span className="text-xs text-[color:var(--text-secondary)] break-all">{x.objectType} {x.objectId}</span>}
              {x.accountId !== null && <span className="text-xs text-[color:var(--text-muted)]">compte {x.accountId}</span>}
              <span className="text-xs text-[color:var(--text-muted)]">origine {x.originLabel}</span>
              {x.nature === 'TECHNICAL' && <span className="text-xs px-1.5 py-0.5 rounded bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)]">technique</span>}
              <span className="text-xs text-[color:var(--text-muted)] sm:ml-auto">{new Date(x.referenceAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}</span>
            </span>
            {x.cause && <span className="block text-xs text-[color:var(--text-secondary)] break-words line-clamp-2">{x.cause}</span>}
            <span className="block text-xs text-[color:var(--text-muted)] break-all">
              {x.calls ? `${x.calls.calls} appel${x.calls.calls > 1 ? 's' : ''}${x.calls.failedCalls ? ` dont ${x.calls.failedCalls} en échec` : ''} · ` : ''}
              {x.resumptions > 0 ? `${x.resumptions} reprise${x.resumptions > 1 ? 's' : ''} · ` : ''}
              <span className="font-mono">{x.id}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
