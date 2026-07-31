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
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import {
  reemettreNotification,
  apercuReemission,
  ReemissionError,
} from '@/services/notifications/notification-reemission.service';

export const dynamic = 'force-dynamic';

async function exigerAdmin(req: NextRequest) {
  const session = await SessionService.getSession(req);
  if (session.role !== 'ADMIN' && session.role !== 'SUPER_ADMIN') {
    throw new ReemissionError('FORBIDDEN', 'Réservé aux administrateurs autorisés.');
  }
  return session;
}

export async function GET(req: NextRequest) {
  try {
    await exigerAdmin(req);
  } catch (e) {
    if (e instanceof ReemissionError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 403 });
    }
    return SessionService.handleSessionError(e);
  }

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Paramètre `id` requis.' }, { status: 400 });

  await ensureMigrations();

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
  let session;
  try {
    session = await exigerAdmin(req);
  } catch (e) {
    if (e instanceof ReemissionError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 403 });
    }
    return SessionService.handleSessionError(e);
  }

  await ensureMigrations();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Corps invalide.' }, { status: 400 });
  }

  if (typeof body.outboxId !== 'string') {
    return NextResponse.json({ error: '`outboxId` requis.' }, { status: 400 });
  }

  try {
    const resultat = await reemettreNotification({
      outboxId: body.outboxId,
      actorUserId: session.userId,
      actorEmail: session.email ?? `user:${session.userId}`,
      // §20.3 condition 4 : la confirmation vient du client, explicitement.
      // Elle n'est jamais déduite de la présence de la requête.
      confirme: body.confirme === true,
      motif: typeof body.motif === 'string' ? body.motif : undefined,
    });
    return NextResponse.json(resultat);
  } catch (e) {
    if (e instanceof ReemissionError) {
      const status = e.code === 'INTROUVABLE' ? 404 : 409;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error('[reemission] échec :', (e as Error).message);
    return NextResponse.json({ error: 'Erreur interne.', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
