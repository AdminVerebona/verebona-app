/**
 * Purge des données de l'assistant — CDC Assistant §24.1 et §29.7.
 *
 * ⚠️ CRITÈRE D'ACCEPTATION N°20 : « les tâches de purge sont réellement
 * implémentées ». Le schéma `verebona_*` portait déjà des colonnes `expires_at`,
 * mais AUCUN traitement ne les exploitait : les données annoncées comme purgées
 * ne l'étaient pas. Une durée de conservation qui n'est appliquée par aucun code
 * n'est pas une politique, c'est une intention.
 *
 * Durées imposées par le §29.7 :
 *   · conversations et messages ........  90 jours (décision produit
 *                                         « 3 mois », GAP-16 ; §24.1 : 7 j)
 *   · agrégats coût et performance .....  13 mois
 *   · feedback .........................  13 mois
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 82C — PLUS AUCUNE PERTE PAR ÂGE DES TRACES IA (CDC Pilotage IA V2
 * LOG-06, LOG-09, R65 ; décisions PO n° 01 et 10 du 22/10)
 *
 * Retirés de cette purge : l'expurgation à 30 jours des traces détaillées
 * (`ai_pipeline_step.output_preview` / `error_message`), la suppression des
 * étapes à 90 jours (`AI_LOG_ARCHIVE=off`) et celle des traces d'exécution
 * T2 (`verebona_request_runs`, `verebona_ai_runs`). Les variables
 * `AI_TRACE_DETAILED_RETENTION_DAYS` / `AI_TRACE_TECHNICAL_RETENTION_DAYS`
 * ne sont plus lues. RESTENT : l'historique conversationnel affiché à
 * l'utilisateur (90 j, GAP-16 — comportement utilisateur inchangé ; les
 * échanges avec le modèle restent capturés dans `ai_call_captures`, à
 * soumettre au DPO), le feedback, les indicateurs anonymes et le cache.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import {
  purgeConversationData,
  purgeMessagesWhere,
  type SqlRunner,
} from '@/services/verebona-assistant/core/conversation.service';
import { loadAssistantConfig } from '@/services/verebona-assistant/config/assistant-config';

/** Entier positif lu dans l'environnement ; sinon la valeur du CDC. */
function duree(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : def;
}

export interface RetentionPolicy {
  /** Historique conversationnel — 90 jours (décision produit GAP-16). */
  conversationDays: number;
  /** Agrégats de coût et performance — §29.7 : 13 mois. */
  aggregateMonths: number;
  /** Feedback — §29.7 : 13 mois. */
  feedbackMonths: number;
}

/**
 * Durées lues À CHAQUE purge (et non figées au chargement du module) : un
 * changement de variable prend effet à la purge suivante. L'historique lit
 * EXACTEMENT la même valeur que l'assistant (`historyDays`, défaut 90 j) :
 * l'expiration posée à l'écriture et la purge ne peuvent pas diverger.
 */
export function retentionPolicy(): RetentionPolicy {
  return {
    conversationDays: loadAssistantConfig().historyDays > 0 ? loadAssistantConfig().historyDays : 90,
    aggregateMonths: duree('AI_AGGREGATE_RETENTION_MONTHS', 13),
    feedbackMonths: duree('AI_FEEDBACK_RETENTION_MONTHS', 13),
  };
}

/** Instantané au chargement (compatibilité) ; la purge relit `retentionPolicy()`. */
export const RETENTION: Readonly<RetentionPolicy> = retentionPolicy();

export interface PurgeReport {
  messagesDeleted: number;
  conversationsDeleted: number;
  feedbackDeleted: number;
  /** Événements d'usage anonymes (§32.3, D-J7 : rétention des agrégats, 13 mois). */
  usageEventsDeleted?: number;
  /**
   * Résultats en cache expirés de `ai_operation_idempotency` (réponses modèle,
   * arbitrages T4 TEMPORAL_AMBIGUITY partagés — lot 22) ; clés réservées
   * (`help-corpus:last-valid:`) jamais touchées.
   */
  expiredCacheDeleted?: number;
  durationMs: number;
}

export async function purgeAssistantData(now = new Date()): Promise<PurgeReport> {
  const startedAt = Date.now();
  // D-J1 : durée d'historique administrée dans le BO, relue avant la purge.
  const { refreshAssistantSettings } = await import('@/services/verebona-assistant/config/assistant-settings');
  await refreshAssistantSettings(true);
  const RETENTION = retentionPolicy();

  // 1. Conversations expirées : purge complète (messages, citations,
  //    sources, actions, avis, réponses modèle en cache), sans compter sur
  //    des cascades qui peuvent manquer (tables créées par drizzle push).
  const expired = (await pgClient.unsafe(
    `SELECT id FROM verebona_conversations
      WHERE (expires_at IS NOT NULL AND expires_at < NOW())
         OR updated_at < NOW() - INTERVAL '${RETENTION.conversationDays} days'`,
  )) as unknown as Array<{ id: number }>;
  const purge = await purgeConversationData(pgClient as unknown as SqlRunner, expired.map((r) => r.id));
  const conversations = purge.conversations;

  // 2. Messages au-delà de la durée de conservation dans un fil encore
  //    actif : supprimés avec leurs dépendances.
  const messages = purge.messages + await purgeMessagesWhere(
    pgClient as unknown as SqlRunner,
    `created_at < NOW() - INTERVAL '${RETENTION.conversationDays} days'`,
  );

  // 3 et 4 (expurgation à 30 jours et suppression des étapes IA) : retirées
  //    au lot 82C — aucune perte par âge des traces IA (décision PO n° 10).

  // 5. Feedback.
  const feedback = await deleteWhere(
    'verebona_feedback',
    `created_at < NOW() - INTERVAL '${RETENTION.feedbackMonths} months'`,
  ).catch(() => 0);  // table optionnelle selon l'état du déploiement

  // 6. Traces d'exécution de l'assistant (`verebona_request_runs`,
  //    `verebona_ai_runs`) : plus supprimées à 90 jours depuis le lot 82C
  //    (traces IA T2 conservées, décisions PO n° 01 et 10).

  // 7. Indicateurs d'usage anonymes (§32.3, D-J7) : même rétention que les
  //    agrégats et le feedback (13 mois) ; compteurs du limiteur partagé
  //    (D-J2) au-delà de 10 minutes (le limiteur purge aussi au fil de l'eau).
  const usageEvents = await deleteWhere(
    'verebona_usage_events',
    `created_at < NOW() - INTERVAL '${RETENTION.feedbackMonths} months'`,
  ).catch(() => 0);
  await deleteWhere('verebona_rate_limit_counters', `window_start < NOW() - INTERVAL '10 minutes'`).catch(() => 0);

  // 8. Résultats en cache expirés (lot 22) : jamais relus (`expires_at >
  //    now()` à la lecture), ils n'étaient supprimés par aucune tâche. La
  //    purge épargne les clés réservées (PUB-01, `purgeExpiredIdempotency`).
  const { purgeExpiredIdempotency } = await import('@/services/ai/idempotency/idempotency.service');
  const expiredCache = await purgeExpiredIdempotency().catch(() => 0);

  return {
    messagesDeleted: messages,
    conversationsDeleted: conversations,
    feedbackDeleted: feedback,
    usageEventsDeleted: usageEvents,
    expiredCacheDeleted: expiredCache,
    durationMs: Date.now() - startedAt,
  };
}

async function deleteWhere(table: string, condition: string): Promise<number> {
  return execute(`DELETE FROM ${table} WHERE ${condition}`);
}

async function execute(sql: string): Promise<number> {
  const result = await pgClient.unsafe(sql);
  return (result as unknown as { count?: number }).count ?? 0;
}
