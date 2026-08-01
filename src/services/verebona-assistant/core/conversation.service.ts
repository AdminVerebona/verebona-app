/**
 * Persistance conversationnelle & historique — CDC §24 / §28.
 *
 * Gère la conversation active (1 par compte — §28.1), les messages, l'idempotence
 * (réutilise `client_request_id`), l'historique 7 jours au niveau COMPTE (partagé Duo,
 * auteur conservé — §24.3) et l'effacement manuel (§24.5).
 *
 * Utilise les tables verebona_* (voir migration 0100). Câblé sur `@/db` (postgres.js).
 */
import { pgClient } from '@/db';
import type { AssistantRunResult, AssistantRequestInput } from '../types/contracts';
import { getAssistantConfig } from '../config/assistant-config';

/** Récupère (ou crée) la conversation active du compte. */
export async function getOrCreateActiveConversation(accountId: number, locale: string): Promise<number> {
  const cfg = getAssistantConfig();
  const expires = new Date(Date.now() + cfg.historyDays * 86400_000).toISOString();
  // Le statut est réaffirmé, pas seulement l'horodatage : sur une base où
  // l'index n'est pas partiel, le conflit peut porter sur une conversation
  // marquée « deleted », et l'assistant écrirait alors dans un historique que
  // l'utilisateur a demandé d'effacer (§24.5).
  const rows = await pgClient.unsafe(
    `INSERT INTO verebona_conversations (account_id, status, machine_state, locale, expires_at)
       VALUES ($1, 'active', 'IDLE', $2, $3)
       ON CONFLICT (account_id) WHERE status = 'active'
       DO UPDATE SET updated_at = now(), status = 'active', expires_at = EXCLUDED.expires_at
       RETURNING id`,
    [accountId, locale, expires],
  );
  return (rows as unknown as Array<{ id: number }>)[0].id;
}

/** Idempotence : renvoie le message existant si `client_request_id` déjà vu (§31.9). */
export async function findByClientRequestId(accountId: number, clientRequestId: string): Promise<number | null> {
  const rows = await pgClient.unsafe(
    `SELECT id FROM verebona_messages WHERE account_id = $1 AND client_request_id = $2 LIMIT 1`,
    [accountId, clientRequestId],
  );
  const list = rows as unknown as Array<{ id: number }>;
  return list.length ? list[0].id : null;
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
): Promise<void> {
  const cfg = getAssistantConfig();
  const expires = new Date(Date.now() + cfg.historyDays * 86400_000).toISOString();

  try {
    const conversationId = await getOrCreateActiveConversation(input.accountId, input.locale);

    await pgClient.begin(async (tx) => {
      // ── 1. Question de l'utilisateur ────────────────────────────────────
      //
      // Enregistrée aussi : sans elle, l'historique montrerait des réponses
      // sans questions, illisible à la reprise.
      await tx.unsafe(
        `INSERT INTO verebona_messages
           (conversation_id, account_id, author_user_id, role, status, content,
            request_id, client_request_id, response_locale, expires_at)
         VALUES ($1, $2, $3, 'user', 'ready', $4, $5, $6, $7, $8)`,
        [conversationId, input.accountId, input.userId, input.message,
         result.requestId, input.clientRequestId, input.locale, expires],
      );

      // ── 2. Réponse de l'assistant ───────────────────────────────────────
      const messageRows = await tx.unsafe(
        `INSERT INTO verebona_messages
           (conversation_id, account_id, author_user_id, role, status, content,
            intent, mode, support_level, request_id, response_locale, expires_at)
         VALUES ($1, $2, NULL, 'assistant', $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [conversationId, input.accountId,
         result.error ? 'error' : 'ready',
         result.answer,
         result.route?.intent ?? null,
         result.mode,
         result.supportLevel,
         result.requestId, input.locale, expires],
      );
      const messageId = (messageRows as unknown as Array<{ id: number }>)[0].id;

      // ── 3. Sources, avec instantané ─────────────────────────────────────
      //
      // `title_snapshot` et `excerpt_snapshot` figent ce qui a été montré.
      // Un document renommé ou supprimé ensuite ne doit pas réécrire
      // l'historique : l'utilisateur a lu CE titre-là (§19.10).
      // Indexé par l'identifiant de la source — « doc_128 » —, car c'est lui
      // que les citations référencent, pas leur rang d'affichage.
      const ligneParSource = new Map<string, number>();
      for (const [rang, source] of result.sources.entries()) {
        const rows = await tx.unsafe(
          `INSERT INTO verebona_message_sources
             (message_id, source_type, source_id, title_snapshot, excerpt_snapshot,
              rank, is_available)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [messageId, source.type, source.id, source.title, source.excerpt,
           rang, source.isAvailable],
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
        await tx.unsafe(
          `INSERT INTO verebona_message_actions
             (message_id, action_type, label, resolved_href, requires_confirmation,
              analytics_code, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [messageId, action.type, action.label, action.href,
           action.requiresConfirmation, action.analyticsCode, action.expiresAt],
        );
      }

      // ── 6. Trace d'exécution ────────────────────────────────────────────
      //
      // C'est elle qui alimente l'évaluation de qualité du §35 : sans mode,
      // intention et nombre de sources, un jeu de référence ne peut rien
      // mesurer.
      await tx.unsafe(
        `INSERT INTO verebona_request_runs
           (request_id, client_request_id, conversation_id, account_id, user_id,
            intent, mode, machine_final_state, source_count, status, error_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [result.requestId, input.clientRequestId, conversationId,
         input.accountId, input.userId,
         result.route?.intent ?? null, result.mode, result.finalState,
         result.sources.length,
         result.error ? 'error' : 'ok',
         result.error?.code ?? null],
      );

      // Mémorise l'état de la machine pour une reprise de conversation (§24).
      await tx.unsafe(
        `UPDATE verebona_conversations
            SET machine_state = $2, updated_at = now()
          WHERE id = $1`,
        [conversationId, result.finalState],
      );
    });
  } catch (e) {
    // La réponse est déjà rendue : un échec d'écriture ne doit pas la
    // transformer en erreur.
    console.error(
      `[verebona] historique non enregistré (demande ${result.requestId}) :`,
      (e as Error).message,
    );
  }
}

/** Effacement manuel de l'historique du compte (§24.5). */
export async function clearAccountHistory(accountId: number): Promise<void> {
  await pgClient.unsafe(
    `UPDATE verebona_conversations SET status = 'deleted' WHERE account_id = $1 AND status = 'active'`,
    [accountId],
  );
}

/** Purge quotidienne des conversations expirées (> 7 j) — appelée par cleanup-job (§28.13). */
export async function purgeExpired(): Promise<number> {
  const rows = await pgClient.unsafe(
    `DELETE FROM verebona_conversations WHERE expires_at < now() RETURNING id`,
  );
  return (rows as unknown as Array<{ id: number }>).length;
}
