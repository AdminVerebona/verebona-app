/**
 * POST /api/to-process/suppliers/bulk-resolve
 * Auto-resolves contact_conflict review items where the stored supplier value
 * and the observed value are identical once normalized (false positives caused
 * by formatting differences like "+33" vs "0", spaces in SIRET/TVA, etc.).
 *
 * Also accepts { resolution: 'ignored', ids: number[] } to bulk-ignore a
 * specific set of review item IDs (user-initiated "ignore all" action).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { supplierReviewItems, suppliers, supplierContactObservations } from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';

// ── Same normalizers as supplier-service.ts ──────────────────────────────────

// Legal forms to strip from name normalization
const LEGAL_FORMS = [
  'sas', 'sarl', 'sa', 'eurl', 'ei', 'sasu', 'snc', 'sci', 'scp', 'scop',
  'gie', 'sca', 'scs', 'eurl', 'selarl', 'selafa', 'selca', 'selas',
  'association', 'syndicat',
];

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove accents
    .replace(/['''`]/g, ' ')
    .replace(/[^\w\s]/g, ' ')        // remove non-word chars
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(word => !LEGAL_FORMS.includes(word))
    .join(' ');
}

function normalizePhone(v: string): string {
  let s = v.replace(/[\s.\-()]/g, '');
  if (s.startsWith('0033')) s = '+' + s.slice(2);
  if (/^0[1-9]\d{8}$/.test(s)) s = '+33' + s.slice(1);
  return s.toUpperCase();
}
function normalizeVat(v: string): string { return v.replace(/\s/g, '').toUpperCase(); }
function normalizeSiret(v: string): string { return v.replace(/[\s\-]/g, ''); }
function normalizeIban(v: string): string { return v.replace(/\s/g, '').toUpperCase(); }
function normalizeUrl(v: string): string { return v.trim().toLowerCase().replace(/\/$/, ''); }
function normalizeEmail(v: string): string { return v.trim().toLowerCase(); }
function normalizeText(v: string): string { return v.trim().replace(/\s+/g, ' ').toLowerCase(); }

const NORMALIZERS: Record<string, (v: string) => string> = {
  email:          normalizeEmail,
  phone:          normalizePhone,
  website:        normalizeUrl,
  addressLine1:   normalizeText,
  addressLine2:   normalizeText,
  postalCode:     (v) => v.trim().toUpperCase(),
  city:           normalizeText,
  country:        normalizeText,
  siret:          normalizeSiret,
  vatNumber:      normalizeVat,
  iban:           normalizeIban,
  ibanHolderName: normalizeText,
};

// Map conflictingField → supplier column and observation column
const FIELD_MAP: Record<string, { supplierKey: string; obsKey: string }> = {
  email:          { supplierKey: 'email',          obsKey: 'observedEmail' },
  phone:          { supplierKey: 'phone',           obsKey: 'observedPhone' },
  website:        { supplierKey: 'website',         obsKey: 'observedWebsite' },
  addressLine1:   { supplierKey: 'addressLine1',    obsKey: 'observedAddressLine1' },
  addressLine2:   { supplierKey: 'addressLine2',    obsKey: 'observedAddressLine2' },
  postalCode:     { supplierKey: 'postalCode',      obsKey: 'observedPostalCode' },
  city:           { supplierKey: 'city',            obsKey: 'observedCity' },
  country:        { supplierKey: 'country',         obsKey: 'observedCountry' },
  siret:          { supplierKey: 'siret',           obsKey: 'observedSiret' },
  vatNumber:      { supplierKey: 'vatNumber',       obsKey: 'observedVatNumber' },
  iban:           { supplierKey: 'iban',            obsKey: 'observedIban' },
  ibanHolderName: { supplierKey: 'ibanHolderName',  obsKey: 'observedIbanHolderName' },
};

export async function POST(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const body = await request.json().catch(() => ({}));

    // Mode 1: explicit ids + resolution (user-initiated bulk ignore)
    if (Array.isArray(body?.ids) && body.ids.length > 0) {
      const ids = (body.ids as unknown[]).filter((x): x is number => typeof x === 'number');
      if (ids.length > 0) {
        await db.update(supplierReviewItems)
          .set({
            status: 'resolved',
            resolution: 'ignored',
            resolvedByUserId: session.userId,
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(
            inArray(supplierReviewItems.id, ids),
            eq(supplierReviewItems.accountId, accountId),
            eq(supplierReviewItems.status, 'open'),
          ));
      }
      return NextResponse.json({ resolved: ids.length });
    }

    // Mode 2: auto-resolve false positives (normalized values now match)
    const openConflicts = await db
      .select({
        id: supplierReviewItems.id,
        supplierId: supplierReviewItems.supplierId,
        observationId: supplierReviewItems.observationId,
        conflictingField: supplierReviewItems.conflictingField,
        itemType: supplierReviewItems.itemType,
      })
      .from(supplierReviewItems)
      .where(and(
        eq(supplierReviewItems.accountId, accountId),
        eq(supplierReviewItems.status, 'open'),
        eq(supplierReviewItems.itemType, 'contact_conflict'),
      ));

    if (openConflicts.length === 0) {
      // Still try to auto-resolve deduplication items with no candidates
      const resolvedDedup = await autoResolveDeduplicationNoCandidates(db, accountId, session.userId);
      return NextResponse.json({ resolved: 0, deduplicationResolved: resolvedDedup });
    }

    // Load all involved suppliers and observations in one pass
    const supplierIds = [...new Set(openConflicts.map(c => c.supplierId).filter((x): x is number => x != null))];
    const observationIds = [...new Set(openConflicts.map(c => c.observationId).filter((x): x is number => x != null))];

    const [supplierRows, obsRows] = await Promise.all([
      supplierIds.length > 0
        ? db.select().from(suppliers).where(inArray(suppliers.id, supplierIds))
        : Promise.resolve([]),
      observationIds.length > 0
        ? db.select().from(supplierContactObservations).where(inArray(supplierContactObservations.id, observationIds))
        : Promise.resolve([]),
    ]);

    const supplierMap = new Map(supplierRows.map(s => [s.id, s]));
    const obsMap = new Map(obsRows.map(o => [o.id, o]));

    const falsePositiveIds: number[] = [];

    for (const conflict of openConflicts) {
      if (!conflict.supplierId || !conflict.observationId || !conflict.conflictingField) continue;

      const fieldCfg = FIELD_MAP[conflict.conflictingField];
      if (!fieldCfg) continue;

      const supplier = supplierMap.get(conflict.supplierId);
      const obs = obsMap.get(conflict.observationId);
      if (!supplier || !obs) continue;

      const current = (supplier as Record<string, unknown>)[fieldCfg.supplierKey] as string | null | undefined;
      const observed = (obs as Record<string, unknown>)[fieldCfg.obsKey] as string | null | undefined;

      if (!current || !observed) continue;

      const norm = NORMALIZERS[conflict.conflictingField] ?? ((v: string) => v.trim());
      if (norm(current) === norm(observed)) {
        falsePositiveIds.push(conflict.id);
      }
    }

    if (falsePositiveIds.length > 0) {
      await db.update(supplierReviewItems)
        .set({
          status: 'resolved',
          resolution: 'ignored',
          resolvedByUserId: session.userId,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          inArray(supplierReviewItems.id, falsePositiveIds),
          eq(supplierReviewItems.accountId, accountId),
        ));
    }

    // Also auto-resolve deduplication items with no candidates
    const resolvedDedup = await autoResolveDeduplicationNoCandidates(db, accountId, session.userId);

    return NextResponse.json({ resolved: falsePositiveIds.length, total: openConflicts.length, deduplicationResolved: resolvedDedup });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}

/**
 * Auto-resolve deduplication review items when the detected supplier name
 * already exists in the supplier list for this account. This handles cases like
 * "IKEA" being detected from multiple documents — once an IKEA supplier exists,
 * subsequent review items for the same name are pointless.
 *
 * Also resolves items that have no candidate supplier IDs (empty/null array),
 * since there's nothing for the user to merge against.
 */
async function autoResolveDeduplicationNoCandidates(
  dbInstance: typeof db,
  accountId: number,
  userId: number,
): Promise<number> {
  // Load all open deduplication items for this account
  const dedupItems = await dbInstance
    .select({
      id: supplierReviewItems.id,
      detectedName: supplierReviewItems.detectedName,
      supplierId: supplierReviewItems.supplierId,
    })
    .from(supplierReviewItems)
    .where(and(
      eq(supplierReviewItems.accountId, accountId),
      eq(supplierReviewItems.status, 'open'),
      eq(supplierReviewItems.itemType, 'deduplication'),
    ));

  if (dedupItems.length === 0) return 0;

  // Load all existing suppliers for this account (name lookup)
  const existingSuppliers = await dbInstance
    .select({
      id: suppliers.id,
      name: suppliers.name,
      normalizedName: suppliers.normalizedName,
    })
    .from(suppliers)
    .where(and(
      eq(suppliers.accountId, accountId),
      eq(suppliers.status, 'active'),
    ));

  // Build a set of all normalized supplier names for fast lookup
  const normalizedNames = new Set(existingSuppliers.map(s => s.normalizedName));

  const resolvableIds: number[] = [];

  for (const item of dedupItems) {
    // Case 1: no candidates → nothing to merge → auto-resolve
    // Case 2: the detected name (after normalization) already exists as a
    //         supplier name in this account → auto-resolve (same name)
    // Case 3: the supplier linked to this review item has a name that already
    //         exists elsewhere → auto-resolve (duplicate)
    const normalizedDetected = item.detectedName ? normalizeName(item.detectedName) : '';
    const linkedSupplier = item.supplierId
      ? existingSuppliers.find(s => s.id === item.supplierId)
      : null;

    if (
      !normalizedDetected || // no name to compare → new supplier race case
      normalizedNames.has(normalizedDetected) || // name already exists as supplier
      (linkedSupplier && linkedSupplier.normalizedName && normalizedDetected === linkedSupplier.normalizedName) // the linked supplier's own name matches
    ) {
      resolvableIds.push(item.id);
    }
  }

  if (resolvableIds.length === 0) return 0;

  await dbInstance.update(supplierReviewItems)
    .set({
      status: 'resolved',
      resolution: 'ignored',
      resolvedByUserId: userId,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      inArray(supplierReviewItems.id, resolvableIds),
      eq(supplierReviewItems.accountId, accountId),
    ));

  return resolvableIds.length;
}
