/**
 * GET /api/admin/notifications/health — CDC 3 §20.1 et §20.2.
 *
 * Écran de santé et recherche. Ne rend que des agrégats et des métadonnées :
 * ni clé push, ni contenu de notification (§20.2).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import {
  getNotificationHealth,
  rechercherNotifications,
} from '@/services/notifications/notification-health.service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  // §20.3 condition 1, appliquée dès la consultation : un écran de santé
  // renseigne sur l'activité de tous les comptes.
  if (session.role !== 'ADMIN' && session.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  }

  await ensureMigrations();
  const p = req.nextUrl.searchParams;

  // Mode recherche (§20.2) si un critère est fourni.
  const criteres = {
    eventId: p.get('eventId') ?? undefined,
    userId: Number(p.get('userId')) || undefined,
    type: p.get('type') ?? undefined,
    status: p.get('status') ?? undefined,
    depuis: p.get('depuis') ?? undefined,
    jusqu: p.get('jusqu') ?? undefined,
  };
  const rechercheDemandee = Object.values(criteres).some((v) => v !== undefined);

  if (rechercheDemandee) {
    return NextResponse.json({ resultats: await rechercherNotifications(criteres) });
  }

  const fenetre = Number(p.get('heures')) || 24;
  return NextResponse.json(await getNotificationHealth(fenetre));
}
