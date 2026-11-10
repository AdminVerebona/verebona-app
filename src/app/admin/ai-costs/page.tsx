"use client";

/**
 * Admin — Coûts IA — CDC BO IA SCR-09.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN COÛT INCONNU N'EST PAS UN COÛT NUL
 *
 * C'est la règle qui structure tout l'écran. Un appel sans tarif porte zéro
 * dans la table : le sommer sans précaution ferait afficher une dépense
 * rassurante et fausse.
 *
 * Le SCR-09 l'exige — « afficher coût non calculable plutôt qu'un fallback
 * tarifaire silencieux » — et l'écran le montre à trois endroits : un bandeau
 * quand des appels ne sont pas tarifés, une mention sur chaque ventilation
 * concernée, et une moyenne rendue nulle plutôt qu'approchée.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FONCTIONNEL ET TECHNIQUE SÉPARÉS, TOUJOURS
 *
 * Une campagne de sondes pendant une panne coûte, et le MOD-013 la classe en
 * technique. Les additionner ferait chercher une dérive métier là où il n'y a
 * qu'un incident fournisseur.
 *
 * Lot 113AF (Trello #730) : « métier » = ORIGINE du coût (service d'un
 * compte, tâches de fond comprises, T1 à T6, même pour une étape hors quota),
 * classée par la règle unique `cost/cost-classification.ts` — plus l'ancien
 * indicateur de quota. Coût fournisseur total = métier + technique + non
 * déterminable (historique) ; coût inconnu compté à part, par segment.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT IA 2
 *
 * · Période : aujourd'hui, 7 j, 30 j, mois calendaire, année, personnalisée
 *   (COST-002, CST-UI-01) ; filtres lus depuis l'URL (liens préfiltrés).
 * · Ventilation par compte (CST-UI-06) et environnement (COST-003) ; usage T2
 *   comparé au coût (COST-015).
 * · Chaque ligne de ventilation ouvre les exécutions filtrées (COST-009,
 *   CST-UI-10).
 * · Budgets global et T1–T6, détection d'anomalies activable, alertes
 *   (COST-010 à COST-014, CST-UI-08, CST-UI-09, WF-22, WF-44).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN BOUTON NE COUPE RIEN
 *
 * « Une alerte de coût ne suspend jamais automatiquement un traitement. »
 * L'écran mesure et alerte ; il ne propose aucune action de suspension, qui se
 * fait depuis la file et en connaissance de cause.
 */

import type { TreatmentSummary } from '@/services/ai/business-execution/types';
import { Suspense, useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, RefreshCw, AlertTriangle, ArrowRight, Bell } from 'lucide-react';
import { toast } from 'sonner';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { apiClient } from '@/lib/api-client';
import {
  periodBounds, T6_MODES, T6_MODE_LABELS, type CostPeriod,
} from '@/services/ai/telemetry/execution-filters';
import { AiEnvBanner } from '../ai-dashboard/_components/AiEnvBanner';
import { UnpricedPanel } from './_components/UnpricedPanel';

interface Breakdown {
  key: string; label: string;
  functionalMicros: number; technicalMicros: number;
  /** Lot 113AF : historique non déterminable. */
  undeterminedMicros?: number;
  calls: number; unpricedCalls: number;
}

interface Report {
  since: string; until: string;
  totals: {
    functionalMicros: number; technicalMicros: number; calls: number;
    failedCalls: number; inputTokens: number; outputTokens: number; unpricedCalls: number;
    /** Lot 109L : coût initial / régularisé, statuts. */
    initialMicros?: number; regularizedCalls?: number; regularizedMicros?: number; staleTariffCalls?: number;
    byStatus?: { applied: number; zeroOrRounded: number; missing: number; insufficientUsage: number; legacyUndetermined: number; regularized: number };
    /** Lot 113AF : coût fournisseur, observation, non déterminable, reclassé, inconnu par segment, lignes classées à la lecture. */
    providerMicros?: number; shadowMicros?: number; undeterminedMicros?: number;
    reclassifiedBusinessMicros?: number; reclassifiedBusinessCalls?: number;
    unpricedBusinessCalls?: number; unpricedTechnicalCalls?: number; unpricedUndeterminedCalls?: number;
    provisionalRows?: number; classification?: 'classified' | 'derived' | 'legacy';
  };
  /** Lot 113AF : explication des segments (textes à valider par le PO). */
  segmentHelp?: { provider: string; business: string; technical: string; undetermined: string; unknown: string; quota: string };
  byOperation?: Breakdown[];
  byOrigin?: Breakdown[];
  byDay?: Breakdown[];
  completeness?: 'complete' | 'partial' | 'unknown';
  completenessLabel?: string;
  averageIsPartial?: boolean;
  byTreatment: Breakdown[];
  byModel: Breakdown[];
  byRank: Breakdown[];
  byVersion: Breakdown[];
  byAccount: Breakdown[];
  incomplete: boolean;
  averageCostPerCall: number | null;
  warning: string | null;
  environment: string | null;
  t2Usage: { requests: number; withAi: number; costMicros: number } | null;
  /** Lot 113AE (#728, AC14) : questions T2 par offre RÉELLE tracée. */
  t2UsageByOffer?: T2OfferUsage[] | null;
  /** Lot 99A : réponses sans appel facturé (cache) et décisions réutilisées — jamais comptées comme appels. */
  reuse?: { available: boolean; cacheResponses: number; decisionsReused: number } | null;
}

interface Settings { anomaliesEnabled: boolean; budgets: Array<{ scope: string; monthlyBudget: number | null }> }
interface Alert { id: number; kind: string; code: string; treatment: string | null; severity: string; message: string; drilldownHref: string | null; createdAt: string }

const PERIODS: Array<{ key: CostPeriod; api: string; label: string }> = [
  { key: 'today', api: 'today', label: "Aujourd'hui" },
  { key: 'week', api: '7d', label: '7 jours' },
  { key: 'month30', api: '30d', label: '30 jours' },
  { key: 'calendarMonth', api: 'month', label: 'Mois en cours' },
  { key: 'year', api: 'year', label: 'Année' },
  { key: 'custom', api: 'custom', label: 'Personnalisée' },
];

const USE_CASE_TO_T: Record<string, string> = {
  SOURCE_ANALYSIS: 'T1', INTELLIGENT_ASSISTANT: 'T2', DATA_RECONCILIATION: 'T3',
  // Lot 49 : AI_GOVERNANCE (technique) n'a pas de traitement — pas de lien filtré.
  AGENDA_INTELLIGENCE: 'T4', HOME_MASCOT: 'T6',
};

function usd(micros: number): string {
  if (micros === 0) return '0 $';
  if (micros < 10_000) return `${(micros / 1_000_000).toFixed(4)} $`;
  return `${(micros / 1_000_000).toFixed(2)} $`;
}

interface T2OfferUsage {
  offer: string; requests: number; withAi: number; aiRate: number | null; aiCalls: number;
  costMicros: number; costPerRequestMicros: number | null; accessRefused: number;
}

/** Libellés des offres commerciales tracées (jamais un code brut à l'écran). */
const OFFER_LABELS: Record<string, string> = {
  standard: 'Standard', trial: 'Essai', premium: 'Premium', premium_duo: 'Premium Duo',
  none: 'Sans offre active', unknown: 'Non tracée (avant le lot 113AE)',
};

/**
 * Lot 113AE (#728, AC14) : questions à Verebona par offre RÉELLE — taux
 * d'appels modèle, coût total et coût moyen par question (comparaison
 * Standard / Premium à données égales).
 */
function T2ParOffre({ rows }: { rows: T2OfferUsage[] }) {
  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <div>
        <h2 className="vb-app-section">Questions à Verebona par offre</h2>
        <p className="text-xs text-[color:var(--text-muted)]">
          Offre réelle enregistrée avec chaque question. Taux d’appels = part des questions avec au moins un appel au modèle.
        </p>
      </div>
      {rows.length === 0 && <p className="text-sm text-[color:var(--text-muted)]">Aucune question sur la période.</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[color:var(--text-muted)]">
                <th className="py-1 pr-3 font-medium">Offre</th>
                <th className="py-1 pr-3 font-medium text-right">Questions</th>
                <th className="py-1 pr-3 font-medium text-right">Taux d’appels</th>
                <th className="py-1 pr-3 font-medium text-right">Appels</th>
                <th className="py-1 pr-3 font-medium text-right">Coût</th>
                <th className="py-1 pr-3 font-medium text-right">Coût / question</th>
                <th className="py-1 font-medium text-right">Sans IA (compte)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.offer} className="border-t border-[color:var(--border-subtle)] text-[color:var(--text-primary)]">
                  <td className="py-1.5 pr-3">{OFFER_LABELS[r.offer] ?? r.offer}</td>
                  <td className="py-1.5 pr-3 text-right">{r.requests}</td>
                  <td className="py-1.5 pr-3 text-right">{r.aiRate === null ? '—' : `${Math.round(r.aiRate * 100)} %`}</td>
                  <td className="py-1.5 pr-3 text-right">{r.aiCalls}</td>
                  <td className="py-1.5 pr-3 text-right">{usd(r.costMicros)}</td>
                  <td className="py-1.5 pr-3 text-right">{r.costPerRequestMicros === null ? '—' : usd(r.costPerRequestMicros)}</td>
                  <td className="py-1.5 text-right text-[color:var(--text-secondary)]">{r.accessRefused}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Lot 113AF (#730) : explication des segments de coût (textes nouveaux, à
 * valider par le PO) et état du classement de l'historique.
 */
function LectureDesCouts({ help, provisional, mode }: {
  help: NonNullable<Report['segmentHelp']>; provisional: number; mode: 'classified' | 'derived' | 'legacy';
}) {
  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-2">
      <h2 className="vb-app-section">Comment lire ces montants</h2>
      <dl className="grid gap-2 sm:grid-cols-2 text-xs text-[color:var(--text-secondary)]">
        {([
          ['Coût fournisseur total', help.provider], ['Dépense métier', help.business], ['Technique et essais', help.technical],
          ['Coût inconnu', help.unknown], ['Origine non déterminable', help.undetermined], ['Quotas des offres', help.quota],
        ] as const).map(([t, d]) => (
          <div key={t}>
            <dt className="font-medium text-[color:var(--text-primary)]">{t}</dt>
            <dd>{d}</dd>
          </div>
        ))}
      </dl>
      {mode === 'legacy' && (
        <p className="text-xs text-[color:var(--text-warning-soft)]">
          Lecture dégradée : la base n’a pas encore les colonnes de classement. Le partage métier / technique suit l’ancien indicateur de quota.
        </p>
      )}
      {mode !== 'legacy' && provisional > 0 && (
        <p className="text-xs text-[color:var(--text-muted)]">
          {provisional} appel(s) de la période sont classés à la lecture par la même règle. Pour figer ce classement (traçable et restaurable) :
          {' '}<Link href="/admin/exploitation" className="text-[color:var(--accent)] hover:underline">Exploitation › Rattrapages › IA : origine des coûts</Link>.
        </p>
      )}
    </div>
  );
}

function Ventilation({ title, rows, hint, hrefFor }: {
  title: string; rows: Breakdown[]; hint?: string; hrefFor: (r: Breakdown) => string | null;
}) {
  const totalOf = (r: Breakdown) => r.functionalMicros + r.technicalMicros + (r.undeterminedMicros ?? 0);
  const max = Math.max(1, ...rows.map(totalOf));
  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <div>
        <h2 className="vb-app-section">{title}</h2>
        {hint && <p className="text-xs text-[color:var(--text-muted)]">{hint}</p>}
      </div>
      {rows.length === 0 && <p className="text-sm text-[color:var(--text-muted)]">Aucune dépense sur la période.</p>}
      {rows.map((r) => {
        const total = totalOf(r);
        const href = hrefFor(r);
        const inner = (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-[color:var(--text-primary)] truncate">{r.label}</span>
              <span className="text-sm text-[color:var(--text-secondary)] shrink-0">{usd(total)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-[color:var(--bg-page)] overflow-hidden">
              <div className="h-full bg-[color:var(--accent)]" style={{ width: `${Math.round((total / max) * 100)}%` }} />
            </div>
            <p className="text-xs text-[color:var(--text-muted)]">
              {r.calls} appel{r.calls > 1 ? 's' : ''}
              {r.technicalMicros > 0 && ` · dont ${usd(r.technicalMicros)} technique`}
              {(r.undeterminedMicros ?? 0) > 0 && ` · dont ${usd(r.undeterminedMicros ?? 0)} d’origine non déterminable`}
              {r.unpricedCalls > 0 && <span className="text-[color:var(--text-warning-soft)]"> · {r.unpricedCalls} sans tarif</span>}
            </p>
          </>
        );
        // COST-009 : tout agrégat ouvre les exécutions correspondantes.
        return href
          ? <Link key={r.key} href={href} className="block space-y-1 rounded hover:bg-[color:var(--bg-hover)]">{inner}</Link>
          : <div key={r.key} className="space-y-1">{inner}</div>;
      })}
    </div>
  );
}

export default function AiCostsPage() {
  return (
    <Suspense fallback={<div className="py-20 text-center text-[color:var(--text-muted)]">Chargement…</div>}>
      <AiCostsScreen />
    </Suspense>
  );
}

function AiCostsScreen() {
  const router = useRouter();
  const sp = useSearchParams();
  const initialPeriod = PERIODS.find((p) => p.api === sp.get('period') || p.key === sp.get('period'))?.key ?? 'month30';
  const [period, setPeriod] = useState<CostPeriod>(initialPeriod);
  const [custom, setCustom] = useState({ from: sp.get('from') ?? '', to: sp.get('to') ?? '' });
  const [treatment, setTreatment] = useState(sp.get('treatment') ?? '');
  const [accountId, setAccountId] = useState(/^\d+$/.test(sp.get('accountId') ?? '') ? sp.get('accountId')! : '');
  // CDC Mascotte BO-009 : génération T6 affichée / pré-génération / secours.
  const [t6Mode, setT6Mode] = useState((T6_MODES as readonly string[]).includes(sp.get('t6Mode') ?? '') ? sp.get('t6Mode')! : '');
  const [report, setReport] = useState<Report | null>(null);
  /** Lot 83C : issues MÉTIER de la même période (chaque exécution comptée une fois). */
  const [metier, setMetier] = useState<{ summary: TreatmentSummary[]; period: { from: string; to: string; rule: string } } | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draftBudgets, setDraftBudgets] = useState<Record<string, string>>({});
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  // Lot 109L : détail « Appels non chiffrés » ouvert depuis le bandeau (ou l'URL `unpriced=1`).
  const [detailOuvert, setDetailOuvert] = useState(sp.get('unpriced') === '1');

  const bounds = periodBounds(period, new Date(), custom);

  useEffect(() => {
    const q = new URLSearchParams({ period: PERIODS.find((p) => p.key === period)!.api });
    if (period === 'custom') { q.set('from', bounds.from); q.set('to', bounds.to); }
    if (treatment) q.set('treatment', treatment);
    if (accountId) q.set('accountId', accountId);
    if (t6Mode) q.set('t6Mode', t6Mode);
    router.replace(`?${q}`, { scroll: false });
  }, [period, bounds.from, bounds.to, treatment, accountId, t6Mode, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setErreur(null);
    try {
      const q = new URLSearchParams({ period: PERIODS.find((p) => p.key === period)!.api });
      if (period === 'custom') { q.set('since', `${bounds.from}T00:00:00Z`); q.set('until', `${bounds.to}T23:59:59.999Z`); }
      if (treatment) q.set('treatment', treatment);
      if (accountId) q.set('accountId', accountId);
      if (t6Mode) q.set('t6Mode', t6Mode);
      const qm = new URLSearchParams({ from: bounds.from, to: bounds.to, limit: '1' });
      if (treatment) qm.set('treatment', treatment);
      if (accountId) qm.set('accountId', accountId);
      const [r, s, a, m] = await Promise.all([
        apiClient.get<Report>(`/api/admin/ai/costs?${q}`),
        apiClient.get<Settings>('/api/admin/ai/cost-settings').catch(() => null),
        apiClient.get<{ alerts: Alert[] }>('/api/admin/ai/alerts?open=1&limit=30').catch(() => ({ alerts: [] })),
        apiClient.get<{ summary: TreatmentSummary[]; period: { from: string; to: string; rule: string } }>(`/api/admin/ai/business-executions?${qm}`).catch(() => null),
      ]);
      setReport(r);
      setMetier(m);
      setSettings(s);
      if (s) setDraftBudgets(Object.fromEntries(s.budgets.map((b) => [b.scope, b.monthlyBudget == null ? '' : String(b.monthlyBudget)])));
      setAlerts(a.alerts.filter((x) => x.kind !== 'guardrail'));
    } catch (e) {
      const err = e as { message?: string; code?: string; status?: number };
      setErreur([err.message, err.code && `(${err.code}${err.status ? ` — ${err.status}` : ''})`].filter(Boolean).join(' ') || null);
      toast.error('Chargement impossible.');
    } finally {
      setLoading(false);
    }
  }, [period, bounds.from, bounds.to, treatment, accountId, t6Mode]);

  useEffect(() => { load(); }, [load]);

  const saveSettings = async (patch: Partial<Settings>) => {
    try {
      await apiClient.put('/api/admin/ai/cost-settings', patch);
      toast.success('Paramètres de coût enregistrés.');
      load();
    } catch (e) {
      toast.error((e as Error).message || 'Enregistrement impossible.');
    }
  };

  const acknowledge = async (id: number) => {
    try {
      await apiClient.post(`/api/admin/ai/alerts/${id}/acknowledge`, {});
      setAlerts((a) => a.filter((x) => x.id !== id));
    } catch { toast.error('Acquittement impossible.'); }
  };

  if (erreur) return <EcranEnErreur titre="Coûts indisponibles" message={erreur} onRetry={load} />;

  // Lien préfiltré vers les exécutions de la période (COST-009).
  const execHref = (extra: Record<string, string>) => {
    const q = new URLSearchParams({ from: bounds.from, to: bounds.to, ...extra });
    if (treatment && !extra.treatment) q.set('treatment', treatment);
    if (accountId && !extra.accountId) q.set('accountId', accountId);
    if (t6Mode && !extra.t6Mode) q.set('t6Mode', t6Mode);
    return `/admin/ai-executions?${q}`;
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* VER-026 / GST-01 : environnement et état global, sur chaque page IA */}
      <AiEnvBanner />
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="vb-app-title">Coûts IA</h1>
          <p className="text-sm text-[color:var(--text-muted)]">
            {report ? <>Du {new Date(report.since).toLocaleDateString('fr-FR')} au {new Date(report.until).toLocaleDateString('fr-FR')}</> : '…'}
            {report?.environment && ` · environnement ${report.environment}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PERIODS.map((p) => (
            <Button key={p.key} size="sm" variant={period === p.key ? 'default' : 'outline'} onClick={() => setPeriod(p.key)}>
              {p.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={load} aria-label="Actualiser"><RefreshCw className="w-3.5 h-3.5" /></Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        {period === 'custom' && (
          <>
            <Input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="max-w-[160px] bg-[color:var(--bg-input)]" />
            <Input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="max-w-[160px] bg-[color:var(--bg-input)]" />
          </>
        )}
        <select value={treatment} onChange={(e) => setTreatment(e.target.value)}
          className="rounded-lg border border-[color:var(--input)] bg-[color:var(--bg-input)] px-3 py-2 text-sm text-[color:var(--text-primary)]">
          <option value="">Tous les traitements</option>
          {['T1', 'T2', 'T3', 'T4', 'T6'].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={t6Mode} onChange={(e) => setT6Mode(e.target.value)} aria-label="Mode de génération T6"
          className="rounded-lg border border-[color:var(--input)] bg-[color:var(--bg-input)] px-3 py-2 text-sm text-[color:var(--text-primary)]">
          <option value="">Tous les modes T6</option>
          {T6_MODES.map((m) => <option key={m} value={m}>{T6_MODE_LABELS[m]}</option>)}
        </select>
        <Input placeholder="Compte" value={accountId} inputMode="numeric" onChange={(e) => setAccountId(e.target.value.replace(/\D/g, ''))}
          className="max-w-[120px] bg-[color:var(--bg-input)]" />
      </div>

      {alerts.length > 0 && (
        <div className="rounded-xl border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] p-4 space-y-2">
          <h2 className="vb-app-section flex items-center gap-2">
            <Bell className="w-4 h-4 text-[color:var(--text-warning-soft)]" /> Alertes de coût
          </h2>
          <p className="text-xs text-[color:var(--text-muted)]">Une alerte de coût n&apos;interrompt jamais un traitement (COST-013).</p>
          {alerts.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-2 text-sm text-[color:var(--text-secondary)]">
              <span className="text-xs px-1.5 py-0.5 rounded bg-[color:var(--bg-warning)] text-[color:var(--text-warning-soft)]">{a.kind === 'budget' ? 'Budget' : 'Anomalie'}</span>
              <span className="flex-1">{a.message}</span>
              {a.drilldownHref && <Link href={a.drilldownHref} className="text-xs text-[color:var(--accent)] hover:underline">Voir</Link>}
              <Button size="sm" variant="ghost" onClick={() => acknowledge(a.id)}>Acquitter</Button>
            </div>
          ))}
        </div>
      )}

      {loading || !report ? (
        <div className="flex items-center justify-center py-20 text-[color:var(--text-muted)]">
          <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Chargement…
        </div>
      ) : (
        <>
          {report.warning && (
            <div className="rounded-xl border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] p-4 flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-[color:var(--text-warning-soft)] shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-[color:var(--text-primary)]">{report.warning}</p>
                <p className="text-xs text-[color:var(--text-muted)]">
                  Le coût de ces appels n&apos;est pas estimé : il serait faux. Rafraîchissez la grille tarifaire depuis l&apos;écran Fournisseur IA.
                </p>
                <div className="flex flex-wrap gap-3 mt-1">
                  <button type="button" className="text-xs text-[color:var(--accent)] hover:underline" onClick={() => setDetailOuvert((v) => !v)}>
                    {detailOuvert ? 'Masquer le détail' : 'Voir le détail par modèle et par cause'}
                  </button>
                  <Link href="/admin/ai-provider#tarifs" className="text-xs text-[color:var(--accent)] hover:underline">État des tarifs</Link>
                </div>
              </div>
            </div>
          )}
          {detailOuvert && (
            <UnpricedPanel since={report.since} until={report.until} />
          )}
          {!report.warning && (
            <button type="button" className="text-xs text-[color:var(--accent)] hover:underline" onClick={() => setDetailOuvert((v) => !v)}>
              {detailOuvert ? 'Masquer le diagnostic des coûts' : 'Diagnostic et régularisation des coûts'}
            </button>
          )}

          <div className="grid gap-3 grid-cols-1 sm:grid-cols-3 lg:grid-cols-6">
            {[
              // Lot 109L : complet / partiel / inconnu — jamais une dépense partielle présentée comme un total.
              // Lot 113AF : coût fournisseur total = métier + technique (+ historique non déterminable).
              ['Coût fournisseur total', `${usd(report.totals.providerMicros ?? (report.totals.functionalMicros + report.totals.technicalMicros))}${report.completeness && report.completeness !== 'complete' ? ' *' : ''}`,
                report.completeness && report.completeness !== 'complete'
                  ? `${report.completenessLabel ?? 'Partiel'}${(report.totals.regularizedCalls ?? 0) > 0 ? ` · dont ${usd(report.totals.regularizedMicros ?? 0)} régularisés (${report.totals.regularizedCalls} appel(s))` : ''}`
                  : (report.totals.regularizedCalls ?? 0) > 0 ? `dont ${usd(report.totals.regularizedMicros ?? 0)} régularisés (${report.totals.regularizedCalls} appel(s)) · coût initial ${usd(report.totals.initialMicros ?? 0)}` : 'Estimation d’après les jetons, pas une facture'],
              ['Dépense métier', `${usd(report.totals.functionalMicros)}${(report.totals.unpricedBusinessCalls ?? 0) > 0 ? ' *' : ''}`,
                [(report.totals.unpricedBusinessCalls ?? 0) > 0 ? `Partielle : ${report.totals.unpricedBusinessCalls} appel(s) au coût inconnu` : 'Service des comptes, tâches de fond comprises',
                  (report.totals.reclassifiedBusinessCalls ?? 0) > 0 ? `dont ${usd(report.totals.reclassifiedBusinessMicros ?? 0)} hors quota (${report.totals.reclassifiedBusinessCalls} appel(s))` : ''].filter(Boolean).join(' · ')],
              ['Technique et essais', `${usd(report.totals.technicalMicros)}${(report.totals.unpricedTechnicalCalls ?? 0) > 0 ? ' *' : ''}`,
                [`Sondes, qualification, corpus, tests${(report.totals.shadowMicros ?? 0) > 0 ? ` · dont ${usd(report.totals.shadowMicros ?? 0)} en observation` : ''}`,
                  (report.totals.unpricedTechnicalCalls ?? 0) > 0 ? `Partiel : ${report.totals.unpricedTechnicalCalls} appel(s) au coût inconnu` : ''].filter(Boolean).join(' · ')],
              ...((report.totals.undeterminedMicros ?? 0) > 0 || (report.totals.unpricedUndeterminedCalls ?? 0) > 0
                ? [['Origine non déterminable', usd(report.totals.undeterminedMicros ?? 0), 'Historique sans élément fiable : compté à part, jamais deviné'] as [string, string, string]]
                : []),
              // Lot 83C (SEM-05) : statut fournisseur des appels — l'issue métier est la tuile suivante.
              ['Appels modèle', String(report.totals.calls), `${report.totals.failedCalls} en échec (technique) · ${(report.totals.inputTokens + report.totals.outputTokens).toLocaleString('fr-FR')} tokens`],
              ...(metier ? [(() => {
                const t = metier.summary.reduce((a, x) => ({ ok: a.ok + x.succeeded, inc: a.inc + x.incomplete, ko: a.ko + x.failed }), { ok: 0, inc: 0, ko: 0 });
                const jours = Math.round((new Date(metier.period.to).getTime() - new Date(metier.period.from).getTime()) / 86_400_000);
                // Lot 84D (BO-11, C-Q9) : volume pour rapporter les coûts ; les échecs et incomplètes
                // ne sont comptés qu'aux cartes d'Exécutions & logs (aucun double affichage).
                return ['Exécutions métier', String(t.ok + t.inc + t.ko),
                  `${t.ok} réussie${t.ok > 1 ? 's' : ''}${t.inc + t.ko ? ' · échecs et incomplètes : Exécutions & logs' : ''}${jours < 89 ? '' : ' · 90 derniers jours au plus'}`] as [string, string, string];
              })()] : []),
              // Lot 99A (point D) : ce qui a répondu SANS appel facturé (0 coût) — distinct des appels modèle.
              ['Sans appel facturé', report.reuse?.available ? String(report.reuse.cacheResponses + report.reuse.decisionsReused) : '—',
                report.reuse?.available ? `${report.reuse.cacheResponses} réponse(s) du cache · ${report.reuse.decisionsReused} décision(s) réutilisée(s) · 0 coût` : 'Non mesuré (migration 0858 absente)'],
              ['Coût moyen par appel', report.averageCostPerCall === null ? '—' : usd(report.averageCostPerCall),
                report.averageCostPerCall === null ? 'Aucun appel tarifé' : report.averageIsPartial ? `Sur les appels chiffrés seulement (${report.totals.unpricedCalls} non chiffré(s))` : null],
              ['Requêtes T2', report.t2Usage ? String(report.t2Usage.requests) : '—',
                report.t2Usage ? `dont ${report.t2Usage.withAi} avec IA · ${report.t2Usage.requests - report.t2Usage.withAi} sans coût` : null],
            ].map(([label, value, hint]) => (
              <div key={label} className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4">
                <p className="text-sm text-[color:var(--text-muted)]">{label}</p>
                <p className="text-2xl font-bold text-[color:var(--text-primary)]">{value}</p>
                {hint && <p className="text-xs text-[color:var(--text-muted)]">{hint}</p>}
              </div>
            ))}
          </div>

          {report.segmentHelp && <LectureDesCouts help={report.segmentHelp} provisional={report.totals.provisionalRows ?? 0} mode={report.totals.classification ?? 'classified'} />}

          {report.t2UsageByOffer && <T2ParOffre rows={report.t2UsageByOffer} />}

          <div className="grid gap-4 sm:grid-cols-2">
            <Ventilation title="Par traitement" rows={report.byTreatment}
              hrefFor={(r) => (USE_CASE_TO_T[r.key] ? execHref({ treatment: USE_CASE_TO_T[r.key] }) : null)} />
            <Ventilation title="Par modèle" rows={report.byModel} hrefFor={(r) => (r.key !== '—' ? execHref({ model: r.key }) : null)} />
            <Ventilation title="Par rang de modèle" rows={report.byRank}
              hint="Une dépense de repli importante signale un modèle principal en difficulté."
              hrefFor={(r) => (['primary', 'fallback_1', 'fallback_2'].includes(r.key) ? execHref({ rank: r.key }) : null)} />
            <Ventilation title="Par version de configuration" rows={report.byVersion}
              hint="Les coûts ne sont jamais recalculés : un changement de tarif ne réécrit pas le passé."
              hrefFor={() => execHref({})} />
            <Ventilation title="Par compte (les plus coûteux)" rows={report.byAccount}
              hint="Dépense métier imputée à chaque compte ; le plafond mensuel d’un compte se fonde sur cette dépense."
              hrefFor={(r) => (/^\d+$/.test(r.key) ? execHref({ accountId: r.key }) : null)} />
            {report.byOrigin && (
              <Ventilation title="Par origine du coût" rows={report.byOrigin}
                hint="Pourquoi un appel est classé métier, technique ou non déterminable."
                hrefFor={() => null} />
            )}
            {report.byOperation && (
              <Ventilation title="Par étape IA (code du référentiel)" rows={report.byOperation}
                hint="Chaque étape exécutée, qu’elle compte ou non dans le quota de l’offre."
                hrefFor={() => null} />
            )}
            {report.byDay && (
              <Ventilation title="Par jour" rows={report.byDay.slice(0, 31)}
                hint="Journées de la période (UTC), les plus récentes d’abord."
                hrefFor={(r) => (/^\d{4}-\d{2}-\d{2}$/.test(r.key) ? `/admin/ai-executions?from=${r.key}&to=${r.key}` : null)} />
            )}
          </div>

          <Link href={execHref({})} className="inline-flex items-center gap-1.5 text-sm text-[color:var(--accent)] hover:underline">
            Voir les appels de la période <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </>
      )}

      {settings && (
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-4">
          <div>
            <h2 className="vb-app-section">Budgets mensuels et anomalies</h2>
            <p className="text-xs text-[color:var(--text-muted)]">
              Paramètres de cet environnement, hors configuration versionnée. Mois calendaire, dépense métier
              (service des comptes, toutes les étapes T1 à T6, tâches de fond comprises, sans les sondes ni les essais),
              en $ (devise de la grille tarifaire). Un dépassement crée une alerte, jamais une suspension.
            </p>
            {report && report.completeness && report.completeness !== 'complete' && (
              <p className="text-xs text-[color:var(--text-warning-soft)]">
                Suivi budgétaire et plafonds PARTIELS : {report.totals.unpricedCalls} appel(s) non chiffré(s) sur la période — la dépense réelle peut être supérieure.
              </p>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-4">
            {settings.budgets.map((b) => (
              <label key={b.scope} className="text-sm text-[color:var(--text-secondary)] space-y-1">
                <span>{b.scope === 'global' ? 'Global' : b.scope}</span>
                <Input inputMode="decimal" placeholder="Aucun" value={draftBudgets[b.scope] ?? ''}
                  onChange={(e) => setDraftBudgets({ ...draftBudgets, [b.scope]: e.target.value.replace(',', '.') })}
                  className="bg-[color:var(--bg-input)]" />
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => {
              const budgets = settings.budgets.map((b) => {
                const raw = (draftBudgets[b.scope] ?? '').trim();
                return { scope: b.scope, monthlyBudget: raw === '' ? null : Number(raw) };
              });
              if (budgets.some((b) => b.monthlyBudget !== null && (!Number.isFinite(b.monthlyBudget) || b.monthlyBudget < 0))) {
                toast.error('Un budget doit être un montant positif, ou vide.');
                return;
              }
              saveSettings({ budgets });
            }}>Enregistrer les budgets</Button>
            <label className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
              <input type="checkbox" checked={settings.anomaliesEnabled}
                onChange={(e) => saveSettings({ anomaliesEnabled: e.target.checked })} />
              Détection automatique des anomalies (coût, coût par appel, volume, fallback, compte)
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
