"use client";

/**
 * Exécution métier — éléments d'affichage partagés (lots 83C, 84D) : pastille
 * d'issue, résultat natif, ligne compacte (Exécutions & logs, File IA).
 *
 * Lot 84D (CDC Pilotage IA V2 P3) : le panneau P2 « Exécutions métier — 7
 * derniers jours » (récapitulatif et listes dépliables) est RETIRÉ — remplacé
 * par les deux cartes et le Journal complet (`BusinessJournal.tsx`), un seul
 * affichage des mêmes nombres (C-Q9).
 *
 * Desktop et mobile : lignes qui s'enroulent, aucune largeur fixe.
 */
import type { BusinessExecutionDto } from '@/services/ai/business-execution/dto';
import type { BusinessOutcome } from '@/services/ai/business-execution/types';

const BADGE: Record<BusinessOutcome, string> = {
  SUCCEEDED: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]',
  INCOMPLETE: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning-soft)] border-[color:var(--border-warning)]',
  FAILED: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
  NOT_FINAL: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-secondary)] border-[color:var(--border-subtle)]',
  VOID: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)] border-[color:var(--border-subtle)]',
  UNDETERMINED: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)] border-[color:var(--border-subtle)]',
};

/** Qualification administrative d'une exécution métier (pastille). */
export function BusinessOutcomeBadge({ x, title }: { x: Pick<BusinessExecutionDto, 'outcome' | 'label' | 'cause'>; title?: string }) {
  return (
    <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full border whitespace-nowrap ${BADGE[x.outcome]}`}
      title={title ?? x.cause ?? undefined} data-testid="business-outcome">
      {x.label}
    </span>
  );
}

/** Résultat natif lisible (OP-04 : jamais perdu). */
export function nativeText(x: Pick<BusinessExecutionDto, 'native'>): string {
  const n = x.native;
  return [n.source, n.status, n.result].filter(Boolean).join(' · ');
}

/** Ligne compacte d'une exécution métier (liste, détail d'appel, File IA). */
export function BusinessExecutionLine({ x, onOpenCall }: { x: BusinessExecutionDto; onOpenCall?: (usageEventId: number) => void }) {
  return (
    <div className="space-y-1 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <BusinessOutcomeBadge x={x} />
        <span className="text-sm font-medium text-[color:var(--text-primary)]">{x.treatment}{x.mode ? ` · ${x.mode}` : ''}</span>
        {x.objectType && <span className="text-xs text-[color:var(--text-secondary)]">{x.objectType} {x.objectId}</span>}
        {x.accountId !== null && <span className="text-xs text-[color:var(--text-muted)]">compte {x.accountId}</span>}
        {x.nature === 'TECHNICAL' && <span className="text-xs px-1.5 py-0.5 rounded bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)]">technique</span>}
        <span className="text-xs text-[color:var(--text-muted)] sm:ml-auto">{new Date(x.referenceAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}</span>
      </div>
      {x.cause && <p className="text-xs text-[color:var(--text-secondary)] break-words">{x.cause}</p>}
      <p className="text-xs text-[color:var(--text-muted)] break-all">
        Résultat natif : {nativeText(x)} · origine {x.originLabel}
        {x.resumptions > 0 && ` · ${x.resumptions} reprise${x.resumptions > 1 ? 's' : ''}`}
        {x.previousExecutionId && ` · exécution précédente ${x.previousExecutionId}`}
        {x.calls && ` · ${x.calls.calls} appel${x.calls.calls > 1 ? 's' : ''}${x.calls.failedCalls ? ` dont ${x.calls.failedCalls} en échec` : ''}${x.calls.repairCalls ? `, ${x.calls.repairCalls} réparation(s)` : ''}`}
        {' · '}<span className="font-mono">{x.id}</span>
      </p>
      {onOpenCall && x.calls && x.calls.usageEventIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {x.calls.usageEventIds.slice(0, 8).map((u) => (
            <button key={u} type="button" onClick={() => onOpenCall(u)}
              className="text-xs text-[color:var(--accent)] hover:underline">appel #{u}</button>
          ))}
        </div>
      )}
    </div>
  );
}
