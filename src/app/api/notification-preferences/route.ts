import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { buildPreferenceMatrix, applyPreferenceChanges, type PreferenceChange } from '@/lib/notifications/preference-matrix';

/**
 * GET /api/notification-preferences  (CDC §13.1)
 * Retourne la matrice complète fusionnée : catégories, réglages (défauts +
 * préférences), verrous email obligatoires, état du push et nombre d'appareils.
 */
export async function GET(request: NextRequest) {
  let session;
  try { session = await getSession(request); }
  catch { return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 }); }

  const matrix = await buildPreferenceMatrix(session.userId);
  return NextResponse.json(matrix);
}

/**
 * PATCH /api/notification-preferences  (CDC §13.1)
 * Applique une ou plusieurs modifications atomiques. Refuse de désactiver un
 * email obligatoire et ne touche jamais aux préférences d'un autre membre Duo
 * (réglages strictement au niveau user_id).
 *
 * Body: { changes: [{ category, channel, deliveryMode?, enabled }] }
 */
export async function PATCH(request: NextRequest) {
  let session;
  try { session = await getSession(request); }
  catch { return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 }); }

  const body = await request.json().catch(() => null);
  const changes: PreferenceChange[] = body?.changes;
  if (!Array.isArray(changes)) {
    return NextResponse.json({ error: 'INVALID_BODY' }, { status: 400 });
  }

  const result = await applyPreferenceChanges(session.userId, changes);
  if (!result.ok) {
    const status = result.error?.startsWith('EMAIL_MANDATORY') ? 409 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  const matrix = await buildPreferenceMatrix(session.userId);
  return NextResponse.json({ ok: true, ...matrix });
}
