/**
 * Routes `/api/admin/operations/**` — BO diagnostic des Opérations (lot 47A,
 * O9 — CDC Opérations V1 C25, C26 ; décisions PO Q8, Q9).
 *
 * LECTURE SEULE : ces routes n'exportent QUE `GET` (test statique
 * `o9-bo-diagnostic.test.ts`) ; le service lit dans une transaction READ ONLY.
 * Garde : celle de tout le BO (`requireAdmin`, rôle ADMIN / SUPER_ADMIN relu
 * en base), appelée dans chaque route avant tout accès. Réponses jamais mises
 * en cache. Consultation non journalisée : le BO ne journalise pas les vues
 * de compte (AUD-003 : actions sensibles seulement).
 */
import { NextResponse } from 'next/server';

export { guardAdmin, NO_STORE } from '../ops/_shared';

/** Erreur de lecture → 503 si la base a annulé la requête (délai), 500 sinon. */
export function diagnosticsError(error: unknown, context: string): NextResponse {
  const code = (error as { code?: string })?.code;
  console.error(`[admin/operations] ${context} :`, (error as Error)?.message ?? error);
  if (code === '57014') {
    return NextResponse.json(
      { error: 'Calcul trop long', code: 'DIAGNOSTICS_TIMEOUT', message: 'Requête annulée par la base (délai dépassé) : filtrer sur un compte ou réduire la période.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(
    { error: 'Lecture impossible', code: 'DIAGNOSTICS_FAILED', message: 'Erreur interne (voir le journal du serveur).' },
    { status: 500, headers: { 'Cache-Control': 'no-store' } },
  );
}
