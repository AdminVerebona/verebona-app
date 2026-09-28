'use client';
/**
 * Aperçu d'une commande (ou d'un plan) préparée par l'assistant.
 *
 * Rien n'est écrit tant que l'utilisateur n'a pas cliqué « Confirmer ». Les
 * paramètres affichés sont ceux qui seront exécutés : le client n'envoie que
 * l'identifiant du plan.
 *
 * Tant qu'elle est en attente et non expirée, la proposition peut être
 * annulée (« Annuler ») : rien n'est modifié, l'annulation est enregistrée
 * dans le fil. Passé l'heure de validité, les boutons disparaissent.
 *
 * Une fois EXÉCUTÉE, une action réversible peut encore être défaite pendant
 * 15 minutes (décision produit, CDC BO IA T2-038 / T2-039) : bouton
 * « Annuler l’action » avec le temps restant, qui disparaît à l'échéance.
 * Aucun bouton pour un plan irréversible (`undoUntil` absent) : le serveur
 * fait foi et refuse de toute façon une annulation hors règles.
 */
import { useEffect, useState } from 'react';
import type { VerebonaCommandPlan as Plan, VerebonaPlanStatus } from '@/lib/verebona/useVerebona';

/** Libellé de l'état d'une proposition close. */
export function planStatusLabel(status: VerebonaPlanStatus): string {
  switch (status) {
    case 'CANCELLED': return 'Action annulée — rien n’a été modifié.';
    case 'EXPIRED': return 'Proposition expirée — rien n’a été modifié.';
    case 'EXECUTED': return 'Action effectuée.';
    case 'PARTIAL': return 'Action effectuée en partie.';
    case 'FAILED': return 'Action non effectuée.';
    case 'REFUSED': return 'Action refusée — rien n’a été modifié.';
    case 'UNDONE': return 'Action annulée — les modifications ont été défaites.';
    case 'EXECUTING': return 'Action en cours d’exécution…';
    case 'DECIDING': return 'Envoi en cours…';
    default: return 'Action traitée.';
  }
}

/**
 * Temps restant (ms) pour « Annuler » une action exécutée ; null si le
 * bouton ne doit pas apparaître (non exécutée, irréversible, délai passé).
 */
export function undoRemainingMs(plan: Pick<Plan, 'status' | 'undoUntil'>, nowMs: number = Date.now()): number | null {
  if (plan.status !== 'EXECUTED' && plan.status !== 'PARTIAL') return null;
  if (!plan.undoUntil) return null;
  const fin = new Date(plan.undoUntil).getTime();
  if (!Number.isFinite(fin) || fin <= nowMs) return null;
  return fin - nowMs;
}

/** « 14 min », puis « 45 s » la dernière minute. */
export function formatUndoRemaining(ms: number): string {
  return ms >= 60_000 ? `${Math.ceil(ms / 60_000)} min` : `${Math.max(1, Math.ceil(ms / 1000))} s`;
}

const heure = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
};

export function VerebonaCommandPlan({
  plan, onConfirm, onCancel, onUndo, disabled,
}: {
  plan: Plan;
  onConfirm: (planId: string) => void;
  onCancel: (planId: string) => void;
  /** « Annuler » une action exécutée (fenêtre de 15 minutes). */
  onUndo?: (planId: string) => void;
  disabled?: boolean;
}) {
  const multi = plan.actions.length > 1;
  const expiresMs = new Date(plan.expiresAt).getTime();
  const [expiree, setExpiree] = useState(() => Number.isFinite(expiresMs) && expiresMs <= Date.now());

  // Expiration côté affichage : le serveur fait foi (il refuse une
  // confirmation tardive), mais les boutons disparaissent à l'échéance.
  useEffect(() => {
    if (plan.status !== 'PENDING_CONFIRMATION' || !Number.isFinite(expiresMs)) return;
    const reste = expiresMs - Date.now();
    if (reste <= 0) { setExpiree(true); return; }
    const t = setTimeout(() => setExpiree(true), Math.min(reste, 2_147_000_000));
    return () => clearTimeout(t);
  }, [plan.status, expiresMs]);

  // Fenêtre « Annuler » : décompte à la seconde, bouton retiré à l'échéance.
  const [maintenant, setMaintenant] = useState(() => Date.now());
  const resteAnnulation = undoRemainingMs(plan, maintenant);
  useEffect(() => {
    if (undoRemainingMs(plan, Date.now()) === null) return;
    const t = setInterval(() => setMaintenant(Date.now()), 1000);
    return () => clearInterval(t);
  }, [plan]);

  const status: VerebonaPlanStatus = plan.status === 'PENDING_CONFIRMATION' && expiree ? 'EXPIRED' : plan.status;
  const enAttente = status === 'PENDING_CONFIRMATION';
  const limite = heure(plan.expiresAt);

  return (
    <div className="mt-2 rounded-xl border p-3 text-xs" role="group" aria-label="Action à confirmer">
      <ol className={multi ? 'list-decimal space-y-2 pl-4' : 'space-y-2'}>
        {plan.actions.map((a) => (
          <li key={a.actionId}>
            <div className="font-medium">{a.preview}</div>
            {a.effects.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                {a.effects.map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
            {a.dependsOn.length > 0 && (
              <div className="mt-1 text-muted-foreground">Exécutée seulement si {a.dependsOn.join(', ')} réussit.</div>
            )}
          </li>
        ))}
      </ol>
      {enAttente ? (
        <>
          <div className="mt-3 flex gap-2">
            <button type="button" disabled={disabled} onClick={() => onConfirm(plan.planId)}
              className="rounded-full bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50">
              Confirmer
            </button>
            <button type="button" disabled={disabled} onClick={() => onCancel(plan.planId)}
              aria-label="Annuler cette action : rien ne sera modifié"
              className="rounded-full border px-3 py-1 hover:bg-muted disabled:opacity-50">
              Annuler
            </button>
          </div>
          {limite && (
            <div className="mt-2 text-muted-foreground">
              Rien n’est modifié sans votre confirmation. Proposition valable jusqu’à {limite}.
            </div>
          )}
        </>
      ) : (
        <>
          <div className="mt-2 text-muted-foreground" role="status">{planStatusLabel(status)}</div>
          {onUndo && resteAnnulation !== null && (
            <div className="mt-2 flex items-center gap-2">
              <button type="button" disabled={disabled} onClick={() => onUndo(plan.planId)}
                aria-label={`Annuler l’action exécutée (encore ${formatUndoRemaining(resteAnnulation)})`}
                className="rounded-full border px-3 py-1 hover:bg-muted disabled:opacity-50">
                Annuler l’action
              </button>
              <span className="text-muted-foreground">Encore {formatUndoRemaining(resteAnnulation)} pour annuler.</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
