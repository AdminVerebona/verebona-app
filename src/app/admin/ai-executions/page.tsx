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
  readExecutionFilters, executionFiltersToParams, T6_MODES, T6_MODE_LABELS, type ExecutionScreenFilters,
} from '@/services/ai/telemetry/execution-filters';
import { AiEnvBanner } from '../ai-dashboard/_components/AiEnvBanner';
import { UnansweredHelpQuestions } from './_components/UnansweredHelpQuestions';
import { CopyBlockButton, ExecutionExportButtons } from './_components/CopyJson';

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
  objectType: string | null;
  objectId: string | null;
  trigger: string | null;
  origin: string | null;
  /** BO-009 : mode déclaré par la mascotte (`displayed` / `pregeneration`). */
  callerMode?: string | null;
  /** CDC 15 DP-05, CFG-02, CFG-05, OBS-CFG : configuration réellement appliquée. */
  task?: string | null;
  masterPromptCode?: string | null;
  masterPromptVersion?: string | null;
  reasoning?: string | null;
  maxOutputTokens?: number | null;
  engine?: string | null;
  callTrigger?: string | null;
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
  steps: Array<{
    stepName: string; stepOrder?: number; status: string; model: string | null; durationMs: number | null;
    errorCode?: string | null; errorMessage: string | null;
    /** Sortie journalisée : extrait masqué, ou empreinte pour l'assistant (§29.6). */
    outputPreview?: string | null;
  }>;
  job: {
    id: number; treatment: string; status: string; origin: string; triggerCode: string | null;
    attempts: number; configVersionId: number | null; createdAt: string; startedAt: string | null;
    finishedAt: string | null; lastError: string | null; targetType: string | null; targetId: string | null;
  } | null;
  inputs: Array<{ label: string; value: unknown }>;
  modifications: Array<{ kind: string; label: string; detail: string | null; at: string | null }>;
  t2: { requestId: string; sources: T2Source[] } | null;
}

interface T2Source {
  messageId: number; sourceType: string; sourceId: string; title: string | null;
  rank: number | null; relevanceScore: number | null; isAvailable: boolean;
}

interface ArchiveItem {
  id: number; sourceTable: string; periodDay: string; part: number; s3Key: string;
  rowCount: number; bytes: number; sha256: string; t2ContentExcluded: boolean; createdAt: string;
}
interface Archives {
  items: ArchiveItem[];
  totals: { archives: number; rows: number; bytes: number; oldestDay: string | null; newestDay: string | null };
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
  const [tab, setTab] = useState<'calls' | 't2' | 'archives'>(
    searchParams.get('tab') === 't2' ? 't2' : searchParams.get('tab') === 'archives' ? 'archives' : 'calls');
  const [archives, setArchives] = useState<Archives | null>(null);
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
    if (tab === 'archives') q.set('tab', 'archives');
    router.replace(`?${q}`, { scroll: false });
  }, [filters, tab, t2Route, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setErreur(null);
    try {
      const params = executionFiltersToParams(filters);
      params.set('offset', String(offset));
      params.set('limit', '50');
      if (tab === 'archives') {
        setArchives(await apiClient.get<Archives>('/api/admin/ai/log-archives?limit=100'));
      } else if (tab === 't2') {
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

  const total = tab === 't2' ? t2?.total ?? 0 : tab === 'archives' ? archives?.totals.archives ?? 0 : page?.total ?? 0;

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
        {([['calls', 'Appels modèles'], ['t2', 'Requêtes T2 (routage)'], ['archives', 'Archives (> 90 j)']] as const).map(([k, label]) => (
          <Button key={k} size="sm" variant={tab === k ? 'default' : 'outline'}
            onClick={() => { setTab(k); setOffset(0); }}>{label}</Button>
        ))}
      </div>

      {/* §10.4 : trous de la base d'aide, remontés depuis l'assistant. */}
      {tab === 't2' && <UnansweredHelpQuestions />}

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
            {/* CDC Mascotte BO-009 : génération affichée / pré-génération / texte de secours. */}
            <select value={filters.t6Mode} onChange={(e) => set('t6Mode', e.target.value)} className={SELECT}
              aria-label="Mode de génération T6">
              <option value="">Tous les modes T6</option>
              {T6_MODES.map((m) => <option key={m} value={m}>{T6_MODE_LABELS[m]}</option>)}
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
            <select value={filters.status} onChange={(e) => set('status', e.target.value)} className={SELECT}>
              <option value="">Tous les statuts</option>
              <option value="success">Succès</option>
              <option value="error">Échec</option>
            </select>
            <Input placeholder="Type d'objet" value={filters.objectType} onChange={(e) => set('objectType', e.target.value.trim())}
              className="max-w-[130px] bg-[color:var(--bg-input)]" />
            <Input placeholder="Objet (id)" value={filters.objectId} onChange={(e) => set('objectId', e.target.value.trim())}
              className="max-w-[110px] bg-[color:var(--bg-input)]" />
            <Input placeholder="Déclencheur / origine" value={filters.trigger} onChange={(e) => set('trigger', e.target.value.trim())}
              className="max-w-[170px] bg-[color:var(--bg-input)]" />
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
        {tab !== 'archives' && <>
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
        </>}
        <span className="text-sm text-[color:var(--text-muted)] ml-auto">
          {total} {tab === 't2' ? 'requête' : tab === 'archives' ? 'archive' : 'appel'}{total > 1 ? 's' : ''}
        </span>
      </div>

      {erreur ? (
        <EcranEnErreur titre="Exécutions indisponibles" message={erreur} onRetry={load} />
      ) : loading ? (
        <div className="flex items-center justify-center py-16 text-[color:var(--text-muted)]">
          <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Chargement…
        </div>
      ) : tab === 'archives' ? (
        <ArchivesPanel archives={archives} />
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
                  <div className="mt-1 flex items-start gap-1">
                    <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all">{JSON.stringify(r.cascade, null, 2)}</pre>
                    <CopyBlockButton value={r.cascade} label="la cascade" />
                  </div>
                </details>
              )}
              <T2RequestExtras requestId={r.requestId} />
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
                {r.callerMode && (
                  <span className="text-xs text-[color:var(--text-muted)]">
                    {r.callerMode === 'pregeneration' ? 'pré-génération' : 'affichée'}
                  </span>
                )}
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
                {r.objectType && ` · objet ${r.objectType} ${r.objectId ?? ''}`}
                {(r.trigger || r.origin) && ` · déclencheur ${r.trigger ?? r.origin}`}
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
          <div className="flex items-center gap-1.5">
            {/* Lot 32 : l'exécution complète, copiable ou téléchargeable pour l'analyser ailleurs. */}
            <ExecutionExportButtons callId={detail.call.id} />
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Fermer"><X className="w-4 h-4" /></Button>
          </div>
        </div>
        <p className="text-xs text-[color:var(--text-muted)] break-all">
          Trace {detail.traceId ?? '—'} · {detail.call.treatment ?? '—'} · {detail.call.operationCode}
          {detail.call.configVisibleNumber !== null ? ` · config v${detail.call.configVisibleNumber}` : detail.call.configVersionId ? ` · config #${detail.call.configVersionId}` : ' · configuration du code'}
          {detail.call.promptVersion && ` · prompt ${detail.call.promptVersion}`}
          {detail.call.appVersion && ` · code ${detail.call.appVersion.slice(0, 8)}`}
        </p>

        {/* CDC 15 CFG-02, CFG-05, DP-05, OBS-CFG : ce qui a réellement été appliqué. */}
        <section className="space-y-1" data-testid="execution-applied-config">
          <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Configuration appliquée</h3>
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-[color:var(--text-muted)]">Moteur</dt>
            <dd className="text-[color:var(--text-secondary)]">
              {detail.call.engine === 'legacy' ? 'legacy (relais historique)' : detail.call.engine === 'new' ? 'nouveau moteur' : 'non tracé'}
            </dd>
            <dt className="text-[color:var(--text-muted)]">Déclencheur</dt>
            <dd className="text-[color:var(--text-secondary)]">{detail.call.callTrigger ?? job?.triggerCode ?? '—'}</dd>
            <dt className="text-[color:var(--text-muted)]">TASK</dt>
            <dd className="text-[color:var(--text-secondary)]">{detail.call.task ?? '—'}</dd>
            <dt className="text-[color:var(--text-muted)]">Prompt maître</dt>
            <dd className="text-[color:var(--text-secondary)]">
              {detail.call.masterPromptCode
                ? `${detail.call.masterPromptCode}${detail.call.masterPromptVersion ? ` v${detail.call.masterPromptVersion}` : ''}`
                : '—'}
            </dd>
            <dt className="text-[color:var(--text-muted)]">Raisonnement</dt>
            <dd className="text-[color:var(--text-secondary)]">{detail.call.reasoning ?? (detail.call.engine ? 'défaut du modèle' : 'non tracé')}</dd>
            <dt className="text-[color:var(--text-muted)]">Jetons de sortie max</dt>
            <dd className="text-[color:var(--text-secondary)]">{detail.call.maxOutputTokens ?? (detail.call.engine ? 'défaut du modèle' : 'non tracé')}</dd>
          </dl>
        </section>

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
              <div key={i} className="text-xs text-[color:var(--text-secondary)]">
                <p>
                  {s.stepName} · {s.status} · {s.model ?? '—'} · {duration(s.durationMs)}
                  {s.errorMessage && <span className="text-red-400"> — {s.errorCode ? `${s.errorCode} — ` : ''}{s.errorMessage}</span>}
                </p>
                {s.outputPreview && (
                  <div className="mt-0.5">
                    <div className="flex items-center gap-1 text-[color:var(--text-muted)]">
                      Sortie du modèle ({/^sha256:/.test(s.outputPreview) ? 'empreinte, contenu non conservé' : 'extrait masqué'}) :
                      <CopyBlockButton value={s.outputPreview} label={`la sortie de l’étape ${s.stepName}`} />
                    </div>
                    <pre className="whitespace-pre-wrap break-all">{s.outputPreview}</pre>
                  </div>
                )}
              </div>
            ))}
          </section>
        )}

        <section className="space-y-1">
          <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Instantanés d&apos;entrée</h3>
          {detail.inputs.filter((i) => i.value != null && i.value !== '').map((i) => (
            <div key={i.label} className="text-xs text-[color:var(--text-secondary)]">
              <span className="text-[color:var(--text-muted)]">{i.label} : </span>
              {typeof i.value === 'object' ? (
                <>
                  <CopyBlockButton value={i.value} label={i.label} />
                  <pre className="whitespace-pre-wrap break-all">{JSON.stringify(i.value, null, 2)}</pre>
                </>
              ) : String(i.value)}
            </div>
          ))}
        </section>

        <section className="space-y-1">
          <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Modifications produites</h3>
          {detail.modifications.length === 0 ? (
            <p className="text-xs text-[color:var(--text-muted)]">Aucune modification rattachée à cette exécution.</p>
          ) : detail.modifications.map((m, i) => (
            <p key={i} className="text-xs text-[color:var(--text-secondary)]">
              <span className="font-medium">{m.kind}</span> · {m.label}{m.detail && ` — ${m.detail}`}
              {m.at && <span className="text-[color:var(--text-muted)]"> · {new Date(m.at).toLocaleString('fr-FR')}</span>}
            </p>
          ))}
        </section>

        {detail.t2 && (
          <section className="space-y-1">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Sources T2 utilisées (requête {detail.t2.requestId})</h3>
            <SourcesList sources={detail.t2.sources} />
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

/** LOG-UI-07 : sources réellement utilisées, sans extrait de contenu. */
function SourcesList({ sources }: { sources: T2Source[] }) {
  if (sources.length === 0) return <p className="text-xs text-[color:var(--text-muted)]">Aucune source enregistrée (ou conversation purgée).</p>;
  return (
    <ul className="text-xs text-[color:var(--text-secondary)] space-y-0.5">
      {sources.map((s, i) => (
        <li key={`${s.messageId}-${s.sourceId}-${i}`}>
          {s.rank !== null && `#${s.rank} `}{s.sourceType} · {s.sourceId}{s.title && ` — ${s.title}`}
          {s.relevanceScore !== null && ` · pertinence ${s.relevanceScore.toFixed(2)}`}
          {!s.isAvailable && <span className="text-amber-500"> · plus disponible</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Requête T2 : sources (LOG-UI-07) et contenu conversationnel à accès
 * RESTREINT (LOG-UI-08) — justification obligatoire, accès tracé, contenu
 * expiré ou purgé introuvable.
 */
function T2RequestExtras({ requestId }: { requestId: string }) {
  const [sources, setSources] = useState<T2Source[] | null>(null);
  const [content, setContent] = useState<Array<{ role: string; content: string | null; createdAt: string }> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const loadSources = async () => {
    try {
      const r = await apiClient.get<{ sources: T2Source[] }>(`/api/admin/ai/t2-requests/${encodeURIComponent(requestId)}`);
      setSources(r.sources);
    } catch { toast.error('Sources indisponibles.'); }
  };
  const loadContent = async () => {
    const reason = window.prompt('Accès restreint au contenu conversationnel. Justification (tracée) :');
    if (!reason) return;
    try {
      const r = await apiClient.post<{ messages: Array<{ role: string; content: string | null; createdAt: string }> }>(
        `/api/admin/ai/t2-requests/${encodeURIComponent(requestId)}/content`, { reason });
      setContent(r.messages);
      setMsg(null);
    } catch (e) {
      setMsg((e as { message?: string }).message ?? 'Accès refusé.');
    }
  };

  return (
    <div className="text-xs space-y-1">
      <div className="flex gap-3">
        <button type="button" className="text-[color:var(--accent)] hover:underline" onClick={loadSources}>Sources utilisées</button>
        <button type="button" className="text-[color:var(--accent)] hover:underline" onClick={loadContent}>Contenu (accès restreint)</button>
      </div>
      {sources && <SourcesList sources={sources} />}
      {msg && <p className="text-amber-500">{msg}</p>}
      {content && (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 space-y-1">
          <p className="text-amber-500">Contenu confidentiel — consultation tracée, disparaît à la purge (3 mois).</p>
          {content.map((m, i) => (
            <p key={i} className="text-[color:var(--text-secondary)] whitespace-pre-wrap">
              <span className="font-medium">{m.role === 'user' ? 'Utilisateur' : 'Assistant'} :</span> {m.content ?? '—'}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** LOG-UI-09 : statut des archives S3 — non interrogeables depuis le BO (V1). */
function ArchivesPanel({ archives }: { archives: Archives | null }) {
  if (!archives) return null;
  const mo = (b: number) => (b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} Mo` : `${Math.ceil(b / 1024)} Ko`);
  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <p className="text-sm text-[color:var(--text-secondary)]">
        Les appels et étapes de plus de 90 jours sont archivés sur S3 puis retirés de la recherche
        (restauration technique hors parcours). Le contenu conversationnel T2 n&apos;est jamais archivé.
      </p>
      <p className="text-xs text-[color:var(--text-muted)]">
        {archives.totals.archives} archive(s) · {archives.totals.rows.toLocaleString('fr-FR')} ligne(s) · {mo(archives.totals.bytes)}
        {archives.totals.oldestDay && ` · du ${archives.totals.oldestDay} au ${archives.totals.newestDay}`}
      </p>
      {archives.items.length === 0 ? (
        <p className="text-sm text-[color:var(--text-muted)]">Aucune archive pour l&apos;instant.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[color:var(--text-muted)]">
                <th className="py-1 pr-3">Jour</th><th className="py-1 pr-3">Table</th><th className="py-1 pr-3">Lignes</th>
                <th className="py-1 pr-3">Taille</th><th className="py-1 pr-3">Objet S3</th><th className="py-1 pr-3">SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {archives.items.map((a) => (
                <tr key={a.id} className="border-t border-[color:var(--border-subtle)] text-[color:var(--text-secondary)]">
                  <td className="py-1 pr-3">{a.periodDay}{a.part > 0 && ` (${a.part + 1})`}</td>
                  <td className="py-1 pr-3">{a.sourceTable}</td>
                  <td className="py-1 pr-3">{a.rowCount}</td>
                  <td className="py-1 pr-3">{mo(a.bytes)}</td>
                  <td className="py-1 pr-3 break-all">{a.s3Key}</td>
                  <td className="py-1 pr-3 font-mono">{a.sha256.slice(0, 12)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
