/**
 * GET /api/admin/ai/documents/[documentId]
 * Détail d'un document — historique analyses, pipeline, fallback, coûts, logs
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles, accounts, aiOperation, aiPipelineStep, aiAnalysisVersion } from '@/db/schema';
import { eq, and, desc, asc } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  try {
    await requireAdmin(request);
    const { documentId: docIdStr } = await params;
    const assetFileId = parseInt(docIdStr);
    if (isNaN(assetFileId)) return NextResponse.json({ error: 'ID invalide' }, { status: 400 });

    const [file, operations] = await Promise.all([
      db.select({
        id: assetFiles.id,
        fileName: assetFiles.filename,
        accountId: assetFiles.accountId,
        uploadStatus: assetFiles.uploadStatus,
        analysisStatus: assetFiles.analysisState,
        analyzedAt: assetFiles.lastAnalysisAt,
      })
        .from(assetFiles)
        .where(eq(assetFiles.id, assetFileId))
        .limit(1)
        .then(r => r[0]),

      db.select()
        .from(aiOperation)
        .where(eq(aiOperation.assetFileId, assetFileId))
        .orderBy(desc(aiOperation.startedAt)),
    ]);

    if (!file) return NextResponse.json({ error: 'Document introuvable' }, { status: 404 });

    const account = await db
      .select({ name: accounts.name })
      .from(accounts)
      .where(eq(accounts.id, file.accountId!))
      .limit(1)
      .then(r => r[0]);

    // Charger les étapes pour chaque opération
    const operationIds = operations.map(o => o.id);
    const steps = operationIds.length > 0
      ? await db.select()
          .from(aiPipelineStep)
          .where(eq(aiPipelineStep.operationId, operations[0].id))
          .orderBy(asc(aiPipelineStep.stepOrder))
      : [];

    // Versions d'analyse
    const analysisVersions = await db
      .select()
      .from(aiAnalysisVersion)
      .where(eq(aiAnalysisVersion.assetFileId, assetFileId))
      .orderBy(desc(aiAnalysisVersion.versionNumber));

    const totalCostMicros = operations.reduce((s, o) => s + (o.totalCostMicros ?? 0), 0);

    return NextResponse.json({
      assetFileId,
      fileName: file.fileName,
      accountId: file.accountId,
      accountName: account?.name ?? `#${file.accountId}`,
      currentAnalysisStatus: file.analysisStatus,
      lastAnalyzedAt: file.analyzedAt,
      analysisVersions,
      operations: operations.map(op => ({
        ...op,
        steps: steps.filter(s => s.operationId === op.id),
        analysisVersions: analysisVersions.filter(v => v.operationId === op.id),
      })),
      totalCostMicros,
    });
  } catch (error: any) {
    if (error?.message === 'INSUFFICIENT_PERMISSIONS') {
      return NextResponse.json({ error: 'Accès refusé' }, { status: 403 });
    }
    console.error('[GET /api/admin/ai/documents/[documentId]]', error);
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}
