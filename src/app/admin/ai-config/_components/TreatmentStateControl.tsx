"use client";

/**
 * Contrôle d'état opérationnel d'un traitement — CDC BO IA WF-07, OPS-008,
 * OPS-027, T1-UI-01, T2-UI-01, T3-UI-01, T4-UI-01.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DANS L'ONGLET DU TRAITEMENT, PAS SEULEMENT DANS LA PAGE FILE
 *
 * Le WF-07 commence par « Cliquer Désactiver dans l'onglet traitement ». Le
 * toggle n'existait que sur `/admin/ai-queue`, et seulement pour T1/T3/T4 :
 * aucun moyen de couper T2, T5 ou T6. Il est ici pour les six traitements.
 *
 * L'état n'est PAS versionné (GEN-001) : il ne dépend pas de la version
 * affichée, et un changement de version ne le modifie pas. C'est pourquoi il
 * est rendu hors de l'éditeur, avec son propre enregistrement immédiat.
 *
 * La confirmation nomme la conséquence, différente selon le traitement : un
 * traitement par lots interrompt son exécution en cours (remise en tête de
 * file), un traitement direct refuse ses appels IA (T2 reste disponible en
 * mode déterministe — MOD-012).
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Loader2, Power } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';

export type RuntimeState = 'ENABLED' | 'DISABLED' | 'SUSPENDED';

export interface TreatmentRuntimeState {
  treatment: string;
  state: RuntimeState;
  suspendedReason: string | null;
  suspendedAt: string | null;
  nextProbeAt: string | null;
}

const LABEL: Record<RuntimeState, string> = {
  ENABLED: 'Activé',
  DISABLED: 'Désactivé',
  SUSPENDED: 'Suspendu automatiquement',
};

const STYLE: Record<RuntimeState, string> = {
  ENABLED: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  DISABLED: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
  SUSPENDED: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
};

export function TreatmentStateControl({
  treatment, batch, state, emergencyStop, onChanged,
}: {
  treatment: string;
  batch: boolean;
  /** Absent = aucune ligne en base = activé (même règle que le serveur). */
  state: TreatmentRuntimeState | undefined;
  emergencyStop: boolean;
  onChanged: (states: TreatmentRuntimeState[]) => void;
}) {
  const [confirm, setConfirm] = useState<null | boolean>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const current: RuntimeState = state?.state ?? 'ENABLED';
  const enabling = current !== 'ENABLED';

  const submit = async () => {
    if (confirm === null) return;
    setBusy(true);
    try {
      const r = await apiClient.post<{ states: TreatmentRuntimeState[] }>('/api/admin/ai/treatments', {
        treatment, enabled: confirm, ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      onChanged(r.states);
      toast.success(`${treatment} ${confirm ? 'réactivé' : 'désactivé'}`);
      setConfirm(null);
      setReason('');
    } catch (e) {
      toast.error((e as Error).message || 'Changement d’état impossible.');
    } finally { setBusy(false); }
  };

  const consequence = (): string => {
    if (confirm) {
      return current === 'SUSPENDED'
        ? 'Réactivation forcée : le circuit breaker est remis à zéro. Les alertes par modèle '
          + 'restent affichées jusqu’au premier succès de chaque modèle (OPS-027).'
        : batch
          ? 'La file reprend : le travail interrompu repart depuis le début, puis les demandes en attente.'
          : 'Les appels IA de ce traitement sont de nouveau autorisés.';
    }
    return batch
      ? 'L’exécution en cours est interrompue et remise en tête de file. Les demandes restent '
        + 'en file et continuent d’être acceptées ; aucune ne démarre avant réactivation (WF-07).'
      : treatment === 'T2'
        ? 'Les appels IA de l’assistant sont refusés. Les réponses déterministes (base de données) '
          + 'restent disponibles (MOD-012).'
        : 'Tous les appels IA de ce traitement sont refusés jusqu’à réactivation.';
  };

  return (
    <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium text-[color:var(--text-primary)]">État opérationnel</span>
      <span className={`text-xs px-2 py-0.5 rounded-full border ${STYLE[current]}`}>{LABEL[current]}</span>
      {emergencyStop && (
        <span className="text-xs text-red-400">· arrêt d&apos;urgence engagé (prime sur cet état)</span>
      )}
      <span className="flex-1" />
      <Button size="sm" variant={enabling ? 'default' : 'outline'} disabled={busy}
        onClick={() => setConfirm(enabling)}>
        <Power className="w-3.5 h-3.5 mr-1.5" />
        {current === 'SUSPENDED' ? 'Forcer la réactivation' : enabling ? 'Activer' : 'Désactiver'}
      </Button>
      {current === 'SUSPENDED' && (state?.suspendedReason || state?.nextProbeAt) && (
        <p className="basis-full text-xs text-amber-500">
          {state?.suspendedReason}
          {state?.nextProbeAt && ` — prochaine sonde : ${new Date(state.nextProbeAt).toLocaleTimeString('fr-FR')}`}
        </p>
      )}
      <p className="basis-full text-xs text-[color:var(--text-muted)]">
        Commande d&apos;exploitation, non versionnée : elle ne dépend pas de la version affichée.
      </p>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm ? `Réactiver ${treatment}` : `Désactiver ${treatment}`}</DialogTitle>
            <DialogDescription>{consequence()}</DialogDescription>
          </DialogHeader>
          {!confirm && (
            <label className="block space-y-1.5">
              <span className="text-sm text-[color:var(--text-secondary)]">Motif (conseillé)</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
                className="w-full rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-input)] px-3 py-2 text-sm" />
            </label>
          )}
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setConfirm(null)}>Annuler</Button>
            <Button variant={confirm ? 'default' : 'destructive'} onClick={submit} disabled={busy}>
              {busy && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              {confirm ? 'Réactiver' : 'Désactiver'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
