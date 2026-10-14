/**
 * Réarbitrages T3 des cartes LINK-ASSET ouvertes — lot 49B, RÉVISÉ au lot 54A
 * (ticket « [P1] T3 — Achever le réexamen systématique de tous les À traiter
 * ouverts », écart 1).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE (lot 54A)
 *
 * Une carte LINK-ASSET ouverte est un problème ACTIF : à chaque passage T3
 * global du compte, elle est réellement retentée — Candidate Builder,
 * déterministe, puis appel T3 si un arbitrage est nécessaire. AUCUN quota
 * métier T3 ne la fait sauter : les plafonds `T3_OPEN_ACTION_AI_MAX_PER_PASS`
 * et `T3_OPEN_ACTION_AI_MAX_PER_DAY` (lot 49B) sont SUPPRIMÉS (variables
 * d'environnement ignorées) et l'issue `AI_DEFERRED` n'est plus produite.
 *
 * Le coût reste maîtrisé par les mécanismes GLOBAUX de la passerelle :
 * plafond mensuel de coût du compte (lot 22), disponibilité du modèle,
 * retry/backoff de la file, circuit breaker. Un document SANS carte ouverte
 * à contexte inchangé reste confirmé sans IA (AC6, inchangé).
 *
 * Ne subsistent ici que le code d'opération et la mesure de consommation
 * (monitoring).
 * ══════════════════════════════════════════════════════════════════════════
 */
export const LINK_AMBIGUITY_OPERATION = 't3_link_ambiguity';

/** Appels `t3_link_ambiguity` du compte sur 24 h glissantes. Monitoring seulement (lot 54A : plus une condition). Ne lève pas (illisible : -1). */
export async function linkAmbiguityCallsLastDay(accountId: number): Promise<number> {
  try {
    const { pgClient } = await import('@/db');
    const [r] = (await pgClient.unsafe(
      `SELECT count(*)::int AS n FROM ai_usage_event
        WHERE account_id = $1 AND operation_code = $2 AND created_at > now() - interval '24 hours'`,
      [accountId, LINK_AMBIGUITY_OPERATION] as never[],
    )) as unknown as Array<{ n: number }>;
    return Number(r?.n ?? 0);
  } catch (e) {
    console.error(`[t3-open-actions] consommation IA du compte ${accountId} illisible :`, (e as Error).message);
    return -1;
  }
}

/** Motif d'un réarbitrage reporté par l'ancien plafond (évaluations historiques seulement, lot 49B). */
export type RearbitrationDeferral = 'PASS_CAP' | 'DAY_CAP';
