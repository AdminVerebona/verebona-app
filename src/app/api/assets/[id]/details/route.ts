import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

// Map family → applicable section keys
const FAMILY_SECTIONS: Record<string, string[]> = {
  IMMOBILIER: ['common', 'location_identification', 'physical_characteristics', 'occupancy_usage', 'performance_technical', 'valuation', 'insurance'],
  VEHICULE: ['common', 'vehicle_identification', 'vehicle_technical', 'vehicle_usage', 'vehicle_insurance', 'valuation'],
  OBJET: ['common', 'object_identification', 'object_condition', 'object_provenance', 'object_usage', 'valuation', 'insurance'],
};

function buildSections(family: string, kc: Record<string, unknown>, assetRow: Record<string, unknown>) {
  const sections: Record<string, unknown> = {};

  // common — always present
  const acquisitionPrice = kc.acquisitionPrice ?? ((assetRow as any).purchasePriceCents != null ? (assetRow as any).purchasePriceCents / 100 : null);
  sections.common = {
    name: assetRow.name,
    subCategory: (assetRow as any).subtype ?? null,
    description: kc.description ?? null,
    acquisitionDate: kc.acquisitionDate ?? (assetRow as any).purchaseDate ?? null,
    acquisitionPrice: acquisitionPrice,
    acquisitionCurrency: kc.acquisitionCurrency ?? 'EUR',
    acquisitionLocation: kc.acquisitionLocation ?? (assetRow as any).purchaseLocation ?? null,
    estimatedValue: kc.estimatedValue ?? null,
    estimatedValueCurrency: kc.estimatedValueCurrency ?? 'EUR',
    estimatedValueDate: kc.estimatedValueDate ?? null,
    estimatedValueMode: kc.estimatedValueMode ?? null,
    notes: kc.notes ?? assetRow.notes ?? null,
    ...(family === 'VEHICULE' ? { vehicleOwnershipStatus: kc.vehicleOwnershipStatus ?? null } : {}),
  };

  if (family === 'IMMOBILIER') {
    sections.location_identification = {
      address1: assetRow.address ?? kc.address1 ?? null,
      address2: kc.address2 ?? null,
      postalCode: assetRow.postalCode ?? kc.postalCode ?? null,
      city: assetRow.city ?? kc.city ?? null,
      country: kc.country ?? null,
      cadastralRef: kc.cadastralRef ?? null,
      lotNumber: kc.lotNumber ?? null,
      floor: kc.floor ?? null,
      gpsCoords: kc.gpsCoords ?? null,
    };
    sections.physical_characteristics = {
      livingArea: kc.livingArea ?? null,
      landArea: kc.landArea ?? null,
      roomCount: kc.roomCount ?? null,
      bedroomCount: kc.bedroomCount ?? null,
      levels: kc.levels ?? null,
      constructionYear: kc.constructionYear ?? null,
      generalCondition: kc.generalCondition ?? assetRow.generalCondition ?? null,
    };
    sections.occupancy_usage = {
      occupancyUsage: kc.occupancyUsage ?? null,
      occupancyStatus: kc.occupancyStatus ?? null,
      monthlyRent: kc.monthlyRent ?? null,
      charges: kc.charges ?? null,
      occupancyNotes: kc.occupancyNotes ?? null,
    };
    sections.performance_technical = {
      heatingType: kc.heatingType ?? null,
      mainEnergy: kc.mainEnergy ?? null,
      dpeClass: kc.dpeClass ?? null,
      dpeDate: kc.dpeDate ?? null,
      gesClass: kc.gesClass ?? null,
      networks: kc.networks ?? [],
    };
    sections.valuation = {
      valuationLow: kc.valuationLow ?? null,
      valuationHigh: kc.valuationHigh ?? null,
      valuationSource: kc.valuationSource ?? null,
      valuationDate: kc.valuationDate ?? null,
    };
    sections.insurance = {
      isInsured: kc.isInsured ?? null,
      insurer: kc.insurer ?? null,
      insuranceContractNumber: kc.insuranceContractNumber ?? null,
      insuranceClientNumber: kc.insuranceClientNumber ?? null,
      insuranceExpiry: kc.insuranceExpiry ?? null,
      insurancePremium: kc.insurancePremium ?? null,
    };
  } else if (family === 'VEHICULE') {
    sections.vehicle_identification = {
      make: kc.make ?? null,
      model: kc.model ?? null,
      registrationNumber: assetRow.registrationNumber ?? kc.registrationNumber ?? null,
      vin: kc.vin ?? null,
      year: kc.year ?? null,
    };
    sections.vehicle_technical = {
      engine: kc.engine ?? assetRow.engineInfo ?? null,
      fuelType: kc.fuelType ?? null,
      fiscalHp: kc.fiscalHp ?? null,
      powerKw: kc.powerKw ?? null,
      ptac: kc.ptac ?? null,
      seats: kc.seats ?? null,
      firstRegistrationDate: kc.firstRegistrationDate ?? null,
    };
    sections.vehicle_usage = {
      vehicleOwnershipStatus: kc.vehicleOwnershipStatus ?? null,
      mileage: kc.mileage ?? assetRow.mileageOrHours ?? null,
      mileageUnit: kc.mileageUnit ?? 'km',
      mileageDate: kc.mileageDate ?? null,
      primaryUse: kc.primaryUse ?? null,
    };
    sections.vehicle_insurance = {
      isInsured: kc.isInsured ?? null,
      insurer: kc.insurer ?? null,
      insuranceContractNumber: kc.insuranceContractNumber ?? null,
      insuranceClientNumber: kc.insuranceClientNumber ?? null,
      insuranceExpiry: kc.insuranceExpiry ?? null,
      insurancePremium: kc.insurancePremium ?? null,
      nextInspection: kc.nextInspection ?? null,
    };
    sections.valuation = {
      valuationLow: kc.valuationLow ?? null,
      valuationHigh: kc.valuationHigh ?? null,
      valuationSource: kc.valuationSource ?? null,
    };
  } else {
    // OBJET or other
    sections.object_identification = {
      objectCategory: kc.objectCategory ?? assetRow.objectCategory ?? null,
      brand: kc.brand ?? null,
      modelName: kc.modelName ?? null,
      serialNumber: kc.serialNumber ?? null,
    };
    sections.object_condition = {
      condition: kc.condition ?? assetRow.generalCondition ?? null,
      dimensions: kc.dimensions ?? assetRow.dimensions ?? null,
      weight: kc.weight ?? null,
      accessories: kc.accessories ?? null,
    };
    sections.object_provenance = {
      acquisitionMode: kc.acquisitionMode ?? null,
      provenance: kc.provenance ?? null,
      authenticityProof: kc.authenticityProof ?? null,
    };
    sections.object_usage = {
      primaryUse: kc.primaryUse ?? null,
      storageLocation: kc.storageLocation ?? null,
      lastRevision: kc.lastRevision ?? null,
      isInsured: kc.isInsured ?? null,
    };
    sections.valuation = {
      valuationLow: kc.valuationLow ?? null,
      valuationHigh: kc.valuationHigh ?? null,
      valuationSource: kc.valuationSource ?? null,
    };
    sections.insurance = {
      isInsured: kc.isInsured ?? null,
      insurer: kc.insurer ?? null,
      insuranceContractNumber: kc.insuranceContractNumber ?? null,
      insuranceClientNumber: kc.insuranceClientNumber ?? null,
      insuranceExpiry: kc.insuranceExpiry ?? null,
      insurancePremium: kc.insurancePremium ?? null,
    };
  }

  return sections;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return apiError(400, 'INVALID_INPUT', 'Valid asset ID required');

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

    let kc: Record<string, unknown> = {};
    try { kc = assetRow.keyCharacteristics ? JSON.parse(assetRow.keyCharacteristics) : {}; } catch {}

    // Determine family
    const family = assetRow.category === 'VEHICULE' ? 'VEHICULE'
      : assetRow.category === 'IMMOBILIER' ? 'IMMOBILIER'
      : 'OBJET';

    const sections = buildSections(family, kc, assetRow as unknown as Record<string, unknown>);

    // Include coherence alerts for UI display
    const coherenceAlerts = Array.isArray(kc.coherenceAlerts) ? kc.coherenceAlerts : [];

    return NextResponse.json({ family, sections, coherenceAlerts });
  } catch (error) {
    console.error('GET /details error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
