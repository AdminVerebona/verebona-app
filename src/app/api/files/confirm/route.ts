import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { canConsumeAnalysis } from '@/services/commercial-model.service';
import { trackFunnelEvent } from '@/services/funnel-analytics.service';
import { emitBusinessEvents } from '@/services/verebona-assistant/events/business-events';
import {
  checkAccountStorageQuota,
  discardRejectedUploads,
  storageQuotaExceededResponse,
  withAccountStorageLock,
  type StorageExecutor,
  type StorageQuotaDecision,
} from '@/lib/storage-quota';
import { verifierFichier, verifierLot, MAX_DOCUMENTS_PAR_DEPOT } from '@/lib/upload-limits';
import { deciderConfirm, empreinteConfirm, estCleOperation } from '@/lib/upload-idempotence';
import { verificationObjetActive, verifierObjetDepose } from '@/lib/upload-object-check';

type LigneFichier = typeof assetFiles.$inferSelect;

/** Réponse d'une confirmation (nouvelle ou rejouée). */
function reponseConfirmee(fichiers: LigneFichier[], fileIdInt: number, replay: boolean): NextResponse {
  const file = fichiers.find((f) => f.id === fileIdInt) ?? fichiers[0];
  return NextResponse.json({ success: true, file, files: fichiers, ...(replay ? { replay: true } : {}) }, { status: 200 });
}

/**
 * Mise en file de l'analyse d'un fichier confirmé — un travail par fichier,
 * via la file durable T1 (déduplication WF-10 des travaux vivants).
 * Aucune analyse si le compte n'a pas de crédit : le fichier reste « non
 * analysé » et la reprise serveur (`analysis-recovery`) le reprendra, comme
 * elle reprend un fichier confirmé dont la mise en file a échoué.
 */
async function mettreEnFile(ids: number[], accountId: number, userId: number): Promise<void> {
  if (ids.length === 0) return;
  try {
    const gate = await canConsumeAnalysis(accountId, 1);
    if (gate.allowed) {
      const { enqueueFileAnalyses } = await import('@/services/ai/source-analysis/queue/t1-handler');
      await enqueueFileAnalyses(ids, accountId, { userId, origin: 'files/confirm' });
    }
  } catch (e) {
    console.error(`[files/confirm] mise en file impossible pour ${ids.join(', ')} :`, (e as Error).message);
  }
}

/**
 * Confirmation rejouée d'un fichier déjà COMPLETED (APP-PERF-30, T-03) :
 * si la première confirmation a réussi mais que sa mise en file a échoué
 * (aucun état d'analyse), la reprise est tentée tout de suite plutôt qu'au
 * prochain passage d'`analysis-recovery`. Sans risque de doublon : la file
 * déduplique les travaux vivants, et un fichier déjà analysé ou en cours a
 * un état d'analyse — il n'est pas remis en file.
 */
async function reprendreMiseEnFile(f: LigneFichier, userId: number): Promise<void> {
  if (f.analysisState !== null || !f.accountId || f.deletedAt) return;
  await mettreEnFile([f.id], f.accountId, userId);
}

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
      operationId: operationIdBrut,
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

    // ── Identifiant d'opération (APP-PERF-30) ───────────────────────────────
    // Facultatif (clients antérieurs, vignettes). Il désigne UN fichier : un
    // lot `fileIds` ne se rejoue pas sous une seule clé.
    if (operationIdBrut !== undefined && operationIdBrut !== null && !estCleOperation(operationIdBrut)) {
      return NextResponse.json({ error: 'Invalid operationId', code: 'INVALID_OPERATION_ID' }, { status: 400 });
    }
    const operationId: string | null = estCleOperation(operationIdBrut) ? operationIdBrut : null;
    if (operationId && idsDemandes.length > 1) {
      return NextResponse.json(
        { error: 'operationId ne vaut que pour un fichier', code: 'INVALID_OPERATION_ID' },
        { status: 400 },
      );
    }
    const empreinte = empreinteConfirm(body as Record<string, unknown>);

    // ── Limites de dépôt — AVANT toute écriture ─────────────────────────────
    // Dix analyses ensemble, c'est dix appels modèle sur un conteneur déjà
    // tombé pour dépassement mémoire. Le contrôle est ici et non seulement
    // dans l'interface : un appel direct contournerait le navigateur.
    if (idsDemandes.length > MAX_DOCUMENTS_PAR_DEPOT) {
      const refus = verifierLot(idsDemandes.map(() => 1))!;
      return NextResponse.json(
        { error: refus.code, message: refus.message, max: refus.max, provided: refus.provided },
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

    // Verify user owns every file — et qu'ils appartiennent au compte de la
    // session (CA-03 : la confirmation d'un autre compte est refusée).
    if (fileRecords.some((f) => f.userId !== userId || (sessionAccountId && f.accountId && f.accountId !== sessionAccountId))) {
      return NextResponse.json(
        { error: 'You do not have permission to access this file', code: 'FORBIDDEN' },
        { status: 403 }
      );
    }

    // ── État de chaque fichier : nouvelle confirmation, rejeu, ou refus ─────
    // APP-PERF-30 : une confirmation réussie dont la réponse s'est perdue
    // est rejouée avec la même clé. Elle rend le document existant au lieu
    // d'un INVALID_STATUS qui faisait croire à un échec.
    for (const f of fileRecords) {
      const d = deciderConfirm(f, operationId, empreinte);
      if (d.kind === 'refus') {
        return NextResponse.json({ error: d.message, code: d.code }, { status: d.status });
      }
      if (d.kind === 'deja_confirme') {
        await reprendreMiseEnFile(f, userId);
        return reponseConfirmee([f], fileIdInt, true);
      }
    }

    // ── Contrat de dépôt (APP-PERF-28) : chaque fichier, puis le lot ────────
    // Mêmes règles que le dialogue et `presign` (`@/lib/upload-limits`).
    for (const f of fileRecords) {
      const refus = verifierFichier(Number(f.size ?? 0), f.mimeType);
      if (refus) {
        return NextResponse.json(
          { error: refus.code, code: refus.code, message: refus.message, max: refus.max, provided: Number(f.size ?? 0), fileId: f.id },
          { status: 400 },
        );
      }
    }
    // Taille cumulée du dépôt.
    const cumul = fileRecords.reduce((t, f) => t + Number(f.size ?? 0), 0);
    const refusLot = verifierLot(fileRecords.map((f) => Number(f.size ?? 0)));
    if (refusLot) {
      return NextResponse.json(
        { error: refusLot.code, message: refusLot.message, max: refusLot.max, provided: refusLot.provided },
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
    }

    // ── Objet réellement déposé (APP-PERF-30) ───────────────────────────────
    // Avant COMPLETED : l'objet existe et a exactement la taille déclarée.
    // Contrôle HORS verrou (appel réseau). Absent ⇒ 409 reprenable (le
    // client relance le transfert sur la même opération) ; taille différente
    // ⇒ dépôt écarté ; stockage injoignable ⇒ 503, la ligne reste PENDING.
    if (verificationObjetActive()) {
      for (const f of fileRecords) {
        const v = await verifierObjetDepose(f);
        if (v.kind === 'absent') {
          return NextResponse.json(
            { error: 'Le fichier n’a pas été reçu par le stockage. Relancez le transfert.', code: 'OBJECT_MISSING', fileId: f.id },
            { status: 409 },
          );
        }
        if (v.kind === 'taille') {
          await withAccountStorageLock(f.accountId, (tx) => discardRejectedUploads(tx, [{ id: f.id, s3Key: f.s3Key }], userId));
          return NextResponse.json(
            {
              error: 'Le fichier reçu ne correspond pas au fichier annoncé. Relancez le dépôt depuis le début.',
              code: 'OBJECT_MISMATCH', fileId: f.id, expected: v.attendue, received: v.reelle,
            },
            { status: 422 },
          );
        }
        if (v.kind === 'indisponible') {
          console.error(`[files/confirm] vérification de l'objet ${f.id} impossible :`, v.detail);
          return NextResponse.json(
            { error: 'Le stockage est momentanément injoignable. Réessayez dans quelques instants.', code: 'STORAGE_UNAVAILABLE' },
            { status: 503 },
          );
        }
      }
    }

    // Update the file records to COMPLETED
    const updateData: any = {
      uploadStatus: 'COMPLETED',
      uploadedAt: new Date(),
      updatedAt: new Date(),
    };
    if (operationId) {
      updateData.uploadOperationId = operationId;
      updateData.confirmFingerprint = empreinte;
    }

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

    const confirmer = (executor: StorageExecutor) => executor
      .update(assetFiles)
      .set(updateData)
      .where(
        and(
          inArray(assetFiles.id, idsDemandes),
          eq(assetFiles.userId, userId),
          eq(assetFiles.uploadStatus, 'PENDING'),
          isNull(assetFiles.deletedAt),
        )
      )
      .returning();

    // ══════════════════════════════════════════════════════════════════════
    // PLAFOND DE STOCKAGE (CDC BO STO-003) — CONTRÔLE ET ÉCRITURE ATOMIQUES
    //
    // `presign` l'a vérifié fichier par fichier, mais plusieurs dépôts
    // préparés en parallèle peuvent ensemble le dépasser. Le volume confirmé
    // exclut les fichiers PENDING, d'où l'ajout du lot entier.
    //
    // Contrôle et passage en COMPLETED se font sous verrou consultatif du
    // compte, dans une même transaction : deux confirmations simultanées ne
    // peuvent plus lire la même somme et dépasser ensemble le plafond.
    //
    // APP-PERF-30 : l'état des fichiers est RELU sous le verrou. Deux
    // confirmations identiques simultanées passaient toutes deux le contrôle
    // PENDING ci-dessus ; la seconde, sérialisée derrière la première, voit
    // désormais le fichier COMPLETED et rend le même résultat — sans compter
    // le fichier une seconde fois dans le quota, sans le refuser à tort, et
    // sans seconde analyse.
    //
    // Un lot refusé (413) ne sera jamais confirmé : ses lignes sont écartées
    // et ses objets S3 programmés pour suppression (`pending_blob_deletions`)
    // dans la même transaction — ni objet ni ligne PENDING orphelins.
    // ══════════════════════════════════════════════════════════════════════
    type Issue =
      | { kind: 'ok'; files: LigneFichier[] }
      | { kind: 'quota'; decision: StorageQuotaDecision }
      | { kind: 'replay'; files: LigneFichier[] }
      | { kind: 'refus'; status: number; code: string; message: string };
    const sousVerrou = async (tx: StorageExecutor): Promise<Issue> => {
      const actuels = await tx.select().from(assetFiles).where(inArray(assetFiles.id, idsDemandes));
      for (const f of actuels) {
        const d = deciderConfirm(f, operationId, empreinte);
        if (d.kind === 'refus') return { kind: 'refus', status: d.status, code: d.code, message: d.message };
        if (d.kind === 'deja_confirme') return { kind: 'replay', files: [f] };
      }
      if (accountForGuard) {
        const decision = await checkAccountStorageQuota(accountForGuard, cumul, tx);
        if (!decision.allowed) {
          await discardRejectedUploads(tx, fileRecords.map((f) => ({ id: f.id, s3Key: f.s3Key })), userId);
          return { kind: 'quota', decision };
        }
      }
      return { kind: 'ok', files: await confirmer(tx) };
    };
    const issue: Issue = accountForGuard
      ? await withAccountStorageLock(accountForGuard, sousVerrou)
      : await db.transaction((tx) => sousVerrou(tx));

    if (issue.kind === 'quota') {
      return storageQuotaExceededResponse(issue.decision);
    }
    if (issue.kind === 'refus') {
      return NextResponse.json({ error: issue.message, code: issue.code }, { status: issue.status });
    }
    if (issue.kind === 'replay') {
      return reponseConfirmee(issue.files, fileIdInt, true);
    }
    const updatedFiles = issue.files;

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
    // parallélisme est borné par la file durable T1. Aucune analyse n'est
    // lancée si le compte n'a pas de crédit : les fichiers restent « non
    // analysés » et la reprise serveur (`analysis-recovery`) les reprendra.
    if (accountId) {
      // §25.7, §31.7 : un événement par document, une seule invalidation
      // (toutes instances) pour la demande, avant la réponse. Ne lève jamais.
      await emitBusinessEvents(updatedFiles.map((f) => ({ type: 'DOCUMENT_UPLOADED' as const, accountId, entityId: f.id })));
      await mettreEnFile(updatedFiles.map((f) => f.id), accountId, userId);

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

    // ── [APP-PERF-27/06] Miniatures — début du crochet ────────────────────
    // Génération asynchrone (file bornée, hors requête, sans appel IA) :
    // jamais bloquante ni requise pour la confirmation. Ne lève jamais.
    void import('@/services/documents/thumbnails/thumbnail.service')
      .then(({ enqueueThumbnails }) => enqueueThumbnails(updatedFiles.map((f) => f.id)))
      .catch(() => undefined);
    // ── [APP-PERF-27/06] Miniatures — fin du crochet ──────────────────────

    // CDC §17 : activation — premier document enregistre
    void trackFunnelEvent({ event: 'first_document_added', accountId });

    return reponseConfirmee(updatedFiles, fileIdInt, false);

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