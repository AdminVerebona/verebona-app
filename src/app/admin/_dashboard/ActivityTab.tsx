"use client";

/**
 * Activité — CDC BO §4.3 : cartes KPI puis graphiques d'évolution. Biens,
 * documents et stockage ne sont pas ventilés par offre. Aucun KPI
 * « utilisateurs actifs » (DACT-003). Le stockage forme un bloc unique
 * (DACT-007) ; ses seuils 80 % / 100 % sont des indicateurs, pas des
 * anomalies (DACT-008).
 */
import { KpiCard, KpiTrend, formatKpiValue } from '@/components/admin/KpiCard';
import type { ActivityData, KpiValue, PerAccountStat } from '@/services/admin/kpi.service';
import { ChartCard, TrendBars, TrendLine } from './charts';
import { PeriodNote, SectionTitle, ViewState } from './shared';
import { useDashboardData } from './useDashboardData';

const int = (v: number) => v.toLocaleString('fr-FR');
const pct = (v: number) => `${(v * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;

function PerAccountBlock({ title, createdLabel, stat, prev }: { title: string; createdLabel: string; stat: PerAccountStat; prev: string }) {
  return (
    <>
      <SectionTitle>{title}</SectionTitle>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <KpiCard label="Stock total" hint="À la fin de la période" kpi={stat.total} prevLabel={prev} />
        <KpiCard label={createdLabel} hint="Sur la période" kpi={stat.created} prevLabel={prev} />
        <KpiCard label="Moyenne par compte" hint="Tous comptes, zéros compris" kpi={stat.meanPerAccount} prevLabel={prev} decimals={1} />
        <KpiCard label="Médiane par compte" hint="Tous comptes, zéros compris" kpi={stat.medianPerAccount} prevLabel={prev} decimals={1} />
      </div>
    </>
  );
}

function StorageRow({ label, kpi, prev }: { label: string; kpi: KpiValue; prev: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 py-2 border-b last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="sm:text-right">
        <p className="text-sm font-semibold tabular-nums">{formatKpiValue(kpi.value, kpi.unit)}</p>
        <KpiTrend kpi={kpi} prevLabel={prev} />
      </div>
    </div>
  );
}

export function ActivityTab({ query }: { query: string }) {
  const { data, loading, error, reload } = useDashboardData<ActivityData>(`/api/admin/dashboard?view=activity&${query}`);
  if (!data) return <ViewState loading={loading} error={error} onRetry={reload} title="Activité indisponible" />;
  const { kpis, period } = data;
  const prev = period.prevLabel;
  const s = kpis.storage;

  return (
    <div className="space-y-4">
      <PeriodNote period={period} />

      <SectionTitle>Activité comptes</SectionTitle>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <KpiCard label="Comptes actifs" hint="Au moins une connexion d'un utilisateur rattaché sur la période" kpi={kpis.activeAccounts} prevLabel={prev} />
        <KpiCard
          label="Taux de comptes actifs"
          hint={`Comptes actifs / comptes accessibles sur la période (${int(kpis.accessibleAccounts)})`}
          kpi={kpis.activeAccountsRate}
          prevLabel={prev}
        />
      </div>

      <PerAccountBlock title="Biens" createdLabel="Biens créés" stat={kpis.assets} prev={prev} />
      <PerAccountBlock title="Documents" createdLabel="Documents ajoutés" stat={kpis.documents} prev={prev} />

      <SectionTitle>Stockage</SectionTitle>
      <div className="rounded-xl border bg-card px-4 py-2 grid grid-cols-1 lg:grid-cols-2 lg:gap-x-8">
        <div>
          <StorageRow label="Volume total" kpi={s.total} prev={prev} />
          <StorageRow label="Volume ajouté sur la période" kpi={s.added} prev={prev} />
          <StorageRow label="Moyenne par compte" kpi={s.meanPerAccount} prev={prev} />
          <StorageRow label="Médiane par compte" kpi={s.medianPerAccount} prev={prev} />
        </div>
        <div>
          <StorageRow label="Maximum observé sur un compte" kpi={s.maxPerAccount} prev={prev} />
          <StorageRow label="Taux moyen d'utilisation du quota" kpi={s.meanQuotaRate} prev={prev} />
          <StorageRow label="Comptes à 80 % ou plus du quota" kpi={s.accountsAtLeast80} prev={prev} />
          <StorageRow label="Comptes à 100 % du quota" kpi={s.accountsAt100} prev={prev} />
        </div>
      </div>

      <SectionTitle>Exports, transmissions et échéances</SectionTitle>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <KpiCard label="Exports générés" hint="Tous modèles confondus" kpi={kpis.exports} prevLabel={prev} />
        <KpiCard label="Transmissions réalisées" kpi={kpis.transmissions} prevLabel={prev} />
        <KpiCard label="Échéances créées manuellement" kpi={kpis.deadlinesManual} prevLabel={prev} />
        <KpiCard label="Échéances créées par l'IA" kpi={kpis.deadlinesAi} prevLabel={prev} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pt-2">
        <ChartCard title="Évolution des comptes actifs">
          <TrendBars data={data.series} dataKey="activeAccounts" format={int} name="Comptes actifs" />
        </ChartCard>
        <ChartCard title="Évolution du taux de comptes actifs">
          <TrendLine data={data.series} dataKey="activeRate" format={pct} name="Taux de comptes actifs" />
        </ChartCard>
        <ChartCard title="Évolution des biens créés">
          <TrendBars data={data.series} dataKey="assetsCreated" format={int} name="Biens créés" />
        </ChartCard>
        <ChartCard title="Évolution des documents ajoutés">
          <TrendBars data={data.series} dataKey="documentsAdded" format={int} name="Documents ajoutés" />
        </ChartCard>
      </div>
    </div>
  );
}
