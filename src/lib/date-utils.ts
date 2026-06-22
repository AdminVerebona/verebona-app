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

/**
 * Validate ISO 8601 date format
 * @param dateString - String to validate
 * @returns True if valid ISO date
 */
export function isValidISODate(dateString: string): boolean {
  if (!dateString) return false;
  
  const date = new Date(dateString);
  return !isNaN(date.getTime()) && dateString === date.toISOString().split('T')[0];
}

/**
 * Validate ISO 8601 timestamp format
 * @param timestampString - String to validate
 * @returns True if valid ISO timestamp
 */
export function isValidISOTimestamp(timestampString: string): boolean {
  if (!timestampString) return false;
  
  const date = new Date(timestampString);
  return !isNaN(date.getTime());
}

/**
 * Format date for display
 * @param date - Date to format
 * @param locale - Locale for formatting (default: 'fr-FR')
 * @returns Formatted date string
 */
export function formatDate(
  date: Date | string | null | undefined,
  locale: string = 'fr-FR'
): string {
  if (!date) return '-';
  
  try {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    
    if (isNaN(dateObj.getTime())) {
      return '-';
    }
    
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(dateObj);
  } catch {
    return '-';
  }
}

/**
 * Format timestamp for display (date + time)
 * @param timestamp - Timestamp to format
 * @param locale - Locale for formatting (default: 'fr-FR')
 * @returns Formatted timestamp string
 */
export function formatTimestamp(
  timestamp: Date | string | null | undefined,
  locale: string = 'fr-FR'
): string {
  if (!timestamp) return '-';
  
  try {
    const dateObj = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
    
    if (isNaN(dateObj.getTime())) {
      return '-';
    }
    
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(dateObj);
  } catch {
    return '-';
  }
}
