import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { db } from '@/db';
import { suppliers } from '@/db/schema';
import { SessionService } from '@/lib/session-service';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { apiError } from '@/lib/api-errors';
import { normalizeName } from '@/services/suppliers/supplier-service';
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

    const normalizedName = normalizeName(name.trim());

    const [newSupplier] = await db.insert(suppliers).values({
      accountId,
      createdByUserId: session.userId,
      name: name.trim(),
      normalizedName,
      email: email?.trim() || null,
      phone: phone?.trim() || null,
      website: website?.trim() || null,
      addressLine1: addressLine1?.trim() || null,
      addressLine2: addressLine2?.trim() || null,
      postalCode: postalCode?.trim() || null,
      city: city?.trim() || null,
      country: country?.trim() || null,
      siret: siret?.trim() || null,
      vatNumber: vatNumber?.trim() || null,
      iban: iban?.trim() || null,
      ibanHolderName: ibanHolderName?.trim() || null,
      source: source ?? 'manual',
      // Lot 109B : aucun statut de vérification (notion supprimée).
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning({ id: suppliers.id, publicId: suppliers.publicId, name: suppliers.name, status: suppliers.status });

    // CDC Assistant §31.7 : modification d'un fournisseur (signal hors catalogue §25.7).
    await emitBusinessEvent({ type: 'SUPPLIER_CHANGED', accountId, entityId: newSupplier?.id ?? null });
    return NextResponse.json({ supplier: newSupplier }, { status: 201 });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
