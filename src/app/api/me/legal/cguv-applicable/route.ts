/**
 * GET /api/me/legal/cguv-applicable — version applicable et réacceptation (lot 102B).
 *
 * Version en vigueur (métadonnées, sans texte), déjà acceptée ou non, et état
 * de réacceptation (version substantielle non acceptée → écran dédié).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { getApplicableVersion } from '@/services/legal/legal-acceptances.service';
import { getPublicCurrentCguv } from '@/services/legal/cguv-referential.service';
import { getReacceptanceState } from '@/services/legal/cguv-reacceptance.service';

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  await ensureMigrations();
  const [applicable, current, reacceptance] = await Promise.all([
    getApplicableVersion(session.userId),
    getPublicCurrentCguv(),
    getReacceptanceState(session.userId),
  ]);
  if (!applicable || !current) {
    return NextResponse.json({ error: 'Aucune version des CGUV n’est connue.', code: 'NO_CURRENT_VERSION', reacceptance }, { status: 503 });
  }
  return NextResponse.json({
    versionCode: current.versionCode,
    title: current.title,
    effectiveAt: current.effectiveAt,
    permalink: current.permalinkUrl,
    permalinkUrl: current.permalinkUrl,
    sha256: current.sha256,
    changeSummary: current.changeSummary,
    alreadyAccepted: applicable.alreadyAccepted,
    acceptanceRequired: applicable.acceptanceRequired,
    requiresReacceptance: applicable.requiresReacceptance,
    reacceptance,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
