import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { apiError } from '@/lib/api-errors';
import { createSupplierForAccount } from '@/services/suppliers/supplier-write.facade';
import { listSuppliers, parseSupplierListQuery } from '@/services/suppliers/supplier-list.service';

// GET /api/suppliers — liste / recherche paginées (IBAN exclu).
// Lot 109B : plus de plafonds silencieux 100 / 20 — total exact, pages
// (`offset`, `limit` ≤ 100), tri (`sort`), statut (`status`), recherche
// (`search`) ; voir `supplier-list.service`. Aucun statut de vérification.
export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const query = parseSupplierListQuery(new URL(request.url).searchParams);
    return NextResponse.json(await listSuppliers(accountId, query));
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}

// POST /api/suppliers — create manually (all accounts)
export async function POST(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');
    // Lot 85D : écriture refusée en lecture seule (essai échu, impayé, résilié, rétractation).
    const refus = await refuserSiLectureSeule(accountId);
    if (refus) return refus;

    const body = await request.json();
    const { name, email, phone, website, addressLine1, addressLine2, postalCode, city, country,
      siret, vatNumber, iban, ibanHolderName, source } = body;

    if (!name?.trim()) {
      return apiError(400, 'INVALID_INPUT', 'name is required');
    }

    // Lot 103E : vérification À BLANC (tiroir Agenda, « Créer un fournisseur ») — mêmes
    // validations, même rapprochement que les documents (`findCandidates` / `assessMatch`),
    // AUCUNE écriture : la fiche n'est créée qu'à l'enregistrement de l'élément.
    if (body.dryRun === true) {
      if (String(name).trim().length > 200) return apiError(400, 'INVALID_INPUT', 'name is too long');
      const { checkSupplierDuplicate } = await import('@/services/agenda/agenda-suppliers');
      return NextResponse.json(await checkSupplierDuplicate(accountId, String(name)));
    }

    // Lot 114 (#753, W18) : création par la façade métier — la même que l'Assistant Verebona (validations,
    // mémoire des identités distinctes décidées par l'utilisateur, événement SUPPLIER_CHANGED).
    const newSupplier = await createSupplierForAccount({
      accountId, userId: session.userId,
      input: { name, email, phone, website, addressLine1, addressLine2, postalCode, city, country, siret, vatNumber, iban, ibanHolderName, source },
      confirmedDistinctFrom: Array.isArray(body.confirmedDistinctFrom) ? (body.confirmedDistinctFrom as unknown[]).map(Number) : [],
    });
    return NextResponse.json({ supplier: newSupplier }, { status: 201 });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
