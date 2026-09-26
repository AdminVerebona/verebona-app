"use client";

/**
 * Sélecteur de période — CDC BO DASH-003 : Mois / Trimestre / Semestre /
 * Année (Mois par défaut), périodes calendaires. Les flèches parcourent les
 * périodes passées ; la suivante est désactivée tant que la période est en
 * cours (UX-003 : motif affiché au survol).
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PERIOD_KINDS, PERIOD_KIND_LABELS, type PeriodKind, type ResolvedPeriod } from '@/lib/admin/periods';

type PeriodInfo = Pick<ResolvedPeriod, 'label' | 'ref' | 'prevRef' | 'nextRef' | 'inProgress'>;

export function PeriodSelector({
  kind, period, onChange,
}: {
  kind: PeriodKind;
  period: PeriodInfo | null;
  onChange: (kind: PeriodKind, ref: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div role="radiogroup" aria-label="Période" className="inline-flex rounded-lg bg-muted p-[3px]">
        {PERIOD_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={k === kind}
            onClick={() => onChange(k, period?.ref ?? null)}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              k === kind ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {PERIOD_KIND_LABELS[k]}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="outline" size="icon" className="h-8 w-8"
          aria-label="Période précédente"
          disabled={!period}
          onClick={() => period && onChange(kind, period.prevRef)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-[9rem] text-center text-sm font-medium capitalize">
          {period ? period.label : '…'}
          {period?.inProgress && <span className="ml-1 text-xs font-normal text-muted-foreground">(en cours)</span>}
        </span>
        <Button
          variant="outline" size="icon" className="h-8 w-8"
          aria-label="Période suivante"
          title={period?.inProgress ? 'Période en cours : aucune période suivante à afficher' : undefined}
          disabled={!period || period.inProgress}
          onClick={() => period && onChange(kind, period.nextRef)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
