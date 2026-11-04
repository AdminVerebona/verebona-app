/**
 * Fiche fournisseur — lecture bornée au compte actif (lot 109B : fiche UNIQUE).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MÊMES RÈGLES D'ACCÈS QUE LES BIENS
 *
 * Un fournisseur appartient à un compte (`suppliers.account_id`). La fiche
 * n'est rendue que pour le compte actif de la session ; un identifiant d'un
 * autre compte est traité comme INEXISTANT (404), sans rien révéler.
 *
 * Les liens (documents, biens, équipements, événements d'Agenda) passent par des tables
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
 * Lot 109B :
 *   · PLUS DE PLAFOND SILENCIEUX : chaque section (documents, biens,
 *     équipements) est paginée et porte son TOTAL EXACT, calculé sur le même
 *     périmètre (mêmes jointures, mêmes filtres) que ses lignes ; l'ordre est
 *     stable (identifiant en dernier critère) et les clés primaires des
 *     jonctions garantissent zéro doublon ;
 *   · AUCUN statut global de vérification du fournisseur (notion supprimée) :
 *     la fiche montre les champs renseignés ou absents, et les CONFLITS réels
 *     de coordonnées avec leur preuve (document source) ;
 *   · la fiabilité d'une RELATION reste exposée telle quelle (preuve locale :
 *     `document_suppliers.is_confirmed`, `confidence_score`) — sa suppression
 *     du statut global ne rend aucun rattachement « certain ».
 *
 * Minimisation : l'IBAN n'est jamais rendu par la fiche (seulement « RIB
 * renseigné » et sa forme masquée) ; sa consultation en clair passe par
 * `GET /api/suppliers/[id]/iban` (action volontaire, réponse non mise en cache).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { documentTitleColumnsSql, documentTitleOf } from '@/lib/documents/document-title-source';
import { documentTypeLabelOrNull } from '@/lib/referential/user-facing-labels';
import { listSupplierDocumentsViaOperation, type SupplierViaOperationPage } from './supplier-operation-documents';
import {
  SUPPLIER_SECTION_PAGE_MAX, SUPPLIER_SECTION_PAGE_SIZE, maskIban, type SupplierSection,
} from '@/lib/suppliers/supplier-fiche-config';

export type SqlRunner = (sql: string, params: unknown[]) => Promise<unknown[]>;

const defaultRunner: SqlRunner = async (sql, params) =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as unknown[];

/** Lot 103E : événements rattachés — relation explicite, liste complète (borne de sécurité seulement). */
const AGENDA_LIMIT = 500;

export interface SupplierSectionPage<T> {
  items: T[];
  /** Nombre exact d'objets de la section (même périmètre que les lignes). */
  total: number;
  offset: number;
  limit: number;
  /** Décalage de la page suivante, `null` quand tout est chargé. */
  nextOffset: number | null;
}

export interface SupplierDocumentRow {
  id: number; title: string; documentType: string | null;
  /** Lot 87D : libellé français du Type V2 enregistré (null : masqué) — jamais un code. */
  documentTypeLabel: string | null;
  documentDate: string | null;
  role: string | null;
  /** Preuve LOCALE de la relation document → fournisseur (conservée, lot 109B). */
  isConfirmed: boolean;
  confidenceScore: number | null;
  assetId: number | null; assetName: string | null; available: boolean;
}
export interface SupplierAssetRow { id: number; name: string; category: string | null; city: string | null; available: boolean }
export interface SupplierEquipmentRow {
  id: number; name: string; type: string | null; relationshipType: string | null; isPrimary: boolean;
  assetId: number; assetName: string; available: boolean;
}

/** Conflit de coordonnées OUVERT (deux sources divergentes), avec sa preuve. */
export interface SupplierConflict {
  id: number;
  field: string;
  /** Valeurs affichables : l'IBAN est toujours MASQUÉ. */
  currentValue: string | null;
  detectedValue: string | null;
  /** Vrai pour un champ bancaire : valeurs masquées, « Utiliser » indisponible. */
  masked: boolean;
  /** Document où la valeur a été relevée (du compte, non supprimé), sinon null. */
  source: { documentId: number; title: string; documentDate: string | null } | null;
  createdAt: string | null;
}

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
    /** IBAN masqué (4 premiers / 4 derniers caractères), jamais en clair. */
    ibanMasked: string | null;
    ibanHolderName: string | null;
    source: string;
    status: string;
  };
  assets: SupplierSectionPage<SupplierAssetRow>;
  documents: SupplierSectionPage<SupplierDocumentRow>;
  equipments: SupplierSectionPage<SupplierEquipmentRow>;
  /** Lot 103E : événements rattachés (relation persistante), avec la provenance du lien. */
  agendaItems: Array<{ id: number; title: string; startDate: string | null; manualStatus: string | null; provenance?: string | null }>;
  /** Conflits de coordonnées ouverts, arbitrables depuis la fiche (Garder / Utiliser / Ignorer). */
  conflicts: SupplierConflict[];
  /** Doublon possible à arbitrer (carte « À traiter »), sans statut global. */
  openDeduplicationCount: number;
  /**
   * Documents des événements de référence du fournisseur (VIA_OPERATION),
   * distincts des documents DIRECTS — point d'extension relié au contrat de
   * lecture de 109A (`supplier-operation-documents.ts`) ; `wired: false` tant
   * qu'il ne l'est pas (section masquée).
   */
  documentsViaOperation: SupplierViaOperationPage;
}

/** Bien ouvrable : ni archivé, ni verrouillé par l'offre (règle de la fiche bien). */
const BIEN_DISPONIBLE = (a: string) => `(${a}.status IS DISTINCT FROM 'ARCHIVED' AND coalesce(${a}.lock_state, 'NONE') = 'NONE')`;

const jour = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

/** Page demandée, bornée (offset ≥ 0, 1 ≤ limit ≤ max). */
export function normalizeSectionPage(p: { offset?: unknown; limit?: unknown } = {}): { offset: number; limit: number } {
  const o = Number(p.offset);
  const l = Number(p.limit);
  const offset = Number.isSafeInteger(o) && o > 0 ? o : 0;
  const limit = Number.isSafeInteger(l) && l > 0 ? Math.min(l, SUPPLIER_SECTION_PAGE_MAX) : SUPPLIER_SECTION_PAGE_SIZE;
  return { offset, limit };
}

// ── Périmètre de chaque section : UNE source pour les lignes ET le total ────
// Paramètres : $1 fournisseur, $2 compte (session), $3 limite, $4 décalage.
const SECTION_SQL: Record<SupplierSection, { from: string; select: string; order: string }> = {
  documents: {
    from: `FROM document_suppliers ds
         JOIN asset_files f ON f.id = ds.document_id AND f.account_id = $2 AND f.deleted_at IS NULL
         LEFT JOIN assets a ON a.id = f.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
        WHERE ds.supplier_id = $1`,
    select: `SELECT f.id, ${documentTitleColumnsSql('f')},
              f.document_type AS "documentType", f.document_type_code AS "documentTypeCode", f.document_date AS "documentDate",
              ds.role, ds.is_confirmed AS "isConfirmed", ds.confidence_score AS "confidenceScore",
              a.id AS "assetId", a.name AS "assetName",
              (a.id IS NULL OR ${BIEN_DISPONIBLE('a')}) AS available`,
    order: 'ORDER BY f.document_date DESC NULLS LAST, f.id DESC',
  },
  // Biens : liens explicites, et biens des documents et équipements liés (relations persistées).
  assets: {
    from: `FROM assets a
        WHERE a.account_id = $2 AND a.deleted_at IS NULL
          AND (
            EXISTS (SELECT 1 FROM asset_suppliers x WHERE x.asset_id = a.id AND x.supplier_id = $1)
            OR EXISTS (SELECT 1 FROM document_suppliers ds JOIN asset_files f ON f.id = ds.document_id
                        WHERE ds.supplier_id = $1 AND f.asset_id = a.id AND f.account_id = $2 AND f.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM equipment_suppliers es JOIN equipments e ON e.id = es.equipment_id
                        WHERE es.supplier_id = $1 AND e.asset_id = a.id AND e.archived_at IS NULL)
          )`,
    select: `SELECT a.id, a.name, a.category, a.city, ${BIEN_DISPONIBLE('a')} AS available`,
    order: 'ORDER BY a.name, a.id',
  },
  equipments: {
    from: `FROM equipment_suppliers es
         JOIN equipments e ON e.id = es.equipment_id AND e.archived_at IS NULL
         JOIN assets a ON a.id = e.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
        WHERE es.supplier_id = $1`,
    select: `SELECT e.id, e.name, e.type, es.relationship_type AS "relationshipType", es.is_primary AS "isPrimary",
              a.id AS "assetId", a.name AS "assetName", ${BIEN_DISPONIBLE('a')} AS available`,
    order: 'ORDER BY es.is_primary DESC, e.name, e.id',
  },
};

function mapRow(section: SupplierSection, d: Record<string, unknown>): SupplierDocumentRow | SupplierAssetRow | SupplierEquipmentRow {
  if (section === 'documents') {
    const score = d.confidenceScore == null ? null : Number(d.confidenceScore);
    return {
      // Lot 87D : titre par la règle unique des vues ; Type V2 en libellé français.
      id: Number(d.id), title: documentTitleOf(d), documentType: (d.documentType as string | null) ?? null,
      documentTypeLabel: documentTypeLabelOrNull(d.documentTypeCode as string | null),
      documentDate: jour(d.documentDate as string | null), role: (d.role as string | null) ?? null,
      isConfirmed: Boolean(d.isConfirmed), confidenceScore: Number.isFinite(score) ? score : null,
      assetId: d.assetId == null ? null : Number(d.assetId), assetName: (d.assetName as string | null) ?? null, available: Boolean(d.available),
    };
  }
  if (section === 'assets') {
    return {
      id: Number(d.id), name: String(d.name ?? ''), category: (d.category as string | null) ?? null,
      city: (d.city as string | null) ?? null, available: Boolean(d.available),
    };
  }
  return {
    id: Number(d.id), name: String(d.name ?? ''), type: (d.type as string | null) ?? null,
    relationshipType: (d.relationshipType as string | null) ?? null, isPrimary: Boolean(d.isPrimary),
    assetId: Number(d.assetId), assetName: String(d.assetName ?? ''), available: Boolean(d.available),
  };
}

async function readSection<T>(
  run: SqlRunner, section: SupplierSection, supplierId: number, accountId: number, page: { offset: number; limit: number },
): Promise<SupplierSectionPage<T>> {
  const q = SECTION_SQL[section];
  const [rows, count] = await Promise.all([
    run(`${q.select} ${q.from} ${q.order} LIMIT $3 OFFSET $4`, [supplierId, accountId, page.limit, page.offset]),
    run(`SELECT count(*)::int AS n ${q.from}`, [supplierId, accountId]),
  ]);
  const total = Number((count as Array<{ n: number }>)[0]?.n ?? 0);
  const items = (rows as Array<Record<string, unknown>>).map((r) => mapRow(section, r)) as T[];
  const end = page.offset + items.length;
  return { items, total, offset: page.offset, limit: page.limit, nextOffset: end < total && items.length > 0 ? end : null };
}

async function supplierOfAccount(run: SqlRunner, accountId: number, supplierId: number) {
  const [s] = (await run(
    `SELECT id, name, email, phone, website, address_line_1 AS "addressLine1", address_line_2 AS "addressLine2",
            postal_code AS "postalCode", city, country, siren, siret, vat_number AS "vatNumber",
            iban, iban_holder_name AS "ibanHolderName", source, status
       FROM suppliers
      WHERE id = $1 AND account_id = $2 AND status <> 'deleted'`,
    [supplierId, accountId],
  )) as Array<Record<string, unknown>>;
  return s ?? null;
}

const validIds = (accountId: number, supplierId: number) =>
  Number.isSafeInteger(accountId) && accountId > 0 && Number.isSafeInteger(supplierId) && supplierId > 0;

/**
 * Une page d'une section de la fiche, ou `null` si le fournisseur n'est pas
 * du compte (même réponse qu'un fournisseur inexistant).
 */
export async function listSupplierSection(
  accountId: number,
  supplierId: number,
  section: SupplierSection,
  page: { offset?: unknown; limit?: unknown } = {},
  run: SqlRunner = defaultRunner,
): Promise<SupplierSectionPage<SupplierDocumentRow | SupplierAssetRow | SupplierEquipmentRow> | null> {
  if (!validIds(accountId, supplierId)) return null;
  const [s] = (await run(
    `SELECT id FROM suppliers WHERE id = $1 AND account_id = $2 AND status <> 'deleted'`,
    [supplierId, accountId],
  )) as Array<{ id: number }>;
  if (!s) return null;
  return readSection(run, section, supplierId, accountId, normalizeSectionPage(page));
}

/**
 * Fiche d'un fournisseur du compte, ou `null` s'il n'existe pas, est
 * supprimé, ou appartient à un autre compte. Chaque section rend sa première
 * page et son total exact.
 */
export async function getSupplierDetail(
  accountId: number,
  supplierId: number,
  run: SqlRunner = defaultRunner,
  pageSize: number = SUPPLIER_SECTION_PAGE_SIZE,
): Promise<SupplierDetail | null> {
  if (!validIds(accountId, supplierId)) return null;

  const s = await supplierOfAccount(run, accountId, supplierId);
  if (!s) return null;

  const first = normalizeSectionPage({ offset: 0, limit: pageSize });
  const [documents, assets, equipments, agenda, conflicts, dedup, documentsViaOperation] = await Promise.all([
    readSection<SupplierDocumentRow>(run, 'documents', supplierId, accountId, first),
    readSection<SupplierAssetRow>(run, 'assets', supplierId, accountId, first),
    readSection<SupplierEquipmentRow>(run, 'equipments', supplierId, accountId, first),
    // Lot 103E : événements d'Agenda RATTACHÉS au fournisseur (relation persistante
    // `agenda_item_suppliers`) — passés, à venir et sans date. Plus aucune déduction par
    // voisinage (document ou équipement commun) : le ticket l'interdit.
    run(
      `SELECT i.id, i.title, i.start_date AS "startDate", i.manual_status AS "manualStatus", l.provenance
         FROM agenda_item_suppliers l
         JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $2
        WHERE l.supplier_id = $1 AND l.account_id = $2
        ORDER BY i.start_date DESC NULLS LAST, i.id DESC
        LIMIT ${AGENDA_LIMIT}`,
      [supplierId, accountId],
    ),
    // Conflits de coordonnées OUVERTS, avec le document source (du compte, non supprimé).
    run(
      `SELECT r.id, r.conflicting_field AS "field", r.current_value AS "currentValue", r.detected_value AS "detectedValue",
              r.created_at AS "createdAt", f.id AS "documentId", ${documentTitleColumnsSql('f')}, f.document_date AS "documentDate"
         FROM supplier_review_items r
         LEFT JOIN asset_files f ON f.id = r.document_id AND f.account_id = $2 AND f.deleted_at IS NULL
        WHERE r.supplier_id = $1 AND r.account_id = $2 AND r.status = 'open' AND r.item_type = 'contact_conflict'
        ORDER BY r.created_at DESC NULLS LAST, r.id DESC`,
      [supplierId, accountId],
    ),
    run(
      `SELECT count(*)::int AS n FROM supplier_review_items
        WHERE supplier_id = $1 AND account_id = $2 AND status = 'open' AND item_type = 'deduplication'`,
      [supplierId, accountId],
    ),
    listSupplierDocumentsViaOperation(accountId, supplierId, first),
  ]);

  const iban = (s.iban as string | null) ?? null;
  return {
    supplier: {
      id: Number(s.id), name: String(s.name ?? ''),
      email: (s.email as string | null) ?? null, phone: (s.phone as string | null) ?? null, website: (s.website as string | null) ?? null,
      addressLine1: (s.addressLine1 as string | null) ?? null, addressLine2: (s.addressLine2 as string | null) ?? null,
      postalCode: (s.postalCode as string | null) ?? null, city: (s.city as string | null) ?? null, country: (s.country as string | null) ?? null,
      siren: (s.siren as string | null) ?? null, siret: (s.siret as string | null) ?? null, vatNumber: (s.vatNumber as string | null) ?? null,
      hasIban: !!(iban && iban.trim()),
      ibanMasked: maskIban(iban),
      ibanHolderName: (s.ibanHolderName as string | null) ?? null,
      source: String(s.source ?? 'manual'), status: String(s.status ?? 'active'),
    },
    documents, assets, equipments,
    agendaItems: (agenda as SupplierDetail['agendaItems']).map((i) => ({ ...i, startDate: jour(i.startDate) })),
    conflicts: (conflicts as Array<Record<string, unknown>>).map((c) => {
      const field = String(c.field ?? '');
      const masked = field === 'iban';
      const val = (v: unknown) => (v == null || v === '' ? null : masked ? maskIban(String(v)) : String(v));
      return {
        id: Number(c.id), field, masked,
        currentValue: val(c.currentValue), detectedValue: val(c.detectedValue),
        source: c.documentId == null ? null : { documentId: Number(c.documentId), title: documentTitleOf(c), documentDate: jour(c.documentDate) },
        createdAt: c.createdAt == null ? null : (c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt)),
      };
    }),
    openDeduplicationCount: Number((dedup as Array<{ n: number }>)[0]?.n ?? 0),
    documentsViaOperation,
  };
}
