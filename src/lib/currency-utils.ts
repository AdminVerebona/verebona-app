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
