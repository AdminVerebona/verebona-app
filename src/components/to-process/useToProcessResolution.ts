'use client';

/**
 * Résolution d'une action « À traiter » — UN SEUL parcours (lot 32).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA FILE ET LA MASCOTTE RÉSOLVENT PAR LE MÊME CODE
 *
 * Ticket Mascotte (point de vigilance) : « Il ne faut pas développer une
 * nouvelle logique de choix spécifique à la mascotte. » Ce hook porte ce que
 * `ToProcessQueue` faisait seul : application d'une proposition (route
 * `/api/v2/to-process/[publicId]/resolve`, mode `arbitrate`), toast
 * « Valeur mise à jour — Annuler », annulation, ouverture de l'objet sur le
 * champ (« Autre », « Compléter »). La carte, elle, est `ActionCard`.
 *
 * ── SYNCHRONISATION IMMÉDIATE (L32-6, MASC2) ──────────────────────────────
 *
 * Toute résolution (ou annulation, ou carte retirée par le serveur) émet
 * `refresh-a-traiter` : la file se relit, la pastille du menu (desktop et
 * barre mobile) et la mascotte aussi — sans rechargement de page.
 *
 * ── REFUS ─────────────────────────────────────────────────────────────────
 *
 * Le message affiché est celui du code renvoyé par la route
 * (`resolveErrorMessage`), plus jamais un « n'a pas pu être appliquée »
 * indistinct. Une carte que le serveur a retirée (déjà traitée, sans objet,
 * périmée) ne revient pas à l'écran.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { openToProcessTarget } from '@/lib/to-process-target';
import { resolveErrorClosesCard, resolveErrorMessage } from '@/lib/to-process-resolve-errors';
import type { ActionProposalView, ActionView } from './ActionCard';

/** Événement de synchronisation file / pastille / mascotte. */
export const TO_PROCESS_SYNC_EVENT = 'refresh-a-traiter';

export function notifyToProcessChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(TO_PROCESS_SYNC_EVENT));
}

function errorCode(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

export interface ResolutionCallbacks {
  /** Retrait optimiste de la carte (§16.3). */
  onRemove?: (action: ActionView) => void;
  /** Le serveur a refusé : la carte revient. */
  onRollback?: (action: ActionView) => void;
  /** Résolution confirmée par le serveur. */
  onResolved?: (action: ActionView) => void;
  /** Après une annulation réussie (la carte est rouverte). */
  onUndone?: (action: ActionView) => void;
}

export function useToProcessResolution(cb: ResolutionCallbacks = {}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  // Rappels lus au moment de l'appel : les fonctions rendues restent stables.
  const ref = useRef(cb);
  ref.current = cb;

  const undo = useCallback(async (action: ActionView, previousValue: unknown) => {
    try {
      await apiClient.post(`/api/v2/to-process/${action.publicId}/resolve`, { mode: 'undo', previousValue });
      ref.current.onUndone?.(action);
      notifyToProcessChanged();
      toast.success('Modification annulée.');
    } catch (e) {
      notifyToProcessChanged();
      toast.error(errorCode(e) === 'STALE' ? resolveErrorMessage('STALE') : 'L’annulation n’a pas abouti.');
    }
  }, []);

  const choose = useCallback(async (action: ActionView, proposal: ActionProposalView): Promise<boolean> => {
    setBusyId(action.publicId);
    ref.current.onRemove?.(action);
    try {
      const res = await apiClient.post<{ ok: boolean; previousValue: unknown }>(
        `/api/v2/to-process/${action.publicId}/resolve`,
        { mode: 'arbitrate', value: proposal.value },
      );
      ref.current.onResolved?.(action);
      notifyToProcessChanged();
      toast.success('Valeur mise à jour', {
        action: { label: 'Annuler', onClick: () => void undo(action, res.previousValue) },
      });
      return true;
    } catch (e) {
      const code = errorCode(e);
      if (resolveErrorClosesCard(code)) {
        // La carte n'est plus active côté serveur : elle ne revient pas.
        notifyToProcessChanged();
        toast.info(resolveErrorMessage(code));
      } else {
        ref.current.onRollback?.(action);
        toast.error(resolveErrorMessage(code));
      }
      return false;
    } finally {
      setBusyId(null);
    }
  }, [undo]);

  /**
   * « Autre » et « Compléter » ouvrent l'objet sur le champ concerné (§8.5,
   * §8.6) — resolver commun (`openToProcessTarget`).
   */
  const openTarget = useCallback((action: ActionView) => {
    openToProcessTarget(
      {
        targetType: action.targetType,
        targetId: action.targetId,
        targetPublicId: action.target.publicId ?? null,
        field: action.fieldKey ?? action.relationKey ?? '',
        supplierId: action.target.supplierId ?? null,
      },
      router,
      () => toast.info('Ouvrez cet élément depuis sa page pour compléter l’information.'),
    );
  }, [router]);

  return { busyId, choose, undo, openTarget };
}
