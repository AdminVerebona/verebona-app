import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetTransmissions, assetFiles, assets } from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

interface DocumentRef {
  id: number;
  s3Key: string | null;
  s3Bucket: string | null;
  originalFilename: string | null;
  documentType: string | null;
  documentDate: string | null;
  description: string | null;
  supplier: string | null;
  amountCents: number | null;
  notes: string | null;
  retainedTitle: string | null;
  retainedFunctionCode: string | null;
  mimeType: string | null;
  size: number | null;
  isWebLink: boolean;
  webLinkUrl: string | null;
  webLinkTitle: string | null;
}

/**
 * GET /api/admin/migrate/fix-transmission-documents
 * Repairs accepted transmissions where the duplicated asset has no documents.
 * Re-copies documents from snapshotPayload according to selectedPayload.
 */
export async function GET(request: NextRequest) {
  await requireAdmin(request);

  const now = new Date();

  // Find all accepted transmissions with a duplicated asset
  const transmissions = await db
    .select({
      id: assetTransmissions.id,
      duplicatedAssetId: assetTransmissions.duplicatedAssetId,
      snapshotPayload: assetTransmissions.snapshotPayload,
      selectedPayload: assetTransmissions.selectedPayload,
    })
    .from(assetTransmissions)
    .where(eq(assetTransmissions.status, 'accepted'));

  let fixed = 0;
  let skipped = 0;
  let alreadyOk = 0;
  const errors: string[] = [];

  for (const tx of transmissions) {
    if (!tx.duplicatedAssetId) { skipped++; continue; }

    // Check duplicated asset exists
    const [asset] = await db
      .select({ id: assets.id, userId: assets.userId, accountId: assets.accountId })
      .from(assets)
      .where(and(eq(assets.id, tx.duplicatedAssetId), isNull(assets.deletedAt)))
      .limit(1);

    if (!asset || !asset.accountId) { skipped++; continue; }

    // Check if asset already has documents
    const existing = await db
      .select({ id: assetFiles.id })
      .from(assetFiles)
      .where(and(eq(assetFiles.assetId, tx.duplicatedAssetId), isNull(assetFiles.deletedAt)))
      .limit(1);

    if (existing.length > 0) { alreadyOk++; continue; }

    // Parse snapshot
    let snapshot: any = null;
    try { snapshot = JSON.parse(tx.snapshotPayload || '{}'); } catch {}
    if (!snapshot?.documents) { skipped++; continue; }

    // Parse selectedPayload
    const selected = {
      includeDocuments: true as boolean,
      selectedDocIds: [] as number[],
    };
    try {
      const p = JSON.parse(tx.selectedPayload || '{}');
      selected.includeDocuments = p.includeDocuments ?? true;
      selected.selectedDocIds = p.selectedDocIds ?? [];
    } catch {}

    const allDocs: DocumentRef[] = Array.isArray(snapshot.documents) ? snapshot.documents : [];

    let docsToTransfer: DocumentRef[];
    if (!selected.includeDocuments) {
      docsToTransfer = [];
    } else if (selected.selectedDocIds.length > 0) {
      const selectedSet = new Set(selected.selectedDocIds);
      docsToTransfer = allDocs.filter((d: DocumentRef) => selectedSet.has(d.id));
    } else {
      docsToTransfer = allDocs;
    }

    if (docsToTransfer.length === 0) { skipped++; continue; }

    try {
      const insertValues = docsToTransfer.map((doc: DocumentRef) => ({
        userId: asset.userId,
        accountId: asset.accountId!,
        assetId: tx.duplicatedAssetId!,
        isWebLink: doc.isWebLink ?? false,
        webLinkUrl: doc.webLinkUrl ?? null,
        webLinkTitle: doc.webLinkTitle ?? null,
        filename: doc.originalFilename ?? null,
        originalFilename: doc.originalFilename ?? null,
        mimeType: doc.mimeType ?? null,
        fileExtension: doc.originalFilename?.split('.').pop() ?? null,
        size: doc.size ?? null,
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
      }));

      await db.insert(assetFiles).values(insertValues);
      fixed++;
      console.info(`[fix-transmission-docs] Copied ${insertValues.length} doc(s) to asset ${tx.duplicatedAssetId}`);
    } catch (err: any) {
      errors.push(`Transmission ${tx.id}: ${err?.message ?? err}`);
    }
  }

  return NextResponse.json({ fixed, skipped, alreadyOk, errors });
}
