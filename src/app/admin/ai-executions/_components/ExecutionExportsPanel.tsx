"use client";

/**
 * Exports des exécutions IA — lot 84D (CDC Pilotage IA V2 P3 : EXP-01 à
 * EXP-05, R27, R28, R63, R64 ; décision PO 15).
 *
 *   · « Exporter » : les exécutions du JOURNAL FILTRÉ (mêmes paramètres que
 *     la liste et les cartes : mêmes exécutions), génération EN TÂCHE DE FOND
 *     (le BO reste utilisable), fichiers stockés ; option « avec contenus des
 *     échanges » proposée seulement à un administrateur habilité
 *     (`AI_MODEL_OUTPUT_ADMIN_IDS`, revérifié côté serveur) ;
 *   · suivi des générations : statut, exécutions écrites, signe de vie ;
 *     une génération interrompue se REPREND à son dernier point de reprise ;
 *   · une fois terminée : volumes ZIP (fractionnés, index commun), fichiers
 *     JSONL compressés, manifeste.
 * Desktop et mobile : lignes qui s'enroulent, boutons qui passent à la ligne.
 */
import { useCallback, useEffect, useState } from 'react';
import { Download, Loader2, Play, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import type { ExecutionsManifest } from '@/services/ai/business-execution/export-model';

interface ExportGeneration {
  id: string;
  status: 'RUNNING' | 'COMPLETE' | 'PARTIAL' | 'FAILED';
  interrupted: boolean;
  rowsExpected: number | null;
  rowsExported: number | null;
  files: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  heartbeatAt: string | null;
  perimeter: Record<string, unknown>;
}

interface ExportDetail {
  manifest: ExecutionsManifest | null;
  downloadables: string[];
  resumable: boolean;
  resume: { cursorAt: string; partsWritten: number; executionsWritten: number; done: boolean; resumes: number } | null;
}

const STATUS: Record<string, string> = { RUNNING: 'en cours', COMPLETE: 'complet', PARTIAL: 'partiel', FAILED: 'en échec' };
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : '—');
const base = (id: string) => `/api/admin/ai/business-executions/exports/${id}`;

/** Rendu pur d'une génération (suivi, reprise, téléchargements). */
export function ExportGenerationView({ g, detail, onResume, busy }: { g: ExportGeneration; detail: ExportDetail | null; onResume?: () => void; busy?: boolean }) {
  const label = g.interrupted ? 'interrompue' : STATUS[g.status] ?? g.status;
  const tone = g.status === 'COMPLETE' ? 'text-[color:var(--text-success)]' : g.status === 'RUNNING' && !g.interrupted ? 'text-[color:var(--text-secondary)]'
    : g.status === 'PARTIAL' ? 'text-[color:var(--text-warning-soft)]' : 'text-[color:var(--text-danger)]';
  const m = detail?.manifest ?? null;
  return (
    <li className="p-3 space-y-1.5 text-xs min-w-0" data-testid="export-generation">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={`font-medium ${tone}`} data-testid="export-status">{label}</span>
        <span className="text-[color:var(--text-secondary)]">lancé le {fmt(g.startedAt)}</span>
        <span className="text-[color:var(--text-muted)]">{(g.rowsExported ?? 0).toLocaleString('fr-FR')} exécution(s) écrite(s){g.rowsExpected !== null ? ` sur ${g.rowsExpected.toLocaleString('fr-FR')}` : ''}</span>
        <span className="text-[color:var(--text-muted)] break-all">{Object.entries(g.perimeter).map(([k, v]) => `${k}=${String(v)}`).join(' · ')}</span>
      </p>
      {g.error && <p className="text-[color:var(--text-danger)] break-words">{g.error}</p>}
      {detail?.resumable && onResume && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onResume} disabled={busy} data-testid="export-resume">
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Reprendre la génération
          </Button>
          {detail.resume && (
            <span className="text-[color:var(--text-muted)]">
              reprise après {detail.resume.partsWritten} partie(s) écrite(s), à partir du {fmt(detail.resume.cursorAt)} — sans doublon ni perte
            </span>
          )}
        </div>
      )}
      {m && (
        <div className="space-y-1" data-testid="export-downloads">
          <p className="text-[color:var(--text-secondary)] break-words">
            Manifeste : {m.status} · {m.totals.executions.exported} / {m.totals.executions.expected} exécution(s) · {m.totals.calls.exported} appel(s)
            {' · '}cartes : {m.totals.cards.failed} échec(s), {m.totals.cards.incomplete} incomplète(s){m.resumes.length ? ` · ${m.resumes.length} reprise(s)` : ''}
          </p>
          <div className="flex flex-wrap gap-2">
            {m.volumes.map((v) => (
              <a key={v.index} href={`${base(g.id)}/download?volume=${v.index}`} className="inline-flex items-center gap-1 text-[color:var(--accent)] hover:underline" data-testid="export-volume">
                <Download className="w-3.5 h-3.5" /> ZIP {v.index}/{m.volumes.length}
              </a>
            ))}
            <a href={`${base(g.id)}/download?path=manifeste.json`} className="inline-flex items-center gap-1 text-[color:var(--accent)] hover:underline">
              <Download className="w-3.5 h-3.5" /> manifeste.json
            </a>
          </div>
          <details>
            <summary className="cursor-pointer text-[color:var(--text-muted)]">Fichiers JSONL ({detail!.downloadables.length})</summary>
            <ul className="mt-1 space-y-0.5">
              {detail!.downloadables.map((p) => (
                <li key={p}><a href={`${base(g.id)}/download?path=${encodeURIComponent(p)}`} className="text-[color:var(--accent)] hover:underline break-all">{p}</a></li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </li>
  );
}

/** Lancement et suivi des exports (le journal filtré courant est passé en paramètres). */
export function ExecutionExportsPanel({ params, summary }: { params: URLSearchParams; summary: string }) {
  const [gens, setGens] = useState<ExportGeneration[] | null>(null);
  const [canSensitive, setCanSensitive] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<Record<string, ExportDetail>>({});

  const load = useCallback(async () => {
    try {
      const r = await apiClient.get<{ items: ExportGeneration[]; canIncludeSensitiveContent: boolean }>('/api/admin/ai/business-executions/exports?pageSize=5');
      setGens(r.items);
      setCanSensitive(r.canIncludeSensitiveContent);
      const ds = await Promise.all(r.items.map((g) => apiClient.get<ExportDetail>(base(g.id)).then((d) => [g.id, d] as const).catch(() => null)));
      setDetails(Object.fromEntries(ds.filter((x): x is readonly [string, ExportDetail] => x !== null)));
    } catch {
      setGens([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // Suivi d'une génération en cours, sans bloquer l'écran.
  useEffect(() => {
    if (!gens?.some((g) => g.status === 'RUNNING' && !g.interrupted)) return;
    const t = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(t);
  }, [gens, load]);

  const lancer = async () => {
    setBusy(true);
    try {
      await apiClient.post('/api/admin/ai/business-executions/exports', { ...Object.fromEntries(params), contenusSensibles: sensitive });
      toast.success('Export lancé : génération en tâche de fond.');
      await load();
    } catch (e) {
      toast.error((e as Error).message || 'Export impossible.');
    } finally { setBusy(false); }
  };
  const reprendre = async (id: string) => {
    setBusy(true);
    try {
      await apiClient.post(base(id), { action: 'resume' });
      toast.success('Génération reprise à son dernier point de reprise.');
      await load();
    } catch (e) {
      toast.error((e as Error).message || 'Reprise impossible.');
    } finally { setBusy(false); }
  };

  return (
    <section className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3" data-testid="execution-exports">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="vb-app-section mr-auto">Exports</h2>
        {canSensitive && (
          <label className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
            <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} data-testid="export-sensitive" />
            avec contenus des échanges
          </label>
        )}
        <Button size="sm" onClick={() => void lancer()} disabled={busy} data-testid="export-launch">
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Play className="w-3.5 h-3.5 mr-1.5" />} Exporter le journal filtré
        </Button>
      </div>
      <p className="text-xs text-[color:var(--text-muted)] break-words">
        Périmètre : {summary}. Mêmes exécutions que les cartes et la liste ; réussites comprises ; JSONL compressé, volumes ZIP, manifeste (attendu / exporté, SHA-256).
      </p>
      {gens === null
        ? <p className="text-sm text-[color:var(--text-muted)]">Chargement…</p>
        : gens.length === 0
          ? <p className="text-sm text-[color:var(--text-muted)]">Aucun export récent.</p>
          : (
            <ul className="divide-y divide-[color:var(--border-subtle)] rounded-lg border border-[color:var(--border-subtle)]">
              {gens.map((g) => <ExportGenerationView key={g.id} g={g} detail={details[g.id] ?? null} onResume={() => void reprendre(g.id)} busy={busy} />)}
            </ul>
          )}
    </section>
  );
}
