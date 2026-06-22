import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { suppliers } from '@/db/schema';
import { eq, and, ilike, or } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { normalizeName } from '@/services/suppliers/supplier-service';

// GET /api/suppliers — list/search (iban excluded)
export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search')?.trim();
    const status = searchParams.get('status') ?? 'active';

    let rows;

    if (search) {
      const normalizedSearch = normalizeName(search);
      rows = await db
        .select({
          id: suppliers.id,
          publicId: suppliers.publicId,
          name: suppliers.name,
          normalizedName: suppliers.normalizedName,
          email: suppliers.email,
          phone: suppliers.phone,
          website: suppliers.website,
          addressLine1: suppliers.addressLine1,
          city: suppliers.city,
          postalCode: suppliers.postalCode,
          siret: suppliers.siret,
          vatNumber: suppliers.vatNumber,
          source: suppliers.source,
          contactStatus: suppliers.contactStatus,
          status: suppliers.status,
          scope: suppliers.scope,
          createdAt: suppliers.createdAt,
          // iban intentionally excluded from list
        })
        .from(suppliers)
        .where(and(
          eq(suppliers.accountId, accountId),
          eq(suppliers.status, status),
          or(
            ilike(suppliers.name, `%${search}%`),
            ilike(suppliers.normalizedName, `%${normalizedSearch}%`),
          ),
        ))
        .limit(20);
    } else {
      rows = await db
        .select({
          id: suppliers.id,
          publicId: suppliers.publicId,
          name: suppliers.name,
          normalizedName: suppliers.normalizedName,
          email: suppliers.email,
          phone: suppliers.phone,
          website: suppliers.website,
          addressLine1: suppliers.addressLine1,
          city: suppliers.city,
          postalCode: suppliers.postalCode,
          siret: suppliers.siret,
          vatNumber: suppliers.vatNumber,
          source: suppliers.source,
          contactStatus: suppliers.contactStatus,
          status: suppliers.status,
          scope: suppliers.scope,
          createdAt: suppliers.createdAt,
          // iban intentionally excluded from list
        })
        .from(suppliers)
        .where(and(
          eq(suppliers.accountId, accountId),
          eq(suppliers.status, status),
        ))
        .limit(100);
    }

    return NextResponse.json({ suppliers: rows });
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

    const body = await request.json();
    const { name, email, phone, website, addressLine1, addressLine2, postalCode, city, country,
      siret, vatNumber, iban, ibanHolderName, source } = body;

    if (!name?.trim()) {
      return apiError(400, 'INVALID_INPUT', 'name is required');
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
      contactStatus: 'unverified',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();

    return NextResponse.json({ supplier: newSupplier }, { status: 201 });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
