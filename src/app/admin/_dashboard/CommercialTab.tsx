"use client";

/**
 * Performance commerciale — CDC BO §4.4. Chaque KPI porte son évolution
 * (DCOM-001). Pas de parrainage ni de codes promo ici (DCOM-002). MRR
 * global uniquement, sans décomposition New/Expansion/Contraction/Churned.
 */
import { KpiCard } from '@/components/admin/KpiCard';
import { formatMoney } from '@/lib/admin/format';
import type { CommercialData } from '@/services/admin/kpi.service';
import { ChartCard, PlanPeriodBars } from './charts';
import { PeriodNote, SectionTitle, ViewState } from './shared';
import { useDashboardData } from './useDashboardData';

const int = (v: number) => v.toLocaleString('fr-FR');
const eur = (v: number) => formatMoney(Math.round(v), 'eur');
const pct = (v: number | null) => (v === null ? 'n.c.' : `${(v * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`);

export function CommercialTab({ query }: { query: string }) {
  const { data, loading, error, reload } = useDashboardData<CommercialData>(`/api/admin/dashboard?view=commercial&${query}`);
  if (!data) return <ViewState loading={loading} error={error} onRetry={reload} title="Performance commerciale indisponible" />;
  const { kpis, period } = data;
  const prev = period.prevLabel;
  const others = Object.entries(data.otherCurrencies);

  return (
    <div className="space-y-4">
      <PeriodNote period={period} />

      <SectionTitle>Acquisition et conversion</SectionTitle>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        <KpiCard label="Nouveaux essais" hint="Essais démarrés sur la période" kpi={kpis.newTrials} prevLabel={prev} />
        <KpiCard label="Nouveaux abonnements payants" hint="Premières facturations sur la période" kpi={kpis.newPaid} prevLabel={prev}>
          <ul className="text-xs space-y-0.5">
            {data.newPaidByPlan.map((p) => (
              <li key={p.planCode} className="flex justify-between">
                <span className="text-muted-foreground">{p.label}</span><span className="tabular-nums">{int(p.count)}</span>
              </li>
            ))}
          </ul>
        </KpiCard>
        <KpiCard
          label="Conversion essai → payant"
          hint={`Dénominateur : essais arrivés à leur terme sur la période (${int(kpis.trialsEnded)})`}
          kpi={kpis.conversion}
          prevLabel={prev}
        />
      </div>

      {data.conversionByPlan.length > 0 && (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b">
                <th className="px-4 py-2 font-medium">Conversion par offre</th>
                <th className="px-4 py-2 font-medium text-right">Essais à terme</th>
                <th className="px-4 py-2 font-medium text-right">Convertis mensuel</th>
                <th className="px-4 py-2 font-medium text-right">Convertis annuel</th>
                <th className="px-4 py-2 font-medium text-right">Taux</th>
              </tr>
            </thead>
            <tbody>
              {data.conversionByPlan.map((r) => (
                <tr key={r.planCode} className="border-b last:border-b-0">
                  <td className="px-4 py-2">{r.label}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{int(r.ended)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{int(r.convertedMonthly)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{int(r.convertedYearly)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{pct(r.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>Rétention et mouvements d&apos;offre</SectionTitle>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <KpiCard label="Résiliations / fins" hint="Abonnements effectivement terminés" kpi={kpis.endedSubscriptions} prevLabel={prev} />
        <KpiCard label="Churn" hint="Fins / abonnements actifs en début de période" kpi={kpis.churn} prevLabel={prev} />
        <KpiCard label="Upgrades" hint="Montées d'offre sur la période" kpi={kpis.upgrades} prevLabel={prev} />
        <KpiCard label="Downgrades" hint="Baisses d'offre sur la période" kpi={kpis.downgrades} prevLabel={prev} />
      </div>

      <SectionTitle>Revenus</SectionTitle>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <KpiCard label="CA encaissé" hint="Avant frais Stripe" kpi={kpis.revenue} prevLabel={prev}>
          {others.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Autres devises (non additionnées) : {others.map(([c, v]) => formatMoney(v, c)).join(' · ')}
            </p>
          )}
        </KpiCard>
        <KpiCard label="MRR" hint="Global" kpi={kpis.mrr} prevLabel={prev} />
        <KpiCard label="ARR" kpi={kpis.arr} prevLabel={prev} />
        <KpiCard label="Revenu récurrent moyen / compte payant" hint="MRR / comptes payants" kpi={kpis.arpa} prevLabel={prev} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <ChartCard title="Abonnements actifs : offre × périodicité" subtitle={`À la fin de ${period.label}`}>
          <PlanPeriodBars rows={data.activeByPlan} />
        </ChartCard>
        <ChartCard title="CA encaissé : offre × périodicité" subtitle={`Euros, ${period.label}`}>
          <PlanPeriodBars
            rows={data.revenueByPlan.map((r) => ({ label: r.label, monthly: r.monthlyCents, yearly: r.yearlyCents }))}
            format={eur}
          />
        </ChartCard>
      </div>
    </div>
  );
}
