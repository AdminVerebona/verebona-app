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
 * LA RÉPARTITION DES ERREURS VIENT AVANT LA LISTE
 *
 * Une liste paginée d'appels ne dit pas par où commencer. Le regroupement par
 * traitement, code d'erreur et modèle répond d'abord à « qu'est-ce qui échoue
 * le plus », et distingue les trois causes qui n'appellent pas le même geste.
 */

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, RefreshCw, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { apiClient } from '@/lib/api-client';

interface Execution {
  id: number;
  createdAt: string;
  treatment: string | null;
  operationCode: string | null;
  accountId: number | null;
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
  configVisibleNumber: number | null;
  appVersion: string | null;
  promptVersion: string | null;
}

interface Page { rows: Execution[]; total: number; limit: number; offset: number }

interface ErrorRow {
  treatment: string | null; errorCode: string | null;
  model: string | null; count: number; lastSeen: string;
}

const RANK_LABEL: Record<string, string> = {
  primary: 'principal', fallback_1: 'repli 1', fallback_2: 'repli 2',
};

function cost(micros: number | null): string {
  if (micros === null) return '—';
  if (micros === 0) return '0';
  return `${(micros / 1_000_000).toFixed(4)} $`;
}

function duration(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

export default function AiExecutionsPage() {
  const [page, setPage] = useState<Page | null>(null);
  const [errors, setErrors] = useState<ErrorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [treatment, setTreatment] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [account, setAccount] = useState('');
  const [offset, setOffset] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setErreur(null);
    try {
      const params = new URLSearchParams({ offset: String(offset), limit: '50' });
      if (treatment) params.set('treatment', treatment);
      if (errorsOnly) params.set('errorsOnly', '1');
      if (/^\d+$/.test(account)) params.set('accountId', account);

      const [p, e] = await Promise.all([
        apiClient.get<Page>(`/api/admin/ai/executions?${params}`),
        apiClient.get<{ breakdown: ErrorRow[] }>('/api/admin/ai/executions/errors?days=7'),
      ]);
      setPage(p);
      setErrors(e.breakdown);
    } catch (e) {
      // Message ET code du serveur. Le code — VERSION_NOT_FOUND,
      // CONFIG_OPERATION_FAILED — est stable et cherchable dans le dépôt ;
      // le message seul obligerait à ouvrir les outils de développement.
      const err = e as { message?: string; code?: string; status?: number };
      setErreur([err.message, err.code && `(${err.code}${err.status ? ` — ${err.status}` : ''})`]
        .filter(Boolean).join(' ') || null);
      toast.error('Chargement impossible.');
    } finally {
      setLoading(false);
    }
  }, [treatment, errorsOnly, account, offset]);

  useEffect(() => { load(); }, [load]);

  const changeFilter = (fn: () => void) => { fn(); setOffset(0); };

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[color:var(--text-primary)]">Exécutions &amp; logs</h1>
          <p className="text-sm text-[color:var(--text-muted)]">
            Appels modèles de tous les traitements. Une demande tranchée sans IA n&apos;y figure pas.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Actualiser
        </Button>
      </div>

      {/* Par où commencer — avant la liste */}
      {errors.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
          <h2 className="text-sm font-semibold text-[color:var(--text-primary)] flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            Échecs des sept derniers jours
          </h2>
          <div className="space-y-1">
            {errors.slice(0, 6).map((e, i) => (
              <p key={i} className="text-sm text-[color:var(--text-secondary)]">
                <span className="font-medium text-[color:var(--text-primary)]">{e.count}×</span>
                {' '}{e.treatment ?? 'traitement inconnu'}
                {e.errorCode && ` · ${e.errorCode}`}
                {e.model && ` · ${e.model}`}
                <span className="text-[color:var(--text-muted)]">
                  {' '}— dernier le {new Date(e.lastSeen).toLocaleDateString('fr-FR')}
                </span>
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Filtres */}
      <div className="flex flex-wrap gap-2 items-center">
        <select value={treatment} onChange={(e) => changeFilter(() => setTreatment(e.target.value))}
          className="rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-input)] px-3 py-2 text-sm text-[color:var(--text-primary)]">
          <option value="">Tous les traitements</option>
          {['T1', 'T2', 'T3', 'T4', 'T5'].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <Input placeholder="Compte" value={account} inputMode="numeric"
          onChange={(e) => changeFilter(() => setAccount(e.target.value))}
          className="max-w-[140px] bg-[color:var(--bg-input)]" />
        <label className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
          <input type="checkbox" checked={errorsOnly}
            onChange={(e) => changeFilter(() => setErrorsOnly(e.target.checked))} />
          Échecs seulement
        </label>
        {page && (
          <span className="text-sm text-[color:var(--text-muted)] ml-auto">
            {page.total} appel{page.total > 1 ? 's' : ''}
          </span>
        )}
      </div>

      {erreur ? (
        // Les filtres restent au-dessus : l'erreur vient parfois d'un filtre
        // trop large, et masquer l'écran entier empêcherait de le corriger.
        <EcranEnErreur titre="Exécutions indisponibles" message={erreur} onRetry={load} />
      ) : loading ? (
        <div className="flex items-center justify-center py-16 text-[color:var(--text-muted)]">
          <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Chargement…
        </div>
      ) : (
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] divide-y divide-[color:var(--border-subtle)]">
          {page?.rows.length === 0 && (
            <p className="p-6 text-sm text-[color:var(--text-muted)]">
              Aucun appel modèle ne correspond à ces filtres. Si vous cherchez une demande de
              l&apos;assistant, elle a pu être traitée sans IA — auquel cas elle n&apos;a rien coûté.
            </p>
          )}

          {page?.rows.map((r) => (
            <div key={r.id} className="px-4 py-3 space-y-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className={`text-xs px-2 py-0.5 rounded-full border ${
                  r.status === 'error'
                    ? 'bg-red-500/10 text-red-400 border-red-500/20'
                    : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'}`}>
                  {r.status === 'error' ? 'Échec' : 'Succès'}
                </span>
                <span className="text-sm font-medium text-[color:var(--text-primary)]">
                  {r.treatment ?? '—'}
                </span>
                <span className="text-sm text-[color:var(--text-secondary)]">{r.operationCode}</span>
                <span className="text-sm text-[color:var(--text-muted)]">{r.model}</span>
                {r.modelRank && r.modelRank !== 'primary' && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500">
                    {RANK_LABEL[r.modelRank] ?? r.modelRank}
                  </span>
                )}
                <span className="flex-1" />
                <span className="text-xs text-[color:var(--text-muted)]">
                  {new Date(r.createdAt).toLocaleString('fr-FR')}
                </span>
              </div>

              <p className="text-xs text-[color:var(--text-muted)]">
                {duration(r.durationMs)} · {cost(r.costMicros)}
                {r.inputTokens !== null && ` · ${r.inputTokens} + ${r.outputTokens} tokens`}
                {r.accountId && ` · compte ${r.accountId}`}
                {r.configVisibleNumber !== null && ` · config v${r.configVisibleNumber}`}
                {r.promptVersion && ` · prompt ${r.promptVersion}`}
                {r.appVersion && ` · code ${r.appVersion.slice(0, 8)}`}
              </p>

              {r.errorMessage && (
                <p className="text-xs text-red-400">
                  {r.errorCode ? `${r.errorCode} — ` : ''}{r.errorMessage}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {page && page.total > page.limit && (
        <div className="flex items-center justify-between">
          <Button size="sm" variant="outline" disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - page.limit))}>
            <ChevronLeft className="w-3.5 h-3.5 mr-1.5" /> Précédents
          </Button>
          <span className="text-sm text-[color:var(--text-muted)]">
            {offset + 1} – {Math.min(offset + page.limit, page.total)} sur {page.total}
          </span>
          <Button size="sm" variant="outline" disabled={offset + page.limit >= page.total}
            onClick={() => setOffset(offset + page.limit)}>
            Suivants <ChevronRight className="w-3.5 h-3.5 ml-1.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
