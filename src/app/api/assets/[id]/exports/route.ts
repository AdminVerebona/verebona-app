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
 * Lot 111B : `regenerate: true` (bouton « Régénérer » de l'écran de
 * préparation) remplace les générations encore actives du MÊME dossier
 * (même bien, type, contexte métier et utilisateur) ; sans ce paramètre,
 * création ou rejeu idempotent comme avant (`enqueueGeneration`).
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
import { exportGenerations, users } from '@/db/schema';
import { eq, desc, inArray } from 'drizzle-orm';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import { EXPORT_ERROR_MESSAGES, exportRouteError } from '@/services/exports/export-errors';
import { requestExportForAsset } from '@/services/exports/export-request.facade';
import { toGenerationDto } from '@/services/exports/v12/generation/status';
import { exportRateLimitResponse } from '@/services/exports/v12/generation/rate-limit';
import { loadReplacementRefs } from '@/services/exports/v12/generation/repository';

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
    // Lot 111B : lien des générations remplacées vers la nouvelle référence.
    const replacements = await loadReplacementRefs(rows, assetId);
    const exports = rows.map((row) => toGenerationDto(row, {
      authorName: nameOf.get(row.userId) ?? null, now,
      replacement: row.replacedByGenerationId ? replacements.get(row.replacedByGenerationId) ?? null : null,
    }));
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

    // Trello #753 (W28) : le corps de la demande vit dans la façade métier partagée avec l'Assistant
    // (`export-request.facade`) — mêmes contrôles, mêmes écritures ; ici, seule la traduction en réponse HTTP.
    const issue = await requestExportForAsset({ asset, userId: session.userId, body });
    switch (issue.kind) {
      case 'invalid_type':
        return NextResponse.json({ error: 'INVALID_EXPORT_TYPE', code: 'INVALID_EXPORT_TYPE', message: EXPORT_ERROR_MESSAGES.INVALID_EXPORT_TYPE }, { status: 400 });
      case 'raw_ready': {
        const dto = issue.dto;
        return NextResponse.json({ exportId: dto.id, publicId: dto.publicId, status: dto.status, generationStatus: dto.generationStatus, downloadUrl: dto.downloadUrl, downloadZipUrl: dto.downloadZipUrl, pollUrl: dto.pollUrl });
      }
      case 'raw_failed':
        return NextResponse.json({
          exportId: issue.exportId,
          publicId: issue.publicId,
          status: 'error',
          generationStatus: 'failed',
          errorCode: 'GENERATION_FAILED',
          errorMessage: EXPORT_ERROR_MESSAGES.GENERATION_FAILED,
          code: 'GENERATION_FAILED',
          message: EXPORT_ERROR_MESSAGES.GENERATION_FAILED,
        }, { status: 500 });
      case 'refused':
        // `details` : lu par le client (`ApiClientError.details`) — blocages de seuil, pièces ZIP (ALT-002).
        return NextResponse.json({ error: issue.code, code: issue.code, message: issue.message, ...(issue.extra ?? {}), details: issue.extra ?? null }, { status: issue.status });
      case 'queued': {
        const dto = issue.dto;
        return NextResponse.json({
          exportId: dto.id,
          publicId: dto.publicId,
          generationPublicId: dto.publicId,
          status: dto.status,
          generationStatus: dto.generationStatus,
          pollUrl: dto.pollUrl,
          downloadUrl: null,
          downloadZipUrl: null,
          warnings: issue.warnings.map((w) => ({ code: w.code, message: w.message })),
          reused: issue.reused,
          // Lot 111B : générations remplacées par cette régénération explicite.
          replaced: issue.replaced.map((r) => ({ publicId: r.publicId, outcome: r.outcome })),
        }, { status: 202 });
      }
    }
  } catch (error) {
    return exportRouteError(error, '[Exports POST]');
  }
}
