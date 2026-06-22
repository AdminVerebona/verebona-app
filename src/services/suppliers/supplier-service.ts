/**
 * Supplier Service — CDC Fournisseurs V1
 * Normalization, candidate matching, coordinate consolidation, and scope propagation.
 */

import { db } from '@/db';
import {
  suppliers,
  supplierContactObservations,
  documentSuppliers,
  equipmentSuppliers,
  assetSuppliers,
  supplierReviewItems,
  assetFiles,
  equipments,
  assets,
  accounts,
} from '@/db/schema';
import { eq, and, or, ilike, isNotNull, inArray } from 'drizzle-orm';

// ─── Name normalization ───────────────────────────────────────────────────────

const LEGAL_FORMS = [
  'sas', 'sarl', 'sa', 'eurl', 'ei', 'sasu', 'snc', 'sci', 'scp', 'scop',
  'gie', 'sca', 'scs', 'eurl', 'selarl', 'selafa', 'selca', 'selas',
  'association', 'syndicat',
];

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove accents
    .replace(/['''`]/g, ' ')
    .replace(/[^\w\s]/g, ' ')        // remove non-word chars
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(word => !LEGAL_FORMS.includes(word) || false) // keep all words including legal forms for matching
    .join(' ');
}

// ─── Contact field normalizers ───────────────────────────────────────────────

function normalizePhone(v: string): string {
  let s = v.replace(/[\s.\-()]/g, '');
  if (s.startsWith('0033')) s = '+' + s.slice(2);
  if (/^0[1-9]\d{8}$/.test(s)) s = '+33' + s.slice(1);
  return s.toUpperCase();
}

function normalizeVat(v: string): string {
  return v.replace(/\s/g, '').toUpperCase();
}

function normalizeSiret(v: string): string {
  return v.replace(/[\s\-]/g, '');
}

function normalizeIban(v: string): string {
  return v.replace(/\s/g, '').toUpperCase();
}

function normalizeUrl(v: string): string {
  return v.trim().toLowerCase().replace(/\/$/, '');
}

function normalizeEmail(v: string): string {
  return v.trim().toLowerCase();
}

function normalizeTextField(v: string): string {
  return v.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExtractedSupplierData {
  name: string;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  siren?: string | null;
  siret?: string | null;
  vatNumber?: string | null;
  iban?: string | null;
  ibanHolderName?: string | null;
  confidence?: number;
}

/**
 * Classifie une chaîne comme SIREN (9 chiffres), SIRET (14 chiffres) ou null.
 * Retourne { siren, siret } avec les bons champs remplis et l'autre null.
 */
export function classifySirenSiret(value: string | null | undefined): { siren: string | null; siret: string | null } {
  if (!value) return { siren: null, siret: null };
  const digits = value.replace(/[\s\-\.]/g, '');
  if (/^\d{9}$/.test(digits)) return { siren: digits, siret: null };
  if (/^\d{14}$/.test(digits)) return { siren: digits.slice(0, 9), siret: digits };
  // Format ambigu ou invalide : on stocke tel quel dans siret
  return { siren: null, siret: digits };
}

/**
 * Vérifie si un SIREN détecté est cohérent avec un SIRET stocké
 * (le SIREN est le préfixe du SIRET → pas un vrai conflit).
 */
function isSirenSiretCompatible(detectedSiren: string, storedSiret: string): boolean {
  const normSiren = detectedSiren.replace(/[\s\-\.]/g, '');
  const normSiret = storedSiret.replace(/[\s\-\.]/g, '');
  return normSiret.startsWith(normSiren) && normSiren.length === 9;
}

export interface Candidate {
  id: number;
  publicId: string;
  name: string;
  normalizedName: string;
  siren: string | null;
  siret: string | null;
  vatNumber: string | null;
  score: number;
}

export type MatchDecision = 'certain' | 'uncertain' | 'new';

export interface ConsolidationResult {
  updated: boolean;
  conflicts: ConflictFieldInfo[];
}

export interface ConflictFieldInfo {
  field: string;
  currentValue: string | null;
  detectedValue: string | null;
}

// ─── Find candidates ──────────────────────────────────────────────────────────

export async function findCandidates(
  accountId: number,
  normalizedName: string,
  siren?: string | null,
  siret?: string | null,
  vatNumber?: string | null,
): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: suppliers.id,
      publicId: suppliers.publicId,
      name: suppliers.name,
      normalizedName: suppliers.normalizedName,
      siren: suppliers.siren,
      siret: suppliers.siret,
      vatNumber: suppliers.vatNumber,
    })
    .from(suppliers)
    .where(and(
      eq(suppliers.accountId, accountId),
      eq(suppliers.status, 'active'),
    ));

  const candidates: Candidate[] = [];

  for (const row of rows) {
    let score = 0;

    // Exact SIRET match → certain
    if (siret && row.siret && normalizeSiret(siret) === normalizeSiret(row.siret)) score += 100;
    // SIREN match (exact, or SIREN compatible avec SIRET stocké) → certain
    if (siren && row.siret && isSirenSiretCompatible(siren, row.siret)) score += 100;
    if (siren && row.siren && normalizeSiret(siren) === normalizeSiret(row.siren)) score += 100;
    // Exact VAT match → certain
    if (vatNumber && row.vatNumber && vatNumber === row.vatNumber) score += 100;

    // Name similarity
    if (row.normalizedName === normalizedName) {
      score += 80;
    } else if (
      row.normalizedName.includes(normalizedName) ||
      normalizedName.includes(row.normalizedName)
    ) {
      score += 50;
    } else {
      // Token overlap
      const aTokens = new Set(normalizedName.split(' '));
      const bTokens = new Set(row.normalizedName.split(' '));
      const intersection = [...aTokens].filter(t => bTokens.has(t) && t.length > 2);
      if (intersection.length > 0) {
        score += Math.min(40, intersection.length * 15);
      }
    }

    if (score > 20) {
      candidates.push({ ...row, score });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

// ─── Assess match ─────────────────────────────────────────────────────────────

export function assessMatch(candidates: Candidate[], extractedData: ExtractedSupplierData): MatchDecision {
  if (candidates.length === 0) return 'new';

  const top = candidates[0];

  // Certain: SIRET or VAT exact match, or score ≥ 100
  if (top.score >= 100) return 'certain';

  // Certain: exact normalized name match with high score
  // (même avec plusieurs candidats — le nom exact est fiable)
  if (top.score >= 80) return 'certain';

  // Uncertain: plausible match but not definitive
  if (top.score >= 40) return 'uncertain';

  return 'new';
}

// ─── Consolidate coordinates ──────────────────────────────────────────────────

export async function consolidateCoordinates(
  supplierId: number,
  observation: ExtractedSupplierData,
): Promise<ConsolidationResult> {
  const [supplier] = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, supplierId))
    .limit(1);

  if (!supplier) return { updated: false, conflicts: [] };

  const updates: Partial<typeof suppliers.$inferInsert> = {};
  const conflicts: ConflictFieldInfo[] = [];

  type SupplierField = keyof typeof supplier;
  const fields: { key: SupplierField; obsKey: keyof ExtractedSupplierData }[] = [
    { key: 'email', obsKey: 'email' },
    { key: 'phone', obsKey: 'phone' },
    { key: 'website', obsKey: 'website' },
    { key: 'addressLine1', obsKey: 'addressLine1' },
    { key: 'addressLine2', obsKey: 'addressLine2' },
    { key: 'postalCode', obsKey: 'postalCode' },
    { key: 'city', obsKey: 'city' },
    { key: 'country', obsKey: 'country' },
    { key: 'siren', obsKey: 'siren' },
    { key: 'siret', obsKey: 'siret' },
    { key: 'vatNumber', obsKey: 'vatNumber' },
    { key: 'iban', obsKey: 'iban' },
    { key: 'ibanHolderName', obsKey: 'ibanHolderName' },
  ];

  const normalizers: Partial<Record<SupplierField, (v: string) => string>> = {
    email:          normalizeEmail,
    phone:          normalizePhone,
    website:        normalizeUrl,
    addressLine1:   normalizeTextField,
    addressLine2:   normalizeTextField,
    postalCode:     (v) => v.trim().toUpperCase(),
    city:           normalizeTextField,
    country:        normalizeTextField,
    siren:          normalizeSiret,
    siret:          normalizeSiret,
    vatNumber:      normalizeVat,
    iban:           normalizeIban,
    ibanHolderName: normalizeTextField,
  };

  for (const { key, obsKey } of fields) {
    const current = supplier[key] as string | null | undefined;
    const observed = observation[obsKey] as string | null | undefined;

    if (!observed) continue;

    const norm = normalizers[key] ?? ((v: string) => v.trim());

    if (!current) {
      // Champ vide → remplir avec la valeur normalisée
      // Exception : si on a un SIREN détecté et un SIRET déjà stocké (compatible), on ne touche pas au SIREN
      if (key === 'siren' && supplier.siret && isSirenSiretCompatible(observed, supplier.siret)) {
        // Le SIREN est le préfixe du SIRET stocké : on peut le dériver, pas de remplissage nécessaire
        continue;
      }
      (updates as Record<string, unknown>)[key] = norm(observed);
    } else if (norm(current) !== norm(observed)) {
      // Valeurs différentes → potentiel conflit
      // Exception SIREN/SIRET : un SIREN détecté compatible avec un SIRET stocké n'est pas un conflit
      if (key === 'siret' && supplier.siret && isSirenSiretCompatible(observed, supplier.siret)) continue;
      if (key === 'siren' && supplier.siret && isSirenSiretCompatible(observed, supplier.siret)) continue;
      if (key === 'siret' && supplier.siren && isSirenSiretCompatible(supplier.siren, observed)) continue;
      // Éviter les faux positifs : si la valeur normalisée est vide, ce n'est pas un vrai conflit
      if (!norm(current).trim() || !norm(observed).trim()) continue;
      conflicts.push({ field: key, currentValue: current || null, detectedValue: observed || null });
    }
  }

  if (Object.keys(updates).length > 0) {
    updates.updatedAt = new Date();
    await db.update(suppliers).set(updates).where(eq(suppliers.id, supplierId));
  }

  return { updated: Object.keys(updates).length > 0, conflicts };
}

// ─── Propagate scope ──────────────────────────────────────────────────────────

export async function propagateScopeIfNeeded(supplierId: number, sourceScope: string): Promise<void> {
  if (sourceScope !== 'duo') return;

  const [supplier] = await db
    .select({ id: suppliers.id, scope: suppliers.scope })
    .from(suppliers)
    .where(eq(suppliers.id, supplierId))
    .limit(1);

  if (supplier && supplier.scope === 'personal') {
    await db.update(suppliers)
      .set({ scope: 'duo', updatedAt: new Date() })
      .where(eq(suppliers.id, supplierId));
  }
}

// ─── Recalculate equipment suppliers ─────────────────────────────────────────

export async function recalculateEquipmentSuppliers(documentId: number): Promise<void> {
  const [doc] = await db
    .select({ equipmentId: assetFiles.equipmentId, id: assetFiles.id })
    .from(assetFiles)
    .where(eq(assetFiles.id, documentId))
    .limit(1);

  if (!doc?.equipmentId) return;

  const docSupplierRows = await db
    .select({ supplierId: documentSuppliers.supplierId })
    .from(documentSuppliers)
    .where(eq(documentSuppliers.documentId, documentId));

  for (const { supplierId } of docSupplierRows) {
    const existing = await db
      .select()
      .from(equipmentSuppliers)
      .where(and(
        eq(equipmentSuppliers.equipmentId, doc.equipmentId),
        eq(equipmentSuppliers.supplierId, supplierId),
      ))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(equipmentSuppliers).values({
        equipmentId: doc.equipmentId,
        supplierId,
        sourceDocumentId: documentId,
        sourceType: 'document_derived',
        isPrimary: false,
      });
    }
  }
}

// ─── Main extraction processor ────────────────────────────────────────────────

export async function processSupplierFromExtraction(params: {
  accountId: number;
  assetFileId: number;
  extractedName: string;
  extractedCoordinates?: ExtractedSupplierData;
  confidenceScore?: number;
  createdByUserId: number;
}): Promise<void> {
  const { accountId, assetFileId, extractedName, extractedCoordinates, confidenceScore, createdByUserId } = params;

  if (!extractedName?.trim()) return;

  const normalizedName = normalizeName(extractedName);
  // Classify the raw identifier: SIREN (9 digits) vs SIRET (14 digits)
  const rawIdentifier = extractedCoordinates?.siret ?? extractedCoordinates?.siren ?? null;
  const { siren, siret } = classifySirenSiret(rawIdentifier);
  const vatNumber = extractedCoordinates?.vatNumber;

  // Enrich extractedCoordinates with classified values
  if (extractedCoordinates) {
    extractedCoordinates.siren = siren;
    extractedCoordinates.siret = siret;
  }

  const candidates = await findCandidates(accountId, normalizedName, siren, siret, vatNumber);
  const extractedData: ExtractedSupplierData = {
    name: extractedName,
    ...extractedCoordinates,
  };
  const decision = assessMatch(candidates, extractedData);

  let supplierId: number;

  if (decision === 'certain') {
    supplierId = candidates[0].id;
  } else if (decision === 'uncertain') {
    // Create a review item for deduplication, use/create a supplier
    const newSupplier = await db.insert(suppliers).values({
      accountId,
      createdByUserId,
      name: extractedName,
      normalizedName,
      source: 'document_extraction',
      contactStatus: 'unverified',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning({ id: suppliers.id });
    supplierId = newSupplier[0].id;

    await db.insert(supplierReviewItems).values({
      accountId,
      itemType: 'deduplication',
      status: 'open',
      supplierId,
      documentId: assetFileId,
      detectedName: extractedName,
      candidateSupplierIds: candidates.slice(0, 3).map(c => c.id),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } else {
    // New supplier
    const newSupplier = await db.insert(suppliers).values({
      accountId,
      createdByUserId,
      name: extractedName,
      normalizedName,
      source: 'document_extraction',
      contactStatus: 'unverified',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning({ id: suppliers.id });
    supplierId = newSupplier[0].id;
  }

  // Link document → supplier
  const existingLink = await db
    .select()
    .from(documentSuppliers)
    .where(and(
      eq(documentSuppliers.documentId, assetFileId),
      eq(documentSuppliers.supplierId, supplierId),
    ))
    .limit(1);

  if (existingLink.length === 0) {
    await db.insert(documentSuppliers).values({
      documentId: assetFileId,
      supplierId,
      isConfirmed: decision === 'certain',
      confidenceScore: confidenceScore ? String(confidenceScore) : null,
    });
  }

  // Save observation with extracted coordinates
  if (extractedCoordinates) {
    const [obs] = await db.insert(supplierContactObservations).values({
      supplierId,
      documentId: assetFileId,
      observedName: extractedName,
      observedEmail: extractedCoordinates.email ?? null,
      observedPhone: extractedCoordinates.phone ?? null,
      observedWebsite: extractedCoordinates.website ?? null,
      observedAddressLine1: extractedCoordinates.addressLine1 ?? null,
      observedAddressLine2: extractedCoordinates.addressLine2 ?? null,
      observedPostalCode: extractedCoordinates.postalCode ?? null,
      observedCity: extractedCoordinates.city ?? null,
      observedCountry: extractedCoordinates.country ?? null,
      observedSiren: extractedCoordinates.siren ?? null,
      observedSiret: extractedCoordinates.siret ?? null,
      observedVatNumber: extractedCoordinates.vatNumber ?? null,
      observedIban: extractedCoordinates.iban ?? null,
      observedIbanHolderName: extractedCoordinates.ibanHolderName ?? null,
      confidenceScore: confidenceScore ? String(confidenceScore) : null,
      createdAt: new Date(),
    }).returning();

    // Consolidate coordinates and detect conflicts
    const { conflicts } = await consolidateCoordinates(supplierId, extractedCoordinates);

    // Create review items for each conflict (except IBAN — handled separately)
    for (const { field, currentValue, detectedValue } of conflicts) {
      await db.insert(supplierReviewItems).values({
        accountId,
        itemType: 'contact_conflict',
        status: 'open',
        supplierId,
        documentId: assetFileId,
        observationId: obs.id,
        conflictingField: field,
        // Never log IBAN values in review items
        currentValue: field === 'iban' ? null : currentValue,
        detectedValue: field === 'iban' ? null : detectedValue,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }

  // Get document scope for propagation
  const [doc] = await db
    .select({ scope: assetFiles.scope })
    .from(assetFiles)
    .where(eq(assetFiles.id, assetFileId))
    .limit(1);

  if (doc) {
    await propagateScopeIfNeeded(supplierId, doc.scope);
  }

  // Propagate to equipment_suppliers if document is linked to an equipment
  await recalculateEquipmentSuppliers(assetFileId);
}
