/**
 * Routes BO « Données du compte » (lot 75N) — garde, compte, erreurs.
 *
 * LECTURE SEULE : ces routes n'exportent QUE `GET` (test statique
 * `l75n-routes.test.ts`) ; les services lisent dans une transaction READ ONLY.
 * Garde : `requireAdmin` (rôle ADMIN / SUPER_ADMIN relu en base), appelée
 * dans chaque route avant tout accès. Réponses jamais mises en cache.
 * Aucune API SQL générique : la catégorie / le type d'entité sont des listes
 * blanches, les requêtes sont écrites dans les services.
 */
import { NextResponse } from 'next/server';
import { readOnlyExecutor } from '@/services/business-operations/diagnostics/service';
import { entityId } from '@/services/admin/account-data/model';

export { guardAdmin, NO_STORE } from '../../../ops/_shared';
import { NO_STORE } from '../../../ops/_shared';

/** Identifiant de compte valide et existant, sinon réponse d'erreur. */
export async function resolveAccount(raw: string): Promise<{ ok: true; accountId: number } | { ok: false; response: NextResponse }> {
  const accountId = entityId(raw);
  if (!accountId) {
    return { ok: false, response: NextResponse.json({ error: 'Identifiant de compte invalide.', code: 'INVALID_ACCOUNT_ID' }, { status: 400, headers: NO_STORE }) };
  }
  const exists = await readOnlyExecutor(async (q) => (await q(`SELECT 1 FROM accounts WHERE id = $1`, [accountId])).length > 0);
  if (!exists) {
    return { ok: false, response: NextResponse.json({ error: 'Compte introuvable.', code: 'ACCOUNT_NOT_FOUND' }, { status: 404, headers: NO_STORE }) };
  }
  return { ok: true, accountId };
}

/** Erreur de lecture → 503 (délai base dépassé) ou 500. */
export function readError(error: unknown, context: string): NextResponse {
  const code = (error as { code?: string })?.code;
  console.error(`[admin/account-data] ${context} :`, (error as Error)?.message ?? error);
  if (code === '57014') {
    return NextResponse.json({ error: 'Lecture trop longue', code: 'READ_TIMEOUT', message: 'Requête annulée par la base (délai dépassé).' }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json({ error: 'Lecture impossible', code: 'READ_FAILED', message: 'Erreur interne (voir le journal du serveur).' }, { status: 500, headers: NO_STORE });
}
