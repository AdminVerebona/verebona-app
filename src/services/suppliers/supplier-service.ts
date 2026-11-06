/**
 * Supplier Service — CDC Fournisseurs V1
 * Normalization, candidate matching, coordinate consolidation, and scope propagation.
 *
 * Lot 22 (chantier B) : `findCandidates`, `assessMatch` et
 * `consolidateCoordinates` sont de nouveau appelés — alimentation du
 * référentiel depuis la projection T1 (`supplier-from-analysis.ts`). Ils
 * acceptent un exécutant (`q`) pour s'exécuter dans la transaction de
 * l'appelant (pool à une connexion sous `next start`).
 */

import { db } from '@/db';
import { suppliers, supplierReviewItems } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';

/** Exécutant drizzle : `db`, ou la transaction en cours. */
export type SupplierQueryRunner = Pick<typeof db, 'select' | 'insert' | 'update'>;

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

type MatchDecision = 'certain' | 'uncertain' | 'new';

export interface ConsolidationResult {
  updated: boolean;
  conflicts: ConflictFieldInfo[];
  /** Lot 111X : décision par champ observé (historique). */
  outcomes: ConsolidationOutcome[];
}

interface ConflictFieldInfo {
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
  q: SupplierQueryRunner = db,
): Promise<Candidate[]> {
  const rows = await q
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

export function assessMatch(candidates: Candidate[]): MatchDecision {
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

/**
 * Lot 111X — décision par champ d'une consolidation (historique, diagnostic) :
 *   FILLED        champ vide complété ;
 *   SAME          même valeur déjà enregistrée (rien à faire) ;
 *   COMPATIBLE    SIREN / SIRET compatibles (pas un conflit) ;
 *   CONFLICT      valeur enregistrée différente : jamais écrasée, revue sourcée ;
 *   USER_CLEARED  champ effacé volontairement par l'utilisateur : jamais réintroduit ;
 *   ADDRESS_MIXED adresse partiellement renseignée et différente : aucun mélange
 *                 de deux adresses (code postal de l'une, ville de l'autre) ;
 *   IDENTITY_CONFLICT SIRET observé différent du SIRET enregistré : le SIREN
 *                 n'est pas complété depuis cette observation ;
 *   COMPARE_ONLY  appel en comparaison seule (`fill: false`).
 */
export type ConsolidationDecision = 'FILLED' | 'SAME' | 'COMPATIBLE' | 'CONFLICT' | 'USER_CLEARED' | 'ADDRESS_MIXED' | 'IDENTITY_CONFLICT' | 'COMPARE_ONLY';

export interface ConsolidationOutcome {
  field: string;
  decision: ConsolidationDecision;
  before: string | null;
  after: string | null;
  observed: string;
}

/** Décisions de l'utilisateur par champ (`suppliers.user_field_decisions`, migration 1335). */
export type UserFieldDecisions = Record<string, { action: 'SET' | 'CLEARED'; at: string; userId: number | null }>;

/**
 * Lot 111X — décisions de l'utilisateur après une modification de la fiche
 * (pure) : seul un champ dont la valeur CHANGE est une décision (un
 * enregistrement du formulaire qui renvoie un champ vide resté vide n'est pas
 * un effacement volontaire). Valeur vidée → CLEARED ; valeur saisie → SET.
 */
export function userFieldDecisionsAfterPatch(
  current: Record<string, unknown>,
  updates: Record<string, string | null | undefined>,
  previous: UserFieldDecisions | null | undefined,
  userId: number | null,
  at: Date = new Date(),
): UserFieldDecisions {
  const out: UserFieldDecisions = { ...(previous ?? {}) };
  for (const [field, v] of Object.entries(updates)) {
    if (field === 'name' || v === undefined) continue;
    const avant = typeof current[field] === 'string' ? (current[field] as string).trim() : '';
    const apres = typeof v === 'string' ? v.trim() : '';
    if (avant === apres) continue;
    out[field] = { action: apres ? 'SET' : 'CLEARED', at: at.toISOString(), userId };
  }
  return out;
}

/** Forme ENREGISTRÉE d'une valeur lue (jamais reformulée au-delà d'un nettoyage). */
const storageForm: Partial<Record<string, (v: string) => string>> = {
  email: (v) => v.trim().toLowerCase(),
  phone: (v) => { const s = v.replace(/[\s.\-()]/g, ''); return s.startsWith('0033') ? `+${s.slice(2)}` : s; },
  website: (v) => v.trim().replace(/\/$/, ''),
  vatNumber: (v) => v.replace(/\s/g, '').toUpperCase(),
  iban: (v) => v.replace(/\s/g, '').toUpperCase(),
  siren: (v) => v.replace(/[\s\-.]/g, ''),
  siret: (v) => v.replace(/[\s\-.]/g, ''),
  postalCode: (v) => v.trim().toUpperCase(),
};
const stocker = (key: string, v: string) => (storageForm[key] ?? ((x: string) => x.trim().replace(/\s+/g, ' ')))(v);

export async function consolidateCoordinates(
  supplierId: number,
  observation: ExtractedSupplierData,
  opts: {
    q?: SupplierQueryRunner;
    /**
     * Remplir les champs VIDES (défaut : oui). Faux : seulement relever les
     * conflits. Un champ renseigné n'est JAMAIS remplacé (conflit à la place).
     * Lot 111X : la protection est PAR CHAMP (`user_field_decisions`) — un
     * champ effacé volontairement n'est jamais réintroduit ; une fiche
     * créée à la main complète ses champs jamais renseignés.
     */
    fill?: boolean;
    /** Lot 111X : provenance des champs complétés (`suppliers.field_provenance`). */
    provenance?: (field: string) => Record<string, unknown> | null;
  } = {},
): Promise<ConsolidationResult> {
  const q = opts.q ?? db;
  const [supplier] = await q
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, supplierId))
    .limit(1);

  if (!supplier) return { updated: false, conflicts: [], outcomes: [] };

  const updates: Partial<typeof suppliers.$inferInsert> = {};
  const conflicts: ConflictFieldInfo[] = [];
  const outcomes: ConsolidationOutcome[] = [];
  const decisionsUtilisateur = (supplier.userFieldDecisions ?? {}) as UserFieldDecisions;

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

  // Adresse : un seul ensemble cohérent — si une partie déjà renseignée diffère, aucun champ d'adresse n'est complété.
  const ADRESSE: SupplierField[] = ['addressLine1', 'addressLine2', 'postalCode', 'city'];
  const adresseMelangee = ADRESSE.some((k) => {
    const cur = supplier[k] as string | null;
    const obs = observation[k as keyof ExtractedSupplierData] as string | null | undefined;
    const norm = normalizers[k]!;
    return !!cur && !!obs && norm(cur) !== norm(obs);
  });

  const provenance: Record<string, Record<string, unknown>> = { ...((supplier.fieldProvenance ?? {}) as Record<string, Record<string, unknown>>) };
  for (const { key, obsKey } of fields) {
    const current = supplier[key] as string | null | undefined;
    const observed = observation[obsKey] as string | null | undefined;

    if (!observed) continue;

    const norm = normalizers[key] ?? ((v: string) => v.trim());
    const out = (decision: ConsolidationDecision, after: string | null = current ?? null) =>
      outcomes.push({ field: key as string, decision, before: current ?? null, after, observed });

    if (!current) {
      // Lot 111X : effacement volontaire de l'utilisateur respecté à chaque reprise.
      if (decisionsUtilisateur[key as string]?.action === 'CLEARED') { out('USER_CLEARED'); continue; }
      if (opts.fill === false) { out('COMPARE_ONLY'); continue; }
      // Exception : si on a un SIREN détecté et un SIRET déjà stocké (compatible), on ne touche pas au SIREN
      if (key === 'siren' && supplier.siret && isSirenSiretCompatible(observed, supplier.siret)) {
        out('COMPATIBLE');
        continue;
      }
      if (ADRESSE.includes(key) && adresseMelangee) { out('ADDRESS_MIXED'); continue; }
      if (key === 'siren' && supplier.siret && observation.siret && normalizeSiret(supplier.siret) !== normalizeSiret(observation.siret)) { out('IDENTITY_CONFLICT'); continue; }
      const v = stocker(key as string, observed);
      (updates as Record<string, unknown>)[key] = v;
      const pv = opts.provenance?.(key as string);
      if (pv) provenance[key as string] = pv;
      out('FILLED', v);
    } else if (norm(current) !== norm(observed)) {
      // Valeurs différentes → potentiel conflit
      // Exception SIREN/SIRET : un SIREN détecté compatible avec un SIRET stocké n'est pas un conflit
      if (key === 'siret' && supplier.siret && isSirenSiretCompatible(observed, supplier.siret)) { out('COMPATIBLE'); continue; }
      if (key === 'siren' && supplier.siret && isSirenSiretCompatible(observed, supplier.siret)) { out('COMPATIBLE'); continue; }
      if (key === 'siret' && supplier.siren && isSirenSiretCompatible(supplier.siren, observed)) { out('COMPATIBLE'); continue; }
      // Éviter les faux positifs : si la valeur normalisée est vide, ce n'est pas un vrai conflit
      if (!norm(current).trim() || !norm(observed).trim()) continue;
      conflicts.push({ field: key, currentValue: current || null, detectedValue: observed || null });
      out('CONFLICT');
    } else {
      out('SAME');
    }
  }

  if (Object.keys(updates).length > 0) {
    updates.updatedAt = new Date();
    if (opts.provenance) updates.fieldProvenance = provenance;
    await q.update(suppliers).set(updates).where(eq(suppliers.id, supplierId));
  }

  return { updated: Object.keys(updates).length > 0, conflicts, outcomes };
}

/**
 * Lot 111X — revues de conflit de VALEUR (`contact_conflict`), sourcées par le
 * document et l'observation (distinctes du doute d'identité `deduplication`,
 * ticket #706). Une par (fournisseur, champ, valeur relevée) ouverte ; une
 * valeur déjà tranchée par l'utilisateur (« garder l'actuelle », « ignorer »)
 * n'est jamais reproposée. Rend le nombre de revues ouvertes.
 */
export async function openContactConflicts(q: SupplierQueryRunner, p: {
  accountId: number; supplierId: number; documentId: number | null; observationId: number | null;
  conflicts: ReadonlyArray<{ field: string; currentValue: string | null; detectedValue: string | null }>;
}): Promise<number> {
  let n = 0;
  // IBAN : jamais en clair dans une revue (ni appliqué d'un clic, lot 109B) — valeurs masquées.
  const { maskIban } = await import('@/lib/suppliers/supplier-fiche-config');
  for (const brut of p.conflicts) {
    const c = brut.field === 'iban' ? { ...brut, currentValue: maskIban(brut.currentValue), detectedValue: maskIban(brut.detectedValue) } : brut;
    const [deja] = await q
      .select({ id: supplierReviewItems.id, status: supplierReviewItems.status })
      .from(supplierReviewItems)
      .where(and(
        eq(supplierReviewItems.supplierId, p.supplierId),
        eq(supplierReviewItems.itemType, 'contact_conflict'),
        eq(supplierReviewItems.conflictingField, c.field),
        eq(supplierReviewItems.detectedValue, c.detectedValue ?? ''),
        sql`(${supplierReviewItems.status} = 'open' OR ${supplierReviewItems.resolution} IN ('keep_current', 'ignored'))`,
      ))
      .limit(1);
    if (deja) continue;
    await q.insert(supplierReviewItems).values({
      accountId: p.accountId,
      itemType: 'contact_conflict',
      status: 'open',
      supplierId: p.supplierId,
      documentId: p.documentId,
      observationId: p.observationId,
      conflictingField: c.field,
      currentValue: c.currentValue,
      detectedValue: c.detectedValue,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    n += 1;
  }
  return n;
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
  // Lot 49 (SEC-03) : un fournisseur du document n'est reporté sur
  // l'équipement que si le document, l'équipement (par son bien) et le
  // fournisseur sont du MÊME compte — condition portée par l'INSERT
  // lui-même : une relation document → équipement incorrecte en base ne
  // propage jamais de fournisseur vers un autre compte.
  await db.execute(sql`
    INSERT INTO equipment_suppliers (equipment_id, supplier_id, source_document_id, source_type, is_primary)
    SELECT f.equipment_id, ds.supplier_id, f.id, 'document_derived', false
      FROM asset_files f
      JOIN equipments e ON e.id = f.equipment_id
      JOIN assets a ON a.id = e.asset_id AND a.account_id = f.account_id
      JOIN document_suppliers ds ON ds.document_id = f.id
      JOIN suppliers s ON s.id = ds.supplier_id AND s.account_id = f.account_id
     WHERE f.id = ${documentId} AND f.equipment_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM equipment_suppliers x WHERE x.equipment_id = f.equipment_id AND x.supplier_id = ds.supplier_id)
    ON CONFLICT DO NOTHING`);
}

