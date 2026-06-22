import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

const ALL_SECTIONS = [
  'common',
  'location_identification', 'physical_characteristics', 'occupancy_usage', 'performance_technical',
  'valuation',
  'vehicle_identification', 'vehicle_technical', 'vehicle_usage', 'vehicle_insurance',
  'object_identification', 'object_condition', 'object_provenance', 'object_usage',
  'insurance',
];

const IMMOBILIER_SECTIONS = ['common', 'location_identification', 'physical_characteristics', 'occupancy_usage', 'performance_technical', 'valuation', 'insurance'];
const VEHICULE_SECTIONS = ['common', 'vehicle_identification', 'vehicle_technical', 'vehicle_usage', 'vehicle_insurance', 'valuation'];
const OBJET_SECTIONS = ['common', 'object_identification', 'object_condition', 'object_provenance', 'object_usage', 'valuation', 'insurance'];

function familySections(category: string) {
  if (category === 'IMMOBILIER') return IMMOBILIER_SECTIONS;
  if (category === 'VEHICULE') return VEHICULE_SECTIONS;
  return OBJET_SECTIONS;
}

// Atomic fields that must be written to both column and JSON
const ATOMIC_FIELDS: Record<string, string> = {
  address1: 'address',
  city: 'city',
  postalCode: 'postalCode',
  registrationNumber: 'registrationNumber',
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; section: string }> }
) {
  try {
    const { id, section } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return apiError(400, 'INVALID_INPUT', 'Valid asset ID required');

    if (!ALL_SECTIONS.includes(section)) {
      return apiError(404, 'NOT_FOUND', `Section unknown: ${section}`);
    }

    let session;
    try {
      session = await SessionService.getSession(request);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const [assetRow] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId), isNull(assets.deletedAt)))
      .limit(1);

    if (!assetRow) return apiError(404, 'NOT_FOUND', 'Asset not found');

    if (assetRow.status === 'ARCHIVED' || assetRow.lockState && assetRow.lockState !== 'NONE') {
      return NextResponse.json(
        { error: 'ASSET_UNAVAILABLE', reason: assetRow.status === 'ARCHIVED' ? 'ARCHIVED' : 'LOCKED_BY_PLAN' },
        { status: 403 }
      );
    }

    const allowed = familySections(assetRow.category);
    if (!allowed.includes(section)) {
      return NextResponse.json({ error: 'SECTION_NOT_APPLICABLE' }, { status: 400 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return apiError(400, 'INVALID_INPUT', 'Invalid JSON body');
    }

    const fields: Record<string, unknown> = (body.fields as Record<string, unknown> | undefined) ?? body;

    // Validate: name cannot be null
    if ('name' in fields && (fields.name === null || fields.name === '')) {
      return NextResponse.json({
        error: 'VALIDATION_ERROR',
        fields: [{ field: 'name', message: 'Name is required' }],
      }, { status: 422 });
    }

    // category is not modifiable via PATCH /details; subtype is allowed via subCategory alias
    if ('category' in fields || 'subtype' in fields) {
      return NextResponse.json({
        error: 'VALIDATION_ERROR',
        fields: [{ field: 'category/subtype', message: 'Cannot change family/subtype via this endpoint' }],
      }, { status: 422 });
    }

    // Parse existing keyCharacteristics
    let kc: Record<string, unknown> = {};
    try { kc = assetRow.keyCharacteristics ? JSON.parse(assetRow.keyCharacteristics) : {}; } catch {}

    // Deep merge fields into kc
    const atomicUpdates: Record<string, unknown> = {};
    let nameUpdate: string | undefined;

    const VALID_STATUSES = ['EN_SERVICE', 'EN_PANNE', 'EN_REPARATION', 'VENDU', 'DETRUIT', 'INACTIF', 'TRANSMIS'];
    let statusUpdate: string | undefined;
    let subCategoryUpdate: string | null | undefined;

    for (const [key, value] of Object.entries(fields)) {
      if (key === 'name') {
        nameUpdate = String(value).trim();
      } else if (key === 'subCategory') {
        subCategoryUpdate = value === '' || value === null ? null : String(value);
      } else if (key === 'status') {
        if (typeof value === 'string' && VALID_STATUSES.includes(value)) {
          statusUpdate = value;
        }
      } else if (key in ATOMIC_FIELDS) {
        const colKey = ATOMIC_FIELDS[key];
        atomicUpdates[colKey] = value;
        kc[key] = value; // also keep in JSON for redundancy
      } else {
        kc[key] = value;
      }
    }

    // If any field was manually edited, clear its dismissedCoherenceAlerts entry
    // and remove the corresponding coherence alert
    const editedFields = Object.keys(fields);
    const dismissedFields: string[] = Array.isArray(kc.dismissedCoherenceAlerts)
      ? kc.dismissedCoherenceAlerts as string[]
      : [];
    const remainingDismissed = dismissedFields.filter(f => !editedFields.includes(f));
    if (remainingDismissed.length !== dismissedFields.length) {
      kc.dismissedCoherenceAlerts = remainingDismissed;
    }
    // Also remove coherence alerts for the edited fields
    const alerts = Array.isArray(kc.coherenceAlerts)
      ? (kc.coherenceAlerts as Array<{ field: string }>).filter(a => !editedFields.includes(a.field))
      : [];
    if (alerts.length !== (Array.isArray(kc.coherenceAlerts) ? kc.coherenceAlerts.length : 0)) {
      kc.coherenceAlerts = alerts;
    }

    // If any valuation fields changed, push a new entry to valuationHistory
    const VALUATION_FIELDS = ['estimatedValue', 'estimatedValueDate', 'estimatedValueMode'] as const;
    const valuationChanged = VALUATION_FIELDS.some(f => f in fields);
    if (valuationChanged && (kc['estimatedValue'] != null || kc['estimatedValueDate'] != null)) {
      let history: unknown[] = [];
      try {
        const h = kc['valuationHistory'];
        if (Array.isArray(h)) history = h;
      } catch {}
      history.push({
        id: `v_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        value: kc['estimatedValue'] ?? null,
        date: kc['estimatedValueDate'] ?? null,
        mode: kc['estimatedValueMode'] ?? null,
        source: 'USER',
        addedAt: new Date().toISOString(),
      });
      kc['valuationHistory'] = history;
    }

    const updatePayload: Record<string, unknown> = {
      keyCharacteristics: JSON.stringify(kc),
      updatedAt: new Date(),
    };
    if (nameUpdate !== undefined) updatePayload.name = nameUpdate;
    if (statusUpdate !== undefined) updatePayload.status = statusUpdate;
    if (atomicUpdates.address !== undefined) updatePayload.address = atomicUpdates.address;
    if (atomicUpdates.city !== undefined) updatePayload.city = atomicUpdates.city;
    if (atomicUpdates.postalCode !== undefined) updatePayload.postalCode = atomicUpdates.postalCode;
    if (atomicUpdates.registrationNumber !== undefined) updatePayload.registrationNumber = atomicUpdates.registrationNumber;
    if (subCategoryUpdate !== undefined) updatePayload.subtype = subCategoryUpdate;

    await db.update(assets)
      .set(updatePayload as any)
      .where(eq(assets.id, assetId));

    return NextResponse.json({ updated: true, section });
  } catch (error) {
    console.error('PATCH /details/[section] error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
