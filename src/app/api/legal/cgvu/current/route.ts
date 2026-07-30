/**
 * GET /api/legal/cgvu/current — CDC 7 §15 (public).
 *
 * Métadonnées de la version en vigueur. Ne renvoie PAS le contenu : la page
 * `/cgvu` sert le document figé lui-même, et dupliquer le texte dans une
 * réponse JSON créerait une seconde source susceptible de diverger.
 */
import { NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { getCurrentVersion, buildDownloadFilename } from '@/services/legal';

export const dynamic = 'force-dynamic';

export async function GET() {
  await ensureMigrations();
  const current = await getCurrentVersion();

  if (!current) {
    return NextResponse.json(
      { error: 'Aucune version publiée.', code: 'NO_CURRENT_VERSION' },
      { status: 503 },
    );
  }

  return NextResponse.json({
    versionCode: current.versionCode,
    title: current.title,
    effectiveAt: current.effectiveAt,
    publishedAt: current.publishedAt,
    changeSummary: current.changeSummary,
    requiresReacceptance: current.requiresReacceptance,
    permalink: current.permalink,
    downloadUrl: `/api/legal/cgvu/versions/${current.versionCode}/download`,
    downloadFilename: buildDownloadFilename(current.versionCode),
  });
}
