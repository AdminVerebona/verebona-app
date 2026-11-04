/**
 * GET /api/me/legal/acceptances — CDC 7 §11 et §15 ; lot 102B.
 *
 * Alimente « Mon compte → Informations légales » : version, date, contexte,
 * canal, lien PUBLIC de consultation de la version acceptée (lot 108L : jamais
 * l'application) et, à part, la preuve immuable (URL initiale, empreinte). Une preuve
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
      // Lot 108L : lien de CONSULTATION public vérifié (`/legal/cguv/versions/{code}`),
      // `null` tant que le texte de cette version n'est pas sur le site public.
      consultationUrl: a.consultationUrl,
      // Preuve IMMUABLE (URL initiale, empreinte, date, contexte, canal) : affichée
      // à part, jamais réécrite, jamais utilisée comme lien.
      proof: { permalinkUrl: a.permalinkUrl, sha256: a.textSha256, acceptedAt: a.acceptedAt, context: a.context, channel: a.channel },
      sha256: a.textSha256,
      proofStatus: a.proofStatus,
    })),
  });
}
