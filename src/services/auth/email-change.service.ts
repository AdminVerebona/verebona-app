/**
 * Changement de l'ADRESSE E-MAIL PRINCIPALE — lot 96A (CDC 18 §11.3,
 * EMAIL-03..07, §22, §23.1 ; décision PO Q8 ; P6).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PARCOURS
 *
 *   1. Mon compte › Sécurité › Adresse e-mail : preuve de réauthentification
 *      fraîche de CETTE session (lot 92, 5 min ; mot de passe, Google ou
 *      Apple — social-only compris) → `requestEmailChange`.
 *   2. Une demande est enregistrée (`email_change_requests`) et un lien à
 *      usage unique part vers la NOUVELLE adresse. Délai PROPRE au lien
 *      (`EMAIL_CHANGE_LINK_TTL_MS`, 24 h — EMAIL-02), indépendant des 5 min.
 *      L'ancienne adresse reste l'adresse principale et l'identifiant de
 *      connexion tant que le lien n'est pas validé (EMAIL-04).
 *   3. Adresse déjà utilisée par un AUTRE compte (actif) : même réponse pour
 *      le demandeur (non énumérable) — la demande est enregistrée de la même
 *      façon, mais AUCUN lien n'est envoyé : seul le titulaire de cette boîte
 *      reçoit « votre adresse a été proposée pour un autre compte » (au plus
 *      un par heure). Ni fusion, ni transfert. Une inscription NON VÉRIFIÉE
 *      sur cette adresse n'est pas un compte : elle est libérée à la bascule.
 *   4. Le lien ouvre « Confirmer ma nouvelle adresse » (session du MÊME
 *      utilisateur exigée ; un bouton — un robot de messagerie qui suit le
 *      lien ne confirme rien) → `confirmEmailChange` :
 *        · bascule ATOMIQUE (transaction) : `users.email` (identifiant de
 *          connexion e-mail + mot de passe, EMAIL-05) ; demande consommée,
 *          autres demandes annulées. `is_active` n'est pas touché ;
 *        · révocation de toutes les AUTRES sessions, y compris celles
 *          ouvertes avant le registre (borne globale, mécanisme 92
 *          « autres appareils ») ; la session courante est conservée et ses
 *          jetons réémis (l'adresse figure dans le JWT) ;
 *        · preuves de réauthentification retirées (Q7) ;
 *        · notification de sécurité aux DEUX adresses (EMAIL-07), sans
 *          exiger l'accès à l'ancienne ;
 *        · client Stripe existant mis à jour (jamais créé ni remplacé).
 *      Biens, documents, Duo, abonnement, identifiant Stripe et identités
 *      Google / Apple (clé : identifiant stable du fournisseur) inchangés.
 *
 * Choix isolés (un autre arbitrage PO se change en un point) :
 *   · `EMAIL_CHANGE_LINK_TTL_MS` — validité du lien ;
 *   · `AUTH_LIMITS.emailChangeRequestUser` / `emailChangeInUseNotice`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash, randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { pgClient } from '@/db';
import { AUTH_LIMITS, authRateLimitEnabled, getAuthRateLimiter, limitKey, normalizeEmail } from '@/lib/auth/auth-rate-limit';
import { formatSecurityIncidentDate } from '@/lib/auth/security-email';
import { logUserActivity } from '@/lib/audit-logger';
import { DEVICE_TRUST_TTL_S } from '@/lib/auth/device-trust';

/** Validité du lien envoyé à la nouvelle adresse (EMAIL-02 : 24 h), propre au lien. */
export const EMAIL_CHANGE_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const TTL_LABEL = '24 heures';

export const EMAIL_CHANGE_TEMPLATES = {
  confirmation: 'EMAIL_CHANGE_CONFIRMATION',
  changed: 'PRIMARY_EMAIL_CHANGED',
  inUse: 'EMAIL_CHANGE_ADDRESS_IN_USE',
} as const;

function appUrl(): string {
  return (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

export function hashEmailChangeToken(token: string): string {
  return createHash('sha256').update(`verebona/email-change/v1:${token}`).digest('hex');
}

/** Adresse partiellement masquée pour les e-mails de sécurité : « j***@exemple.fr ». */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

/** Contrôle de forme (le serveur fait foi ; même tolérance que l'inscription, plus stricte). */
export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export const EMAIL_CHANGE_NEUTRAL_MESSAGE =
  'Demande enregistrée. Si cette adresse peut être utilisée, un lien de confirmation vient d’y être envoyé. '
  + 'Votre adresse actuelle reste celle de votre compte tant que le lien n’est pas utilisé.';

export interface PendingEmailChange { newEmail: string; expiresAt: string; createdAt: string }

/** Demande ouverte de l'utilisateur (ou `null`). */
export async function getPendingEmailChange(userId: number, now = new Date()): Promise<PendingEmailChange | null> {
  const [row] = await pgClient<{ new_email: string; expires_at: Date; created_at: Date }[]>`
    SELECT new_email, expires_at, created_at FROM email_change_requests
     WHERE user_id = ${userId} AND consumed_at IS NULL AND cancelled_at IS NULL AND expires_at > ${now.toISOString()}
     ORDER BY created_at DESC LIMIT 1`;
  return row ? { newEmail: row.new_email, expiresAt: new Date(row.expires_at).toISOString(), createdAt: new Date(row.created_at).toISOString() } : null;
}

export async function cancelEmailChange(userId: number, reason = 'USER_CANCELLED'): Promise<number> {
  const rows = await pgClient`
    UPDATE email_change_requests SET cancelled_at = now(), cancel_reason = ${reason}
     WHERE user_id = ${userId} AND consumed_at IS NULL AND cancelled_at IS NULL
    RETURNING id`;
  return rows.length;
}

export type RequestEmailChangeResult =
  | { ok: true; pending: PendingEmailChange; /** Usage interne et tests : jamais renvoyé au client. */ delivered: 'link' | 'in_use_notice' | 'in_use_throttled' | 'failed' }
  | { ok: false; code: 'INVALID_EMAIL' | 'SAME_EMAIL' | 'RATE_LIMITED'; message: string; retryAfterSeconds?: number };

/**
 * Enregistre la demande et envoie le lien (ou, adresse prise, l'information au
 * titulaire). L'appelant a vérifié la preuve de réauthentification.
 */
export async function requestEmailChange(input: {
  request?: NextRequest; userId: number; sid: string | null; reauthMethod: string | null; newEmail: unknown; now?: Date;
}): Promise<RequestEmailChangeResult> {
  const now = input.now ?? new Date();
  const newEmail = normalizeEmail(input.newEmail);
  if (!isPlausibleEmail(newEmail)) {
    return { ok: false, code: 'INVALID_EMAIL', message: 'Saisissez une adresse e-mail valide.' };
  }
  const [me] = await pgClient<{ email: string; first_name: string | null }[]>`SELECT email, first_name FROM users WHERE id = ${input.userId}`;
  if (!me) throw new Error('USER_NOT_FOUND');
  if (normalizeEmail(me.email) === newEmail) {
    return { ok: false, code: 'SAME_EMAIL', message: 'C’est déjà l’adresse de votre compte.' };
  }
  if (authRateLimitEnabled()) {
    const d = await getAuthRateLimiter().consume([{ key: limitKey('email-change', 'user', String(input.userId)), policy: AUTH_LIMITS.emailChangeRequestUser }]);
    if (!d.allowed) {
      return { ok: false, code: 'RATE_LIMITED', message: 'Trop de demandes. Réessayez un peu plus tard.', retryAfterSeconds: d.retryAfterSeconds };
    }
  }

  // Adresse d'un AUTRE compte actif ? (une inscription non vérifiée ne compte pas)
  const [taken] = await pgClient<{ id: number; first_name: string | null }[]>`
    SELECT id, first_name FROM users WHERE email = ${newEmail} AND id <> ${input.userId} AND is_active = true LIMIT 1`;

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + EMAIL_CHANGE_LINK_TTL_MS);
  await pgClient.begin(async (tx) => {
    await tx`UPDATE email_change_requests SET cancelled_at = ${now.toISOString()}, cancel_reason = 'SUPERSEDED'
              WHERE user_id = ${input.userId} AND consumed_at IS NULL AND cancelled_at IS NULL`;
    // Même enregistrement que l'adresse soit libre ou prise : l'écran du
    // demandeur est identique (non énumérable). Adresse prise : le lien n'est
    // jamais envoyé, et la bascule revérifie de toute façon la disponibilité.
    await tx`
      INSERT INTO email_change_requests (user_id, old_email, new_email, token_hash, requested_sid, reauth_method, created_at, expires_at)
      VALUES (${input.userId}, ${me.email}, ${newEmail}, ${hashEmailChangeToken(token)}, ${input.sid}, ${input.reauthMethod},
              ${now.toISOString()}, ${expiresAt.toISOString()})`;
  });

  const { emailService } = await import('@/lib/email/email-service');
  let delivered: 'link' | 'in_use_notice' | 'in_use_throttled' | 'failed';
  if (taken) {
    const d = authRateLimitEnabled()
      ? await getAuthRateLimiter().consume([{ key: limitKey('email-change', 'acct', newEmail), policy: AUTH_LIMITS.emailChangeInUseNotice }])
      : { allowed: true };
    if (!d.allowed) {
      delivered = 'in_use_throttled';
    } else {
      const res = await emailService.send({
        templateCode: EMAIL_CHANGE_TEMPLATES.inUse,
        to: newEmail,
        userId: taken.id,
        variables: { firstName: taken.first_name?.trim() || '', requestDate: formatSecurityIncidentDate(now), loginUrl: `${appUrl()}/login` },
      }).catch(() => null);
      delivered = res?.success ? 'in_use_notice' : 'failed';
    }
  } else {
    const res = await emailService.send({
      templateCode: EMAIL_CHANGE_TEMPLATES.confirmation,
      to: newEmail,
      userId: input.userId,
      variables: {
        firstName: me.first_name?.trim() || '',
        confirmUrl: `${appUrl()}/mon-compte/confirmer-adresse?token=${encodeURIComponent(token)}`,
        expiresIn: TTL_LABEL,
      },
    }).catch(() => null);
    delivered = res?.success ? 'link' : 'failed';
  }

  // Journal §23.1 — l'issue réelle (adresse prise ou non) reste interne.
  void logUserActivity({
    activityType: 'PRIMARY_EMAIL_CHANGE_REQUESTED',
    userId: input.userId,
    userEmail: me.email,
    details: { reauthMethod: input.reauthMethod, outcome: delivered, expiresAt: expiresAt.toISOString() },
    request: input.request,
  });
  return {
    ok: true,
    delivered,
    pending: { newEmail, expiresAt: expiresAt.toISOString(), createdAt: now.toISOString() },
  };
}

export type ConfirmEmailChangeResult =
  | { ok: true; oldEmail: string; newEmail: string }
  | { ok: false; code: 'INVALID_LINK' | 'LINK_EXPIRED' | 'LINK_USED' | 'WRONG_ACCOUNT' | 'ADDRESS_UNAVAILABLE'; message: string };

export const CONFIRM_MESSAGES = {
  INVALID_LINK: 'Ce lien n’est pas valable. Demandez un nouveau changement d’adresse depuis Mon compte › Sécurité.',
  LINK_EXPIRED: 'Ce lien a expiré. Votre adresse n’a pas changé : refaites la demande depuis Mon compte › Sécurité.',
  LINK_USED: 'Ce lien a déjà été utilisé ou remplacé par une demande plus récente.',
  WRONG_ACCOUNT: 'Ce lien concerne un autre compte que celui avec lequel vous êtes connecté. Connectez-vous avec le bon compte, puis rouvrez le lien.',
  ADDRESS_UNAVAILABLE: 'Cette adresse ne peut pas être utilisée pour votre compte. Votre adresse n’a pas changé.',
} as const;

/**
 * Bascule ATOMIQUE de l'adresse principale. Ne touche ni aux sessions, ni aux
 * preuves, ni aux notifications : la route s'en charge après le succès
 * (`finalizeEmailChange`).
 */
export async function confirmEmailChange(input: { userId: number; token: unknown; now?: Date }): Promise<ConfirmEmailChangeResult> {
  const now = input.now ?? new Date();
  const fail = (code: keyof typeof CONFIRM_MESSAGES): ConfirmEmailChangeResult => ({ ok: false, code, message: CONFIRM_MESSAGES[code] });
  if (typeof input.token !== 'string' || input.token.length < 20 || input.token.length > 200) return fail('INVALID_LINK');
  const tokenHash = hashEmailChangeToken(input.token);

  const [req] = await pgClient<{ id: number; user_id: number; old_email: string; new_email: string; expires_at: Date; consumed_at: Date | null; cancelled_at: Date | null }[]>`
    SELECT id, user_id, old_email, new_email, expires_at, consumed_at, cancelled_at FROM email_change_requests WHERE token_hash = ${tokenHash}`;
  if (!req) return fail('INVALID_LINK');
  if (Number(req.user_id) !== input.userId) return fail('WRONG_ACCOUNT');
  if (req.consumed_at || req.cancelled_at) return fail('LINK_USED');
  if (new Date(req.expires_at) <= now) return fail('LINK_EXPIRED');

  // Adresse prise entre-temps par un AUTRE compte actif : refus, sans fusion ni transfert.
  const [taken] = await pgClient`SELECT 1 FROM users WHERE email = ${req.new_email} AND id <> ${input.userId} AND is_active = true LIMIT 1`;
  if (taken) {
    await pgClient`UPDATE email_change_requests SET cancelled_at = ${now.toISOString()}, cancel_reason = 'ADDRESS_IN_USE' WHERE id = ${req.id} AND consumed_at IS NULL`;
    return fail('ADDRESS_UNAVAILABLE');
  }
  // Inscription NON VÉRIFIÉE sur cette adresse : pas un compte, libérée (lot 57A).
  const { releaseUnverifiedEmail } = await import('@/services/auth/release-unverified-email');
  await releaseUnverifiedEmail(req.new_email);

  try {
    const outcome = await pgClient.begin(async (tx) => {
      const consumed = await tx`
        UPDATE email_change_requests SET consumed_at = ${now.toISOString()}
         WHERE id = ${req.id} AND consumed_at IS NULL AND cancelled_at IS NULL AND expires_at > ${now.toISOString()}
        RETURNING id`;
      if (consumed.length === 0) return 'LINK_USED' as const;
      // Identifiant de connexion : l'ancienne adresse doit être encore celle du compte.
      const switched = await tx`
        UPDATE users SET email = ${req.new_email}, updated_at = ${now.toISOString()}
         WHERE id = ${input.userId} AND email = ${req.old_email} AND is_active = true
        RETURNING id`;
      if (switched.length === 0) throw new Error('EMAIL_CHANGE_STALE');
      await tx`UPDATE email_change_requests SET cancelled_at = ${now.toISOString()}, cancel_reason = 'SUPERSEDED'
                WHERE user_id = ${input.userId} AND id <> ${req.id} AND consumed_at IS NULL AND cancelled_at IS NULL`;
      return 'OK' as const;
    });
    if (outcome === 'LINK_USED') return fail('LINK_USED');
  } catch (e) {
    if ((e as Error)?.message === 'EMAIL_CHANGE_STALE') return fail('LINK_USED');
    // Course avec une inscription / un changement concurrent : index unique.
    if ((e as { code?: string })?.code === '23505') return fail('ADDRESS_UNAVAILABLE');
    throw e;
  }
  return { ok: true, oldEmail: req.old_email, newEmail: req.new_email };
}

/**
 * Après la bascule : notifications aux deux adresses et client Stripe.
 * Jamais bloquant (la bascule est acquise) ; rend le résultat pour le journal.
 */
export async function notifyEmailChanged(input: { userId: number; oldEmail: string; newEmail: string; at?: Date }): Promise<{ notified: string[]; stripe: { updated: number; failed: number } }> {
  const at = input.at ?? new Date();
  const [me] = await pgClient<{ first_name: string | null }[]>`SELECT first_name FROM users WHERE id = ${input.userId}`;
  const { emailService } = await import('@/lib/email/email-service');
  const variables = {
    firstName: me?.first_name?.trim() || '',
    oldEmail: maskEmail(input.oldEmail),
    newEmail: maskEmail(input.newEmail),
    changeDate: formatSecurityIncidentDate(at),
    securityUrl: `${appUrl()}/mon-compte#securite`,
    forgotPasswordUrl: `${appUrl()}/forgot-password`,
  };
  const notified: string[] = [];
  // Ancienne adresse d'abord : c'est elle qui protège le titulaire si le changement n'est pas de lui.
  for (const to of [input.oldEmail, input.newEmail]) {
    try {
      const r = await emailService.send({ templateCode: EMAIL_CHANGE_TEMPLATES.changed, to, userId: input.userId, variables });
      if (r?.success) notified.push(to);
      else console.error('[email-change] notification non acceptée pour l’utilisateur', input.userId);
    } catch (e) {
      console.error('[email-change] notification en échec :', (e as Error)?.message ?? e);
    }
  }
  let stripe = { updated: 0, failed: 0 };
  try {
    const { syncStripeCustomerEmail } = await import('@/lib/stripe-customer');
    const s = await syncStripeCustomerEmail(input.userId, input.newEmail);
    stripe = { updated: s.updated.length, failed: s.failed.length };
  } catch (e) {
    console.error('[email-change] synchronisation Stripe impossible :', (e as Error)?.message ?? e);
  }
  return { notified, stripe };
}

/**
 * Purge : demandes terminées (annulées, expirées) depuis plus de 30 jours ;
 * demandes CONFIRMÉES après 180 jours (durée du cookie d'appareil reconnu) :
 * la plus ancienne donne l'adresse d'origine du compte, qui seule permet
 * d'accepter sans usurpation les entrées d'appareil héritées
 * (`lib/auth/device-account.ts`, intégration 96).
 */
export async function purgeEmailChangeRequests(now = new Date()): Promise<number> {
  try {
    const limit = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const confirmedLimit = new Date(now.getTime() - DEVICE_TRUST_TTL_S * 1000).toISOString();
    const rows = await pgClient`
      DELETE FROM email_change_requests
       WHERE (consumed_at IS NULL AND COALESCE(cancelled_at, expires_at) < ${limit})
          OR (consumed_at IS NOT NULL AND consumed_at < ${confirmedLimit})
      RETURNING id`;
    return rows.length;
  } catch (e) {
    if ((e as { code?: string })?.code === '42P01') return 0;
    throw e;
  }
}
