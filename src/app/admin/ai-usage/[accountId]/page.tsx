"use client";

/**
 * Admin — Suivi IA > Détail compte
 * Vue complète : opérations récentes, coûts, pipeline steps, versions d'analyse, audit
 * Lot 22 : plafond IA du mois (cumul / plafond effectif, offre ou dérogation),
 * dérogation modifiable (PATCH …/quota, auditée).
 */
import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft, Loader2, Activity, FileText, Shield,
  CheckCircle2, AlertTriangle, Lock, Unlock,
  ChevronDown, ChevronRight, Euro, Database, Search,
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
import { Input } from '@/components/ui/input';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

/** Montants du plafond IA : micro-USD, comme les réglages administrés (lot 22). */
function fmtUsd(micros: number | null | undefined) {
  return `${((micros ?? 0) / 1_000_000).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
}

function fmtDate(v: any) {
  if (!v) return '—';
  try { return format(new Date(v), 'dd MMM yyyy HH:mm', { locale: fr }); } catch { return '—'; }
}

function BusinessResultBadge({ result }: { result: string }) {
  const colors: Record<string, string> = {
    success: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]',
    success_with_warning: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning-soft)] border-[color:var(--border-warning)]',
    error: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
    refused_quota: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning-soft)] border-[color:var(--border-warning)]',
    refused_security: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
    incomplete: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)] border-[color:var(--border)]',
    cancelled: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)] border-[color:var(--border)]',
    pending: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-secondary)] border-[color:var(--border)]',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${colors[result] ?? 'bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)] border-[color:var(--border)]'}`}>
      {AI_BUSINESS_RESULT_LABELS[result as keyof typeof AI_BUSINESS_RESULT_LABELS] ?? result}
    </span>
  );
}

function SearchLogRow({ log }: { log: any }) {
  const [expanded, setExpanded] = useState(false);
  const modeColors: Record<string, string> = {
    answer: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]',
    sources_only: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-secondary)] border-[color:var(--border)]',
    upgrade_hint: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning-soft)] border-[color:var(--border-warning)]',
    no_result: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)] border-[color:var(--border)]',
    error: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
    blocked: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
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
            <p className="text-xs font-semibold text-[color:var(--text-primary)] tabular-nums">{formatCostMicros(log.costMicros)}</p>
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
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-[color:var(--bg-danger)] border border-[color:var(--border-danger)]">
              <AlertTriangle className="w-3.5 h-3.5 text-[color:var(--text-danger)] shrink-0 mt-0.5" />
              <p className="text-xs text-[color:var(--text-danger)]">{log.blockReason}</p>
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
            {op.usedFallback && <span className="text-[10px] text-[color:var(--text-warning-soft)]">+ fallback</span>}
          </div>
          <div className="text-right">
            <p className="text-xs font-semibold text-[color:var(--text-primary)] tabular-nums">{formatCostMicros(op.totalCostMicros)}</p>
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
                  <span className="text-[10px] px-2 py-0.5 rounded bg-[color:var(--bg-subtle)] text-[color:var(--text-secondary)] border border-[color:var(--border)]">
                    Origine : {op.origin}
                  </span>
                )}
                {op.environment && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)] border border-[color:var(--border)]">
                    {op.environment}
                  </span>
                )}
                {op.isReanalysis && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-[color:var(--bg-warning)] text-[color:var(--text-warning-soft)] border border-[color:var(--border-warning)]">
                    Re‑analyse
                  </span>
                )}
                {op.completedAt && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-[color:var(--bg-success)] text-[color:var(--text-success)] border border-[color:var(--border-success)]">
                    Terminé {fmtDate(op.completedAt)}
                  </span>
                )}
              </div>
              {op.usedFallback && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[color:var(--bg-warning)] border border-[color:var(--border-warning)]">
                  <AlertTriangle className="w-3.5 h-3.5 text-[color:var(--text-warning-soft)] shrink-0" />
                  <p className="text-xs text-[color:var(--text-warning-soft)]">Fallback utilisé — le modèle nominal n'a pas répondu correctement</p>
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
                  <p className="vb-app-label">Versions d'analyse</p>
                  {opDetail.analysisVersions.map((av: any) => (
                    <div key={av.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)]">
                      <span className="text-[10px] font-mono text-[color:var(--accent)]">v{av.versionNumber}</span>
                      <span className="text-xs text-[color:var(--text-secondary)] flex-1">{av.modelProvider ?? '—'}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[color:var(--bg-success)] text-[color:var(--text-success)]">{av.status}</span>
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
                    step.status === 'done' ? 'bg-[color:var(--bg-success)] text-[color:var(--text-success)]' :
                    step.status === 'error' ? 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)]' :
                    'bg-[color:var(--border-subtle)] text-[color:var(--text-muted)]'
                  }`}>
                    {AI_PIPELINE_STEP_LABELS[step.status as keyof typeof AI_PIPELINE_STEP_LABELS] ?? step.status}
                  </span>
                  <span className="text-[10px] text-[color:var(--text-muted)]">{step.provider ?? '—'}</span>
                  {step.isFallback && <span className="text-[10px] text-[color:var(--text-warning-soft)]">fallback</span>}
                  <span className="text-[10px] text-[color:var(--text-primary)] tabular-nums">{step.costMicros ? formatCostMicros(step.costMicros) : '—'}</span>
                  {step.durationMs && <span className="text-[10px] text-[color:var(--text-muted)]">{step.durationMs}ms</span>}
                </div>
              ))}
            </div>
          )}

          {(op.errorMessage || op.warningMessage) && (
            <div className="mt-3 space-y-1.5">
              {op.errorMessage && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-[color:var(--bg-danger)] border border-[color:var(--border-danger)]">
                  <AlertTriangle className="w-3.5 h-3.5 text-[color:var(--text-danger)] shrink-0 mt-0.5" />
                  <p className="text-xs text-[color:var(--text-danger)] font-mono break-all">{op.errorMessage}</p>
                </div>
              )}
              {op.warningMessage && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-[color:var(--bg-warning)] border border-[color:var(--border-warning)]">
                  <AlertTriangle className="w-3.5 h-3.5 text-[color:var(--text-warning-soft)] shrink-0 mt-0.5" />
                  <p className="text-xs text-[color:var(--text-warning-soft)]">{op.warningMessage}</p>
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
  const [capDialog, setCapDialog] = useState({ open: false, value: '', reason: '' });

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

  // Lot 22 : dérogation au plafond IA de l'offre (montant en $ ; vide = retour à l'offre).
  const handleCap = async (retourOffre: boolean) => {
    const brut = capDialog.value.trim().replace(',', '.');
    const montant = retourOffre || brut === '' ? null : Math.round(Number(brut) * 1_000_000);
    if (montant !== null && (!Number.isFinite(montant) || montant < 0)) { toast.error('Montant invalide.'); return; }
    setActionLoading(true);
    try {
      await apiClient.patch(`/api/admin/ai/accounts/${accountId}/quota`, { monthlyCostCapMicros: montant, reason: capDialog.reason });
      toast.success(montant === null ? 'Plafond de l’offre rétabli' : 'Dérogation enregistrée');
      setCapDialog({ open: false, value: '', reason: '' });
      load();
    } catch { toast.error('Erreur'); }
    finally { setActionLoading(false); }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24">
        <Loader2 className="w-8 h-8 animate-spin text-[color:var(--accent)]" />
      </div>
    );
  }

  if (!data) return null;

  const docsPct = quotaPercent(data.documentsAnalyzedCount, data.documentsAnalyzedQuota);
  const cap = data.costCap as null | {
    capMicros: number | null; spentMicros: number | null; source: 'override' | 'offer' | null; plan: string;
    overrideMicros: number | null; offerCapMicros: number | null; periodKey: string; resumeAt: string; level: string;
  };
  const capPct = cap?.capMicros ? quotaPercent(cap.spentMicros ?? 0, cap.capMicros) : 0;
  const activeLocks = (data.activeSecurityLocks ?? []).filter((l: any) => !l.isResolved);

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push('/admin/ai-usage')} className="mt-0.5 shrink-0">
          <ArrowLeft className="w-4 h-4 mr-1" />Retour
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="vb-app-title truncate">{data.accountName}</h1>
          <p className="text-sm text-[color:var(--text-muted)]">#{data.accountId} · {data.planCode} · {data.ownerEmail}</p>
        </div>
        {activeLocks.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="border-[color:var(--border-danger)] text-[color:var(--text-danger)] hover:bg-[color:var(--bg-danger)] shrink-0"
            onClick={() => setUnlockDialog({ open: true, reason: '' })}
          >
            <Unlock className="w-3.5 h-3.5 mr-1.5" />Débloquer ({activeLocks.length})
          </Button>
        )}
      </div>

      {/* Compteurs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3 space-y-1.5">
          <p className="text-xs text-[color:var(--text-muted)]">Documents analysés ({data.periodYear})</p>
          <p className="text-xl font-bold text-[color:var(--text-primary)]">
            {data.documentsAnalyzedCount}
            <span className="text-sm font-normal text-[color:var(--text-muted)]"> / {data.documentsAnalyzedQuota}</span>
          </p>
          <div className="h-1.5 rounded-full bg-[color:var(--border-subtle)] overflow-hidden">
            <div
              className={`h-full rounded-full ${docsPct >= 100 ? 'bg-[color:var(--danger)]' : docsPct >= 90 ? 'bg-[color:var(--attention)]' : 'bg-[color:var(--accent)]'}`}
              style={{ width: `${docsPct}%` }}
            />
          </div>
        </div>
        {cap && (
          <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3 space-y-1.5" data-testid="ai-cost-cap">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-[color:var(--text-muted)]">Plafond IA ({cap.periodKey})</p>
              <button
                type="button"
                className="text-[10px] text-[color:var(--accent)] hover:underline"
                onClick={() => setCapDialog({ open: true, value: cap.overrideMicros != null ? String(cap.overrideMicros / 1_000_000) : '', reason: '' })}
              >
                Modifier
              </button>
            </div>
            <p className="text-xl font-bold text-[color:var(--text-primary)]">
              {fmtUsd(cap.spentMicros)}
              <span className="text-sm font-normal text-[color:var(--text-muted)]"> / {cap.capMicros ? fmtUsd(cap.capMicros) : 'sans plafond'}</span>
            </p>
            {cap.capMicros ? (
              <div className="h-1.5 rounded-full bg-[color:var(--border-subtle)] overflow-hidden">
                <div
                  className={`h-full rounded-full ${capPct >= 100 ? 'bg-[color:var(--danger)]' : capPct >= 80 ? 'bg-[color:var(--attention)]' : 'bg-[color:var(--accent)]'}`}
                  style={{ width: `${capPct}%` }}
                />
              </div>
            ) : null}
            <p className="text-[10px] text-[color:var(--text-muted)]">
              {cap.source === 'override' ? 'Dérogation du compte' : `Offre ${cap.plan}`}
              {cap.level === 'reached' ? ` · atteint, reprise le ${fmtDate(cap.resumeAt)}` : ''}
            </p>
          </div>
        )}
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3">
          <p className="text-xs text-[color:var(--text-muted)]">Coût total (année)</p>
          <p className="text-xl font-bold text-[color:var(--text-primary)] tabular-nums">{formatCostMicros(data.totalCostMicrosThisYear)}</p>
        </div>
        <div className={`rounded-xl border p-3 ${activeLocks.length > 0 ? 'border-[color:var(--border-danger)] bg-[color:var(--bg-danger)]' : 'border-[color:var(--border-success)] bg-[color:var(--bg-success)]'}`}>
          <p className="text-xs text-[color:var(--text-muted)]">Blocages sécurité</p>
          <p className={`text-xl font-bold ${activeLocks.length > 0 ? 'text-[color:var(--text-danger)]' : 'text-[color:var(--text-success)]'}`}>{activeLocks.length}</p>
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
              <h3 className="vb-app-subsection">Usage IA par type d'opération ({data.periodYear})</h3>
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
                          <div className="h-full rounded-full bg-[color:var(--accent)]" style={{ width: `${pct}%` }} />
                        </div>
                        <span className={`text-[10px] ${r.successCount < r.opsCount ? 'text-[color:var(--text-warning-soft)]' : 'text-[color:var(--text-muted)]'}`}>
                          {r.successCount < r.opsCount ? `${r.successCount} / ${r.opsCount} ops` : `${r.opsCount} ops`}
                        </span>
                      </div>
                    </div>
                    <span className="text-xs font-semibold text-[color:var(--text-primary)] tabular-nums">{formatCostMicros(r.totalCostMicros)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      <Tabs defaultValue="operations">
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="operations" className="rounded-lg">
            <Activity className="w-3.5 h-3.5 mr-1.5" />Analyses
          </TabsTrigger>
          <TabsTrigger value="search" className="rounded-lg">
            <Search className="w-3.5 h-3.5 mr-1.5" />Recherches
          </TabsTrigger>
          <TabsTrigger value="security" className="rounded-lg">
            <Shield className="w-3.5 h-3.5 mr-1.5" />Sécurité
          </TabsTrigger>
          <TabsTrigger value="costs" className="rounded-lg">
            <Euro className="w-3.5 h-3.5 mr-1.5" />Coûts
          </TabsTrigger>
          <TabsTrigger value="audit" className="rounded-lg">
            <Database className="w-3.5 h-3.5 mr-1.5" />Audit
          </TabsTrigger>
        </TabsList>

        {/* Opérations */}
        <TabsContent value="operations" className="mt-4 space-y-2">
          {(data.recentOperations ?? []).length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <CheckCircle2 className="w-8 h-8 text-[color:var(--text-success)]" />
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
              <CheckCircle2 className="w-8 h-8 text-[color:var(--text-success)]" />
              <p className="text-sm text-[color:var(--text-muted)]">Aucun blocage sécurité.</p>
            </div>
          ) : (
            (data.activeSecurityLocks ?? []).map((lock: any) => (
              <div key={lock.id} className={`rounded-xl border p-4 space-y-2 ${lock.isResolved ? 'border-[color:var(--border-subtle)] opacity-60' : 'border-[color:var(--border-danger)] bg-[color:var(--bg-danger)]'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {lock.isResolved ? <CheckCircle2 className="w-4 h-4 text-[color:var(--text-success)]" /> : <Lock className="w-4 h-4 text-[color:var(--text-danger)]" />}
                    <span className="text-sm font-medium text-[color:var(--text-primary)]">
                      {AI_SECURITY_LOCK_LABELS[lock.lockType as keyof typeof AI_SECURITY_LOCK_LABELS] ?? lock.lockType}
                    </span>
                    {lock.isResolved && <span className="text-[10px] text-[color:var(--text-success)] bg-[color:var(--bg-success)] px-1.5 py-0.5 rounded-full">Résolu</span>}
                  </div>
                  <p className="text-xs text-[color:var(--text-muted)]">{fmtDate(lock.triggeredAt)}</p>
                </div>
                {lock.triggerDetails && (
                  <p className="text-xs text-[color:var(--text-secondary)] font-mono bg-[color:var(--bg-page)] px-3 py-2 rounded-lg">{lock.triggerDetails}</p>
                )}
                {lock.isResolved && lock.resolutionNotes && (
                  <p className="text-xs text-[color:var(--text-success)] italic">{lock.resolutionNotes}</p>
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
                  <div className="flex items-center justify-between px-4 py-3 border-b border-[color:var(--border-subtle)] bg-[color:var(--accent-soft)]">
                    <h3 className="vb-app-subsection">Usage client (opérations utilisateur)</h3>
                    <span className="text-sm font-bold text-[color:var(--text-primary)] tabular-nums">{formatCostMicros(total)}</span>
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
                            <p className={`text-xs ${r.successCount < r.opsCount ? 'text-[color:var(--text-warning-soft)]' : 'text-[color:var(--text-secondary)]'}`}>
                              {r.successCount < r.opsCount ? `${r.successCount} / ${r.opsCount} ops` : `${r.opsCount} ops`}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs font-semibold text-[color:var(--text-primary)] tabular-nums">{formatCostMicros(r.totalCostMicros)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {/* Coût par provider */}
                <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-[color:var(--border-subtle)]">
                    <h3 className="vb-app-subsection">Répartition par provider</h3>
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
                            <span className="text-xs font-semibold text-[color:var(--text-primary)] tabular-nums">{formatCostMicros(cost)}</span>
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
                    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3">
                      <p className="text-xs text-[color:var(--text-muted)]">Coût total</p>
                      <p className="text-xl font-bold text-[color:var(--text-primary)] tabular-nums">{formatCostMicros(ss.costMicros)}</p>
                    </div>
                    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3">
                      <p className="text-xs text-[color:var(--text-muted)]">Avec réponse IA</p>
                      <p className="text-xl font-bold text-[color:var(--text-success)]">{ss.answerCount}</p>
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
              <CheckCircle2 className="w-8 h-8 text-[color:var(--text-success)]" />
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

      {/* Dialog Plafond IA (lot 22) */}
      <Dialog open={capDialog.open} onOpenChange={o => setCapDialog(p => ({ ...p, open: o }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Plafond IA mensuel du compte</DialogTitle>
            <DialogDescription>
              Dérogation au plafond de l’offre ({cap?.offerCapMicros ? fmtUsd(cap.offerCapMicros) : 'sans plafond'}), en $ par mois civil.
              0 : aucun plafond pour ce compte. Cette action est auditée.
            </DialogDescription>
          </DialogHeader>
          <Input
            type="number"
            min={0}
            step={0.01}
            aria-label="Plafond mensuel ($)"
            placeholder="Plafond de l’offre"
            value={capDialog.value}
            onChange={e => setCapDialog(p => ({ ...p, value: e.target.value }))}
          />
          <Textarea
            placeholder="Motif (optionnel)"
            value={capDialog.reason}
            onChange={e => setCapDialog(p => ({ ...p, reason: e.target.value }))}
            rows={2}
          />
          <DialogFooter>
            {cap?.overrideMicros != null && (
              <Button variant="ghost" onClick={() => handleCap(true)} disabled={actionLoading}>Revenir à l’offre</Button>
            )}
            <Button variant="outline" onClick={() => setCapDialog({ open: false, value: '', reason: '' })}>Annuler</Button>
            <Button onClick={() => handleCap(false)} disabled={actionLoading || capDialog.value.trim() === ''}>
              {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog Unlock */}
      <Dialog open={unlockDialog.open} onOpenChange={o => setUnlockDialog(p => ({ ...p, open: o }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Unlock className="w-4 h-4 text-[color:var(--text-success)]" />Lever les blocages</DialogTitle>
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
            >
              {actionLoading && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Débloquer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
