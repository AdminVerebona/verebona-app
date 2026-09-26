'use client';

/**
 * Lancement manuel batch — CDC BO IA WF-11, T1-UI-12, T3-UI-08, T4-UI-07
 * (lot IA 2).
 *
 * Trois temps, comme le WF-11 : choisir le périmètre (comptes ou tout),
 * afficher l'estimation, confirmer. La confirmation reprend l'estimation : on
 * ne lance pas « à l'aveugle » une réanalyse de milliers de documents.
 * T4 n'est pas proposé seul (ses entrées viennent de T1) : l'écran le dit.
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

type Launchable = 'T1' | 'T3';

interface Estimate {
  objects: number;
  accounts: number;
  waitsForReactivation: boolean;
}

const LIBELLES: Record<Launchable, string> = {
  T1: 'T1 — réanalyse des documents (non facturée au compte)',
  T3: 'T3 — contrôle complet de cohérence des comptes',
};

export function ManualLaunch({ onLaunched }: { onLaunched: () => void | Promise<void> }) {
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
      const r = await apiClient.post<Estimate & { jobIds: number[] }>(`/api/admin/ai/treatments/${treatment}/launch`, body());
      toast.success(`${r.jobIds.length} exécution(s) manuelle(s) ${treatment} mise(s) en file`
        + (r.waitsForReactivation ? ' — elles démarreront à la réactivation du traitement.' : '.'));
      setEstimate(null);
      await onLaunched();
    } catch (e) {
      toast.error((e as Error).message || 'Lancement impossible.');
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
        automatique équivalente attend. T4 se relance par une réanalyse T1 du même périmètre.
      </p>

      <Dialog open={estimate !== null} onOpenChange={(o) => !o && setEstimate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmer le lancement {treatment}</DialogTitle>
            <DialogDescription>
              {estimate && (
                <>
                  {estimate.objects} {treatment === 'T1' ? 'document(s)' : 'compte(s)'} sur {estimate.accounts} compte(s).
                  {estimate.waitsForReactivation && ` ${treatment} est actuellement coupé : les exécutions attendront sa réactivation.`}
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
