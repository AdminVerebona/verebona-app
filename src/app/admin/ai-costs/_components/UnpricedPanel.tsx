"use client";

/**
 * BO › Coûts IA › « Appels non chiffrés » — lot 109L (ticket P1 « Tarifs
 * Gemini non reconnus, 948 appels », points D et E).
 *
 * Ouvert depuis le bandeau : rapprochement avec l'ancienne règle du bandeau,
 * ventilation par cause, par modèle (lien vers les exécutions du modèle et de
 * la période) et par jour, exemples reliés aux traces ; agrégats journaliers à
 * part. Régularisation CONTRÔLÉE : simuler → exporter avant / après →
 * appliquer une fois → annuler. Coût initial, régularisé et encore inconnu
 * sont distingués ; rien n'appelle un modèle.
 */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Download, Play, RotateCcw, FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';

interface Bucket { calls: number; legacyRule: number; inputTokens: number; outputTokens: number; regularizable: number; corrected: number; reconstitutedMicros: number }
interface Report {
  period: { since: string; until: string };
  reconciliation: { legacyRuleCalls: number; legacyRuleByCause: Record<string, number>; effectiveUnknownCalls: number; zeroOrRoundedCalls: number; alreadyCorrected: number };
  byCause: Array<{ cause: string; label: string } & Bucket>;
  byModel: Array<{ model: string; cause: string; label: string; firstAt: string; lastAt: string; statusNow: string | null } & Bucket>;
  byDay: Array<{ day: string; calls: number; byCause: Record<string, number> }>;
  rollups: { rows: number; unpricedCalls: number; regularizableRows: number; regularizableCalls: number };
  samples: Record<string, Array<{ id: number; at: string; model: string | null; traceId: string | null; detail: string; notReconstitutable: string | null }>>;
  lastPricingSync: Record<string, unknown> | null;
}
interface Run { id: number; mode: string; status: string; since: string; until: string; started_at: string; dry_run_id: number | null; summary: Record<string, any>; error_message: string | null }

const usd = (m: number) => `${(m / 1_000_000).toFixed(m < 10_000 ? 4 : 2)} $`;
const day = (d: string) => d.slice(0, 10);

export function UnpricedPanel({ since, until }: { since: string; until: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ since, until });
      const [r, x] = await Promise.all([
        apiClient.get<Report>(`/api/admin/ai/costs/unpriced?${q}`),
        apiClient.get<{ runs: Run[] }>('/api/admin/ai/costs/regularization').catch(() => ({ runs: [] })),
      ]);
      setReport(r); setRuns(x.runs);
    } catch { toast.error('Détail des appels non chiffrés indisponible.'); }
  }, [since, until]);
  useEffect(() => { load(); }, [load]);

  const act = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try { await apiClient.post('/api/admin/ai/costs/regularization', body); toast.success(ok); }
    catch (e) { toast.error((e as Error).message || 'Action refusée.'); }
    finally { setBusy(false); load(); }
  };

  if (!report) return <div className="flex items-center gap-2 text-sm text-[color:var(--text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Diagnostic…</div>;
  const rc = report.reconciliation;
  const lastDry = runs.find((r) => r.mode === 'dry_run' && r.status === 'completed');
  const applied = (id: number) => runs.some((r) => r.mode === 'apply' && r.status === 'completed' && r.dry_run_id === id);
  const lastApply = runs.find((r) => r.mode === 'apply' && r.status === 'completed');
  const exec = (model: string, from: string, to: string) => `/admin/ai-executions?${new URLSearchParams({ model, from: day(from), to: day(to) })}`;

  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-4">
      <div>
        <h2 className="vb-app-section">Appels non chiffrés — détail</h2>
        <p className="text-xs text-[color:var(--text-muted)]">
          Ancienne règle du bandeau : {rc.legacyRuleCalls} appel(s) · coût réellement inconnu : {rc.effectiveUnknownCalls} ·
          coût connu arrondi à zéro (plus compté « sans tarif ») : {rc.zeroOrRoundedCalls} · déjà régularisés : {rc.alreadyCorrected}.
        </p>
      </div>

      <div className="space-y-1">
        {report.byCause.map((c) => (
          <div key={c.cause} className="text-sm">
            <button type="button" className="w-full flex flex-wrap items-baseline gap-x-3 text-left hover:bg-[color:var(--bg-hover)] rounded" onClick={() => setOpen(open === c.cause ? null : c.cause)}>
              <span className="flex-1 text-[color:var(--text-primary)]">{c.label}</span>
              <span className="text-[color:var(--text-secondary)]">{c.calls} appel(s)</span>
              <span className="text-xs text-[color:var(--text-muted)]">{c.regularizable} régularisable(s){c.reconstitutedMicros ? ` · ${usd(c.reconstitutedMicros)}` : ''}</span>
            </button>
            {open === c.cause && (
              <ul className="pl-4 text-xs text-[color:var(--text-muted)] space-y-0.5">
                {(report.samples[c.cause] ?? []).map((x) => (
                  <li key={x.id}>{new Date(x.at).toLocaleString('fr-FR')} · <span className="font-mono">{x.model ?? '—'}</span> · appel {x.id}
                    {x.traceId && <> · <Link className="text-[color:var(--accent)] hover:underline" href={`/admin/ai-executions?${new URLSearchParams({ model: x.model ?? '', from: day(x.at), to: day(x.at) })}`}>exécutions</Link></>}
                    {' '}— {x.detail}{x.notReconstitutable ? ` (non reconstituable : ${x.notReconstitutable})` : ''}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {report.byCause.length === 0 && <p className="text-sm text-[color:var(--text-muted)]">Aucun appel non chiffré sur la période.</p>}
      </div>

      {report.byModel.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Par modèle et cause</h3>
          <div className="space-y-0.5">
            {report.byModel.slice(0, 30).map((m) => (
              <Link key={`${m.model}-${m.cause}`} href={exec(m.model, m.firstAt, m.lastAt)} className="flex flex-wrap gap-x-3 text-xs hover:bg-[color:var(--bg-hover)] rounded">
                <span className="font-mono flex-1 min-w-[10rem] text-[color:var(--text-primary)]">{m.model}</span>
                <span className="text-[color:var(--text-secondary)]">{m.label}</span>
                <span className="text-[color:var(--text-muted)]">{m.calls} · {day(m.firstAt)} → {day(m.lastAt)} · tarif actuel {m.statusNow ?? '—'}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {report.rollups.rows > 0 && (
        <p className="text-xs text-[color:var(--text-muted)]">
          Agrégats journaliers d’appels supprimés (avant le lot 82C) : {report.rollups.rows} ligne(s), {report.rollups.unpricedCalls} appel(s) — régularisables : {report.rollups.regularizableCalls}. Traités à part, jamais additionnés aux appels en base.
        </p>
      )}

      <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-2">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Régularisation contrôlée</h3>
        <p className="text-xs text-[color:var(--text-muted)]">
          1. Simuler (rien n’est modifié) · 2. Exporter avant / après · 3. Appliquer une seule fois · 4. Annuler si besoin. Seul un tarif documenté
          à la date de l’appel est appliqué ; le coût initial de chaque trace reste intact ; les appels non reconstituables restent non chiffrés, avec leur raison.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: 'dry_run', since: report.period.since, until: report.period.until }, 'Simulation terminée.')}>
            <FlaskConical className="w-3.5 h-3.5 mr-1.5" /> Simuler sur la période
          </Button>
          {lastDry && (
            <>
              <a className="inline-flex items-center text-sm text-[color:var(--accent)] hover:underline" href={`/api/admin/ai/costs/regularization/${lastDry.id}/export`}>
                <Download className="w-3.5 h-3.5 mr-1" /> Export avant / après (simulation {lastDry.id})
              </a>
              {!applied(lastDry.id) && (
                <Button size="sm" disabled={busy} onClick={() => {
                  if (window.confirm(`Appliquer la simulation ${lastDry.id} : ${lastDry.summary?.regularize?.calls ?? 0} appel(s), ${usd(Number(lastDry.summary?.regularize?.micros ?? 0))} ? Application unique, annulable.`)) {
                    act({ action: 'apply', dryRunId: lastDry.id, confirm: true }, 'Régularisation appliquée.');
                  }
                }}><Play className="w-3.5 h-3.5 mr-1.5" /> Appliquer</Button>
              )}
            </>
          )}
          {lastApply && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
              const reason = window.prompt(`Annuler l’application ${lastApply.id} : motif`);
              if (reason && reason.trim().length >= 5) act({ action: 'revert', applyRunId: lastApply.id, reason }, 'Régularisation annulée : coûts initiaux rétablis.');
            }}><RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Annuler l’application {lastApply.id}</Button>
          )}
        </div>
        {lastDry && (
          <p className="text-xs text-[color:var(--text-secondary)]">
            Simulation {lastDry.id} ({day(lastDry.since)} → {day(lastDry.until)}) : {lastDry.summary?.regularize?.calls ?? 0} appel(s) régularisables
            ({usd(Number(lastDry.summary?.regularize?.micros ?? 0))}), {lastDry.summary?.keepUnpriced?.calls ?? 0} restent non chiffrés, {lastDry.summary?.noAction?.calls ?? 0} sans action.
          </p>
        )}
        <ul className="text-xs text-[color:var(--text-muted)] space-y-0.5">
          {runs.slice(0, 6).map((r) => <li key={r.id}>#{r.id} · {r.mode} · {r.status} · {new Date(r.started_at).toLocaleString('fr-FR')}{r.error_message ? ` · ${r.error_message}` : ''}</li>)}
        </ul>
      </div>
    </div>
  );
}
