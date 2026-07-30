/**
 * POST /api/admin/legal/cgvu/drafts/{id}/publish — CDC 7 §6.2 et §15.
 *
 * Publie un brouillon selon les neuf étapes du §6.2. Opération irréversible :
 * la version devient immuable, son code et sa clé de stockage ne pourront
 * jamais être réutilisés.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { publishVersion, LegalVersionError } from '@/services/legal';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let adminId: number;
  try {
    adminId = await SessionService.requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const { id } = await params;
  await ensureMigrations();

  let setAsCurrent = false;
  try {
    const body = await req.json();
    setAsCurrent = body?.setAsCurrent === true;
  } catch {
    // Corps absent : publication sans désignation comme version courante.
  }

  try {
    const published = await publishVersion(id, { actorUserId: adminId, setAsCurrent });
    return NextResponse.json({
      version: {
        id: published.id,
        versionCode: published.versionCode,
        status: published.status,
        permalink: published.permalink,
        sha256: published.sha256,
        publishedAt: published.publishedAt,
      },
    });
  } catch (e) {
    if (e instanceof LegalVersionError) {
      const status =
        e.code === 'NOT_FOUND' ? 404 : e.code === 'ALREADY_PUBLISHED' ? 409 : 400;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error('[legal-admin] publication impossible :', (e as Error).message);
    return NextResponse.json({ error: 'Une erreur interne est survenue.', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
