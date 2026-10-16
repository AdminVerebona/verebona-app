'use client';

/**
 * Pertinence des « À traiter » documentaires — lot 61 (tickets « BUG P1 —
 * écarts résiduels du lot 58B » et « [P1] Fiabiliser la pertinence des
 * cartes »).
 *
 * Une carte, une colonne sur mobile, grilles à partir de `sm`, composants et
 * jetons existants seulement. Sans SQL ni commande, le PO :
 *   · voit la configuration T4 effective (contrat `t4_output_v3` actif ou
 *     non : l'évaluation structurée de l'intervention l'exige) ;
 *   · suit la réévaluation RÉTROACTIVE des cartes existantes : bilan AVANT /
 *     APRÈS par règle, issues (conservées, résolues, différées, retirées,
 *     remplacées par l'action réelle, en erreur), détail par carte filtrable
 *     (compte, issue) ; relance une campagne ;
 *   · lance la RECETTE du corpus livré avec le véritable T4 et lit, cas par
 *     cas, le résultat attendu et obtenu (trace IA).
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ListChecks, AlertTriangle, RefreshCw, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api-client';

interface Campaign {
  id: number; code: string; status: string; trigger: string; engineVersion: string; startedAt: string; finishedAt: string | null;
  lastRunAt: string | null; runs: number; before: Record<string, number>; after: Record<string, number> | null;
  outcomes: Record<string, number>; errorSample: string | null;
}
interface Item { actionId: number; accountId: number; fileId: number; ruleCode: string; kindBefore: string | null; outcome: string; reason: string | null; createdAt: string }
interface RecetteResult {
  caseId: string; label: string; ok: boolean; expected: { outcomes: string[]; card?: string | null; kinds?: string[]; never?: string[] };
  obtained: { outcome: string | null; card: string | null; kind: string | null; pertinence: string | null; derivation?: string | null; action?: string | null };
  aiCalled: boolean; aiStatus: string | null; traceId: string | null; reason: string; problems: string[];
}
interface RecetteRun {
  id: number; status: string; configRef: string | null; total: number; passed: number; failed: number; aiCalls: number;
  results: RecetteResult[]; error: string | null; startedAt: string; finishedAt: string | null;
}
interface Data {
  config: {
    ref: string; interventionCapable: boolean;
    /** Lot 63 : seuils « À traiter » effectifs (BO › Configuration IA › Réglages). */
    thresholds?: { futureHorizonDays: number; historicalYears: number; deferUncertainDays: number; deferUndatedDays: number; deferTitleOnlyDays: number };
  };
  engineVersion: string;
  migrations: { decisions0444: boolean; campaigns0445: boolean; recette0446: boolean };
  campaigns: Campaign[]; items: Item[];
  recetteCases: Array<{ id: string; label: string; deterministic: boolean }>;
  recetteRuns: RecetteRun[];
}

const ISSUE_LABEL: Record<string, string> = {
  KEPT: 'conservées', AUTO_RESOLVED: 'résolues automatiquement', DEFERRED: 'différées', REMOVED: 'retirées (sans pertinence)',
  REPLACED_BY_INTERVENTION: 'remplacées par l’action réelle', RESOLVED_ELSEWHERE: 'résolues ailleurs', ERROR: 'en erreur', examined: 'examinées',
};
const dt = (v: string | null) => (v ? new Date(v).toLocaleString('fr-FR') : '—');
const kv = (o: Record<string, number> | null | undefined, labels: Record<string, string> = {}) =>
  (o && Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${labels[k] ?? k} ${v}`).join(' · ') : '—');
const total = (o: Record<string, number> | null | undefined) => (o ? Object.values(o).reduce((a, b) => a + b, 0) : 0);

function CampaignBlock({ c }: { c: Campaign }) {
  return (
    <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-1 min-w-0">
      <p className="text-xs text-[color:var(--text-secondary)] break-words">
        Campagne {c.code} · {c.status === 'DONE' ? 'terminée' : c.status === 'RUNNING' ? 'en cours' : 'en erreur'} · {c.trigger}
        {' · '}{dt(c.startedAt)} → {dt(c.finishedAt ?? c.lastRunAt)} · {c.runs} passage(s) · moteur {c.engineVersion}
      </p>
      <p className="text-xs break-words">
        <span className="text-[color:var(--text-secondary)]">Cartes actives AVANT : </span>
        <span className="text-[color:var(--text-muted)]">{total(c.before)} ({kv(c.before)})</span>
      </p>
      <p className="text-xs break-words">
        <span className="text-[color:var(--text-secondary)]">Cartes actives APRÈS : </span>
        <span className="text-[color:var(--text-muted)]">{c.after ? `${total(c.after)} (${kv(c.after)})` : 'campagne en cours'}</span>
      </p>
      <p className="text-xs break-words">
        <span className="text-[color:var(--text-secondary)]">Issues : </span>
        <span className="text-[color:var(--text-muted)]">{kv(c.outcomes, ISSUE_LABEL)}</span>
      </p>
      {c.errorSample && <p className="text-xs text-red-400 break-words">Exemple d’erreur : {c.errorSample}</p>}
    </div>
  );
}

function RecetteRow({ r }: { r: RecetteResult }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-[color:var(--border-subtle)] p-2 min-w-0">
      <button type="button" className="w-full text-left flex items-start gap-2" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronDown className={`w-3.5 h-3.5 mt-0.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="text-xs break-words min-w-0">
          <span className={r.ok ? 'text-emerald-500' : 'text-red-400'}>{r.ok ? 'Conforme' : 'NON CONFORME'}</span>
          {' · '}<span className="font-medium text-[color:var(--text-primary)]">{r.caseId}</span> · {r.label}
        </span>
      </button>
      {open && (
        <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs sm:grid-cols-2 break-words">
          {([
            ['Attendu', `${r.expected.outcomes.join(' | ') || '—'}${r.expected.card ? ` · carte ${r.expected.card}` : ''}${r.expected.kinds ? ` · ${r.expected.kinds.join(' | ')}` : ''}${r.expected.never?.length ? ` · jamais ${r.expected.never.join(', ')}` : ''}`],
            ['Obtenu', `${r.obtained.outcome ?? '—'}${r.obtained.card ? ` · carte ${r.obtained.card}` : ''}${r.obtained.kind ? ` · ${r.obtained.kind}` : ''}${r.obtained.derivation ? ` · calcul ${r.obtained.derivation}` : ''}`],
            ['Action formulée', r.obtained.action ?? '—'],
            ['Pertinence', r.obtained.pertinence ?? '—'],
            ['IA', r.aiCalled ? `t4_classify_event · ${r.aiStatus ?? '?'}${r.traceId ? ` · trace ${r.traceId}` : ''}` : 'aucun appel (décision du code)'],
            ['Motif', r.reason],
            ['Écarts', r.problems.length ? r.problems.join(' ; ') : '—'],
          ] as Array<[string, string]>).map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-[color:var(--text-secondary)]">{k}</dt>
              <dd className="text-[color:var(--text-muted)]">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

export function ToProcessRelevancePanel() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState({ accountId: '', outcome: '' });

  const charger = useCallback(async (f = filters) => {
    setError(null);
    try {
      const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v.trim() !== ''));
      setData(await apiClient.get<Data>(`/api/admin/ai/queue/to-process-relevance?${q.toString()}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filters]);
  useEffect(() => { void charger(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const lancer = async (action: 'campaign' | 'recette') => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.post(`/api/admin/ai/queue/to-process-relevance`, { action });
      await charger();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const recette = data?.recetteRuns[0] ?? null;
  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ListChecks className="w-4 h-4 text-[color:var(--text-muted)] shrink-0" />
        <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">Pertinence des « À traiter » documentaires</h2>
        <Button type="button" size="sm" variant="outline" className="ml-auto h-8" onClick={() => void charger()} disabled={busy}>
          <RefreshCw className="w-3.5 h-3.5 mr-1" />Actualiser
        </Button>
      </div>
      {error && <p className="text-xs text-red-400 break-words flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{error}</p>}
      {data && (
        <>
          <p className="text-xs break-words">
            <span className="text-[color:var(--text-secondary)]">Configuration T4 : </span>
            <span className="text-[color:var(--text-muted)]">{data.config.ref} · moteur {data.engineVersion} · </span>
            <span className={data.config.interventionCapable ? 'text-emerald-500' : 'text-amber-500'}>
              {data.config.interventionCapable
                ? 'évaluation structurée de l’intervention active (t4_output_v3)'
                : 'version active SANS t4_output_v3 : décision prudente (actions non identifiées différées). Activer la version de référence dans Prompts maîtres › T4.'}
            </span>
          </p>
          {data.config.thresholds && (
            <p className="text-xs break-words" data-testid="to-process-thresholds">
              <span className="text-[color:var(--text-secondary)]">Seuils (Configuration IA › Réglages) : </span>
              <span className="text-[color:var(--text-muted)]">
                horizon {data.config.thresholds.futureHorizonDays} j · historique {data.config.thresholds.historicalYears} ans · réévaluation
                {' '}incertaine {data.config.thresholds.deferUncertainDays} j / sans date {data.config.thresholds.deferUndatedDays} j / titre seul {data.config.thresholds.deferTitleOnlyDays} j
              </span>
            </p>
          )}
          {(!data.migrations.decisions0444 || !data.migrations.campaigns0445 || !data.migrations.recette0446) && (
            <p className="text-xs text-amber-500 break-words">
              Migrations : décisions {data.migrations.decisions0444 ? 'présentes' : 'ABSENTES (0444)'} · campagnes {data.migrations.campaigns0445 ? 'présentes' : 'ABSENTES (0445)'} · recette {data.migrations.recette0446 ? 'présente' : 'ABSENTE (0446)'}.
            </p>
          )}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-[color:var(--text-secondary)]">Réévaluation rétroactive des cartes existantes</p>
              <Button type="button" size="sm" className="h-8" disabled={busy} onClick={() => void lancer('campaign')}>
                <Play className="w-3.5 h-3.5 mr-1" />Relancer une campagne
              </Button>
            </div>
            {data.campaigns.length === 0 && <p className="text-xs text-[color:var(--text-muted)]">Aucune campagne (la tâche planifiée « to-process-relevance-reevaluation » la lance au démarrage).</p>}
            {data.campaigns.slice(0, 3).map((c) => <CampaignBlock key={c.id} c={c} />)}
            <form className="grid gap-2 grid-cols-2 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void charger(filters); }}>
              <Input value={filters.accountId} placeholder="Compte" aria-label="Compte" className="h-8 text-xs"
                onChange={(e) => setFilters((f) => ({ ...f, accountId: e.target.value }))} />
              <Input value={filters.outcome} placeholder="Issue (ex. DEFERRED)" aria-label="Issue" className="h-8 text-xs"
                onChange={(e) => setFilters((f) => ({ ...f, outcome: e.target.value.toUpperCase() }))} />
              <Button type="submit" size="sm" disabled={busy}>Filtrer</Button>
            </form>
            {data.items.length > 0 && (
              <ul className="space-y-1">
                {data.items.map((i) => (
                  <li key={i.actionId} className="text-xs break-words rounded border border-[color:var(--border-subtle)] px-2 py-1">
                    <span className="text-[color:var(--text-primary)]">Action #{i.actionId}</span> · compte {i.accountId} · document {i.fileId} · {i.ruleCode}
                    {' · '}<span className={i.outcome === 'ERROR' ? 'text-red-400' : 'text-[color:var(--text-secondary)]'}>{ISSUE_LABEL[i.outcome] ?? i.outcome}</span>
                    {i.reason ? <span className="text-[color:var(--text-muted)]"> — {i.reason}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-[color:var(--text-secondary)]">Recette avec le véritable T4 ({data.recetteCases.length} cas)</p>
              <Button type="button" size="sm" className="h-8" disabled={busy || recette?.status === 'RUNNING'} onClick={() => void lancer('recette')}>
                <Play className="w-3.5 h-3.5 mr-1" />{recette?.status === 'RUNNING' ? 'Recette en cours…' : 'Lancer la recette T4 réelle'}
              </Button>
            </div>
            {!recette && <p className="text-xs text-[color:var(--text-muted)]">Aucune recette lancée. Les appels IA sont imputés au compte sélectionné.</p>}
            {recette && (
              <>
                <p className="text-xs break-words">
                  <span className={recette.failed === 0 && recette.status === 'DONE' ? 'text-emerald-500' : recette.status === 'RUNNING' ? 'text-amber-500' : 'text-red-400'}>
                    {recette.status === 'RUNNING' ? 'En cours' : recette.status === 'DONE' ? 'Terminée' : 'En erreur'}
                  </span>
                  <span className="text-[color:var(--text-muted)]">
                    {' · '}{recette.passed}/{recette.total} conformes · {recette.failed} non conformes · {recette.aiCalls} appel(s) IA · {recette.configRef ?? '—'} · {dt(recette.startedAt)}
                  </span>
                </p>
                {recette.error && <p className="text-xs text-amber-500 break-words">{recette.error}</p>}
                <ul className="space-y-1.5">{recette.results.map((r) => <RecetteRow key={r.caseId} r={r} />)}</ul>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
