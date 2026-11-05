import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { guardAdmin, NO_STORE, opsError } from '../_shared';
import { readMfaEnforcementSettings, writeMfaEnforcementSetting } from '@/lib/auth/mfa/policy';
import { keyRingStatus } from '@/lib/auth/mfa/secret-box';
import { webAuthnStatus } from '@/lib/auth/mfa/passkeys';
import { MFA_ENFORCEMENT_SCOPES, type MfaEnforcementScope } from '@/lib/auth/mfa/constants';
import { logAdminAction } from '@/lib/admin-audit';
import { logUserActivity } from '@/lib/audit-logger';

export const dynamic = 'force-dynamic';

/** Phrase de confirmation exigée pour ACTIVER une obligation (saisie explicite). */
const CONFIRMATION = 'ACTIVER';

/**
 * BO › Exploitation › Double authentification (lot 110B).
 *
 * GET : réglages (date d'entrée en vigueur par population, `null` = non
 * activée), état de la configuration (trousseau de chiffrement, origines
 * WebAuthn — noms et identifiants seulement, jamais une valeur secrète),
 * nombre de comptes protégés.
 *
 * PUT { scope: 'users' | 'admins', enforcedFrom: ISO | null, confirm? } :
 * programme (date future, affichable pour la communication), active
 * immédiatement (date ≤ maintenant) ou retire l'obligation (`null`). Retirer
 * l'obligation ne désactive JAMAIS la double authentification d'un compte
 * qui a enrôlé un facteur. Activation : phrase « ACTIVER » exigée ; journal
 * BO (avant / après).
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    const { pgClient } = await import('@/db');
    const settings = await readMfaEnforcementSettings();
    const [c] = await pgClient<{ users: number; users_protected: number; admins: number; admins_protected: number }[]>`
      SELECT COUNT(*) FILTER (WHERE u.status <> 'DELETED')::int AS users,
             COUNT(*) FILTER (WHERE u.status <> 'DELETED' AND m.enabled_at IS NOT NULL)::int AS users_protected,
             COUNT(*) FILTER (WHERE u.role IN ('ADMIN', 'SUPER_ADMIN'))::int AS admins,
             COUNT(*) FILTER (WHERE u.role IN ('ADMIN', 'SUPER_ADMIN') AND m.enabled_at IS NOT NULL)::int AS admins_protected
        FROM users u LEFT JOIN user_mfa_state m ON m.user_id = u.id`;
    const now = Date.now();
    const view = (d: Date | null) => ({ enforcedFrom: d?.toISOString() ?? null, active: !!d && d.getTime() <= now, scheduled: !!d && d.getTime() > now });
    return NextResponse.json({
      users: view(settings.users),
      admins: view(settings.admins),
      counts: c ?? { users: 0, users_protected: 0, admins: 0, admins_protected: 0 },
      totpKeys: keyRingStatus(),
      webauthn: webAuthnStatus(),
      environment: process.env.VEREBONA_ENV ?? process.env.NODE_ENV ?? 'inconnu',
    }, { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'double authentification', 'OPS_MFA_FAILED');
  }
}

export async function PUT(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const body = (await request.json().catch(() => ({}))) as { scope?: unknown; enforcedFrom?: unknown; confirm?: unknown };
  const scope = MFA_ENFORCEMENT_SCOPES.find((s) => s === body.scope) as MfaEnforcementScope | undefined;
  if (!scope) return NextResponse.json({ error: 'Population inconnue', code: 'INVALID_SCOPE' }, { status: 400, headers: NO_STORE });
  let next: Date | null = null;
  if (body.enforcedFrom !== null) {
    const t = typeof body.enforcedFrom === 'string' ? Date.parse(body.enforcedFrom) : NaN;
    if (!Number.isFinite(t)) return NextResponse.json({ error: 'Date invalide', code: 'INVALID_DATE', message: 'Indiquez une date et une heure valides.' }, { status: 400, headers: NO_STORE });
    // Jamais antidatée : « maintenant » au plus tôt (aucune activation rétroactive affichée).
    next = new Date(Math.max(t, Date.now()));
    if (body.confirm !== CONFIRMATION) {
      return NextResponse.json({ error: 'Confirmation requise', code: 'CONFIRMATION_REQUIRED', message: `Saisissez ${CONFIRMATION} pour confirmer.` }, { status: 400, headers: NO_STORE });
    }
    // Intégration lot 110 : jamais d'obligation sans moyen de s'y conformer. Sans trousseau TOTP
    // (MFA_ENCRYPTION_KEYS) ni configuration WebAuthn (WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS) valides,
    // aucun compte ne pourrait enrôler de facteur : tous seraient bloqués. Le retrait (null) reste toujours possible.
    const keys = keyRingStatus();
    const web = webAuthnStatus();
    const keysOk = keys.problem === null && (keys.configured || process.env.NODE_ENV !== 'production');
    if (!keysOk || !web.available) {
      const manque = [!keysOk ? 'MFA_ENCRYPTION_KEYS' : null, !web.available ? 'WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS' : null].filter(Boolean).join(', ');
      return NextResponse.json({
        error: 'Configuration incomplète', code: 'MFA_NOT_CONFIGURED',
        message: `Activation impossible : variables à poser sur Scalingo d’abord (${manque}).`,
      }, { status: 409, headers: NO_STORE });
    }
  }
  try {
    const before = await readMfaEnforcementSettings();
    await writeMfaEnforcementSetting(scope, next, g.adminId);
    void logAdminAction({
      adminId: g.adminId, action: 'MFA_ENFORCEMENT_UPDATE', targetType: 'MFA_ENFORCEMENT', targetId: null, result: 'SUCCESS',
      before: { scope, enforcedFrom: before[scope]?.toISOString() ?? null }, after: { scope, enforcedFrom: next?.toISOString() ?? null },
    });
    void logUserActivity({ activityType: 'MFA_ENFORCEMENT_CHANGED', userId: g.adminId, userEmail: '', details: { scope, enforcedFrom: next?.toISOString() ?? null }, request });
    return NextResponse.json({ success: true, scope, enforcedFrom: next?.toISOString() ?? null }, { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'double authentification (réglage)', 'OPS_MFA_FAILED');
  }
}
