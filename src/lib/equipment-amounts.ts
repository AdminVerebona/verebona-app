/**
 * Montants d'un équipement en CENTIMES (`equipments.purchase_price_cents`,
 * `estimated_value_cents`, colonnes `integer`) — lot 75G (ticket « écarts
 * résiduels 71A », D2).
 *
 *   · absent (`undefined`) : non fourni, rien n'est écrit ;
 *   · `null` : vide ;
 *   · entier ≥ 0 et ≤ 2 147 483 647 : valeur ;
 *   · décimal : refusé en mode STRICT (création), arrondi avec avertissement
 *     en mode `legacy` (modification, compatibilité lot 18) ;
 *   · négatif, non numérique, hors bornes : INVALID.
 */
export const MAX_CENTS = 2_147_483_647;

export function parseEquipmentCents(
  field: string, v: unknown, mode: 'strict' | 'legacy',
): number | null | undefined | 'INVALID' {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_CENTS) return 'INVALID';
  if (Number.isInteger(v)) return v;
  if (mode === 'strict') return 'INVALID';
  console.warn(`[equipments] ${field} décimal (${v}) arrondi au centime entier — attendu : entier en centimes.`);
  return Math.round(v);
}
