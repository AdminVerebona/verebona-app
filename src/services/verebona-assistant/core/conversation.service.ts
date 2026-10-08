/**
 * Persistance conversationnelle & historique — CDC §24 / §28.
 *
 * Gère la conversation active, les messages, l'idempotence (`client_request_id`),
 * l'historique (90 jours par défaut, décision produit GAP-16 ; VEREBONA_ASSISTANT_HISTORY_DAYS) et l'effacement
 * manuel (§24.5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE CONVERSATION APPARTIENT À UN UTILISATEUR, PAS AU COMPTE
 *
 * Le modèle d'origine (« 1 conversation active par compte, historique
 * partagé Duo ») exposait à B les questions, sources et clarifications de A.
 * Le cloisonnement est désormais porté par la base (migration 0151) :
 * `verebona_conversations.user_id`, idempotence par auteur.
 *
 * PLUSIEURS FILS PAR UTILISATEUR (migration 0152) — la clé fonctionnelle est
 * compte + utilisateur + conversation. Un fil se crée explicitement, se
 * reprend par son identifiant (après rechargement, déconnexion…), et sa
 * mémoire conversationnelle ne se mélange jamais à celle des autres fils. Toute lecture ou écriture de ce service prend les
 * DEUX identifiants — issus de la session serveur, jamais du client.
 *
 * Les données métier du compte (biens, documents) restent partagées : seule
 * la mémoire conversationnelle est privée.
 *
 * ── ÉCART ASSUMÉ AU CDC (décision produit) ────────────────────────────────
 * Le CDC Assistant (§0.14, §6.3, §24.2, §24.3, §28.1, §29.9, CA-12, 37.10)
 * prévoit UNE conversation active par COMPTE, partagée en Duo. La décision
 * produit maintient des conversations PRIVÉES par utilisateur, en plusieurs
 * fils (migrations 0151, 0152) : un membre du Duo ne lit ni les questions ni
 * les sources de l'autre. Ne pas « corriger » vers le CDC sans nouvel
 * arbitrage ; le test `conversations-privees.test.ts` fige ce choix.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Utilise les tables verebona_* (voir migration 0100). Câblé sur `@/db` (postgres.js).
 */
import { timelineColumnReady, timelineForStorage } from './timeline-persistence';
import { pgClient } from '@/db';
import { CANONICAL_FIELDS } from '@/services/canonical/registry';
import type { AssistantRunResult, AssistantRequestInput } from '../types/contracts';
import { getAssistantConfig } from '../config/assistant-config';
import { assistantCachePrefix } from './assistant-cache-key';
import { parseEntityRef } from './entity-ref';
import { INTENT_CATALOG_VERSION } from '../types/intents';
import { ACTION_CATALOG_VERSION } from '../types/actions';
import type { VerebonaAction } from '../types/actions';
import { RESPONSE_SCHEMA_VERSION } from '../types/contracts';
import type { PresentedEntity, ReferencedType, ThreadContext } from './reference-resolver';
import { awaitAiRuns } from './usage-tracking.service';
import { targetsFromInput } from './assistant-targets';
import { buildT2ObservabilityTrace } from '@/services/ai/telemetry/t2-observability';

const expiresFromNow = () =>
  new Date(Date.now() + getAssistantConfig().historyDays * 86400_000).toISOString();

/** Lot 33 : niveau tracé de chaque étape de la cascade du Centre d'aide. */
const HELP_LEVELS: Readonly<Record<string, string>> = {
  'help.fulltext': 'fulltext',
  'help.expanded': 'expanded',
  'help.understand': 'understand',
  'help.reformulated': 'reformulated',
};

/** Fil de conversation tel que la liste le présente. */
export interface ConversationThread {
  id: number;
  title: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  messageCount: number;
  /**
   * Début de la dernière réponse de l'assistant (160 caractères), pour le
   * résumé des « Demandes précédentes » (Direction D v2 §8).
   */
  lastAnswer: string | null;
}

/** Conversation introuvable pour cet utilisateur (inexistante, d'un autre, effacée ou expirée). */
export class ConversationNotFoundError extends Error {
  readonly code = 'CONVERSATION_NOT_FOUND';
  constructor() { super('CONVERSATION_NOT_FOUND'); }
}

/** Crée explicitement un nouveau fil, sans rien hériter des autres. */
export async function createConversation(accountId: number, userId: number, locale: string): Promise<number> {
  const rows = await pgClient.unsafe(
    `INSERT INTO verebona_conversations (account_id, user_id, status, machine_state, locale, expires_at)
     VALUES ($1, $2, 'active', 'IDLE', $3, $4)
     RETURNING id`,
    [accountId, userId, locale, expiresFromNow()],
  );
  return (rows as unknown as Array<{ id: number }>)[0].id;
}

/**
 * Le fil appartient-il à cet utilisateur, dans ce compte, et est-il encore
 * consultable ? Rend son identifiant, ou `null` — sans distinguer « n'existe
 * pas » de « appartient à un autre », pour ne rien révéler.
 */
export async function findOwnedConversation(
  accountId: number,
  userId: number,
  conversationId: number,
): Promise<number | null> {
  if (!Number.isInteger(conversationId) || conversationId <= 0) return null;
  const rows = await pgClient.unsafe(
    `SELECT id FROM verebona_conversations
      WHERE id = $1 AND account_id = $2 AND user_id = $3
        AND status = 'active' AND expires_at > now()
      LIMIT 1`,
    [conversationId, accountId, userId],
  );
  return (rows as unknown as Array<{ id: number }>)[0]?.id ?? null;
}

/** Fil le plus récent de l'utilisateur, s'il en a un. */
export async function findLatestConversation(accountId: number, userId: number): Promise<number | null> {
  const rows = await pgClient.unsafe(
    `SELECT id FROM verebona_conversations
      WHERE account_id = $1 AND user_id = $2 AND status = 'active' AND expires_at > now()
      ORDER BY COALESCE(last_message_at, created_at) DESC, id DESC
      LIMIT 1`,
    [accountId, userId],
  );
  return (rows as unknown as Array<{ id: number }>)[0]?.id ?? null;
}

/**
 * Récupère le fil le plus récent de l'utilisateur, ou en crée un.
 *
 * Plus d'unicité « une conversation par compte / utilisateur » : un verrou
 * transactionnel propre au couple (compte, utilisateur) évite que deux
 * premières questions simultanées ouvrent deux fils.
 */
export async function getOrCreateActiveConversation(
  accountId: number,
  userId: number,
  locale: string,
): Promise<number> {
  return pgClient.begin(async (tx) => {
    await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('verebona_conv:' || $1 || ':' || $2))`, [accountId, userId]);
    const rows = (await tx.unsafe(
      `SELECT id FROM verebona_conversations
        WHERE account_id = $1 AND user_id = $2 AND status = 'active' AND expires_at > now()
        ORDER BY COALESCE(last_message_at, created_at) DESC, id DESC
        LIMIT 1`,
      [accountId, userId],
    )) as unknown as Array<{ id: number }>;
    if (rows[0]) return rows[0].id;
    const created = (await tx.unsafe(
      `INSERT INTO verebona_conversations (account_id, user_id, status, machine_state, locale, expires_at)
       VALUES ($1, $2, 'active', 'IDLE', $3, $4) RETURNING id`,
      [accountId, userId, locale, expiresFromNow()],
    )) as unknown as Array<{ id: number }>;
    return created[0].id;
  }) as Promise<number>;
}

/**
 * Fil dans lequel une demande s'inscrit.
 *
 *   · identifiant fourni → il doit appartenir à l'utilisateur, sinon
 *     `ConversationNotFoundError` (jamais de repli silencieux vers un autre
 *     fil : la question partirait dans le mauvais contexte) ;
 *   · aucun identifiant → fil le plus récent, créé au besoin.
 */
export async function resolveConversation(
  accountId: number,
  userId: number,
  locale: string,
  requested?: number | null,
): Promise<number> {
  if (requested != null) {
    const owned = await findOwnedConversation(accountId, userId, requested);
    if (!owned) throw new ConversationNotFoundError();
    return owned;
  }
  return getOrCreateActiveConversation(accountId, userId, locale);
}

/** Fils de l'utilisateur, du plus récent au plus ancien. */
export async function listConversations(accountId: number, userId: number): Promise<ConversationThread[]> {
  const rows = (await pgClient.unsafe(
    `SELECT c.id, c.title, c.created_at, c.last_message_at,
            (SELECT count(*)::int FROM verebona_messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT left(m.content, 160) FROM verebona_messages m
              WHERE m.conversation_id = c.id AND m.account_id = c.account_id
                AND m.role = 'assistant' AND m.expires_at > now()
              ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_answer
       FROM verebona_conversations c
      WHERE c.account_id = $1 AND c.user_id = $2 AND c.status = 'active' AND c.expires_at > now()
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
      LIMIT 50`,
    [accountId, userId],
  )) as unknown as Array<{ id: number; title: string | null; created_at: Date; last_message_at: Date | null; message_count: number; last_answer: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: new Date(r.created_at).toISOString(),
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
    messageCount: r.message_count,
    lastAnswer: r.last_answer ?? null,
  }));
}

/**
 * Idempotence : renvoie la question existante si `client_request_id` déjà vu
 * POUR CET UTILISATEUR (§31.9). Le même identifiant rejoué par un autre
 * membre du compte ne retrouve rien.
 */
export async function findByClientRequestId(
  accountId: number,
  userId: number,
  clientRequestId: string,
): Promise<number | null> {
  const rows = await pgClient.unsafe(
    `SELECT m.id
       FROM verebona_messages m
       JOIN verebona_conversations c ON c.id = m.conversation_id
      WHERE m.account_id = $1 AND m.author_user_id = $2 AND m.client_request_id = $3
        AND c.user_id = $2 AND c.status = 'active'
      LIMIT 1`,
    [accountId, userId, clientRequestId],
  );
  const list = rows as unknown as Array<{ id: number }>;
  return list.length ? list[0].id : null;
}

/** Réponse déjà rendue pour une demande rejouée (même clientRequestId). */
export interface ReplayedAnswer {
  conversationId: number;
  messageId: number;
  requestId: string;
  content: string;
  intent: string | null;
  mode: string | null;
  /** Rejeu fidèle (§31.9, CA-29) : mêmes sources et mêmes actions. */
  sourceCount: number;
  actions: Array<{ actionId: string; type: string; label: string; href: string | null; requiresConfirmation: boolean; expiresAt: string | null; analyticsCode: string }>;
}

export async function findReplayedAnswer(
  accountId: number,
  userId: number,
  clientRequestId: string,
): Promise<ReplayedAnswer | null> {
  const rows = await pgClient.unsafe(
    `SELECT a.id, a.conversation_id, a.request_id, a.content, a.intent, a.mode
       FROM verebona_messages q
       JOIN verebona_conversations c ON c.id = q.conversation_id
       JOIN verebona_messages a ON a.conversation_id = q.conversation_id
                               AND a.request_id = q.request_id AND a.role = 'assistant'
      WHERE q.account_id = $1 AND q.author_user_id = $2 AND q.client_request_id = $3
        AND q.role = 'user' AND c.user_id = $2 AND c.status = 'active'
        AND q.created_at > now() - ($4::int * interval '1 second')
      LIMIT 1`,
    // §43 IDEMPOTENCY_TTL_SECONDS : le rejeu n'est servi que dans la fenêtre
    // d'idempotence (900 s par défaut). Au-delà, l'identifiant est périmé :
    // la réservation le refuse (« déjà traitée ») sans relancer le pipeline.
    [accountId, userId, clientRequestId, Math.max(1, Math.floor(getAssistantConfig().idempotencyTtlSeconds))],
  );
  const r = (rows as unknown as Array<{ id: number; conversation_id: number; request_id: string; content: string | null; intent: string | null; mode: string | null }>)[0];
  if (!r) return null;
  // Le rejeu rendait `sourcesAvailable: false` et `actions: []` : la même
  // demande donnait une réponse appauvrie. Sources et actions sont relues.
  const [src] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM verebona_message_sources WHERE message_id = $1`, [r.id],
  )) as unknown as Array<{ n: number }>;
  const act = (await pgClient.unsafe(
    `SELECT id, action_type, label, resolved_href, requires_confirmation, analytics_code, expires_at
       FROM verebona_message_actions WHERE message_id = $1 ORDER BY id ASC`, [r.id],
  )) as unknown as Array<{ id: number; action_type: string; label: string; resolved_href: string | null; requires_confirmation: boolean; analytics_code: string | null; expires_at: Date | null }>;
  return {
    conversationId: r.conversation_id, messageId: r.id, requestId: r.request_id, content: r.content ?? '',
    intent: r.intent, mode: r.mode,
    sourceCount: src?.n ?? 0,
    actions: act
      .filter((a) => !a.expires_at || new Date(a.expires_at).getTime() > Date.now())
      .map((a) => ({
        actionId: `replay-${a.id}`, type: a.action_type, label: a.label, href: a.resolved_href,
        requiresConfirmation: Boolean(a.requires_confirmation), expiresAt: a.expires_at ? new Date(a.expires_at).toISOString() : null,
        analyticsCode: a.analytics_code ?? `verebona.action.${a.action_type.toLowerCase()}`,
      })),
  };
}

/**
 * Historique d'UN fil : uniquement s'il appartient à l'utilisateur, est
 * actif et non expiré. C'est aussi la seule mémoire conversationnelle
 * autorisée pour ce fil — rien n'est lu dans les autres.
 *
 * §27.6 — pagination par curseur : les `limit` messages les plus récents
 * (50 au plus), antérieurs au curseur `before` s'il est fourni, rendus dans
 * l'ordre chronologique. Le curseur est l'identifiant du plus ancien message
 * déjà affiché (`nextCursor`) : stable même si deux messages partagent la
 * même date.
 */
export const HISTORY_PAGE_MAX = 50;

export interface HistoryPageOptions {
  limit?: number;
  /** Identifiant de message : seuls les messages plus anciens sont rendus. */
  before?: number | null;
}

export async function listActiveMessages(
  accountId: number,
  userId: number,
  conversationId: number,
  options: HistoryPageOptions = {},
) {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? HISTORY_PAGE_MAX), 1), HISTORY_PAGE_MAX);
  const before = options.before != null && Number.isInteger(options.before) && options.before > 0 ? options.before : null;
  // R1 (0228) : chronologie relue si la colonne existe.
  const chronologie = (await timelineColumnReady()) ? 'm.timeline_events_json' : 'NULL::jsonb AS timeline_events_json';
  // Un message de plus que la page : il dit s'il reste des messages plus anciens.
  const rows = (await pgClient.unsafe(
    `SELECT * FROM (
       SELECT m.id, m.role, m.content, m.intent, m.mode, m.created_at, m.result_groups_json, ${chronologie},
              (SELECT count(*)::int FROM verebona_message_sources s WHERE s.message_id = m.id) AS source_count
         FROM verebona_messages m
         JOIN verebona_conversations c ON c.id = m.conversation_id
        WHERE c.id = $3 AND c.account_id = $1 AND c.user_id = $2 AND c.status = 'active'
          AND m.account_id = $1 AND m.expires_at > now() AND c.expires_at > now()
          AND ($5::int IS NULL OR (m.created_at, m.id) < (SELECT created_at, id FROM verebona_messages WHERE id = $5 AND conversation_id = $3))
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $4
     ) page ORDER BY created_at ASC, id ASC`,
    [accountId, userId, conversationId, limit + 1, before],
  )) as unknown as Array<{ id: number } & Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const messages = hasMore ? rows.slice(1) : rows;
  return { messages, nextCursor: hasMore && messages[0] ? messages[0].id : null };
}

/**
 * Condition SQL de propriété d'un message : réutilisée par les routes
 * sources / explication / avis. `m` désigne verebona_messages, `$acc` et
 * `$usr` les paramètres de session.
 */
export const MESSAGE_OWNED_BY_USER = (m: string, acc: string, usr: string) =>
  `EXISTS (SELECT 1 FROM verebona_conversations oc
            WHERE oc.id = ${m}.conversation_id AND oc.account_id = ${acc}
              AND oc.user_id = ${usr} AND oc.status = 'active')`;

/**
 * Trace §18 d'une demande (lot 17) : jamais bloquante — une cible illisible
 * laisse `target` à null, la réponse est déjà rendue.
 */
function t2Observability(result: AssistantRunResult, input: AssistantRequestInput) {
  let target: { type: string; origin: string } | null = null;
  try {
    target = targetsFromInput(input, result.route ?? null).primary;
  } catch {
    target = null;
  }
  return buildT2ObservabilityTrace({ strategy: result.cascade?.strategy, sources: result.sources, target });
}

/**
 * Persiste le résultat complet — CDC §28.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'ASSISTANT N'AVAIT PAS DE MÉMOIRE
 *
 * Cette fonction était un `console.debug`. Les dix tables du §28 existaient
 * en base, vides : aucune conversation ne survivait à un rechargement, aucune
 * citation n'était conservée, aucun retour n'était collecté, et la purge du
 * §31 n'avait rien à purger.
 *
 * Ce n'était pas un détail d'implémentation. La reprise de conversation
 * (§24), la clarification (§20) et l'évaluation de qualité (§35) reposent
 * toutes sur ces enregistrements.
 *
 * ── UNE TRANSACTION, ET UN ORDRE IMPOSÉ ───────────────────────────────────
 *
 * Message, puis citations, puis sources, puis le lien entre les deux, puis
 * actions. Les clés étrangères l'exigent, mais surtout : une réponse dont les
 * citations manqueraient serait pire qu'une réponse absente — l'utilisateur
 * lirait une affirmation sans pouvoir en vérifier l'origine, ce que le §18.5
 * interdit.
 *
 * ── ELLE NE LÈVE JAMAIS ───────────────────────────────────────────────────
 *
 * La réponse est déjà rendue à l'utilisateur quand cette fonction s'exécute.
 * Un échec d'écriture ne doit pas transformer une réponse correcte en erreur :
 * il est journalisé, et l'historique perd un message.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function persistResult(
  result: AssistantRunResult,
  input: AssistantRequestInput,
): Promise<PersistedIds | null> {
  const cfg = getAssistantConfig();
  const expires = new Date(Date.now() + cfg.historyDays * 86400_000).toISOString();

  try {
    // Les traces d'appels modèle s'écrivent en tâche de fond : elles sont
    // attendues (borné) pour que le rattachement au message (§28.8) et le
    // cache_hit (§28.7) les voient.
    await awaitAiRuns(result.requestId);
    // Fil résolu par la route (conversation de l'utilisateur) ; à défaut, la
    // conversation active de l'utilisateur.
    const conversationId = input.conversationId
      ?? await getOrCreateActiveConversation(input.accountId, input.userId, input.locale);

    return (await pgClient.begin(async (tx) => {
      // ── 0. Le fil existe toujours et appartient à l'utilisateur ─────────
      //
      // Un effacement a pu intervenir pendant le traitement : la réponse ne
      // doit pas ressusciter un historique que l'utilisateur vient de
      // supprimer. Le verrou sérialise avec `clearUserHistory`.
      const fil = await tx.unsafe(
        `SELECT id FROM verebona_conversations
          WHERE id = $1 AND account_id = $2 AND user_id = $3 AND status = 'active'
          FOR UPDATE`,
        [conversationId, input.accountId, input.userId],
      );
      if ((fil as unknown as unknown[]).length === 0) return null;

      // ── 0 bis. La demande n'a pas été annulée pendant le traitement ─────
      //
      // CDC §7.8, §9.7, CA-22 : une réponse arrivée après l'annulation n'est
      // jamais réinjectée. La réservation (`request-lifecycle.service`) est
      // relue sous verrou, ce qui sérialise avec DELETE /requests/{id} : soit
      // l'annulation passe avant et rien n'est écrit, soit la réponse est
      // enregistrée et l'annulation répond « déjà terminée ».
      const run = (await tx.unsafe(
        `SELECT status FROM verebona_request_runs
          WHERE request_id = $1 AND account_id = $2 FOR UPDATE`,
        [result.requestId, input.accountId],
      )) as unknown as Array<{ status: string | null }>;
      const reservation = run[0] ?? null;
      if (reservation?.status === 'cancelled') {
        // Le coût du traitement reste tracé (§31.3), sans aucun message.
        await tx.unsafe(
          `UPDATE verebona_request_runs
              SET intent = $2, mode = $3, machine_final_state = 'CANCELLED', source_count = $4,
                  latency_ms = $5, intent_catalog_version = $6
            WHERE request_id = $1`,
          [result.requestId, result.route?.intent ?? null, result.mode, result.sources.length,
           result.cascade?.latencyMs ?? null, INTENT_CATALOG_VERSION],
        );
        return null;
      }

      // ── 1. Question de l'utilisateur ────────────────────────────────────
      //
      // Enregistrée aussi : sans elle, l'historique montrerait des réponses
      // sans questions, illisible à la reprise.
      const questionRows = await tx.unsafe(
        `INSERT INTO verebona_messages
           (conversation_id, account_id, author_user_id, role, status, content,
            request_id, client_request_id, response_locale, expires_at)
         VALUES ($1, $2, $3, 'user', 'ready', $4, $5, $6, $7, $8)
         RETURNING id`,
        // Reprise après clarification : l'historique montre le CHOIX de
        // l'utilisateur, pas la demande initiale rejouée une seconde fois.
        [conversationId, input.accountId, input.userId, input.resume?.choiceLabel ?? input.originalMessage ?? input.message,
         result.requestId, input.clientRequestId, input.locale, expires],
      );
      // §28.2 : la réponse est rattachée à la question qui l'a provoquée.
      const questionId = (questionRows as unknown as Array<{ id: number }>)[0]?.id ?? null;

      // ── 2. Réponse de l'assistant ───────────────────────────────────────
      const messageRows = await tx.unsafe(
        `INSERT INTO verebona_messages
           (conversation_id, account_id, author_user_id, role, status, content,
            intent, mode, support_level, request_id, response_locale, expires_at,
            result_groups_json, action_catalog_version,
            intent_catalog_version, schema_version, parent_message_id)
         VALUES ($1, $2, NULL, 'assistant', $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15)
         RETURNING id`,
        [conversationId, input.accountId,
         result.error ? 'error' : 'ready',
         result.answer,
         result.route?.intent ?? null,
         result.mode,
         result.supportLevel,
         result.requestId, input.locale, expires,
         // Cartes de résultats (§11.3, migration 0190) : relues à la reprise.
         result.resultGroups?.length ? JSON.stringify(result.resultGroups) : null,
         // §22.11 : version du catalogue d'actions avec laquelle les actions
         // de CE message ont été résolues (colonne existante, migration 0100).
         ACTION_CATALOG_VERSION,
         // §28.2 : catalogue d'intentions et schéma de sortie en vigueur,
         // et question d'origine (parent_message_id).
         INTENT_CATALOG_VERSION, RESPONSE_SCHEMA_VERSION, questionId],
      );
      const messageId = (messageRows as unknown as Array<{ id: number }>)[0].id;

      // CDC 15 T2-35 / R1 (migration 0228) : chronologie structurée, relue à la
      // reprise du fil. Absente (legacy, autre format) : colonne NULL.
      const chronologie = timelineForStorage(result.events);
      if (chronologie && await timelineColumnReady()) {
        await tx.unsafe(
          `UPDATE verebona_messages SET timeline_events_json = $2::jsonb WHERE id = $1`,
          [messageId, JSON.stringify(chronologie)],
        );
      }

      // ── 3. Sources, avec instantané ─────────────────────────────────────
      //
      // `title_snapshot` et `excerpt_snapshot` figent ce qui a été montré.
      // Un document renommé ou supprimé ensuite ne doit pas réécrire
      // l'historique : l'utilisateur a lu CE titre-là (§19.10).
      // Indexé par l'identifiant de la source — « doc_128 » —, car c'est lui
      // que les citations référencent, pas leur rang d'affichage.
      const ligneParSource = new Map<string, number>();
      for (const [rang, source] of result.sources.entries()) {
        // TOUTES les sources de la réponse (≤ 8), avec type, bien lié, date
        // utile, statut, score et version (§19.3, §19.5, §19.13, §28.4).
        const rows = await tx.unsafe(
          `INSERT INTO verebona_message_sources
             (message_id, source_type, source_id, title_snapshot, excerpt_snapshot,
              rank, is_available, linked_asset_label, useful_date, status_label,
              relevance_score, source_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id`,
          [messageId, source.type, source.id, source.title, source.excerpt,
           rang, source.isAvailable, source.linkedAssetLabel ?? null, source.usefulDate ?? null,
           source.statusLabel ?? null, source.relevanceScore ?? null, source.sourceVersion ?? null],
        );
        ligneParSource.set(source.id, (rows as unknown as Array<{ id: number }>)[0].id);
      }

      // ── 4. Citations, et leur rattachement aux sources ──────────────────
      for (const claim of result.claims) {
        const rows = await tx.unsafe(
          `INSERT INTO verebona_message_claims (message_id, claim_key, claim_text, derivation)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [messageId, claim.claimKey, claim.text, claim.derivation],
        );
        const claimId = (rows as unknown as Array<{ id: number }>)[0].id;

        // Le lien citation → source est ce qui rend une affirmation
        // vérifiable. Sans lui, les deux tables existeraient sans rapport.
        for (const ref of claim.sourceIds) {
          const ligneId = ligneParSource.get(ref);
          // Une citation peut référencer une source écartée de l'affichage
          // (au-delà de `maxVisibleSources`). On ne l'invente pas : le lien
          // est simplement absent, et l'affirmation reste enregistrée.
          if (ligneId === undefined) continue;
          await tx.unsafe(
            `INSERT INTO verebona_claim_sources (claim_id, message_source_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [claimId, ligneId],
          );
        }
      }

      // ── 5. Actions proposées ────────────────────────────────────────────
      for (const action of result.actions) {
        // §28.6 : cible décodée (famille + identifiant numérique) et
        // paramètres validés côté serveur. Jamais d'URL libre venue du modèle :
        // le href stocké est celui que le résolveur a construit.
        const cible = actionTarget(action);
        await tx.unsafe(
          `INSERT INTO verebona_message_actions
             (message_id, action_type, label, resolved_href, requires_confirmation,
              analytics_code, expires_at, target_type, target_id, payload_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
          [messageId, action.type, action.label, action.href,
           action.requiresConfirmation, action.analyticsCode, action.expiresAt,
           cible.targetType, cible.targetId, JSON.stringify(cible.payload)],
        );
      }

      // ── 5 ter. Commande proposée : rattachée au message qui la présente ──
      //
      // L'historique rechargé restitue ainsi l'état du plan (en attente et
      // annulable, annulé, expiré, exécuté — migration 0203). Seul un plan
      // du même compte et du même utilisateur est rattaché.
      if (result.commandPlan?.planId) {
        await tx.unsafe(
          `UPDATE verebona_command_plans SET message_id = $1, conversation_id = $2
            WHERE plan_id = $3 AND account_id = $4 AND user_id = $5`,
          [messageId, conversationId, result.commandPlan.planId, input.accountId, input.userId],
        );
      }

      // ── 5 bis. Entités présentées, DANS L'ORDRE D'AFFICHAGE ─────────────
      //
      // « Ouvre le deuxième » désignera le deuxième élément affiché ici, même
      // si une nouvelle requête les rendait dans un autre ordre.
      let position = 0;
      for (const source of result.sources) {
        const ref = parseEntityRef(source.id);
        if (!ref || !['asset', 'document', 'agenda_item', 'equipment', 'room'].includes(ref.kind)) continue;
        position += 1;
        await tx.unsafe(
          `INSERT INTO verebona_presented_entities
             (conversation_id, message_id, position, entity_type, entity_id, label)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [conversationId, messageId, position, ref.kind, ref.id, source.title ?? null],
        );
      }

      // Entité désignée (référence résolue, choix de clarification) : elle
      // devient le contexte courant du fil — « sa date », « cette maison ».
      if (result.contextUpdate) {
        const u = result.contextUpdate;
        const patch: Record<string, unknown> = { lastSelected: { type: u.type, id: u.id, label: u.label ?? null } };
        if (u.type === 'asset') patch.currentAssetId = u.id;
        if (u.type === 'document') patch.currentDocumentId = u.id;
        await tx.unsafe(
          `UPDATE verebona_conversations SET context_json = coalesce(context_json, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
          [conversationId, JSON.stringify(patch)],
        );
      }

      // ── 6. Trace d'exécution ────────────────────────────────────────────
      //
      // C'est elle qui alimente l'évaluation de qualité du §35 : sans mode,
      // intention et nombre de sources, un jeu de référence ne peut rien
      // mesurer.
      //
      // Cascade T2 (non-escalade) : niveau ayant répondu, décision de
      // suffisance, motifs d'escalade, appels IA, modèle. `levelsReached`
      // (structured / fulltext / llm) alimente le tableau de bord T2 de la
      // gouvernance, qui lisait jusqu'ici une colonne jamais remplie.
      const cascade = result.cascade
        ? {
            ...result.cascade,
            // §18 (lot 17) : source de vérité, sources PAR TYPE, type et
            // origine de la cible — codes et compteurs, aucun contenu.
            observability: t2Observability(result, input),
            levelsReached: [
              ...new Set([
                // Seuls les niveaux réellement évalués comptent : un niveau
                // sans plan applicable (NOT_APPLICABLE / NO_STRUCTURED_PLAN)
                // n'a pas été « atteint ».
                ...result.cascade.attempts
                  .filter((a) => a.status !== 'NOT_APPLICABLE' && a.reason !== 'NO_STRUCTURED_PLAN' && a.status !== 'SKIPPED')
                  // Lot 33 : niveaux de la cascade du Centre d'aide (recherche
                  // élargie, compréhension UNDERSTAND, recherche reformulée).
                  .map((a) => HELP_LEVELS[a.strategy] ?? (a.level === 1 ? 'structured' : 'fulltext')),
                ...(result.cascade.answeredBy === 'llm' ? ['llm'] : []),
              ]),
            ],
          }
        // Refus sans cascade : le classement des sous-demandes reste tracé.
        : (result.scope ? { scope: result.scope } : null);
      // Réservée au début (route POST messages) : la ligne est complétée.
      // Sans réservation (reprise de clarification, appel direct) : insérée.
      const traceParams = [result.requestId, input.clientRequestId, conversationId,
        input.accountId, input.userId,
        result.route?.intent ?? null, result.mode, result.finalState,
        result.sources.length,
        result.error ? 'error' : 'ok',
        result.error?.code ?? null,
        cascade ? JSON.stringify(cascade) : null,
        result.cascade?.sourceCount ?? null,
        result.cascade?.latencyMs ?? null,
        INTENT_CATALOG_VERSION,
        // §28.7 cache_hit : retrieval servi par le cache, OU un appel modèle
        // de la demande servi par le cache d'idempotence (trace `cached`).
        Boolean(result.cascade?.cacheHit)];
      const cacheHit = `($16::boolean OR EXISTS (SELECT 1 FROM verebona_ai_runs x
                                                  WHERE x.request_id = $1 AND x.status = 'cached'))`;
      await tx.unsafe(
        reservation
          ? `UPDATE verebona_request_runs
                SET client_request_id = $2, conversation_id = $3, user_id = $5, intent = $6, mode = $7,
                    machine_final_state = $8, source_count = $9, status = $10, error_code = $11,
                    retrieval_methods_json = $12::jsonb, candidate_count = $13, latency_ms = $14,
                    intent_catalog_version = $15, cache_hit = ${cacheHit}
              WHERE request_id = $1 AND account_id = $4`
          : `INSERT INTO verebona_request_runs
               (request_id, client_request_id, conversation_id, account_id, user_id,
                intent, mode, machine_final_state, source_count, status, error_code,
                retrieval_methods_json, candidate_count, latency_ms, intent_catalog_version, cache_hit)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, ${cacheHit})`,
        traceParams,
      );

      // §28.8 : chaque appel modèle de la demande est rattaché au message
      // assistant enregistré (message_id était toujours NULL).
      await tx.unsafe(
        `UPDATE verebona_ai_runs SET message_id = $1
          WHERE request_id = $2 AND account_id = $3 AND message_id IS NULL`,
        [messageId, result.requestId, input.accountId],
      );

      // Mémorise l'état de la machine pour une reprise de conversation (§24),
      // intitule le fil à sa première question et prolonge sa conservation :
      // un fil reste consultable `historyDays` jours après sa dernière
      // activité (90 jours, soit 3 mois — `assistant-config.ts`, variable
      // unique lue aussi par la purge ; CDC 15 T2-46).
      await tx.unsafe(
        `UPDATE verebona_conversations
            SET machine_state = $2, updated_at = now(), last_message_at = now(),
                title = COALESCE(title, left($3, 80)), expires_at = $4
          WHERE id = $1`,
        [conversationId, result.finalState, input.message, expires],
      );
      return { conversationId, messageId };
    })) as PersistedIds | null;
  } catch (e) {
    // La réponse est déjà rendue : un échec d'écriture ne doit pas la
    // transformer en erreur.
    console.error(
      `[verebona] historique non enregistré (demande ${result.requestId}) :`,
      (e as Error).message,
    );
    return null;
  }
}

/**
 * Cible et paramètres d'une action, tels que persistés (§28.6) : famille et
 * identifiant décodés par le résolveur (« asset:42 »), paramètres validés.
 * Une action sans cible (liste, aide) garde `target_type/target_id` nuls.
 */
export function actionTarget(action: Pick<VerebonaAction, 'targetRef' | 'payload'>): {
  targetType: string | null; targetId: string | null; payload: Record<string, unknown>;
} {
  const m = typeof action.targetRef === 'string' ? action.targetRef.match(/^([a-z_]+):(\d+)$/) : null;
  return {
    targetType: m ? m[1] : null,
    targetId: m ? m[2] : null,
    payload: action.payload && typeof action.payload === 'object' ? { ...action.payload } : {},
  };
}

/** Identifiants réellement enregistrés (le messageId rendu au client est celui de la base). */
export interface PersistedIds {
  conversationId: number;
  messageId: number;
}

/** Client SQL minimal : `pgClient` ou la transaction de `pgClient.begin`. */
export interface SqlRunner {
  unsafe(query: string, params?: never[]): PromiseLike<unknown>;
}

export interface ConversationPurge {
  conversations: number;
  messages: number;
  cachedModelResponses: number;
}

/**
 * Supprime DÉFINITIVEMENT des conversations et tout ce qui permettrait de les
 * reconstruire :
 *   · messages, citations, sources (instantanés titre/extrait), liens
 *     citation → source, actions proposées, avis ;
 *   · réponses brutes du modèle mises en cache par la passerelle
 *     (`ai_operation_idempotency`, clés `assistant:c{id}:…`) ;
 *   · traces d'exécution : conservées pour les mesures de qualité et de coût
 *     (§35) mais DÉTACHÉES du fil (conversation_id, client_request_id mis à
 *     NULL) — elles ne contiennent aucun texte de la conversation.
 *
 * Les suppressions sont explicites, enfant avant parent, et ne comptent pas
 * sur les cascades : une table créée par `drizzle-kit push` (avant la
 * migration 0100) n'a pas de clé étrangère, et une cascade absente
 * laisserait les citations et sources orphelines — donc lisibles.
 */
export async function purgeConversationData(
  sql: SqlRunner,
  conversationIds: number[],
): Promise<ConversationPurge> {
  if (conversationIds.length === 0) return { conversations: 0, messages: 0, cachedModelResponses: 0 };
  const ids = [conversationIds] as never[];

  const messages = await purgeMessagesWhere(sql, 'conversation_id = ANY($1::int[])', ids);
  await sql.unsafe(
    `UPDATE verebona_request_runs SET conversation_id = NULL, client_request_id = NULL
      WHERE conversation_id = ANY($1::int[])`,
    ids,
  );

  // Copies brutes des réponses du modèle. La table est optionnelle selon
  // l'état du déploiement : sa présence est vérifiée plutôt que de risquer
  // une erreur qui annulerait toute la transaction.
  let cachedModelResponses = 0;
  const [cache] = (await sql.unsafe(
    `SELECT to_regclass('ai_operation_idempotency') IS NOT NULL AS present`,
  )) as Array<{ present: boolean }>;
  if (cache?.present) {
    const patterns = conversationIds.flatMap((id) => [`${assistantCachePrefix(id)}%`, `assistant:${id}:%`]);
    const rows = (await sql.unsafe(
      `DELETE FROM ai_operation_idempotency WHERE key_hash LIKE ANY($1::text[]) RETURNING 1`,
      [patterns] as never[],
    )) as unknown[];
    cachedModelResponses = rows.length;
  }

  // Commandes métier : ce sont des traces d'écritures réelles (audit). Elles
  // sont conservées mais détachées du fil effacé.
  const [cmd] = (await sql.unsafe(
    `SELECT to_regclass('verebona_command_plans') IS NOT NULL AS present`,
  )) as Array<{ present: boolean }>;
  if (cmd?.present) {
    await sql.unsafe(`UPDATE verebona_command_plans SET conversation_id = NULL WHERE conversation_id = ANY($1::int[])`, ids);
  }

  // Revalidations de faits : la connaissance améliorée reste (elle appartient
  // au compte), mais la question posée et le rattachement au fil s'effacent.
  const [rev] = (await sql.unsafe(
    `SELECT to_regclass('verebona_fact_revalidations') IS NOT NULL AS present`,
  )) as Array<{ present: boolean }>;
  if (rev?.present) {
    await sql.unsafe(
      `UPDATE verebona_fact_revalidations SET conversation_id = NULL, question = NULL WHERE conversation_id = ANY($1::int[])`,
      ids,
    );
  }

  // Entités présentées (ordre d'affichage) : mémoire du fil.
  const [pres] = (await sql.unsafe(
    `SELECT to_regclass('verebona_presented_entities') IS NOT NULL AS present`,
  )) as Array<{ present: boolean }>;
  if (pres?.present) {
    await sql.unsafe(`DELETE FROM verebona_presented_entities WHERE conversation_id = ANY($1::int[])`, ids);
  }

  // Traces du parcours de clarification : elles contiennent la demande
  // initiale et les candidats, donc de quoi reconstruire l'échange.
  const [clar] = (await sql.unsafe(
    `SELECT to_regclass('verebona_clarification_events') IS NOT NULL AS present`,
  )) as Array<{ present: boolean }>;
  if (clar?.present) {
    await sql.unsafe(`DELETE FROM verebona_clarification_events WHERE conversation_id = ANY($1::int[])`, ids);
  }

  const conversations = (await sql.unsafe(
    `DELETE FROM verebona_conversations WHERE id = ANY($1::int[]) RETURNING id`, ids,
  )) as unknown[];

  return { conversations: conversations.length, messages, cachedModelResponses };
}

/**
 * Supprime des messages ET leurs dépendances (citations, sources, liens,
 * actions, avis), enfant avant parent. `where` porte sur verebona_messages.
 * Rend le nombre de messages supprimés.
 */
export async function purgeMessagesWhere(sql: SqlRunner, where: string, params: never[] = []): Promise<number> {
  const MSG = `SELECT id FROM verebona_messages WHERE ${where}`;
  await sql.unsafe(
    `DELETE FROM verebona_claim_sources
      WHERE claim_id IN (SELECT id FROM verebona_message_claims WHERE message_id IN (${MSG}))
         OR message_source_id IN (SELECT id FROM verebona_message_sources WHERE message_id IN (${MSG}))`,
    params,
  );
  for (const table of ['verebona_message_claims', 'verebona_message_sources', 'verebona_message_actions', 'verebona_feedback']) {
    await sql.unsafe(`DELETE FROM ${table} WHERE message_id IN (${MSG})`, params);
  }
  await sql.unsafe(`UPDATE verebona_ai_runs SET message_id = NULL WHERE message_id IN (${MSG})`, params);
  const rows = (await sql.unsafe(`DELETE FROM verebona_messages WHERE ${where} RETURNING id`, params)) as unknown[];
  return rows.length;
}

/**
 * Effacement manuel de l'historique de L'UTILISATEUR (§24.5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * EFFACER, PAS MASQUER
 *
 * L'ancienne version passait la conversation à `deleted` ; la lecture
 * interrogeait `verebona_messages` par compte sans regarder ce statut, et
 * d'anciens messages revenaient au rechargement. Sources, citations,
 * actions et réponses en cache restaient en base.
 *
 * Désormais, dans une transaction : les conversations de l'utilisateur sont
 * verrouillées puis purgées (voir `purgeConversationData`). La conversation
 * suivante est créée neuve — aucun état machine, contexte ni clarification
 * n'en est hérité. L'historique des autres membres du compte n'est jamais
 * touché.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function clearUserHistory(
  accountId: number,
  userId: number,
  /** Un seul fil ; absent : tous les fils de l'utilisateur. */
  conversationId?: number,
): Promise<ConversationPurge> {
  return pgClient.begin(async (tx) => {
    const rows = (await tx.unsafe(
      conversationId == null
        ? `SELECT id FROM verebona_conversations
            WHERE account_id = $1 AND user_id = $2
            FOR UPDATE`
        : `SELECT id FROM verebona_conversations
            WHERE account_id = $1 AND user_id = $2 AND id = $3
            FOR UPDATE`,
      conversationId == null ? [accountId, userId] : [accountId, userId, conversationId],
    )) as unknown as Array<{ id: number }>;
    return purgeConversationData(tx as unknown as SqlRunner, rows.map((r) => r.id));
  }) as Promise<ConversationPurge>;
}

/**
 * Purge quotidienne des conversations expirées — appelée par cleanup-job
 * (§28.13). Expirée = `expires_at` dépassé, soit `historyDays` jours (90,
 * 3 mois — `assistant-config.ts`) sans activité ; CDC 15 T2-46.
 */
export async function purgeExpired(): Promise<number> {
  return pgClient.begin(async (tx) => {
    const rows = (await tx.unsafe(
      `SELECT id FROM verebona_conversations WHERE expires_at < now() FOR UPDATE SKIP LOCKED`,
    )) as unknown as Array<{ id: number }>;
    const r = await purgeConversationData(tx as unknown as SqlRunner, rows.map((x) => x.id));
    return r.conversations;
  }) as Promise<number>;
}

/**
 * Contexte conversationnel du fil courant — et de lui seul (§16.4).
 *
 * Borné : 8 messages utiles au plus, les listes d'entités présentées dans
 * l'ordre d'affichage (au plus 4, de la plus récente à la plus ancienne),
 * l'entité sélectionnée, le bien / document courants, la clarification en
 * cours. Rien n'est lu dans les autres fils ni chez l'autre membre d'un Duo ;
 * un fil effacé ou expiré ne rend rien.
 */
export async function loadThreadContext(
  accountId: number,
  userId: number,
  conversationId: number,
): Promise<ThreadContext | null> {
  const conv = (await pgClient.unsafe(
    `SELECT id, context_json, clarification_state_json
       FROM verebona_conversations
      WHERE id = $1 AND account_id = $2 AND user_id = $3 AND status = 'active' AND expires_at > now()`,
    [conversationId, accountId, userId],
  )) as unknown as Array<{ id: number; context_json: Record<string, unknown> | null; clarification_state_json: { clarificationId?: string } | null }>;
  if (!conv[0]) return null;

  // Lot 29 (ticket 8a AC10) : une réponse qui restitue une donnée SENSIBLE
  // (affirmation `field:<clé sensible>`) est marquée — le texte reste dans
  // l'historique de l'utilisateur, il n'est jamais recopié vers le modèle.
  const clesSensibles = CANONICAL_FIELDS.filter((f) => f.sensitive).map((f) => `field:${f.key}`);
  const msgs = (await pgClient.unsafe(
    `SELECT role, content, sensitive FROM (
       SELECT m.id, m.role, m.content, m.created_at,
              EXISTS (SELECT 1 FROM verebona_message_claims c WHERE c.message_id = m.id AND c.claim_key = ANY($2::text[])) AS sensitive
         FROM verebona_messages m
        WHERE m.conversation_id = $1 AND m.status = 'ready' AND m.role IN ('user', 'assistant')
          AND coalesce(m.content, '') <> '' AND m.expires_at > now()
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 8
     ) m ORDER BY created_at ASC, id ASC`,
    [conversationId, clesSensibles],
  )) as unknown as Array<{ role: 'user' | 'assistant'; content: string; sensitive: boolean }>;

  const pres = (await pgClient.unsafe(
    `SELECT message_id, position, entity_type, entity_id, label
       FROM verebona_presented_entities
      WHERE conversation_id = $1
        AND message_id IN (SELECT DISTINCT message_id FROM verebona_presented_entities
                            WHERE conversation_id = $1 ORDER BY message_id DESC LIMIT 4)
      ORDER BY message_id DESC, position ASC`,
    [conversationId],
  ).catch(() => [])) as unknown as Array<{ message_id: number; position: number; entity_type: ReferencedType; entity_id: number; label: string | null }>;
  const lists: PresentedEntity[][] = [];
  let courant: number | null = null;
  for (const r of pres) {
    if (r.message_id !== courant) { lists.push([]); courant = r.message_id; }
    lists[lists.length - 1].push({ position: r.position, type: r.entity_type, id: r.entity_id, label: r.label });
  }

  const c = conv[0].context_json ?? {};
  const sel = c.lastSelected as ThreadContext['lastSelected'] | undefined;
  return {
    conversationId,
    messages: msgs.map((m) => ({ role: m.role, content: m.content, ...(m.sensitive === true ? { sensitive: true } : {}) })),
    presentedLists: lists,
    lastPresentedEntities: lists[0] ?? [],
    lastSelected: sel && typeof sel.id === 'number' ? sel : null,
    currentAssetId: typeof c.currentAssetId === 'number' ? c.currentAssetId : null,
    currentDocumentId: typeof c.currentDocumentId === 'number' ? c.currentDocumentId : null,
    pendingClarification: conv[0].clarification_state_json?.clarificationId ?? null,
  };
}
