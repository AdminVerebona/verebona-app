/**
 * GET /api/users/me/gdpr-export/download — téléchargement de l'archive
 * « Mes données » (CDC BO GDP-022 : lien sécurisé et temporaire).
 *
 * Le lien affiché à l'utilisateur est cette route, protégée par la session :
 * il ne vaut rien hors de son compte. Elle redirige vers une URL S3
 * présignée de courte durée (GDPR_EXPORT_LINK_TTL_SECONDS), générée à chaque
 * clic ; l'archive elle-même expire après GDPR_EXPORT_RETENTION_HOURS.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { getDownloadUrl } from '@/services/gdpr/gdpr-export.service';

export async function GET(request: NextRequest) {
  let userId: number;
  try {
    userId = (await SessionService.getSession(request)).userId;
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
  try {
    const url = await getDownloadUrl(userId);
    if (!url) {
      return NextResponse.json(
        { error: 'GDPR_EXPORT_UNAVAILABLE', message: 'Aucune archive disponible : elle a expiré ou n’est pas encore prête.' },
        { status: 404 },
      );
    }
    const res = NextResponse.redirect(url, 302);
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('Referrer-Policy', 'no-referrer');
    return res;
  } catch (error) {
    console.error('[users/me/gdpr-export/download] :', error);
    return NextResponse.json(
      { error: 'GDPR_EXPORT_DOWNLOAD_FAILED', message: 'Le téléchargement est momentanément indisponible. Réessayez.' },
      { status: 500 },
    );
  }
}
