"use client";

/**
 * Admin — Exécutions & logs — CDC BO IA SCR-07.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS CRITÈRES D'ACCEPTATION, TROIS PARTIS PRIS
 *
 * « Un administrateur peut expliquer quelle version/config/code a produit un
 * résultat. » Version IA et commit sont donc sur la ligne, pas dans un détail
 * qu'il faut déplier. C'est la première question qu'on se pose devant un
 * résultat inattendu, et la faire coûter un clic la fait souvent sauter.
 *
 * « Le fallback réellement utilisé est visible. » Le rang est affiché en clair
 * — principal, repli 1, repli 2 — et non un simple témoin de bascule. Un
 * traitement qui atteint toujours le second repli est un incident, pas un
 * repli ordinaire.
 *
 * « Une requête T2 déterministe apparaît avec 0 appel et 0 coût IA. » Cet écran
 * liste les appels modèles : une demande tranchée par les règles n'y figure
 * pas, et son absence est l'information. L'écran le dit plutôt que de laisser
 * croire à un trou dans les traces.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT IA 2 — LIENS PRÉFILTRÉS, DÉTAIL, ROUTAGE T2
 *
 * · Les filtres sont lus depuis l'URL et y sont réécrits (COST-009,
 *   CST-UI-10, ALT-01) : les liens du tableau de bord, des alertes et des
 *   coûts ouvrent enfin un écran filtré. Filtres serveur complets : période,
 *   modèle, rang, version, opération, durée, utilisateur, job (LOG-UI-02).
 * · Un clic sur un appel ouvre le détail de l'exécution (LOG-UI-04) : appels
 *   de la même trace, étapes, job parent, version figée.
 * · Onglet « Requêtes T2 » (LOG-UI-06/07, T2-046) : mode, cascade, appels et
 *   coût — une requête déterministe y figure avec 0 appel et 0 coût (SCR-07).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA RÉPARTITION DES ERREURS VIENT AVANT LA LISTE
 *
 * Une liste paginée d'appels ne dit pas par où commencer. Le regroupement par
 * traitement, code d'erreur et modèle répond d'abord à « qu'est-ce qui échoue
 * le plus », et distingue les trois causes qui n'appellent pas le même geste.
 */

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, RefreshCw, AlertTriangle, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { toast } from 'sonner';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { apiClient } from '@/lib/api-client';
import {
  readExecutionFilters, executionFiltersToParams, type ExecutionScreenFilters,
} from '@/services/ai/telemetry/execution-filters';
import { AiEnvBanner } from '../ai-dashboard/_components/AiEnvBanner';

interface Execution {
  id: number;
  createdAt: string;
  treatment: string | null;
  operationCode: string | null;
  accountId: number | null;
  userId: number | null;
  model: string | null;
  modelRank: string | null;
  usedFallback: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  durationMs: number | null;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  configVersionId: number | null;
  configVisibleNumber: number | null;
  appVersion: string | null;
  jobId: number | null;
  promptVersion: string | null;
}

interface Page { rows: Execution[]; total: number; limit: number; offset: number }

interface ErrorRow {
  treatment: string | null; errorCode: string | null;
  model: string | null; count: number; lastSeen: string;
}

interface Detail {
  call: Execution;
  traceId: string | null;
  calls: Execution[];
  steps: Array<{ stepName: string; status: string; model: string | null; durationMs: number | null; errorMessage: string | null }>;
  job: {
    id: number; treatment: string; status: string; origin: string; triggerCode: string | null;
    attempts: number; configVersionId: number | null; createdAt: string; startedAt: string | null;
    finishedAt: string | null; lastError: string | null; targetType: string | null; targetId: string | null;
  } | null;
}

interface T2Row {
  id: number; requestId: string; createdAt: string; accountId: number; userId: number | null;
  intent: string | null; mode: string | null; status: string | null; latencyMs: number | null;
  sourceCount: number | null; aiCalls: number; costMicros: number; fallbackUsed: boolean;
  routeReasons: string[]; models: string[]; cascade: unknown;
}

const RANK_LABEL: Record<string, string> = {
  primary: 'principal', fallback_1: 'repli 1', fallback_2: 'repli 2', fallback: 'tout repli',
};

const SELECT = 'rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-input)] px-3 py-2 text-sm text-[color:var(--text-primary)]';

function cost(micros: number | null): string {
  if (micros === null) return 'non calculable';
  if (micros === 0) return '0';
  return `${(micros / 1_000_000).toFixed(4)} $`;
}

function duration(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

export default function AiExecutionsPage() {
  // `useSearchParams` exige une frontière Suspense (Next.js 15).
  return (
    <Suspense fallback={<div className="py-16 text-center text-[color:var(--text-muted)]">Chargement…</div>}>
      <AiExecutionsScreen />
    </Suspense>
  );
}

function AiExecutionsScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<ExecutionScreenFilters>(() => readExecutionFilters(searchParams));
  const [tab, setTab] = useState<'calls' | 't2'>(searchParams.get('tab') === 't2' ? 't2' : 'calls');
  const [page, setPage] = useState<Page | null>(null);
  const [t2, setT2] = useState<{ rows: T2Row[]; total: number } | null>(null);
  const [t2Route, setT2Route] = useState(searchParams.get('route') ?? '');
  const [errors, setErrors] = useState<ErrorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<Detail | null>(null);

  // L'URL suit les filtres : un écran filtré se partage et survit au rechargement.
  useEffect(() => {
    const q = executionFiltersToParams(filters);
    if (tab === 't2') { q.set('tab', 't2'); if (t2Route) q.set('route', t2Route); }
    router.replace(`?${q}`, { scroll: false });
  }, [filters, tab, t2Route, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setErreur(null);
    try {
      const params = executionFiltersToParams(filters);
      params.set('offset', String(offset));
      params.set('limit', '50');
      if (tab === 't2') {
        const q = new URLSearchParams({ offset: String(offset), limit: '50' });
        for (const k of ['accountId', 'userId', 'from', 'to'] as const) if (filters[k]) q.set(k, filters[k]);
        if (t2Route) q.set('route', t2Route);
        setT2(await apiClient.get<{ rows: T2Row[]; total: number }>(`/api/admin/ai/t2-requests?${q}`));
      } else {
        const [p, e] = await Promise.all([
          apiClient.get<Page>(`/api/admin/ai/executions?${params}`),
          apiClient.get<{ breakdown: ErrorRow[] }>('/api/admin/ai/executions/errors?days=7'),
        ]);
        setPage(p);
        setErrors(e.breakdown);
      }
    } catch (e) {
      const err = e as { message?: string; code?: string; status?: number };
      setErreur([err.message, err.code && `(${err.code}${err.status ? ` — ${err.status}` : ''})`]
        .filter(Boolean).join(' ') || null);
      toast.error('Chargement impossible.');
    } finally {
      setLoading(false);
    }
  }, [filters, offset, tab, t2Route]);

  useEffect(() => { load(); }, [load]);

  const set = <K extends keyof ExecutionScreenFilters>(k: K, v: ExecutionScreenFilters[K]) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setOffset(0);
  };

  const openDetail = async (id: number) => {
    try {
      setDetail(await apiClient.get<Detail>(`/api/admin/ai/executions/${id}`));
    } catch {
      toast.error('Détail indisponible.');
    }
  };

  const total = tab === 't2' ? t2?.total ?? 0 : page?.total ?? 0;

  return (
    <div className="space-y-6 max-w-6xl">
      {/* VER-026 / GST-01 : environnement et état global, sur chaque page IA */}
      <AiEnvBanner />
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[color:var(--text-primary)]">Exécutions &amp; logs</h1>
          <p className="text-sm text-[color:var(--text-muted)]">
            Appels modèles de tous les traitements, et routage des requêtes de l&apos;assistant.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Actualiser
        </Button>
      </div>

      <div className="flex gap-2">
        {([['calls', 'Appels modèles'], ['t2', 'Requêtes T2 (routage)']] as const).map(([k, label]) => (
          <Button key={k} size="sm" variant={tab === k ? 'default' : 'outline'}
            onClick={() => { setTab(k); setOffset(0); }}>{label}</Button>
        ))}
      </div>

      {tab === 'calls' && errors.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
          <h2 className="text-sm font-semibold text-[color:var(--text-primary)] flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            Échecs des sept derniers jours
          </h2>
          <div className="space-y-1">
            {errors.slice(0, 6).map((e, i) => (
              <button key={i} type="button" className="block text-left text-sm text-[color:var(--text-secondary)] hover:underline"
                onClick={() => setFilters({ ...filters, treatment: e.treatment ?? '', model: e.model ?? '', errorsOnly: true })}>
                <span className="font-medium text-[color:var(--text-primary)]">{e.count}×</span>
                {' '}{e.treatment ?? 'traitement inconnu'}
                {e.errorCode && ` · ${e.errorCode}`}
                {e.model && ` · ${e.model}`}
                <span className="text-[color:var(--text-muted)]">
                  {' '}— dernier le {new Date(e.lastSeen).toLocaleDateString('fr-FR')}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filtres — lus depuis l'URL, réécrits à chaque changement */}
      <div className="flex flex-wrap gap-2 items-center">
        {tab === 'calls' && (
          <>
            <select value={filters.treatment} onChange={(e) => set('treatment', e.target.value)} className={SELECT}>
              <option value="">Tous les traitements</option>
              {['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={filters.rank} onChange={(e) => set('rank', e.target.value)} className={SELECT}>
              <option value="">Tous les rangs</option>
              {Object.entries(RANK_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <Input placeholder="Modèle" value={filters.model} onChange={(e) => set('model', e.target.value)}
              className="max-w-[170px] bg-[color:var(--bg-input)]" />
            <Input placeholder="Opération" value={filters.operationCode} onChange={(e) => set('operationCode', e.target.value)}
              className="max-w-[160px] bg-[color:var(--bg-input)]" />
            <Input placeholder="Version (id)" value={filters.configVersionId} inputMode="numeric"
              onChange={(e) => set('configVersionId', e.target.value.replace(/\D/g, ''))} className="max-w-[120px] bg-[color:var(--bg-input)]" />
            <Input placeholder="Job" value={filters.jobId} inputMode="numeric"
              onChange={(e) => set('jobId', e.target.value.replace(/\D/g, ''))} className="max-w-[90px] bg-[color:var(--bg-input)]" />
            <Input placeholder="Durée ≥ ms" value={filters.minDurationMs} inputMode="numeric"
              onChange={(e) => set('minDurationMs', e.target.value.replace(/\D/g, ''))} className="max-w-[120px] bg-[color:var(--bg-input)]" />
            <label className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
              <input type="checkbox" checked={filters.errorsOnly} onChange={(e) => set('errorsOnly', e.target.checked)} />
              Échecs seulement
            </label>
          </>
        )}
        {tab === 't2' && (
          <select value={t2Route} onChange={(e) => { setT2Route(e.target.value); setOffset(0); }} className={SELECT}>
            <option value="">Toutes les requêtes</option>
            <option value="deterministic">Sans IA (0 appel)</option>
            <option value="ai">Escaladées vers le modèle</option>
          </select>
        )}
        <Input placeholder="Compte" value={filters.accountId} inputMode="numeric"
          onChange={(e) => set('accountId', e.target.value.replace(/\D/g, ''))} className="max-w-[110px] bg-[color:var(--bg-input)]" />
        <Input placeholder="Utilisateur" value={filters.userId} inputMode="numeric"
          onChange={(e) => set('userId', e.target.value.replace(/\D/g, ''))} className="max-w-[110px] bg-[color:var(--bg-input)]" />
        <label className="text-sm text-[color:var(--text-secondary)] flex items-center gap-1">
          Du <input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} className={SELECT} />
        </label>
        <label className="text-sm text-[color:var(--text-secondary)] flex items-center gap-1">
          au <input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} className={SELECT} />
        </label>
        <span className="text-sm text-[color:var(--text-muted)] ml-auto">
          {total} {tab === 't2' ? 'requête' : 'appel'}{total > 1 ? 's' : ''}
        </span>
      </div>

      {erreur ? (
        <EcranEnErreur titre="Exécutions indisponibles" message={erreur} onRetry={load} />
      ) : loading ? (
        <div className="flex items-center justify-center py-16 text-[color:var(--text-muted)]">
          <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Chargement…
        </div>
      ) : tab === 't2' ? (
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] divide-y divide-[color:var(--border-subtle)]">
          {t2?.rows.length === 0 && <p className="p-6 text-sm text-[color:var(--text-muted)]">Aucune requête ne correspond.</p>}
          {t2?.rows.map((r) => (
            <div key={r.id} className="px-4 py-3 space-y-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className={`text-xs px-2 py-0.5 rounded-full border ${r.aiCalls === 0
                  ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                  : 'bg-sky-500/10 text-sky-400 border-sky-500/20'}`}>
                  {r.aiCalls === 0 ? 'Sans IA' : `${r.aiCalls} appel${r.aiCalls > 1 ? 's' : ''} IA`}
                </span>
                <span className="text-sm font-medium text-[color:var(--text-primary)]">{r.intent ?? '—'}</span>
                <span className="text-sm text-[color:var(--text-secondary)]">mode {r.mode ?? '—'}</span>
                {r.fallbackUsed && <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500">repli</span>}
                <span className="flex-1" />
                <span className="text-xs text-[color:var(--text-muted)]">{new Date(r.createdAt).toLocaleString('fr-FR')}</span>
              </div>
              <p className="text-xs text-[color:var(--text-muted)]">
                {r.status ?? '—'} · {duration(r.latencyMs)} · coût {cost(r.costMicros)} · {r.sourceCount ?? 0} source(s)
                {` · compte ${r.accountId}`}
                {r.routeReasons.length > 0 && ` · escalade : ${r.routeReasons.join(', ')}`}
                {r.models.length > 0 && ` · ${r.models.join(', ')}`}
              </p>
              {r.cascade != null && (
                <details className="text-xs text-[color:var(--text-muted)]">
                  <summary className="cursor-pointer">Cascade (niveaux atteints)</summary>
                  <pre className="whitespace-pre-wrap break-all mt-1">{JSON.stringify(r.cascade, null, 2)}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] divide-y divide-[color:var(--border-subtle)]">
          {page?.rows.length === 0 && (
            <p className="p-6 text-sm text-[color:var(--text-muted)]">
              Aucun appel modèle ne correspond à ces filtres. Une demande de l&apos;assistant tranchée
              sans IA figure dans l&apos;onglet « Requêtes T2 », avec zéro appel.
            </p>
          )}

          {page?.rows.map((r) => (
            <button key={r.id} type="button" onClick={() => openDetail(r.id)}
              className="w-full text-left px-4 py-3 space-y-1 hover:bg-[color:var(--bg-hover)]">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className={`text-xs px-2 py-0.5 rounded-full border ${
                  r.status === 'error'
                    ? 'bg-red-500/10 text-red-400 border-red-500/20'
                    : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'}`}>
                  {r.status === 'error' ? 'Échec' : 'Succès'}
                </span>
                <span className="text-sm font-medium text-[color:var(--text-primary)]">{r.treatment ?? '—'}</span>
                <span className="text-sm text-[color:var(--text-secondary)]">{r.operationCode}</span>
                <span className="text-sm text-[color:var(--text-muted)]">{r.model}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${r.modelRank && r.modelRank !== 'primary'
                  ? 'bg-amber-500/10 text-amber-500' : 'bg-[color:var(--bg-input)] text-[color:var(--text-muted)]'}`}>
                  {r.modelRank ? RANK_LABEL[r.modelRank] ?? r.modelRank : 'rang inconnu'}
                </span>
                <span className="flex-1" />
                <span className="text-xs text-[color:var(--text-muted)]">{new Date(r.createdAt).toLocaleString('fr-FR')}</span>
              </div>
              <p className="text-xs text-[color:var(--text-muted)]">
                {duration(r.durationMs)} · {cost(r.costMicros)}
                {r.inputTokens !== null && ` · ${r.inputTokens} + ${r.outputTokens} tokens`}
                {r.accountId && ` · compte ${r.accountId}`}
                {r.jobId && ` · job ${r.jobId}`}
                {r.configVisibleNumber !== null && ` · config v${r.configVisibleNumber}`}
                {r.promptVersion && ` · prompt ${r.promptVersion}`}
                {r.appVersion && ` · code ${r.appVersion.slice(0, 8)}`}
              </p>
              {r.errorMessage && (
                <p className="text-xs text-red-400">{r.errorCode ? `${r.errorCode} — ` : ''}{r.errorMessage}</p>
              )}
            </button>
          ))}
        </div>
      )}

      {total > 50 && (
        <div className="flex items-center justify-between">
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
            <ChevronLeft className="w-3.5 h-3.5 mr-1.5" /> Précédents
          </Button>
          <span className="text-sm text-[color:var(--text-muted)]">
            {offset + 1} – {Math.min(offset + 50, total)} sur {total}
          </span>
          <Button size="sm" variant="outline" disabled={offset + 50 >= total} onClick={() => setOffset(offset + 50)}>
            Suivants <ChevronRight className="w-3.5 h-3.5 ml-1.5" />
          </Button>
        </div>
      )}

      {detail && <ExecutionDetailPanel detail={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

/** LOG-UI-04 : détail d'une exécution — trace, étapes, job parent, version. */
function ExecutionDetailPanel({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const { job } = detail;
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="w-full max-w-xl h-full overflow-y-auto bg-[color:var(--bg-card)] p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">Exécution — appel {detail.call.id}</h2>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Fermer"><X className="w-4 h-4" /></Button>
        </div>
        <p className="text-xs text-[color:var(--text-muted)] break-all">
          Trace {detail.traceId ?? '—'} · {detail.call.treatment ?? '—'} · {detail.call.operationCode}
          {detail.call.configVisibleNumber !== null ? ` · config v${detail.call.configVisibleNumber}` : detail.call.configVersionId ? ` · config #${detail.call.configVersionId}` : ' · configuration du code'}
          {detail.call.promptVersion && ` · prompt ${detail.call.promptVersion}`}
          {detail.call.appVersion && ` · code ${detail.call.appVersion.slice(0, 8)}`}
        </p>

        <section className="space-y-1">
          <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Appels de la chaîne de modèles</h3>
          {detail.calls.map((c) => (
            <p key={c.id} className="text-xs text-[color:var(--text-secondary)]">
              {RANK_LABEL[c.modelRank ?? ''] ?? 'rang inconnu'} · {c.model} · {c.status === 'error' ? `échec ${c.errorCode ?? ''}` : 'succès'}
              {' · '}{duration(c.durationMs)} · {cost(c.costMicros)}
              {c.inputTokens !== null && ` · ${c.inputTokens} + ${c.outputTokens} tokens`}
            </p>
          ))}
        </section>

        {detail.steps.length > 0 && (
          <section className="space-y-1">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Étapes</h3>
            {detail.steps.map((s, i) => (
              <p key={i} className="text-xs text-[color:var(--text-secondary)]">
                {s.stepName} · {s.status} · {s.model ?? '—'} · {duration(s.durationMs)}
                {s.errorMessage && <span className="text-red-400"> — {s.errorMessage}</span>}
              </p>
            ))}
          </section>
        )}

        <section className="space-y-1">
          <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Exécution de file</h3>
          {job ? (
            <p className="text-xs text-[color:var(--text-secondary)]">
              Job {job.id} · {job.treatment} · {job.status} · origine {job.origin}
              {job.triggerCode && ` · déclencheur ${job.triggerCode}`} · {job.attempts} tentative(s)
              {job.configVersionId && ` · version figée #${job.configVersionId}`}
              {job.targetType && ` · cible ${job.targetType} ${job.targetId}`}
              {job.lastError && <span className="text-red-400"> — {job.lastError}</span>}
            </p>
          ) : (
            <p className="text-xs text-[color:var(--text-muted)]">Appel synchrone (hors file).</p>
          )}
        </section>
      </div>
    </div>
  );
}
