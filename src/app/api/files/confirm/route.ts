import { NextRequest, NextResponse } from 'next/server';

/** Documents par dépôt — au-delà, la mémoire du conteneur souffre. */
const MAX_DOCUMENTS_PAR_DEPOT = 10;
/** Taille cumulée d'un dépôt. 100 Mo : aucun usage normal ne l'atteint. */
const MAX_TAILLE_LOT = 100_000_000;
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { canConsumeAnalysis } from '@/services/commercial-model.service';
import { trackFunnelEvent } from '@/services/funnel-analytics.service';
import { checkAccountStorageQuota, storageQuotaExceededResponse } from '@/lib/storage-quota';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    const { userId } = session;
    const sessionAccountId = (session as any).currentAccountId as number | undefined;

    const body = await request.json();
    const {
      fileId,
      fileIds: batchFileIds,
      assetId,
      documentType,
      documentDate,
      description,
      supplier,
      amountCents,
      substructureId,
      equipmentId,
    } = body;

    if (!fileId) {
      return NextResponse.json(
        { error: 'MISSING_FIELD', message: 'fileId requis' },
        { status: 400 }
      );
    }

    // Validate fileId is a valid number
    const fileIdInt = parseInt(fileId);
    if (isNaN(fileIdInt)) {
      return NextResponse.json(
        { error: 'Invalid fileId', code: 'INVALID_FILE_ID' },
        { status: 400 }
      );
    }

    // ══════════════════════════════════════════════════════════════════════
    // TOUS LES FICHIERS DU DÉPÔT SONT CONFIRMÉS, PAS SEULEMENT LE PREMIER
    //
    // L'ancienne version recevait `fileIds` mais ne passait en `COMPLETED`
    // que `fileId`. Les autres fichiers restaient `PENDING` : invisibles dans
    // « Mes documents », non comptés, puis éventuellement supprimés par le
    // regroupement de l'analyse.
    //
    // Le client envoie désormais une confirmation par fichier. `fileIds` reste
    // accepté pour les appelants plus anciens, et chaque fichier y est traité.
    // ══════════════════════════════════════════════════════════════════════
    const idsDemandes: number[] = Array.isArray(batchFileIds) && batchFileIds.length > 0
      ? [...new Set([fileIdInt, ...batchFileIds.map((x: unknown) => Number(x))])]
      : [fileIdInt];

    if (idsDemandes.some((id) => !Number.isInteger(id))) {
      return NextResponse.json(
        { error: 'Invalid fileIds', code: 'INVALID_FILE_ID' },
        { status: 400 }
      );
    }

    // ── Limites de dépôt — AVANT toute écriture ─────────────────────────────
    // Dix analyses ensemble, c'est dix appels modèle sur un conteneur déjà
    // tombé pour dépassement mémoire. Le contrôle est ici et non seulement
    // dans l'interface : un appel direct contournerait le navigateur.
    if (idsDemandes.length > MAX_DOCUMENTS_PAR_DEPOT) {
      return NextResponse.json(
        {
          error: 'TOO_MANY_FILES',
          message:
            `Vous pouvez déposer ${MAX_DOCUMENTS_PAR_DEPOT} documents à la fois. ` +
            `Ce dépôt en contient ${idsDemandes.length}.`,
          max: MAX_DOCUMENTS_PAR_DEPOT,
          provided: idsDemandes.length,
        },
        { status: 400 },
      );
    }

    const fileRecords = await db
      .select()
      .from(assetFiles)
      .where(inArray(assetFiles.id, idsDemandes));

    if (fileRecords.length !== idsDemandes.length) {
      return NextResponse.json(
        { error: 'File not found', code: 'FILE_NOT_FOUND' },
        { status: 404 }
      );
    }

    // Verify user owns every file
    if (fileRecords.some((f) => f.userId !== userId)) {
      return NextResponse.json(
        { error: 'You do not have permission to access this file', code: 'FORBIDDEN' },
        { status: 403 }
      );
    }

    // Check files are in PENDING status
    const nonPending = fileRecords.find((f) => f.uploadStatus !== 'PENDING');
    if (nonPending) {
      return NextResponse.json(
        {
          error: `File is not in PENDING status. Current status: ${nonPending.uploadStatus}`,
          code: 'INVALID_STATUS'
        },
        { status: 400 }
      );
    }

    // Taille cumulée du dépôt.
    const cumul = fileRecords.reduce((t, f) => t + Number(f.size ?? 0), 0);
    if (cumul > MAX_TAILLE_LOT) {
      return NextResponse.json(
        {
          error: 'BATCH_TOO_LARGE',
          message:
            `Ce dépôt pèse ${Math.round(cumul / 1_000_000)} Mo. ` +
            `Le maximum est de ${MAX_TAILLE_LOT / 1_000_000} Mo par dépôt.`,
          max: MAX_TAILLE_LOT,
          provided: cumul,
        },
        { status: 400 },
      );
    }

    // ── Droits du compte ────────────────────────────────────────────────────
    // `presign` contrôle déjà les droits, mais un essai peut se terminer
    // entre la préparation et la confirmation. Le refus porte le code que le
    // client affiche dans la fenêtre de fin d'essai.
    const accountForGuard = fileRecords[0].accountId ?? sessionAccountId;
    if (accountForGuard) {
      const refus = await refuserSiLectureSeule(accountForGuard);
      if (refus) return refus;

      // Plafond de stockage (CDC BO STO-003) : `presign` l'a vérifié fichier
      // par fichier, mais plusieurs dépôts préparés en parallèle peuvent
      // ensemble le dépasser. Le volume confirmé exclut les fichiers PENDING,
      // d'où l'ajout du lot entier.
      const storageDecision = await checkAccountStorageQuota(accountForGuard, cumul);
      if (!storageDecision.allowed) {
        return storageQuotaExceededResponse(storageDecision);
      }
    }

    // Update the file records to COMPLETED
    const updateData: any = {
      uploadStatus: 'COMPLETED',
      uploadedAt: new Date(),
      updatedAt: new Date(),
    };

    // Save metadata if provided in body
    if (assetId !== undefined) {
      updateData.assetId = assetId === 0 || assetId === '0' || assetId === null ? null : parseInt(assetId.toString());
    }
    if (documentType) updateData.documentType = documentType;
    if (documentDate) updateData.documentDate = documentDate;
    // Titre et fournisseur saisis s'appliquent à un dépôt d'UN fichier : sur
    // plusieurs documents distincts, un titre commun serait faux pour tous
    // sauf un. L'analyse les renseigne alors document par document.
    if (description && idsDemandes.length === 1) updateData.description = description;
    if (supplier && idsDemandes.length === 1) updateData.supplier = supplier;
    if (amountCents !== undefined && amountCents !== null && idsDemandes.length === 1) {
      updateData.amountCents = parseInt(amountCents.toString());
    }
    if (substructureId !== undefined && substructureId !== null) {
      updateData.substructureId = parseInt(substructureId.toString());
    }
    if (equipmentId !== undefined && equipmentId !== null) {
      updateData.equipmentId = parseInt(equipmentId.toString());
    }

    const updatedFiles = await db
      .update(assetFiles)
      .set(updateData)
      .where(
        and(
          inArray(assetFiles.id, idsDemandes),
          eq(assetFiles.userId, userId),
          eq(assetFiles.uploadStatus, 'PENDING'),
        )
      )
      .returning();

    if (updatedFiles.length === 0) {
      return NextResponse.json(
        { error: 'Failed to update file record', code: 'UPDATE_FAILED' },
        { status: 500 }
      );
    }

    const confirmedFile = updatedFiles.find((f) => f.id === fileIdInt) ?? updatedFiles[0];
    const accountId = confirmedFile.accountId ?? sessionAccountId;

    // ── Analyse : un travail par fichier, via la file d'attente ──────────────
    // Chaque document est analysé comme s'il avait été déposé seul. Le
    // parallélisme est borné par la file. Aucune analyse n'est lancée si le
    // compte n'a pas de crédit : les fichiers restent « non analysés » et
    // `check-pending` les reprendra.
    if (accountId) {
      const confirmedIds = updatedFiles.map((f) => f.id);
      try {
        const gate = await canConsumeAnalysis(accountId, 1);
        if (gate.allowed) {
          const { enqueueFileAnalyses } = await import('@/services/ai/source-analysis/analysis-queue');
          await enqueueFileAnalyses(confirmedIds, accountId, { userId, origin: 'files/confirm' });
        }
      } catch (e) {
        console.error(
          `[files/confirm] mise en file impossible pour ${confirmedIds.join(', ')} :`,
          (e as Error).message,
        );
      }

      // ── Détection fusion (fire-and-forget), par fichier ───────────────────
      for (const f of updatedFiles) {
        if (!f.sha256Hash) continue;
        void (async () => {
          try {
            const { detectFusionCandidates } = await import('@/services/document-ai/fusion-detector');
            await detectFusionCandidates(f.id, accountId);
          } catch { /* non-blocking */ }
        })();
      }
    }

    // CDC §17 : activation — premier document enregistre
    void trackFunnelEvent({ event: 'first_document_added', accountId });

    return NextResponse.json(
      {
        success: true,
        file: confirmedFile,
        files: updatedFiles,
      },
      { status: 200 }
    );

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    const errMsg = (error as Error).message;
    if (errMsg === 'AUTH_REQUIRED' || errMsg === 'INVALID_TOKEN' || errMsg === 'ACCOUNT_SUSPENDED') {
      const { SessionService } = await import('@/lib/session-service');
      return SessionService.handleSessionError(error);
    }

    console.error('POST /api/files/confirm error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}