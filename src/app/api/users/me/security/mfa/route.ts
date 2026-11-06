/**
 * GET /api/users/me/security/mfa — Mon compte › Sécurité : clés d'accès,
 * application d'authentification, codes de récupération, obligation (lot
 * 110B). Aucun secret, aucun identifiant de credential, aucun code.
 * Lot 113M : `totpAvailable` (configuration serveur de l'application
 * d'authentification) pour ne proposer que les ajouts réellement possibles.
 */
import type { NextRequest } from 'next/server';
import { withSession, mfaJson } from '@/lib/auth/mfa/http';
import { loadFactorSummary } from '@/lib/auth/mfa/db';
import { mfaRequirementFor, readMfaEnforcementSettings } from '@/lib/auth/mfa/policy';
import { webAuthnStatus } from '@/lib/auth/mfa/passkeys';
import { keyRingStatus } from '@/lib/auth/mfa/secret-box';

export async function GET(request: NextRequest) {
  return withSession(request, async (session) => {
    const [f, req, settings] = await Promise.all([loadFactorSummary(session.userId), mfaRequirementFor(session.userId), readMfaEnforcementSettings()]);
    return mfaJson({
      required: req.required,
      enrolled: req.enrolled,
      sessionStrong: session.aal === 2,
      enforcedFrom: settings.users ? settings.users.toISOString() : null,
      passkeysAvailable: webAuthnStatus().available,
      // Lot 113M : trousseau TOTP utilisable (statut global, sans détail) — même règle que /api/auth/mfa/state.
      totpAvailable: keyRingStatus().problem === null,
      passkeys: f.passkeys.map((p) => ({
        id: p.id, name: p.name, createdAt: p.createdAt.toISOString(), lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
        synced: p.backedUp, deviceType: p.deviceType,
      })),
      totp: { active: f.totp.active, confirmedAt: f.totp.confirmedAt?.toISOString() ?? null },
      recoveryCodes: { remaining: f.recoveryRemaining, total: f.recoveryTotal, confirmed: !!f.recoveryConfirmedAt },
      lastMethod: f.lastMethod,
    });
  });
}
