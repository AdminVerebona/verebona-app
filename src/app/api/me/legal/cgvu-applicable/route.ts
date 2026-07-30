/**
 * GET /api/me/legal/cgvu-applicable — CDC 7 §8.2, §8.3 et §15.
 *
 * Indique la version applicable et s'il faut la faire accepter. Consommée
 * avant une souscription payante : le §8.2 demande de ne pas faire recocher
 * une version que l'utilisateur a déjà acceptée pendant son essai.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { getApplicableVersion } from '@/services/legal/legal-acceptances.service';
import { buildDownloadFilename } from '@/services/legal';

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  await ensureMigrations();
  const applicable = await getApplicableVersion(session.userId);

  if (!applicable) {
    return NextResponse.json(
      { error: 'Aucune version publiée.', code: 'NO_CURRENT_VERSION' },
      { status: 503 },
    );
  }

  return NextResponse.json({
    versionCode: applicable.versionCode,
    title: applicable.title,
    effectiveAt: applicable.effectiveAt,
    permalink: applicable.permalink,
    downloadUrl: `/api/legal/cgvu/versions/${applicable.versionCode}/download`,
    downloadFilename: buildDownloadFilename(applicable.versionCode),
    alreadyAccepted: applicable.alreadyAccepted,
    acceptanceRequired: applicable.acceptanceRequired,
    requiresReacceptance: applicable.requiresReacceptance,
  });
}
