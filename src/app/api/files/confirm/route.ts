import { NextRequest, NextResponse } from 'next/server';

/** Documents par dépôt — au-delà, la mémoire du conteneur souffre. */
const MAX_DOCUMENTS_PAR_DEPOT = 10;
/** Taille cumulée d'un dépôt. 100 Mo : aucun usage normal ne l'atteint. */
const MAX_TAILLE_LOT = 100_000_000;
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';
import { trackFunnelEvent } from '@/services/funnel-analytics.service';

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

    // Fetch the file record
    const fileRecords = await db
      .select()
      .from(assetFiles)
      .where(eq(assetFiles.id, fileIdInt))
      .limit(1);

    // Check if file exists
    if (fileRecords.length === 0) {
      return NextResponse.json(
        { error: 'File not found', code: 'FILE_NOT_FOUND' },
        { status: 404 }
      );
    }

    const fileRecord = fileRecords[0];

    // Verify user owns the file
    if (fileRecord.userId !== userId) {
      return NextResponse.json(
        { error: 'You do not have permission to access this file', code: 'FORBIDDEN' },
        { status: 403 }
      );
    }

    // Check file is in PENDING status
    if (fileRecord.uploadStatus !== 'PENDING') {
      return NextResponse.json(
        { 
          error: `File is not in PENDING status. Current status: ${fileRecord.uploadStatus}`,
          code: 'INVALID_STATUS'
        },
        { status: 400 }
      );
    }

    // Update the file record to COMPLETED
    const updateData: any = {
      uploadStatus: 'COMPLETED',
      sha256Hash: fileRecord.sha256Hash,
      uploadedAt: new Date(),
      updatedAt: new Date(),
    };

    // Save metadata if provided in body
    if (assetId !== undefined) {
      updateData.assetId = assetId === 0 || assetId === '0' || assetId === null ? null : parseInt(assetId.toString());
    }
    if (documentType) updateData.documentType = documentType;
    if (documentDate) updateData.documentDate = documentDate;
    if (description) updateData.description = description;
    if (supplier) updateData.supplier = supplier;
    if (amountCents !== undefined && amountCents !== null) {
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
          eq(assetFiles.id, fileIdInt),
          eq(assetFiles.userId, userId)
        )
      )
      .returning();

    if (updatedFiles.length === 0) {
      return NextResponse.json(
        { error: 'Failed to update file record', code: 'UPDATE_FAILED' },
        { status: 500 }
      );
    }

    const confirmedFile = updatedFiles[0];

    // ── Pipeline d'analyse unifié (fire-and-forget) ─────────────────────────
    // Déclenché pour tous les plans avec analyse IA.
    // Accepte un batch (fileIds[]) ou un fichier unique (fileId).
    const accountId = confirmedFile.accountId ?? sessionAccountId;
    if (accountId) {
      // Construire la liste complète des fileIds du batch
      const allFileIds: number[] = Array.isArray(batchFileIds) && batchFileIds.length > 0
        ? batchFileIds.map(Number)
        : [fileIdInt];

      // ══════════════════════════════════════════════════════════════════
      // LIMITES DE DÉPÔT
      //
      // Dix analyses lancées ensemble, ce sont dix appels modèles sur un
      // conteneur qui est déjà tombé pour dépassement mémoire. Le plafond
      // protège la machine autant que le quota du compte.
      //
      // Le contrôle est ICI et non seulement dans l'interface : un appel
      // direct à l'API contournerait une validation côté navigateur.
      // ══════════════════════════════════════════════════════════════════
      if (allFileIds.length > MAX_DOCUMENTS_PAR_DEPOT) {
        return NextResponse.json(
          {
            error: 'TOO_MANY_FILES',
            message:
              `Vous pouvez déposer ${MAX_DOCUMENTS_PAR_DEPOT} documents à la fois. ` +
              `Ce dépôt en contient ${allFileIds.length}.`,
            max: MAX_DOCUMENTS_PAR_DEPOT,
            provided: allFileIds.length,
          },
          { status: 400 },
        );
      }

      // Taille cumulée : dix fichiers de 25 Mo feraient 250 Mo, que le
      // navigateur met plusieurs minutes à envoyer et que la confirmation
      // charge en mémoire.
      const [tailleLot] = await db
        .select({ total: sql<number>`coalesce(sum(${assetFiles.size}), 0)::bigint` })
        .from(assetFiles)
        .where(inArray(assetFiles.id, allFileIds));

      const cumul = Number(tailleLot?.total ?? 0);
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
      // Aiguillage unique (CDC §10.1) : le moteur est choisi dans
      // `source-analysis/entrypoint`, jamais ici. Voir l'en-tête de ce module
      // pour la raison — huit appelants, un seul test de drapeau.
      // ══════════════════════════════════════════════════════════════════
      // UNE ERREUR AVALÉE LAISSE LE DOCUMENT « EN COURS » POUR TOUJOURS
      //
      // Le `.catch(() => {})` d'origine ne couvrait d'ailleurs que l'échec
      // d'IMPORT du module. L'analyse elle-même partait en `void` : si elle
      // rejetait, la promesse n'était rattrapée par personne.
      //
      // Résultat observé : le document reste en analyse indéfiniment, le
      // navigateur sonde toutes les quatre secondes, et rien nulle part ne
      // dit pourquoi.
      //
      // On ne peut pas attendre l'analyse — elle dure des dizaines de
      // secondes et la requête d'import doit répondre tout de suite. Mais on
      // peut consigner l'échec, et remettre le document dans un état où
      // l'utilisateur comprend ce qui s'est passé.
      // ══════════════════════════════════════════════════════════════════
      import('@/services/ai/source-analysis/entrypoint')
        .then(({ analyzeFileSources }) =>
          analyzeFileSources(allFileIds, accountId, { userId, origin: 'files/confirm' }),
        )
        .catch(async (e) => {
          const err = e as Error & { cause?: { message?: string } };
          console.error(
            `[files/confirm] analyse impossible pour ${allFileIds.join(', ')} :`,
            err.message,
            err.cause?.message ?? '',
          );
          // Sortir de « en cours » : un état d'échec est lisible, une attente
          // sans fin ne l'est pas.
          await db
            .update(assetFiles)
            // `asset_files` ne porte pas de colonne pour le motif : seul
            // l'état est écrit, la cause reste au journal. C'est une limite
            // connue — l'utilisateur voit que ça a échoué, pas pourquoi.
            .set({ analysisState: 'ANALYSIS_FAILED', updatedAt: new Date() })
            .where(inArray(assetFiles.id, allFileIds))
            .catch(() => { /* la trace console suffit */ });
        });
    }

    // ── Détection fusion (fire-and-forget) ──────────────────────────────────
    if (accountId && confirmedFile.sha256Hash) {
      (async () => {
        try {
          const { detectFusionCandidates } = await import('@/services/document-ai/fusion-detector');
          await detectFusionCandidates(fileIdInt, accountId);
        } catch { /* non-blocking */ }
      })();
    }

    // CDC §17 : activation — premier document enregistre
    void trackFunnelEvent({ event: 'first_document_added', accountId });

    return NextResponse.json(
      {
        success: true,
        file: confirmedFile,
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