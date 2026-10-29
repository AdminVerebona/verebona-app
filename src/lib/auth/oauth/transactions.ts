/**
 * Transactions OAuth serveur — lot 93, CDC 18 §12.2, §19.2, §31.5, §37
 * (« callback rejoué → refus »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CYCLE DE VIE (table `auth_transactions`, migration 0808)
 *
 *   pending        créée au démarrage : `state` (haché), `nonce` (haché),
 *                  vérificateur PKCE, contexte (retour interne, invitation,
 *                  transmission, parrainage, application), liaison au
 *                  navigateur (cookie `vb_oauth`, haché) ; 10 minutes.
 *   received       Apple seulement : retour `form_post` (requête inter-sites,
 *                  sans cookie Lax) — l'identité validée est mise de côté, le
 *                  navigateur est renvoyé en GET (cookies présents) pour
 *                  vérifier la liaison avant tout effet.
 *   awaiting_user  aucun compte lié : étape « Vous avez déjà un compte ? » /
 *                  profil / code d'adresse — 30 minutes.
 *   handoff        retour vers l'application mobile : code d'échange à usage
 *                  unique (2 minutes), lié au défi PKCE de l'application.
 *   consumed       terminée (session ouverte, identité liée, preuve émise…).
 *   failed         refusée (motif normalisé).
 *
 * Chaque passage d'état est un UPDATE CONDITIONNEL sur l'état attendu
 * (RETURNING) : un retour rejoué, un double clic ou deux onglets ne peuvent
 * produire qu'un seul effet (usage unique, y compris en concurrence).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { NextRequest, NextResponse } from 'next/server';
import { pgClient } from '@/db';
import { OAUTH_TX_TTL_MS, type OAuthProvider } from './config';
import { createPkcePair, randomToken, sha256Hex } from './crypto';
import type { ProviderIdentity } from './providers';

export type OAuthIntent = 'login' | 'signup' | 'link' | 'reauth';
export type TxStatus = 'pending' | 'received' | 'awaiting_user' | 'handoff' | 'consumed' | 'failed';

/** Contexte conservé côté serveur à travers la redirection (CDC §7, §24, §31.5). */
export interface TxContext {
  client: 'web' | 'app';
  returnUrl?: string;
  inviteToken?: string;
  transmissionToken?: string;
  referralCode?: string;
  /** Défi PKCE de l'application mobile (échange final, §21.3). */
  appChallenge?: string;
  /** Rattachement en attente prouvé par un AUTRE fournisseur déjà lié (§8.1, §18.2). */
  pendingLinkTxId?: number;
  /** Mon compte › Sécurité : action à reprendre après la réauthentification. */
  resume?: string;
}

/** Identité validée, mise de côté entre le retour du fournisseur et l'étape suivante. */
export interface TxClaims extends ProviderIdentity {
  /** Jeton Apple CHIFFRÉ (révocation, §25) — jamais en clair. */
  refreshTokenCiphertext?: string | null;
}

export interface AuthTransaction {
  id: number;
  provider: OAuthProvider;
  intent: OAuthIntent;
  status: TxStatus;
  bindingHash: string;
  nonceHash: string;
  codeVerifier: string;
  userId: number | null;
  sessionSid: string | null;
  context: TxContext;
  claims: TxClaims | null;
  stage: string | null;
  pendingEmail: string | null;
  emailCodeHash: string | null;
  emailCodeExpiresAt: Date | null;
  emailCodeAttempts: number;
  emailCodeSentAt: Date | null;
  expiresAt: Date;
}

type Row = {
  id: string | number; provider: OAuthProvider; intent: OAuthIntent; status: TxStatus; binding_hash: string;
  nonce_hash: string; code_verifier: string; user_id: number | null; session_sid: string | null;
  context: TxContext | null; claims: TxClaims | null; stage: string | null; pending_email: string | null;
  email_code_hash: string | null; email_code_expires_at: Date | string | null; email_code_attempts: number;
  email_code_sent_at: Date | string | null; expires_at: Date | string;
};

/** Horodatage pour le pilote `postgres` de l'application (chaînes ISO, jamais `Date`). */
const ts = (d: Date): string => d.toISOString();

const COLUMNS = `id, provider, intent, status, binding_hash, nonce_hash, code_verifier, user_id, session_sid,
  context, claims, stage, pending_email, email_code_hash, email_code_expires_at, email_code_attempts,
  email_code_sent_at, expires_at`;

function toTx(r: Row): AuthTransaction {
  return {
    id: Number(r.id), provider: r.provider, intent: r.intent, status: r.status, bindingHash: r.binding_hash,
    nonceHash: r.nonce_hash, codeVerifier: r.code_verifier, userId: r.user_id, sessionSid: r.session_sid,
    context: r.context ?? { client: 'web' }, claims: r.claims, stage: r.stage, pendingEmail: r.pending_email,
    emailCodeHash: r.email_code_hash,
    emailCodeExpiresAt: r.email_code_expires_at ? new Date(r.email_code_expires_at) : null,
    emailCodeAttempts: Number(r.email_code_attempts ?? 0),
    emailCodeSentAt: r.email_code_sent_at ? new Date(r.email_code_sent_at) : null,
    expiresAt: new Date(r.expires_at),
  };
}

// ── Liaison au navigateur ───────────────────────────────────────────────────

/** Cookie de liaison : HttpOnly, SameSite=Lax (renvoyé sur la navigation de retour), limité à `/api/auth/oauth`. */
export const OAUTH_BINDING_COOKIE = 'vb_oauth';
const BINDING_PATH = '/api/auth/oauth';
const BINDING_MAX_AGE_S = 45 * 60;

type CookieReader = Pick<NextRequest, 'cookies'>;

export function readBinding(request: CookieReader): string | null {
  const v = request.cookies.get(OAUTH_BINDING_COOKIE)?.value;
  return v && /^[A-Za-z0-9_-]{32,128}$/.test(v) ? v : null;
}

/** Valeur existante (même parcours : rattachement par un autre fournisseur) ou nouvelle. */
export function ensureBinding(request: CookieReader): string {
  return readBinding(request) ?? randomToken(32);
}

export function setBindingCookie(response: NextResponse, value: string): void {
  response.cookies.set(OAUTH_BINDING_COOKIE, value, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: BINDING_PATH, maxAge: BINDING_MAX_AGE_S,
  });
}

export function clearBindingCookie(response: NextResponse): void {
  response.cookies.set(OAUTH_BINDING_COOKIE, '', {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: BINDING_PATH, maxAge: 0,
  });
}

export function bindingMatches(tx: AuthTransaction, binding: string | null): boolean {
  return !!binding && sha256Hex(binding) === tx.bindingHash;
}

// ── Création ────────────────────────────────────────────────────────────────

export async function createTransaction(input: {
  provider: OAuthProvider;
  intent: OAuthIntent;
  binding: string;
  context: TxContext;
  userId?: number | null;
  sessionSid?: string | null;
  /** Lot 97B : ticket app → navigateur système (stocké haché, usage unique). */
  appTicket?: string | null;
  now?: Date;
}): Promise<{ id: number; state: string; nonce: string; codeChallenge: string }> {
  const now = input.now ?? new Date();
  const state = randomToken(32);
  const nonce = randomToken(32);
  const { verifier, challenge } = createPkcePair();
  const [row] = await pgClient<{ id: string }[]>`
    INSERT INTO auth_transactions
      (provider, intent, status, state_hash, binding_hash, nonce_hash, code_verifier, user_id, session_sid, context, expires_at, created_at, updated_at,
       app_ticket_hash)
    VALUES (${input.provider}, ${input.intent}, 'pending', ${sha256Hex(state)}, ${sha256Hex(input.binding)}, ${sha256Hex(nonce)},
            ${verifier}, ${input.userId ?? null}, ${input.sessionSid ?? null}, ${JSON.stringify(input.context)}::jsonb,
            ${ts(new Date(now.getTime() + OAUTH_TX_TTL_MS))}, ${ts(now)}, ${ts(now)},
            ${input.appTicket ? sha256Hex(input.appTicket) : null})
    RETURNING id`;
  return { id: Number(row.id), state, nonce, codeChallenge: challenge };
}

// ── Lecture ─────────────────────────────────────────────────────────────────

export async function findByState(state: string): Promise<AuthTransaction | null> {
  if (typeof state !== 'string' || state.length < 16 || state.length > 256) return null;
  const rows = await pgClient<Row[]>`SELECT ${pgClient.unsafe(COLUMNS)} FROM auth_transactions WHERE state_hash = ${sha256Hex(state)}`;
  return rows[0] ? toTx(rows[0]) : null;
}

export async function findById(id: number): Promise<AuthTransaction | null> {
  const rows = await pgClient<Row[]>`SELECT ${pgClient.unsafe(COLUMNS)} FROM auth_transactions WHERE id = ${id}`;
  return rows[0] ? toTx(rows[0]) : null;
}

/** Étape d'inscription en attente de CE navigateur (la plus récente, non expirée). */
export async function findAwaitingByBinding(binding: string | null, now = new Date()): Promise<AuthTransaction | null> {
  if (!binding) return null;
  const rows = await pgClient<Row[]>`
    SELECT ${pgClient.unsafe(COLUMNS)} FROM auth_transactions
     WHERE binding_hash = ${sha256Hex(binding)} AND status = 'awaiting_user' AND expires_at > ${ts(now)}
     ORDER BY id DESC LIMIT 1`;
  return rows[0] ? toTx(rows[0]) : null;
}

export function isExpired(tx: AuthTransaction, now = new Date()): boolean {
  return tx.expiresAt.getTime() <= now.getTime();
}

// ── Transitions conditionnelles ─────────────────────────────────────────────

/** `from` → `to` si et seulement si l'état est encore `from` et non expiré. Rend la ligne à jour, ou `null`. */
export async function transition(
  id: number,
  from: TxStatus | TxStatus[],
  to: TxStatus,
  patch: { claims?: TxClaims | null; stage?: string | null; expiresAt?: Date; failureCode?: string | null; handoffHash?: string | null; userId?: number | null } = {},
  now = new Date(),
): Promise<AuthTransaction | null> {
  const froms = Array.isArray(from) ? from : [from];
  const rows = await pgClient<Row[]>`
    UPDATE auth_transactions SET
      status = ${to},
      claims = CASE WHEN ${patch.claims !== undefined} THEN ${patch.claims == null ? null : JSON.stringify(patch.claims)}::jsonb ELSE claims END,
      stage = CASE WHEN ${patch.stage !== undefined} THEN ${patch.stage ?? null} ELSE stage END,
      expires_at = COALESCE(${patch.expiresAt ? ts(patch.expiresAt) : null}::timestamptz, expires_at),
      failure_code = CASE WHEN ${patch.failureCode !== undefined} THEN ${patch.failureCode ?? null} ELSE failure_code END,
      handoff_hash = CASE WHEN ${patch.handoffHash !== undefined} THEN ${patch.handoffHash ?? null} ELSE handoff_hash END,
      user_id = CASE WHEN ${patch.userId !== undefined} THEN ${patch.userId ?? null}::int ELSE user_id END,
      consumed_at = CASE WHEN ${to === 'consumed' || to === 'failed'} THEN ${ts(now)}::timestamptz ELSE consumed_at END,
      -- Les secrets du parcours n'ont plus d'usage une fois le code échangé.
      code_verifier = CASE WHEN ${to !== 'pending'} THEN '' ELSE code_verifier END,
      updated_at = ${ts(now)}
    WHERE id = ${id} AND status = ANY(${froms}) AND expires_at > ${ts(now)}
    RETURNING ${pgClient.unsafe(COLUMNS)}`;
  return rows[0] ? toTx(rows[0]) : null;
}

/** Échec définitif (journal), quel que soit l'état non terminal. */
export async function markFailed(id: number, code: string, now = new Date()): Promise<void> {
  await pgClient`
    UPDATE auth_transactions SET status = 'failed', failure_code = ${code.slice(0, 60)}, consumed_at = ${ts(now)}, code_verifier = '', updated_at = ${ts(now)}
     WHERE id = ${id} AND status NOT IN ('consumed', 'failed')`;
}

/** Inscription en attente : profil choisi, adresse à vérifier, code haché. */
export async function setPendingEmailCode(
  id: number,
  input: { stage: string; pendingEmail: string; codeHash: string; codeExpiresAt: Date; profile: Record<string, unknown> },
  now = new Date(),
): Promise<boolean> {
  const rows = await pgClient`
    UPDATE auth_transactions SET
      stage = ${input.stage}, pending_email = ${input.pendingEmail}, email_code_hash = ${input.codeHash},
      email_code_expires_at = ${ts(input.codeExpiresAt)}, email_code_attempts = 0, email_code_sent_at = ${ts(now)},
      context = context || ${JSON.stringify({ profile: input.profile })}::jsonb, updated_at = ${ts(now)}
    WHERE id = ${id} AND status = 'awaiting_user' AND expires_at > ${ts(now)}
    RETURNING id`;
  return rows.length === 1;
}

/** Une tentative de code de plus (comptée AVANT la comparaison). Rend le nombre de tentatives, ou `null`. */
export async function countEmailCodeAttempt(id: number, now = new Date()): Promise<number | null> {
  const rows = await pgClient<{ n: number }[]>`
    UPDATE auth_transactions SET email_code_attempts = email_code_attempts + 1, updated_at = ${ts(now)}
     WHERE id = ${id} AND status = 'awaiting_user' AND expires_at > ${ts(now)}
    RETURNING email_code_attempts AS n`;
  return rows[0] ? Number(rows[0].n) : null;
}

/**
 * Lot 97B — le navigateur système présente le ticket créé par la vue de
 * l'application (association / confirmation Google / Apple depuis Mon compte).
 * Consommation ATOMIQUE et à usage unique : le ticket est effacé, `state`,
 * `nonce` et la liaison au navigateur sont tirés À NOUVEAU (ceux de la
 * création n'ont jamais quitté le serveur) ; seul ce navigateur pourra donc
 * revenir du fournisseur. Rend la transaction et les secrets à transmettre,
 * ou `null` (inconnu, déjà utilisé, expiré, autre usage).
 */
export async function claimAppTicket(
  ticket: string, now = new Date(),
): Promise<{ tx: AuthTransaction; state: string; nonce: string; binding: string } | null> {
  if (typeof ticket !== 'string' || ticket.length < 16 || ticket.length > 256) return null;
  const state = randomToken(32);
  const nonce = randomToken(32);
  const binding = randomToken(32);
  const rows = await pgClient<Row[]>`
    UPDATE auth_transactions SET
      app_ticket_hash = NULL, state_hash = ${sha256Hex(state)}, nonce_hash = ${sha256Hex(nonce)},
      binding_hash = ${sha256Hex(binding)}, updated_at = ${ts(now)}
     WHERE app_ticket_hash = ${sha256Hex(ticket)} AND status = 'pending' AND intent IN ('link', 'reauth')
       AND context->>'client' = 'app' AND expires_at > ${ts(now)}
    RETURNING ${pgClient.unsafe(COLUMNS)}`;
  return rows[0] ? { tx: toTx(rows[0]), state, nonce, binding } : null;
}

/** Échange final de l'application : code d'échange à usage unique (§21.3). */
export async function consumeHandoff(handoff: string, now = new Date()): Promise<AuthTransaction | null> {
  if (typeof handoff !== 'string' || handoff.length < 16 || handoff.length > 256) return null;
  const rows = await pgClient<Row[]>`
    UPDATE auth_transactions SET status = 'consumed', consumed_at = ${ts(now)}, handoff_hash = NULL, updated_at = ${ts(now)}
     WHERE handoff_hash = ${sha256Hex(handoff)} AND status = 'handoff' AND expires_at > ${ts(now)}
    RETURNING ${pgClient.unsafe(COLUMNS)}`;
  return rows[0] ? toTx(rows[0]) : null;
}

/** Purge (tâche interne `auth-rate-limits-purge`) : transactions terminées ou expirées depuis plus d'un jour. */
export async function purgeAuthTransactions(now = new Date()): Promise<number> {
  const rows = await pgClient<{ n: number }[]>`
    WITH d AS (DELETE FROM auth_transactions WHERE expires_at < ${ts(new Date(now.getTime() - 24 * 3600 * 1000))} RETURNING 1)
    SELECT count(*)::int AS n FROM d`;
  return rows[0]?.n ?? 0;
}
