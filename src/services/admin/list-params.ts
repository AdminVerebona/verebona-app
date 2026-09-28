/**
 * Paramètres de liste du back-office — pagination classique et tri
 * (CDC Back-Office V1 GEN-004, UX-004). Pur : utilisable côté serveur et
 * dans les tests.
 */

export const ADMIN_PAGE_SIZE = 25;

export interface ListParams<K extends string> {
  q: string;
  sort: K;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

/** Lit `q`, `sort`, `dir`, `page` ; toute valeur hors liste blanche retombe sur le défaut. */
export function parseListParams<K extends string>(
  sp: URLSearchParams,
  allowedSorts: readonly K[],
  defaults: { sort: K; dir: 'asc' | 'desc' },
  pageSize = ADMIN_PAGE_SIZE,
): ListParams<K> {
  const rawSort = sp.get('sort') as K | null;
  const sort = rawSort && allowedSorts.includes(rawSort) ? rawSort : defaults.sort;
  const rawDir = sp.get('dir');
  const dir = rawDir === 'asc' || rawDir === 'desc' ? rawDir : defaults.dir;
  const page = Math.max(1, Math.floor(Number(sp.get('page')) || 1));
  const q = (sp.get('q') ?? sp.get('search') ?? '').trim().slice(0, 200);
  return { q, sort, dir, page, pageSize };
}

/** Motif ILIKE « contient », jokers de l'utilisateur neutralisés. */
export function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export interface PageResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Pagination classique en mémoire ; la page est bornée à [1, totalPages]. */
export function paginateRows<T>(rows: T[], page: number, pageSize: number): PageResult<T> {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  return { items: rows.slice((current - 1) * pageSize, current * pageSize), page: current, pageSize, total, totalPages };
}

type Comparable = string | number | Date | null | undefined;

/**
 * Tri stable ; les valeurs absentes sont toujours en fin de liste, quel que
 * soit le sens. Les chaînes sont comparées en français, sans casse.
 */
export function sortRows<T>(rows: T[], get: (row: T) => Comparable, dir: 'asc' | 'desc'): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  const norm = (v: Comparable): string | number | null => {
    if (v == null || v === '') return null;
    if (v instanceof Date) return v.getTime();
    return v;
  };
  return rows
    .map((row, i) => ({ row, i, v: norm(get(row)) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      let c: number;
      if (typeof a.v === 'number' && typeof b.v === 'number') c = a.v - b.v;
      else c = String(a.v).localeCompare(String(b.v), 'fr', { sensitivity: 'base' });
      return c === 0 ? a.i - b.i : c * sign;
    })
    .map((x) => x.row);
}
