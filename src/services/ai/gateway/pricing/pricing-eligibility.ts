/**
 * Éligibilité TARIFAIRE d'un modèle — lot 114 (Trello #770).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE (décision métier #770, remplace l'autorisation « sans tarif » de #412)
 *
 * Un modèle n'est admissible à la sélection, aux épreuves qui consomment des
 * jetons, à la promotion et à une exécution réelle que si Verebona détient un
 * tarif OFFICIEL, vérifié et applicable. Un tarif officiel égal à 0 est
 * VALIDE. Un tarif absent, inconnu, non confirmé ou périmé est BLOQUANT.
 *
 * Un tarif est admissible quand il est servi par le référentiel (ligne non
 * invalidée, en vigueur) ET que sa preuve est l'une des suivantes :
 *   · grille du compte (`billing_api`, vérifiée) ;
 *   · saisie manuelle CONFIRMÉE (`manual`, vérifiée) ;
 *   · page tarifaire officielle Google (`public_catalog`) dont la dernière
 *     lecture validée CONFIRME le modèle (`KNOWN`), ou ne le confirme plus
 *     (`STALE`) depuis moins que le délai de validité des preuves — une panne
 *     de lecture n'efface pas une preuve, mais une preuve ne vaut pas sans fin.
 * Ne sont jamais admissibles : l'amorçage embarqué jamais confirmé par la
 * page, une saisie manuelle non confirmée, un statut `UNKNOWN`, un cache
 * tarifaire illisible (jamais de « fail-open »).
 *
 * Module PUR (aucune lecture) : l'état est injecté. Aucun prix n'est déduit,
 * estimé ni emprunté à un autre modèle.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CachedPrice } from './pricing.repository';

export type PricingIneligibility =
  /** Aucun tarif servi pour ce modèle. */
  | 'ABSENT'
  /** La page officielle ne donne pas de tarif lisible pour ce modèle. */
  | 'UNKNOWN'
  /** Tarif connu, jamais confirmé par une source officielle (amorçage, saisie non confirmée). */
  | 'UNVERIFIED'
  /** Preuve officielle non reconfirmée depuis plus longtemps que le délai de validité. */
  | 'STALE_EXPIRED'
  /** Référentiel tarifaire illisible : statut non établi, donc refus. */
  | 'UNREADABLE';

export const PRICING_INELIGIBILITY_LABELS: Readonly<Record<PricingIneligibility, string>> = {
  ABSENT: 'aucun tarif officiel connu',
  UNKNOWN: 'tarif non lisible sur la page officielle',
  UNVERIFIED: 'tarif non confirmé par une source officielle',
  STALE_EXPIRED: 'preuve tarifaire périmée (non reconfirmée dans le délai de validité)',
  UNREADABLE: 'référentiel tarifaire illisible',
};

/** Motif d'exclusion du référentiel d'éligibilité et code de trace de la passerelle. */
export const PRICING_NOT_VERIFIED = 'PRICING_NOT_VERIFIED';
export const MODEL_PRICING_UNVERIFIED = 'MODEL_PRICING_UNVERIFIED';

/**
 * Délai de validité d'une preuve officielle que la dernière lecture ne
 * confirme plus (`STALE`). À VALIDER PAR LE PO. Réglable sans livraison par la
 * variable `AI_PRICING_PROOF_VALIDITY_DAYS` (entier ≥ 0 ; 0 : une preuve non
 * reconfirmée bloque aussitôt).
 */
export const DEFAULT_PRICING_PROOF_VALIDITY_DAYS = 7;

export function pricingProofValidityDays(env: Record<string, string | undefined> = process.env): number {
  const brut = env.AI_PRICING_PROOF_VALIDITY_DAYS;
  if (brut === undefined || brut.trim() === '') return DEFAULT_PRICING_PROOF_VALIDITY_DAYS;
  const n = Number(brut);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_PRICING_PROOF_VALIDITY_DAYS;
}

export type PricingEligibility =
  | { ok: true; price: CachedPrice }
  | { ok: false; code: PricingIneligibility; label: string };

const refus = (code: PricingIneligibility): PricingEligibility => ({ ok: false, code, label: PRICING_INELIGIBILITY_LABELS[code] });

/** Le tarif servi pour ce modèle est-il une preuve admissible ? (pur, testé) */
export function pricingEligibility(
  price: CachedPrice | null,
  state: { degraded: boolean; loaded: boolean },
  now: Date = new Date(),
  validityDays: number = pricingProofValidityDays(),
): PricingEligibility {
  // Jamais de « fail-open » : statut non lisible → refus.
  if (!state.loaded || state.degraded) return refus('UNREADABLE');
  if (!price) return refus('ABSENT');
  if (!Number.isFinite(price.inputMicros) || !Number.isFinite(price.outputMicros) || price.inputMicros < 0 || price.outputMicros < 0) return refus('UNKNOWN');
  if (price.verified && (price.source === 'billing_api' || price.source === 'manual')) return { ok: true, price };
  if (price.source !== 'public_catalog') return refus('UNVERIFIED');
  // Page officielle : la dernière lecture validée fait foi.
  if (price.pageStatus === 'KNOWN') return { ok: true, price };
  if (price.pageStatus === 'STALE') {
    const depuis = price.staleSince ? price.staleSince.getTime() : NaN;
    if (Number.isFinite(depuis) && now.getTime() - depuis <= validityDays * 86_400_000) return { ok: true, price };
    return refus('STALE_EXPIRED');
  }
  if (price.pageStatus === 'UNKNOWN') return refus('UNKNOWN');
  // Aucun statut : amorçage embarqué jamais confirmé par la page officielle.
  return refus('UNVERIFIED');
}
