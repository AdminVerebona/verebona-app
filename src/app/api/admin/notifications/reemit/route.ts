/**
 * POST /api/admin/notifications/reemit — CDC 3 §20.3.
 *
 * Réémission manuelle. Les cinq conditions du §20.3 sont vérifiées par le
 * service ; cette route porte la première — l'habilitation — et transmet la
 * confirmation explicite.
 *
 * `GET ?id=…` rend l'aperçu qui précède la confirmation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { reemettre, requireAdminContext } from '../_shared';
import {
  apercuReemission,
  ReemissionError,
} from '@/services/notifications/notification-reemission.service';

export const dynamic = 'force-dynamic';

/**
 * Habilitation (§20.3 condition 1) : garde admin serveur commune du BO
 * (CDC BO GEN-002), qui relit le rôle en base si le jeton est antérieur à une
 * promotion. Chaque réémission — réussie, refusée ou en échec — est
 * journalisée (`logAdminAction`, D-L lot 21).
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Paramètre `id` requis.' }, { status: 400 });

  try {
    return NextResponse.json(await apercuReemission(id));
  } catch (e) {
    if (e instanceof ReemissionError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 404 });
    }
    throw e;
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  return reemettre(req, guard, 'NOTIFICATION_REEMIT');
}
