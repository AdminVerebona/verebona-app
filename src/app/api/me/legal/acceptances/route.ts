/**
 * GET /api/me/legal/acceptances — CDC 7 §11 et §15.
 *
 * Alimente la rubrique « Mon compte → Informations légales » : identifiant de
 * version, date d'acceptation, lien de consultation et de téléchargement.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { listUserAcceptances } from '@/services/legal/legal-acceptances.service';
import { buildDownloadFilename } from '@/services/legal';

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
      offerCode: a.offerCode,
      permalink: a.permalink,
      downloadUrl: `/api/legal/cgvu/versions/${a.versionCode}/download`,
      downloadFilename: buildDownloadFilename(a.versionCode),
    })),
  });
}
