/**
 * Plafond de coût des RÉARBITRAGES T3 à contexte inchangé (lot 49B — ticket
 * « T3 — Réexaminer systématiquement les À traiter ouverts », conciliation
 * avec le ticket « T3 : exploiter la couche exhaustive T1 », §8 / AC6).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE
 *
 *   · Document AVEC une carte « À traiter » LINK-ASSET ouverte : réexamen
 *     COMPLET à chaque passage T3 (Candidate Builder, déterministe, puis IA si
 *     des candidats demandent un arbitrage) — même empreinte identique
 *     (ticket « À traiter », tests 1, 2, 4, 6).
 *   · Document SANS carte ouverte (balayage, AC6) : empreinte identique →
 *     CONFIRMED_NO_CHANGE, aucun appel.
 *
 * Seul l'appel modèle d'un réexamen à contexte INCHANGÉ est plafonné (comme
 * le niveau M3 du lot 42) ; un contexte modifié n'est jamais retenu ici :
 *   · `T3_OPEN_ACTION_AI_MAX_PER_PASS` (défaut 10, 0 à 100) réarbitrages par
 *     passage et par compte (phase « open actions ») ;
 *   · `T3_OPEN_ACTION_AI_MAX_PER_DAY` (défaut 100, 0 à 2000) appels
 *     `t3_link_ambiguity` du compte sur 24 h glissantes (`ai_usage_event`,
 *     traces de la passerelle) — au-delà, le réarbitrage est REPORTÉ au
 *     passage suivant (carte maintenue, évaluation `AI_DEFERRED`) ;
 *   · plafond mensuel de coût du compte (passerelle, lot 22).
 * Les cartes reportées passent en tête au passage suivant (les plus
 * anciennement évaluées d'abord) : aucune n'est oubliée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { envNumber } from '@/lib/env-number';

export const LINK_AMBIGUITY_OPERATION = 't3_link_ambiguity';

/** Réarbitrages à contexte inchangé par passage et par compte. */
export function rearbitrationsPerPass(): number {
  return Math.min(100, Math.floor(envNumber('T3_OPEN_ACTION_AI_MAX_PER_PASS', 10, { min: 0 })));
}

/** Appels `t3_link_ambiguity` du compte sur 24 h au-delà desquels un réarbitrage à contexte inchangé est reporté. */
export function rearbitrationsPerDay(): number {
  return Math.min(2000, Math.floor(envNumber('T3_OPEN_ACTION_AI_MAX_PER_DAY', 100, { min: 0 })));
}

/** Appels `t3_link_ambiguity` du compte sur 24 h glissantes. Ne lève pas (illisible : plafond considéré atteint). */
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
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Motif d'un réarbitrage reporté (monitoring). */
export type RearbitrationDeferral = 'PASS_CAP' | 'DAY_CAP';

/** Le plafond journalier autorise-t-il un réarbitrage de plus ? */
export async function dailyRearbitrationAllowed(accountId: number): Promise<boolean> {
  return (await linkAmbiguityCallsLastDay(accountId)) < rearbitrationsPerDay();
}
