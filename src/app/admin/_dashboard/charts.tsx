"use client";

/**
 * Graphiques du Dashboard (CDC BO §4.2.2, §4.3).
 *
 * Une série par graphique (un seul axe, jamais de double échelle), couleurs
 * catégorielles en ordre fixe : série 1 bleu, série 2 orange (palette
 * validée daltonisme, variantes claire / sombre). Info-bulle au survol.
 */
import type { ReactNode } from 'react';
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

export const VIZ_STYLE = `
.viz-root { --viz-1: #2a78d6; --viz-2: #eb6834; }
.dark .viz-root { --viz-1: #3987e5; --viz-2: #d95926; }
`;

const tooltipStyle = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--foreground)',
};
const axisTick = { fontSize: 11, fill: 'var(--muted-foreground)' };

export function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="viz-root rounded-xl border bg-card p-4">
      <p className="text-sm font-medium">{title}</p>
      {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      <div className="h-56 mt-3">{children}</div>
    </div>
  );
}

export function TrendLine<T extends Record<string, unknown>>({
  data, dataKey, format, name,
}: { data: T[]; dataKey: string; format: (v: number) => string; name: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} />
        <YAxis tick={axisTick} tickLine={false} axisLine={false} width={72} tickFormatter={(v: number) => format(v)} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => [format(Number(v)), name]} />
        <Line type="monotone" dataKey={dataKey} name={name} stroke="var(--viz-1)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function TrendBars<T extends Record<string, unknown>>({
  data, dataKey, format, name,
}: { data: T[]; dataKey: string; format: (v: number) => string; name: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} />
        <YAxis tick={axisTick} tickLine={false} axisLine={false} width={56} allowDecimals={false} tickFormatter={(v: number) => format(v)} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--muted)', opacity: 0.4 }} formatter={(v) => [format(Number(v)), name]} />
        <Bar dataKey={dataKey} name={name} fill="var(--viz-1)" radius={[4, 4, 0, 0]} maxBarSize={36} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Offre × périodicité dans un même graphique (DOV-003) : barres groupées
 * mensuel / annuel par offre, pour voir si la périodicité change la
 * structure entre offres. Info-bulle avec la part de chaque périodicité.
 */
export function PlanPeriodBars({
  rows, format = (v: number) => v.toLocaleString('fr-FR'),
}: {
  rows: Array<{ label: string; monthly: number; yearly: number }>;
  format?: (v: number) => string;
}) {
  const data = rows.map((r) => ({ ...r, total: r.monthly + r.yearly }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} />
        <YAxis tick={axisTick} tickLine={false} axisLine={false} width={72} tickFormatter={(v: number) => format(v)} />
        <Tooltip
          contentStyle={tooltipStyle}
          cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
          formatter={(v, name, item) => {
            const total = Number((item?.payload as { total?: number })?.total ?? 0);
            const share = total > 0 ? ` (${Math.round((Number(v) / total) * 100)} %)` : '';
            return [`${format(Number(v))}${share}`, name];
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="monthly" name="Mensuel" fill="var(--viz-1)" radius={[4, 4, 0, 0]} maxBarSize={32} />
        <Bar dataKey="yearly" name="Annuel" fill="var(--viz-2)" radius={[4, 4, 0, 0]} maxBarSize={32} />
      </BarChart>
    </ResponsiveContainer>
  );
}
