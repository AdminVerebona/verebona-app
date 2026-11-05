/**
 * Récupération d'accès après la perte d'un facteur (lot 110B, ticket §5).
 *
 *   1. possession de l'ADRESSE du compte : code à 6 chiffres envoyé par
 *      e-mail (15 min, 5 essais, lié à ce navigateur) — pour un compte
 *      Google / Apple, la preuve FRAÎCHE du fournisseur (contexte provisoire
 *      ouvert par Google / Apple pour CE compte) en tient lieu ;
 *   2. ET un code de récupération valide (usage unique, consommé
 *      atomiquement) ;
 *   → toutes les sessions du compte sont révoquées (sessions à risque),
 *     e-mail de sécurité, puis contexte provisoire d'ENRÔLEMENT d'un nouveau
 *     facteur — aucun accès aux biens / documents avant son achèvement.
 *
 * Réponses identiques que l'adresse existe ou non (non énumérant). Tous
 * facteurs ET codes perdus : AUCUNE restauration (ni support, ni BO, ni lien
 * e-mail seul, ni facture, ni membre Duo) — voir la recette 110B.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { revokeAllUserSessions } from '@/db';
import { serverCacheDelete } from '@/lib/server-cache';
import { sessionCutoffCacheKey } from '../session-cutoff';
import { invalidateReauthProofs } from '../reauth';
import { runDetached } from '../anti-enumeration';
import { normalizeEmail } from '../auth-rate-limit';
import { sixDigitCode } from '../oauth/crypto';
import { sql } from './db';
import { checkEmailCode, storeEmailCode } from './challenges';
import { consumeRecoveryCode } from './recovery-codes';
import { cancelPending, createPending, type PendingContext } from './pending';
import { auditMfa, notifyMfaEvent } from './notify';
import { RECOVERY_EMAIL_CODE_MAX_ATTEMPTS, RECOVERY_EMAIL_CODE_TTL_MS } from './constants';

interface RecoveryUser { id: number; email: string; first_name: string | null; username: string | null; status: string; is_active: boolean; enabled: boolean }

export async function findRecoveryUser(email: unknown): Promise<RecoveryUser | null> {
  if (typeof email !== 'string' || !email.trim()) return null;
  const n = normalizeEmail(email);
  const db = await sql();
  const rows = await db<RecoveryUser[]>`
    SELECT u.id, u.email, u.first_name, u.username, u.status, u.is_active, (m.enabled_at IS NOT NULL) AS enabled
      FROM users u LEFT JOIN user_mfa_state m ON m.user_id = u.id
     WHERE u.email IN (${email.trim()}, ${n})
     ORDER BY (u.email = ${email.trim()}) DESC LIMIT 1`;
  return rows[0] ?? null;
}

const usable = (u: RecoveryUser | null): u is RecoveryUser =>
  !!u && u.is_active && u.status !== 'SUSPENDED' && u.status !== 'DELETED' && u.enabled;

/** Envoie le code e-mail si l'adresse correspond à un compte protégé (silencieux sinon). */
export async function sendRecoveryEmailCode(email: unknown, binding: string): Promise<void> {
  const u = await findRecoveryUser(email);
  if (!usable(u)) return;
  const code = sixDigitCode();
  await storeEmailCode(u.id, `rc:${binding}`, code, RECOVERY_EMAIL_CODE_TTL_MS);
  runDetached('code de récupération MFA', async () => {
    const { emailService } = await import('@/lib/email/email-service');
    const { greetingName } = await import('@/lib/user-display-name');
    const r = await emailService.send({
      templateCode: 'MFA_RECOVERY_EMAIL_CODE',
      to: u.email,
      variables: { firstName: greetingName({ firstName: u.first_name, username: u.username } as never), code, expiresIn: '15 minutes' },
      userId: u.id,
    });
    if (!r?.success) console.error('[mfa] envoi du code de récupération en échec');
  });
}

export type RecoveryOutcome = { ok: true; userId: number } | { ok: false; userId: number | null };

/** Vérifie possession de l'adresse (ou preuve fournisseur) + code de récupération. */
export async function verifyRecovery(input: {
  ctx: PendingContext | null; email: unknown; emailCode: unknown; recoveryCode: unknown; binding: string | null;
}): Promise<RecoveryOutcome> {
  const social = !!input.ctx && (input.ctx.primaryMethod === 'google' || input.ctx.primaryMethod === 'apple');
  let userId: number;
  if (social) {
    userId = input.ctx!.userId;
  } else {
    const u = await findRecoveryUser(input.email);
    if (!usable(u) || !input.binding) return { ok: false, userId: u?.id ?? null };
    if (!(await checkEmailCode(u.id, `rc:${input.binding}`, String(input.emailCode ?? ''), RECOVERY_EMAIL_CODE_MAX_ATTEMPTS))) {
      return { ok: false, userId: u.id };
    }
    userId = u.id;
  }
  if (!(await consumeRecoveryCode(userId, String(input.recoveryCode ?? '')))) return { ok: false, userId };
  return { ok: true, userId };
}

/** Après une récupération réussie : sessions révoquées, alerte, contexte d'enrôlement. */
export async function afterRecovery(request: NextRequest, response: NextResponse, userId: number, ctx: PendingContext | null): Promise<void> {
  const cutoff = await revokeAllUserSessions(userId, 'MFA_RECOVERY');
  serverCacheDelete(sessionCutoffCacheKey(userId));
  await invalidateReauthProofs(userId, { reason: 'mfa_recovery' });
  if (ctx) await cancelPending(ctx.pid).catch(() => null);
  // Le nouveau contexte doit être STRICTEMENT postérieur à la borne de révocation.
  while (Date.now() <= cutoff.getTime()) await new Promise((r) => setTimeout(r, 1));
  await createPending(response, { userId, purpose: 'enroll', primaryMethod: 'recovery', recovered: true, rememberDevice: true, returnUrl: ctx?.returnUrl ?? null });
  auditMfa(request, 'MFA_RECOVERY_USED', userId, { viaProvider: !!ctx && (ctx.primaryMethod === 'google' || ctx.primaryMethod === 'apple'), sessionsRevoked: true });
  void notifyMfaEvent(userId, 'recovery_used');
}
