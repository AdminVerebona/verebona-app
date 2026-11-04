import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { db } from '@/db';
import { supplierReviewItems, suppliers, documentSuppliers, assetFiles } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { apiError } from '@/lib/api-errors';
import { refsInAccount } from '@/services/security/account-ownership';
import { SUPPLIER_CONFLICT_APPLICABLE_FIELDS } from '@/lib/suppliers/supplier-fiche-config';

// POST /api/to-process/suppliers/[id]/resolve
// Lot 49 (SEC-03, « autres relations fournisseurs ») : la fiche cible d'une
// fusion et la fiche de l'élément sont du compte actif, vérifiées avant toute
// écriture ; chaque écriture porte la condition de compte (un document d'un
// autre compte n'est jamais rattaché, une fiche d'un autre compte jamais
// modifiée ni archivée).
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');
    // Lot 85D : écriture refusée en lecture seule (essai échu, impayé, résilié, rétractation).
    const refus = await refuserSiLectureSeule(accountId);
    if (refus) return refus;

    const { id } = await params;
    const reviewItemId = parseInt(id);
    if (isNaN(reviewItemId)) return apiError(400, 'INVALID_INPUT', 'Invalid review item id');

    const [item] = await db
      .select()
      .from(supplierReviewItems)
      .where(and(
        eq(supplierReviewItems.id, reviewItemId),
        eq(supplierReviewItems.accountId, accountId),
        eq(supplierReviewItems.status, 'open'),
      ))
      .limit(1);

    if (!item) return apiError(404, 'NOT_FOUND', 'Review item not found');

    const body = await request.json();
    // resolution: 'merged' | 'created_new' | 'ignored' | 'modified' | 'keep_current' | 'use_detected'
    const { resolution, targetSupplierId } = body;

    if (!resolution) return apiError(400, 'INVALID_INPUT', 'resolution is required');

    const fiches = [item.supplierId, resolution === 'merged' ? targetSupplierId : null]
      .filter((x): x is number => x !== null && x !== undefined).map(Number);
    if (fiches.some((x) => !Number.isInteger(x)) || !(await refsInAccount(accountId, { supplier: fiches }))) {
      return apiError(404, 'NOT_FOUND', 'Supplier not found');
    }

    // Conflit de coordonnées : l'utilisateur choisit la valeur à garder
    if (resolution === 'use_detected' && item.conflictingField && item.detectedValue && item.supplierId) {
      // Lot 109B : table centralisée (fiche fournisseur et « À traiter ») ; corrige
      // les colonnes d'adresse (`address_line_1`/`_2`, l'ancienne table visait
      // `address_line1` inexistante). L'IBAN reste exclu (jamais appliqué d'un clic).
      const colName = SUPPLIER_CONFLICT_APPLICABLE_FIELDS[item.conflictingField];
      if (!colName) {
        return apiError(400, 'INVALID_INPUT', 'Champ de conflit non autorisé');
      }
      await db.execute(
        sql`UPDATE suppliers SET ${sql.raw(colName)} = ${item.detectedValue}, updated_at = NOW() WHERE id = ${item.supplierId} AND account_id = ${accountId}`
      );
    }

    if (resolution === 'merged' && targetSupplierId && item.supplierId && item.supplierId !== targetSupplierId) {
      // Migrate document links from item.supplierId to targetSupplierId
      // Documents DU COMPTE seulement (une relation incorrecte en base n'est
      // jamais reportée sur la fiche cible).
      const docLinks = await db
        .select({ documentId: documentSuppliers.documentId })
        .from(documentSuppliers)
        .innerJoin(assetFiles, and(eq(assetFiles.id, documentSuppliers.documentId), eq(assetFiles.accountId, accountId)))
        .where(eq(documentSuppliers.supplierId, item.supplierId));

      for (const { documentId } of docLinks) {
        const existingTarget = await db
          .select()
          .from(documentSuppliers)
          .where(and(
            eq(documentSuppliers.documentId, documentId),
            eq(documentSuppliers.supplierId, targetSupplierId),
          ))
          .limit(1);

        if (existingTarget.length === 0) {
          await db.insert(documentSuppliers).values({
            documentId,
            supplierId: targetSupplierId,
            isConfirmed: true,
          });
        }
        await db.delete(documentSuppliers).where(and(
          eq(documentSuppliers.documentId, documentId),
          eq(documentSuppliers.supplierId, item.supplierId),
        ));
      }

      // Lot 103E : fournisseurs / intervenants des éléments d'Agenda reportés sur la fiche conservée
      // (provenance la plus forte, retraits manuels conservés, sans doublon ni lien orphelin).
      const { mergeAgendaSupplierLinksInTx } = await import('@/services/agenda/agenda-suppliers');
      await db.transaction((tx) => mergeAgendaSupplierLinksInTx(tx, {
        accountId, fromSupplierId: item.supplierId!, toSupplierId: Number(targetSupplierId), actorUserId: session.userId ?? null,
      }));

      // Lot 109A : liens Opération ↔ fournisseur reportés sur la fiche conservée (décision de l'utilisateur la
      // plus forte, sans doublon), puis réévaluation T3 durable des Opérations des documents reportés.
      const { mergeOperationSuppliersAfterSupplierMerge } = await import('@/services/relations/operation-suppliers');
      await mergeOperationSuppliersAfterSupplierMerge({
        accountId, fromSupplierId: item.supplierId!, toSupplierId: Number(targetSupplierId), actorUserId: session.userId ?? null,
        documentIds: docLinks.map((d) => d.documentId),
      });

      // Archive old supplier
      await db.update(suppliers)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(and(eq(suppliers.id, item.supplierId), eq(suppliers.accountId, accountId)));
    }

    await db.update(supplierReviewItems)
      .set({
        status: 'resolved',
        resolution,
        resolvedByUserId: session.userId,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(supplierReviewItems.id, reviewItemId), eq(supplierReviewItems.accountId, accountId)));

    // CDC Assistant §25.7, §31.7 : élément « À traiter » résolu.
    await emitBusinessEvent({ type: 'TO_PROCESS_ITEM_UPDATED', accountId, entityId: reviewItemId });
    return NextResponse.json({ success: true });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
