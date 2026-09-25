/**
 * Retours sur les articles du Centre d'aide — CDC Centre d'aide V1,
 * FEEDBACK-01, FEEDBACK-02, COOKIE-01.
 *
 * Deux temps, comme l'écran du §11 :
 *   1. le vote Oui/Non, enregistré aussitôt ;
 *   2. pour « Non », un commentaire facultatif, rattaché au vote par un jeton
 *      à usage unique rendu au premier appel. Sans ce jeton, personne ne peut
 *      commenter le vote d'un autre.
 *
 * Sans session ni cookie : le site public n'en pose aucun.
 */
import { createHash, randomBytes } from 'crypto';
import { pgClient } from '@/db';

export const MAX_COMMENT_LENGTH = 1000;
const TOKEN_TTL_MS = 60 * 60 * 1000;
const ARTICLE_ID = /^AID-[A-Z]+-\d{3}$/;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Nettoie un commentaire (FEEDBACK-02) : texte brut, borné, sans caractère de
 * contrôle. Il n'est jamais rendu en HTML — mais un signe « < » stocké tel
 * quel resterait un piège pour qui l'afficherait un jour sans échappement :
 * les chevrons sont donc retirés.
 */
export function sanitizeComment(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮]/g, '')
    .replace(/[<>]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_COMMENT_LENGTH);
  return clean === '' ? null : clean;
}

export function isArticleId(v: unknown): v is string {
  return typeof v === 'string' && ARTICLE_ID.test(v);
}

export async function recordVote(input: {
  articleId: string;
  helpful: boolean;
  contentVersion: string | null;
}): Promise<{ feedbackId: string; commentToken: string | null }> {
  const token = input.helpful ? null : randomBytes(24).toString('base64url');
  const rows = await pgClient.unsafe(
    `INSERT INTO help_article_feedback (article_id, helpful, content_version, comment_token_hash, comment_token_expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      input.articleId, input.helpful, input.contentVersion?.slice(0, 64) ?? null,
      token ? sha256(token) : null, token ? new Date(Date.now() + TOKEN_TTL_MS) : null,
    ] as never[],
  );
  return { feedbackId: String((rows as unknown as Array<{ id: string }>)[0].id), commentToken: token };
}

/** Ajoute le commentaire ; `false` si le jeton est inconnu, expiré ou déjà utilisé. */
export async function recordComment(feedbackId: string, token: string, comment: string): Promise<boolean> {
  const rows = await pgClient.unsafe(
    `UPDATE help_article_feedback
        SET comment = $3, commented_at = now(), comment_token_hash = NULL, comment_token_expires_at = NULL
      WHERE id = $1 AND comment_token_hash = $2 AND comment_token_expires_at > now()
      RETURNING id`,
    [feedbackId, sha256(token), comment] as never[],
  );
  return (rows as unknown[]).length === 1;
}

// ── Limitation de débit (FEEDBACK-02) ────────────────────────────────────────

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, { count: number; resetAt: number }>();

/** 20 envois par IP et par 10 minutes : largement au-delà d'un lecteur réel. */
export function allowFeedback(ip: string, now = Date.now()): boolean {
  const h = hits.get(ip);
  if (!h || now > h.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    if (hits.size > 10_000) for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    return true;
  }
  h.count += 1;
  return h.count <= MAX_PER_WINDOW;
}

/** Réservé aux tests. */
export function resetFeedbackRateLimit(): void {
  hits.clear();
}
