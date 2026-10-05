'use client';

/**
 * Caches et export des métriques — CDC Assistant §32.6 (« consulter l'état
 * des caches », « invalider un cache », « exporter des métriques agrégées »),
 * §32.7 ; lot 23.
 *
 * Section repliée du tableau de bord IA, sous l'observabilité (aucune entrée
 * de menu) ; mêmes composants que le reste du BO : tableau, Button,
 * AlertDialog de confirmation, Input, Textarea.
 *
 *   · un cache par ligne : nature, version partagée, âge, volumes, dernière
 *     invalidation (date, auteur, motif) ; « Invalider » demande une
 *     confirmation et un motif, journalisés ; effet sur toutes les instances ;
 *   · export CSV des agrégats (période, filtres facultatifs) : aucun
 *     identifiant ni contenu de conversation.
 */
import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';

interface CacheState {
  id: string; label: string; nature: string; invalidation: string;
  version: number | null; versionUpdatedAt: string | null; versionReason: string | null;
  volume: Array<{ label: string; value: number | null }>;
  ageSeconds: number | null; details: string[];
  lastInvalidation: { at: string; admin: string; reason: string | null } | null;
}
interface Report { instance: string; generatedAt: string; caches: CacheState[]; notes: string[] }

const MOTIF_MIN = 5;
const TH = 'py-1 pr-3 font-medium';
const TD = 'py-1.5 pr-3 align-top';

function duree(s: number | null): string {
  if (s == null) return '—';
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} j`;
}

const jour = (d: Date) => d.toISOString().slice(0, 10);

export function CachesPanel() {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [cible, setCible] = useState<CacheState | null>(null);
  const [motif, setMotif] = useState('');
  const [busy, setBusy] = useState(false);
  const aujourdhui = new Date();
  const [periode, setPeriode] = useState({ from: jour(new Date(aujourdhui.getTime() - 29 * 86_400_000)), to: jour(aujourdhui) });
  const [filtres, setFiltres] = useState({ intent: '', model: '', promptVersion: '', plan: '' });
  const [export_, setExport] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await apiClient.get<Report>('/api/admin/ai/caches'));
    } catch (e) {
      toast.error((e as { message?: string }).message ?? 'État des caches indisponible.');
    } finally {
      setLoading(false);
    }
  }, []);

  const invalider = async () => {
    if (!cible) return;
    setBusy(true);
    try {
      const r = await apiClient.post<{ effect?: { rowsDeleted?: number; partial?: boolean } }>(
        '/api/admin/ai/caches', { cacheId: cible.id, reason: motif.trim() },
      );
      if (r.effect?.partial) {
        toast.warning(`${cible.label} : invalidation PARTIELLE (${r.effect.rowsDeleted ?? 0} lignes supprimées, délai atteint) — relancer pour terminer.`);
      } else {
        toast.success(`${cible.label} : invalidé sur toutes les instances.`);
      }
      setCible(null);
      setMotif('');
      await load();
    } catch (e) {
      toast.error((e as { message?: string }).message ?? 'Invalidation refusée.');
    } finally {
      setBusy(false);
    }
  };

  const exporter = async () => {
    setExport(true);
    try {
      const qs = new URLSearchParams(periode);
      for (const [k, v] of Object.entries(filtres)) if (v.trim()) qs.set(k, v.trim());
      const res = await fetch(`/api/admin/ai/metrics-export?${qs}`, { credentials: 'include' });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(err?.message ?? `Export refusé (${res.status}).`);
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `verebona-metriques-ia_${periode.from}_${periode.to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error((e as Error).message || 'Export impossible.');
    } finally {
      setExport(false);
    }
  };

  return (
    <details
      className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3"
      onToggle={(e) => {
        const o = (e.target as HTMLDetailsElement).open;
        setOpen(o);
        if (o && !report) void load();
      }}
      data-testid="ai-caches"
    >
      <summary className="cursor-pointer text-sm font-semibold text-[color:var(--text-primary)]">
        Caches et export des métriques
      </summary>

      {open && (
        <div className="space-y-5 pt-3">
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">État des caches</h3>
              <Button size="sm" variant="outline" onClick={load} disabled={loading}>
                {loading && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />} Actualiser
              </Button>
            </div>
            {!report ? (
              <p className="text-xs text-[color:var(--text-muted)]">Chargement…</p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[color:var(--text-muted)]">
                        <th className={TH}>Cache</th><th className={TH}>Version</th><th className={TH}>Âge</th>
                        <th className={TH}>Volume</th><th className={TH}>Dernière invalidation</th><th className={TH} />
                      </tr>
                    </thead>
                    <tbody>
                      {report.caches.map((c) => (
                        <tr key={c.id} className="border-t border-[color:var(--border-subtle)] text-[color:var(--text-primary)]">
                          <td className={`${TD} min-w-[260px]`}>
                            <p>{c.label}</p>
                            <p className="text-[color:var(--text-muted)]">{c.nature}</p>
                            {c.details.map((d, i) => <p key={i} className="text-[color:var(--text-muted)]">{d}</p>)}
                          </td>
                          <td className={TD}>
                            {c.version ?? '—'}
                            {c.versionUpdatedAt && <p className="text-[color:var(--text-muted)]">{formatDateTime(c.versionUpdatedAt)}</p>}
                          </td>
                          <td className={TD}>{duree(c.ageSeconds)}</td>
                          <td className={TD}>
                            {c.volume.length === 0 ? '—' : c.volume.map((v) => (
                              <p key={v.label}>{v.value == null ? '—' : v.value.toLocaleString('fr-FR')} <span className="text-[color:var(--text-muted)]">{v.label}</span></p>
                            ))}
                          </td>
                          <td className={TD}>
                            {c.lastInvalidation ? (
                              <>
                                <p>{formatDateTime(c.lastInvalidation.at)} · {c.lastInvalidation.admin}</p>
                                {c.lastInvalidation.reason && <p className="text-[color:var(--text-muted)]">{c.lastInvalidation.reason}</p>}
                              </>
                            ) : '—'}
                          </td>
                          <td className={`${TD} text-right`}>
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => { setCible(c); setMotif(''); }}>
                              Invalider
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {report.notes.map((n, i) => <p key={i} className="text-xs text-[color:var(--text-muted)]">{n}</p>)}
                <p className="text-xs text-[color:var(--text-muted)]">
                  Instance : {report.instance} · {formatDateTime(report.generatedAt)}
                </p>
              </>
            )}
          </section>

          <section className="space-y-2 border-t border-[color:var(--border-subtle)] pt-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Export des métriques agrégées (CSV)</h3>
            <p className="text-xs text-[color:var(--text-muted)]">
              Demandes de l’assistant (intention, mode, statut), appels modèle (alias, modèle, version de prompt), usage IA par
              traitement et par offre — par jour. Aucun identifiant ni contenu de conversation ; chaque export est journalisé.
            </p>
            <p className="text-xs text-[color:var(--text-muted)]">
              Filtres : intention → demandes et appels modèle ; modèle et offre → les trois sections ; version de prompt (version du
              prompt maître) → usage par offre seulement. Un groupe de moins de 5 comptes perd son libellé (« &lt; 5 comptes ») ;
              avec un filtre d’offre, il est retiré. La dernière ligne du fichier indique une éventuelle troncature.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-[color:var(--text-muted)] space-y-1">
                <span className="block">Du</span>
                <Input type="date" className="w-40" value={periode.from} onChange={(e) => setPeriode((p) => ({ ...p, from: e.target.value }))} />
              </label>
              <label className="text-xs text-[color:var(--text-muted)] space-y-1">
                <span className="block">Au</span>
                <Input type="date" className="w-40" value={periode.to} onChange={(e) => setPeriode((p) => ({ ...p, to: e.target.value }))} />
              </label>
              {([
                ['intent', 'Intention'], ['model', 'Modèle'], ['promptVersion', 'Version de prompt'], ['plan', 'Offre'],
              ] as const).map(([k, l]) => (
                <label key={k} className="text-xs text-[color:var(--text-muted)] space-y-1">
                  <span className="block">{l} (facultatif)</span>
                  <Input className="w-40" value={filtres[k]} onChange={(e) => setFiltres((f) => ({ ...f, [k]: e.target.value }))} />
                </label>
              ))}
              <Button size="sm" onClick={exporter} disabled={export_ || !periode.from || !periode.to}>
                {export_ && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />} Exporter (CSV)
              </Button>
            </div>
          </section>
        </div>
      )}

      <AlertDialog open={cible !== null} onOpenChange={(o) => { if (!busy && !o) setCible(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Invalider « {cible?.label} » ?</AlertDialogTitle>
            <AlertDialogDescription>
              {cible?.invalidation} L’opération est journalisée (auteur, date, motif).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={motif}
            onChange={(e) => setMotif(e.target.value)}
            placeholder="Motif (obligatoire)"
            aria-label="Motif de l’invalidation"
            maxLength={500}
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || motif.trim().length < MOTIF_MIN}
              onClick={(e) => { e.preventDefault(); void invalider(); }}
            >
              {busy && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />} Invalider
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </details>
  );
}
