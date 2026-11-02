/**
 * POST /api/me/legal/cguv/accept — réacceptation explicite des CGUV (lot 102B).
 *
 * Corps : { versionCode } = version AFFICHÉE à l'utilisateur (§18). Si une
 * autre version est entrée en vigueur entre-temps : 409 VERSION_CHANGED avec
 * la nouvelle version, rien n'est enregistré. Preuve : version + permalien +
 * empreinte + date + contexte VERSION_UPDATE + canal (web / mobile).
 * Toujours permise pendant la réacceptation (`lib/legal/reacceptance-gate`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { invalidateUserReadCache } from '@/lib/server-cache';
import { readClientContext } from '@/lib/mobile/client-context';
import { channelFrom } from '@/lib/legal/public-legal';
import { acceptCurrentCguv } from '@/services/legal/cguv-reacceptance.service';

export async function POST(req: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  const body = await req.json().catch(() => null) as { versionCode?: unknown } | null;
  const versionCode = typeof body?.versionCode === 'string' ? body.versionCode.trim().slice(0, 80) : '';
  if (!versionCode) {
    return NextResponse.json({ code: 'VERSION_REQUIRED', message: 'Version des CGUV affichée manquante.' }, { status: 400 });
  }
  await ensureMigrations();
  const result = await acceptCurrentCguv({
    userId: session.userId,
    presentedVersionCode: versionCode,
    channel: channelFrom(readClientContext(req).client, req.headers.get('user-agent')),
    // §9 : ni adresse IP ni agent stockés ici (non collectés à des fins de sécurité pour ce geste).
  });
  if (!result.ok) {
    if (result.code === 'VERSION_CHANGED') {
      return NextResponse.json({
        code: 'VERSION_CHANGED',
        message: 'Une nouvelle version des CGUV vient d’entrer en vigueur : lisez-la avant de l’accepter.',
        current: result.current,
      }, { status: 409 });
    }
    return NextResponse.json({ code: 'NO_CURRENT_VERSION', message: 'Les CGUV sont momentanément indisponibles. Réessayez dans un instant.' }, { status: 503 });
  }
  invalidateUserReadCache(session.userId);
  return NextResponse.json({
    accepted: true,
    versionCode: result.versionCode,
    permalinkUrl: result.permalinkUrl,
    sha256: result.textSha256,
    acceptedAt: result.acceptedAt,
    alreadyRecorded: result.alreadyRecorded,
  });
}
