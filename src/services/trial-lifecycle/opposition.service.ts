/**
 * Lot 100G — opposition aux communications commerciales (désinscription).
 *
 * Lien {{unsubscribeUrl}} des relances, SANS connexion, signé, IDEMPOTENT :
 * un second clic ne change rien (date d'origine conservée) et répond la même
 * chose. Effets immédiats :
 *   · plus aucune relance commerciale de la séquence de fin d'essai (contrôlé
 *     juste avant chaque envoi : motif `opposition`) ;
 *   · le consentement aux actualités (`news_consents`), s'il existait, est
 *     retiré — « Ne plus recevoir de communications commerciales » vaut pour
 *     toutes (choix prudent).
 * Les notifications de SERVICE (J−2, J0) ne portent aucune offre commerciale
 * nouvelle et ne sont jamais envoyées après J0 : elles ne peuvent pas servir à
 * contourner l'opposition.
 * Réponse identique que l'utilisateur existe ou non (aucune énumération).
 */
import { pgClient } from '@/db';
import { unsubscribeSecret, verifyUnsubscribeToken } from './links';

export type OppositionSource = 'email_link' | 'one_click' | 'admin' | 'account';

export async function isOpposed(userId: number): Promise<boolean> {
  const [row] = await pgClient<{ n: number }[]>`SELECT 1 AS n FROM marketing_oppositions WHERE user_id = ${userId} LIMIT 1`;
  return !!row;
}

/** Enregistre l'opposition (idempotent). `created` : première opposition. */
export async function recordOpposition(userId: number, source: OppositionSource, now: Date = new Date()): Promise<{ created: boolean }> {
  return pgClient.begin(async (tx) => {
    const [u] = await tx<{ id: number }[]>`SELECT id FROM users WHERE id = ${userId}`;
    if (!u) return { created: false };
    const inserted = await tx`
      INSERT INTO marketing_oppositions (user_id, opposed_at, source) VALUES (${userId}, ${now.toISOString()}, ${source})
      ON CONFLICT (user_id) DO NOTHING RETURNING user_id`;
    if (!inserted.length) return { created: false };
    // Consentement aux actualités retiré (preuve conservée : date de retrait).
    await tx`
      UPDATE news_consents SET consented = false, revoked_at = ${now.toISOString()}, source = 'trial_unsubscribe', updated_at = ${now.toISOString()}
       WHERE user_id = ${userId} AND consented = true`;
    const [last] = await tx<{ account_id: number | null; trial_ends_at: Date | null; milestone: string | null }[]>`
      SELECT account_id, trial_ends_at, milestone FROM trial_lifecycle_messages
       WHERE user_id = ${userId} AND status = 'sent' ORDER BY sent_at DESC NULLS LAST LIMIT 1`;
    await tx`
      INSERT INTO trial_lifecycle_events (account_id, user_id, trial_ends_at, milestone, event_type, actor, detail, created_at)
      VALUES (${last?.account_id ?? null}, ${userId}, ${last?.trial_ends_at ?? null}, ${last?.milestone ?? null}, 'unsubscribe',
              ${source === 'admin' ? 'admin' : 'user'}, ${JSON.stringify({ source })}::jsonb, ${now.toISOString()})`;
    return { created: true };
  });
}

export type UnsubscribeResult = { ok: true; alreadyOpposed: boolean } | { ok: false; code: 'INVALID_LINK' | 'UNAVAILABLE' };

/** Désinscription depuis le lien d'un e-mail (page ou « en un clic »). */
export async function unsubscribeWithToken(token: unknown, source: 'email_link' | 'one_click', now: Date = new Date()): Promise<UnsubscribeResult> {
  const secret = unsubscribeSecret();
  if (!secret) return { ok: false, code: 'UNAVAILABLE' };
  const userId = verifyUnsubscribeToken(token, secret);
  if (!userId) return { ok: false, code: 'INVALID_LINK' };
  const r = await recordOpposition(userId, source, now);
  return { ok: true, alreadyOpposed: !r.created };
}
