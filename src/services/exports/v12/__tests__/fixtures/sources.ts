/**
 * Données sources de test (`ExportSource`) par famille — comme si elles
 * sortaient de `loadExportSource`, sans base. Contiennent volontairement des
 * données qui ne doivent JAMAIS être imprimées (estimation, occupant, pièces
 * sensibles, identifiants en clair) pour éprouver les mappeurs.
 */
import { cleanCharacteristics, type ExportSource, type SourceDocument, type SourceEvent, type SourcePhoto } from '../../data/source';
import type { DossierCode } from '@/services/exports/catalog';
import type { DocKind } from '../../data/documents';

export const TODAY = '2026-09-28';

let nextId = 100;
export function doc(over: Partial<SourceDocument> & { kind: DocKind; title: string }): SourceDocument {
  const id = over.id ?? nextId++;
  return {
    id,
    typeLabel: over.kind,
    format: 'PDF',
    integrable: true,
    sensitive: false,
    occupantData: false,
    date: '2025-03-22',
    sizeBytes: 120_000,
    fileName: `${over.title}.pdf`,
    mimeType: 'application/pdf',
    s3Key: `k/${id}`,
    s3Bucket: null,
    supplier: null,
    amountCents: null,
    description: null,
    cilRubricCodes: [],
    codes: [over.kind],
    equipmentId: null,
    ...over,
  } as SourceDocument;
}

export function photo(id: number, over: Partial<SourcePhoto> = {}): SourcePhoto {
  return {
    id, fileId: 1000 + id, s3Key: `p/${id}`, s3Bucket: null, mimeType: 'image/jpeg', fileName: `photo-${id}.jpg`,
    sizeBytes: 200_000, displayOrder: id, isPrimary: id === 1, caption: `Photo ${id}`, date: '2026-01-10', ...over,
  };
}

export function event(id: number, over: Partial<SourceEvent> & { title: string }): SourceEvent {
  return {
    key: `event:${id}`, source: 'event', id, date: '2025-06-12', category: 'entretien', status: 'realise',
    provider: null, costCents: null, description: null, forecast: false, ...over,
  };
}

/** Caractéristiques brutes contenant estimation et occupation : filtrées comme en production. */
const RAW_CHARACTERISTICS = {
  estimatedValue: 342000, estimatedValueDate: '2026-06-01', valuationLow: 330000, valuationHigh: 355000, valuationSource: 'Estimation Verebona',
  occupancyStatus: 'LOUE', occupancyNotes: 'Locataire M. Garnier jusqu’en 2027', monthlyRent: 1150, tenantName: 'Garnier',
};

export function makeSource(family: 'IMMOBILIER' | 'VEHICULE' | 'OBJET', exportType: DossierCode, over: Partial<ExportSource> = {}): ExportSource {
  const base: Record<string, unknown> = family === 'IMMOBILIER'
    ? { livingArea: 68, roomCount: 3, bedroomCount: 2, constructionYear: 1962, floor: '3e', dpeClass: 'C', gesClass: 'A', dpeDate: '2024-03-12', heatingType: 'GAZ_INDIVIDUEL', occupancyUsage: 'RESIDENCE_PRINCIPALE' }
    : family === 'VEHICULE'
      ? { make: 'Urban Arrow', model: 'Family', year: 2022, mileage: 3480, mileageDate: '2026-09-20', vin: 'UA22F0000004871', fuelType: 'ELECTRIQUE' }
      : { brand: 'Firewire', modelName: 'Seaside 5\'8', serialNumber: 'FW-SS58-H-25004318', dimensions: '5\'8 × 21 1/4', storageLocation: 'Garage fermé' };
  return {
    exportType,
    family,
    asset: {
      id: 4127, publicId: 'x', name: family === 'IMMOBILIER' ? 'Appartement Lyon 2e' : family === 'VEHICULE' ? 'Vélo cargo' : 'Planche de surf',
      category: family === 'OBJET' ? 'OBJECT' : family, subtype: family === 'IMMOBILIER' ? 'Appartement' : family === 'VEHICULE' ? 'Vélo' : null,
      objectCategory: null, status: 'EN_SERVICE', generalCondition: 'BON', purchaseDate: '2022-06-04', purchasePriceCents: 549000,
      warrantyEndDate: '2027-06-04', mileageOrHours: null, registrationNumber: family === 'VEHICULE' ? 'AB-123-CD' : null,
      dimensions: null, engineInfo: null, purchaseLocation: 'Revendeur agréé', address: family === 'IMMOBILIER' ? '14 rue des Remparts d’Ainay' : null,
      postalCode: family === 'IMMOBILIER' ? '69002' : null, city: 'Lyon', description: null,
      characteristics: cleanCharacteristics({ ...base, ...RAW_CHARACTERISTICS }),
      equipmentList: ['Cave'],
    },
    documents: [],
    photos: [],
    events: [],
    equipments: [],
    rooms: [],
    additionalInfo: { commercial: {}, rental: {}, insurance: {}, claim: {}, updatedAt: null },
    cil: null,
    preparedBy: 'Claire Martin',
    ...over,
  };
}
