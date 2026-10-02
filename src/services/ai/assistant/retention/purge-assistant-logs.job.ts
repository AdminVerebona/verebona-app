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
 *   · traces détaillées expurgées ......  30 jours
 *   · logs techniques sans contenu .....  90 jours
 *   · agrégats coût et performance .....  13 mois
 *   · feedback .........................  13 mois
 */
import { pgClient } from '@/db';
import {
  purgeConversationData,
  purgeMessagesWhere,
  type SqlRunner,
} from '@/services/verebona-assistant/core/conversation.service';
import { loadAssistantConfig } from '@/services/verebona-assistant/config/assistant-config';

/** Entier positif lu dans l'environnement ; sinon la valeur du CDC. */
function jours(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : def;
}

export interface RetentionPolicy {
  /** Historique conversationnel — 90 jours (décision produit GAP-16). */
  conversationDays: number;
  /** Traces détaillées expurgées — §29.7 : 30 jours. */
  detailedTraceDays: number;
  /** Logs techniques sans contenu — §29.7 : 90 jours. */
  technicalLogDays: number;
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
/** Archivage S3 des logs IA actif ? Même lecture que le planificateur quotidien. */
export function logArchiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !['off', 'false', '0'].includes((env.AI_LOG_ARCHIVE ?? '').trim().toLowerCase());
}

export function retentionPolicy(): RetentionPolicy {
  return {
    conversationDays: loadAssistantConfig().historyDays > 0 ? loadAssistantConfig().historyDays : 90,
    detailedTraceDays: jours('AI_TRACE_DETAILED_RETENTION_DAYS', 30),
    technicalLogDays: jours('AI_TRACE_TECHNICAL_RETENTION_DAYS', 90),
    aggregateMonths: jours('AI_AGGREGATE_RETENTION_MONTHS', 13),
    feedbackMonths: jours('AI_FEEDBACK_RETENTION_MONTHS', 13),
  };
}

/** Instantané au chargement (compatibilité) ; la purge relit `retentionPolicy()`. */
export const RETENTION: Readonly<RetentionPolicy> = retentionPolicy();

export interface PurgeReport {
  messagesDeleted: number;
  conversationsDeleted: number;
  tracesRedacted: number;
  technicalLogsDeleted: number;
  feedbackDeleted: number;
  /** Traces de demandes et d'appels modèle de l'assistant (§29.7 : 90 j). */
  assistantRunsDeleted: number;
  /** Événements d'usage anonymes (§32.3, D-J7 : rétention des agrégats, 13 mois). */
  usageEventsDeleted?: number;
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
  //    Quand l'archivage S3 est actif (défaut), c'est LUI qui supprime les
  //    étapes, une fois l'archive déposée et enregistrée (`log-archive.job`).
  //    La purge ne supprime donc rien ici : si l'archivage échoue (S3 absent,
  //    erreur réseau, retard de plus de 14 jours), les lignes restent en base
  //    au lieu d'être perdues. Avec AI_LOG_ARCHIVE=off, l'exploitation a
  //    renoncé à l'archive : la purge applique alors la rétention seule.
  const technical = logArchiveEnabled()
    ? 0
    : await deleteWhere(
      'ai_pipeline_step',
      `created_at < NOW() - INTERVAL '${RETENTION.technicalLogDays} days'`,
    );

  // 5. Feedback.
  const feedback = await deleteWhere(
    'verebona_feedback',
    `created_at < NOW() - INTERVAL '${RETENTION.feedbackMonths} months'`,
  ).catch(() => 0);  // table optionnelle selon l'état du déploiement

  // 6. Traces de l'assistant (§29.7, audit P3) : `verebona_request_runs` et
  //    `verebona_ai_runs` n'étaient jamais purgées. Sans texte de
  //    conversation (seulement identifiants, coûts, versions), elles suivent
  //    la durée des logs techniques. Le mois courant reste toujours lisible
  //    pour le plafond budgétaire mensuel (90 j > 1 mois).
  const assistantRuns =
    await deleteWhere('verebona_request_runs', `created_at < NOW() - INTERVAL '${RETENTION.technicalLogDays} days'`).catch(() => 0)
    + await deleteWhere('verebona_ai_runs', `created_at < NOW() - INTERVAL '${RETENTION.technicalLogDays} days'`).catch(() => 0);

  // 7. Indicateurs d'usage anonymes (§32.3, D-J7) : même rétention que les
  //    agrégats et le feedback (13 mois) ; compteurs du limiteur partagé
  //    (D-J2) au-delà de 10 minutes (le limiteur purge aussi au fil de l'eau).
  const usageEvents = await deleteWhere(
    'verebona_usage_events',
    `created_at < NOW() - INTERVAL '${RETENTION.feedbackMonths} months'`,
  ).catch(() => 0);
  await deleteWhere('verebona_rate_limit_counters', `window_start < NOW() - INTERVAL '10 minutes'`).catch(() => 0);

  return {
    messagesDeleted: messages,
    conversationsDeleted: conversations,
    tracesRedacted: traces,
    technicalLogsDeleted: technical,
    feedbackDeleted: feedback,
    assistantRunsDeleted: assistantRuns,
    usageEventsDeleted: usageEvents,
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
