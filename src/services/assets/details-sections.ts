/**
 * Fiche d'un bien — sections renvoyées par `GET /api/assets/[id]/details`
 * (onglet « Informations »). Extrait de la route au lot 88A (diagnostic
 * global, ticket P1) : la route ET le diagnostic (projection API → écran,
 * `admin/diagnostics-export/properties.ts`) appellent la MÊME fonction — la
 * valeur « renvoyée par l'API » exportée par le diagnostic est donc
 * exactement celle que la route renvoie pour les mêmes données persistées.
 *
 * Ordre de lecture de l'adresse (arbitrage lot 16, CDC 15 X-02 / T3-05) : la
 * fiche canonique fait foi (voir la route) ; l'appelant fournit `adresse`.
 */
import { readOrigin } from '@/services/ai/reconciliation/field-origin';
import { tenureEndSectionFields } from '@/lib/assets/tenure-end';

export type AddressOverride = { address1: unknown; postalCode: unknown; city: unknown };

/** Lot 49A (ticket 9) / lot 53 (D18) : fin de contrat PRÉVUE, jamais une fin de détention (voir `lib/assets/tenure-end`). */
const tenureEndFields = (family: string, kc: Record<string, unknown>, context: Record<string, unknown>) =>
  tenureEndSectionFields(family, kc, context, readOrigin);

export function buildSections(family: string, kc: Record<string, unknown>, assetRow: Record<string, unknown>, adresse: AddressOverride | null = null) {
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
    // Lot 43 (O4, décision PO Q5) : vente réalisée — affichée seulement pour un
    // bien VENDU (date et prix) ou TRANSMIS (date), modifiable dans la fiche.
    saleDate: kc.saleDate ?? null,
    salePrice: kc.salePrice ?? null,
    ...(family === 'VEHICULE' ? { vehicleOwnershipStatus: kc.vehicleOwnershipStatus ?? null } : {}),
  };

  if (family === 'IMMOBILIER') {
    sections.location_identification = {
      address1: adresse ? adresse.address1 : assetRow.address ?? kc.address1 ?? null,
      address2: kc.address2 ?? null,
      postalCode: adresse ? adresse.postalCode : assetRow.postalCode ?? kc.postalCode ?? null,
      city: adresse ? adresse.city : assetRow.city ?? kc.city ?? null,
      country: kc.country ?? null,
      cadastralRef: kc.cadastralRef ?? null,
      lotNumber: kc.lotNumber ?? null,
      floor: kc.floor ?? null,
      gpsCoords: kc.gpsCoords ?? null,
    };
    sections.physical_characteristics = {
      livingArea: kc.livingArea ?? null,
      carrezArea: kc.carrezArea ?? null,
      listedArea: kc.listedArea ?? null,
      landArea: kc.landArea ?? null,
      roomCount: kc.roomCount ?? null,
      bedroomCount: kc.bedroomCount ?? null,
      levels: kc.levels ?? null,
      constructionYear: kc.constructionYear ?? null,
      parking: kc.parking ?? null,
      generalCondition: kc.generalCondition ?? assetRow.generalCondition ?? null,
    };
    sections.occupancy_usage = {
      occupancyUsage: kc.occupancyUsage ?? null,
      occupancyStatus: kc.occupancyStatus ?? null,
      monthlyRent: kc.monthlyRent ?? null,
      charges: kc.charges ?? null,
      occupancyNotes: kc.occupancyNotes ?? null,
      ...tenureEndFields('IMMOBILIER', kc, { occupancyStatus: kc.occupancyStatus }),
    };
    sections.performance_technical = {
      heatingType: kc.heatingType ?? null,
      mainEnergy: kc.mainEnergy ?? null,
      dpeClass: kc.dpeClass ?? null,
      dpeDate: kc.dpeDate ?? null,
      dpeExpiryDate: kc.dpeExpiryDate ?? null,
      dpeAdemeNumber: kc.dpeAdemeNumber ?? null,
      energyConsumption: kc.energyConsumption ?? null,
      gesClass: kc.gesClass ?? null,
      lastRevision: kc.lastRevision ?? null,
      maintenanceDueDate: kc.maintenanceDueDate ?? null,
      networks: kc.networks ?? [],
    };
    sections.valuation = {
      valuationLow: kc.valuationLow ?? null,
      valuationHigh: kc.valuationHigh ?? null,
      valuationSource: kc.valuationSource ?? null,
      listingPrice: kc.listingPrice ?? null,
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
      registrationExpiry: kc.registrationExpiry ?? null,
      vin: kc.vin ?? null,
      year: kc.year ?? null,
    };
    sections.vehicle_technical = {
      engine: kc.engine ?? assetRow.engineInfo ?? null,
      engineDisplacement: kc.engineDisplacement ?? null,
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
      lastRevision: kc.lastRevision ?? null,
      maintenanceDueDate: kc.maintenanceDueDate ?? null,
      contractNumber: kc.contractNumber ?? null,
      contractStartDate: kc.contractStartDate ?? null,
      leaseDurationMonths: kc.leaseDurationMonths ?? null,
      leaseMonthlyPayment: kc.leaseMonthlyPayment ?? null,
      leaseResidualValue: kc.leaseResidualValue ?? null,
      ...tenureEndFields('VEHICULE', kc, { vehicleOwnershipStatus: kc.vehicleOwnershipStatus }),
    };
    sections.vehicle_insurance = {
      isInsured: kc.isInsured ?? null,
      insurer: kc.insurer ?? null,
      insuranceContractNumber: kc.insuranceContractNumber ?? null,
      insuranceClientNumber: kc.insuranceClientNumber ?? null,
      insuranceExpiry: kc.insuranceExpiry ?? null,
      insurancePremium: kc.insurancePremium ?? null,
      lastInspectionDate: kc.lastInspectionDate ?? null,
      nextInspection: kc.nextInspection ?? null,
    };
    sections.valuation = {
      valuationLow: kc.valuationLow ?? null,
      valuationHigh: kc.valuationHigh ?? null,
      valuationSource: kc.valuationSource ?? null,
      listingPrice: kc.listingPrice ?? null,
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
      warrantyStartDate: kc.warrantyStartDate ?? null,
    };
    sections.object_usage = {
      primaryUse: kc.primaryUse ?? null,
      storageLocation: kc.storageLocation ?? null,
      lastRevision: kc.lastRevision ?? null,
      maintenanceDueDate: kc.maintenanceDueDate ?? null,
      isInsured: kc.isInsured ?? null,
      // Contexte (non modifiable ici) : le mode d'acquisition dit si l'objet
      // est loué / prêté — détention à durée limitée (lot 49A).
      acquisitionMode: kc.acquisitionMode ?? null,
      ...tenureEndFields('OBJET', kc, { acquisitionMode: kc.acquisitionMode }),
    };
    sections.valuation = {
      valuationLow: kc.valuationLow ?? null,
      valuationHigh: kc.valuationHigh ?? null,
      valuationSource: kc.valuationSource ?? null,
      listingPrice: kc.listingPrice ?? null,
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

