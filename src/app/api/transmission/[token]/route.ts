/**
 * GET  /api/transmission/[token]
 *   Charge les données minimales d'une transmission (public, sans auth)
 *   Retourne : identité du bien + status. PAS de détail du périmètre transmis.
 *
 * POST /api/transmission/[token]
 *   Accepter ou refuser la transmission
 *   body: { action: 'accept' | 'refuse', recipientUserId?: number, confirmDuplicate?: boolean }
 *
 *   Acceptation :
 *   - Duplique le bien chez le destinataire
 *   - Copie les documents sélectionnés (selectedPayload) depuis le snapshot
 *   - Si doublon détecté (même nom + catégorie) → retourne { conflict: true } sauf si confirmDuplicate=true
 *   - Archive le bien émetteur (status='TRANSMIS', archivedReason='transmitted') sauf si keepActiveAfter=true
 *
 *   Refus :
 *   - status='refused', bien émetteur inchangé
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { accountMemberships, assetTransmissions, assets, assetFiles, agendaItems, agendaAssetLinks, users } from '@/db/schema';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { emit } from '@/lib/notifications';
import { SessionService } from '@/lib/session-service';
import { CopyObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, S3_BUCKET } from '@/lib/s3-client';
import { generateS3Key, parseS3Key } from '@/lib/s3-naming';

/**
 * Copie un objet S3 vers une nouvelle clé propre au destinataire.
 * Retourne la nouvelle clé, ou null si la copie est impossible (web-link, clé manquante, erreur S3).
 */
async function copyS3File(
  sourceKey: string | null,
  sourceBucket: string | null,
  recipientUserId: number,
  newAssetId: number,
  newFileId: number,
  originalFilename: string | null,
): Promise<string | null> {
  if (!sourceKey || !sourceBucket || !S3_BUCKET) return null;
  const parsed = parseS3Key(sourceKey);
  const sanitizedFilename = parsed?.sanitizedFilename ?? (originalFilename ?? 'file');
  const newKey = generateS3Key({
    userId: recipientUserId,
    assetId: newAssetId,
    fileId: newFileId,
    timestamp: Date.now(),
    sanitizedFilename,
  });
  await s3Client.send(new CopyObjectCommand({
    Bucket: S3_BUCKET,
    CopySource: `${sourceBucket}/${sourceKey}`,
    Key: newKey,
  }));
  return newKey;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SelectedPayload {
  includeDocuments: boolean;
  selectedDocIds: number[];
  includeEquipments: boolean;
  selectedEquipmentIds: number[];
  includePhotos: boolean;
  selectedPhotoIds: number[];
  includeEvents: boolean;
  selectedEventIds: number[];
  includeThumbnail?: boolean;
}

interface DocumentRef {
  id: number;
  s3Key: string | null;
  s3Bucket: string | null;
  originalFilename: string | null;
  documentType: string | null;
  documentDate: string | null;
  description: string | null;
  retainedTitle: string | null;
  retainedFunctionCode: string | null;
  mimeType: string | null;
  size: number | null;
  sha256Hash?: string | null;
  isWebLink: boolean;
  webLinkUrl: string | null;
  webLinkTitle: string | null;
  substructureId: number | null;
  equipmentId: number | null;
  supplier?: string | null;
  amountCents?: number | null;
  notes?: string | null;
}

interface PhotoRef {
  id: number;
  fileId: number | null;
  s3Key: string | null;
  s3Bucket: string | null;
  mimeType: string | null;
  originalFilename: string | null;
  size: number | null;
  displayOrder: number;
  isPrimary: boolean;
  caption: string | null;
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  const [row] = await db
    .select({
      id: assetTransmissions.id,
      status: assetTransmissions.status,
      assetId: assetTransmissions.assetId,
      snapshotPayload: assetTransmissions.snapshotPayload,
      cancelledAt: assetTransmissions.cancelledAt,
      recipientEmail: assetTransmissions.recipientEmail,
    })
    .from(assetTransmissions)
    .where(eq(assetTransmissions.token, token))
    .limit(1);

  if (!row) return NextResponse.json({ error: 'INVALID_TOKEN' }, { status: 404 });

  if (row.status === 'cancelled') {
    return NextResponse.json({ status: 'cancelled', message: 'Cette invitation a été annulée.' });
  }
  if (row.status === 'accepted') {
    return NextResponse.json({ status: 'accepted', message: 'Cette invitation a déjà été acceptée.' });
  }
  if (row.status === 'refused') {
    return NextResponse.json({ status: 'refused', message: 'Cette invitation a déjà été refusée.' });
  }

  // Check if recipient already has an account
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, row.recipientEmail))
    .limit(1);
  const recipientHasAccount = !!existingUser;

  // Parse snapshot for minimal identity (no perimeter details exposed)
  let assetIdentity: { id: number; name: string; category: string; subtype: string | null } | null = null;
  if (row.snapshotPayload) {
    try {
      const snap = JSON.parse(row.snapshotPayload);
      assetIdentity = {
        id: snap.id,
        name: snap.name,
        category: snap.category,
        subtype: snap.subtype ?? null,
      };
    } catch {}
  }

  return NextResponse.json({
    status: row.status,
    asset: assetIdentity,
    recipientHasAccount,
    recipientEmail: row.recipientEmail,
  });
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const body = await request.json().catch(() => ({}));
  const { action, recipientUserId, confirmDuplicate } = body as {
    action?: 'accept' | 'refuse';
    recipientUserId?: number;
    confirmDuplicate?: boolean;
  };

  if (!['accept', 'refuse'].includes(action ?? '')) {
    return NextResponse.json({ error: 'INVALID_ACTION' }, { status: 400 });
  }

  const [row] = await db
    .select()
    .from(assetTransmissions)
    .where(eq(assetTransmissions.token, token))
    .limit(1);

  if (!row) return NextResponse.json({ error: 'INVALID_TOKEN' }, { status: 404 });

  if (row.status === 'cancelled') {
    return NextResponse.json({ error: 'CANCELLED', message: 'Cette invitation a été annulée.' }, { status: 410 });
  }

  if (row.status !== 'pending') {
    return NextResponse.json({ error: 'ALREADY_RESPONDED', status: row.status }, { status: 409 });
  }

  const now = new Date();

  if (action === 'refuse') {
    await db
      .update(assetTransmissions)
      .set({ status: 'refused', refusedAt: now })
      .where(eq(assetTransmissions.id, row.id));

    // Notify initiator
    let snapshot: any = null;
    try { snapshot = JSON.parse(row.snapshotPayload || '{}'); } catch {}
    const refuserName = row.recipientEmail;
    await emit({
      type: 'TRANSMISSION_REFUSED',
      recipientUserIds: [row.initiatorUserId],
      entityType: 'asset_transmission',
      entityId: row.id,
      payload: { recipientName: refuserName, assetName: snapshot?.name ?? 'votre bien' },
      dedupeKey: `transmission:refused:${row.id}`,
    });

    return NextResponse.json({ success: true, status: 'refused' });
  }

  // ── ACCEPT ────────────────────────────────────────────────────────────────

  // Parse snapshot
  let snapshot: any = null;
  try { snapshot = JSON.parse(row.snapshotPayload || '{}'); } catch {}
  if (!snapshot?.name) {
    return NextResponse.json({ error: 'INVALID_SNAPSHOT' }, { status: 500 });
  }

  // Parse selectedPayload
  let selected: SelectedPayload = {
    includeDocuments: true,
    selectedDocIds: [],
    includeEquipments: true,
    selectedEquipmentIds: [],
    includePhotos: true,
    selectedPhotoIds: [],
    includeEvents: true,
    selectedEventIds: [],
    includeThumbnail: true,
  };
  try { selected = { ...selected, ...JSON.parse(row.selectedPayload || '{}') }; } catch {}

  // Resolve recipient user — session > explicit id > email lookup
  let recipientUser: { id: number; accountId: number | null } | null = null;

  const resolveAccountId = async (userId: number): Promise<number | null> => {
    const [membership] = await db
      .select({ accountId: accountMemberships.accountId })
      .from(accountMemberships)
      .where(eq(accountMemberships.userId, userId))
      .limit(1);
    return membership?.accountId ?? null;
  };

  // Prefer the authenticated session if present
  const session = await SessionService.tryGetSession(request);
  if (session) {
    recipientUser = { id: session.userId, accountId: await resolveAccountId(session.userId) };
  }

  if (!recipientUser && recipientUserId) {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, recipientUserId))
      .limit(1);
    if (u) recipientUser = { id: u.id, accountId: await resolveAccountId(u.id) };
  }
  if (!recipientUser && row.recipientEmail) {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, row.recipientEmail))
      .limit(1);
    if (u) recipientUser = { id: u.id, accountId: await resolveAccountId(u.id) };
  }

  // No account exists yet — keep transmission pending, ask recipient to sign up
  if (!recipientUser) {
    return NextResponse.json({
      requiresSignup: true,
      recipientEmail: row.recipientEmail,
    });
  }

  // Doublon check: uniquement les biens en cours d'usage actif (EN_SERVICE, EN_PANNE, EN_REPARATION).
  // VENDU, DETRUIT, INACTIF, ARCHIVED, TRANSMIS ne comptent pas comme doublons.
  if (!confirmDuplicate) {
    const existingAssets = await db
      .select({ id: assets.id, name: assets.name })
      .from(assets)
      .where(and(
        eq(assets.userId, recipientUser.id),
        eq(assets.name, snapshot.name),
        eq(assets.category, snapshot.category),
        isNull(assets.deletedAt),
        inArray(assets.status, ['EN_SERVICE', 'EN_PANNE', 'EN_REPARATION']),
      ))
      .limit(1);

    if (existingAssets.length > 0) {
      return NextResponse.json({
        conflict: true,
        existingAssetId: existingAssets[0].id,
        message: 'Un bien avec ce nom et cette catégorie existe déjà dans votre portefeuille.',
      }, { status: 200 });
    }
  }

  // ── 1. Duplicate asset record for recipient ────────────────────────────────
  let duplicatedAssetId: number | null = null;

  try {
    const [newAsset] = await db
      .insert(assets)
      .values({
        userId: recipientUser.id,
        accountId: recipientUser.accountId,
        category: snapshot.category,
        subtype: snapshot.subtype ?? null,
        name: snapshot.name,
        status: snapshot.status ?? 'EN_SERVICE',
        purchaseDate: snapshot.purchaseDate ?? null,
        purchasePriceCents: snapshot.purchasePriceCents ?? null,
        estimatedValueCents: snapshot.estimatedValueCents ?? null,
        generalCondition: snapshot.generalCondition ?? null,
        notes: snapshot.notes ?? null,
        warrantyEndDate: snapshot.warrantyEndDate ?? null,
        mileageOrHours: snapshot.mileageOrHours ?? null,
        lastMaintenanceDate: snapshot.lastMaintenanceDate ?? null,
        registrationNumber: snapshot.registrationNumber ?? null,
        address: snapshot.address ?? null,
        city: snapshot.city ?? null,
        postalCode: snapshot.postalCode ?? null,
        keyCharacteristics: JSON.stringify({
          ...(snapshot.keyCharacteristics ?? {}),
          acquisitionDate: now.toISOString().split('T')[0],
        }),
        thumbnailUrl: (selected.includeThumbnail !== false && snapshot.thumbnailUrl) ? snapshot.thumbnailUrl : null,
        copySourceRequestId: row.id,
        scope: 'personal',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: assets.id });
    duplicatedAssetId = newAsset.id;
  } catch (err) {
    console.error('[Transmission] Failed to duplicate asset:', err);
    return NextResponse.json({ error: 'DUPLICATION_FAILED' }, { status: 500 });
  }

  // ── 2. Copy documents ─────────────────────────────────────────────────────
  // selectedDocIds: query the DB directly (avoids snapshot staleness — docs
  // uploaded right before initiation may still be processing in the snapshot).
  // include-all fallback: use snapshot (point-in-time semantics).
  if (duplicatedAssetId && recipientUser.accountId) {
    const allSnapshotDocs: DocumentRef[] = Array.isArray(snapshot.documents) ? snapshot.documents : [];

    let docsToTransfer: DocumentRef[];
    if (!selected.includeDocuments) {
      docsToTransfer = [];
    } else if (selected.selectedDocIds && selected.selectedDocIds.length > 0) {
      // Fetch directly from DB by ID — bypasses any snapshot freshness issue
      const dbDocs = await db
        .select({
          id: assetFiles.id,
          s3Key: assetFiles.s3Key,
          s3Bucket: assetFiles.s3Bucket,
          originalFilename: assetFiles.originalFilename,
          documentType: assetFiles.documentType,
          documentDate: assetFiles.documentDate,
          description: assetFiles.description,
          retainedTitle: assetFiles.retainedTitle,
          retainedFunctionCode: assetFiles.retainedFunctionCode,
          mimeType: assetFiles.mimeType,
          size: assetFiles.size,
          sha256Hash: assetFiles.sha256Hash,
          isWebLink: assetFiles.isWebLink,
          webLinkUrl: assetFiles.webLinkUrl,
          webLinkTitle: assetFiles.webLinkTitle,
          substructureId: assetFiles.substructureId,
          equipmentId: assetFiles.equipmentId,
          supplier: assetFiles.supplier,
          amountCents: assetFiles.amountCents,
          notes: assetFiles.notes,
        })
        .from(assetFiles)
        .where(and(
          inArray(assetFiles.id, selected.selectedDocIds),
          isNull(assetFiles.deletedAt),
        ));
      docsToTransfer = dbDocs as DocumentRef[];
    } else {
      // No specific selection — include all from snapshot (point-in-time)
      docsToTransfer = allSnapshotDocs;
    }

    // Insert all docs in DB first (sequential — each needs a new ID for the S3 key)
    const insertedDocs: Array<{ newFileId: number; doc: DocumentRef }> = [];
    for (const doc of docsToTransfer) {
      try {
        const [newFile] = await db.insert(assetFiles).values({
          userId: recipientUser!.id,
          accountId: recipientUser!.accountId!,
          assetId: duplicatedAssetId!,
          isWebLink: doc.isWebLink ?? false,
          webLinkUrl: doc.webLinkUrl ?? null,
          webLinkTitle: doc.webLinkTitle ?? null,
          filename: doc.originalFilename ?? null,
          originalFilename: doc.originalFilename ?? null,
          mimeType: doc.mimeType ?? null,
          fileExtension: doc.originalFilename?.split('.').pop() ?? null,
          size: doc.size ?? null,
          sha256Hash: doc.sha256Hash ?? null,
          s3Key: doc.s3Key ?? null,
          s3Bucket: doc.s3Bucket ?? null,
          documentType: doc.documentType ?? 'AUTRE',
          documentDate: doc.documentDate ? String(doc.documentDate).split('T')[0] : null,
          description: doc.description ?? null,
          supplier: doc.supplier ?? null,
          amountCents: doc.amountCents ?? null,
          notes: doc.notes ?? null,
          retainedTitle: doc.retainedTitle ?? null,
          retainedFunctionCode: doc.retainedFunctionCode ?? null,
          uploadStatus: 'COMPLETED' as const,
          scope: 'personal' as const,
          isDraft: false,
          isIgnored: false,
          uploadedAt: now,
          createdAt: now,
          updatedAt: now,
        }).returning({ id: assetFiles.id });
        insertedDocs.push({ newFileId: newFile.id, doc });
      } catch (err) {
        console.error(`[Transmission] Failed to insert doc id=${doc.id} (${doc.originalFilename}):`, err);
      }
    }

    // Copy S3 objects in parallel batches of 10
    const BATCH = 10;
    let docsCopied = 0;
    for (let i = 0; i < insertedDocs.length; i += BATCH) {
      const batch = insertedDocs.slice(i, i + BATCH);
      await Promise.all(batch.map(async ({ newFileId, doc }) => {
        if (!doc.isWebLink && doc.s3Key && doc.s3Bucket) {
          try {
            const newKey = await copyS3File(
              doc.s3Key,
              doc.s3Bucket,
              recipientUser!.id,
              duplicatedAssetId!,
              newFileId,
              doc.originalFilename,
            );
            if (newKey) {
              await db.update(assetFiles)
                .set({ s3Key: newKey, s3Bucket: S3_BUCKET })
                .where(eq(assetFiles.id, newFileId));
            }
          } catch (s3Err) {
            console.error(`[Transmission] S3 copy failed for doc id=${doc.id}, recipient keeps reference to source key:`, s3Err);
          }
        }
        docsCopied++;
      }));
    }
    if (docsCopied > 0) console.info(`[Transmission] Copied ${docsCopied}/${docsToTransfer.length} document(s) to asset ${duplicatedAssetId}`);
  }

  // ── 3. Copy photos ────────────────────────────────────────────────────────
  // selectedPhotoIds = assetFiles.id values — fetch from DB for same reasons as docs.
  if (duplicatedAssetId && recipientUser.accountId) {
    const allSnapshotPhotos: PhotoRef[] = Array.isArray(snapshot.photos) ? snapshot.photos : [];

    let photosToTransfer: PhotoRef[];
    if (!selected.includePhotos) {
      photosToTransfer = [];
    } else if (selected.selectedPhotoIds && selected.selectedPhotoIds.length > 0) {
      // Fetch photo file metadata directly from DB by assetFiles.id
      const dbPhotoFiles = await db
        .select({
          id: assetFiles.id,
          s3Key: assetFiles.s3Key,
          s3Bucket: assetFiles.s3Bucket,
          mimeType: assetFiles.mimeType,
          originalFilename: assetFiles.originalFilename,
          size: assetFiles.size,
        })
        .from(assetFiles)
        .where(and(
          inArray(assetFiles.id, selected.selectedPhotoIds),
          isNull(assetFiles.deletedAt),
        ));
      // Re-attach photo display metadata (displayOrder, isPrimary, caption) from snapshot
      const snapshotPhotoMap = new Map(allSnapshotPhotos.map(p => [p.fileId, p]));
      photosToTransfer = dbPhotoFiles.map(f => {
        const snap = snapshotPhotoMap.get(f.id);
        return {
          id: snap?.id ?? 0,
          fileId: f.id,
          s3Key: f.s3Key ?? null,
          s3Bucket: f.s3Bucket ?? null,
          mimeType: f.mimeType ?? null,
          originalFilename: f.originalFilename ?? null,
          size: f.size ?? null,
          displayOrder: snap?.displayOrder ?? 0,
          isPrimary: snap?.isPrimary ?? false,
          caption: snap?.caption ?? null,
        };
      });
    } else {
      photosToTransfer = allSnapshotPhotos;
    }

    let photosCopied = 0;
    for (const photo of photosToTransfer) {
      try {
        const [newFile] = await db.insert(assetFiles).values({
          userId: recipientUser.id,
          accountId: recipientUser.accountId!,
          assetId: duplicatedAssetId,
          isWebLink: false,
          filename: photo.originalFilename ?? null,
          originalFilename: photo.originalFilename ?? null,
          mimeType: photo.mimeType ?? 'image/jpeg',
          fileExtension: photo.originalFilename?.split('.').pop() ?? null,
          size: photo.size ?? null,
          s3Key: photo.s3Key ?? null,
          s3Bucket: photo.s3Bucket ?? null,
          documentType: 'AUTRE',
          uploadStatus: 'COMPLETED' as const,
          scope: 'personal' as const,
          isDraft: false,
          isIgnored: false,
          uploadedAt: now,
          createdAt: now,
          updatedAt: now,
        }).returning({ id: assetFiles.id });

        if (photo.s3Key && photo.s3Bucket) {
          try {
            const newKey = await copyS3File(
              photo.s3Key,
              photo.s3Bucket,
              recipientUser.id,
              duplicatedAssetId,
              newFile.id,
              photo.originalFilename,
            );
            if (newKey) {
              await db.update(assetFiles)
                .set({ s3Key: newKey, s3Bucket: S3_BUCKET })
                .where(eq(assetFiles.id, newFile.id));
            }
          } catch (s3Err) {
            console.error(`[Transmission] S3 copy failed for photo id=${photo.fileId}, recipient keeps reference to source key:`, s3Err);
          }
        }

        photosCopied++;
      } catch (err) {
        console.error(`[Transmission] Failed to copy photo id=${photo.fileId} (${photo.originalFilename}):`, err);
      }
    }
    if (photosCopied > 0) console.info(`[Transmission] Copied ${photosCopied}/${photosToTransfer.length} photo(s) to asset ${duplicatedAssetId}`);
  }

  // ── 4. Copy agenda items ──────────────────────────────────────────────────
  if (duplicatedAssetId && recipientUser.accountId && selected.includeEvents) {
    // Find all agenda items linked to the source asset
    const linkedItems = await db
      .select({ item: agendaItems })
      .from(agendaItems)
      .innerJoin(agendaAssetLinks, eq(agendaAssetLinks.agendaItemId, agendaItems.id))
      .where(
        selected.selectedEventIds && selected.selectedEventIds.length > 0
          ? and(eq(agendaAssetLinks.assetId, row.assetId), inArray(agendaItems.id, selected.selectedEventIds))
          : eq(agendaAssetLinks.assetId, row.assetId)
      );

    let agendaCopied = 0;
    for (const { item } of linkedItems) {
      try {
        const [newItem] = await db.insert(agendaItems).values({
          accountId: recipientUser.accountId!,
          createdByUserId: recipientUser.id,
          title: item.title,
          description: item.description ?? null,
          startDate: item.startDate ?? null,
          startTime: item.startTime ?? null,
          endDate: item.endDate ?? null,
          endTime: item.endTime ?? null,
          manualStatus: item.manualStatus ?? null,
          isAutomatic: false,
          isAutomaticModified: false,
          requiresQualification: false,
          originType: 'manual',
          createdAt: now,
          updatedAt: now,
        }).returning({ id: agendaItems.id });

        // Link the new agenda item to the duplicated asset
        await db.insert(agendaAssetLinks).values({
          agendaItemId: newItem.id,
          assetId: duplicatedAssetId!,
        });
        agendaCopied++;
      } catch (err) {
        console.error(`[Transmission] Failed to copy agenda item id=${item.id} (${item.title}):`, err);
      }
    }
    if (agendaCopied > 0) console.info(`[Transmission] Copied ${agendaCopied}/${linkedItems.length} agenda item(s) to asset ${duplicatedAssetId}`);
  }

  // ── 5. Archive sender's asset unless keepActiveAfter ──────────────────────
  if (!row.keepActiveAfter) {
    await db
      .update(assets)
      .set({ status: 'TRANSMIS', archivedReason: 'transmitted' })
      .where(eq(assets.id, row.assetId));
  }

  // ── 6. Update transmission record ─────────────────────────────────────────
  await db
    .update(assetTransmissions)
    .set({
      status: 'accepted',
      acceptedAt: now,
      recipientUserId: recipientUser.id,
      duplicatedAssetId,
    })
    .where(eq(assetTransmissions.id, row.id));

  // Notify initiator of acceptance
  const [recipientUserInfo] = await db
    .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
    .from(users)
    .where(eq(users.id, recipientUser.id))
    .limit(1);
  const recipientDisplayName = recipientUserInfo
    ? [recipientUserInfo.firstName, recipientUserInfo.lastName].filter(Boolean).join(' ') || recipientUserInfo.email
    : row.recipientEmail;
  await emit({
    type: 'TRANSMISSION_ACCEPTED',
    recipientUserIds: [row.initiatorUserId],
    entityType: 'asset_transmission',
    entityId: row.id,
    payload: { recipientName: recipientDisplayName, assetName: snapshot?.name ?? 'votre bien' },
    dedupeKey: `transmission:accepted:${row.id}`,
  });

  // Check if recipient has an account (for redirect hint)
  const [recipientUserCheck] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, row.recipientEmail))
    .limit(1);

  return NextResponse.json({
    success: true,
    status: 'accepted',
    duplicatedAssetId,
    recipientHasAccount: !!recipientUserCheck,
  });
}
