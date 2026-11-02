'use client';

/**
 * Lot 104A (P1-E) — bandeau « Vérification des CGUV momentanément
 * impossible ». Affiché par la coquille (ordinateur, mobile et application
 * mobile — même composant) quand le serveur ne peut pas contrôler la
 * réacceptation des CGUV : les modifications sont suspendues par sécurité
 * (refus 503 `CGUV_CHECK_UNAVAILABLE`), tout le reste est disponible —
 * consultation, export de ses données, lecture des CGUV, déconnexion.
 * Aucun écran bloquant : il n'y a rien de fiable à faire accepter.
 */
import { AlertTriangle } from 'lucide-react';
import { CGUV_CHECK_UNAVAILABLE_MESSAGE } from '@/lib/legal/reacceptance-gate';

export function CguvCheckUnavailableNotice() {
  return (
    <div
      role="status"
      data-testid="cguv-check-unavailable"
      className="mx-4 mt-3 flex items-start gap-2 rounded-xl border border-[color:var(--attention-edge)] bg-[color:var(--attention-soft)] p-3 text-sm text-[color:var(--attention-on-soft)] md:mx-6"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--attention)]" aria-hidden />
      <p>{CGUV_CHECK_UNAVAILABLE_MESSAGE}</p>
    </div>
  );
}
