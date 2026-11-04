/**
 * Lot 109B — POINT D'EXTENSION : documents d'un fournisseur « via événement
 * de référence » (VIA_OPERATION).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * À RELIER PAR L'INTÉGRATEUR AU CONTRAT DE LECTURE DE 109A
 *
 * Le chantier 109A fournit le contrat serveur unique de lecture des relations
 * (documents DIRECT / VIA_OPERATION, Opération source, rôle, preuve). La
 * fiche fournisseur (109B) n'en connaît qu'UNE fonction, celle-ci :
 *
 *   listSupplierDocumentsViaOperation(accountId, supplierId, { offset, limit })
 *
 * (RELIÉ à l'intégration du lot 109.) Tant qu'elle n'était pas reliée, elle répond `wired: false` et la fiche
 * n'affiche AUCUNE section correspondante (rien d'inventé, aucun document
 * déduit du nom ou du voisinage). Pour la relier : remplacer le corps par
 * l'appel au contrat 109A, en conservant la signature et ces invariants :
 *
 *   · bornée au compte (`accountId`) — aucun objet d'un autre compte ;
 *   · documents NON supprimés, dédoublonnés par identifiant ;
 *   · EXCLUT les documents déjà liés DIRECTEMENT au fournisseur
 *     (`document_suppliers`) : la section DIRECT reste la seule à les montrer ;
 *   · `total` exact avant pagination ; ordre stable (date du document
 *     décroissante puis identifiant) ;
 *   · jamais présentés comme « émis par » ce fournisseur : ce sont les
 *     documents de l'événement de référence (le mot « Opération » n'est
 *     jamais affiché).
 *
 * BRANCHEMENT (contrat 109A, `src/services/relations/read-contract.ts`) :
 *
 *   const r = await listSupplierDocuments(accountId, supplierId, {
 *     provenance: 'VIA_OPERATION_ONLY',                      // exclut les DIRECTS
 *     pageSize: page.limit,                                 // ≤ 200
 *     page: Math.floor(page.offset / page.limit) + 1,       // décalage → page (1-based)
 *   });
 *   if (!r) return { wired: true, items: [], total: 0, offset: page.offset, limit: page.limit, nextOffset: null };
 *   return {
 *     wired: true, total: r.total, offset: page.offset, limit: page.limit,
 *     nextOffset: r.hasMore ? page.offset + r.items.length : null,
 *     items: r.items.map((d) => ({
 *       id: d.id, title: d.title, documentTypeLabel: d.documentTypeLabel, documentDate: d.documentDate,
 *       assetName: d.assetName, available: d.available,
 *       operationId: d.viaOperations[0]?.operationId ?? 0, operationLabel: null,
 *     })),
 *   };
 *
 * Les offsets demandés par la fiche sont toujours multiples de la taille de
 * page (première page puis pages suivantes de même taille) : la conversion
 * décalage → page est exacte.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { listSupplierDocuments, RELATIONS_MAX_PAGE_SIZE } from '@/services/relations/read-contract';

export interface SupplierViaOperationDocument {
  id: number;
  title: string;
  documentTypeLabel: string | null;
  documentDate: string | null;
  assetName: string | null;
  available: boolean;
  /** Événement de référence source (identifiant interne, jamais affiché tel quel). */
  operationId: number;
  /** Libellé lisible de l'événement de référence, s'il existe. */
  operationLabel: string | null;
}

export interface SupplierViaOperationPage {
  /** `false` tant que le contrat de 109A n'est pas relié : la fiche masque la section. */
  wired: boolean;
  items: SupplierViaOperationDocument[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
}

export async function listSupplierDocumentsViaOperation(
  accountId: number,
  supplierId: number,
  page: { offset: number; limit: number },
): Promise<SupplierViaOperationPage> {
  // Intégration lot 109 : relié au contrat de lecture 109A (provenance VIA_OPERATION_ONLY,
  // qui exclut les documents déjà liés directement au fournisseur).
  const limit = Math.max(1, Math.min(page.limit, RELATIONS_MAX_PAGE_SIZE));
  const offset = Math.max(0, page.offset);
  const r = await listSupplierDocuments(accountId, supplierId, {
    provenance: 'VIA_OPERATION_ONLY',
    pageSize: limit,
    page: Math.floor(offset / limit) + 1,
  });
  if (!r) return { wired: true, items: [], total: 0, offset, limit, nextOffset: null };
  return {
    wired: true,
    total: r.total,
    offset,
    limit,
    nextOffset: r.hasMore ? offset + r.items.length : null,
    items: r.items.map((d) => ({
      id: d.id,
      title: d.title,
      documentTypeLabel: d.documentTypeLabel,
      documentDate: d.documentDate,
      assetName: d.assetName,
      available: d.available,
      operationId: d.viaOperations[0]?.operationId ?? 0,
      operationLabel: null,
    })),
  };
}
