import { NextResponse } from 'next/server';
import { getVapidPublicKey } from '@/lib/notifications/web-push-sender';

/**
 * GET /api/push/public-key  (CDC §13.2)
 * Retourne uniquement la clé VAPID publique (jamais la clé privée).
 */
export async function GET() {
  const publicKey = getVapidPublicKey();
  if (!publicKey) {
    return NextResponse.json({ error: 'PUSH_NOT_CONFIGURED' }, { status: 503 });
  }
  return NextResponse.json({ publicKey });
}
