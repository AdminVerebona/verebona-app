import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { getNotificationHealth } from '@/lib/notifications/metrics';

/**
 * GET /api/admin/notifications/metrics  (CDC §20.1)
 * Écran de santé des notifications. Réservé aux administrateurs. N'expose ni
 * clés push ni contenu de notification.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  }

  const url = new URL(request.url);
  const windowDays = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 365);

  try {
    const health = await getNotificationHealth(windowDays);
    return NextResponse.json(health);
  } catch (error) {
    console.error('[admin/notifications/metrics] erreur:', error);
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
