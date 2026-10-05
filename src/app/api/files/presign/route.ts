import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles, assets } from '@/db/schema';
import { eq, and, isNull, or, sql } from 'drizzle-orm';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { sanitizeFilename, validateExtension, ALLOWED_MIME_TYPES, estEmpreinteSha256 } from '@/lib/file-validation';
import { verifierFichier, MAX_FICHIERS_COMPTE, MAX_FICHIERS_PAR_BIEN } from '@/lib/upload-limits';
import { estCleOperation, empreintePresign, deciderPresignRejoue } from '@/lib/upload-idempotence';
import { generateS3Key } from '@/lib/s3-naming';
import { rateLimiter } from '@/lib/rate-limiter';
import { getSession } from '@/lib/auth-guards';
import { canAddDocument } from '@/services/entitlements.service';
import { SessionService } from '@/lib/session-service';
import { s3Client, S3_BUCKET, S3_REGION } from '@/lib/s3-client';
import { checkAccountStorageQuota, storageQuotaExceededResponse } from '@/lib/storage-quota';

// ══════════════════════════════════════════════════════════════════════════
// LIMITES DE TAILLE ET DE NOMBRE : `@/lib/upload-limits` (APP-PERF-28)
//
// Document analysé 25 Mo (contrainte du fournisseur d'analyse : au-delà,
// l'analyse échouerait après un transfert inutile), vidéo et lot selon le
// contrat partagé avec le dialogue et `/api/files/confirm`. L'ancien plafond
// vidéo de 500 Mo propre à cette route laissait passer des fichiers que la
// confirmation refusait ensuite.
// ══════════════════════════════════════════════════════════════════════════
const MAX_FILES_PER_USER = MAX_FICHIERS_COMPTE;
const MAX_FILES_PER_ASSET = MAX_FICHIERS_PAR_BIEN;
const PRESIGNED_URL_EXPIRATION = 3600; // 1 hour

/**
 * URL signée de dépôt.
 * NOTE: ContentLength intentionally omitted — signing it causes browsers to fail
 * when they upload via fetch(url, { body: File }) without an explicit Content-Length
 * header (OVH S3 rejects the PUT because the signed length doesn't match chunked transfer).
 * La taille réelle est vérifiée à la confirmation (`upload-object-check.ts`).
 */
async function signerDepot(d: {
  s3Key: string; mimeType: string; userId: number; assetId: number | null; fileId: number; sha256Hash: string;
}): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: d.s3Key,
    ContentType: d.mimeType,
    Metadata: {
      userId: d.userId.toString(),
      assetId: d.assetId ? d.assetId.toString() : 'unassigned',
      fileId: d.fileId.toString(),
      sha256: d.sha256Hash,
    },
  });
  return getSignedUrl(s3Client, command, { expiresIn: PRESIGNED_URL_EXPIRATION });
}

/**
 * Fixe la clé S3 définitive d'une ligne encore provisoire (`temp`) et rend
 * la clé effectivement retenue : deux préparations simultanées de la même
 * opération signent ainsi la MÊME clé.
 */
async function fixerCleS3(fileId: number, cle: string): Promise<string> {
  const [maj] = await db.update(assetFiles)
    .set({ s3Key: cle })
    .where(and(eq(assetFiles.id, fileId), eq(assetFiles.s3Key, 'temp')))
    .returning({ s3Key: assetFiles.s3Key });
  if (maj?.s3Key) return maj.s3Key;
  const [actuelle] = await db.select({ s3Key: assetFiles.s3Key }).from(assetFiles).where(eq(assetFiles.id, fileId)).limit(1);
  return actuelle?.s3Key ?? cle;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
      const { userId, currentAccountId } = session;
      
      if (!currentAccountId) {
        return NextResponse.json(
          { error: 'NO_ACCOUNT', message: 'No account selected' },
          { status: 401 }
        );
      }
      

    // Rate limiting - CORRECTION: utiliser check() au lieu de checkLimit()
    const rateLimit = rateLimiter.check(`presign:${userId}`);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: 'RATE_LIMIT_EXCEEDED',
          message: `Limite de ${rateLimit.limit} requêtes par minute atteinte`,
          remaining: rateLimit.remaining,
          resetAt: rateLimit.resetAt,
        },
        { status: 429 }
      );
    }

    // Parse request body
    const body = await request.json();
    const { assetId, filename, mimeType, size, operationId } = body;
    const sha256Hash = typeof body.sha256Hash === 'string' ? body.sha256Hash.toLowerCase() : body.sha256Hash;

    // Validate required fields - assetId is now optional (can be 0 or null)
    if (!filename) {
      return NextResponse.json(
        { error: 'MISSING_FILENAME', message: 'Filename is required' },
        { status: 400 }
      );
    }

    if (!mimeType) {
      return NextResponse.json(
        { error: 'MISSING_MIME_TYPE', message: 'MIME type is required' },
        { status: 400 }
      );
    }

    if (size === undefined || size === null) {
      return NextResponse.json(
        { error: 'MISSING_SIZE', message: 'File size is required' },
        { status: 400 }
      );
    }

    if (!sha256Hash) {
      return NextResponse.json(
        { error: 'MISSING_HASH', message: 'sha256Hash is required for integrity verification' },
        { status: 400 }
      );
    }

    // APP-PERF-24 : une valeur de repli (« placeholder-hash ») n'est pas une
    // empreinte. Commune à plusieurs fichiers, elle les ferait passer pour
    // des doublons exacts. Le client signale un échec de calcul au lieu de
    // l'envoyer.
    if (!estEmpreinteSha256(sha256Hash)) {
      return NextResponse.json(
        { error: 'INVALID_HASH', message: 'Empreinte SHA-256 invalide (64 caractères hexadécimaux attendus).' },
        { status: 400 }
      );
    }

    if (operationId !== undefined && operationId !== null && !estCleOperation(operationId)) {
      return NextResponse.json(
        { error: 'INVALID_OPERATION_ID', message: 'Identifiant d’opération invalide.' },
        { status: 400 }
      );
    }

    // Parse assetId - null or 0 means unassigned
    let assetIdInt: number | null = null;
    if (assetId && assetId !== 0) {
      assetIdInt = parseInt(assetId);
      if (isNaN(assetIdInt)) {
        return NextResponse.json(
          { error: 'INVALID_ASSET_ID', message: 'Asset ID must be a valid number' },
          { status: 400 }
        );
      }
    }

    // ── Contrat de dépôt (APP-PERF-28) : taille exacte en octets et type ──
    // Mêmes règles que le dialogue et la confirmation (`verifierFichier`) :
    // plafond inclus, plafond + 1 octet refusé, fichier vide refusé.
    const refusFichier = verifierFichier(size, mimeType);
    if (refusFichier) {
      return NextResponse.json(
        {
          error: refusFichier.code,
          message: refusFichier.message,
          ...(refusFichier.max !== undefined ? { maxSize: refusFichier.max, providedSize: Number(size) } : {}),
          ...(refusFichier.code === 'INVALID_MIME_TYPE' ? { allowedTypes: ALLOWED_MIME_TYPES } : {}),
        },
        { status: 400 },
      );
    }
    const sizeInt = Number(size);

    // Sanitize filename - strict ASCII-safe
    const sanitizedFilename = sanitizeFilename(filename);
    if (!sanitizedFilename) {
      return NextResponse.json(
        { 
          error: 'INVALID_FILENAME',
          message: 'Nom de fichier invalide. Le nom doit être ASCII-safe, max 255 caractères, et ne peut contenir de séquences de traversée de chemin ou d\'extensions dangereuses.'
        },
        { status: 400 }
      );
    }

    // Validate extension matches MIME type
    if (!validateExtension(sanitizedFilename, mimeType)) {
      return NextResponse.json(
        { 
          error: 'EXTENSION_MIME_MISMATCH',
          message: 'L\'extension du fichier ne correspond pas au type MIME déclaré'
        },
        { status: 400 }
      );
    }

      // Validate asset exists and user has access - only if assetId is provided
      if (assetIdInt) {
        const asset = await db.select()
          .from(assets)
          .where(
            and(
              eq(assets.id, assetIdInt),
              eq(assets.accountId, currentAccountId)
            )
          )
          .limit(1);

        if (asset.length === 0) {
          return NextResponse.json(
            { error: 'ASSET_NOT_FOUND', message: 'Bien introuvable ou accès refusé' },
            { status: 404 }
          );
        }
      }

    // Check S3 credentials
    if (!S3_BUCKET) {
      console.error('S3 bucket not configured');
      return NextResponse.json(
        { error: 'S3_NOT_CONFIGURED', message: 'Service de stockage non configuré' },
        { status: 500 }
      );
    }

    // ══════════════════════════════════════════════════════════════════════
    // REPRISE D'UNE OPÉRATION DÉJÀ PRÉPARÉE (APP-PERF-30)
    //
    // Même `operationId`, même demande : la ligne existante est réutilisée —
    // nouvelle URL signée pour la MÊME clé S3 si le dépôt est en attente,
    // « déjà confirmé » (sans URL) s'il est COMPLETED. Aucun nouveau
    // document, aucun nouveau contrôle de quota (la confirmation, sous
    // verrou, reste le contrôle qui fait foi). Même clé, autre demande : 409.
    // ══════════════════════════════════════════════════════════════════════
    const cleOperation: string | null = estCleOperation(operationId) ? operationId : null;
    const empreinteDemande = empreintePresign({
      accountId: currentAccountId, assetId: assetIdInt, filename, mimeType, size: sizeInt, sha256Hash,
    });
    const reprendre = async (): Promise<NextResponse | null> => {
      if (!cleOperation) return null;
      const [ligne] = await db.select()
        .from(assetFiles)
        .where(and(eq(assetFiles.userId, userId), eq(assetFiles.uploadOperationId, cleOperation)))
        .limit(1);
      if (!ligne) return null;
      const decision = deciderPresignRejoue(ligne, empreinteDemande);
      if (decision.kind === 'refus') {
        return NextResponse.json({ error: decision.code, code: decision.code, message: decision.message }, { status: decision.status });
      }
      if (decision.kind === 'completed') {
        return NextResponse.json(
          { fileId: ligne.id, uploadStatus: 'COMPLETED', reprise: true },
          { status: 200 },
        );
      }
      let cle = ligne.s3Key;
      if (!cle || cle === 'temp') {
        cle = generateS3Key({
          userId, assetId: ligne.assetId, fileId: ligne.id, timestamp: Date.now(), sanitizedFilename,
        });
        cle = await fixerCleS3(ligne.id, cle);
      }
      return NextResponse.json(
        {
          uploadUrl: await signerDepot({ s3Key: cle, mimeType, userId, assetId: ligne.assetId, fileId: ligne.id, sha256Hash }),
          fileId: ligne.id,
          s3Key: cle,
          expiresIn: PRESIGNED_URL_EXPIRATION,
          uploadStatus: 'PENDING',
          reprise: true,
        },
        { status: 200 },
      );
    };
    const repriseExistante = await reprendre();
    if (repriseExistante) return repriseExistante;

      // Quota checks - count total files for account (where deletedAt is null)
      const accountFileCount = await db.select({ count: sql<number>`count(*)` })
        .from(assetFiles)
        .where(
          and(
            eq(assetFiles.accountId, currentAccountId),
            isNull(assetFiles.deletedAt),
            or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus))
          )
        );

      const totalFiles = Number(accountFileCount[0]?.count || 0);

      // ══════════════════════════════════════════════════════════════════════
      // ⚠️ DROITS D'ECRITURE ET QUOTA DOCUMENTAIRE — CONTROLE MANQUANT
      //
      // Cette route est le passage oblige de tout televersement : sans URL
      // signee, aucun fichier n'atteint le stockage. Elle ne verifiait
      // pourtant que des limites TECHNIQUES (1000 fichiers, 100 par bien,
      // type MIME, taille). `canAddDocument()` existait dans le service
      // d'entitlements sans etre appele nulle part.
      //
      // Consequence : un compte en mode restreint — essai termine, offre
      // resiliee — pouvait continuer d'ajouter des documents, et le quota
      // documentaire du CDC §8.1 (30 en essai, 150 en Premium, 225 en Duo)
      // n'etait jamais oppose.
      // ══════════════════════════════════════════════════════════════════════
      const documentDecision = await canAddDocument(currentAccountId, totalFiles);
      if (!documentDecision.allowed) {
        return NextResponse.json(
          {
            error: documentDecision.reason ?? 'DOCUMENT_QUOTA_REACHED',
            code: documentDecision.reason ?? 'DOCUMENT_QUOTA_REACHED',
            message: documentDecision.message ?? "L'ajout de documents n'est pas autorise.",
            limit: documentDecision.limit,
            currentCount: totalFiles,
          },
          { status: 403 },
        );
      }

      // ══════════════════════════════════════════════════════════════════
      // PLAFOND DE STOCKAGE DU COMPTE — CDC BO STO-001 / STO-003
      //
      // Garde-fou distinct du quota documentaire : 2 / 10 / 15 Go selon
      // l'offre. Seul le NOUVEAU dépôt est refusé (413) ; tout le reste —
      // consultation, suppression, export, transmission — reste possible.
      // Contrôlé ici (avant l'URL signée) et de nouveau à la confirmation,
      // pour les dépôts préparés en parallèle.
      //
      // Pas de verrou ici, volontairement : la ligne créée plus bas est
      // PENDING et n'entre pas dans le volume compté — un verrou ne
      // protégerait aucune écriture comptée. Ce contrôle n'est qu'un refus
      // précoce (éviter un téléversement voué à l'échec) ; le contrôle qui
      // fait foi est celui de `/api/files/confirm`, sous verrou consultatif
      // du compte (`withAccountStorageLock`).
      // ══════════════════════════════════════════════════════════════════
      const storageDecision = await checkAccountStorageQuota(currentAccountId, sizeInt);
      if (!storageDecision.allowed) {
        return storageQuotaExceededResponse(storageDecision);
      }

      if (totalFiles >= MAX_FILES_PER_USER) {
        return NextResponse.json(
          { 
            error: 'ACCOUNT_FILE_QUOTA_EXCEEDED',
            message: `Limite de fichiers atteinte (${MAX_FILES_PER_USER} fichiers)`,
            currentCount: totalFiles,
            maxAllowed: MAX_FILES_PER_USER
          },
          { status: 400 }
        );
      }



    // Check files per asset - only if assetId is provided
    if (assetIdInt) {
      const assetFileCount = await db.select({ count: sql<number>`count(*)` })
        .from(assetFiles)
        .where(
          and(
            eq(assetFiles.assetId, assetIdInt),
            isNull(assetFiles.deletedAt)
          )
        );

      const assetFilesCount = Number(assetFileCount[0]?.count || 0);
      if (assetFilesCount >= MAX_FILES_PER_ASSET) {
        return NextResponse.json(
          { 
            error: 'ASSET_FILE_QUOTA_EXCEEDED',
            message: `Limite de fichiers par bien atteinte (${MAX_FILES_PER_ASSET} fichiers)`,
            currentCount: assetFilesCount,
            maxAllowed: MAX_FILES_PER_ASSET
          },
          { status: 400 }
        );
      }
    }

    // Extract file extension
    const fileExtension = sanitizedFilename.split('.').pop() || '';

    // Create PENDING record in assetFiles table to get fileId
    const now = new Date();
    const tempS3Key = 'temp'; // Temporary value, will be updated after getting fileId
    
    let newFile: Array<typeof assetFiles.$inferSelect>;
    try {
      newFile = await db.insert(assetFiles)
        .values({
          uploadOperationId: cleOperation,
          uploadRequestFingerprint: cleOperation ? empreinteDemande : null,
          userId: userId,
          accountId: currentAccountId,
          assetId: assetIdInt, // Can be null for unassigned files
          filename: sanitizedFilename,
          originalFilename: filename,
          retainedTitle: filename, // nom du fichier = titre par défaut
          mimeType: mimeType,
          fileExtension: fileExtension,
          size: sizeInt,
          sha256Hash: sha256Hash,
          s3Key: tempS3Key,
          s3Bucket: S3_BUCKET,
          s3Region: S3_REGION,
          uploadStatus: 'PENDING',
          uploadedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    } catch (e) {
      // Deux préparations simultanées de la même opération : l'index unique
      // (0241) a refusé la seconde ligne — on rend celle de la première.
      // Drizzle enveloppe l'erreur du pilote : le code est sur `cause`.
      const code = (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
      if (code === '23505' && cleOperation) {
        const reprise = await reprendre();
        if (reprise) return reprise;
      }
      throw e;
    }

    if (newFile.length === 0) {
      throw new Error('Failed to create file record');
    }

    const fileId = newFile[0].id;

    // Generate S3 key using normalized format - supports null assetId
    const timestamp = Date.now();
    const s3Key = generateS3Key({
      userId: userId,
      assetId: assetIdInt,
      fileId: fileId,
      timestamp: timestamp,
      sanitizedFilename: sanitizedFilename,
    });

    // Update the file record with the real S3 key — sauf si une reprise
    // concurrente de la même opération l'a déjà fixée : on signe alors CELLE-LÀ.
    const s3KeyRetenue = await fixerCleS3(fileId, s3Key);

    const uploadUrl = await signerDepot({ s3Key: s3KeyRetenue, mimeType, userId, assetId: assetIdInt, fileId, sha256Hash });

    // Return success response
    return NextResponse.json(
      {
        uploadUrl,
        fileId: fileId,
        s3Key: s3KeyRetenue,
        expiresIn: PRESIGNED_URL_EXPIRATION,
        uploadStatus: 'PENDING',
      },
      { status: 201 }
    );

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    const errMsg = (error as Error).message;
    if (errMsg === 'AUTH_REQUIRED' || errMsg === 'INVALID_TOKEN' || errMsg === 'ACCOUNT_SUSPENDED') {
      return SessionService.handleSessionError(error);
    }

    console.error('POST /api/files/presign error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}