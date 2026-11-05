/**
 * Fin d'enrôlement d'un facteur (lot 110B, ticket §2, §5) : e-mail de
 * sécurité, journal, et — premier facteur ou enrôlement après récupération —
 * 10 nouveaux codes de récupération affichés UNE fois.
 */
import type { NextRequest } from 'next/server';
import { regenerateRecoveryCodes, remainingRecoveryCodes } from './recovery-codes';
import { auditMfa, notifyMfaEvent, type MfaSecurityEvent } from './notify';

export async function finishFactorEnrollment(input: {
  request: NextRequest; userId: number; event: MfaSecurityEvent; factor: 'totp' | 'passkey';
  /** Toujours de nouveaux codes (enrôlement provisoire : premier facteur ou après récupération). */
  forceNewCodes: boolean;
}): Promise<{ recoveryCodes: string[] | null }> {
  auditMfa(input.request, 'MFA_FACTOR_ADDED', input.userId, { factor: input.factor, event: input.event });
  void notifyMfaEvent(input.userId, input.event);
  const needCodes = input.forceNewCodes || (await remainingRecoveryCodes(input.userId)) === 0;
  if (!needCodes) return { recoveryCodes: null };
  const codes = await regenerateRecoveryCodes(input.userId);
  auditMfa(input.request, 'MFA_RECOVERY_CODES_REGENERATED', input.userId, { reason: 'enrollment', count: codes.length });
  return { recoveryCodes: codes };
}
