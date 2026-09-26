"use client";

/**
 * Carte KPI du Dashboard — CDC Back-Office V1 DOV-001, DASH-004 à DASH-007.
 *
 * Affiche la valeur, l'évolution en % et l'état hausse / stagnation / baisse
 * par rapport à la période précédente équivalente.
 *
 * DASH-007 : le SENS (flèche + libellé « Hausse / Baisse / Stagnation ») et
 * le CARACTÈRE (couleur verte / rouge / neutre) sont deux informations
 * distinctes, calculées côté serveur (`kpi.service.ts#buildKpi`). Une hausse
 * d'anomalies a une flèche montante ET une couleur défavorable. La couleur
 * n'est jamais seule porteuse du sens (libellé textuel toujours présent).
 */
import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { KpiValue } from '@/services/admin/kpi.service';
import { formatBytes, formatMoney } from '@/lib/admin/format';

/** Mise en forme d'une valeur de KPI selon son unité (UX-007). */
export function formatKpiValue(value: number | null, unit: KpiValue['unit'], opts: { decimals?: number } = {}): string {
  if (value === null || Number.isNaN(value)) return 'n.c.';
  switch (unit) {
    case 'cents': return formatMoney(Math.round(value), 'eur');
    case 'bytes': return formatBytes(value);
    case 'ratio': return `${(value * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;
    default: return value.toLocaleString('fr-FR', { maximumFractionDigits: opts.decimals ?? 0 });
  }
}

const DIRECTION = {
  up: { label: 'Hausse', Icon: ArrowUpRight },
  down: { label: 'Baisse', Icon: ArrowDownRight },
  flat: { label: 'Stagnation', Icon: Minus },
} as const;

const TONE_CLASS: Record<KpiValue['tone'], string> = {
  favorable: 'text-emerald-600 dark:text-emerald-400',
  unfavorable: 'text-red-600 dark:text-red-400',
  neutral: 'text-muted-foreground',
};

function formatChange(kpi: KpiValue): string | null {
  if (kpi.unit === 'ratio' && kpi.deltaPoints !== null) {
    const pts = `${kpi.deltaPoints > 0 ? '+' : ''}${kpi.deltaPoints.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} pt`;
    return kpi.changePct === null ? pts : `${pts} (${kpi.changePct > 0 ? '+' : ''}${kpi.changePct.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %)`;
  }
  if (kpi.changePct === null) return null;
  return `${kpi.changePct > 0 ? '+' : ''}${kpi.changePct.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;
}

export function KpiTrend({ kpi, prevLabel, decimals }: { kpi: KpiValue; prevLabel: string; decimals?: number }) {
  const prev = formatKpiValue(kpi.previous, kpi.unit, { decimals });
  if (kpi.direction === null) {
    return <p className="text-xs text-muted-foreground">Non comparable ({prevLabel} : {prev})</p>;
  }
  const { label, Icon } = DIRECTION[kpi.direction];
  // Évolution depuis zéro : pas de pourcentage (division par zéro).
  const change = formatChange(kpi) ?? (kpi.direction === 'flat' ? '0 %' : 'n.c.');
  return (
    <p className={`flex items-center gap-1 text-xs ${TONE_CLASS[kpi.tone]}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="font-medium">{label} {change}</span>
      <span className="text-muted-foreground">· {prevLabel} : {prev}</span>
    </p>
  );
}

export function KpiCard({
  label, kpi, prevLabel, hint, decimals, children,
}: {
  label: string;
  kpi: KpiValue;
  /** Libellé de la période de comparaison (« août 2026 »). */
  prevLabel: string;
  /** Précision de définition affichée sous le libellé. */
  hint?: string;
  decimals?: number;
  /** Ventilation éventuelle (par offre…). */
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 space-y-1.5">
      <div>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {hint && <p className="text-[11px] text-muted-foreground/80">{hint}</p>}
      </div>
      <p className="text-2xl font-bold tabular-nums">{formatKpiValue(kpi.value, kpi.unit, { decimals })}</p>
      <KpiTrend kpi={kpi} prevLabel={prevLabel} decimals={decimals} />
      {children && <div className="pt-1.5 border-t mt-2">{children}</div>}
    </div>
  );
}
