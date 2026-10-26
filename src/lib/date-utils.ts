/**
 * Date normalization utilities
 * All dates should be stored in ISO 8601 format
 */

/**
 * Normalize a date to ISO 8601 format (YYYY-MM-DD or full ISO timestamp)
 * @param date - Date to normalize (Date object, string, or timestamp)
 * @returns ISO date string or null
 */
export function normalizeDate(date: Date | string | number | null | undefined): string | null {
  if (date === null || date === undefined || date === '') {
    return null;
  }

  try {
    const dateObj = typeof date === 'string' || typeof date === 'number' 
      ? new Date(date) 
      : date;

    if (isNaN(dateObj.getTime())) {
      return null;
    }

    return dateObj.toISOString();
  } catch {
    return null;
  }
}

/**
 * Normalize a date to ISO date format (YYYY-MM-DD only)
 * @param date - Date to normalize
 * @returns ISO date string (YYYY-MM-DD) or null
 */
export function normalizeDateOnly(date: Date | string | number | null | undefined): string | null {
  if (date === null || date === undefined || date === '') {
    return null;
  }

  try {
    const dateObj = typeof date === 'string' || typeof date === 'number' 
      ? new Date(date) 
      : date;

    if (isNaN(dateObj.getTime())) {
      return null;
    }

    // Return YYYY-MM-DD format
    return dateObj.toISOString().split('T')[0];
  } catch {
    return null;
  }
}
