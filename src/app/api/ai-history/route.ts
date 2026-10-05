/**
 * GET /api/ai-history
 * Retourne l'historique des modifications automatiques IA pour le compte courant.
 *
 * Lot 22 : les écritures sur un ÉQUIPEMENT ou une PIÈCE du bien (cible 0236)
 * y figurent, libellé « Champ (nom de l'entité) » ; `assetId` / `assetName`
 * restent ceux du bien porteur (filtre « Bien » inchangé).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { aiFieldUpdates, assets, assetFiles } from '@/db/schema';
import { eq, desc, count, and, gte, lte } from 'drizzle-orm';
import { aiFieldUpdatesTargetReady } from '@/services/canonical/entity-state/entity-schema';
import {
  entityScopedLabel, fieldUpdateTargetColumns, registryFieldLabel, visibleFieldUpdatesWhere,
} from '@/services/canonical/entity-state/ai-field-updates-target';

// Labels lisibles pour les clés de champs
// Ensemble des champs visibles par l'utilisateur dans l'UI (AssetDetailsTab)
// Toute fieldKey hors de cet ensemble est filtrée — ce sont des champs techniques
// enrichis par l'IA mais non affichés dans le formulaire.
const VISIBLE_FIELDS = new Set([
  'name', 'subCategory', 'description', 'acquisitionDate', 'acquisitionPrice',
  'vehicleOwnershipStatus', 'notes',
  'address1', 'address2', 'postalCode', 'city', 'country', 'cadastralRef', 'lotNumber', 'floor', 'gpsCoords',
  'livingArea', 'landArea', 'roomCount', 'bedroomCount', 'levels', 'constructionYear', 'generalCondition',
  'occupancyUsage', 'occupancyStatus', 'monthlyRent', 'charges', 'occupancyNotes',
  'heatingType', 'mainEnergy', 'dpeClass', 'dpeDate', 'gesClass', 'networks',
  'estimatedValue', 'valuationSource', 'valuationDate',
  'make', 'model', 'registrationNumber', 'vin', 'year',
  'engine', 'fuelType', 'fiscalHp', 'powerKw', 'ptac', 'seats', 'firstRegistrationDate',
  'mileage', 'mileageUnit', 'mileageDate', 'primaryUse',
  'isInsured', 'insurer', 'insuranceExpiry', 'insuranceContractNumber', 'insuranceClientNumber', 'insurancePremium', 'nextInspection',
  'objectCategory', 'brand', 'modelName', 'serialNumber',
  'condition', 'dimensions', 'weight', 'accessories',
  'acquisitionMode', 'provenance', 'authenticityProof',
  'storageLocation', 'lastRevision',
]);

const FIELD_LABELS: Record<string, string> = {
  name:                    'Nom du bien',
  description:             'Description',
  acquisitionDate:         "Date d'acquisition",
  acquisitionPrice:        "Prix d'acquisition",
  acquisitionLocation:     "Lieu d'acquisition",
  estimatedValue:          'Valeur estimée',
  make:                    'Marque',
  model:                   'Modèle',
  registrationNumber:      "Numéro d'immatriculation",
  vin:                     'Numéro VIN',
  year:                    'Année',
  engine:                  'Moteur',
  fuelType:                'Carburant',
  powerKw:                 'Puissance (kW)',
  seats:                   'Nombre de places',
  mileage:                 'Kilométrage',
  mileageUnit:             'Unité kilométrage',
  mileageDate:             'Date du kilométrage',
  isInsured:               'Assuré',
  insurer:                 'Assureur',
  insuranceExpiry:         "Date d'échéance assurance",
  insuranceContractNumber: 'N° de contrat assurance',
  insuranceClientNumber:   'N° de client assurance',
  insurancePremium:        'Prime annuelle assurance (€)',
  nextInspection:          'Prochain contrôle technique',
  vehicleOwnershipStatus:  'Statut de détention',
  occupancyStatus:         "Statut d'occupation",
  address1:                'Adresse',
  city:                    'Ville',
  postalCode:              'Code postal',
  livingArea:              'Surface habitable (m²)',
  landArea:                'Surface terrain (m²)',
  roomCount:               'Nombre de pièces',
  constructionYear:        'Année de construction',
  dpeClass:                'Classe DPE',
  gesClass:                'Classe GES',
  brand:                   'Marque',
  modelName:               'Modèle',
  serialNumber:            'Numéro de série',
  condition:               'État',
};

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 400 });

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 100);
    const offset = parseInt(url.searchParams.get('offset') ?? '0');
    const filterAssetId = url.searchParams.get('assetId') ? parseInt(url.searchParams.get('assetId')!) : null;
    const filterDateFrom = url.searchParams.get('dateFrom') ? new Date(url.searchParams.get('dateFrom')!) : null;
    const filterDateTo = url.searchParams.get('dateTo') ? new Date(url.searchParams.get('dateTo')! + 'T23:59:59') : null;

    const cible = await aiFieldUpdatesTargetReady();
    const cibleCols = fieldUpdateTargetColumns(cible);
    const conditions = [
      eq(aiFieldUpdates.accountId, accountId),
      ...(filterAssetId ? [eq(aiFieldUpdates.assetId, filterAssetId)] : []),
      ...(filterDateFrom ? [gte(aiFieldUpdates.createdAt, filterDateFrom)] : []),
      ...(filterDateTo ? [lte(aiFieldUpdates.createdAt, filterDateTo)] : []),
      visibleFieldUpdatesWhere(cible, [...VISIBLE_FIELDS]),
    ];
    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

    const [rows, [{ total }]] = await Promise.all([
      db.select({
        id:          aiFieldUpdates.id,
        fieldKey:    aiFieldUpdates.fieldKey,
        oldValue:    aiFieldUpdates.oldValue,
        newValue:    aiFieldUpdates.newValue,
        createdAt:   aiFieldUpdates.createdAt,
        assetId:     aiFieldUpdates.assetId,
        assetName:   assets.name,
        assetFileId: aiFieldUpdates.assetFileId,
        docTitle:    assetFiles.retainedTitle,
        targetType:  cibleCols.targetType,
        targetId:    cibleCols.targetId,
        entityName:  cibleCols.entityName,
      })
      .from(aiFieldUpdates)
      .leftJoin(assets, eq(aiFieldUpdates.assetId, assets.id))
      .leftJoin(assetFiles, eq(aiFieldUpdates.assetFileId, assetFiles.id))
      .where(whereClause)
      .orderBy(desc(aiFieldUpdates.createdAt))
      .limit(limit)
      .offset(offset),
      db.select({ total: count() }).from(aiFieldUpdates).where(whereClause),
    ]);

    const items = rows
      .map(r => ({
      id:          r.id,
      fieldKey:    r.fieldKey,
      fieldLabel:  r.targetType
        ? entityScopedLabel(FIELD_LABELS[r.fieldKey] ?? registryFieldLabel(r.fieldKey), r.entityName ?? (r.targetType === 'ROOM' ? 'pièce supprimée' : 'équipement supprimé'))
        : FIELD_LABELS[r.fieldKey] ?? r.fieldKey,
      oldValue:    r.oldValue,
      newValue:    r.newValue,
      createdAt:   r.createdAt,
      assetId:     r.assetId,
      assetName:   r.assetName ?? 'Bien inconnu',
      docTitle:    r.docTitle ?? null,
      // Cible (lot 22) : null pour un champ du bien.
      entityType:  r.targetType ?? null,
      entityId:    r.targetId ?? null,
      entityName:  r.entityName ?? null,
    }));

    return NextResponse.json({ items, total });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('GET /api/ai-history error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
