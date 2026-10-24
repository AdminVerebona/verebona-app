/**
 * Socle commun des routes de configuration IA — CDC BO IA §17.
 *
 * Neuf routes partagent la même garde, la même lecture d'identifiant et la même
 * traduction des refus en codes HTTP. Les dupliquer neuf fois, c'est se garantir
 * qu'elles divergeront : une route finira par rendre 200 là où les autres
 * rendent 409, et l'écran ne saura plus quoi afficher.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { requireAdmin } from '@/lib/auth-guards';
import { ensureMigrations } from '@/db';
import { ConfigOperationRefused } from '@/services/ai/config/config-version.service';
import { ConfigVersionRefused } from '@/services/ai/config/config-version.repository';

export interface AdminContext {
  adminUserId: number;
}

/**
 * Garde d'administration. Rend une réponse à renvoyer telle quelle en cas de
 * refus, plutôt que de lever : une route qui oublierait le try/catch renverrait
 * sinon une 500 sur une simple absence de session.
 */
export async function requireAdminContext(
  req: NextRequest,
): Promise<{ ok: true; ctx: AdminContext } | { ok: false; response: NextResponse }> {
  try {
    const adminUserId = await requireAdmin(req);
    await ensureMigrations();
    return { ok: true, ctx: { adminUserId } };
  } catch (e) {
    return { ok: false, response: SessionService.handleSessionError(e) };
  }
}

/** Identifiant de version, strictement entier positif. */
export function parseVersionId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function invalidId(raw: string): NextResponse {
  return NextResponse.json(
    { error: 'INVALID_VERSION_ID', message: `Identifiant de version illisible : « ${raw} ».` },
    { status: 400 },
  );
}

/**
 * Traduit une erreur en réponse.
 *
 * Un refus fonctionnel n'est pas une panne : il porte un code stable que
 * l'écran peut interpréter, et un statut qui le distingue d'une erreur
 * technique. 409 parce que l'opération entre en conflit avec l'état courant —
 * ni la requête ni le serveur ne sont en cause.
 */
const NOT_FOUND_CODES = new Set(['VERSION_NOT_FOUND', 'REVISION_NOT_FOUND', 'EXPORT_NOT_FOUND', 'IMPORT_NOT_FOUND', 'INTERVENTION_NOT_FOUND', 'PROMOTION_NOT_FOUND']);
const UNPROCESSABLE_CODES = new Set([
  'EXPORT_INVALID', 'IMPORT_REFUSED', 'IMPORT_UNREADABLE', 'LEGACY_PACKAGE_FORMAT', 'LEGACY_EXPORT_FORMAT', 'UNKNOWN_FORMAT_VERSION', 'UNKNOWN_FORMAT',
]);

export function toErrorResponse(e: unknown, route: string): NextResponse {
  if (e instanceof ConfigOperationRefused || e instanceof ConfigVersionRefused) {
    const status = NOT_FOUND_CODES.has(e.code) ? 404
      // Lot 54 : un fichier qui ne passe pas ses contrôles n'est jamais rendu.
      // Lot 86B : fichier importé refusé (format retiré, illisible, contrôles).
      : UNPROCESSABLE_CODES.has(e.code) ? 422
        : 409;
    return NextResponse.json({ error: e.code, message: e.message, details: e.details ?? null }, { status });
  }

  // Les refus de la machine à états arrivent ici : ils disent qu'une transition
  // n'est pas prévue depuis l'état courant, ce qui est aussi un conflit.
  const message = (e as Error).message ?? '';
  if (message.includes('Transition refusée') || message.includes('VER-002')) {
    return NextResponse.json({ error: 'INVALID_TRANSITION', message }, { status: 409 });
  }

  console.error(`[${route}]`, e);
  return NextResponse.json(
    { error: 'CONFIG_OPERATION_FAILED', message: 'Opération impossible.' },
    { status: 500 },
  );
}
