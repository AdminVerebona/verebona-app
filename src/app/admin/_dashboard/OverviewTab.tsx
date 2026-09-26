"use client";

/**
 * Vue d'ensemble — CDC BO §4.2 : 8 cartes KPI (DOV-001) et 5 graphiques
 * (§4.2.2). L'évolution des comptes actifs n'est pas ici (DOV-004 : onglet
 * Activité). Le CA est affiché sans frais Stripe (DOV-002).
 */
import { KpiCard } from '@/components/admin/KpiCard';
import { formatMoney } from '@/lib/admin/format';
import type { OverviewData } from '@/services/admin/kpi.service';
import { ChartCard, PlanPeriodBars, TrendBars, TrendLine } from './charts';
import { PeriodNote, ViewState } from './shared';
import { useDashboardData } from './useDashboardData';

const eur = (v: number) => formatMoney(Math.round(v), 'eur');
const int = (v: number) => v.toLocaleString('fr-FR');

export function OverviewTab({ query }: { query: string }) {
  const { data, loading, error, reload } = useDashboardData<OverviewData>(`/api/admin/dashboard?view=overview&${query}`);
  if (!data) return <ViewState loading={loading} error={error} onRetry={reload} title="Vue d'ensemble indisponible" />;
  const { kpis, period } = data;
  const prev = period.prevLabel;
  const others = Object.entries(data.otherCurrencies);

  return (
    <div className="space-y-4">
      <PeriodNote period={period} />
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <KpiCard label="Comptes" hint="Total à la fin de la période" kpi={kpis.accounts} prevLabel={prev} />
        <KpiCard label="Utilisateurs" hint="Total à la fin de la période" kpi={kpis.users} prevLabel={prev} />
        <KpiCard label="Abonnements actifs" hint="Abonnements payants à la fin de la période" kpi={kpis.activeSubscriptions} prevLabel={prev}>
          <ul className="text-xs space-y-0.5">
            {data.activeByPlan.map((p) => (
              <li key={p.planCode} className="flex justify-between">
                <span className="text-muted-foreground">{p.label}</span>
                <span className="tabular-nums">{int(p.total)}</span>
              </li>
            ))}
          </ul>
        </KpiCard>
        <KpiCard label="Nouvelles inscriptions" hint="Comptes créés sur la période" kpi={kpis.signups} prevLabel={prev} />
        <KpiCard label="CA encaissé" hint="Paiements encaissés via Stripe, avant frais" kpi={kpis.revenue} prevLabel={prev}>
          {others.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Autres devises (non additionnées) : {others.map(([c, v]) => formatMoney(v, c)).join(' · ')}
            </p>
          )}
        </KpiCard>
        <KpiCard label="MRR" hint="Abonnements actifs, annuel ramené au mois" kpi={kpis.mrr} prevLabel={prev} />
        <KpiCard label="ARR" hint="MRR × 12" kpi={kpis.arr} prevLabel={prev} />
        <KpiCard label="Anomalies en cours" hint="Anomalies ouvertes (Supervision)" kpi={kpis.openAnomalies} prevLabel={prev} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <ChartCard title="Évolution du CA encaissé" subtitle="Euros, par période">
          <TrendBars data={data.series} dataKey="revenueCents" format={eur} name="CA encaissé" />
        </ChartCard>
        <ChartCard title="Évolution du MRR" subtitle="En fin de période">
          <TrendLine data={data.series} dataKey="mrrCents" format={eur} name="MRR" />
        </ChartCard>
        <ChartCard title="Évolution des nouvelles inscriptions">
          <TrendBars data={data.series} dataKey="signups" format={int} name="Inscriptions" />
        </ChartCard>
        <ChartCard title="Évolution des abonnements actifs" subtitle="En fin de période">
          <TrendLine data={data.series} dataKey="activeSubscriptions" format={int} name="Abonnements actifs" />
        </ChartCard>
        <ChartCard title="Abonnements actifs : offre × périodicité" subtitle={`À la fin de ${period.label}`}>
          <PlanPeriodBars rows={data.activeByPlan} />
        </ChartCard>
      </div>
    </div>
  );
}
