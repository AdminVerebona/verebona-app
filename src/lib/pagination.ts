/**
 * Pagination Helper - Cursor-based pagination for Verebona API
 * 
 * Implements cursor-based pagination using the ID field for stable pagination.
 * Cursor format: base64-encoded ID of the last item in the current page.
 * 
 * @example
 * const result = await paginateQuery({
 *   query: db.select().from(assets),
 *   limit: 20,
 *   cursor: request.searchParams.get('cursor'),
 *   cursorField: assets.id
 * });
 * 
 * Response format:
 * {
 *   data: [...items],
 *   pagination: {
 *     nextCursor: "eyJpZCI6MTIzfQ==",
 *     hasMore: true,
 *     limit: 20
 *   }
 * }
 */

import { SQL } from 'drizzle-orm';

export interface PaginationParams {
  limit?: number;
  cursor?: string | null;
}

export interface PaginationResult<T> {
  data: T[];
  pagination: {
    nextCursor: string | null;
    hasMore: boolean;
    limit: number;
  };
}

/**
 * Default pagination limit
 */
export const DEFAULT_LIMIT = 20;


/**
 * Encode cursor from ID
 */
export function encodeCursor(id: number): string {
  return Buffer.from(JSON.stringify({ id })).toString('base64');
}

/**
 * Decode cursor to ID
 */
export function decodeCursor(cursor: string): number | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
    return typeof decoded.id === 'number' ? decoded.id : null;
  } catch {
    return null;
  }
}

/**
 * Parse and validate pagination parameters from request
 */
export function parsePaginationParams(searchParams: URLSearchParams): {
  limit: number;
  cursor: string | null;
} {
  const limitParam = searchParams.get('limit');
  const cursorParam = searchParams.get('cursor');

  let limit = DEFAULT_LIMIT;
  if (limitParam) {
    const parsed = parseInt(limitParam);
    if (!isNaN(parsed) && parsed > 0) {
      limit = parsed;
    }
  }

  return {
    limit,
    cursor: cursorParam,
  };
}

/**
 * Build pagination response
 * 
 * Fetches limit + 1 items to determine if there are more pages.
 * Returns only `limit` items with pagination metadata.
 */
export function buildPaginationResponse<T extends { id: number }>(
  items: T[],
  limit: number
): PaginationResult<T> {
  const hasMore = items.length > limit;
  const data = hasMore ? items.slice(0, limit) : items;
  const lastItem = data[data.length - 1];

  return {
    data,
    pagination: {
      nextCursor: hasMore && lastItem ? encodeCursor(lastItem.id) : null,
      hasMore,
      limit,
    },
  };
}

/**
 * Get the starting ID from cursor for WHERE clause
 */
export function getCursorId(cursor: string | null): number | null {
  if (!cursor) return null;
  return decodeCursor(cursor);
}