/**
 * POST /api/users/me/security/mfa/recovery-codes — régénération des 10 codes
 * (lot 110B, ticket §5) : réauthentification fraîche (forte), anciens codes
 * TOUS invalidés, nouveaux affichés une seule fois, e-mail de sécurité.
 */
import type { NextRequest } from 'next/server';
import { mfaJson, mfaError } from '@/lib/auth/mfa/http';
import { requireSecurityStepUp } from '@/lib/auth/mfa/account-ops';
import { regenerateRecoveryCodes } from '@/lib/auth/mfa/recovery-codes';
import { countStrongMethods } from '@/lib/auth/mfa/db';
import { auditMfa, notifyMfaEvent } from '@/lib/auth/mfa/notify';

export async function POST(request: NextRequest) {
  const check = await requireSecurityStepUp(request, 'mfa_recovery_regenerate');
  if (!check.ok) return check.response;
  const { session } = check;
  if ((await countStrongMethods(session.userId)) === 0) return mfaError(409, 'MFA_NOT_ENROLLED', 'Ajoutez d’abord une méthode de sécurité.');
  const codes = await regenerateRecoveryCodes(session.userId);
  auditMfa(request, 'MFA_RECOVERY_CODES_REGENERATED', session.userId, { reason: 'user', count: codes.length });
  void notifyMfaEvent(session.userId, 'recovery_regenerated');
  return mfaJson({ success: true, recoveryCodes: codes });
}
