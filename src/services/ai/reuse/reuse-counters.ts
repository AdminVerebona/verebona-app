/**
 * Compteurs DISTINCTS d'usage de l'IA — lot 99A (ticket P1 T3, point D).
 *
 * Un appel RÉEL au fournisseur est tracé par `ai_usage_event` (coût, jetons,
 * modèle) : c'est la seule source des « appels IA » et des coûts. Tout ce qui
 * répond SANS appel facturé est compté ici, par jour (Paris), compte,
 * traitement, opération et nature (`ai_reuse_counters`, migration 0858) :
 *
 *   PROVIDER_CACHE_HIT     réponse du cache temporaire des réponses modèle ;
 *   CONCURRENT_SHARED      demande identique simultanée : réponse partagée ;
 *   CACHE_RENEWED          entrée de cache expirée remplacée (après un appel réel) ;
 *   DECISION_REUSED        décision T3 mémorisée réutilisée sans appel ;
 *   DECISION_REEVALUATED   contexte changé : décision réévaluée ;
 *   DECISION_FORCED        relance forcée explicitement tracée ;
 *   USER_ARBITRATION_KEPT  arbitrage déjà tranché par l'utilisateur : aucun appel.
 *
 * Écriture best-effort : jamais bloquante, jamais une cause d'échec du
 * traitement (table absente → rien n'est compté, un avertissement unique).
 */
import { pgClient } from '@/db';
import { noteAiDecisionReuse } from '../measure/ai-activity';

export const REUSE_KINDS = [
  'PROVIDER_CACHE_HIT', 'CONCURRENT_SHARED', 'CACHE_RENEWED',
  'DECISION_REUSED', 'DECISION_REEVALUATED', 'DECISION_FORCED', 'USER_ARBITRATION_KEPT',
] as const;
export type ReuseKind = (typeof REUSE_KINDS)[number];

/** Libellés BO / exports (français simple). */
export const REUSE_KIND_LABELS: Record<ReuseKind, string> = {
  PROVIDER_CACHE_HIT: 'Réponses servies par le cache (sans appel)',
  CONCURRENT_SHARED: 'Demandes simultanées partagées (sans second appel)',
  CACHE_RENEWED: 'Entrées de cache expirées renouvelées',
  DECISION_REUSED: 'Décisions réutilisées (sans appel)',
  DECISION_REEVALUATED: 'Décisions réévaluées (contexte changé)',
  DECISION_FORCED: 'Relances forcées',
  USER_ARBITRATION_KEPT: 'Arbitrages utilisateur conservés (sans appel)',
};

/** Natures qui valent « réponse cache » dans les synthèses (aucun appel facturé). */
export const CACHE_KINDS: readonly ReuseKind[] = ['PROVIDER_CACHE_HIT', 'CONCURRENT_SHARED'];
/** Natures qui valent « décision métier réutilisée » (aucun appel). */
export const REUSED_DECISION_KINDS: readonly ReuseKind[] = ['DECISION_REUSED', 'USER_ARBITRATION_KEPT'];

export interface ReuseEvent {
  kind: ReuseKind;
  accountId?: number | null;
  treatment?: string | null;
  operationCode?: string | null;
  /** Nombre d'occurrences (défaut 1). */
  count?: number;
  /**
   * Carte #811 : l'appelant a déjà porté cette réutilisation dans la mesure de
   * l'exécution (`noteAiDecisionReuse`, appel synchrone) — elle n'y est pas
   * portée une seconde fois ici.
   */
  activityNoted?: boolean;
}

let absente = false;

/** Compte un événement de réutilisation. Ne lève JAMAIS. */
export async function noteReuse(e: ReuseEvent): Promise<void> {
  const n = Math.max(0, Math.floor(e.count ?? 1));
  // Carte #811 (P1-A) : décision réutilisée portée dans la mesure de l'exécution en cours — AVANT toute attente,
  // et même si la table des compteurs est absente (la mesure du passage ne dépend pas de la migration 0858).
  if (n > 0 && !e.activityNoted && (e.kind === 'DECISION_REUSED' || e.kind === 'USER_ARBITRATION_KEPT')) {
    noteAiDecisionReuse({ kind: e.kind, operationCode: e.operationCode ?? null, treatment: e.treatment ?? null, count: n });
  }
  if (n === 0 || absente) return;
  try {
    await pgClient.unsafe(
      `INSERT INTO ai_reuse_counters (day, account_id, treatment, operation_code, kind, count, last_at)
       VALUES ((now() AT TIME ZONE 'Europe/Paris')::date, $1, $2, $3, $4, $5, now())
       ON CONFLICT (day, (COALESCE(account_id, 0)), treatment, operation_code, kind)
       DO UPDATE SET count = ai_reuse_counters.count + EXCLUDED.count, last_at = now()`,
      [e.accountId ?? null, e.treatment ?? '', e.operationCode ?? '', e.kind, n] as never[],
    );
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === '42P01') {
      absente = true;
      console.warn('[ai-reuse] table ai_reuse_counters absente (migration 0858) : réutilisations non comptées.');
      return;
    }
    // Compte supprimé entre-temps (FK) ou base indisponible : jamais bloquant.
    if (code !== '23503') console.error('[ai-reuse] compteur non écrit (non bloquant) :', (err as Error)?.message);
  }
}

/** Réinitialise l'état « table absente » (tests). */
export function __resetReuseCountersForTests(): void { absente = false; }

export interface ReuseTotals {
  /** Par nature, sur la période. */
  byKind: Record<ReuseKind, number>;
  /** Réponses sans appel servies par le cache (cache + demandes partagées). */
  cacheResponses: number;
  /** Décisions métier réutilisées (mémoire T3 + arbitrages utilisateur conservés). */
  decisionsReused: number;
}

/** Totaux pure (lignes déjà lues). */
export function reuseTotals(rows: ReadonlyArray<{ kind: string; count: number | string }>): ReuseTotals {
  const byKind = Object.fromEntries(REUSE_KINDS.map((k) => [k, 0])) as Record<ReuseKind, number>;
  for (const r of rows) if ((REUSE_KINDS as readonly string[]).includes(r.kind)) byKind[r.kind as ReuseKind] += Number(r.count) || 0;
  return {
    byKind,
    cacheResponses: CACHE_KINDS.reduce((s, k) => s + byKind[k], 0),
    decisionsReused: REUSED_DECISION_KINDS.reduce((s, k) => s + byKind[k], 0),
  };
}

/**
 * Totaux d'une période (jours de Paris, bornes incluses), filtrables par
 * traitement et compte. Table absente → totaux à zéro avec `available: false`.
 */
export async function readReuseTotals(p: {
  fromDay: string; toDay: string; treatment?: string | null; accountId?: number | null;
}): Promise<ReuseTotals & { available: boolean; byTreatment: Record<string, ReuseTotals> }> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT treatment, kind, sum(count)::bigint AS count FROM ai_reuse_counters
        WHERE day BETWEEN $1::date AND $2::date
          AND ($3::text IS NULL OR treatment = $3) AND ($4::int IS NULL OR account_id = $4)
        GROUP BY treatment, kind`,
      [p.fromDay, p.toDay, p.treatment ?? null, p.accountId ?? null] as never[],
    )) as unknown as Array<{ treatment: string; kind: string; count: string }>;
    const parTraitement = new Map<string, Array<{ kind: string; count: string }>>();
    for (const r of rows) parTraitement.set(r.treatment, [...(parTraitement.get(r.treatment) ?? []), r]);
    return {
      ...reuseTotals(rows), available: true,
      byTreatment: Object.fromEntries([...parTraitement].map(([t, rs]) => [t, reuseTotals(rs)])),
    };
  } catch (e) {
    if ((e as { code?: string })?.code !== '42P01') throw e;
    return { ...reuseTotals([]), available: false, byTreatment: {} };
  }
}

export interface TreatmentAiUsage {
  /**
   * Requêtes RÉELLEMENT émises vers le fournisseur (carte #811) : somme de
   * `ai_usage_event.metadata.networkRequests` ; pour un événement ANTÉRIEUR à
   * cette mesure, une requête est comptée seulement si une réponse ou une
   * consommation la prouve (sinon : `providerCallsUndetermined`).
   */
  providerCalls: number;
  /** Réponses servies sans appel (cache, demandes simultanées partagées). */
  cacheResponses: number;
  /** Décisions réutilisées sans appel (mémoire T3, arbitrages utilisateur conservés). */
  decisionsReused: number;
  /** Carte #811 : événements d'usage écrits (lignes `ai_usage_event`) — pas un nombre d'appels. */
  usageEvents?: number;
  /** Carte #811 : dont événements SANS requête émise (refus avant appel, rang non sollicité). */
  usageEventsWithoutSend?: number;
  /** Carte #811 : événements anciens dont on ne peut pas prouver qu'une requête est partie (ni compté, ni exclu). */
  providerCallsUndetermined?: number;
}

/**
 * Lot 99A — usage de l'IA par traitement sur une période (instants), en
 * compteurs DISTINCTS : synthèse du Journal complet et diagnostic. Lecture
 * seule ; une table absente donne des zéros (`available` du cache à faux).
 *
 * Carte #811 (P1-A) : un événement d'usage n'est PAS un appel — un rang non
 * sollicité ou un refus avant appel écrit aussi une ligne, et une tentative
 * peut émettre plusieurs requêtes. `providerCalls` vient de la mesure figée
 * avec chaque événement ; l'historique sans mesure n'est jamais reconstruit.
 */
export async function readAiUsageByTreatment(p: {
  from: Date; to: Date; treatment?: string | null; accountId?: number | null;
}): Promise<{ available: boolean; byTreatment: Record<string, TreatmentAiUsage> }> {
  const { treatmentOfUseCase } = await import('../config/treatments');
  const appels = (await pgClient.unsafe(
    `SELECT use_case_code, count(*)::bigint AS n,
            coalesce(sum((metadata->>'networkRequests')::int) FILTER (WHERE metadata ? 'networkRequests'), 0)::bigint AS mesurees,
            count(*) FILTER (WHERE metadata ? 'networkRequests' AND (metadata->>'networkRequests')::int = 0)::bigint AS sans_envoi,
            count(*) FILTER (WHERE NOT (metadata ? 'networkRequests')
                               AND (status = 'success' OR coalesce(input_tokens, 0) + coalesce(output_tokens, 0) > 0))::bigint AS anciennes_prouvees,
            count(*) FILTER (WHERE NOT (metadata ? 'networkRequests')
                               AND NOT (status = 'success' OR coalesce(input_tokens, 0) + coalesce(output_tokens, 0) > 0))::bigint AS anciennes_indeterminees
       FROM ai_usage_event
      WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz AND ($3::int IS NULL OR account_id = $3)
      GROUP BY use_case_code`,
    [p.from.toISOString(), p.to.toISOString(), p.accountId ?? null] as never[],
  )) as unknown as Array<{ use_case_code: string | null; n: string; mesurees: string; sans_envoi: string; anciennes_prouvees: string; anciennes_indeterminees: string }>;
  const out: Record<string, TreatmentAiUsage> = {};
  const de = (t: string) => (out[t] ??= { providerCalls: 0, cacheResponses: 0, decisionsReused: 0, usageEvents: 0, usageEventsWithoutSend: 0, providerCallsUndetermined: 0 });
  const N = (v: unknown) => Number(v) || 0;
  for (const r of appels) {
    let t: string | null = null;
    try { t = r.use_case_code ? treatmentOfUseCase(r.use_case_code as never) : null; } catch { t = null; }
    if (t && (!p.treatment || p.treatment === t)) {
      const u = de(t);
      u.providerCalls += N(r.mesurees) + N(r.anciennes_prouvees);
      u.usageEvents = (u.usageEvents ?? 0) + N(r.n);
      u.usageEventsWithoutSend = (u.usageEventsWithoutSend ?? 0) + N(r.sans_envoi);
      u.providerCallsUndetermined = (u.providerCallsUndetermined ?? 0) + N(r.anciennes_indeterminees);
    }
  }
  const jour = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  const reuse = await readReuseTotals({ fromDay: jour(p.from), toDay: jour(p.to), treatment: p.treatment ?? null, accountId: p.accountId ?? null });
  for (const [t, tot] of Object.entries(reuse.byTreatment)) {
    if (!t) continue;
    de(t).cacheResponses += tot.cacheResponses;
    de(t).decisionsReused += tot.decisionsReused;
  }
  return { available: reuse.available, byTreatment: out };
}
