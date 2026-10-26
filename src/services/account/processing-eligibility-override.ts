/**
 * Lot 82A — point de remplacement du contrôle d'éligibilité, SANS dépendance
 * (ni base, ni droits) : importé par `src/test/setup.ts` avant que les tests
 * unitaires ne remplacent `@/db` par leurs doubles. Voir
 * `processing-eligibility.ts`.
 */
interface EligibilityOverrideResult {
  eligible: boolean;
  reason: string | null;
}

type EligibilityOverride = (accountId: number, now: Date) => Promise<EligibilityOverrideResult>;

let surcharge: EligibilityOverride | null = null;
const abonnes = new Set<() => void>();

/** TESTS UNITAIRES SEULEMENT. `null` rétablit le contrôle réel. */
export function __setProcessingEligibilityForTests(fn: EligibilityOverride | null): void {
  surcharge = fn;
  for (const f of abonnes) f();
}

/** Remplacement en vigueur (`null` : contrôle réel). */
export function currentEligibilityOverride(): EligibilityOverride | null {
  return surcharge;
}

/** Notifié à chaque remplacement (vidage du cache du module principal). */
export function onEligibilityOverrideChange(f: () => void): void {
  abonnes.add(f);
}
