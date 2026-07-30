/**
 * POST /api/admin/legal/cgvu/versions/{id}/set-current — CDC 7 §6.1 et §15.
 *
 * Désigne une version publiée comme version en vigueur. L'ancienne passe à
 * ARCHIVED et reste accessible par son permalien (§3.3) : c'est tout l'objet
 * du dispositif.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { setCurrentVersion, LegalVersionError } from '@/services/legal';

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

  try {
    const version = await setCurrentVersion(id, adminId);
    return NextResponse.json({
      version: {
        id: version.id,
        versionCode: version.versionCode,
        status: version.status,
        permalink: version.permalink,
      },
    });
  } catch (e) {
    if (e instanceof LegalVersionError) {
      const status = e.code === 'NOT_FOUND' ? 404 : 400;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error('[legal-admin] changement de version courante impossible :', (e as Error).message);
    return NextResponse.json({ error: 'Une erreur interne est survenue.', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
