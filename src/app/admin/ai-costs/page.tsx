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

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, RefreshCw, AlertTriangle, ArrowRight, Bell } from 'lucide-react';
import { toast } from 'sonner';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { apiClient } from '@/lib/api-client';
import { periodBounds, type CostPeriod } from '@/services/ai/telemetry/execution-filters';
import { AiEnvBanner } from '../ai-dashboard/_components/AiEnvBanner';

interface Breakdown {
  key: string; label: string;
  functionalMicros: number; technicalMicros: number;
  calls: number; unpricedCalls: number;
}

interface Report {
  since: string; until: string;
  totals: {
    functionalMicros: number; technicalMicros: number; calls: number;
    failedCalls: number; inputTokens: number; outputTokens: number; unpricedCalls: number;
  };
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
  AGENDA_INTELLIGENCE: 'T4', AI_GOVERNANCE: 'T5', HOME_MASCOT: 'T6',
};

function usd(micros: number): string {
  if (micros === 0) return '0 $';
  if (micros < 10_000) return `${(micros / 1_000_000).toFixed(4)} $`;
  return `${(micros / 1_000_000).toFixed(2)} $`;
}

function Ventilation({ title, rows, hint, hrefFor }: {
  title: string; rows: Breakdown[]; hint?: string; hrefFor: (r: Breakdown) => string | null;
}) {
  const max = Math.max(1, ...rows.map((r) => r.functionalMicros + r.technicalMicros));
  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">{title}</h2>
        {hint && <p className="text-xs text-[color:var(--text-muted)]">{hint}</p>}
      </div>
      {rows.length === 0 && <p className="text-sm text-[color:var(--text-muted)]">Aucune dépense sur la période.</p>}
      {rows.map((r) => {
        const total = r.functionalMicros + r.technicalMicros;
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
              {r.unpricedCalls > 0 && <span className="text-amber-500"> · {r.unpricedCalls} sans tarif</span>}
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
  const [report, setReport] = useState<Report | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draftBudgets, setDraftBudgets] = useState<Record<string, string>>({});
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);

  const bounds = periodBounds(period, new Date(), custom);

  useEffect(() => {
    const q = new URLSearchParams({ period: PERIODS.find((p) => p.key === period)!.api });
    if (period === 'custom') { q.set('from', bounds.from); q.set('to', bounds.to); }
    if (treatment) q.set('treatment', treatment);
    if (accountId) q.set('accountId', accountId);
    router.replace(`?${q}`, { scroll: false });
  }, [period, bounds.from, bounds.to, treatment, accountId, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setErreur(null);
    try {
      const q = new URLSearchParams({ period: PERIODS.find((p) => p.key === period)!.api });
      if (period === 'custom') { q.set('since', `${bounds.from}T00:00:00Z`); q.set('until', `${bounds.to}T23:59:59.999Z`); }
      if (treatment) q.set('treatment', treatment);
      if (accountId) q.set('accountId', accountId);
      const [r, s, a] = await Promise.all([
        apiClient.get<Report>(`/api/admin/ai/costs?${q}`),
        apiClient.get<Settings>('/api/admin/ai/cost-settings').catch(() => null),
        apiClient.get<{ alerts: Alert[] }>('/api/admin/ai/alerts?open=1&limit=30').catch(() => ({ alerts: [] })),
      ]);
      setReport(r);
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
  }, [period, bounds.from, bounds.to, treatment, accountId]);

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
    return `/admin/ai-executions?${q}`;
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* VER-026 / GST-01 : environnement et état global, sur chaque page IA */}
      <AiEnvBanner />
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[color:var(--text-primary)]">Coûts IA</h1>
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
          className="rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-input)] px-3 py-2 text-sm text-[color:var(--text-primary)]">
          <option value="">Tous les traitements</option>
          {['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <Input placeholder="Compte" value={accountId} inputMode="numeric" onChange={(e) => setAccountId(e.target.value.replace(/\D/g, ''))}
          className="max-w-[120px] bg-[color:var(--bg-input)]" />
      </div>

      {alerts.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
          <h2 className="text-sm font-semibold text-[color:var(--text-primary)] flex items-center gap-2">
            <Bell className="w-4 h-4 text-amber-500" /> Alertes de coût
          </h2>
          <p className="text-xs text-[color:var(--text-muted)]">Une alerte de coût n&apos;interrompt jamais un traitement (COST-013).</p>
          {alerts.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-2 text-sm text-[color:var(--text-secondary)]">
              <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500">{a.kind === 'budget' ? 'Budget' : 'Anomalie'}</span>
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
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-[color:var(--text-primary)]">{report.warning}</p>
                <p className="text-xs text-[color:var(--text-muted)]">
                  Le coût de ces appels n&apos;est pas estimé : il serait faux. Rafraîchissez la grille tarifaire depuis l&apos;écran Fournisseur IA.
                </p>
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-5">
            {[
              ['Dépense métier', usd(report.totals.functionalMicros), null],
              ['Technique et tests', usd(report.totals.technicalMicros), 'Sondes, observation, vérifications'],
              ['Appels', String(report.totals.calls), `${report.totals.failedCalls} en échec · ${(report.totals.inputTokens + report.totals.outputTokens).toLocaleString('fr-FR')} tokens`],
              ['Coût moyen par appel', report.averageCostPerCall === null ? '—' : usd(report.averageCostPerCall), report.averageCostPerCall === null ? 'Aucun appel tarifé' : null],
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
              hint="Pas de budget par compte en V1 : un compte coûteux est signalé par la détection d'anomalies."
              hrefFor={(r) => (/^\d+$/.test(r.key) ? execHref({ accountId: r.key }) : null)} />
          </div>

          <Link href={execHref({})} className="inline-flex items-center gap-1.5 text-sm text-[color:var(--accent)] hover:underline">
            Voir les appels de la période <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </>
      )}

      {settings && (
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">Budgets mensuels et anomalies</h2>
            <p className="text-xs text-[color:var(--text-muted)]">
              Paramètres de cet environnement, hors configuration versionnée. Mois calendaire, dépense métier,
              en $ (devise de la grille tarifaire). Un dépassement crée une alerte, jamais une suspension.
            </p>
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
