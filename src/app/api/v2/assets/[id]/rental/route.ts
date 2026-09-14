/**
 * GET / PATCH /api/v2/assets/[id]/rental — CDC V2.0 §6.1, §5.3.
 *
 * L'identifiant est numérique, comme le reste des routes `/api/assets/[id]` :
 * l'onglet « Informations » travaille déjà avec `asset.id`, et introduire
 * l'identifiant public ici obligerait à le charger en plus pour un seul champ.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { SessionService } from '@/lib/session-service';
import {
  getRentalStatus,
  isRentalAttributeApplicable,
  setRentalStatusByUser,
} from '@/services/assets/rental-status.service';

export const dynamic = 'force-dynamic';

async function resolveAsset(req: NextRequest, id: string) {
  const session = await SessionService.getSession(req);
  const accountId = session.currentAccountId;
  if (!accountId) return { error: 'NO_ACCOUNT_SELECTED' as const, status: 400 };

  const assetId = Number(id);
  if (!Number.isInteger(assetId) || assetId <= 0) {
    return { error: 'INVALID_ID' as const, status: 400 };
  }

  const [row] = await db
    .select({ id: assets.id, category: assets.category })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId)))
    .limit(1);

  if (!row) return { error: 'NOT_FOUND' as const, status: 404 };

  // §6.1 : le champ n'existe que pour l'immobilier. Le refuser ici, et pas
  // seulement le masquer côté client, évite qu'un appel direct pose l'attribut
  // sur un véhicule — où il n'aurait aucun sens et rendrait « Gestion
  // locative » visible sur un bien qui ne peut pas la porter.
  if (!isRentalAttributeApplicable(row.category)) {
    return { error: 'NOT_APPLICABLE' as const, status: 422 };
  }

  return { accountId, assetId };
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let resolved;
  try {
    resolved = await resolveAsset(req, id);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const status = await getRentalStatus(resolved.accountId, resolved.assetId);
  return NextResponse.json(status);
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let resolved;
  try {
    resolved = await resolveAsset(req, id);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  let body: { isRented?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_BODY' }, { status: 400 });
  }

  if (typeof body.isRented !== 'boolean') {
    return NextResponse.json({ error: 'INVALID_VALUE' }, { status: 400 });
  }

  const status = await setRentalStatusByUser(
    resolved.accountId,
    resolved.assetId,
    body.isRented,
  );

  return NextResponse.json(status);
}
