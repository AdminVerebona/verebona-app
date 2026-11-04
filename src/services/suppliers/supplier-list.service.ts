/**
 * Lot 109B — liste paginée des fournisseurs du compte (`GET /api/suppliers`).
 *
 * Remplace les plafonds silencieux 100 (liste) / 20 (recherche) : chaque
 * réponse porte le TOTAL EXACT du périmètre demandé (compte, statut,
 * recherche) et le décalage de la page suivante. Lignes et total partagent
 * la MÊME clause (une seule source), l'ordre est stable (identifiant en
 * dernier critère) : pas de doublon ni de trou entre deux pages.
 *
 * L'IBAN n'est jamais rendu dans une liste. Aucun statut de vérification.
 */
import { pgClient } from '@/db';
import {
  SUPPLIER_LIST_PAGE_MAX, SUPPLIER_LIST_PAGE_SIZE, SUPPLIER_LIST_SORTS, SUPPLIER_LIST_STATUSES,
  SUPPLIER_SEARCH_MAX_LENGTH, type SupplierListSort, type SupplierListStatus,
} from '@/lib/suppliers/supplier-fiche-config';
import { normalizeName } from './supplier-service';
import type { SqlRunner } from './supplier-detail.service';

const defaultRunner: SqlRunner = async (sql, params) =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as unknown[];

export interface SupplierListRow {
  id: number;
  publicId: string;
  name: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  addressLine1: string | null;
  city: string | null;
  postalCode: string | null;
  siret: string | null;
  vatNumber: string | null;
  source: string;
  status: string;
  scope: string;
  createdAt: string | null;
}

export interface SupplierListQuery {
  search: string | null;
  status: SupplierListStatus;
  sort: SupplierListSort;
  offset: number;
  limit: number;
}

export interface SupplierListPage {
  suppliers: SupplierListRow[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
}

/** Paramètres d'URL → requête bornée (valeurs inconnues : défauts). */
export function parseSupplierListQuery(sp: URLSearchParams): SupplierListQuery {
  const search = (sp.get('search') ?? sp.get('q') ?? '').trim().slice(0, SUPPLIER_SEARCH_MAX_LENGTH) || null;
  const st = sp.get('status');
  const so = sp.get('sort');
  const o = Number(sp.get('offset'));
  const l = Number(sp.get('limit'));
  return {
    search,
    status: (SUPPLIER_LIST_STATUSES as readonly string[]).includes(st ?? '') ? (st as SupplierListStatus) : 'active',
    sort: (SUPPLIER_LIST_SORTS as readonly string[]).includes(so ?? '') ? (so as SupplierListSort) : 'name_asc',
    offset: Number.isSafeInteger(o) && o > 0 ? o : 0,
    limit: Number.isSafeInteger(l) && l > 0 ? Math.min(l, SUPPLIER_LIST_PAGE_MAX) : SUPPLIER_LIST_PAGE_SIZE,
  };
}

/** Motif ILIKE sûr : `%`, `_` et `\` saisis sont des caractères ordinaires. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const ORDER: Record<SupplierListSort, string> = {
  name_asc: 'ORDER BY lower(s.name) ASC, s.id ASC',
  name_desc: 'ORDER BY lower(s.name) DESC, s.id DESC',
  recent: 'ORDER BY s.created_at DESC NULLS LAST, s.id DESC',
};

export async function listSuppliers(
  accountId: number,
  q: SupplierListQuery,
  run: SqlRunner = defaultRunner,
): Promise<SupplierListPage> {
  const params: unknown[] = [accountId, q.status];
  let where = `WHERE s.account_id = $1 AND s.status = $2`;
  if (q.search) {
    params.push(likePattern(q.search));
    // Nom saisi et ville ; nom normalisé (accents, casse, formes juridiques)
    // seulement s'il reste quelque chose à chercher (« % » seul ne vaut pas « tout »).
    const normalise = normalizeName(q.search);
    if (normalise) {
      params.push(likePattern(normalise));
      where += ` AND (s.name ILIKE $3 OR s.normalized_name ILIKE $4 OR s.city ILIKE $3)`;
    } else {
      where += ` AND (s.name ILIKE $3 OR s.city ILIKE $3)`;
    }
  }
  const n = params.length;
  const [rows, count] = await Promise.all([
    run(
      `SELECT s.id, s.public_id AS "publicId", s.name, s.email, s.phone, s.website, s.address_line_1 AS "addressLine1",
              s.city, s.postal_code AS "postalCode", s.siret, s.vat_number AS "vatNumber", s.source, s.status, s.scope,
              s.created_at AS "createdAt"
         FROM suppliers s
         ${where}
         ${ORDER[q.sort]}
         LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...params, q.limit, q.offset],
    ),
    run(`SELECT count(*)::int AS n FROM suppliers s ${where}`, params),
  ]);
  const total = Number((count as Array<{ n: number }>)[0]?.n ?? 0);
  const suppliers = (rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id), publicId: String(r.publicId ?? ''), name: String(r.name ?? ''),
    email: (r.email as string | null) ?? null, phone: (r.phone as string | null) ?? null, website: (r.website as string | null) ?? null,
    addressLine1: (r.addressLine1 as string | null) ?? null, city: (r.city as string | null) ?? null,
    postalCode: (r.postalCode as string | null) ?? null, siret: (r.siret as string | null) ?? null,
    vatNumber: (r.vatNumber as string | null) ?? null, source: String(r.source ?? ''), status: String(r.status ?? ''),
    scope: String(r.scope ?? ''),
    createdAt: r.createdAt == null ? null : (r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt)),
  }));
  const end = q.offset + suppliers.length;
  return { suppliers, total, offset: q.offset, limit: q.limit, nextOffset: end < total && suppliers.length > 0 ? end : null };
}
