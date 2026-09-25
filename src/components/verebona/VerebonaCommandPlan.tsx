'use client';
/**
 * Aperçu d'une commande (ou d'un plan) préparée par l'assistant.
 *
 * Rien n'est écrit tant que l'utilisateur n'a pas cliqué « Confirmer ». Les
 * paramètres affichés sont ceux qui seront exécutés : le client n'envoie que
 * l'identifiant du plan.
 */
import type { VerebonaCommandPlan as Plan } from '@/lib/verebona/useVerebona';

export function VerebonaCommandPlan({
  plan, onConfirm, onCancel, disabled,
}: { plan: Plan; onConfirm: (planId: string) => void; onCancel: (planId: string) => void; disabled?: boolean }) {
  const multi = plan.actions.length > 1;
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
      {plan.status === 'PENDING_CONFIRMATION' ? (
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={disabled} onClick={() => onConfirm(plan.planId)}
            className="rounded-full bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50">
            Confirmer
          </button>
          <button type="button" disabled={disabled} onClick={() => onCancel(plan.planId)}
            className="rounded-full border px-3 py-1 hover:bg-muted disabled:opacity-50">
            Annuler
          </button>
        </div>
      ) : (
        <div className="mt-2 text-muted-foreground">
          {plan.status === 'CANCELLED' ? 'Action annulée — rien n’a été modifié.' : 'Action traitée.'}
        </div>
      )}
    </div>
  );
}
