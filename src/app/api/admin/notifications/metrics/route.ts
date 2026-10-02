import { NextRequest, NextResponse } from 'next/server';
import { getNotificationHealth } from '@/lib/notifications/metrics';
import { requireAdminContext } from '../_shared';

/**
 * GET /api/admin/notifications/metrics  (CDC §20.1)
 * Indicateurs de livraison par canal sur une fenêtre en jours. Réservé aux
 * administrateurs. N'expose ni clés push ni contenu de notification.
 * Lecture d'agrégats : non journalisée (aucune donnée nominative).
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdminContext(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const windowDays = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 365);

  try {
    return NextResponse.json(await getNotificationHealth(windowDays));
  } catch (error) {
    console.error('[admin/notifications/metrics] erreur:', error);
    return NextResponse.json({ error: 'SERVER_ERROR', message: 'Indicateurs indisponibles.' }, { status: 500 });
  }
}
