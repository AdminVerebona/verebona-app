/**
 * GET  /api/assets/[id]/exports  — Historique des générations du bien (§17, DRH-002/003)
 * POST /api/assets/[id]/exports  — Demande de génération d'un dossier V12 (asynchrone)
 *
 * Dossiers prêts à l'emploi (CIL, DOSSIER_COMPLET, VENTE, LOCATION,
 * ASSURANCE_SOUSCRIPTION, ASSURANCE_SINISTRE ; anciens codes acceptés via
 * `normalizeExportCode`) : contrôles synchrones puis mise en file (`queued`,
 * réponse 202) ; le rendu HTML/CSS + Chromium est fait par le worker
 * (`services/exports/v12/generation`). Plus de PDFMonkey ni de jsPDF
 * (DEC-001/002, MIG-01/02).
 *
 * Corps accepté :
 *   - payload V12 (§17.2) : `{ exportType, choices: { outputFormat, sections:
 *     [{ id, enabled, items: [{ sourceType, sourceId, selected, mode }] }],
 *     acknowledgements } }` ;
 *   - tiroir historique : `{ exportType, requestedOutputs, options:
 *     { customDocIds, includePhotos } }` (pré-sélections du CDC appliquées).
 *
 * L'export de données brutes (EXPORT_BRUT, hors dossiers — EXC-001) reste
 * produit dans la requête (ZIP de fichiers), avec la même rétention.
 *
 * Accès par compte (`assets.accountId = session.currentAccountId`) : le
 * co-titulaire Duo voit l'historique et génère comme le titulaire (DRH-002).
 * Les liens de téléchargement pointent vers
 * `/api/export-generations/{publicId}/download`, qui revérifie les droits à
 * chaque demande (DRH-010).
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { exportGenerations, accounts, users } from '@/db/schema';
import { eq, desc, inArray } from 'drizzle-orm';
import { buildExportAssetSnapshot } from '@/services/exports/export-snapshot-source';
import { buildExportManifest } from '@/services/export-manifest.service';
import { isPremiumPlan } from '@/types/domain';
import { buildExportZip } from '@/services/export-zip.service';
import { uploadExportFile, buildExportS3Key } from '@/services/export-upload.service';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import { normalizeExportCode, EXPORT_BRUT_CODE } from '@/services/exports/catalog';
import {
  EXPORT_ERROR_MESSAGES, technicalErrorMessage, exportRouteError,
} from '@/services/exports/export-errors';
import { notifySupportOfExportFailure } from '@/services/exports/export-support-notifier';
import { toGenerationDto } from '@/services/exports/v12/generation/status';
import { exportRateLimitResponse } from '@/services/exports/v12/generation/rate-limit';
import { enqueueGeneration } from '@/services/exports/v12/generation/enqueue';
import { nudgeExportWorker } from '@/services/exports/v12/generation/worker';
import { EXPORT_RETENTION_DAYS } from '@/services/exports/v12/storage';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const asset = await findAccessibleAssetForExport(session, assetId);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND', code: 'ASSET_NOT_FOUND', message: EXPORT_ERROR_MESSAGES.ASSET_NOT_FOUND }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '50') || 50, 1), 50);

    // DRH-004/006 : entrées dont le fichier a été supprimé ou a expiré conservées, sans lien.
    const rows = await db
      .select()
      .from(exportGenerations)
      .where(eq(exportGenerations.assetId, assetId))
      .orderBy(desc(exportGenerations.createdAt))
      .limit(limit);

    // DRH-003 : auteur de chaque génération (titulaire ou co-titulaire Duo).
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const authors = userIds.length
      ? await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(inArray(users.id, userIds))
      : [];
    const nameOf = new Map(authors.map((a) => [a.id, [a.firstName, a.lastName].filter((x) => x?.trim()).join(' ') || null]));

    const now = new Date();
    const exports = rows.map((row) => toGenerationDto(row, { authorName: nameOf.get(row.userId) ?? null, now }));
    return NextResponse.json({ exports });
  } catch (error) {
    return exportRouteError(error, '[Exports GET]');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    // Limitation de débit par utilisateur (création de générations, EXPORT_BRUT compris).
    const limited = exportRateLimitResponse(session.userId);
    if (limited) return limited;

    const asset = await findAccessibleAssetForExport(session, assetId);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND', code: 'ASSET_NOT_FOUND', message: EXPORT_ERROR_MESSAGES.ASSET_NOT_FOUND }, { status: 404 });

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'INVALID_PAYLOAD', code: 'INVALID_PAYLOAD', message: 'Requête invalide.' }, { status: 400 });
    }

    const code = normalizeExportCode(body?.exportType);
    if (!code) {
      return NextResponse.json({ error: 'INVALID_EXPORT_TYPE', code: 'INVALID_EXPORT_TYPE', message: EXPORT_ERROR_MESSAGES.INVALID_EXPORT_TYPE }, { status: 400 });
    }

    if (code === EXPORT_BRUT_CODE) return generateRawExport(asset, session.userId, body);

    const result = await enqueueGeneration({ asset, userId: session.userId, code, body });
    if (!result.ok) {
      // `details` : lu par le client (`ApiClientError.details`) — blocages de seuil, pièces ZIP (ALT-002).
      return NextResponse.json({ error: result.code, code: result.code, message: result.message, ...(result.extra ?? {}), details: result.extra ?? null }, { status: result.status });
    }
    nudgeExportWorker();
    const dto = toGenerationDto(result.generation);
    return NextResponse.json({
      exportId: dto.id,
      publicId: dto.publicId,
      generationPublicId: dto.publicId,
      status: dto.status,
      generationStatus: dto.generationStatus,
      pollUrl: dto.pollUrl,
      downloadUrl: null,
      downloadZipUrl: null,
      warnings: result.warnings.map((w) => ({ code: w.code, message: w.message })),
      reused: result.reused,
    }, { status: 202 });
  } catch (error) {
    return exportRouteError(error, '[Exports POST]');
  }
}

/**
 * Export de données brutes (EXC-001, hors dossiers V12) : ZIP produit dans la
 * requête, sélection du tiroir respectée ; rétention de 30 jours.
 */
async function generateRawExport(
  asset: NonNullable<Awaited<ReturnType<typeof findAccessibleAssetForExport>>>,
  userId: number,
  body: Record<string, unknown>,
) {
  const accountId = asset.accountId;
  const options = (body.options ?? {}) as { customDocIds?: number[]; includePhotos?: boolean; includeEquipments?: boolean };
  const now = new Date();
  const [row] = await db.insert(exportGenerations).values({
    assetId: asset.id,
    accountId,
    userId,
    exportType: EXPORT_BRUT_CODE,
    variant: typeof body.variant === 'string' ? body.variant : null,
    status: 'generating',
    requestedOutputs: JSON.stringify(['ZIP']),
    manifestPayload: JSON.stringify(options),
    outputFormat: 'ZIP',
    generationAttemptCount: 1,
    generationStartedAt: now,
    createdAt: now,
  }).returning();

  try {
    const [accountRow] = await db.select({ planType: accounts.planType }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const isPremium = isPremiumPlan(accountRow?.planType ?? '');
    // X-02 (lot 16) : source canonique.
    const snapshot = await buildExportAssetSnapshot(asset.id, userId, { accountId }, 'EXPORT_BRUT');
    const manifest = buildExportManifest('EXPORT_BRUT', snapshot, { ...options, requestedOutputs: ['ZIP'] });
    const zipBuffer = await buildExportZip(manifest, snapshot, null, isPremium);
    const zipKey = buildExportS3Key(accountId, asset.id, row.id, 'export_brut.zip');
    await uploadExportFile(zipBuffer, zipKey, 'application/zip');
    const completedAt = new Date();
    const [done] = await db.update(exportGenerations).set({
      status: 'ready',
      outputPayload: JSON.stringify({ zipS3Key: zipKey, zipSize: zipBuffer.length }),
      fileKey: zipKey,
      fileSizeBytes: zipBuffer.length,
      expiresAt: new Date(completedAt.getTime() + EXPORT_RETENTION_DAYS * 86_400_000),
      metricsJson: {
        'generation.duration_ms': completedAt.getTime() - now.getTime(), 'generation.output_format': 'ZIP', 'generation.file_size_bytes': zipBuffer.length,
        ...(snapshot.dataSource ? { 'generation.data_source': snapshot.dataSource.source, 'generation.registry_version': snapshot.dataSource.registryVersion } : {}),
      },
      completedAt,
    }).where(eq(exportGenerations.id, row.id)).returning();
    const dto = toGenerationDto(done);
    return NextResponse.json({ exportId: dto.id, publicId: dto.publicId, status: dto.status, generationStatus: dto.generationStatus, downloadUrl: dto.downloadUrl, downloadZipUrl: dto.downloadZipUrl, pollUrl: dto.pollUrl });
  } catch (error) {
    const technicalMessage = technicalErrorMessage(error);
    console.error('[Exports POST] Export brut échoué :', { exportId: row.id, assetId: asset.id, error });
    const supportEmailSent = await notifySupportOfExportFailure({
      assetId: asset.id, exportId: row.id, exportType: EXPORT_BRUT_CODE, technicalMessage, attemptCount: 1, userId, accountId,
    });
    await db.update(exportGenerations).set({
      status: 'failed',
      errorCode: 'GENERATION_FAILED',
      errorPayload: JSON.stringify({ code: 'GENERATION_FAILED', message: EXPORT_ERROR_MESSAGES.GENERATION_FAILED, technicalMessage, supportEmailSent }),
      completedAt: new Date(),
    }).where(eq(exportGenerations.id, row.id));
    return NextResponse.json({
      exportId: row.id,
      publicId: row.publicId,
      status: 'error',
      generationStatus: 'failed',
      errorCode: 'GENERATION_FAILED',
      errorMessage: EXPORT_ERROR_MESSAGES.GENERATION_FAILED,
      code: 'GENERATION_FAILED',
      message: EXPORT_ERROR_MESSAGES.GENERATION_FAILED,
    }, { status: 500 });
  }
}
