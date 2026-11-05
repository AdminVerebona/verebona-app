/**
 * POST /api/auth/mfa/recovery/start — début de la récupération d'accès
 * (lot 110B, ticket §5). Corps : { email }. Réponse IDENTIQUE que l'adresse
 * corresponde ou non à un compte protégé (non énumérant) ; débit limité par
 * IP (429) et par adresse (silencieux). Compte Google / Apple dont le
 * contexte provisoire est ouvert : aucun e-mail, la preuve du fournisseur
 * en tient lieu.
 */
import type { NextRequest } from 'next/server';
import { mfaJson, bodyOf } from '@/lib/auth/mfa/http';
import { readPending } from '@/lib/auth/mfa/pending';
import { randomBinding } from '@/lib/auth/mfa/challenges';
import { sendRecoveryEmailCode } from '@/lib/auth/mfa/recovery-flow';
import { consumeRecoveryEmailQuota } from '@/lib/auth/mfa/throttle';
import { normalizeEmail } from '@/lib/auth/auth-rate-limit';
import { MFA_PENDING_COOKIE_PATH, MFA_RECOVERY_BINDING_COOKIE, RECOVERY_EMAIL_CODE_TTL_MS } from '@/lib/auth/mfa/constants';

export async function POST(request: NextRequest) {
  const ctx = await readPending(request).catch(() => null);
  if (ctx && (ctx.primaryMethod === 'google' || ctx.primaryMethod === 'apple')) {
    return mfaJson({ success: true, stage: 'codes', emailCode: false });
  }
  const body = await bodyOf(request);
  const email = typeof body.email === 'string' ? body.email : (ctx?.email ?? '');
  const quota = await consumeRecoveryEmailQuota(request, normalizeEmail(email));
  if (quota.ipBlocked) return quota.ipBlocked;
  const binding = randomBinding();
  if (quota.accountAllowed) {
    try { await sendRecoveryEmailCode(email, binding); } catch (e) { console.error('[mfa] récupération : préparation du code impossible :', (e as Error)?.message ?? e); }
  }
  const res = mfaJson({ success: true, stage: 'codes', emailCode: true });
  res.cookies.set(MFA_RECOVERY_BINDING_COOKIE, binding, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax',
    maxAge: Math.floor(RECOVERY_EMAIL_CODE_TTL_MS / 1000), path: MFA_PENDING_COOKIE_PATH,
  });
  return res;
}
