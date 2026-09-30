/**
 * Fournisseurs dédoublonnés — CDC 15 T2-05 (lot 15).
 *
 * Un même fournisseur apparaît sous trois formes : la fiche structurée
 * (`suppliers`), le nom lu sur les documents (`asset_files.supplier`, lié ou
 * non par `document_suppliers`), et les interventions (documents d'entretien
 * ou de réparation, équipements suivis — `equipment_suppliers`). Ce module
 * les réunit en UNE entrée par fournisseur :
 *
 *   · un document lié à une fiche (`document_suppliers`) compte pour elle ;
 *   · un nom de document non lié dont le nom normalisé (`normalizeName`,
 *     formes juridiques retirées) est celui d'une fiche compte pour elle ;
 *   · sinon, les documents de même nom normalisé forment une entrée « non
 *     enregistrée » (pas de fiche : non ouvrable).
 *
 * Fournisseur de données destiné à l'adaptateur de Y (`retrieval-adapters`).
 * Borné au compte ; documents supprimés et fiches supprimées exclus.
 */
import { pgClient } from '@/db';
import { normalizeName } from '@/services/suppliers/supplier-service';
import type { RetrievedSource } from '../types/sources';

export interface SupplierEntry {
  /** Clé de dédoublonnage : `id:<supplierId>` ou `name:<nom normalisé>`. */
  key: string;
  supplierId: number | null;
  name: string;
  city: string | null;
  documentCount: number;
  /** Documents d'entretien / réparation / travaux (interventions). */
  interventionCount: number;
  equipmentCount: number;
  lastDocumentDate: string | null;
  /** D'où l'entrée est connue : fiche, documents, interventions. */
  origins: Array<'structured' | 'document' | 'intervention'>;
}

const INTERVENTION_TYPES = new Set([
  'MAINTENANCE_INVOICE', 'REPAIR_INVOICE', 'WORKS_INVOICE', 'MAINTENANCE_REPORT', 'INTERVENTION_REPORT', 'MAINTENANCE_LOG',
  'INSTALLATION_REPORT', 'RAPPORT_ENTRETIEN',
]);

export interface SupplierRawData {
  structured: Array<{ id: number; name: string; normalizedName: string | null; city: string | null; equipmentCount: number }>;
  documents: Array<{ fileId: number; supplierText: string | null; supplierId: number | null; typeCode: string | null; date: string | null }>;
}

/** Dédoublonnage (pur, testé). */
export function dedupeSuppliers(raw: SupplierRawData): SupplierEntry[] {
  const parId = new Map<number, SupplierEntry>();
  const parNom = new Map<string, SupplierEntry>();
  const idParNom = new Map<string, number>();
  for (const s of raw.structured) {
    const e: SupplierEntry = {
      key: `id:${s.id}`, supplierId: s.id, name: s.name, city: s.city, documentCount: 0, interventionCount: 0,
      equipmentCount: s.equipmentCount, lastDocumentDate: null, origins: ['structured'],
    };
    parId.set(s.id, e);
    const n = s.normalizedName || normalizeName(s.name);
    if (n && !idParNom.has(n)) idParNom.set(n, s.id);
  }
  const compter = (e: SupplierEntry, d: SupplierRawData['documents'][number]) => {
    e.documentCount += 1;
    if (!e.origins.includes('document')) e.origins.push('document');
    if (d.typeCode && INTERVENTION_TYPES.has(d.typeCode)) {
      e.interventionCount += 1;
      if (!e.origins.includes('intervention')) e.origins.push('intervention');
    }
    if (d.date && (!e.lastDocumentDate || d.date > e.lastDocumentDate)) e.lastDocumentDate = d.date;
  };
  const vus = new Set<string>();
  for (const d of raw.documents) {
    const lie = d.supplierId != null ? parId.get(d.supplierId) : undefined;
    const n = d.supplierText ? normalizeName(d.supplierText) : '';
    const cible = lie ?? (n && idParNom.has(n) ? parId.get(idParNom.get(n)!) : undefined);
    const dedup = `${d.fileId}|${cible?.key ?? n}`;
    if (vus.has(dedup)) continue;
    vus.add(dedup);
    if (cible) { compter(cible, d); continue; }
    if (!n) continue;
    const e = parNom.get(n) ?? {
      key: `name:${n}`, supplierId: null, name: d.supplierText!.trim(), city: null, documentCount: 0, interventionCount: 0,
      equipmentCount: 0, lastDocumentDate: null, origins: [],
    };
    compter(e, d);
    parNom.set(n, e);
  }
  return [...parId.values(), ...parNom.values()]
    .sort((a, b) => b.documentCount - a.documentCount || a.name.localeCompare(b.name, 'fr'));
}

/**
 * Fournisseurs du compte, dédoublonnés. `terms` : filtre (nom ou ville,
 * insensible aux accents) ; `limit` ≤ 100.
 */
export async function listSuppliersDeduplicated(accountId: number, opts: { terms?: string[]; limit?: number } = {}): Promise<SupplierEntry[]> {
  const [structured, documents] = await Promise.all([
    pgClient.unsafe(
      `SELECT s.id, s.name, s.normalized_name AS "normalizedName", s.city,
              (SELECT count(*)::int FROM equipment_suppliers es JOIN equipments e ON e.id = es.equipment_id
                 JOIN assets a ON a.id = e.asset_id AND a.account_id = s.account_id AND a.deleted_at IS NULL
                WHERE es.supplier_id = s.id) AS "equipmentCount"
         FROM suppliers s WHERE s.account_id = $1 AND s.status <> 'deleted' ORDER BY s.id LIMIT 1000`,
      [accountId] as never[],
    ) as unknown as Promise<SupplierRawData['structured']>,
    pgClient.unsafe(
      `SELECT f.id AS "fileId", f.supplier AS "supplierText", ds.supplier_id AS "supplierId",
              coalesce(f.document_type_code, f.document_type) AS "typeCode", to_char(f.document_date, 'YYYY-MM-DD') AS date
         FROM asset_files f
         LEFT JOIN document_suppliers ds ON ds.document_id = f.id
         LEFT JOIN suppliers s ON s.id = ds.supplier_id AND s.account_id = f.account_id AND s.status <> 'deleted'
        WHERE f.account_id = $1 AND f.deleted_at IS NULL AND (f.supplier IS NOT NULL OR s.id IS NOT NULL)
        ORDER BY f.id LIMIT 5000`,
      [accountId] as never[],
    ) as unknown as Promise<SupplierRawData['documents']>,
  ]);
  let list = dedupeSuppliers({ structured, documents });
  const terms = (opts.terms ?? []).map((t) => normalizeName(t)).filter((t) => t.length >= 2);
  if (terms.length) list = list.filter((e) => terms.some((t) => normalizeName(`${e.name} ${e.city ?? ''}`).includes(t)));
  return list.slice(0, Math.min(Math.max(opts.limit ?? 20, 1), 100));
}

/** Source d'un fournisseur : `supplier_<id>` (fiche, ouvrable) ou `suppliername_<n>` (documents seuls). */
export function supplierSource(e: SupplierEntry, index = 0): RetrievedSource {
  const details = [
    e.city,
    e.documentCount ? `${e.documentCount} document${e.documentCount > 1 ? 's' : ''}` : null,
    e.interventionCount ? `${e.interventionCount} intervention${e.interventionCount > 1 ? 's' : ''}` : null,
    e.equipmentCount ? `${e.equipmentCount} équipement${e.equipmentCount > 1 ? 's' : ''} suivi${e.equipmentCount > 1 ? 's' : ''}` : null,
    e.lastDocumentDate ? `dernier document le ${e.lastDocumentDate}` : null,
    e.supplierId ? null : 'fournisseur non enregistré (lu sur vos documents)',
  ].filter(Boolean);
  return {
    id: e.supplierId ? `supplier_${e.supplierId}` : `suppliername_${index}`,
    type: 'supplier',
    title: e.name,
    content: details.join(' · '),
    relevanceScore: 1,
    meta: {
      supplierId: e.supplierId, subtitle: e.city, documentCount: e.documentCount, interventionCount: e.interventionCount,
      registered: e.supplierId !== null,
    },
  };
}
