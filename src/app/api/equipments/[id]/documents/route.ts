import { NextRequest, NextResponse } from 'next/server';
import { documentTypeDisplayLabel } from '@/lib/referential/v2';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { equipmentInAccount } from '@/services/security/account-ownership';
import { listAll, listEntityDocuments, pageOptionsFromSearch, type RelatedDocument } from '@/services/relations/read-contract';

// GET /api/equipments/[id]/documents — documents d'un équipement.
// Lot 109A (ticket « Relations métier », §6) : CONTRAT DE LECTURE UNIQUE
// (`services/relations/read-contract.ts`) —
//   · DIRECT : colonne historique `equipment_id` OU lien N-N actif
//     (`document_asset_links`, cible équipement, rôle PRIMARY / SECONDARY) ;
//   · VIA_OPERATION : document membre d'une Opération active liée à
//     l'équipement — consultable par l'Opération, JAMAIS transformé en lien
//     direct (aucun produit cartésien).
// Chaque document une seule fois ; `total` / `totals` exacts avant
// pagination ; sans `page`, la liste est EXHAUSTIVE (toutes les pages).
// Lot 49 (SEC-06) : équipement du compte vérifié AVANT la lecture ; documents
// et bien joint bornés au compte.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const { id } = await params;
    const equipmentId = parseInt(id);
    if (isNaN(equipmentId)) return apiError(400, 'INVALID_INPUT', 'Invalid equipment id');
    if (!(await equipmentInAccount(accountId, equipmentId))) return apiError(404, 'NOT_FOUND', 'Equipment not found');

    const search = new URL(request.url).searchParams;
    const opts = pageOptionsFromSearch(search);
    const entity = { kind: 'equipment' as const, id: equipmentId };
    const page = search.has('page')
      ? await listEntityDocuments(accountId, entity, opts)
      : await listAll((p) => listEntityDocuments(accountId, entity, { ...opts, page: p, pageSize: 200 }));
    if (!page) return apiError(404, 'NOT_FOUND', 'Equipment not found');

    const documents = page.items.map((doc: RelatedDocument) => ({
      id: doc.id,
      publicId: doc.publicId,
      title: doc.title,
      documentType: doc.documentType,
      // Lot 86E (ticket §5) : libellé du Type V2 ENREGISTRÉ, comme « Mes documents ».
      documentTypeCode: doc.documentTypeCode,
      documentTypeLabel: documentTypeDisplayLabel(doc.documentTypeCode),
      documentDate: doc.documentDate,
      mimeType: doc.mimeType,
      assetId: doc.assetId,
      assetName: doc.assetName,
      webLinkUrl: doc.webLinkUrl,
      createdAt: doc.createdAt,
      // Lot 109A : provenance du rattachement (DIRECT / VIA_OPERATION), preuves directes, Opérations de contexte.
      provenance: doc.provenance,
      direct: doc.direct,
      viaOperations: doc.viaOperations,
    }));

    return NextResponse.json({
      documents,
      contract: page.contract,
      total: page.total,
      totals: page.totals,
      page: page.page,
      pageSize: page.pageSize,
      pageCount: page.pageCount,
      hasMore: page.hasMore,
    });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
