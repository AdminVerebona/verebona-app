"use client";

/**
 * Admin — File d'attente IA — CDC BO IA SCR-08.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE CRITÈRE D'ACCEPTATION EST « POURQUOI CET ITEM N'AVANCE PAS »
 *
 * Tout l'écran est construit autour de lui. Un travail peut stagner pour cinq
 * raisons, et seule leur distinction permet d'agir :
 *
 *   · le traitement est désactivé — quelqu'un l'a coupé ;
 *   · le traitement est suspendu — le disjoncteur s'est ouvert ;
 *   · l'arrêt d'urgence est engagé — tout l'environnement est bloqué ;
 *   · le travail attend sa reprise après échec — la date est connue ;
 *   · il attend simplement son tour — la file est longue.
 *
 * Afficher « en attente » sans dire laquelle obligerait l'administrateur à
 * ouvrir trois autres écrans pour comprendre. La raison est donc calculée par
 * ligne et affichée en clair.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE L'ÉCRAN NE PROPOSE PAS
 *
 * Aucune priorité manuelle : le §1.4 l'exclut de la V1, et l'offrir ici
 * créerait une attente que le serveur ne sait pas honorer. La tête de file est
 * signalée, jamais attribuée à la main.
 */

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Loader2, RefreshCw, OctagonX, Play, Pause, ArrowUp, XCircle, Clock,
} from 'lucide-react';
import { toast } from 'sonner';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { apiClient } from '@/lib/api-client';

type Treatment = 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
type JobStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';
type TreatmentState = 'ENABLED' | 'DISABLED' | 'SUSPENDED';

interface Job {
  id: number;
  treatment: Treatment;
  accountId: number | null;
  targetType: string | null;
  targetId: string | null;
  status: JobStatus;
  origin: 'automatic' | 'manual';
  triggerCode: string | null;
  attempts: number;
  lastError: string | null;
  availableAt: string;
  coalesceRequested: boolean;
  headPriority: boolean;
  createdAt: string;
}

interface Summary { treatment: Treatment; pending: number; running: number; failed: number }
interface StateRow {
  treatment: Treatment; state: TreatmentState;
  suspendedReason: string | null; suspendedAt: string | null; nextProbeAt: string | null;
}
interface Overview {
  summary: Summary[];
  states: StateRow[];
  emergencyStop: { active: boolean; reason: string | null; engagedAt: string | null };
}

const STATUS_LABEL: Record<JobStatus, string> = {
  PENDING: 'En attente', RUNNING: 'En cours', DONE: 'Terminé',
  FAILED: 'Échec', CANCELLED: 'Annulé',
};

const STATUS_STYLE: Record<JobStatus, string> = {
  PENDING: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
  RUNNING: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
  DONE: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  FAILED: 'bg-red-500/10 text-red-400 border-red-500/20',
  CANCELLED: 'bg-[color:var(--bg-page)] text-[color:var(--text-muted)] border-[color:var(--border-subtle)]',
};

const STATE_LABEL: Record<TreatmentState, string> = {
  ENABLED: 'Actif', DISABLED: 'Désactivé', SUSPENDED: 'Suspendu',
};

/**
 * Pourquoi ce travail n'avance pas — le critère d'acceptation du SCR-08.
 *
 * L'ordre des causes suit leur portée : l'arrêt d'urgence bloque tout, un
 * traitement coupé bloque sa file, une reprise différée ne concerne qu'un
 * travail. Afficher la plus large d'abord évite de faire chercher un problème
 * de travail là où c'est l'environnement entier qui est arrêté.
 */
function stagnationReason(job: Job, overview: Overview | null): string | null {
  if (job.status !== 'PENDING') return null;
  if (!overview) return null;

  if (overview.emergencyStop.active) {
    return 'Arrêt d’urgence engagé : aucun traitement ne démarre.';
  }

  const state = overview.states.find((s) => s.treatment === job.treatment);
  if (state?.state === 'DISABLED') {
    return `${job.treatment} est désactivé : la file se remplit sans être servie.`;
  }
  if (state?.state === 'SUSPENDED') {
    const probe = state.nextProbeAt
      ? ` Prochaine tentative de reprise à ${new Date(state.nextProbeAt).toLocaleTimeString('fr-FR')}.`
      : '';
    return `${job.treatment} est suspendu${state.suspendedReason ? ` : ${state.suspendedReason}` : ''}.${probe}`;
  }

  const available = new Date(job.availableAt);
  if (available.getTime() > Date.now()) {
    return `Reprise après échec prévue à ${available.toLocaleTimeString('fr-FR')}`
      + ` (tentative ${job.attempts + 1}).`;
  }

  return null;
}

function targetLabel(job: Job): string {
  const parts: string[] = [];
  if (job.accountId) parts.push(`compte ${job.accountId}`);
  if (job.targetType) parts.push(`${job.targetType}${job.targetId ? ` ${job.targetId}` : ''}`);
  return parts.length > 0 ? parts.join(' · ') : 'périmètre global';
}

export default function AiQueuePage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filterTreatment, setFilterTreatment] = useState('');
  const [filterStatus, setFilterStatus] = useState('PENDING');
  const [filterAccount, setFilterAccount] = useState('');
  const [cancelling, setCancelling] = useState<Job | null>(null);
  const [stopDialog, setStopDialog] = useState(false);
  const [stopReason, setStopReason] = useState('');

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filterTreatment) params.set('treatment', filterTreatment);
      if (filterStatus) params.set('status', filterStatus);
      if (/^\d+$/.test(filterAccount)) params.set('accountId', filterAccount);

      const [o, j] = await Promise.all([
        apiClient.get<Overview>('/api/admin/ai/queue'),
        apiClient.get<{ jobs: Job[] }>(`/api/admin/ai/queue/jobs?${params}`),
      ]);
      setOverview(o);
      setJobs(j.jobs);
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
  }, [filterTreatment, filterStatus, filterAccount]);

  useEffect(() => { load(); }, [load]);

  const toggleTreatment = async (t: Treatment, enabled: boolean) => {
    setBusy(true);
    try {
      await apiClient.post('/api/admin/ai/treatments', { treatment: t, enabled });
      toast.success(enabled ? `${t} réactivé` : `${t} désactivé`);
      await load();
    } catch {
      toast.error("Le changement d'état n'a pas abouti.");
    } finally { setBusy(false); }
  };

  const toggleStop = async (active: boolean) => {
    setBusy(true);
    try {
      await apiClient.post('/api/admin/ai/queue/emergency-stop',
        active ? { active: true, reason: stopReason } : { active: false });
      toast.success(active ? 'Arrêt d’urgence engagé' : 'Arrêt d’urgence relâché');
      setStopDialog(false);
      setStopReason('');
      await load();
    } catch {
      toast.error("L'arrêt d'urgence n'a pas pu être modifié.");
    } finally { setBusy(false); }
  };

  const cancel = async (job: Job) => {
    setBusy(true);
    try {
      await apiClient.post(`/api/admin/ai/queue/jobs/${job.id}/cancel`, {});
      toast.success('Travail annulé');
      setCancelling(null);
      await load();
    } catch {
      // Le serveur refuse un travail démarré plutôt que de simuler l'annulation.
      toast.error('Ce travail a déjà démarré : il ne peut plus être annulé.');
      setCancelling(null);
      await load();
    } finally { setBusy(false); }
  };

  if (erreur) {
    return <EcranEnErreur titre="File d'attente indisponible" message={erreur} onRetry={load} />;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-[color:var(--text-muted)]">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Chargement…
      </div>
    );
  }

  const stop = overview?.emergencyStop;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[color:var(--text-primary)]">File d&apos;attente IA</h1>
          <p className="text-sm text-[color:var(--text-muted)]">
            Travaux par lots des traitements T1, T3 et T4.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={load} disabled={busy}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Actualiser
        </Button>
      </div>

      {stop?.active && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 flex items-start gap-3">
          <OctagonX className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-red-400">Arrêt d&apos;urgence engagé</p>
            <p className="text-sm text-[color:var(--text-secondary)]">
              {stop.reason ?? 'Aucun motif renseigné.'}
              {stop.engagedAt && ` — depuis le ${new Date(stop.engagedAt).toLocaleString('fr-FR')}`}
            </p>
            <p className="text-xs text-[color:var(--text-muted)] mt-1">
              Les traitements retrouveront leur état précédent au relâchement.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => toggleStop(false)} disabled={busy}>
            Relâcher
          </Button>
        </div>
      )}

      {/* Résumé et états — SCR-08, zone « Résumé » */}
      <div className="grid gap-3 sm:grid-cols-3">
        {overview?.states.filter((s) => ['T1', 'T3', 'T4'].includes(s.treatment)).map((s) => {
          const sum = overview.summary.find((x) => x.treatment === s.treatment);
          return (
            <div key={s.treatment}
              className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-[color:var(--text-primary)]">{s.treatment}</span>
                <span className={`text-xs ${s.state === 'ENABLED' ? 'text-emerald-500'
                  : s.state === 'SUSPENDED' ? 'text-amber-500' : 'text-[color:var(--text-muted)]'}`}>
                  {STATE_LABEL[s.state]}
                </span>
              </div>
              <p className="text-sm text-[color:var(--text-secondary)]">
                {sum?.pending ?? 0} en attente · {sum?.running ?? 0} en cours · {sum?.failed ?? 0} en échec
              </p>
              {s.state === 'SUSPENDED' && s.suspendedReason && (
                <p className="text-xs text-amber-500">{s.suspendedReason}</p>
              )}
              <Button size="sm" variant="ghost" disabled={busy || s.state === 'SUSPENDED'}
                onClick={() => toggleTreatment(s.treatment, s.state !== 'ENABLED')}>
                {s.state === 'ENABLED'
                  ? <><Pause className="w-3.5 h-3.5 mr-1.5" /> Désactiver</>
                  : <><Play className="w-3.5 h-3.5 mr-1.5" /> Réactiver</>}
              </Button>
            </div>
          );
        })}
      </div>

      {/* Filtres — SCR-08, NFR-001 */}
      <div className="flex flex-wrap gap-2">
        <select value={filterTreatment} onChange={(e) => setFilterTreatment(e.target.value)}
          className="rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-input)] px-3 py-2 text-sm text-[color:var(--text-primary)]">
          <option value="">Tous les traitements</option>
          {['T1', 'T3', 'T4'].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
          className="rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-input)] px-3 py-2 text-sm text-[color:var(--text-primary)]">
          <option value="">Tous les statuts</option>
          {(Object.keys(STATUS_LABEL) as JobStatus[]).map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </select>
        <Input placeholder="Compte" value={filterAccount} inputMode="numeric"
          onChange={(e) => setFilterAccount(e.target.value)}
          className="max-w-[140px] bg-[color:var(--bg-input)]" />
      </div>

      {/* Liste */}
      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] divide-y divide-[color:var(--border-subtle)]">
        {jobs.length === 0 && (
          <p className="p-6 text-sm text-[color:var(--text-muted)]">
            Aucun travail ne correspond à ces filtres.
          </p>
        )}
        {jobs.map((job) => {
          const reason = stagnationReason(job, overview);
          return (
            <div key={job.id} className="px-4 py-3 space-y-1.5">
              <div className="flex items-center gap-3">
                {job.headPriority && (
                  <ArrowUp className="w-3.5 h-3.5 text-amber-500 shrink-0" aria-label="remis en tête" />
                )}
                <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_STYLE[job.status]}`}>
                  {STATUS_LABEL[job.status]}
                </span>
                <span className="text-sm text-[color:var(--text-primary)]">{job.treatment}</span>
                <span className="text-sm text-[color:var(--text-secondary)] flex-1 truncate">
                  {targetLabel(job)}
                </span>
                {job.origin === 'manual' && (
                  <span className="text-xs text-[color:var(--text-muted)]">lancé à la main</span>
                )}
                {job.status === 'PENDING' && (
                  <Button size="sm" variant="ghost" onClick={() => setCancelling(job)} disabled={busy}>
                    <XCircle className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>

              {reason && (
                <p className="text-xs text-amber-500 flex items-start gap-1.5">
                  <Clock className="w-3 h-3 mt-0.5 shrink-0" /> {reason}
                </p>
              )}
              {job.coalesceRequested && (
                <p className="text-xs text-[color:var(--text-muted)]">
                  Un passage supplémentaire est prévu à la fin de celui-ci.
                </p>
              )}
              {job.lastError && job.status !== 'PENDING' && (
                <p className="text-xs text-[color:var(--text-muted)] truncate">{job.lastError}</p>
              )}
              {job.attempts > 1 && (
                <p className="text-xs text-[color:var(--text-muted)]">
                  {job.attempts} tentatives
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex justify-end">
        {!stop?.active && (
          <Button size="sm" variant="destructive" onClick={() => setStopDialog(true)} disabled={busy}>
            <OctagonX className="w-3.5 h-3.5 mr-1.5" /> Arrêt d&apos;urgence
          </Button>
        )}
      </div>

      <Dialog open={cancelling !== null} onOpenChange={(o) => !o && setCancelling(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Annuler ce travail</DialogTitle>
            <DialogDescription>
              {cancelling && `${cancelling.treatment} · ${targetLabel(cancelling)}`}
              {' — '}l&apos;annulation est définitive. Le travail ne sera pas replanifié.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setCancelling(null)}>Revenir</Button>
            <Button variant="destructive" onClick={() => cancelling && cancel(cancelling)}>
              Annuler le travail
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={stopDialog} onOpenChange={setStopDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Engager l&apos;arrêt d&apos;urgence</DialogTitle>
            <DialogDescription>
              Tous les appels IA de cet environnement s&apos;arrêtent. Les exécutions en cours
              reviennent en tête de file et reprendront depuis le début au relâchement.
              Les traitements déjà désactivés le resteront.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Motif — la personne qui relâchera en aura besoin"
            value={stopReason}
            onChange={(e) => setStopReason(e.target.value)}
            className="bg-[color:var(--bg-input)]"
          />
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setStopDialog(false)}>Revenir</Button>
            <Button variant="destructive" disabled={stopReason.trim() === ''}
              onClick={() => toggleStop(true)}>
              Engager l&apos;arrêt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
