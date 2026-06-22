/**
 * Currency conversion utilities
 * Handles conversion between euros and cents
 */

/**
 * Convert euros to cents
 * @param euros - Amount in euros (e.g., 100.50)
 * @returns Amount in cents (e.g., 10050)
 */
export function eurosToCents(euros: number | string | null | undefined): number | null {
  if (euros === null || euros === undefined || euros === '') {
    return null;
  }
  
  const amount = typeof euros === 'string' ? parseFloat(euros) : euros;
  
  if (isNaN(amount)) {
    return null;
  }
  
  return Math.round(amount * 100);
}

/**
 * Convert cents to euros
 * @param cents - Amount in cents (e.g., 10050)
 * @returns Amount in euros (e.g., 100.50)
 */
export function centsToEuros(cents: number | null | undefined): number | null {
  if (cents === null || cents === undefined) {
    return null;
  }
  
  return cents / 100;
}

/**
 * Format cents as currency string
 * @param cents - Amount in cents
 * @param locale - Locale for formatting (default: 'fr-FR')
 * @param currency - Currency code (default: 'EUR')
 * @returns Formatted currency string (e.g., "100,50 €")
 */
export function formatCents(
  cents: number | null | undefined,
  locale: string = 'fr-FR',
  currency: string = 'EUR'
): string {
  if (cents === null || cents === undefined) {
    return '-';
  }
  
  const euros = centsToEuros(cents);
  
  if (euros === null) {
    return '-';
  }
  
  return formatCurrency(euros, locale, currency);
}

/**
 * Format a number as currency string
 * @param amount - Amount (e.g., 100.50)
 * @param locale - Locale for formatting (default: 'fr-FR')
 * @param currency - Currency code (default: 'EUR')
 * @returns Formatted currency string (e.g., "100,50 €")
 */
export function formatCurrency(
  amount: number | null | undefined,
  locale: string = 'fr-FR',
  currency: string = 'EUR'
): string {
  if (amount === null || amount === undefined) {
    return '-';
  }
  
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(amount);
}

/**
 * Validate that a value is a valid price in cents
 * @param cents - Value to validate
 * @returns True if valid, false otherwise
 */
export function isValidCents(cents: unknown): cents is number {
  return typeof cents === 'number' && cents >= 0 && Number.isInteger(cents);
}
