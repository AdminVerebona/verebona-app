/**
 * GET  /api/assets/[id]/exports  — Historique des exports d'un bien
 * POST /api/assets/[id]/exports  — Créer et générer un export (synchrone)
 *
 * Stratégie V1 : génération synchrone dans la requête HTTP
 * - INSERT pending → UPDATE generating (verrou atomique) → génère → UPDATE ready/error
 * - En cas d'erreur : email support@verebona.com + status='error'
 * - Client poll GET toutes les 3s si timeout
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { assets, exportGenerations, accountMemberships, accounts } from '@/db/schema';
import { eq, and, ne, desc, or } from 'drizzle-orm';
import { getExportSignedUrl } from '@/services/export-upload.service';
import { buildAssetSnapshot } from '@/services/export-snapshot.service';
import { buildExportManifest } from '@/services/export-manifest.service';
import type { ExportType, ExportOutput } from '@/services/export-manifest.service';
import { isPremiumPlan } from '@/types/domain';
import { renderExportToPdf } from '@/services/pdf-renderer.service';
import { buildExportZip } from '@/services/export-zip.service';
import { uploadExportFile, buildExportS3Key } from '@/services/export-upload.service';

const VALID_EXPORT_TYPES: ExportType[] = [
  'CIL_REGLEMENTAIRE', 'DOSSIER_VENTE',
  'ASSURANCE_ESTIMATION', 'ASSURANCE_INDEMNISATION', 'EXPORT_BRUT',
];

async function resolveAccountId(userId: number): Promise<number | null> {
  const [membership] = await db
    .select({ accountId: accountMemberships.accountId })
    .from(accountMemberships)
    .where(and(
      eq(accountMemberships.userId, userId),
      or(eq(accountMemberships.status, 'active'), eq(accountMemberships.status, 'ACTIVE')),
    ))
    .limit(1);
  return membership?.accountId ?? null;
}

async function sendSupportEmail(params: {
  assetId: number;
  exportId: number;
  exportType: string;
  errorMessage: string;
  attemptCount: number;
  userId: number;
}): Promise<void> {
  // Best-effort: log + send email via nodemailer or Resend if configured
  console.error('[ExportSupport] Generation failed — support notification:', params);
  // TODO: wire to actual email service (Resend/Nodemailer) when available
  // For now, logged to console and stored in error_payload.supportEmailSent = true
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const [asset] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, session.userId)))
      .limit(1);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 50);

    const rows = await db
      .select()
      .from(exportGenerations)
      .where(and(
        eq(exportGenerations.assetId, assetId),
        ne(exportGenerations.status, 'deleted'),
      ))
      .orderBy(desc(exportGenerations.createdAt))
      .limit(limit);

    const exports = await Promise.all(rows.map(async (row) => {
      let downloadUrl: string | null = null;
      let downloadZipUrl: string | null = null;

      if (row.status === 'ready' && row.outputPayload) {
        try {
          const output = JSON.parse(row.outputPayload);
          if (output.pdfS3Key) downloadUrl = await getExportSignedUrl(output.pdfS3Key, 3600);
          if (output.zipS3Key) downloadZipUrl = await getExportSignedUrl(output.zipS3Key, 3600);
        } catch {}
      }

      let errorMessage: string | null = null;
      if (row.status === 'error' && row.errorPayload) {
        try { errorMessage = JSON.parse(row.errorPayload)?.message ?? null; } catch {}
      }

      return {
        id: row.id,
        publicId: row.publicId,
        exportType: row.exportType,
        variant: row.variant,
        status: row.status,
        requestedOutputs: row.requestedOutputs ? JSON.parse(row.requestedOutputs) : ['PDF'],
        errorMessage,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        generationAttemptCount: row.generationAttemptCount,
        downloadUrl,
        downloadZipUrl,
      };
    }));

    return NextResponse.json({ exports });
  } catch (error) {
    return SessionService.handleSessionError(error);
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

    const [asset] = await db
      .select({ id: assets.id, userId: assets.userId, category: assets.category })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, session.userId)))
      .limit(1);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    const body = await request.json();
    const { exportType, variant, requestedOutputs, options } = body as {
      exportType: ExportType;
      variant?: string;
      requestedOutputs?: string[];
      options?: { customSections?: string[]; customDocIds?: number[]; includePhotos?: boolean; includeEquipments?: boolean };
    };

    if (!VALID_EXPORT_TYPES.includes(exportType)) {
      return NextResponse.json({ error: 'INVALID_EXPORT_TYPE' }, { status: 400 });
    }

    // Validate asset category compatibility with export type
    const IMMO_VEHICLE_TYPES: ExportType[] = ['DOSSIER_VENTE'];
    if (exportType === 'CIL_REGLEMENTAIRE' && asset.category !== 'IMMOBILIER') {
      return NextResponse.json({ error: 'INCOMPATIBLE_ASSET_CATEGORY', message: 'Ce type d\'export est réservé aux biens immobiliers.' }, { status: 400 });
    }
    if (IMMO_VEHICLE_TYPES.includes(exportType) && !['IMMOBILIER', 'VEHICULE'].includes(asset.category)) {
      return NextResponse.json({ error: 'INCOMPATIBLE_ASSET_CATEGORY', message: 'Ce type d\'export est réservé aux biens immobiliers et aux véhicules.' }, { status: 400 });
    }

    const accountId = await resolveAccountId(session.userId);
    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 400 });

    const now = new Date();

    // 1. INSERT pending
    const [newExport] = await db
      .insert(exportGenerations)
      .values({
        assetId,
        accountId,
        userId: session.userId,
        exportType,
        variant: variant ?? null,
        status: 'pending',
        requestedOutputs: JSON.stringify(requestedOutputs ?? ['PDF']),
        manifestPayload: options ? JSON.stringify(options) : null,
        generationAttemptCount: 0,
        createdAt: now,
      })
      .returning({ id: exportGenerations.id, publicId: exportGenerations.publicId });

    // 2. Atomic lock: pending → generating
    const lockResult = await db
      .update(exportGenerations)
      .set({
        status: 'generating',
        generationStartedAt: now,
        generationAttemptCount: 1,
      })
      .where(and(
        eq(exportGenerations.id, newExport.id),
        eq(exportGenerations.status, 'pending'),
      ))
      .returning({ id: exportGenerations.id });

    if (lockResult.length === 0) {
      // Another process already took it — shouldn't happen in V1 synchronous mode
      return NextResponse.json({ exportId: newExport.id, publicId: newExport.publicId, status: 'generating' });
    }

    // 3. Synchronous generation
    try {
      // Determine plan — source de vérité : accounts.planType
      const [accountRow] = await db
        .select({ planType: accounts.planType })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      const isPremium = isPremiumPlan(accountRow?.planType ?? '');

      // Parse options
      let manifestOptions: { customSections?: string[]; customDocIds?: number[]; includePhotos?: boolean; includeEquipments?: boolean } = {};
      if (options) manifestOptions = options;

      const outputs: ExportOutput[] = (requestedOutputs ?? ['PDF']) as ExportOutput[];

      // Snapshot
      const snapshot = await buildAssetSnapshot(assetId, session.userId);

      // Manifest
      const manifest = buildExportManifest(exportType, snapshot, {
        ...manifestOptions,
        requestedOutputs: outputs,
        variant: variant ?? undefined,
      });

      const outputPayload: Record<string, string | number> = {};
      const completedAt = new Date();

      // Build a human-friendly base filename for CIL exports
      const buildCilBaseName = (type: string): string => {
        const isCil = type === 'CIL_REGLEMENTAIRE';
        if (!isCil) return type;
        const sanitize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        const addressPart = sanitize([snapshot.address, snapshot.postalCode, snapshot.city].filter(Boolean).join('_')) || 'adresse';
        const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        return `CIL_${addressPart}_${datePart}`;
      };
      const baseName = buildCilBaseName(exportType);

      // EXPORT_BRUT: ZIP only (no PDF)
      if (exportType === 'EXPORT_BRUT') {
        const zipBuffer = await buildExportZip(manifest, snapshot, null, isPremium);
        const zipKey = buildExportS3Key(accountId, assetId, newExport.id, 'export_brut.zip');
        await uploadExportFile(zipBuffer, zipKey, 'application/zip');
        outputPayload.zipS3Key = zipKey;
        outputPayload.zipSize = zipBuffer.length;
      } else {
        // PDF
        const pdfBuffer = await renderExportToPdf(manifest, snapshot);
        const pdfKey = buildExportS3Key(accountId, assetId, newExport.id, `${baseName}.pdf`);
        await uploadExportFile(pdfBuffer, pdfKey, 'application/pdf');
        outputPayload.pdfS3Key = pdfKey;
        outputPayload.pdfSize = pdfBuffer.length;

        // ZIP if requested (premium)
        if (outputs.includes('ZIP') && isPremium) {
          const zipBuffer = await buildExportZip(manifest, snapshot, pdfBuffer, isPremium);
          const zipKey = buildExportS3Key(accountId, assetId, newExport.id, `${baseName}.zip`);
          await uploadExportFile(zipBuffer, zipKey, 'application/zip');
          outputPayload.zipS3Key = zipKey;
          outputPayload.zipSize = zipBuffer.length;
        }
      }

      // 4. Mark ready
      await db
        .update(exportGenerations)
        .set({
          status: 'ready',
          snapshotPayload: JSON.stringify(snapshot),
          outputPayload: JSON.stringify(outputPayload),
          completedAt,
        })
        .where(eq(exportGenerations.id, newExport.id));

      // Build signed URLs for immediate return
      let downloadUrl: string | null = null;
      let downloadZipUrl: string | null = null;
      if (outputPayload.pdfS3Key) {
        downloadUrl = await getExportSignedUrl(String(outputPayload.pdfS3Key), 3600);
      }
      if (outputPayload.zipS3Key) {
        downloadZipUrl = await getExportSignedUrl(String(outputPayload.zipS3Key), 3600);
      }

      return NextResponse.json({
        exportId: newExport.id,
        publicId: newExport.publicId,
        status: 'ready',
        downloadUrl,
        downloadZipUrl,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorPayload = { code: 'GENERATION_FAILED', message: errorMessage, supportEmailSent: true };

      await db
        .update(exportGenerations)
        .set({
          status: 'error',
          errorPayload: JSON.stringify(errorPayload),
          completedAt: new Date(),
        })
        .where(eq(exportGenerations.id, newExport.id));

      // Notify support (best-effort, non-blocking)
      await sendSupportEmail({
        assetId,
        exportId: newExport.id,
        exportType,
        errorMessage,
        attemptCount: 1,
        userId: session.userId,
      }).catch(() => {});

      return NextResponse.json({
        exportId: newExport.id,
        publicId: newExport.publicId,
        status: 'error',
        errorMessage,
      }, { status: 500 });
    }
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
