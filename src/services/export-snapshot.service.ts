/**
 * Service de snapshot d'asset pour les exports
 * Capture l'état complet d'un bien au moment de la génération (données gelées)
 *
 * Règles d'inclusion :
 * - asset_files : direct (assetId) + indirect via substructureId/equipmentId
 *   MAIS pas linkedAssetId/linkedRoomId (rattachement croisé hors périmètre V1)
 * - Exclusions strictes : deletedAt, isDraft, isIgnored, uploadStatus != COMPLETED
 * - web links : chargés dans snapshot mais filtrés au niveau manifest selon l'usage
 * - equipments : archivedAt IS NULL uniquement
 * - events : isDraft=false, isIgnored=false
 */

import { db } from '@/db';
import {
  assets, assetFiles, substructures, equipments, events,
  assetPhotos,
} from '@/db/schema';
import { eq, and, isNull, inArray, or } from 'drizzle-orm';

export interface DocumentRef {
  id: number;
  s3Key: string | null;
  s3Bucket: string | null;
  originalFilename: string | null;
  documentType: string;
  documentDate: string | null;
  description: string | null;
  retainedTitle: string | null;
  retainedFunctionCode: string | null;
  cilRubricCodes: string[] | null;
  mimeType: string | null;
  size: number | null;
  isWebLink: boolean;
  webLinkUrl: string | null;
  webLinkTitle: string | null;
  substructureId: number | null;
  equipmentId: number | null;
}

export interface PhotoRef {
  id: number;
  fileId: number | null;
  s3Key: string | null;
  s3Bucket: string | null;
  mimeType: string | null;
  originalFilename: string | null;
  size: number | null;
  displayOrder: number;
  isPrimary: boolean;
  caption: string | null;
}

// Sections structurées extraites de keyCharacteristics — lisibles par le renderer
export interface AssetDetailSections {
  family: 'IMMOBILIER' | 'VEHICULE' | 'OBJET';
  common?: {
    name?: string | null;
    description?: string | null;
    acquisitionDate?: string | null;
    acquisitionPrice?: number | null;
    acquisitionCurrency?: string | null;
    estimatedValue?: number | null;
    estimatedValueDate?: string | null;
    estimatedValueMode?: string | null;
    notes?: string | null;
  };
  // IMMOBILIER
  location_identification?: {
    address1?: string | null;
    address2?: string | null;
    postalCode?: string | null;
    city?: string | null;
    country?: string | null;
    cadastralRef?: string | null;
    lotNumber?: string | null;
    floor?: string | null;
    gpsCoords?: string | null;
  };
  physical_characteristics?: {
    livingArea?: number | null;
    landArea?: number | null;
    roomCount?: number | null;
    bedroomCount?: number | null;
    levels?: number | null;
    constructionYear?: number | null;
    generalCondition?: string | null;
  };
  occupancy_usage?: {
    occupancyUsage?: string | null;
    occupancyStatus?: string | null;
    monthlyRent?: number | null;
    charges?: number | null;
    occupancyNotes?: string | null;
  };
  performance_technical?: {
    heatingType?: string | null;
    mainEnergy?: string | null;
    dpeClass?: string | null;
    dpeDate?: string | null;
    gesClass?: string | null;
    networks?: string[];
  };
  valuation?: {
    valuationLow?: number | null;
    valuationHigh?: number | null;
    valuationSource?: string | null;
    valuationDate?: string | null;
  };
  // VEHICULE
  vehicle_identification?: {
    make?: string | null;
    model?: string | null;
    registrationNumber?: string | null;
    vin?: string | null;
    year?: number | null;
  };
  vehicle_technical?: {
    engine?: string | null;
    fuelType?: string | null;
    powerKw?: number | null;
    seats?: number | null;
    firstRegistrationDate?: string | null;
    fiscalHp?: number | null;
    ptac?: number | null;
  };
  vehicle_usage?: {
    mileage?: number | null;
    mileageUnit?: string | null;
    mileageDate?: string | null;
    vehicleOwnershipStatus?: string | null;
    primaryUse?: string | null;
  };
  vehicle_insurance?: {
    isInsured?: boolean | null;
    insurer?: string | null;
    insuranceExpiry?: string | null;
    nextInspection?: string | null;
    insuranceContractNumber?: string | null;
    insuranceClientNumber?: string | null;
    insurancePremium?: number | null;
  };
  // OBJET
  object_identification?: {
    objectCategory?: string | null;
    brand?: string | null;
    modelName?: string | null;
    serialNumber?: string | null;
  };
  object_condition?: {
    condition?: string | null;
    dimensions?: string | null;
    weight?: string | null;
  };
  object_provenance?: {
    acquisitionMode?: string | null;
    provenance?: string | null;
  };
  object_usage?: {
    isInsured?: boolean | null;
    storageLocation?: string | null;
    lastRevision?: string | null;
    accessories?: string | null;
  };
  // IMMOBILIER
  insurance?: {
    isInsured?: boolean | null;
    insurer?: string | null;
    insuranceContractNumber?: string | null;
    insuranceClientNumber?: string | null;
    insuranceExpiry?: string | null;
    insurancePremium?: number | null;
  };
}

export interface AssetSnapshot {
  // Asset core
  id: number;
  name: string;
  category: string;
  subtype: string | null;
  status: string;
  purchaseDate: string | null;
  purchasePriceCents: number | null;
  estimatedValueCents: number | null;
  generalCondition: string | null;
  notes: string | null;
  warrantyEndDate: string | null;
  mileageOrHours: number | null;
  lastMaintenanceDate: string | null;
  registrationNumber: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  thumbnailUrl: string | null;
  description: string | null;
  keyCharacteristics: Record<string, unknown>;
  /** Sections structurées avec libellés lisibles — issues de keyCharacteristics */
  detailSections: AssetDetailSections;
  equipmentList: string[];
  // Related data
  documents: DocumentRef[];   // all (incl. web links) — filtered per usage by manifest
  photos: PhotoRef[];
  substructures: Array<{ id: number; name: string; roomType?: string; area?: string | null }>;
  equipments: Array<{
    id: number;
    name: string;
    type: string | null;
    category: string | null;
    status: string;
    purchasePriceCents: number | null;
    estimatedValueCents: number | null;
    isMobilier: boolean;
  }>;
  events: Array<{
    id: number;
    title: string;
    date: string | null;
    categorie: string;
    statut: string;
    costCents: number | null;
    provider: string | null;
    notes: string | null;
  }>;
  snapshotAt: string;
}

// ─── Reconstruction des sections structurées depuis keyCharacteristics ─────────
// Même logique que /api/assets/[id]/details — source unique de vérité pour le renderer

function buildDetailSections(
  kc: Record<string, unknown>,
  assetRow: { category: string; address?: string | null; postalCode?: string | null; city?: string | null; registrationNumber?: string | null; generalCondition?: string | null; mileageOrHours?: number | null; notes?: string | null; name?: string | null },
): AssetDetailSections {
  const family: 'IMMOBILIER' | 'VEHICULE' | 'OBJET' =
    assetRow.category === 'VEHICULE' ? 'VEHICULE'
    : assetRow.category === 'IMMOBILIER' ? 'IMMOBILIER'
    : 'OBJET';

  const common = {
    name: assetRow.name ?? null,
    description: (kc.description as string) ?? null,
    acquisitionDate: (kc.acquisitionDate as string) ?? null,
    acquisitionPrice: kc.acquisitionPrice != null ? Number(kc.acquisitionPrice) : null,
    acquisitionCurrency: (kc.acquisitionCurrency as string) ?? 'EUR',
    estimatedValue: kc.estimatedValue != null ? Number(kc.estimatedValue) : null,
    estimatedValueDate: (kc.estimatedValueDate as string) ?? null,
    estimatedValueMode: (kc.estimatedValueMode as string) ?? null,
    notes: (kc.notes as string) ?? assetRow.notes ?? null,
  };

  if (family === 'IMMOBILIER') {
    return {
      family,
      common,
      location_identification: {
        address1: assetRow.address ?? (kc.address1 as string) ?? null,
        address2: (kc.address2 as string) ?? null,
        postalCode: assetRow.postalCode ?? (kc.postalCode as string) ?? null,
        city: assetRow.city ?? (kc.city as string) ?? null,
        country: (kc.country as string) ?? null,
        cadastralRef: (kc.cadastralRef as string) ?? null,
        lotNumber: (kc.lotNumber as string) ?? null,
        floor: (kc.floor as string) ?? null,
        gpsCoords: (kc.gpsCoords as string) ?? null,
      },
      physical_characteristics: {
        livingArea: kc.livingArea != null ? Number(kc.livingArea) : null,
        landArea: kc.landArea != null ? Number(kc.landArea) : null,
        roomCount: kc.roomCount != null ? Number(kc.roomCount) : null,
        bedroomCount: kc.bedroomCount != null ? Number(kc.bedroomCount) : null,
        levels: kc.levels != null ? Number(kc.levels) : null,
        constructionYear: kc.constructionYear != null ? Number(kc.constructionYear) : null,
        generalCondition: (kc.generalCondition as string) ?? assetRow.generalCondition ?? null,
      },
      occupancy_usage: {
        occupancyUsage: (kc.occupancyUsage as string) ?? null,
        occupancyStatus: (kc.occupancyStatus as string) ?? null,
        monthlyRent: kc.monthlyRent != null ? Number(kc.monthlyRent) : null,
        charges: kc.charges != null ? Number(kc.charges) : null,
        occupancyNotes: (kc.occupancyNotes as string) ?? null,
      },
      performance_technical: {
        heatingType: (kc.heatingType as string) ?? null,
        mainEnergy: (kc.mainEnergy as string) ?? null,
        dpeClass: (kc.dpeClass as string) ?? null,
        dpeDate: (kc.dpeDate as string) ?? null,
        gesClass: (kc.gesClass as string) ?? null,
        networks: Array.isArray(kc.networks) ? (kc.networks as string[]) : [],
      },
      valuation: {
        valuationLow: kc.valuationLow != null ? Number(kc.valuationLow) : null,
        valuationHigh: kc.valuationHigh != null ? Number(kc.valuationHigh) : null,
        valuationSource: (kc.valuationSource as string) ?? null,
        valuationDate: (kc.valuationDate as string) ?? null,
      },
      insurance: {
        isInsured: kc.isInsured != null ? Boolean(kc.isInsured) : null,
        insurer: (kc.insurer as string) ?? null,
        insuranceContractNumber: (kc.insuranceContractNumber as string) ?? null,
        insuranceClientNumber: (kc.insuranceClientNumber as string) ?? null,
        insuranceExpiry: (kc.insuranceExpiry as string) ?? null,
        insurancePremium: kc.insurancePremium != null ? Number(kc.insurancePremium) : null,
      },
    };
  }

  if (family === 'VEHICULE') {
    return {
      family,
      common,
      vehicle_identification: {
        make: (kc.make as string) ?? null,
        model: (kc.model as string) ?? null,
        registrationNumber: assetRow.registrationNumber ?? (kc.registrationNumber as string) ?? null,
        vin: (kc.vin as string) ?? null,
        year: kc.year != null ? Number(kc.year) : null,
      },
      vehicle_technical: {
        engine: (kc.engine as string) ?? null,
        fuelType: (kc.fuelType as string) ?? null,
        powerKw: kc.powerKw != null ? Number(kc.powerKw) : null,
        seats: kc.seats != null ? Number(kc.seats) : null,
        firstRegistrationDate: (kc.firstRegistrationDate as string) ?? null,
        fiscalHp: kc.fiscalHp != null ? Number(kc.fiscalHp) : null,
        ptac: kc.ptac != null ? Number(kc.ptac) : null,
      },
      vehicle_usage: {
        mileage: kc.mileage != null ? Number(kc.mileage) : (assetRow.mileageOrHours ?? null),
        mileageUnit: (kc.mileageUnit as string) ?? 'km',
        mileageDate: (kc.mileageDate as string) ?? null,
        vehicleOwnershipStatus: (kc.vehicleOwnershipStatus as string) ?? null,
        primaryUse: (kc.primaryUse as string) ?? null,
      },
      vehicle_insurance: {
        isInsured: kc.isInsured != null ? Boolean(kc.isInsured) : null,
        insurer: (kc.insurer as string) ?? null,
        insuranceExpiry: (kc.insuranceExpiry as string) ?? null,
        nextInspection: (kc.nextInspection as string) ?? null,
        insuranceContractNumber: (kc.insuranceContractNumber as string) ?? null,
        insuranceClientNumber: (kc.insuranceClientNumber as string) ?? null,
        insurancePremium: kc.insurancePremium != null ? Number(kc.insurancePremium) : null,
      },
      valuation: {
        valuationLow: kc.valuationLow != null ? Number(kc.valuationLow) : null,
        valuationHigh: kc.valuationHigh != null ? Number(kc.valuationHigh) : null,
        valuationSource: (kc.valuationSource as string) ?? null,
        valuationDate: (kc.valuationDate as string) ?? null,
      },
    };
  }

  return {
    family,
    common,
    object_identification: {
      objectCategory: (kc.objectCategory as string) ?? null,
      brand: (kc.brand as string) ?? null,
      modelName: (kc.modelName as string) ?? null,
      serialNumber: (kc.serialNumber as string) ?? null,
    },
    object_condition: {
      condition: (kc.condition as string) ?? assetRow.generalCondition ?? null,
      dimensions: (kc.dimensions as string) ?? null,
      weight: (kc.weight as string) ?? null,
    },
    object_provenance: {
      acquisitionMode: (kc.acquisitionMode as string) ?? null,
      provenance: (kc.provenance as string) ?? null,
    },
    object_usage: {
      isInsured: kc.isInsured != null ? Boolean(kc.isInsured) : null,
      storageLocation: (kc.storageLocation as string) ?? null,
      lastRevision: (kc.lastRevision as string) ?? null,
      accessories: (kc.accessories as string) ?? null,
    },
    valuation: {
      valuationLow: kc.valuationLow != null ? Number(kc.valuationLow) : null,
      valuationHigh: kc.valuationHigh != null ? Number(kc.valuationHigh) : null,
      valuationSource: (kc.valuationSource as string) ?? null,
      valuationDate: (kc.valuationDate as string) ?? null,
    },
  };
}

export async function buildAssetSnapshot(assetId: number, userId: number): Promise<AssetSnapshot> {
  const [assetRow] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.userId, userId)))
    .limit(1);

  if (!assetRow) throw new Error(`Asset ${assetId} not found for user ${userId}`);

  // Parse keyCharacteristics
  let keyChars: Record<string, unknown> = {};
  if (assetRow.keyCharacteristics) {
    try { keyChars = JSON.parse(assetRow.keyCharacteristics); } catch {}
  }

  // Parse equipmentList (legacy field)
  let equipList: string[] = [];
  if (assetRow.equipmentList) {
    try { equipList = JSON.parse(assetRow.equipmentList); }
    catch { equipList = assetRow.equipmentList.split(',').map(e => e.trim()).filter(Boolean); }
  }

  // Load substructures (rooms)
  const subs = await db
    .select({ id: substructures.id, name: substructures.name, roomType: substructures.name })
    .from(substructures)
    .where(eq(substructures.assetId, assetId));

  const subIds = subs.map(s => s.id);

  // Load equipments (non archived)
  const equips = await db
    .select({
      id: equipments.id,
      name: equipments.name,
      type: equipments.type,
      category: equipments.category,
      status: equipments.status,
      purchasePriceCents: equipments.purchasePriceCents,
      estimatedValueCents: equipments.estimatedValueCents,
      substructureId: equipments.substructureId,
    })
    .from(equipments)
    .where(and(eq(equipments.assetId, assetId), isNull(equipments.archivedAt)));

  const equipIds = equips.map(e => e.id);

  // Load documents:
  // - direct (assetId = assetId) OR indirect (substructureId IN subIds) OR (equipmentId IN equipIds)
  // - strict exclusions: deletedAt, isDraft, isIgnored, uploadStatus != COMPLETED
  // - linkedAssetId / linkedRoomId exclus (rattachement croisé hors V1)
  const docsConditions = [
    isNull(assetFiles.deletedAt),
    eq(assetFiles.isDraft, false),
    eq(assetFiles.isIgnored, false),
    // uploadStatus = 'COMPLETED' or null (legacy)
    or(
      eq(assetFiles.uploadStatus, 'COMPLETED'),
      isNull(assetFiles.uploadStatus),
    ),
  ];

  // Scope: direct OR via substructure OR via equipment
  const scopeCondition = subIds.length > 0 && equipIds.length > 0
    ? or(
        eq(assetFiles.assetId, assetId),
        inArray(assetFiles.substructureId, subIds),
        inArray(assetFiles.equipmentId, equipIds),
      )
    : subIds.length > 0
    ? or(
        eq(assetFiles.assetId, assetId),
        inArray(assetFiles.substructureId, subIds),
      )
    : equipIds.length > 0
    ? or(
        eq(assetFiles.assetId, assetId),
        inArray(assetFiles.equipmentId, equipIds),
      )
    : eq(assetFiles.assetId, assetId);

  const docs = await db
    .select({
      id: assetFiles.id,
      s3Key: assetFiles.s3Key,
      s3Bucket: assetFiles.s3Bucket,
      originalFilename: assetFiles.originalFilename,
      documentType: assetFiles.documentType,
      documentDate: assetFiles.documentDate,
      description: assetFiles.description,
      retainedTitle: assetFiles.retainedTitle,
      retainedFunctionCode: assetFiles.retainedFunctionCode,
      cilRubricCodes: assetFiles.cilRubricCodes,
      mimeType: assetFiles.mimeType,
      size: assetFiles.size,
      isWebLink: assetFiles.isWebLink,
      webLinkUrl: assetFiles.webLinkUrl,
      webLinkTitle: assetFiles.webLinkTitle,
      substructureId: assetFiles.substructureId,
      equipmentId: assetFiles.equipmentId,
    })
    .from(assetFiles)
    .where(and(scopeCondition!, ...docsConditions));

  // Load photos
  const photos = await db
    .select({
      id: assetPhotos.id,
      fileId: assetPhotos.fileId,
      displayOrder: assetPhotos.displayOrder,
      isPrimary: assetPhotos.isPrimary,
      caption: assetPhotos.caption,
      s3Key: assetFiles.s3Key,
      s3Bucket: assetFiles.s3Bucket,
      mimeType: assetFiles.mimeType,
      originalFilename: assetFiles.originalFilename,
      size: assetFiles.size,
    })
    .from(assetPhotos)
    .leftJoin(assetFiles, eq(assetFiles.id, assetPhotos.fileId))
    .where(eq(assetPhotos.assetId, assetId));

  // Load events (non-draft, non-ignored)
  const evts = await db
    .select({
      id: events.id,
      title: events.title,
      date: events.date,
      categorie: events.categorie,
      statut: events.statut,
      costCents: events.costCents,
      provider: events.provider,
      notes: events.notes,
    })
    .from(events)
    .where(and(
      eq(events.assetId, assetId),
      eq(events.isIgnored, false),
      eq(events.isDraft, false),
    ));

  // Determine mobilier: equipments with substructureId (attached to a room) or category='MOBILIER'
  const equipMapped = equips.map(e => ({
    ...e,
    isMobilier: e.category?.toLowerCase() === 'mobilier' || !!e.substructureId,
  }));

  return {
    id: assetRow.id,
    name: assetRow.name,
    category: assetRow.category,
    subtype: assetRow.subtype,
    status: assetRow.status,
    purchaseDate: assetRow.purchaseDate,
    purchasePriceCents: assetRow.purchasePriceCents,
    estimatedValueCents: assetRow.estimatedValueCents,
    generalCondition: assetRow.generalCondition,
    notes: assetRow.notes,
    warrantyEndDate: assetRow.warrantyEndDate,
    mileageOrHours: assetRow.mileageOrHours,
    lastMaintenanceDate: assetRow.lastMaintenanceDate,
    registrationNumber: assetRow.registrationNumber,
    address: assetRow.address,
    city: assetRow.city,
    postalCode: assetRow.postalCode,
    thumbnailUrl: assetRow.thumbnailUrl,
    description: (keyChars.description as string) ?? null,
    keyCharacteristics: keyChars,
    detailSections: buildDetailSections(keyChars, assetRow),
    equipmentList: equipList,
    documents: docs as DocumentRef[],
    photos: photos.map(p => ({
      id: p.id,
      fileId: p.fileId ?? null,
      s3Key: p.s3Key ?? null,
      s3Bucket: p.s3Bucket ?? null,
      mimeType: p.mimeType ?? null,
      originalFilename: p.originalFilename ?? null,
      size: p.size ?? null,
      displayOrder: p.displayOrder,
      isPrimary: p.isPrimary,
      caption: p.caption,
    })),
    substructures: subs.map(s => ({ id: s.id, name: s.name, area: null })),
    equipments: equipMapped,
    events: evts,
    snapshotAt: new Date().toISOString(),
  };
}
