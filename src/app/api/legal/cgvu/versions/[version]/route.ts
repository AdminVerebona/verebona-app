/**
 * GET /api/legal/cgvu/versions/{version} — CDC 7 §15 (public).
 *
 * Métadonnées d'une version figée. Comme le permalien, ne retombe jamais sur
 * la version courante lorsque le code est inconnu (§16.3).
 */
import { NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { getVersionByCode, isValidVersionCode, buildDownloadFilename } from '@/services/legal';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ version: string }> },
) {
  const { version } = await params;

  if (!isValidVersionCode(version)) {
    return NextResponse.json(
      { error: 'Identifiant de version invalide.', code: 'INVALID_VERSION_CODE' },
      { status: 400 },
    );
  }

  await ensureMigrations();
  const found = await getVersionByCode(version);

  if (!found) {
    return NextResponse.json(
      { error: 'Version introuvable.', code: 'VERSION_NOT_FOUND' },
      { status: 404 },
    );
  }

  return NextResponse.json({
    versionCode: found.versionCode,
    title: found.title,
    status: found.status,
    effectiveAt: found.effectiveAt,
    publishedAt: found.publishedAt,
    changeSummary: found.changeSummary,
    permalink: found.permalink,
    downloadUrl: `/api/legal/cgvu/versions/${found.versionCode}/download`,
    downloadFilename: buildDownloadFilename(found.versionCode),
  });
}
