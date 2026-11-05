/**
 * POST /api/auth/mfa/recovery/verify — { email, emailCode, recoveryCode }
 * (lot 110B, ticket §5). Succès : sessions du compte révoquées, e-mail de
 * sécurité, contexte provisoire d'enrôlement d'un NOUVEAU facteur (aucun
 * accès métier). Échec : message unique, échec compté (compte + IP).
 */
import type { NextRequest } from 'next/server';
import { mfaJson, mfaError, bodyOf } from '@/lib/auth/mfa/http';
import { readPending } from '@/lib/auth/mfa/pending';
import { afterRecovery, findRecoveryUser, verifyRecovery } from '@/lib/auth/mfa/recovery-flow';
import { mfaBlockedResponse, recordMfaFailure, recordMfaSuccess } from '@/lib/auth/mfa/throttle';
import { MFA_MESSAGES, MFA_PENDING_COOKIE_PATH, MFA_RECOVERY_BINDING_COOKIE } from '@/lib/auth/mfa/constants';

export async function POST(request: NextRequest) {
  const blockedIp = await mfaBlockedResponse(request, null);
  if (blockedIp) return blockedIp;
  const ctx = await readPending(request).catch(() => null);
  const body = await bodyOf(request);
  // Pause du COMPTE vérifiée avant tout essai (aucun code testé pendant une pause).
  const social = !!ctx && (ctx.primaryMethod === 'google' || ctx.primaryMethod === 'apple');
  const targetId = social ? ctx!.userId : (await findRecoveryUser(body.email ?? ctx?.email))?.id ?? null;
  if (targetId != null) {
    const blocked = await mfaBlockedResponse(request, targetId);
    if (blocked) return blocked;
  }
  const r = await verifyRecovery({
    ctx, email: body.email ?? ctx?.email, emailCode: body.emailCode, recoveryCode: body.recoveryCode,
    binding: request.cookies.get(MFA_RECOVERY_BINDING_COOKIE)?.value ?? null,
  });
  if (!r.ok) {
    await recordMfaFailure(request, r.userId, 'recovery');
    return mfaError(401, 'MFA_RECOVERY_FAILED', MFA_MESSAGES.invalidRecovery);
  }
  await recordMfaSuccess(r.userId);
  const res = mfaJson({ success: true, step: 'enroll', redirectTo: '/securiser-mon-compte' });
  await afterRecovery(request, res, r.userId, ctx);
  res.cookies.set(MFA_RECOVERY_BINDING_COOKIE, '', { httpOnly: true, maxAge: 0, path: MFA_PENDING_COOKIE_PATH });
  return res;
}
