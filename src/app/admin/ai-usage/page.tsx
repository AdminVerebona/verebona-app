"use client";

/**
 * Admin — Suivi IA
 * CDC Verebona V2 — 6 vues :
 *   1. Vue globale (overview)
 *   2. Comptes (liste avec quotas)
 *   3. Documents (recherche par fichier)
 *   4. Opérations IA (liste filtrable)
 *   5. Blocages sécurité
 *   6. Coûts (synthèse par provider/mois)
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  Activity, Building2, FileText, BarChart3,
  RefreshCw, Loader2, CheckCircle2,
  TrendingUp, TrendingDown, Zap, Search, ExternalLink,
  Lock, Unlock, RotateCcw, Settings2, Sparkles, MessageSquare,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import {
  AI_BUSINESS_RESULT_LABELS,
  AI_OPERATION_CATEGORY_LABELS,

  formatCostMicros,
  quotaPercent,
  type AiSecurityLockDetail,
  type AdminAiAccountSummary,
} from '@/types/ai-usage';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color = 'default' }: {
  label: string;
  value: string | number;
  sub?: string;
  color?: 'default' | 'violet' | 'emerald' | 'amber' | 'red';
}) {
  const colors = {
    default: 'border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]',
    violet: 'border-violet-500/30 bg-violet-500/5',
    emerald: 'border-emerald-500/30 bg-emerald-500/5',
    amber: 'border-amber-500/30 bg-amber-500/5',
    red: 'border-red-500/30 bg-red-500/5',
  };
  const textColors = {
    default: 'text-[color:var(--text-primary)]',
    violet: 'text-violet-300',
    emerald: 'text-emerald-300',
    amber: 'text-amber-300',
    red: 'text-red-300',
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color]}`}>
      <p className="text-xs text-[color:var(--text-muted)] mb-1">{label}</p>
      <p className={`text-2xl font-bold ${textColors[color]}`}>{value}</p>
      {sub && <p className="text-xs text-[color:var(--text-muted)] mt-0.5">{sub}</p>}
    </div>
  );
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

function QuotaMiniBar({ used, total }: { used: number; total: number }) {
  const pct = quotaPercent(used, total);
  if (!total) return <span className="text-xs text-[color:var(--text-muted)]">—</span>;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-[color:var(--text-secondary)] tabular-nums">{used} / {total}</span>
      <div className="w-16 h-1.5 rounded-full bg-[color:var(--border-subtle)] overflow-hidden flex-shrink-0">
        <div
          className={`h-full rounded-full ${pct >= 100 ? 'bg-red-500' : pct >= 90 ? 'bg-amber-500' : 'bg-violet-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-[color:var(--text-muted)]">{pct}%</span>
    </div>
  );
}

// ─── Vue Globale ──────────────────────────────────────────────────────────────

function OverviewTab() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<any>('/api/admin/ai/overview');
      setData(res);
    } catch { toast.error('Erreur chargement'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-[color:var(--text-muted)]" /></div>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Stats opérations */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Opérations aujourd'hui" value={data.totalOperationsToday} color="violet" />
        <StatCard label="Opérations ce mois" value={data.totalOperationsThisMonth} />
        <StatCard
          label="Blocages sécurité actifs"
          value={data.activeSecurityLocks}
          color={data.activeSecurityLocks > 0 ? 'red' : 'emerald'}
        />
        <StatCard
          label="Providers actifs"
          value={Object.keys(data.operationsByProvider).length}
        />
      </div>

      {/* Coûts clients / technique / total */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
          <p className="text-xs text-[color:var(--text-muted)]">Coût clients</p>
          <p className="text-2xl font-bold text-amber-300">{formatCostMicros(data.clientCostMicrosThisYear ?? 0)}</p>
          <div className="flex items-center gap-3 text-[10px] text-[color:var(--text-muted)]">
            <span>Aujourd'hui : <span className="text-amber-400/80">{formatCostMicros(data.clientCostMicrosToday ?? 0)}</span></span>
            <span>·</span>
            <span>Ce mois : <span className="text-amber-400/80">{formatCostMicros(data.clientCostMicrosThisMonth ?? 0)}</span></span>
          </div>
          <p className="text-[10px] text-[color:var(--text-muted)]">Somme de tous les comptes (hors technique)</p>
        </div>
        <div className="rounded-xl border border-slate-500/30 bg-slate-500/5 p-4 space-y-2">
          <p className="text-xs text-[color:var(--text-muted)]">Coût technique / tests</p>
          <p className="text-2xl font-bold text-slate-300">{formatCostMicros(data.techCostMicrosThisYear ?? 0)}</p>
          <div className="flex items-center gap-3 text-[10px] text-[color:var(--text-muted)]">
            <span>Aujourd'hui : <span className="text-slate-400/80">{formatCostMicros(data.techCostMicrosToday ?? 0)}</span></span>
            <span>·</span>
            <span>Ce mois : <span className="text-slate-400/80">{formatCostMicros(data.techCostMicrosThisMonth ?? 0)}</span></span>
          </div>
          <p className="text-[10px] text-[color:var(--text-muted)]">{data.techOperationsThisYear ?? 0} ops ({data.techOperationsToday ?? 0} aujourd'hui)</p>
        </div>
        <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4 space-y-2">
          <p className="text-xs text-[color:var(--text-muted)]">Total global</p>
          <p className="text-2xl font-bold text-violet-300">
            {formatCostMicros((data.clientCostMicrosThisYear ?? 0) + (data.techCostMicrosThisYear ?? 0))}
          </p>
          <div className="flex items-center gap-3 text-[10px] text-[color:var(--text-muted)]">
            <span>Aujourd'hui : <span className="text-violet-400/80">{formatCostMicros((data.clientCostMicrosToday ?? 0) + (data.techCostMicrosToday ?? 0))}</span></span>
            <span>·</span>
            <span>Ce mois : <span className="text-violet-400/80">{formatCostMicros((data.clientCostMicrosThisMonth ?? 0) + (data.techCostMicrosThisMonth ?? 0))}</span></span>
          </div>
          <p className="text-[10px] text-[color:var(--text-muted)]">Clients + technique</p>
        </div>
      </div>

      {/* Indicateurs qualité */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label="Fallback flash-8b → 2.5-flash"
          value={`${data.fallback1Rate ?? 0}%`}
          sub="Nominal → Fallback 1"
          color={(data.fallback1Rate ?? 0) > 20 ? 'amber' : 'emerald'}
        />
        <StatCard
          label="Fallback 2.5-flash → 2.5-pro"
          value={`${data.fallback2Rate ?? 0}%`}
          sub="Fallback 1 → Fallback 2"
          color={(data.fallback2Rate ?? 0) > 10 ? 'amber' : 'emerald'}
        />
        <StatCard
          label="Ops. technique / test"
          value={data.techOperationsThisMonth ?? 0}
          sub={`${data.techOperationsToday ?? 0} aujourd'hui`}
          color="default"
        />
      </div>

      {/* Résultats par statut */}
      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)] mb-3">Résultats métier (ce mois)</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {Object.entries(data.operationsByResult).map(([result, cnt]: any) => (
            <div key={result} className="flex items-center justify-between px-3 py-2 rounded-lg bg-[color:var(--bg-page)] border border-[color:var(--border-subtle)]">
              <BusinessResultBadge result={result} />
              <span className="text-sm font-bold text-[color:var(--text-primary)] ml-2">{cnt}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Répartition par provider */}
      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)] mb-3">Répartition par provider (ce mois)</h3>
        <div className="space-y-2">
          {Object.entries(data.operationsByProvider).map(([provider, cnt]: any) => {
            const total = Object.values(data.operationsByProvider).reduce((s: number, v: any) => s + v, 0);
            const pct = total > 0 ? Math.round((cnt / total) * 100) : 0;
            return (
              <div key={provider} className="flex items-center gap-3">
                <span className="text-xs text-[color:var(--text-secondary)] w-32 truncate">{provider ?? 'Inconnu'}</span>
                <div className="flex-1 h-2 rounded-full bg-[color:var(--border-subtle)] overflow-hidden">
                  <div className="h-full rounded-full bg-violet-500" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-xs text-[color:var(--text-muted)] w-16 text-right">{cnt} ({pct}%)</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Top comptes coûteux */}
      {data.topCostAccounts?.length > 0 && (
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4">
          <h3 className="text-sm font-semibold text-[color:var(--text-primary)] mb-3">Top comptes (coût ce mois)</h3>
          <div className="space-y-2">
            {data.topCostAccounts.map((a: any) => (
              <div key={a.accountId} className="flex items-center justify-between px-3 py-2 rounded-lg bg-[color:var(--bg-page)] border border-[color:var(--border-subtle)]">
                <span className="text-sm text-[color:var(--text-secondary)]">{a.accountName}</span>
                <span className="text-sm font-semibold text-amber-400">{formatCostMicros(a.totalCostMicros)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Vue Comptes ──────────────────────────────────────────────────────────────

function AccountsTab() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<AdminAiAccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [resetDialog, setResetDialog] = useState<{ open: boolean; accountId: number | null; accountName: string }>({ open: false, accountId: null, accountName: '' });
  const [quotaDialog, setQuotaDialog] = useState<{ open: boolean; accountId: number | null; accountName: string; current: number }>({ open: false, accountId: null, accountName: '', current: 0 });
  const [resetReason, setResetReason] = useState('');
  const [newQuota, setNewQuota] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<any>(`/api/admin/ai/accounts?search=${encodeURIComponent(search)}&limit=100`);
      setAccounts(res.accounts);
    } catch { toast.error('Erreur chargement'); }
    finally { setLoading(false); }
  }, [search]);

  useEffect(() => { load(); }, [load]);

  const handleReset = async () => {
    if (!resetDialog.accountId) return;
    setActionLoading(true);
    try {
      await apiClient.post(`/api/admin/ai/accounts/${resetDialog.accountId}/reset-counter`, { reason: resetReason });
      toast.success('Compteur remis à zéro');
      setResetDialog({ open: false, accountId: null, accountName: '' });
      setResetReason('');
      load();
    } catch { toast.error('Erreur'); }
    finally { setActionLoading(false); }
  };

  const handleSaveQuota = async () => {
    if (!quotaDialog.accountId) return;
    setActionLoading(true);
    try {
      await apiClient.patch(`/api/admin/ai/accounts/${quotaDialog.accountId}/quota`, {
        documentsAnalyzedQuota: parseInt(newQuota),
        reason: 'Modification manuelle admin',
      });
      toast.success('Quota mis à jour');
      setQuotaDialog({ open: false, accountId: null, accountName: '', current: 0 });
      setNewQuota('');
      load();
    } catch { toast.error('Erreur'); }
    finally { setActionLoading(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[color:var(--text-muted)]" />
          <Input
            placeholder="Rechercher un compte…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm bg-[color:var(--bg-input)] border-[color:var(--border-subtle)]"
          />
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-[color:var(--text-muted)]" /></div>
      ) : (
        <div className="rounded-xl border border-[color:var(--border-subtle)] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-page)]/50">
                <th className="text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Compte</th>
                <th className="text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Plan</th>
                <th className="text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Documents analysés</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Coût analyses</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Coût recherches</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Coût autre IA</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)] border-l border-[color:var(--border-subtle)]">Total</th>
                <th className="text-center px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Statut</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--border-subtle)]">
              {/* Ligne totaux */}
              {accounts.length > 0 && (() => {
                const totAnalysis = accounts.reduce((s, a) => s + ((a as any).costAnalysisMicros ?? 0), 0);
                const totSearch   = accounts.reduce((s, a) => s + ((a as any).costSearchMicros ?? 0), 0);
                const totOther    = accounts.reduce((s, a) => s + ((a as any).costOtherMicros ?? 0), 0);
                const totAll      = totAnalysis + totSearch + totOther;
                return (
                  <tr className="bg-[color:var(--bg-page)]/60 border-b-2 border-[color:var(--border-subtle)]">
                    <td className="px-4 py-2.5" colSpan={3}>
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">
                        Totaux ({accounts.length} comptes)
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span className={`text-xs font-bold tabular-nums ${totAnalysis > 0 ? 'text-amber-300' : 'text-[color:var(--text-muted)]'}`}>{formatCostMicros(totAnalysis)}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span className={`text-xs font-bold tabular-nums ${totSearch > 0 ? 'text-amber-300' : 'text-[color:var(--text-muted)]'}`}>{formatCostMicros(totSearch)}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span className={`text-xs font-bold tabular-nums ${totOther > 0 ? 'text-amber-300' : 'text-[color:var(--text-muted)]'}`}>{formatCostMicros(totOther)}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right border-l border-[color:var(--border-subtle)]">
                      <span className={`text-xs font-bold tabular-nums ${totAll > 0 ? 'text-white' : 'text-[color:var(--text-muted)]'}`}>{formatCostMicros(totAll)}</span>
                    </td>
                    <td colSpan={2} />
                  </tr>
                );
              })()}
              {accounts.map(a => (
                <tr key={a.accountId} className="hover:bg-[color:var(--bg-hover)] transition-colors">
                  <td className="px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-[color:var(--text-primary)]">{a.accountName}</p>
                      <p className="text-[10px] text-[color:var(--text-muted)]">#{a.accountId}</p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-mono text-[color:var(--text-secondary)]">{a.planCode}</span>
                  </td>
                  <td className="px-4 py-3">
                    <QuotaMiniBar used={a.documentsAnalyzedCount} total={a.documentsAnalyzedQuota} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={`text-xs font-semibold tabular-nums ${(a as any).costAnalysisMicros > 0 ? 'text-amber-400' : 'text-[color:var(--text-muted)]'}`}>
                      {formatCostMicros((a as any).costAnalysisMicros ?? 0)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={`text-xs font-semibold tabular-nums ${(a as any).costSearchMicros > 0 ? 'text-amber-400' : 'text-[color:var(--text-muted)]'}`}>
                      {formatCostMicros((a as any).costSearchMicros ?? 0)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={`text-xs font-semibold tabular-nums ${(a as any).costOtherMicros > 0 ? 'text-amber-400' : 'text-[color:var(--text-muted)]'}`}>
                      {formatCostMicros((a as any).costOtherMicros ?? 0)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right border-l border-[color:var(--border-subtle)]">
                    <span className={`text-xs font-bold tabular-nums ${a.totalCostMicrosThisYear > 0 ? 'text-white' : 'text-[color:var(--text-muted)]'}`}>
                      {formatCostMicros(a.totalCostMicrosThisYear)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {a.hasActiveLock
                      ? <span className="inline-flex items-center gap-1 text-[10px] text-red-400"><Lock className="w-3 h-3" />Bloqué</span>
                      : <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400"><CheckCircle2 className="w-3 h-3" />OK</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        onClick={() => router.push(`/admin/ai-usage/${a.accountId}`)}
                        title="Voir le détail"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        onClick={() => { setQuotaDialog({ open: true, accountId: a.accountId, accountName: a.accountName, current: a.documentsAnalyzedQuota }); setNewQuota(String(a.documentsAnalyzedQuota)); }}
                        title="Modifier quota"
                      >
                        <Settings2 className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[10px] text-amber-400 hover:text-amber-300"
                        onClick={() => setResetDialog({ open: true, accountId: a.accountId, accountName: a.accountName })}
                        title="Remettre à zéro"
                      >
                        <RotateCcw className="w-3 h-3" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Dialog Reset */}
      <Dialog open={resetDialog.open} onOpenChange={o => setResetDialog(p => ({ ...p, open: o }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><RotateCcw className="w-4 h-4 text-amber-400" />Reset compteur</DialogTitle>
            <DialogDescription>Remettre à zéro les compteurs de documents analysés de <strong>{resetDialog.accountName}</strong>.</DialogDescription>
          </DialogHeader>
          <Textarea placeholder="Raison (optionnel)" value={resetReason} onChange={e => setResetReason(e.target.value)} className="min-h-[80px] text-sm" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetDialog({ open: false, accountId: null, accountName: '' })}>Annuler</Button>
            <Button onClick={handleReset} disabled={actionLoading} className="bg-amber-600 hover:bg-amber-700 text-white">
              {actionLoading && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Remettre à zéro
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog Quota */}
      <Dialog open={quotaDialog.open} onOpenChange={o => setQuotaDialog(p => ({ ...p, open: o }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Settings2 className="w-4 h-4 text-violet-400" />Modifier quota</DialogTitle>
            <DialogDescription>Quota annuel de documents analysés pour <strong>{quotaDialog.accountName}</strong>.</DialogDescription>
          </DialogHeader>
          <Input type="number" value={newQuota} onChange={e => setNewQuota(e.target.value)} placeholder="Quota annuel" className="text-sm" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setQuotaDialog({ open: false, accountId: null, accountName: '', current: 0 })}>Annuler</Button>
            <Button onClick={handleSaveQuota} disabled={actionLoading} className="bg-violet-600 hover:bg-violet-700 text-white">
              {actionLoading && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Vue Documents ────────────────────────────────────────────────────────────

function DocumentsTab() {
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<any>(`/api/admin/ai/documents?search=${encodeURIComponent(search)}&limit=100`);
      setData(res);
    } catch { toast.error('Erreur chargement'); }
    finally { setLoading(false); }
  }, [search]);

  useEffect(() => { load(); }, [load]);

  const sm = data?.statsMonth;
  const sy = data?.statsYear;
  const successRateMonth = sm?.total > 0 ? Math.round((sm.success / sm.total) * 100) : 0;
  const successRateYear  = sy?.total > 0 ? Math.round((sy.success / sy.total) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Stats */}
      {data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3 space-y-0.5">
              <p className="text-[10px] text-[color:var(--text-muted)] uppercase tracking-wider">Analyses ce mois</p>
              <p className="text-2xl font-bold text-[color:var(--text-primary)]">{sm?.total ?? 0}</p>
              <p className="text-[10px] text-[color:var(--text-muted)]">{sy?.total ?? 0} cette année</p>
            </div>
            <div className={`rounded-xl border p-3 space-y-0.5 ${successRateMonth >= 90 ? 'border-emerald-500/30 bg-emerald-500/5' : successRateMonth >= 70 ? 'border-amber-500/30 bg-amber-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
              <p className="text-[10px] text-[color:var(--text-muted)] uppercase tracking-wider">Taux de succès</p>
              <p className={`text-2xl font-bold ${successRateMonth >= 90 ? 'text-emerald-300' : successRateMonth >= 70 ? 'text-amber-300' : 'text-red-300'}`}>{successRateMonth}%</p>
              <p className="text-[10px] text-[color:var(--text-muted)]">{successRateYear}% cette année · {sm?.errors ?? 0} erreurs ce mois</p>
            </div>
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-0.5">
              <p className="text-[10px] text-[color:var(--text-muted)] uppercase tracking-wider">Coût total ce mois</p>
              <p className="text-2xl font-bold text-amber-300">{formatCostMicros(sm?.totalCost ?? 0)}</p>
              <p className="text-[10px] text-[color:var(--text-muted)]">Moy. {formatCostMicros(sm?.avgCost ?? 0)} / analyse · {formatCostMicros(sy?.totalCost ?? 0)} cette année</p>
            </div>
            <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-3 space-y-0.5">
              <p className="text-[10px] text-[color:var(--text-muted)] uppercase tracking-wider">Réanalyses ce mois</p>
              <p className="text-2xl font-bold text-violet-300">{sm?.reanalyses ?? 0}</p>
              <p className="text-[10px] text-[color:var(--text-muted)]">
                {sm?.total > 0 ? Math.round(((sm?.reanalyses ?? 0) / sm.total) * 100) : 0}% des analyses · durée moy. {sm?.avgDuration ? `${Math.round(sm.avgDuration / 1000)}s` : '—'}
              </p>
            </div>
          </div>

          {Object.keys(sm?.byResult ?? {}).length > 0 && (
            <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3 flex flex-wrap gap-2 items-center">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)] mr-1">Ce mois</span>
              {Object.entries(sm.byResult).map(([result, cnt]: any) => (
                <span key={result} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
                  result === 'success' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' :
                  result === 'success_with_warning' ? 'bg-yellow-500/10 text-yellow-300 border-yellow-500/20' :
                  result === 'error' ? 'bg-red-500/10 text-red-300 border-red-500/20' :
                  'bg-[color:var(--border-subtle)] text-[color:var(--text-muted)] border-transparent'
                }`}>
                  {AI_BUSINESS_RESULT_LABELS[result as keyof typeof AI_BUSINESS_RESULT_LABELS] ?? result}
                  <span className="font-bold">{cnt}</span>
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {/* Recherche */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[color:var(--text-muted)]" />
          <Input
            placeholder="Document, compte…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm bg-[color:var(--bg-input)] border-[color:var(--border-subtle)]"
          />
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Liste */}
      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-[color:var(--text-muted)]" /></div>
      ) : (
        <div className="rounded-xl border border-[color:var(--border-subtle)] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-page)]/50">
                <th className="text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Document</th>
                <th className="text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Compte</th>
                <th className="text-center px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Résultat</th>
                <th className="text-center px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Type</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Coût</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Durée</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--border-subtle)]">
              {(data?.analyses ?? []).length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-xs text-[color:var(--text-muted)]">Aucune analyse trouvée.</td></tr>
              ) : (
                (data.analyses as any[]).map((a: any) => (
                  <tr
                    key={a.operationId}
                    className="hover:bg-[color:var(--bg-hover)] transition-colors cursor-pointer"
                    onClick={() => router.push(`/admin/ai-usage/${a.accountId}`)}
                  >
                    <td className="px-4 py-2.5 max-w-[200px]">
                      <p className="text-xs font-medium text-[color:var(--text-primary)] truncate">{a.documentTitle}</p>
                      {a.errorMessage && <p className="text-[10px] text-red-400/80 truncate">{a.errorMessage}</p>}
                    </td>
                    <td className="px-4 py-2.5">
                      <p className="text-xs text-[color:var(--text-secondary)] truncate max-w-[140px]">{a.accountName}</p>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                        a.businessResult === 'success' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                        a.businessResult === 'success_with_warning' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' :
                        a.businessResult === 'error' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                        'bg-[color:var(--border-subtle)] text-[color:var(--text-muted)] border-transparent'
                      }`}>
                        {AI_BUSINESS_RESULT_LABELS[a.businessResult as keyof typeof AI_BUSINESS_RESULT_LABELS] ?? a.businessResult}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <div className="flex items-center justify-center gap-1">
                        {a.isReanalysis && <span className="text-[10px] text-violet-400 bg-violet-500/10 px-1.5 py-0.5 rounded-full border border-violet-500/20">Réanalyse</span>}
                        {a.usedFallback && <span className="text-[10px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded-full border border-amber-500/20">Fallback</span>}
                        {!a.isReanalysis && !a.usedFallback && <span className="text-[10px] text-[color:var(--text-muted)]">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span className={`text-xs tabular-nums ${a.totalCostMicros > 0 ? 'text-amber-400' : 'text-[color:var(--text-muted)]'}`}>
                        {formatCostMicros(a.totalCostMicros ?? 0)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span className="text-xs tabular-nums text-[color:var(--text-muted)]">
                        {a.durationMs ? `${Math.round(a.durationMs / 1000)}s` : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span className="text-[10px] text-[color:var(--text-muted)] tabular-nums whitespace-nowrap">
                        {a.startedAt ? new Date(a.startedAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Vue Recherches intelligentes ────────────────────────────────────────────

function responseModeLabel(mode: string): string {
  const labels: Record<string, string> = {
    answer: 'Réponse IA',
    sources_only: 'Sources seules',
    upgrade_hint: 'Incitation upgrade',
    blocked_offer: 'Offre non éligible',
    blocked_ambiguous: 'Ambiguë',
    no_result: 'Aucun résultat',
  };
  return labels[mode] ?? mode;
}

function responseModeColor(mode: string): string {
  const colors: Record<string, string> = {
    answer: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
    sources_only: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    upgrade_hint: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    blocked_offer: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
    blocked_ambiguous: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
    no_result: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
  };
  return colors[mode] ?? 'bg-slate-500/10 text-slate-400 border-slate-500/20';
}

function SearchLogsTab() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [offerFilter, setOfferFilter] = useState('');
  const [modeFilter, setModeFilter] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (search) params.set('search', search);
      if (offerFilter) params.set('offer_code', offerFilter);
      if (modeFilter) params.set('response_mode', modeFilter);
      const res = await apiClient.get<any>(`/api/admin/ai/search-logs?${params}`);
      setData(res);
    } catch { toast.error('Erreur chargement'); }
    finally { setLoading(false); }
  }, [search, offerFilter, modeFilter]);

  useEffect(() => { load(); }, [load]);

  const stats = data?.stats ?? {};

  return (
    <div className="space-y-4">
      {/* Stats */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total requêtes" value={stats.totalCount ?? 0} />
          <StatCard label="Réponses IA" value={stats.answerCount ?? 0} color="violet" />
          <StatCard label="Coût total" value={formatCostMicros(stats.totalCostMicros ?? 0)} color="amber" />
          <StatCard
            label="Taux de réponse"
            value={stats.totalCount > 0 ? `${Math.round((stats.answerCount / stats.totalCount) * 100)}%` : '—'}
            color={stats.totalCount > 0 && (stats.answerCount / stats.totalCount) > 0.6 ? 'emerald' : 'default'}
          />
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Tokens input" value={(stats.totalInputTokens ?? 0).toLocaleString('fr-FR')} />
          <StatCard label="Tokens output" value={(stats.totalOutputTokens ?? 0).toLocaleString('fr-FR')} />
          <StatCard label="Durée moy." value={stats.avgDurationMs ? `${(stats.avgDurationMs / 1000).toFixed(1)}s` : '—'} />
          <StatCard label="Erreurs" value={stats.errorCount ?? 0} color={stats.errorCount > 0 ? 'red' : 'emerald'} />
        </div>
      )}

      {/* Filtres */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[160px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[color:var(--text-muted)]" />
          <Input
            placeholder="Rechercher une requête…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm bg-[color:var(--bg-input)] border-[color:var(--border-subtle)]"
          />
        </div>
        <select
          value={offerFilter}
          onChange={e => setOfferFilter(e.target.value)}
          className="h-8 text-xs rounded-lg bg-[color:var(--bg-input)] border border-[color:var(--border-subtle)] text-[color:var(--text-secondary)] px-2"
        >
          <option value="">Toutes offres</option>
          <option value="PREMIUM">Premium</option>
          <option value="PREMIUM_DUO">Premium Duo</option>
          <option value="PREMIUM_PRO">Premium Pro</option>
        </select>
        <select
          value={modeFilter}
          onChange={e => setModeFilter(e.target.value)}
          className="h-8 text-xs rounded-lg bg-[color:var(--bg-input)] border border-[color:var(--border-subtle)] text-[color:var(--text-secondary)] px-2"
        >
          <option value="">Tous modes</option>
          <option value="answer">Réponse IA</option>
          <option value="sources_only">Sources seules</option>
          <option value="upgrade_hint">Incitation upgrade</option>
          <option value="no_result">Aucun résultat</option>
        </select>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-[color:var(--text-muted)]" /></div>
      ) : (
        <div className="rounded-xl border border-[color:var(--border-subtle)] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-page)]/50">
                <th className="text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Requête</th>
                <th className="text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Compte</th>
                <th className="text-center px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Mode</th>
                <th className="text-center px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Offre</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Coût</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Durée</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--border-subtle)]">
              {(data?.logs ?? []).length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-xs text-[color:var(--text-muted)]">Aucune recherche intelligente enregistrée.</td></tr>
              ) : (
                (data.logs as any[]).map((log: any) => (
                  <>
                    <tr
                      key={log.id}
                      className="hover:bg-[color:var(--bg-hover)] transition-colors cursor-pointer"
                      onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                    >
                      <td className="px-4 py-2.5 max-w-[220px]">
                        <p className="text-xs font-medium text-[color:var(--text-primary)] truncate">{log.queryText}</p>
                        {log.blockReason && (
                          <p className="text-[10px] text-amber-400/80 truncate">{log.blockReason}</p>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <p className="text-xs text-[color:var(--text-secondary)] truncate max-w-[130px]">{log.accountName ?? `#${log.accountId}`}</p>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${responseModeColor(log.responseMode)}`}>
                          {responseModeLabel(log.responseMode)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className="text-[10px] font-mono text-[color:var(--text-secondary)]">{log.offerCode}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className={`text-xs tabular-nums ${log.costMicros > 0 ? 'text-amber-400' : 'text-[color:var(--text-muted)]'}`}>
                          {formatCostMicros(log.costMicros ?? 0)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-xs tabular-nums text-[color:var(--text-muted)]">
                          {log.durationMs ? `${(log.durationMs / 1000).toFixed(1)}s` : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-[10px] text-[color:var(--text-muted)] tabular-nums whitespace-nowrap">
                          {log.createdAt ? new Date(log.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                        </span>
                      </td>
                    </tr>
                    {expandedId === log.id && log.answerText && (
                      <tr key={`${log.id}-detail`} className="bg-[color:var(--bg-page)]/40">
                        <td colSpan={7} className="px-6 py-3">
                          <div className="flex items-start gap-2">
                            <Sparkles className="w-3.5 h-3.5 text-violet-400 shrink-0 mt-0.5" />
                            <div className="space-y-1">
                              <p className="text-[10px] font-semibold text-violet-400 uppercase tracking-wider">Réponse générée</p>
                              <p className="text-xs text-[color:var(--text-secondary)] leading-relaxed">{log.answerText}</p>
                              <p className="text-[10px] text-[color:var(--text-muted)]">
                                {log.inputTokens} tokens input · {log.outputTokens} tokens output · {log.sourcesCount} source(s) · {log.model ?? log.provider ?? '—'}
                              </p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────

export default function AdminAiUsagePage() {
  const [activeTab, setActiveTab] = useState('overview');

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[color:var(--text-primary)] flex items-center gap-2">
            <Activity className="w-6 h-6 text-violet-400" />
            Suivi IA
          </h1>
          <p className="text-sm text-[color:var(--text-muted)] mt-1">
            Monitoring complet de la consommation IA — quotas, opérations, coûts, sécurité
          </p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-[rgba(15,23,42,0.5)] border border-[color:var(--border-subtle)] p-1 rounded-xl flex flex-wrap gap-1 w-full sm:w-auto">
          <TabsTrigger value="overview" className="rounded-lg data-[state=active]:bg-violet-500 data-[state=active]:text-white">
            <BarChart3 className="w-3.5 h-3.5 mr-1.5" />Vue globale
          </TabsTrigger>
          <TabsTrigger value="accounts" className="rounded-lg data-[state=active]:bg-violet-500 data-[state=active]:text-white">
            <Building2 className="w-3.5 h-3.5 mr-1.5" />Comptes
          </TabsTrigger>
          <TabsTrigger value="documents" className="rounded-lg data-[state=active]:bg-violet-500 data-[state=active]:text-white">
            <FileText className="w-3.5 h-3.5 mr-1.5" />Documents
          </TabsTrigger>
          <TabsTrigger value="search-logs" className="rounded-lg data-[state=active]:bg-violet-500 data-[state=active]:text-white">
            Recherches intelligentes
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6"><OverviewTab /></TabsContent>
        <TabsContent value="accounts" className="mt-6"><AccountsTab /></TabsContent>
        <TabsContent value="documents" className="mt-6"><DocumentsTab /></TabsContent>
        <TabsContent value="search-logs" className="mt-6">{activeTab === 'search-logs' && <SearchLogsTab />}</TabsContent>

      </Tabs>
    </div>
  );
}
