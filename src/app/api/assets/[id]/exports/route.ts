/**
 * GET  /api/assets/[id]/exports  — Historique des exports d'un bien
 * POST /api/assets/[id]/exports  — Créer et générer un export (synchrone)
 *
 * Stratégie V1 : génération synchrone dans la requête HTTP
 * - INSERT pending → UPDATE generating (verrou atomique) → génère → UPDATE ready/error
 * - En cas d'erreur : notification réelle du support (SUPPORT_EMAIL) + status='error'
 *   ; l'utilisateur reçoit un message générique et un code (détail en journal)
 * - Client poll GET toutes les 3s si timeout
 *
 * Accès par compte (`assets.accountId = session.currentAccountId`) : le
 * co-titulaire Duo voit l'historique et génère comme le titulaire (DRH-002).
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { exportGenerations, accounts } from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getExportSignedUrl } from '@/services/export-upload.service';
import { buildAssetSnapshot } from '@/services/export-snapshot.service';
import { buildExportManifest } from '@/services/export-manifest.service';
import type { ExportType, ExportOutput } from '@/services/export-manifest.service';
import { isPremiumPlan } from '@/types/domain';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import { renderExportToPdf } from '@/services/pdf-renderer.service';
import { buildExportZip } from '@/services/export-zip.service';
import { uploadExportFile, buildExportS3Key } from '@/services/export-upload.service';
import { isCilEligible, CIL_NOT_ELIGIBLE_MESSAGE } from '@/lib/asset-capabilities';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import {
  evaluateCilReadiness, CIL_ACTION_REQUIRED_CODE, CIL_ACTION_REQUIRED_MESSAGE,
} from '@/services/exports/cil-preparation.service';
import {
  EXPORT_ERROR_MESSAGES, safeExportErrorMessage, technicalErrorMessage, exportRouteError,
} from '@/services/exports/export-errors';
import { notifySupportOfExportFailure } from '@/services/exports/export-support-notifier';

// DOSSIER_COMPLET manquait : la carte et le renderer existaient mais le POST
// répondait 400 INVALID_EXPORT_TYPE (dossier non générable).
const VALID_EXPORT_TYPES: ExportType[] = [
  'CIL_REGLEMENTAIRE', 'DOSSIER_VENTE', 'DOSSIER_COMPLET',
  'ASSURANCE_ESTIMATION', 'ASSURANCE_INDEMNISATION', 'EXPORT_BRUT',
];

/** Dossiers prêts à l'usage — réservés à Premium / Premium Duo (EXPORT_BRUT exclu). */
const PREMIUM_EXPORT_TYPES: ExportType[] = [
  'CIL_REGLEMENTAIRE',
  'DOSSIER_VENTE',
  'DOSSIER_COMPLET',
  'ASSURANCE_ESTIMATION',
  'ASSURANCE_INDEMNISATION',
];

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
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 50);

    // DRH-004 : une entrée dont le fichier a été supprimé reste dans
    // l'historique (statut `deleted`, sans lien de téléchargement).
    const rows = await db
      .select()
      .from(exportGenerations)
      .where(eq(exportGenerations.assetId, assetId))
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

      // Message générique uniquement : le détail technique n'est jamais renvoyé.
      const errorMessage = row.status === 'error' ? safeExportErrorMessage(row.errorPayload) : null;

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

    const asset = await findAccessibleAssetForExport(session, assetId);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    const body = await request.json();
    const { exportType, variant, requestedOutputs, options } = body as {
      exportType: ExportType;
      variant?: string;
      requestedOutputs?: string[];
      options?: { customSections?: string[]; customDocIds?: number[]; includePhotos?: boolean; includeEquipments?: boolean };
    };

    if (!VALID_EXPORT_TYPES.includes(exportType)) {
      return NextResponse.json({ error: 'INVALID_EXPORT_TYPE', code: 'INVALID_EXPORT_TYPE', message: 'Type de dossier inconnu.' }, { status: 400 });
    }

    // Compatibilité famille / type : seul le CIL est restreint. Le dossier de
    // vente couvre immobilier, véhicule et objet (CDC V12 §1.2, §10).
    // CIL : maisons et appartements uniquement (GAP-08, `lib/asset-capabilities`).
    if (exportType === 'CIL_REGLEMENTAIRE' && !isCilEligible(asset)) {
      return NextResponse.json({ error: 'INCOMPATIBLE_ASSET_CATEGORY', message: CIL_NOT_ELIGIBLE_MESSAGE }, { status: 400 });
    }

    // Compte du bien (= compte courant de la session, vérifié ci-dessus).
    const accountId = asset.accountId;

    // Dossiers prêts à l'usage : Premium et Premium Duo uniquement (essai
    // Premium compris). L'export de données brutes reste ouvert à Standard.
    // Le client affiche déjà la fenêtre d'offre ; ce contrôle en est la
    // garantie, et son refus est lu par `parseWriteBlocked` côté client.
    if (PREMIUM_EXPORT_TYPES.includes(exportType)) {
      const decision = await canUsePremiumFeature(accountId);
      if (!decision.allowed) {
        return NextResponse.json(
          { error: decision.reason, code: decision.reason, message: decision.message },
          { status: 403 },
        );
      }
    }

    // CIL-RULE-002 : B1, B3 et B8 à compléter bloquent la génération.
    if (exportType === 'CIL_REGLEMENTAIRE') {
      const readiness = await evaluateCilReadiness(asset);
      if (readiness.globalStatus === 'action_required') {
        return NextResponse.json({
          error: CIL_ACTION_REQUIRED_CODE,
          code: CIL_ACTION_REQUIRED_CODE,
          message: CIL_ACTION_REQUIRED_MESSAGE,
          blockingBlocks: readiness.blockingBlocks.map(b => ({ id: b.id, label: b.label })),
        }, { status: 422 });
      }
    }

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
      const snapshot = await buildAssetSnapshot(assetId, session.userId, { accountId });

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
      const technicalMessage = technicalErrorMessage(error);
      console.error('[Exports POST] Génération échouée :', { exportId: newExport.id, assetId, exportType, error });

      // Notification réelle du support ; `supportEmailSent` reflète le
      // résultat effectif de l'envoi (jamais forcé à true).
      const supportEmailSent = await notifySupportOfExportFailure({
        assetId,
        exportId: newExport.id,
        exportType,
        technicalMessage,
        attemptCount: 1,
        userId: session.userId,
        accountId,
      });

      const errorPayload = {
        code: 'GENERATION_FAILED',
        message: EXPORT_ERROR_MESSAGES.GENERATION_FAILED,
        technicalMessage, // interne : jamais renvoyé au client
        supportEmailSent,
      };

      await db
        .update(exportGenerations)
        .set({
          status: 'error',
          errorPayload: JSON.stringify(errorPayload),
          completedAt: new Date(),
        })
        .where(eq(exportGenerations.id, newExport.id));

      return NextResponse.json({
        exportId: newExport.id,
        publicId: newExport.publicId,
        status: 'error',
        errorCode: 'GENERATION_FAILED',
        errorMessage: EXPORT_ERROR_MESSAGES.GENERATION_FAILED,
        // Lus par `apiClient` pour le message affiché à l'utilisateur.
        code: 'GENERATION_FAILED',
        message: EXPORT_ERROR_MESSAGES.GENERATION_FAILED,
      }, { status: 500 });
    }
  } catch (error) {
    return exportRouteError(error, '[Exports POST]');
  }
}
