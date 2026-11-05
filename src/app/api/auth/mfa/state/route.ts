/**
 * GET /api/auth/mfa/state — étape provisoire en cours (lot 110B). Contexte
 * provisoire EXIGÉ (`withPending`). Rend l'étape et les méthodes CONFIGURÉES
 * pour ce compte (jamais une méthode non enrôlée), sans aucun secret.
 */
import type { NextRequest } from 'next/server';
import { withPending, mfaJson } from '@/lib/auth/mfa/http';
import { listPasskeys } from '@/lib/auth/mfa/db';
import { hasActiveTotp } from '@/lib/auth/mfa/totp';
import { webAuthnStatus } from '@/lib/auth/mfa/passkeys';
import { readMfaEnforcementSettings } from '@/lib/auth/mfa/policy';

export async function GET(request: NextRequest) {
  return withPending(request, async (ctx) => {
    const [passkeys, totp, settings] = await Promise.all([listPasskeys(ctx.userId), hasActiveTotp(ctx.userId), readMfaEnforcementSettings()]);
    const social = ctx.primaryMethod === 'google' || ctx.primaryMethod === 'apple';
    return mfaJson({
      step: ctx.purpose,
      primaryMethod: ctx.primaryMethod,
      firstName: ctx.firstName,
      hasPassword: ctx.hasPassword,
      methods: { passkey: passkeys.length > 0, totp },
      passkeysAvailable: webAuthnStatus().available,
      factorEnrolled: !!ctx.factorEnrolledAt,
      recovered: !!ctx.recoveredAt,
      // Comptes Google / Apple : la preuve du fournisseur remplace le code e-mail à la récupération.
      recoveryNeedsEmailCode: !social,
      expiresAt: ctx.expiresAt.toISOString(),
      enforcedFrom: settings.users ? settings.users.toISOString() : null,
    });
  });
}
