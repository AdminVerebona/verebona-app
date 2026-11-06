import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { db } from '@/db';
import { supplierReviewItems, suppliers } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { apiError } from '@/lib/api-errors';
import { refsInAccount } from '@/services/security/account-ownership';
import { SUPPLIER_CONFLICT_APPLICABLE_FIELDS } from '@/lib/suppliers/supplier-fiche-config';

// POST /api/to-process/suppliers/[id]/resolve
// Lot 113G (#706) : fusion par la procédure unique `mergeSuppliersInTx` ;
// « nouvelle fiche » / « ignorer » d'un doute d'identité mémorisés par paire.
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
      // Lot 111X : valeur CHOISIE par l'utilisateur — protégée par champ (jamais remplacée par un document).
      const decision = JSON.stringify({ [item.conflictingField]: { action: 'SET', at: new Date().toISOString(), userId: session.userId ?? null } });
      await db.execute(
        sql`UPDATE suppliers SET ${sql.raw(colName)} = ${item.detectedValue}, updated_at = NOW(),
                   user_field_decisions = COALESCE(user_field_decisions, '{}'::jsonb) || ${decision}::jsonb
             WHERE id = ${item.supplierId} AND account_id = ${accountId}`
      );
    }

    if (resolution === 'merged' && targetSupplierId && item.supplierId && item.supplierId !== Number(targetSupplierId)) {
      // Lot 113G (#706) : procédure UNIQUE de fusion (`mergeSuppliersInTx`), dans une transaction —
      // documents (fiabilité réelle conservée), biens, équipements, observations, Agenda, Opérations,
      // revues, décisions et coordonnées non conflictuelles ; jamais de fusion « à moitié ».
      const { mergeSuppliersInTx, afterSupplierMerge, SupplierMergeError } = await import('@/services/suppliers/supplier-merge');
      try {
        const r = await db.transaction((tx) => mergeSuppliersInTx(tx, {
          accountId, fromId: item.supplierId!, toId: Number(targetSupplierId), actorUserId: session.userId ?? null, reviewId: item.id,
        }));
        await afterSupplierMerge(accountId, r);
      } catch (e) {
        if (e instanceof SupplierMergeError) return apiError(e.code === 'NOT_FOUND' ? 404 : 409, e.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_STATE', 'Supplier merge refused');
        throw e;
      }
    }

    // Lot 113G : « nouvelle fiche » / « ignorer » sur un doute d'identité = identités DISTINCTES, mémorisées
    // par paire — jamais reproposées par T1, T3, la cohérence ou un nouveau document sans preuve nouvelle.
    if (item.itemType === 'deduplication' && item.supplierId && (resolution === 'created_new' || resolution === 'ignored')) {
      const { reviewCandidateIds, recordPairDecision } = await import('@/services/suppliers/supplier-identity-reviews');
      const ids = reviewCandidateIds(item.candidateSupplierIds).filter((x) => x !== item.supplierId);
      if (ids.length) {
        const fiches = await db.select().from(suppliers)
          .where(and(eq(suppliers.accountId, accountId), sql`${suppliers.id} = ANY(${`{${[item.supplierId, ...ids].join(',')}}`}::int[])`));
        const a = fiches.find((f) => f.id === item.supplierId);
        for (const b of fiches) {
          if (!a || b.id === a.id) continue;
          await recordPairDecision(db, { accountId, a, b, decision: 'DISTINCT', reviewId: item.id, userId: session.userId ?? null, evidence: { resolution } });
        }
      }
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
