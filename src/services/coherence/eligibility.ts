/**
 * Éligibilité d'un compte au contrôle de cohérence — lot 82B (arbitrage
 * C-Q10, §3.3).
 *
 * Seuls les comptes ACTIFS et MODIFIABLES reçoivent un traitement : aucun
 * contrôle, même en simple constat, sur un compte suspendu, archivé, en
 * lecture seule (essai de sept jours échu sans souscription, résiliation,
 * impayé, rétractation) ou sans abonnement. La règle est vérifiée au moment
 * de l'EXÉCUTION (parcours d'un compte, puis avant chaque réparation), et
 * pas seulement à la programmation.
 *
 * La règle est celle, unique, du chantier 82A
 * (`src/services/account/processing-eligibility.ts`) : ce module ne fait
 * que la ré-exporter et la traduire en motif de campagne.
 */
import { getAccountProcessingEligibility, type IneligibilityReason } from '@/services/account/processing-eligibility';

export { getAccountProcessingEligibility };
export type { IneligibilityReason, ProcessingEligibility } from '@/services/account/processing-eligibility';

export interface AccountEligibility {
  eligible: boolean;
  /** Motif consigné dans la campagne (`ELIGIBLE` ou motif 82A). */
  reason: 'ELIGIBLE' | IneligibilityReason | 'ELIGIBILITY_UNREADABLE';
}

/** Le compte peut-il recevoir un contrôle (et une réparation) maintenant ? Ne lève pas : en cas d'erreur, NON éligible. */
export async function coherenceAccountEligibility(accountId: number, now: Date = new Date()): Promise<AccountEligibility> {
  try {
    const e = await getAccountProcessingEligibility(accountId, now);
    return e.eligible ? { eligible: true, reason: 'ELIGIBLE' } : { eligible: false, reason: e.reason ?? 'READ_ONLY' };
  } catch (e) {
    console.error(`[coherence] éligibilité du compte ${accountId} illisible — aucun traitement :`, (e as Error).message);
    return { eligible: false, reason: 'ELIGIBILITY_UNREADABLE' };
  }
}
