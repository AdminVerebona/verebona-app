/**
 * GET /api/me/legal/acceptances — CDC 7 §11 et §15 ; lot 102B.
 *
 * Alimente « Mon compte → Informations légales » : version, date, contexte,
 * canal, permalien historique de la version acceptée (site public, ou archive
 * figée d'une version antérieure) et empreinte du texte accepté. Une preuve
 * antérieure au lot 102B est marquée « historique » (aucune empreinte inventée).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { listUserAcceptances } from '@/services/legal/legal-acceptances.service';

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  await ensureMigrations();
  const acceptances = await listUserAcceptances(session.userId);

  return NextResponse.json({
    acceptances: acceptances.map((a) => ({
      acceptanceId: a.id,
      versionCode: a.versionCode,
      title: a.title,
      acceptedAt: a.acceptedAt,
      context: a.context,
      channel: a.channel,
      offerCode: a.offerCode,
      permalink: a.permalinkUrl,
      permalinkUrl: a.permalinkUrl,
      sha256: a.textSha256,
      proofStatus: a.proofStatus,
    })),
  });
}
