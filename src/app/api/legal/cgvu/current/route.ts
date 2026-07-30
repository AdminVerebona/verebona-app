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
import { logDatabaseError } from '@/lib/database-diagnostic';

export const dynamic = 'force-dynamic';

export async function GET() {
  await ensureMigrations();

  let current;
  try {
    current = await getCurrentVersion();
  } catch (e) {
    // Une erreur ici signale presque toujours un schéma incomplet : la table
    // `legal_document_versions` est créée par la migration 0115. Un 500 nu
    // obligeait à fouiller les journaux pour l'établir.
    const { reference, diagnostic } = logDatabaseError('CGVU', e);
    return NextResponse.json(
      {
        error: 'Les conditions générales sont momentanément indisponibles.',
        code: 'LEGAL_UNAVAILABLE',
        reference,
        ...(diagnostic.schemaHint ? { schemaHint: diagnostic.schemaHint } : {}),
      },
      { status: 503 },
    );
  }

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
