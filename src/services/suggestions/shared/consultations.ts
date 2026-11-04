/**
 * Suggestions partagées CONSULTÉES — lot 108J (table
 * `shared_suggestion_consultations`, migration 1085).
 *
 * Une consultation (clic sur une suggestion, revalidé par la route de
 * l'assistant) sert UNIQUEMENT à la rotation : la suggestion laisse sa place
 * pendant `SHARED_SUGGESTION_CONSULTED_REST_HOURS`, puis peut revenir si elle
 * reste utile. Jamais une action métier, une preuve de maîtrise, une tâche
 * « À traiter », une alerte ni un retard. Préférence personnelle (Duo :
 * chacun la sienne). Table absente ou lecture impossible : aucune (jamais
 * bloquant).
 */
import { SHARED_SUGGESTION_CONSULTED_REST_HOURS } from './select';

/** Consultations conservées au plus par utilisateur et par compte (les plus anciennes sont purgées). */
const MAX_PER_USER = 200;
export const SHARED_SUGGESTION_ID_PATTERN = /^[a-z][a-z0-9_]{1,60}$/;

export async function readConsultedSuggestions(accountId: number, userId: number | null): Promise<Set<string>> {
  if (userId == null) return new Set();
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(
      `SELECT suggestion_id AS id FROM shared_suggestion_consultations
        WHERE account_id = $1 AND user_id = $2 AND consulted_at > NOW() - ($3::int * INTERVAL '1 hour')`,
      [accountId, userId, SHARED_SUGGESTION_CONSULTED_REST_HOURS] as never[],
    )) as unknown as Array<{ id: string }>;
    return new Set(r.map((x) => x.id));
  } catch {
    return new Set();
  }
}

/** Enregistre une consultation (idempotent : date renouvelée, compteur incrémenté). Rend `false` si impossible. */
export async function recordSuggestionConsultation(accountId: number, userId: number, suggestionId: string): Promise<boolean> {
  if (!SHARED_SUGGESTION_ID_PATTERN.test(suggestionId)) return false;
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `INSERT INTO shared_suggestion_consultations (account_id, user_id, suggestion_id, consulted_at, consult_count)
       VALUES ($1, $2, $3, NOW(), 1)
       ON CONFLICT (account_id, user_id, suggestion_id)
       DO UPDATE SET consulted_at = EXCLUDED.consulted_at, consult_count = shared_suggestion_consultations.consult_count + 1`,
      [accountId, userId, suggestionId] as never[],
    );
    await pgClient.unsafe(
      `DELETE FROM shared_suggestion_consultations s
        WHERE s.account_id = $1 AND s.user_id = $2
          AND s.id NOT IN (SELECT id FROM shared_suggestion_consultations WHERE account_id = $1 AND user_id = $2 ORDER BY consulted_at DESC LIMIT $3)`,
      [accountId, userId, MAX_PER_USER] as never[],
    );
    return true;
  } catch (e) {
    console.error('[suggestions] consultation non enregistrée :', (e as Error).message);
    return false;
  }
}
