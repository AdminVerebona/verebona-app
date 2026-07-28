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
 *   · conversations et messages ........  7 jours
 *   · traces détaillées expurgées ......  30 jours
 *   · logs techniques sans contenu .....  90 jours
 *   · agrégats coût et performance .....  13 mois
 *   · feedback .........................  13 mois
 */
import { pgClient } from '@/db';

export const RETENTION = {
  conversationDays: Number(process.env.VEREBONA_ASSISTANT_HISTORY_DAYS ?? 7),
  detailedTraceDays: Number(process.env.AI_TRACE_DETAILED_RETENTION_DAYS ?? 30),
  technicalLogDays: Number(process.env.AI_TRACE_TECHNICAL_RETENTION_DAYS ?? 90),
  aggregateMonths: Number(process.env.AI_AGGREGATE_RETENTION_MONTHS ?? 13),
  feedbackMonths: Number(process.env.AI_FEEDBACK_RETENTION_MONTHS ?? 13),
} as const;

export interface PurgeReport {
  messagesDeleted: number;
  conversationsDeleted: number;
  tracesRedacted: number;
  technicalLogsDeleted: number;
  feedbackDeleted: number;
  durationMs: number;
}

export async function purgeAssistantData(now = new Date()): Promise<PurgeReport> {
  const startedAt = Date.now();

  // 1. Messages au-delà de la durée de conservation.
  const messages = await deleteWhere(
    'verebona_messages',
    `created_at < NOW() - INTERVAL '${RETENTION.conversationDays} days'`,
  );

  // 2. Conversations vides ou expirées. Après le nettoyage des messages, pour
  //    ne pas laisser de messages orphelins en cas d'interruption.
  const conversations = await deleteWhere(
    'verebona_conversations',
    `(expires_at IS NOT NULL AND expires_at < NOW())
      OR updated_at < NOW() - INTERVAL '${RETENTION.conversationDays} days'`,
  );

  // 3. Traces détaillées : le CONTENU est expurgé, la ligne technique reste.
  //    C'est ce qui permet de conserver 90 jours de mesures sans conserver
  //    90 jours de données personnelles.
  const traces = await execute(
    `UPDATE ai_pipeline_step
        SET output_preview = NULL, error_message = NULL
      WHERE created_at < NOW() - INTERVAL '${RETENTION.detailedTraceDays} days'
        AND (output_preview IS NOT NULL OR error_message IS NOT NULL)`,
  );

  // 4. Logs techniques sans contenu.
  const technical = await deleteWhere(
    'ai_pipeline_step',
    `created_at < NOW() - INTERVAL '${RETENTION.technicalLogDays} days'`,
  );

  // 5. Feedback.
  const feedback = await deleteWhere(
    'verebona_feedback',
    `created_at < NOW() - INTERVAL '${RETENTION.feedbackMonths} months'`,
  ).catch(() => 0);  // table optionnelle selon l'état du déploiement

  return {
    messagesDeleted: messages,
    conversationsDeleted: conversations,
    tracesRedacted: traces,
    technicalLogsDeleted: technical,
    feedbackDeleted: feedback,
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
