/**
 * POST /api/legal/acceptances — CDC 7 §15 (utilisateur connecté).
 *
 * Enregistre l'acceptation d'une version PRÉCISE, transmise par l'appelant.
 * Le serveur ne substitue jamais « la version courante » au code reçu : le §18
 * l'interdit lorsque la version a changé pendant le parcours.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { recordAcceptance, isAcceptanceContext } from '@/services/legal/legal-acceptances.service';
import { LegalVersionError } from '@/services/legal';

export async function POST(req: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  await ensureMigrations();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Corps de requête invalide.', code: 'BAD_REQUEST' }, { status: 400 });
  }

  const versionCode = typeof body.versionCode === 'string' ? body.versionCode.trim() : '';
  const context = body.context;

  if (!versionCode) {
    return NextResponse.json(
      { error: 'Le code de version est obligatoire.', code: 'MISSING_VERSION_CODE' },
      { status: 400 },
    );
  }
  if (!isAcceptanceContext(context)) {
    return NextResponse.json(
      { error: "Contexte d'acceptation invalide.", code: 'INVALID_CONTEXT' },
      { status: 400 },
    );
  }

  try {
    const record = await recordAcceptance({
      userId: session.userId,
      versionCode,
      context,
      subscriptionId: typeof body.subscriptionId === 'number' ? body.subscriptionId : null,
      offerCode: typeof body.offerCode === 'string' ? body.offerCode : null,
      // §9 : l'adresse IP n'est retenue que parce qu'elle est déjà journalisée
      // à des fins de sécurité par ailleurs.
      ipAddress: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: req.headers.get('user-agent'),
    });

    // 200 et non 201 lorsque l'appel est rejoué : rien n'a été créé (§18).
    return NextResponse.json(
      {
        acceptanceId: record.id,
        versionCode: record.versionCode,
        permalink: record.permalink,
        acceptedAt: record.acceptedAt,
        alreadyRecorded: record.alreadyRecorded,
      },
      { status: record.alreadyRecorded ? 200 : 201 },
    );
  } catch (e) {
    if (e instanceof LegalVersionError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    console.error('[legal] enregistrement d’acceptation impossible :', (e as Error).message);
    return NextResponse.json(
      { error: 'Une erreur interne est survenue.', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
