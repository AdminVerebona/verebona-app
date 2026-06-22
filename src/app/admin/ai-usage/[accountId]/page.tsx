"use client";

/**
 * Admin — Suivi IA > Détail compte
 * Vue complète : opérations récentes, coûts, pipeline steps, versions d'analyse, audit
 */
import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft, Loader2, Activity, FileText, Shield, Clock,
  CheckCircle2, AlertTriangle, Lock, Unlock, RotateCcw, Settings2,
  ChevronDown, ChevronRight, Cpu, TrendingUp, Euro, Database, Search,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import {
  formatCostMicros, quotaPercent,
  AI_BUSINESS_RESULT_LABELS, AI_OPERATION_CATEGORY_LABELS,
  AI_PIPELINE_STEP_LABELS, AI_SECURITY_LOCK_LABELS, AI_SEARCH_RESPONSE_MODE_LABELS,
} from '@/types/ai-usage';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

function fmtDate(v: any) {
  if (!v) return '—';
  try { return format(new Date(v), 'dd MMM yyyy HH:mm', { locale: fr }); } catch { return '—'; }
}

function BusinessResultBadge({ result }: { result: string }) {
  const colors: Record<string, string> = {
    success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    success_with_warning: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    error: 'bg-red-500/10 text-red-400 border-red-500/20',
    refused_quota: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    refused_security: 'bg-red-500/10 text-red-400 border-red-500/20',
    incomplete: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
    cancelled: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
    pending: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${colors[result] ?? 'bg-slate-500/10 text-slate-400 border-slate-500/20'}`}>
      {AI_BUSINESS_RESULT_LABELS[result as keyof typeof AI_BUSINESS_RESULT_LABELS] ?? result}
    </span>
  );
}

function SearchLogRow({ log }: { log: any }) {
  const [expanded, setExpanded] = useState(false);
  const modeColors: Record<string, string> = {
    answer: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    sources_only: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    upgrade_hint: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    no_result: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
    error: 'bg-red-500/10 text-red-400 border-red-500/20',
    blocked: 'bg-red-500/10 text-red-400 border-red-500/20',
  };
  return (
    <div className="overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[color:var(--bg-hover)] transition-colors text-left"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-[color:var(--text-muted)] shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-[color:var(--text-muted)] shrink-0" />}
        <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-5 gap-2 items-center">
          <div className="sm:col-span-2 min-w-0">
            <p className="text-xs font-medium text-[color:var(--text-primary)] truncate">{log.queryText}</p>
            <p className="text-[10px] text-[color:var(--text-muted)]">{fmtDate(log.createdAt)}</p>
          </div>
          <div>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${modeColors[log.responseMode] ?? modeColors.no_result}`}>
              {AI_SEARCH_RESPONSE_MODE_LABELS[log.responseMode as keyof typeof AI_SEARCH_RESPONSE_MODE_LABELS] ?? log.responseMode}
            </span>
          </div>
          <div>
            <p className="text-xs text-[color:var(--text-secondary)]">{log.provider ?? '—'}</p>
            {log.durationMs && <p className="text-[10px] text-[color:var(--text-muted)]">{log.durationMs}ms</p>}
          </div>
          <div className="text-right">
            <p className="text-xs font-semibold text-amber-400">{formatCostMicros(log.costMicros)}</p>
            <p className="text-[10px] text-[color:var(--text-muted)]">{log.sourcesCount} source{log.sourcesCount !== 1 ? 's' : ''}</p>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-[color:var(--border-subtle)] px-4 py-3 bg-[color:var(--bg-page)]/40 space-y-2">
          <div className="flex gap-4 text-[10px] text-[color:var(--text-muted)]">
            <span>Entrée : {log.inputTokens} tok</span>
            <span>Sortie : {log.outputTokens} tok</span>
            <span>Offre : {log.offerCode}</span>
            {log.model && <span>Modèle : {log.model}</span>}
          </div>
          {log.answerText && (
            <div className="bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] rounded-lg px-3 py-2">
              <p className="text-[10px] text-[color:var(--text-muted)] mb-1">Réponse IA</p>
              <p className="text-xs text-[color:var(--text-secondary)] whitespace-pre-wrap">{log.answerText}</p>
            </div>
          )}
          {log.blockReason && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/5 border border-red-500/20">
              <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300">{log.blockReason}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OperationRow({ op }: { op: any }) {
  const [expanded, setExpanded] = useState(false);
  const [steps, setSteps] = useState<any[]>([]);
  const [loadingSteps, setLoadingSteps] = useState(false);

  const [opDetail, setOpDetail] = useState<any>(null);

  const loadSteps = async () => {
    if (steps.length > 0 || opDetail) { setExpanded(e => !e); return; }
    setExpanded(true);
    setLoadingSteps(true);
    try {
      const res = await apiClient.get<any>(`/api/admin/ai/operations/${op.id}`);
      setSteps(res.steps ?? []);
      setOpDetail(res);
    } catch { toast.error('Erreur chargement étapes'); }
    finally { setLoadingSteps(false); }
  };

  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] overflow-hidden">
      <button
        onClick={loadSteps}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[color:var(--bg-hover)] transition-colors text-left"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-[color:var(--text-muted)] shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-[color:var(--text-muted)] shrink-0" />}
        <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-5 gap-2 items-center">
          <div className="sm:col-span-2">
            <p className="text-xs font-medium text-[color:var(--text-primary)] truncate">
              {AI_OPERATION_CATEGORY_LABELS[op.operationCategory as keyof typeof AI_OPERATION_CATEGORY_LABELS] ?? op.operationCategory}
            </p>
            <p className="text-[10px] text-[color:var(--text-muted)]">{fmtDate(op.startedAt)}</p>
          </div>
          <div>
            <BusinessResultBadge result={op.businessResult} />
          </div>
          <div>
            <p className="text-xs text-[color:var(--text-secondary)]">{op.providerPrimary ?? '—'}</p>
            {op.usedFallback && <span className="text-[10px] text-amber-400">+ fallback</span>}
          </div>
          <div className="text-right">
            <p className="text-xs font-semibold text-amber-400">{formatCostMicros(op.totalCostMicros)}</p>
            {op.durationMs && <p className="text-[10px] text-[color:var(--text-muted)]">{op.durationMs}ms</p>}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-[color:var(--border-subtle)] px-4 py-3 bg-[color:var(--bg-page)]/40">
          {loadingSteps ? (
            <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 animate-spin" /></div>
          ) : steps.length === 0 ? (
            <div className="space-y-2 py-1">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {op.totalInputTokens != null && (
                  <div className="rounded-lg bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] px-3 py-2">
                    <p className="text-[10px] text-[color:var(--text-muted)]">Tokens entrée</p>
                    <p className="text-xs font-semibold text-[color:var(--text-primary)]">{op.totalInputTokens.toLocaleString()}</p>
                  </div>
                )}
                {op.totalOutputTokens != null && (
                  <div className="rounded-lg bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] px-3 py-2">
                    <p className="text-[10px] text-[color:var(--text-muted)]">Tokens sortie</p>
                    <p className="text-xs font-semibold text-[color:var(--text-primary)]">{op.totalOutputTokens.toLocaleString()}</p>
                  </div>
                )}
                {op.providerPrimary && (
                  <div className="rounded-lg bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] px-3 py-2">
                    <p className="text-[10px] text-[color:var(--text-muted)]">Modèle</p>
                    <p className="text-xs font-semibold text-[color:var(--text-primary)] truncate">{op.providerPrimary}</p>
                  </div>
                )}
                {op.durationMs != null && (
                  <div className="rounded-lg bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] px-3 py-2">
                    <p className="text-[10px] text-[color:var(--text-muted)]">Durée</p>
                    <p className="text-xs font-semibold text-[color:var(--text-primary)]">{op.durationMs}ms</p>
                  </div>
                )}
              </div>
              {/* Analyse détaillée */}
              <div className="flex flex-wrap gap-2">
                {op.origin && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                    Origine : {op.origin}
                  </span>
                )}
                {op.environment && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-slate-500/10 text-slate-400 border border-slate-500/20">
                    {op.environment}
                  </span>
                )}
                {op.isReanalysis && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    Re‑analyse
                  </span>
                )}
                {op.completedAt && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    Terminé {fmtDate(op.completedAt)}
                  </span>
                )}
              </div>
              {op.usedFallback && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/20">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <p className="text-xs text-amber-300">Fallback utilisé — le modèle nominal n'a pas répondu correctement</p>
                </div>
              )}
              {opDetail?.fileName && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)]">
                  <FileText className="w-3.5 h-3.5 text-[color:var(--text-muted)] shrink-0" />
                  <p className="text-xs text-[color:var(--text-secondary)]">Fichier source : {opDetail.fileName}</p>
                </div>
              )}
              {(opDetail?.analysisVersions ?? []).length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold text-[color:var(--text-muted)] uppercase tracking-wider">Versions d'analyse</p>
                  {opDetail.analysisVersions.map((av: any) => (
                    <div key={av.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)]">
                      <span className="text-[10px] font-mono text-violet-400">v{av.versionNumber}</span>
                      <span className="text-xs text-[color:var(--text-secondary)] flex-1">{av.modelProvider ?? '—'}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">{av.status}</span>
                      {av.durationMs != null && (
                        <span className="text-[10px] text-[color:var(--text-muted)]">{av.durationMs}ms</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              {steps.map((step: any) => (
                <div key={step.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)]">
                  <span className="text-[10px] font-mono text-[color:var(--text-muted)] w-6 text-right">{step.stepOrder}</span>
                  <span className="text-xs text-[color:var(--text-secondary)] flex-1">{step.stepName}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    step.status === 'done' ? 'bg-emerald-500/10 text-emerald-400' :
                    step.status === 'error' ? 'bg-red-500/10 text-red-400' :
                    'bg-[color:var(--border-subtle)] text-[color:var(--text-muted)]'
                  }`}>
                    {AI_PIPELINE_STEP_LABELS[step.status as keyof typeof AI_PIPELINE_STEP_LABELS] ?? step.status}
                  </span>
                  <span className="text-[10px] text-[color:var(--text-muted)]">{step.provider ?? '—'}</span>
                  {step.isFallback && <span className="text-[10px] text-amber-400">fallback</span>}
                  <span className="text-[10px] text-amber-400/70">{step.costMicros ? formatCostMicros(step.costMicros) : '—'}</span>
                  {step.durationMs && <span className="text-[10px] text-[color:var(--text-muted)]">{step.durationMs}ms</span>}
                </div>
              ))}
            </div>
          )}

          {(op.errorMessage || op.warningMessage) && (
            <div className="mt-3 space-y-1.5">
              {op.errorMessage && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/5 border border-red-500/20">
                  <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-300 font-mono break-all">{op.errorMessage}</p>
                </div>
              )}
              {op.warningMessage && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/20">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-300">{op.warningMessage}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AdminAiUsageAccountPage() {
  const router = useRouter();
  const params = useParams();
  const accountId = params.accountId as string;

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [unlockDialog, setUnlockDialog] = useState({ open: false, reason: '' });
  const [actionLoading, setActionLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<any>(`/api/admin/ai/accounts/${accountId}`);
      setData(res);
    } catch { toast.error('Erreur chargement'); }
    finally { setLoading(false); }
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  const handleUnlock = async () => {
    setActionLoading(true);
    try {
      await apiClient.post(`/api/admin/ai/accounts/${accountId}/unlock-security`, { reason: unlockDialog.reason });
      toast.success('Blocage levé');
      setUnlockDialog({ open: false, reason: '' });
      load();
    } catch { toast.error('Erreur'); }
    finally { setActionLoading(false); }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24">
        <Loader2 className="w-8 h-8 animate-spin text-violet-400" />
      </div>
    );
  }

  if (!data) return null;

  const docsPct = quotaPercent(data.documentsAnalyzedCount, data.documentsAnalyzedQuota);
  const activeLocks = (data.activeSecurityLocks ?? []).filter((l: any) => !l.isResolved);

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push('/admin/ai-usage')} className="mt-0.5 shrink-0">
          <ArrowLeft className="w-4 h-4 mr-1" />Retour
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-[color:var(--text-primary)] truncate">{data.accountName}</h1>
          <p className="text-sm text-[color:var(--text-muted)]">#{data.accountId} · {data.planCode} · {data.ownerEmail}</p>
        </div>
        {activeLocks.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="border-red-500/30 text-red-300 hover:bg-red-500/10 shrink-0"
            onClick={() => setUnlockDialog({ open: true, reason: '' })}
          >
            <Unlock className="w-3.5 h-3.5 mr-1.5" />Débloquer ({activeLocks.length})
          </Button>
        )}
      </div>

      {/* Compteurs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3 space-y-1.5">
          <p className="text-xs text-[color:var(--text-muted)]">Documents analysés ({data.periodYear})</p>
          <p className="text-xl font-bold text-[color:var(--text-primary)]">
            {data.documentsAnalyzedCount}
            <span className="text-sm font-normal text-[color:var(--text-muted)]"> / {data.documentsAnalyzedQuota}</span>
          </p>
          <div className="h-1.5 rounded-full bg-[color:var(--border-subtle)] overflow-hidden">
            <div
              className={`h-full rounded-full ${docsPct >= 100 ? 'bg-red-500' : docsPct >= 90 ? 'bg-amber-500' : 'bg-violet-500'}`}
              style={{ width: `${docsPct}%` }}
            />
          </div>
        </div>
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-xs text-[color:var(--text-muted)]">Coût total (année)</p>
          <p className="text-xl font-bold text-amber-300">{formatCostMicros(data.totalCostMicrosThisYear)}</p>
        </div>
        <div className={`rounded-xl border p-3 ${activeLocks.length > 0 ? 'border-red-500/30 bg-red-500/5' : 'border-emerald-500/30 bg-emerald-500/5'}`}>
          <p className="text-xs text-[color:var(--text-muted)]">Blocages sécurité</p>
          <p className={`text-xl font-bold ${activeLocks.length > 0 ? 'text-red-300' : 'text-emerald-300'}`}>{activeLocks.length}</p>
        </div>
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3">
          <p className="text-xs text-[color:var(--text-muted)]">Analyses récentes</p>
          <p className="text-xl font-bold text-[color:var(--text-primary)]">{data.recentOperations?.length ?? 0}</p>
        </div>
      </div>

      {/* Usage IA par catégorie (client uniquement) */}
      {(() => {
        const clientRows = (data.costByCategory ?? []) as any[];
        const ss = data.searchStats;
        const searchRow = ss?.count > 0 ? { category: '_search', opsCount: ss.count, successCount: ss.answerCount, totalCostMicros: ss.costMicros } : null;
        const allRows = [...clientRows, ...(searchRow ? [searchRow] : [])];
        if (allRows.length === 0) return null;
        const sorted = [...allRows].sort((a: any, b: any) => b.totalCostMicros - a.totalCostMicros);
        const maxCost = sorted[0]?.totalCostMicros ?? 1;
        return (
          <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[color:var(--border-subtle)]">
              <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Usage IA par type d'opération ({data.periodYear})</h3>
            </div>
            <div className="divide-y divide-[color:var(--border-subtle)]">
              {sorted.map((r: any) => {
                const pct = maxCost > 0 ? Math.round((r.totalCostMicros / maxCost) * 100) : 0;
                const label = r.category === '_search' ? 'Recherche intelligente' : (AI_OPERATION_CATEGORY_LABELS[r.category as keyof typeof AI_OPERATION_CATEGORY_LABELS] ?? r.category);
                return (
                  <div key={r.category} className="grid grid-cols-[1fr_auto_auto] gap-4 px-4 py-2.5 items-center hover:bg-[color:var(--bg-hover)] transition-colors">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-[color:var(--text-primary)]">{label}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="h-1 rounded-full bg-[color:var(--border-subtle)] flex-1 max-w-[120px] overflow-hidden">
                          <div className="h-full rounded-full bg-violet-500/60" style={{ width: `${pct}%` }} />
                        </div>
                        <span className={`text-[10px] ${r.successCount < r.opsCount ? 'text-amber-400' : 'text-[color:var(--text-muted)]'}`}>
                          {r.successCount < r.opsCount ? `${r.successCount} / ${r.opsCount} ops` : `${r.opsCount} ops`}
                        </span>
                      </div>
                    </div>
                    <span className="text-xs font-semibold text-amber-400 tabular-nums">{formatCostMicros(r.totalCostMicros)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      <Tabs defaultValue="operations">
        <TabsList className="bg-[rgba(15,23,42,0.5)] border border-[color:var(--border-subtle)] p-1 rounded-xl w-fit">
          <TabsTrigger value="operations" className="rounded-lg data-[state=active]:bg-violet-500 data-[state=active]:text-white">
            <Activity className="w-3.5 h-3.5 mr-1.5" />Analyses
          </TabsTrigger>
          <TabsTrigger value="search" className="rounded-lg data-[state=active]:bg-sky-500 data-[state=active]:text-white">
            <Search className="w-3.5 h-3.5 mr-1.5" />Recherches
          </TabsTrigger>
          <TabsTrigger value="security" className="rounded-lg data-[state=active]:bg-red-500 data-[state=active]:text-white">
            <Shield className="w-3.5 h-3.5 mr-1.5" />Sécurité
          </TabsTrigger>
          <TabsTrigger value="costs" className="rounded-lg data-[state=active]:bg-amber-500 data-[state=active]:text-white">
            <Euro className="w-3.5 h-3.5 mr-1.5" />Coûts
          </TabsTrigger>
          <TabsTrigger value="audit" className="rounded-lg data-[state=active]:bg-slate-500 data-[state=active]:text-white">
            <Database className="w-3.5 h-3.5 mr-1.5" />Audit
          </TabsTrigger>
        </TabsList>

        {/* Opérations */}
        <TabsContent value="operations" className="mt-4 space-y-2">
          {(data.recentOperations ?? []).length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <CheckCircle2 className="w-8 h-8 text-emerald-500" />
              <p className="text-sm text-[color:var(--text-muted)]">Aucune opération enregistrée.</p>
            </div>
          ) : (
            (data.recentOperations ?? []).map((op: any) => (
              <OperationRow key={op.id} op={op} />
            ))
          )}
        </TabsContent>

        {/* Sécurité */}
        <TabsContent value="security" className="mt-4 space-y-3">
          {(data.activeSecurityLocks ?? []).length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <CheckCircle2 className="w-8 h-8 text-emerald-500" />
              <p className="text-sm text-[color:var(--text-muted)]">Aucun blocage sécurité.</p>
            </div>
          ) : (
            (data.activeSecurityLocks ?? []).map((lock: any) => (
              <div key={lock.id} className={`rounded-xl border p-4 space-y-2 ${lock.isResolved ? 'border-[color:var(--border-subtle)] opacity-60' : 'border-red-500/30 bg-red-500/5'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {lock.isResolved ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : <Lock className="w-4 h-4 text-red-400" />}
                    <span className="text-sm font-medium text-[color:var(--text-primary)]">
                      {AI_SECURITY_LOCK_LABELS[lock.lockType as keyof typeof AI_SECURITY_LOCK_LABELS] ?? lock.lockType}
                    </span>
                    {lock.isResolved && <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">Résolu</span>}
                  </div>
                  <p className="text-xs text-[color:var(--text-muted)]">{fmtDate(lock.triggeredAt)}</p>
                </div>
                {lock.triggerDetails && (
                  <p className="text-xs text-[color:var(--text-secondary)] font-mono bg-[color:var(--bg-page)] px-3 py-2 rounded-lg">{lock.triggerDetails}</p>
                )}
                {lock.isResolved && lock.resolutionNotes && (
                  <p className="text-xs text-emerald-300/70 italic">{lock.resolutionNotes}</p>
                )}
              </div>
            ))
          )}
        </TabsContent>

        {/* Coûts par catégorie */}
        <TabsContent value="costs" className="mt-4 space-y-4">
          {(() => {
            const rows: any[] = data.costByCategory ?? [];
            const ss = data.searchStats;
            const searchRow = ss?.count > 0
              ? { category: '_search', opsCount: ss.count, successCount: ss.answerCount, totalCostMicros: ss.costMicros }
              : null;
            const allRows = [...rows, ...(searchRow ? [searchRow] : [])].sort((a: any, b: any) => b.totalCostMicros - a.totalCostMicros);
            const total = allRows.reduce((s: number, r: any) => s + r.totalCostMicros, 0);

            // Merge provider costs: aiOperation providers + search provider(s)
            const providerMap: Record<string, number> = { ...(data.costByProvider ?? {}) };
            if (ss?.costMicros > 0) {
              // Search logs use Gemini — aggregate under their provider
              const searchProviders: Record<string, number> = {};
              (data.searchLogs ?? []).forEach((l: any) => {
                const p = l.provider ?? 'gemini';
                searchProviders[p] = (searchProviders[p] ?? 0) + l.costMicros;
              });
              for (const [p, c] of Object.entries(searchProviders)) {
                providerMap[p] = (providerMap[p] ?? 0) + (c as number);
              }
            }

            return (
              <>
                <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-[color:var(--border-subtle)] bg-violet-500/5">
                    <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Usage client (opérations utilisateur)</h3>
                    <span className="text-sm font-bold text-amber-300">{formatCostMicros(total)}</span>
                  </div>
                  {allRows.length === 0 ? (
                    <p className="text-xs text-[color:var(--text-muted)] px-4 py-3">Aucune opération cette année.</p>
                  ) : (
                    <div className="divide-y divide-[color:var(--border-subtle)]">
                      {allRows.map((r: any) => (
                        <div key={r.category} className="grid grid-cols-4 gap-2 px-4 py-2.5 items-center hover:bg-[color:var(--bg-hover)] transition-colors">
                          <div className="col-span-2">
                            <p className="text-xs font-medium text-[color:var(--text-primary)]">
                              {r.category === '_search' ? 'Recherche intelligente' : (AI_OPERATION_CATEGORY_LABELS[r.category as keyof typeof AI_OPERATION_CATEGORY_LABELS] ?? r.category)}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className={`text-xs ${r.successCount < r.opsCount ? 'text-amber-400' : 'text-[color:var(--text-secondary)]'}`}>
                              {r.successCount < r.opsCount ? `${r.successCount} / ${r.opsCount} ops` : `${r.opsCount} ops`}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs font-semibold text-amber-400">{formatCostMicros(r.totalCostMicros)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {/* Coût par provider */}
                <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-[color:var(--border-subtle)]">
                    <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Répartition par provider</h3>
                  </div>
                  {Object.keys(providerMap).length === 0 ? (
                    <p className="text-xs text-[color:var(--text-muted)] px-4 py-3">Aucune donnée.</p>
                  ) : (
                    <div className="divide-y divide-[color:var(--border-subtle)]">
                      {Object.entries(providerMap)
                        .sort(([, a]: any, [, b]: any) => b - a)
                        .map(([provider, cost]: any) => (
                          <div key={provider} className="flex items-center justify-between px-4 py-2.5 hover:bg-[color:var(--bg-hover)] transition-colors">
                            <span className="text-xs text-[color:var(--text-secondary)]">{provider}</span>
                            <span className="text-xs font-semibold text-amber-400">{formatCostMicros(cost)}</span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </TabsContent>

        {/* Recherches intelligentes */}
        <TabsContent value="search" className="mt-4 space-y-4">
          {(() => {
            const ss = data.searchStats;
            const logs: any[] = data.searchLogs ?? [];
            return (
              <>
                {/* Stats résumé */}
                {ss && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3">
                      <p className="text-xs text-[color:var(--text-muted)]">Recherches ({data.periodYear})</p>
                      <p className="text-xl font-bold text-[color:var(--text-primary)]">{ss.count}</p>
                    </div>
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                      <p className="text-xs text-[color:var(--text-muted)]">Coût total</p>
                      <p className="text-xl font-bold text-amber-300">{formatCostMicros(ss.costMicros)}</p>
                    </div>
                    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3">
                      <p className="text-xs text-[color:var(--text-muted)]">Avec réponse IA</p>
                      <p className="text-xl font-bold text-emerald-300">{ss.answerCount}</p>
                    </div>
                    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3">
                      <p className="text-xs text-[color:var(--text-muted)]">Durée moy.</p>
                      <p className="text-xl font-bold text-[color:var(--text-primary)]">{ss.avgDurationMs ? `${ss.avgDurationMs}ms` : '—'}</p>
                    </div>
                  </div>
                )}
                {/* Liste */}
                {logs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-3">
                    <Search className="w-8 h-8 text-[color:var(--text-muted)]" />
                    <p className="text-sm text-[color:var(--text-muted)]">Aucune recherche intelligente enregistrée.</p>
                  </div>
                ) : (
                  <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] overflow-hidden">
                    <div className="divide-y divide-[color:var(--border-subtle)]">
                      {logs.map((log: any) => (
                        <SearchLogRow key={log.id} log={log} />
                      ))}
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </TabsContent>

        {/* Audit */}
        <TabsContent value="audit" className="mt-4 space-y-2">
          {(data.auditLogs ?? []).length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <CheckCircle2 className="w-8 h-8 text-emerald-500" />
              <p className="text-sm text-[color:var(--text-muted)]">Aucune action admin enregistrée.</p>
            </div>
          ) : (
            (data.auditLogs ?? []).map((log: any) => (
              <div key={log.id} className="flex items-start gap-3 px-4 py-3 rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]">
                <Database className="w-4 h-4 text-[color:var(--text-muted)] shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-[color:var(--text-primary)]">{log.actionType}</span>
                    <span className="text-xs text-[color:var(--text-muted)]">par {log.adminEmail}</span>
                    <span className="text-xs text-[color:var(--text-muted)]">{fmtDate(log.createdAt)}</span>
                  </div>
                  {log.reason && <p className="text-xs text-[color:var(--text-secondary)] mt-0.5 italic">{log.reason}</p>}
                  {log.beforeValue && log.afterValue && (
                    <div className="flex items-center gap-2 mt-1 text-[10px] font-mono text-[color:var(--text-muted)]">
                      <span>{JSON.stringify(log.beforeValue)}</span>
                      <span>→</span>
                      <span>{JSON.stringify(log.afterValue)}</span>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </TabsContent>
      </Tabs>

      {/* Dialog Unlock */}
      <Dialog open={unlockDialog.open} onOpenChange={o => setUnlockDialog(p => ({ ...p, open: o }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Unlock className="w-4 h-4 text-emerald-400" />Lever les blocages</DialogTitle>
            <DialogDescription>Débloquer tous les locks sécurité IA actifs de ce compte. Cette action est auditée.</DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Raison (obligatoire)"
            value={unlockDialog.reason}
            onChange={e => setUnlockDialog(p => ({ ...p, reason: e.target.value }))}
            className="min-h-[80px] text-sm"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnlockDialog({ open: false, reason: '' })}>Annuler</Button>
            <Button
              onClick={handleUnlock}
              disabled={actionLoading || !unlockDialog.reason.trim()}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {actionLoading && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Débloquer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
