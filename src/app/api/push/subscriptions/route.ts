import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { pushSubscriptions } from '@/db/schema';
import { and, desc, eq } from 'drizzle-orm';

/**
 * POST /api/push/subscriptions  (CDC §13.2 / §10)
 * Crée ou réactive l'abonnement Web Push de l'appareil courant. Idempotent sur
 * l'endpoint : un même appareil (endpoint unique) est rattaché à l'utilisateur
 * courant — ce qui gère aussi la reprise d'un appareil partagé après connexion.
 *
 * Body: { endpoint, keys: { p256dh, auth }, userAgent?, platform?, deviceLabel? }
 */
export async function POST(request: NextRequest) {
  let session;
  try { session = await getSession(request); }
  catch { return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 }); }

  const body = await request.json().catch(() => null);
  const endpoint: string | undefined = body?.endpoint;
  const p256dh: string | undefined = body?.keys?.p256dh;
  const auth: string | undefined = body?.keys?.auth;

  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: 'INVALID_SUBSCRIPTION' }, { status: 400 });
  }

  // Métadonnées minimisées (§19.2) : UA tronqué, pas de localisation.
  const userAgent = typeof body?.userAgent === 'string' ? body.userAgent.slice(0, 160) : null;
  const platform = typeof body?.platform === 'string' ? body.platform.slice(0, 40) : null;
  const deviceLabel = typeof body?.deviceLabel === 'string' ? body.deviceLabel.slice(0, 60) : null;

  await db.insert(pushSubscriptions).values({
    userId: session.userId,
    endpoint,
    p256dhKey: p256dh,
    authKey: auth,
    userAgent,
    platform,
    deviceLabel,
    status: 'active',
    failureCount: 0,
  }).onConflictDoUpdate({
    target: pushSubscriptions.endpoint,
    set: {
      userId: session.userId,
      p256dhKey: p256dh,
      authKey: auth,
      userAgent,
      platform,
      deviceLabel,
      status: 'active',
      failureCount: 0,
      updatedAt: new Date(),
    },
  });

  return NextResponse.json({ ok: true });
}

/**
 * GET /api/push/subscriptions  (CDC §13.2 / §10.3)
 * Liste minimisée des appareils de l'utilisateur (aucune clé exposée).
 */
export async function GET(request: NextRequest) {
  let session;
  try { session = await getSession(request); }
  catch { return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 }); }

  const rows = await db
    .select({
      id: pushSubscriptions.id,
      platform: pushSubscriptions.platform,
      deviceLabel: pushSubscriptions.deviceLabel,
      status: pushSubscriptions.status,
      lastSuccessAt: pushSubscriptions.lastSuccessAt,
      createdAt: pushSubscriptions.createdAt,
    })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, session.userId), eq(pushSubscriptions.status, 'active')))
    .orderBy(desc(pushSubscriptions.lastSuccessAt));

  return NextResponse.json({ devices: rows });
}
