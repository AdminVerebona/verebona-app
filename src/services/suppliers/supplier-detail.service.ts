/**
 * Fiche fournisseur — lecture seule, bornée au compte actif.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MÊMES RÈGLES D'ACCÈS QUE LES BIENS
 *
 * Un fournisseur appartient à un compte (`suppliers.account_id`). La fiche
 * n'est rendue que pour le compte actif de la session ; un identifiant d'un
 * autre compte est traité comme INEXISTANT (404), sans rien révéler.
 *
 * Les liens (documents, biens, équipements, échéances) passent par des tables
 * de jonction sans colonne de compte : chaque objet lié est donc RE-FILTRÉ
 * sur le compte actif, jamais déduit du seul fournisseur. Une jonction
 * corrompue qui pointerait vers le document d'un autre compte ne le fait pas
 * apparaître.
 *
 *   · biens supprimés : absents ; archivés ou verrouillés par l'offre :
 *     listés mais non ouvrables (la fiche bien les refuse aussi — 403
 *     ASSET_UNAVAILABLE) ; leurs documents et équipements de même ;
 *   · documents supprimés : absents ;
 *   · équipements archivés : absents ;
 *   · échéances annulées : absentes.
 *
 * Minimisation : l'IBAN n'est jamais rendu par la fiche (seulement « RIB
 * renseigné ») ; sa consultation reste dans le tiroir d'édition.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';

export type SqlRunner = (sql: string, params: unknown[]) => Promise<unknown[]>;

const defaultRunner: SqlRunner = async (sql, params) =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as unknown[];

/** Plafond par section : la fiche n'est pas une liste exhaustive. */
export const SUPPLIER_DETAIL_LIMIT = 50;

export interface SupplierDetail {
  supplier: {
    id: number;
    name: string;
    email: string | null;
    phone: string | null;
    website: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    postalCode: string | null;
    city: string | null;
    country: string | null;
    siren: string | null;
    siret: string | null;
    vatNumber: string | null;
    hasIban: boolean;
    source: string;
    contactStatus: string;
    status: string;
  };
  assets: Array<{ id: number; name: string; category: string | null; city: string | null; available: boolean }>;
  documents: Array<{
    id: number; title: string; documentType: string | null; documentDate: string | null;
    role: string | null; isConfirmed: boolean; assetId: number | null; assetName: string | null; available: boolean;
  }>;
  equipments: Array<{
    id: number; name: string; type: string | null; relationshipType: string | null; isPrimary: boolean;
    assetId: number; assetName: string; available: boolean;
  }>;
  agendaItems: Array<{ id: number; title: string; startDate: string | null; manualStatus: string | null }>;
  openReviewCount: number;
}

/** Bien ouvrable : ni archivé, ni verrouillé par l'offre (règle de la fiche bien). */
const BIEN_DISPONIBLE = (a: string) => `(${a}.status IS DISTINCT FROM 'ARCHIVED' AND coalesce(${a}.lock_state, 'NONE') = 'NONE')`;

const jour = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

/**
 * Fiche d'un fournisseur du compte, ou `null` s'il n'existe pas, est
 * supprimé, ou appartient à un autre compte.
 */
export async function getSupplierDetail(
  accountId: number,
  supplierId: number,
  run: SqlRunner = defaultRunner,
): Promise<SupplierDetail | null> {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) return null;
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0) return null;

  const [s] = (await run(
    `SELECT id, name, email, phone, website, address_line_1 AS "addressLine1", address_line_2 AS "addressLine2",
            postal_code AS "postalCode", city, country, siren, siret, vat_number AS "vatNumber",
            (iban IS NOT NULL AND iban <> '') AS "hasIban", source, contact_status AS "contactStatus", status
       FROM suppliers
      WHERE id = $1 AND account_id = $2 AND status <> 'deleted'`,
    [supplierId, accountId],
  )) as Array<SupplierDetail['supplier']>;
  if (!s) return null;

  const L = SUPPLIER_DETAIL_LIMIT;
  const [documents, assets, equipments, agenda, review] = await Promise.all([
    run(
      `SELECT f.id, coalesce(nullif(f.retained_title, ''), f.original_filename, 'Document') AS title,
              f.document_type AS "documentType", f.document_date AS "documentDate",
              ds.role, ds.is_confirmed AS "isConfirmed", a.id AS "assetId", a.name AS "assetName",
              (a.id IS NULL OR ${BIEN_DISPONIBLE('a')}) AS available
         FROM document_suppliers ds
         JOIN asset_files f ON f.id = ds.document_id AND f.account_id = $2 AND f.deleted_at IS NULL
         LEFT JOIN assets a ON a.id = f.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
        WHERE ds.supplier_id = $1
        ORDER BY f.document_date DESC NULLS LAST, f.id DESC
        LIMIT ${L}`,
      [supplierId, accountId],
    ),
    // Biens : liens explicites, et biens des documents et équipements liés.
    run(
      `SELECT a.id, a.name, a.category, a.city, ${BIEN_DISPONIBLE('a')} AS available
         FROM assets a
        WHERE a.account_id = $2 AND a.deleted_at IS NULL
          AND (
            EXISTS (SELECT 1 FROM asset_suppliers x WHERE x.asset_id = a.id AND x.supplier_id = $1)
            OR EXISTS (SELECT 1 FROM document_suppliers ds JOIN asset_files f ON f.id = ds.document_id
                        WHERE ds.supplier_id = $1 AND f.asset_id = a.id AND f.account_id = $2 AND f.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM equipment_suppliers es JOIN equipments e ON e.id = es.equipment_id
                        WHERE es.supplier_id = $1 AND e.asset_id = a.id AND e.archived_at IS NULL)
          )
        ORDER BY a.name
        LIMIT ${L}`,
      [supplierId, accountId],
    ),
    run(
      `SELECT e.id, e.name, e.type, es.relationship_type AS "relationshipType", es.is_primary AS "isPrimary",
              a.id AS "assetId", a.name AS "assetName", ${BIEN_DISPONIBLE('a')} AS available
         FROM equipment_suppliers es
         JOIN equipments e ON e.id = es.equipment_id AND e.archived_at IS NULL
         JOIN assets a ON a.id = e.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
        WHERE es.supplier_id = $1
        ORDER BY es.is_primary DESC, e.name
        LIMIT ${L}`,
      [supplierId, accountId],
    ),
    // Échéances : rattachées à un document ou à un équipement du fournisseur.
    run(
      `SELECT i.id, i.title, i.start_date AS "startDate", i.manual_status AS "manualStatus"
         FROM agenda_items i
        WHERE i.account_id = $2 AND i.manual_status IS DISTINCT FROM 'annule'
          AND (
            EXISTS (SELECT 1 FROM agenda_file_links fl JOIN document_suppliers ds ON ds.document_id = fl.asset_file_id
                     JOIN asset_files f ON f.id = fl.asset_file_id AND f.account_id = $2 AND f.deleted_at IS NULL
                     WHERE fl.agenda_item_id = i.id AND ds.supplier_id = $1)
            OR EXISTS (SELECT 1 FROM agenda_equipment_links el JOIN equipment_suppliers es ON es.equipment_id = el.equipment_id
                     WHERE el.agenda_item_id = i.id AND es.supplier_id = $1)
          )
        ORDER BY (i.manual_status IS NULL) DESC, i.start_date ASC NULLS LAST, i.id
        LIMIT ${L}`,
      [supplierId, accountId],
    ),
    run(
      `SELECT count(*)::int AS n FROM supplier_review_items
        WHERE supplier_id = $1 AND account_id = $2 AND status = 'open'`,
      [supplierId, accountId],
    ),
  ]);

  return {
    supplier: { ...s, hasIban: Boolean(s.hasIban) },
    documents: (documents as SupplierDetail['documents']).map((d) => ({
      ...d, documentDate: jour(d.documentDate), isConfirmed: Boolean(d.isConfirmed), available: Boolean(d.available),
    })),
    assets: (assets as SupplierDetail['assets']).map((a) => ({ ...a, available: Boolean(a.available) })),
    equipments: (equipments as SupplierDetail['equipments']).map((e) => ({
      ...e, isPrimary: Boolean(e.isPrimary), available: Boolean(e.available),
    })),
    agendaItems: (agenda as SupplierDetail['agendaItems']).map((i) => ({ ...i, startDate: jour(i.startDate) })),
    openReviewCount: Number((review as Array<{ n: number }>)[0]?.n ?? 0),
  };
}
