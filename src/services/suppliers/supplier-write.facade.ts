/**
 * Lot 114 (Trello #753, CDC T2 §14.3 W18 – W20, M30) — FAÇADE MÉTIER des
 * écritures d'un fournisseur : création, modification, archivage.
 *
 * Extraite des routes `POST /api/suppliers`, `PATCH /api/suppliers/[id]` et
 * `POST /api/suppliers/[id]/archive`, qui l'appellent désormais : l'interface
 * et l'Assistant Verebona passent par le MÊME code — mêmes validations
 * (`supplier-validation`), même protection par champ (`user_field_decisions`,
 * lot 111X : une saisie ou un effacement volontaire n'est jamais réintroduit
 * par un document), même mémoire des identités distinctes décidées par
 * l'utilisateur (lot 113G), même événement `SUPPLIER_CHANGED`.
 *
 * Aucune suppression physique : le retrait d'un fournisseur est son ARCHIVAGE
 * (lot 109B) — relations historiques conservées, fiche consultable et
 * réactivable. Toutes les écritures sont bornées au compte dans leur SQL.
 */
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db';
import { suppliers } from '@/db/schema';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { normalizeName, userFieldDecisionsAfterPatch, type UserFieldDecisions } from './supplier-service';
import { validateSupplierPatch, type SupplierEditableField } from './supplier-validation';

export interface SupplierCreateInput {
  name: string;
  email?: string | null; phone?: string | null; website?: string | null;
  addressLine1?: string | null; addressLine2?: string | null; postalCode?: string | null; city?: string | null; country?: string | null;
  siret?: string | null; vatNumber?: string | null; iban?: string | null; ibanHolderName?: string | null;
  source?: string | null;
}

const net = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Crée une fiche fournisseur (toutes offres). `confirmedDistinctFrom` : fiches
 * proches que l'utilisateur a déclarées DISTINCTES en créant quand même —
 * mémorisées par paire, jamais reproposées (lot 113G).
 */
export async function createSupplierForAccount(p: {
  accountId: number; userId: number; input: SupplierCreateInput; confirmedDistinctFrom?: readonly number[];
}): Promise<{ id: number; publicId: string | null; name: string; status: string | null }> {
  const name = p.input.name.trim();
  const [cree] = await db.insert(suppliers).values({
    accountId: p.accountId,
    createdByUserId: p.userId,
    name,
    normalizedName: normalizeName(name),
    email: net(p.input.email), phone: net(p.input.phone), website: net(p.input.website),
    addressLine1: net(p.input.addressLine1), addressLine2: net(p.input.addressLine2),
    postalCode: net(p.input.postalCode), city: net(p.input.city), country: net(p.input.country),
    siret: net(p.input.siret), vatNumber: net(p.input.vatNumber),
    iban: net(p.input.iban), ibanHolderName: net(p.input.ibanHolderName),
    source: p.input.source ?? 'manual',
    // Lot 109B : aucun statut de vérification (notion supprimée).
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning({ id: suppliers.id, publicId: suppliers.publicId, name: suppliers.name, status: suppliers.status });

  const ids = (p.confirmedDistinctFrom ?? []).map(Number).filter((x) => Number.isSafeInteger(x) && x > 0);
  if (cree && ids.length) {
    const { recordDistinctFromCandidates } = await import('@/services/agenda/agenda-suppliers');
    await recordDistinctFromCandidates(db as never, p.accountId, cree.id, ids, p.userId ?? null);
  }
  // CDC Assistant §31.7 : modification d'un fournisseur (signal hors catalogue §25.7).
  await emitBusinessEvent({ type: 'SUPPLIER_CHANGED', accountId: p.accountId, entityId: cree?.id ?? null });
  return cree as { id: number; publicId: string | null; name: string; status: string | null };
}

export type SupplierUpdateResult =
  | { ok: true; changed: SupplierEditableField[] }
  | { ok: false; code: 'NOT_FOUND' }
  | { ok: false; code: 'INVALID_INPUT'; message: string; field: SupplierEditableField | null };

/**
 * Modifie les coordonnées d'une fiche du compte (non supprimée). Seuls les
 * champs PRÉSENTS dans `body` sont validés et écrits ; une chaîne vide efface
 * (sauf le nom). Chaque champ dont la valeur CHANGE devient une décision de
 * l'utilisateur (SET / CLEARED), protégée des documents.
 */
export async function updateSupplierForAccount(p: {
  accountId: number; userId: number | null; supplierId: number; body: unknown;
}): Promise<SupplierUpdateResult> {
  const [existing] = await db.select().from(suppliers)
    .where(and(eq(suppliers.id, p.supplierId), eq(suppliers.accountId, p.accountId), ne(suppliers.status, 'deleted'))).limit(1);
  if (!existing) return { ok: false, code: 'NOT_FOUND' };
  const v = validateSupplierPatch(p.body);
  if (!v.ok) return { ok: false, code: 'INVALID_INPUT', message: v.message, field: v.field };

  const updates: Record<string, unknown> = { ...v.updates, updatedAt: new Date() };
  if (typeof v.updates.name === 'string') updates.normalizedName = normalizeName(v.updates.name);
  // Lot 111X : protection PAR CHAMP — une saisie ou un effacement volontaire n'est jamais remplacé ni
  // réintroduit par un document (seul un champ dont la valeur CHANGE est une décision).
  updates.userFieldDecisions = userFieldDecisionsAfterPatch(
    existing as unknown as Record<string, unknown>, v.updates, existing.userFieldDecisions as UserFieldDecisions, p.userId ?? null);

  await db.update(suppliers).set(updates as Partial<typeof suppliers.$inferInsert>)
    .where(and(eq(suppliers.id, p.supplierId), eq(suppliers.accountId, p.accountId)));
  // CDC Assistant §31.7 : modification d'un fournisseur.
  await emitBusinessEvent({ type: 'SUPPLIER_CHANGED', accountId: p.accountId, entityId: p.supplierId });
  return { ok: true, changed: Object.keys(v.updates) as SupplierEditableField[] };
}

/**
 * Archive (ou réactive, `restore`) une fiche du compte. Les relations
 * historiques (documents, biens, équipements, Agenda) sont CONSERVÉES ; la
 * fiche reste consultable et affiche « Archivé » (lot 109B).
 */
export async function setSupplierArchived(p: { accountId: number; supplierId: number; restore?: boolean }):
  Promise<{ ok: true; status: 'active' | 'archived' } | { ok: false; code: 'NOT_FOUND' }> {
  const [existing] = await db.select({ id: suppliers.id, status: suppliers.status }).from(suppliers)
    .where(and(eq(suppliers.id, p.supplierId), eq(suppliers.accountId, p.accountId))).limit(1);
  if (!existing || existing.status === 'deleted') return { ok: false, code: 'NOT_FOUND' };
  const status = p.restore === true ? 'active' : 'archived';
  await db.update(suppliers).set({ status, updatedAt: new Date() })
    .where(and(eq(suppliers.id, p.supplierId), eq(suppliers.accountId, p.accountId)));
  // CDC Assistant §31.7 : fournisseur archivé.
  await emitBusinessEvent({ type: 'SUPPLIER_CHANGED', accountId: p.accountId, entityId: p.supplierId });
  return { ok: true, status };
}
