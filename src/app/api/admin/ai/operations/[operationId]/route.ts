/**
 * GET /api/admin/ai/operations/[operationId]
 * Détail complet d'une opération IA avec toutes les étapes de pipeline
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { aiOperation, aiPipelineStep, aiAnalysisVersion, assetFiles } from '@/db/schema';
import { eq, asc, desc } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ operationId: string }> }
) {
  try {
    await requireAdmin(request);
    const { operationId: opIdStr } = await params;
    const operationId = parseInt(opIdStr);
    if (isNaN(operationId)) return NextResponse.json({ error: 'ID invalide' }, { status: 400 });

    const [operation, steps, analysisVersions] = await Promise.all([
      db.select()
        .from(aiOperation)
        .where(eq(aiOperation.id, operationId))
        .limit(1)
        .then(r => r[0]),

      db.select()
        .from(aiPipelineStep)
        .where(eq(aiPipelineStep.operationId, operationId))
        .orderBy(asc(aiPipelineStep.stepOrder)),

      db.select()
        .from(aiAnalysisVersion)
        .where(eq(aiAnalysisVersion.operationId, operationId))
        .orderBy(desc(aiAnalysisVersion.versionNumber)),
    ]);

    if (!operation) return NextResponse.json({ error: 'Opération introuvable' }, { status: 404 });

    // Nom du fichier si dispo
    let fileName: string | null = null;
    if (operation.assetFileId) {
      fileName = await db
        .select({ filename: assetFiles.filename })
        .from(assetFiles)
        .where(eq(assetFiles.id, operation.assetFileId))
        .limit(1)
        .then(r => r[0]?.filename ?? null);
    }

    return NextResponse.json({
      ...operation,
      fileName,
      steps,
      analysisVersions,
    });
  } catch (error: any) {
    if (error?.message === 'INSUFFICIENT_PERMISSIONS') {
      return NextResponse.json({ error: 'Accès refusé' }, { status: 403 });
    }
    console.error('[GET /api/admin/ai/operations/[operationId]]', error);
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}
