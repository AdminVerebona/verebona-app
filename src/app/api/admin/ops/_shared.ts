/**
 * Garde commune des routes `/api/admin/ops/**` de la page BO « Exploitation »
 * (lot 25, chantier B) — même garde que le reste du BO (`requireAdmin`,
 * session par cookie, rôle relu en base si le jeton est périmé). Le CSRF des
 * méthodes d'écriture est vérifié en amont par `src/middleware.ts`
 * (`verifyRequestOrigin`, aucune exemption pour `/api/admin/`).
 * Réponses jamais mises en cache.
 */
import { NextResponse } from 'next/server';
import { isSessionError, sessionErrorResponse } from '@/lib/auth-guards';

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export type AdminGuard = { ok: true; adminId: number } | { ok: false; response: NextResponse };

/**
 * Exécute la garde admin (`requireAdmin(request)`, appelée dans chaque route :
 * contrôle statique `admin-guard.test.ts`) et traduit ses refus en 401/403/503.
 */
export async function guardAdmin(garde: () => Promise<number>): Promise<AdminGuard> {
  try {
    return { ok: true, adminId: await garde() };
  } catch (error) {
    if (isSessionError(error)) return { ok: false, response: sessionErrorResponse(error) };
    console.error('[admin/ops] garde :', (error as Error).message);
    return { ok: false, response: NextResponse.json({ error: 'Vérification impossible', code: 'GUARD_FAILED' }, { status: 500 }) };
  }
}

export function opsError(error: unknown, context: string, code = 'OPS_FAILED'): NextResponse {
  console.error(`[admin/ops] ${context} :`, (error as Error)?.message ?? error);
  return NextResponse.json(
    { error: 'Opération impossible', code, message: 'Erreur interne (voir le journal du serveur).' },
    { status: 500, headers: NO_STORE },
  );
}
