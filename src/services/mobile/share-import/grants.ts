/**
 * Jetons d'import du partage natif — lot 110A (migration 1160).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN JETON DÉDIÉ (et pas la session)
 *
 * L'extension de partage iOS est un PROCESSUS DISTINCT de l'application : elle
 * n'a pas accès aux cookies de la vue web (HttpOnly, magasin propre à l'app),
 * et le jeton d'accès de session dure 15 min (renouvellement par rotation, que
 * seule la vue web doit faire). Sur Android, l'envoi de fond (WorkManager)
 * s'exécute application fermée. Leur donner la session complète élargirait la
 * surface (lecture de tout le compte). Ils reçoivent donc un jeton :
 *
 *   · DÉRIVÉ D'UNE SESSION : émis seulement par `POST /api/mobile/share-import/grant`
 *     derrière la garde de session habituelle (`getSession` : révocations,
 *     accès au compte, CGUV… et, après le lot 110B, la garde MFA qui s'y
 *     appliquera d'elle-même). Aucune session n'est émise ici ;
 *   · IMPORT SEUL : accepté uniquement par `/api/mobile/share-import/upload`
 *     (aucune lecture : la route ne rend que l'identifiant du document créé) ;
 *   · UN UTILISATEUR ET UN ESPACE : ceux de la session au moment de l'émission ;
 *   · COURTE DURÉE (72 h), USAGES BORNÉS (100 requêtes), RÉVOCABLE, et refusé
 *     dès que la session d'origine est révoquée (déconnexion, autres appareils,
 *     changement de mot de passe) — contrôle refait à CHAQUE usage ;
 *   · seule l'empreinte SHA-256 est stockée ; jamais journalisé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash, randomBytes } from 'node:crypto';
import { pgClient } from '@/db';
import { envNumber } from '@/lib/env-number';
import {
  SHARE_IMPORT_GRANT_MAX_USES, SHARE_IMPORT_GRANT_TTL_HOURS_DEFAULT, SHARE_IMPORT_GRANT_TTL_HOURS_MAX,
  SHARE_IMPORT_TOKEN_PATTERN, SHARE_IMPORT_TOKEN_PREFIX, shareImportAccountKey,
} from '@/lib/mobile/share-import-policy';

export type SharePlatform = 'ios' | 'android';

/** Durée de validité effective (variable Scalingo MOBILE_SHARE_IMPORT_GRANT_TTL_HOURS, bornée). */
export function shareImportGrantTtlMs(env: Record<string, string | undefined> = process.env): number {
  const h = envNumber('MOBILE_SHARE_IMPORT_GRANT_TTL_HOURS', SHARE_IMPORT_GRANT_TTL_HOURS_DEFAULT, { min: 1 }, env);
  return Math.min(h, SHARE_IMPORT_GRANT_TTL_HOURS_MAX) * 3600 * 1000;
}

export function hashShareImportToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newShareImportToken(): string {
  return `${SHARE_IMPORT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export interface GrantRow {
  id: number;
  userId: number;
  accountId: number;
  sessionSid: string | null;
  platform: SharePlatform;
  maxUses: number;
  uses: number;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export type GrantRefusal =
  | 'GRANT_INVALID' | 'GRANT_EXPIRED' | 'GRANT_REVOKED' | 'GRANT_EXHAUSTED'
  | 'SESSION_REVOKED' | 'ACCOUNT_ACCESS_REVOKED' | 'ACCOUNT_SUSPENDED' | 'ACCOUNT_PENDING_DELETION'
  | 'CGUV_REACCEPTANCE_REQUIRED' | 'FEATURE_OFF'
  // Intégration 110A × 110B : jeton de niveau 1 alors que la double authentification est exigée.
  | 'MFA_REQUIRED';

/** Décision sur la ligne du jeton seule (pure, testée). */
export function decideGrantRow(row: GrantRow | null, now: Date): { ok: true } | { ok: false; code: GrantRefusal } {
  if (!row) return { ok: false, code: 'GRANT_INVALID' };
  if (row.revokedAt) return { ok: false, code: 'GRANT_REVOKED' };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, code: 'GRANT_EXPIRED' };
  if (row.uses >= row.maxUses) return { ok: false, code: 'GRANT_EXHAUSTED' };
  return { ok: true };
}

function mapRow(r: Record<string, unknown>): GrantRow {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    accountId: Number(r.account_id),
    sessionSid: (r.session_sid as string | null) ?? null,
    platform: r.platform as SharePlatform,
    maxUses: Number(r.max_uses),
    uses: Number(r.uses),
    createdAt: new Date(r.created_at as string),
    expiresAt: new Date(r.expires_at as string),
    revokedAt: r.revoked_at ? new Date(r.revoked_at as string) : null,
  };
}

// ── Émission / révocation (appelées derrière la garde de session) ─────────

export interface IssuedGrant {
  token: string;
  expiresAt: string;
  maxUses: number;
  accountKey: string;
}

/**
 * Émet un jeton pour la session appelante ; les jetons encore actifs de la
 * MÊME session (ou, sans `sid`, de la même installation) sont révoqués
 * (rotation : un seul jeton vivant par session et appareil).
 */
export async function issueShareImportGrant(input: {
  userId: number; accountId: number; sid: string | null; platform: SharePlatform; installationId: string | null;
  /** Intégration 110A × 110B : niveau de preuve de la session émettrice (1 par défaut, fail closed). */
  sessionAal?: 1 | 2;
}, now = new Date()): Promise<IssuedGrant> {
  const token = newShareImportToken();
  const expiresAt = new Date(now.getTime() + shareImportGrantTtlMs());
  await pgClient.begin(async (tx) => {
    if (input.sid) {
      await tx`UPDATE mobile_share_import_grants SET revoked_at = ${now.toISOString()}::timestamptz, revoked_reason = 'ROTATED'
               WHERE user_id = ${input.userId} AND session_sid = ${input.sid} AND revoked_at IS NULL`;
    } else if (input.installationId) {
      await tx`UPDATE mobile_share_import_grants SET revoked_at = ${now.toISOString()}::timestamptz, revoked_reason = 'ROTATED'
               WHERE user_id = ${input.userId} AND session_sid IS NULL AND installation_id = ${input.installationId} AND revoked_at IS NULL`;
    }
    await tx`INSERT INTO mobile_share_import_grants
               (token_hash, user_id, account_id, session_sid, platform, installation_id, max_uses, uses, created_at, expires_at, session_aal)
             VALUES (${hashShareImportToken(token)}, ${input.userId}, ${input.accountId}, ${input.sid}, ${input.platform},
                     ${input.installationId}, ${SHARE_IMPORT_GRANT_MAX_USES}, 0, ${now.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz,
                     ${input.sessionAal === 2 ? 2 : 1})`;
    // Ménage borné : jetons expirés ou révoqués depuis plus de 30 jours.
    await tx`DELETE FROM mobile_share_import_grants
             WHERE user_id = ${input.userId} AND COALESCE(revoked_at, expires_at) < ${new Date(now.getTime() - 30 * 86400_000).toISOString()}::timestamptz`;
  });
  return {
    token, expiresAt: expiresAt.toISOString(), maxUses: SHARE_IMPORT_GRANT_MAX_USES,
    accountKey: shareImportAccountKey(input.userId, input.accountId),
  };
}

/** Révoque les jetons actifs d'une session (déconnexion, changement d'espace). */
export async function revokeShareImportGrants(input: { userId: number; sid: string | null; installationId?: string | null }, reason: string, now = new Date()): Promise<number> {
  const rows = input.sid
    ? await pgClient`UPDATE mobile_share_import_grants SET revoked_at = ${now.toISOString()}::timestamptz, revoked_reason = ${reason.slice(0, 40)}
                     WHERE user_id = ${input.userId} AND session_sid = ${input.sid} AND revoked_at IS NULL RETURNING id`
    : await pgClient`UPDATE mobile_share_import_grants SET revoked_at = ${now.toISOString()}::timestamptz, revoked_reason = ${reason.slice(0, 40)}
                     WHERE user_id = ${input.userId} AND session_sid IS NULL AND installation_id IS NOT DISTINCT FROM ${input.installationId ?? null}
                       AND revoked_at IS NULL RETURNING id`;
  return rows.length;
}

async function revokeGrant(id: number, reason: GrantRefusal): Promise<void> {
  await pgClient`UPDATE mobile_share_import_grants SET revoked_at = now(), revoked_reason = ${reason} WHERE id = ${id} AND revoked_at IS NULL`;
}

// ── Usage (route d'import) ─────────────────────────────────────────────────

export interface AuthenticatedGrant {
  grantId: number;
  userId: number;
  accountId: number;
  platform: SharePlatform;
}

/** Contrôles de la session d'origine, injectables pour les tests. */
export interface GrantSessionChecks {
  isAccessRevoked(p: { userId: number; sid: string | null; iatMs: number }): Promise<boolean>;
  userStatus(userId: number): Promise<string | null>;
  hasAccountAccess(userId: number, accountId: number): Promise<boolean>;
  reacceptanceRequired(userId: number): Promise<boolean>;
  featureOn(platform: SharePlatform): boolean;
  /** Double authentification exigée pour ce titulaire (garde 110B, lue sans cache). */
  mfaRequired(userId: number): Promise<boolean>;
}

async function defaultChecks(): Promise<GrantSessionChecks> {
  const [{ isAccessRevoked }, { hasActiveAccountAccess }, { isMobileFeatureEnabled }, { isPendingDeletion }] = await Promise.all([
    import('@/lib/auth/session-guard'),
    import('@/lib/auth/account-access'),
    import('@/lib/mobile/mobile-config'),
    import('@/lib/auth/account-closure'),
  ]);
  return {
    isAccessRevoked: (p) => isAccessRevoked(p),
    userStatus: async (userId) => {
      const [r] = await pgClient`SELECT status FROM users WHERE id = ${userId}`;
      const st = (r?.status as string | undefined) ?? null;
      return st && isPendingDeletion(st) ? 'PENDING_DELETION' : st;
    },
    hasAccountAccess: (u, a) => hasActiveAccountAccess(u, a),
    reacceptanceRequired: async (userId) => {
      const { isReacceptanceRequired } = await import('@/services/legal/cguv-reacceptance.service');
      return isReacceptanceRequired(userId);
    },
    featureOn: (platform) => isMobileFeatureEnabled('share_in', platform),
    mfaRequired: async (userId) => {
      const { mfaRequirementFor } = await import('@/lib/auth/mfa/policy');
      return (await mfaRequirementFor(userId)).required;
    },
  };
}

let checksOverride: GrantSessionChecks | null = null;
/** Tests uniquement. */
export function __setGrantChecksForTests(c: GrantSessionChecks | null): void { checksOverride = c; }

/**
 * Vérifie un jeton présenté et CONSOMME un usage (atomique). Les contrôles de
 * la session d'origine sont ceux de la garde de session : révocation globale
 * (borne) ou unitaire (`sid`), statut du compte, accès ACTIF à l'espace,
 * CGUV. Une session révoquée ou un accès retiré révoque aussi le jeton.
 */
export async function authenticateShareImportGrant(token: string | null | undefined, now = new Date()):
Promise<{ ok: true; grant: AuthenticatedGrant } | { ok: false; code: GrantRefusal }> {
  if (!token || !SHARE_IMPORT_TOKEN_PATTERN.test(token)) return { ok: false, code: 'GRANT_INVALID' };
  const [raw] = await pgClient`SELECT * FROM mobile_share_import_grants WHERE token_hash = ${hashShareImportToken(token)}`;
  const row = raw ? mapRow(raw as Record<string, unknown>) : null;
  const d = decideGrantRow(row, now);
  if (!d.ok || !row) return d.ok ? { ok: false, code: 'GRANT_INVALID' } : d;

  const checks = checksOverride ?? await defaultChecks();
  if (!checks.featureOn(row.platform)) return { ok: false, code: 'FEATURE_OFF' };
  if (await checks.isAccessRevoked({ userId: row.userId, sid: row.sessionSid, iatMs: row.createdAt.getTime() })) {
    await revokeGrant(row.id, 'SESSION_REVOKED');
    return { ok: false, code: 'SESSION_REVOKED' };
  }
  const status = await checks.userStatus(row.userId);
  if (status === null || status === 'SUSPENDED' || status === 'DELETED') {
    await revokeGrant(row.id, 'ACCOUNT_SUSPENDED');
    return { ok: false, code: 'ACCOUNT_SUSPENDED' };
  }
  if (status === 'PENDING_DELETION') return { ok: false, code: 'ACCOUNT_PENDING_DELETION' };
  if (!(await checks.hasAccountAccess(row.userId, row.accountId))) {
    await revokeGrant(row.id, 'ACCOUNT_ACCESS_REVOKED');
    return { ok: false, code: 'ACCOUNT_ACCESS_REVOKED' };
  }
  if (await checks.reacceptanceRequired(row.userId)) return { ok: false, code: 'CGUV_REACCEPTANCE_REQUIRED' };
  // Intégration 110A × 110B : un jeton émis par une session de niveau 1 ne dépose plus rien dès que la
  // double authentification est exigée pour son titulaire (même règle que la garde MFA des sessions).
  if (Number((raw as Record<string, unknown>).session_aal ?? 1) !== 2 && (await checks.mfaRequired(row.userId))) {
    return { ok: false, code: 'MFA_REQUIRED' };
  }

  const used = await pgClient`UPDATE mobile_share_import_grants SET uses = uses + 1, last_used_at = ${now.toISOString()}::timestamptz
                              WHERE id = ${row.id} AND revoked_at IS NULL AND expires_at > ${now.toISOString()}::timestamptz AND uses < max_uses
                              RETURNING id`;
  if (used.length === 0) return { ok: false, code: 'GRANT_EXHAUSTED' };
  return { ok: true, grant: { grantId: row.id, userId: row.userId, accountId: row.accountId, platform: row.platform } };
}
