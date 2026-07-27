import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { getNewsConsent, setNewsConsent } from '@/lib/notifications/news-consent';

/**
 * GET /api/notification-preferences/news-consent  (CDC §7.8 / §19.5)
 * État du consentement actualités de l'utilisateur.
 */
export async function GET(request: NextRequest) {
  let session;
  try { session = await getSession(request); }
  catch { return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 }); }

  const consent = await getNewsConsent(session.userId);
  return NextResponse.json(consent);
}

/**
 * POST /api/notification-preferences/news-consent
 * Donne ou retire le consentement. Retrait immédiat, preuve conservée.
 * Body: { consented: boolean, source?: string }
 */
export async function POST(request: NextRequest) {
  let session;
  try { session = await getSession(request); }
  catch { return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 }); }

  const body = await request.json().catch(() => null);
  if (typeof body?.consented !== 'boolean') {
    return NextResponse.json({ error: 'INVALID_BODY' }, { status: 400 });
  }
  const source = typeof body.source === 'string' ? body.source : 'mon-compte/notifications';

  const consent = await setNewsConsent(session.userId, body.consented, source);
  return NextResponse.json({ ok: true, ...consent });
}
