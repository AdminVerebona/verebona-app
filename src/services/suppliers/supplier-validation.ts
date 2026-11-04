/**
 * Lot 109B — validation des coordonnées modifiées depuis la fiche fournisseur
 * (`PATCH /api/suppliers/[id]`). Pure, testée.
 *
 * Seuls les champs PRÉSENTS dans la requête sont validés et modifiés ; une
 * chaîne vide efface la valeur (sauf le nom, obligatoire). Aucun statut de
 * vérification n'est accepté ni calculé (notion supprimée, lot 109B).
 */

export const SUPPLIER_EDITABLE_FIELDS = [
  'name', 'email', 'phone', 'website', 'addressLine1', 'addressLine2',
  'postalCode', 'city', 'country', 'siren', 'siret', 'vatNumber', 'iban', 'ibanHolderName',
] as const;
export type SupplierEditableField = (typeof SUPPLIER_EDITABLE_FIELDS)[number];

/** Longueur maximale d'un champ texte (le nom suit la règle du tiroir Agenda). */
const MAX_LENGTH: Partial<Record<SupplierEditableField, number>> = { name: 200, website: 500 };
const DEFAULT_MAX = 300;

export type SupplierPatchValidation =
  | { ok: true; updates: Partial<Record<SupplierEditableField, string | null>> }
  | { ok: false; field: SupplierEditableField | null; message: string };

const compact = (v: string) => v.replace(/[\s.-]+/g, '');

export function validateSupplierPatch(body: unknown): SupplierPatchValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, field: null, message: 'Invalid body' };
  const b = body as Record<string, unknown>;
  const updates: Partial<Record<SupplierEditableField, string | null>> = {};
  for (const field of SUPPLIER_EDITABLE_FIELDS) {
    if (!(field in b)) continue;
    const raw = b[field];
    if (raw !== null && typeof raw !== 'string') return { ok: false, field, message: `${field} must be a string` };
    let v = typeof raw === 'string' ? raw.trim() : '';
    if (v.length > (MAX_LENGTH[field] ?? DEFAULT_MAX)) return { ok: false, field, message: `${field} is too long` };
    if (field === 'name') {
      if (!v) return { ok: false, field, message: 'name is required' };
      updates.name = v.replace(/\s+/g, ' ');
      continue;
    }
    if (!v) { updates[field] = null; continue; }
    if (field === 'siren') {
      v = compact(v);
      if (!/^\d{9}$/.test(v)) return { ok: false, field, message: 'SIREN must have 9 digits' };
    } else if (field === 'siret') {
      v = compact(v);
      if (!/^\d{14}$/.test(v)) return { ok: false, field, message: 'SIRET must have 14 digits' };
    } else if (field === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, field, message: 'Invalid email' };
    } else if (field === 'iban') {
      v = v.replace(/\s+/g, '').toUpperCase();
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(v)) return { ok: false, field, message: 'Invalid IBAN' };
    } else if (field === 'vatNumber') {
      v = v.replace(/\s+/g, '').toUpperCase();
    }
    updates[field] = v;
  }
  return { ok: true, updates };
}

/** Lien web actionnable (protocole ajouté si absent ; seuls http/https). */
export function websiteHref(website: string | null | undefined): string | null {
  const w = (website ?? '').trim();
  if (!w) return null;
  const withProto = /^https?:\/\//i.test(w) ? w : /^[a-z][a-z0-9+.-]*:/i.test(w) ? null : `https://${w}`;
  if (!withProto) return null;
  try {
    const u = new URL(withProto);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Numéro composable (`tel:`) : chiffres et « + » initial seulement. */
export function phoneHref(phone: string | null | undefined): string | null {
  const p = (phone ?? '').trim();
  if (!p) return null;
  const digits = p.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  return digits.replace(/\D/g, '').length >= 3 ? `tel:${digits}` : null;
}
