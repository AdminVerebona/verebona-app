/**
 * POST /api/webhooks/resend — événements de livraison Resend (lot 57A, P1-D).
 *
 * Public (pas de session) : authentifié par la SIGNATURE Svix, vérifiée avec
 * la variable d'environnement RESEND_WEBHOOK_SECRET (voir
 * `email-provider-events.service.ts`). Corps lu brut (la signature porte sur
 * les octets reçus). Réponses :
 *   · 200 : événement enregistré (ou rejoué : sans effet) ;
 *   · 401 : signature absente, fausse ou horodatage hors tolérance ;
 *   · 503 : secret non configuré (Resend réessaiera) ;
 *   · 400 : corps illisible.
 * Aucune donnée personnelle dans la réponse ni dans les journaux.
 */
import { NextRequest, NextResponse } from 'next/server';
import { recordResendEvent, verifySvixSignature } from '@/services/email/email-provider-events.service';

export async function POST(request: NextRequest) {
  const raw = await request.text();
  const check = verifySvixSignature(raw, {
    id: request.headers.get('svix-id'),
    timestamp: request.headers.get('svix-timestamp'),
    signature: request.headers.get('svix-signature'),
  });
  if (!check.ok) {
    console.warn(`[webhook resend] refusé : ${check.code}`);
    return NextResponse.json({ error: check.code }, { status: check.code === 'NOT_CONFIGURED' ? 503 : 401 });
  }
  let evt: unknown;
  try {
    evt = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'INVALID_BODY' }, { status: 400 });
  }
  try {
    const r = await recordResendEvent(request.headers.get('svix-id')!, evt as Parameters<typeof recordResendEvent>[1]);
    return NextResponse.json({ received: true, ...r });
  } catch (e) {
    console.error('[webhook resend] enregistrement impossible :', (e as Error)?.message ?? e);
    return NextResponse.json({ error: 'STORE_FAILED' }, { status: 500 });
  }
}
