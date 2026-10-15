'use client';

/**
 * Lancement manuel batch — CDC BO IA WF-11, T1-UI-12, T3-UI-08, T4-UI-07
 * (lot IA 2).
 *
 * Trois temps, comme le WF-11 : choisir le périmètre (comptes ou tout),
 * afficher l'estimation, confirmer. La confirmation reprend l'estimation : on
 * ne lance pas « à l'aveugle » une réanalyse de milliers de documents.
 * T4 force un nouveau passage sur les échéances candidates des analyses T1
 * de référence (T4-016, T4-UI-07), sans réanalyser les documents.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Play } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';

type Launchable = 'T1' | 'T3' | 'T4';

interface Estimate {
  objects: number;
  accounts: number;
  waitsForReactivation: boolean;
  /** Lot 52A : comptes demandés hors périmètre (ni bien actif ni « À traiter » ouvert pour T3). */
  excludedAccountIds?: number[];
}

const LIBELLES: Record<Launchable, string> = {
  T1: 'T1 — réanalyse des documents (non facturée au compte)',
  T3: 'T3 — contrôle complet de cohérence des comptes',
  T4: 'T4 — nouveau passage sur les échéances candidates (sans réanalyse)',
};

/**
 * `onLaunched(ids)` : identifiants des jobs RÉELLEMENT créés (lot 52A, COR-02 /
 * COR-03) — l'écran les affiche aussitôt, quels que soient ses filtres.
 */
export function ManualLaunch({ onLaunched }: { onLaunched: (jobIds: number[]) => void | Promise<void> }) {
  const [treatment, setTreatment] = useState<Launchable>('T3');
  const [all, setAll] = useState(false);
  const [accounts, setAccounts] = useState('');
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState(false);

  const body = () => (all
    ? { all: true }
    : { accountIds: accounts.split(/[\s,;]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0) });

  const estimer = async () => {
    setBusy(true);
    try {
      setEstimate(await apiClient.post<Estimate>(`/api/admin/ai/treatments/${treatment}/launch`, { ...body(), dryRun: true }));
    } catch (e) {
      toast.error((e as Error).message || 'Estimation impossible.');
    } finally { setBusy(false); }
  };

  const lancer = async () => {
    setBusy(true);
    try {
      const r = await apiClient.post<Estimate & { jobIds: number[]; refused?: number }>(`/api/admin/ai/treatments/${treatment}/launch`, body());
      // Lot 52A (COR-02) : jamais de réussite annoncée sans job créé (le
      // serveur refuse alors avec un motif — branche d'erreur ci-dessous).
      if (!Array.isArray(r.jobIds) || r.jobIds.length === 0) {
        toast.error('Aucun job n’a été créé.');
        return;
      }
      const premiers = r.jobIds.slice(0, 5).map((id) => `#${id}`).join(', ');
      toast.success(`${r.jobIds.length} job(s) ${treatment} créé(s) : ${premiers}${r.jobIds.length > 5 ? '…' : ''}`
        + (r.waitsForReactivation ? ' — ils démarreront à la réactivation du traitement.' : '.')
        + (r.refused ? ` ${r.refused} demande(s) refusée(s) par le contrôle de périmètre.` : '')
        + (r.excludedAccountIds?.length ? ` Comptes non retenus : ${r.excludedAccountIds.join(', ')}.` : ''));
      setEstimate(null);
      await onLaunched(r.jobIds);
    } catch (e) {
      // Lot 54A : code et motif du serveur (EMPTY_SCOPE, NO_JOB_CREATED, INSERT_FAILED…), jamais un succès.
      const err = e as { message?: string; code?: string; status?: number };
      toast.error(`${err.message || 'Lancement impossible.'}${err.code ? ` (${err.code}${err.status ? ` — ${err.status}` : ''})` : ''}`);
      setEstimate(null);
      await onLaunched([]);
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">Lancement manuel</h2>
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <select
          value={treatment}
          onChange={(e) => setTreatment(e.target.value as Launchable)}
          className="h-9 rounded-md border border-[color:var(--border-subtle)] bg-transparent px-2 text-sm"
          aria-label="Traitement"
        >
          {(Object.keys(LIBELLES) as Launchable[]).map((t) => <option key={t} value={t}>{LIBELLES[t]}</option>)}
        </select>
        <Input
          value={accounts}
          onChange={(e) => setAccounts(e.target.value)}
          placeholder="Identifiants de comptes (ex. 12, 57)"
          disabled={all}
          className="sm:max-w-xs"
        />
        <label className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          Tout le périmètre
        </label>
        <Button size="sm" onClick={estimer} disabled={busy || (!all && accounts.trim() === '')}>
          <Play className="w-3.5 h-3.5 mr-1.5" /> Estimer et lancer
        </Button>
      </div>
      <p className="text-xs text-[color:var(--text-muted)]">
        Chaque lancement crée une nouvelle exécution, identifiée « manuelle », même si une exécution
        automatique équivalente attend. T4 repasse sur les échéances candidates des dernières
        analyses T1 des documents du périmètre, sans les réanalyser.
      </p>

      <Dialog open={estimate !== null} onOpenChange={(o) => !o && setEstimate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmer le lancement {treatment}</DialogTitle>
            <DialogDescription>
              {estimate && (
                <>
                  {estimate.objects} {treatment === 'T3' ? 'compte(s)' : 'document(s)'} sur {estimate.accounts} compte(s).
                  {estimate.waitsForReactivation && ` ${treatment} est actuellement coupé : les exécutions attendront sa réactivation.`}
                  {estimate.excludedAccountIds && estimate.excludedAccountIds.length > 0
                    && ` Comptes non retenus (${treatment === 'T3' ? 'ni bien actif ni « À traiter » ouvert' : 'aucun objet à traiter'}) : ${estimate.excludedAccountIds.join(', ')}.`}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setEstimate(null)}>Revenir</Button>
            <Button onClick={lancer} disabled={busy || (estimate?.objects ?? 0) === 0}>Lancer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
