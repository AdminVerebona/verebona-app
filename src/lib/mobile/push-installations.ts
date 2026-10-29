/**
 * Registre des installations push mobiles — lot 97 (CDC 12 §18.1, PUSH-07..09,
 * AUTH-10, AUTH-13, DUO-05, Annexe A ; migration 0814).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE INSTALLATION = UN APPAREIL LOGIQUE = L'UTILISATEUR CONNECTÉ
 *
 *   · enregistrement idempotent par identifiant d'installation : rejouer le
 *     même appel ne crée rien de plus ; un nouveau jeton (rotation FCM) ou
 *     une nouvelle version d'app met la ligne à jour ;
 *   · un appareil sur lequel un AUTRE utilisateur se connecte est
 *     réattribué à ce dernier (jamais deux utilisateurs pour un téléphone) ;
 *   · un même jeton présent sur une autre installation (réinstallation,
 *     restauration de sauvegarde du téléphone) : l'ancienne est révoquée —
 *     aucun push d'un compte précédent n'arrive sur l'appareil ;
 *   · déconnexion / révocation de session : `deactivatePushForSession`
 *     (branchée par l'intégration sur `onSessionRevoked` du registre des
 *     sessions, sous-lot 92) — l'appareil ne reçoit plus rien, les autres
 *     appareils de l'utilisateur ne sont pas touchés ;
 *   · une installation non active n'a plus de jeton (colonnes vidées).
 *
 * Jamais de jeton en clair dans un journal, une réponse ou un export.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { parseEnvironment } from '@/services/ai/config/environment';
import type { MobilePlatform } from './client-context';
import { decryptPushToken, encryptPushToken, pushTokenHash } from './push-token-crypto';

export type InstallationStatus = 'active' | 'logged_out' | 'invalid_token' | 'revoked';

/** Environnement du serveur, enregistré sur chaque installation (préprod ≠ prod). */
export function serverPushEnvironment(): 'local' | 'preprod' | 'production' {
  return parseEnvironment(process.env.NEXT_PUBLIC_APP_ENV) ?? 'local';
}

/** Jeton push accepté : chaîne opaque imprimable, bornée (FCM ~ 160-200 caractères). */
export function isValidPushToken(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 20 && v.length <= 4096 && /^[\x21-\x7e]+$/.test(v);
}

export interface RegisterInput {
  userId: number;
  accountId: number | null;
  sessionId: string | null;
  installationId: string;
  platform: MobilePlatform;
  appVersion: string | null;
  build: string | null;
  pushToken: string;
}

export interface RegisterResult {
  id: string;
  created: boolean;
  /** L'installation appartenait à un autre utilisateur (changement de compte sur l'appareil). */
  reassigned: boolean;
  /** Autres installations révoquées parce qu'elles portaient le même jeton. */
  revokedDuplicates: number;
}

export async function registerPushInstallation(input: RegisterInput): Promise<RegisterResult> {
  const hash = pushTokenHash(input.pushToken);
  const enc = encryptPushToken(input.pushToken);
  const environment = serverPushEnvironment();
  return pgClient.begin(async (tx) => {
    // Sérialise les enregistrements concurrents d'un même appareil / jeton.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`mobile-push-install:${input.installationId}`}))`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`mobile-push-token:${hash}`}))`;
    const doublons = await tx`
      UPDATE mobile_push_installations
         SET status = 'revoked', status_reason = 'token_reassigned', push_token_enc = NULL, push_token_hash = NULL,
             revoked_at = now(), updated_at = now()
       WHERE push_token_hash = ${hash} AND installation_id <> ${input.installationId}
      RETURNING id`;
    const [avant] = await tx<{ user_id: number }[]>`
      SELECT user_id FROM mobile_push_installations WHERE installation_id = ${input.installationId} FOR UPDATE`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO mobile_push_installations
        (installation_id, user_id, account_id, platform, app_version, build_number, push_provider,
         push_token_enc, push_token_hash, environment, status, session_id, last_seen_at)
      VALUES (${input.installationId}, ${input.userId}, ${input.accountId}, ${input.platform}, ${input.appVersion}, ${input.build}, 'fcm',
              ${enc}, ${hash}, ${environment}, 'active', ${input.sessionId}, now())
      ON CONFLICT (installation_id) DO UPDATE SET
        user_id = EXCLUDED.user_id, account_id = EXCLUDED.account_id, platform = EXCLUDED.platform,
        app_version = EXCLUDED.app_version, build_number = EXCLUDED.build_number,
        push_token_enc = EXCLUDED.push_token_enc, push_token_hash = EXCLUDED.push_token_hash,
        environment = EXCLUDED.environment, status = 'active', status_reason = NULL, session_id = EXCLUDED.session_id,
        failure_count = 0, last_error_code = NULL, revoked_at = NULL, last_seen_at = now(), updated_at = now()
      RETURNING id::text AS id`;
    return {
      id: row.id,
      created: !avant,
      reassigned: !!avant && Number(avant.user_id) !== input.userId,
      revokedDuplicates: doublons.length,
    };
  });
}

/**
 * Désinscription de l'appareil courant (déconnexion, push désactivé dans
 * l'app). Idempotente ; sans effet sur l'installation d'un autre utilisateur.
 */
export async function unregisterPushInstallation(userId: number, installationId: string, reason = 'user_unregistered'): Promise<boolean> {
  const r = await pgClient`
    UPDATE mobile_push_installations
       SET status = 'logged_out', status_reason = ${reason}, push_token_enc = NULL, push_token_hash = NULL,
           revoked_at = now(), updated_at = now()
     WHERE installation_id = ${installationId} AND user_id = ${userId} AND status = 'active'
    RETURNING id`;
  return r.length > 0;
}

export interface SessionRef {
  /** Famille de session (`sid` du jeton). */
  sessionId?: string | null;
  /** Identifiant d'installation (en-tête `X-Verebona-Installation-Id`). */
  installationId?: string | null;
  /** Restreint à cet utilisateur (recommandé quand il est connu). */
  userId?: number | null;
}

/**
 * Lot 97 — AUTH-10 / PUSH-08 : désactive le push des appareils rattachés à
 * une session révoquée (déconnexion, révocation d'appareil, changement de
 * mot de passe). À BRANCHER par l'intégration sur `onSessionRevoked(session)`
 * du registre des sessions (sous-lot 92) :
 *
 *   onSessionRevoked((s) => deactivatePushForSession({ sessionId: s.sid, installationId: s.installationId, userId: s.userId }))
 *
 * Au moins un critère parmi `sessionId` / `installationId` est requis ; sans
 * aucun, rien n'est fait (jamais « tout désactiver » par erreur). Ne lève
 * jamais : une révocation de session ne doit pas échouer à cause du push.
 */
export async function deactivatePushForSession(ref: SessionRef, reason = 'session_revoked'): Promise<number> {
  const sid = ref.sessionId?.trim() || null;
  const inst = ref.installationId?.trim() || null;
  if (!sid && !inst) return 0;
  try {
    const r = await pgClient`
      UPDATE mobile_push_installations
         SET status = 'logged_out', status_reason = ${reason}, push_token_enc = NULL, push_token_hash = NULL,
             revoked_at = now(), updated_at = now()
       WHERE status = 'active'
         AND ((${sid}::text IS NOT NULL AND session_id = ${sid}) OR (${inst}::text IS NOT NULL AND installation_id = ${inst}))
         AND (${ref.userId ?? null}::int IS NULL OR user_id = ${ref.userId ?? null})
      RETURNING id`;
    return r.length;
  } catch (e) {
    console.error('[mobile-push] désactivation sur révocation de session :', (e as Error).message);
    return 0;
  }
}

/**
 * Lot 94 (M2) : la session `fromSid` est remplacée par `toSid` sur le MÊME
 * appareil (reconnexion) — l'installation suit la session neuve, pour que la
 * révocation de celle-ci (« Déconnecter » cet appareil) coupe son push. Ne
 * lève jamais.
 */
export async function transferPushSession(fromSid: string, toSid: string, userId: number | null): Promise<number> {
  if (!fromSid || !toSid || fromSid === toSid) return 0;
  try {
    const r = await pgClient`
      UPDATE mobile_push_installations
         SET session_id = ${toSid}, updated_at = now()
       WHERE session_id = ${fromSid} AND status = 'active'
         AND (${userId}::int IS NULL OR user_id = ${userId})
      RETURNING id`;
    return r.length;
  } catch (e) {
    console.error('[mobile-push] rattachement à la session neuve :', (e as Error).message);
    return 0;
  }
}

/**
 * Toutes les installations actives d'un utilisateur (révocation globale de ses
 * sessions), sauf celle rattachée à la session CONSERVÉE (`exceptSessionId` :
 * « déconnecter tous les autres appareils », changement d'adresse ou de mot de
 * passe depuis cet appareil). Intégration 96 : complète le crochet
 * `onSessionRevoked`, qui ne voit que les sessions inscrites au registre —
 * une installation rattachée à une session ANTÉRIEURE au registre (ou sans
 * session connue) est ainsi coupée aussi. Une installation coupée à tort (cet
 * appareil, session héritée) se réactive d'elle-même au prochain
 * enregistrement de l'app (démarrage, retour au premier plan).
 */
export async function deactivateAllPushForUser(
  userId: number,
  reason = 'all_sessions_revoked',
  opts: { exceptSessionId?: string | null } = {},
): Promise<number> {
  const keep = opts.exceptSessionId?.trim() || null;
  const r = await pgClient`
    UPDATE mobile_push_installations
       SET status = 'logged_out', status_reason = ${reason}, push_token_enc = NULL, push_token_hash = NULL,
           revoked_at = now(), updated_at = now()
     WHERE user_id = ${userId} AND status = 'active'
       AND (${keep}::text IS NULL OR session_id IS DISTINCT FROM ${keep})
    RETURNING id`;
  return r.length;
}

export interface ActiveInstallation {
  id: string;
  installationId: string;
  platform: MobilePlatform;
  token: string | null;
}

/**
 * Installations actives d'un utilisateur dans l'environnement du serveur, jeton déchiffré.
 *
 * Lot 94 (décision PO M2) — FILET : une installation rattachée à une session
 * que le registre (sous-lot 92) dit révoquée, ou ouverte par un autre
 * utilisateur, n'est jamais servie, même si le crochet `onSessionRevoked`
 * n'a pas pu la désactiver (processus redémarré, erreur passagère). Une
 * installation sans session connue (ou session absente du registre, ouverte
 * avant son déploiement) reste servie, comme la session elle-même. Une
 * session REMPLACÉE sur le même appareil (reconnexion) n'est pas une
 * révocation : l'appareil reste servi (`transferPushSession`).
 */
export async function activeInstallationsForUser(userId: number): Promise<ActiveInstallation[]> {
  const rows = await pgClient<{ id: string; installation_id: string; platform: MobilePlatform; push_token_enc: string | null }[]>`
    SELECT i.id::text AS id, i.installation_id, i.platform, i.push_token_enc
      FROM mobile_push_installations i
     WHERE i.user_id = ${userId} AND i.status = 'active' AND i.environment = ${serverPushEnvironment()}
       AND NOT EXISTS (
         SELECT 1 FROM user_sessions s
          WHERE s.sid = i.session_id
            AND (s.user_id <> i.user_id
                 OR (s.revoked_at IS NOT NULL AND coalesce(s.revocation_reason, '') <> 'SESSION_REPLACED')))
     ORDER BY i.created_at`;
  return rows.map((r) => ({ id: r.id, installationId: r.installation_id, platform: r.platform, token: decryptPushToken(r.push_token_enc) }));
}

/** Jeton refusé par le fournisseur (PUSH-07) : installation nettoyée, jamais retentée. */
export async function markInstallationInvalid(id: string, code: string): Promise<void> {
  await pgClient`
    UPDATE mobile_push_installations
       SET status = 'invalid_token', status_reason = ${code.slice(0, 60)}, push_token_enc = NULL, push_token_hash = NULL,
           last_error_code = ${code.slice(0, 60)}, last_failure_at = now(), revoked_at = now(), updated_at = now()
     WHERE id = ${id}::uuid`;
}

export async function markInstallationSent(id: string): Promise<void> {
  await pgClient`
    UPDATE mobile_push_installations
       SET failure_count = 0, last_error_code = NULL, last_success_at = now(), updated_at = now()
     WHERE id = ${id}::uuid`;
}

export async function markInstallationFailure(id: string, code: string): Promise<void> {
  await pgClient`
    UPDATE mobile_push_installations
       SET failure_count = failure_count + 1, last_error_code = ${code.slice(0, 60)}, last_failure_at = now(), updated_at = now()
     WHERE id = ${id}::uuid`;
}

export interface InstallationView {
  id: string;
  platform: MobilePlatform;
  appVersion: string | null;
  buildNumber: string | null;
  status: InstallationStatus;
  lastSeenAt: string | null;
  lastSuccessAt: string | null;
  createdAt: string | null;
  current: boolean;
}

/** Liste minimisée des appareils de l'utilisateur (aucun jeton, aucun identifiant de session). */
export async function listInstallations(userId: number, currentInstallationId: string | null): Promise<InstallationView[]> {
  const rows = await pgClient<Array<Record<string, unknown>>>`
    SELECT id::text AS id, installation_id, platform, app_version, build_number, status,
           last_seen_at, last_success_at, created_at
      FROM mobile_push_installations
     WHERE user_id = ${userId} AND environment = ${serverPushEnvironment()}
     ORDER BY last_seen_at DESC
     LIMIT 50`;
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
  return rows.map((r) => ({
    id: String(r.id),
    platform: r.platform as MobilePlatform,
    appVersion: (r.app_version as string | null) ?? null,
    buildNumber: (r.build_number as string | null) ?? null,
    status: r.status as InstallationStatus,
    lastSeenAt: iso(r.last_seen_at),
    lastSuccessAt: iso(r.last_success_at),
    createdAt: iso(r.created_at),
    current: currentInstallationId !== null && r.installation_id === currentInstallationId,
  }));
}

/** Nombre d'appareils mobiles actifs de l'utilisateur (0 si la table manque encore). */
export async function countActiveInstallations(userId: number): Promise<number> {
  try {
    const [r] = await pgClient<{ n: number }[]>`
      SELECT count(*)::int AS n FROM mobile_push_installations
       WHERE user_id = ${userId} AND status = 'active' AND environment = ${serverPushEnvironment()}`;
    return Number(r?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Nettoyage (purge quotidienne des notifications) : PUSH-09 « l'ancien jeton
 * devient inactif à terme » — installation active non revue depuis
 * `staleDays` jours → `revoked` (jeton vidé) ; installations inactives
 * depuis plus de 90 jours supprimées.
 */
export async function purgeMobileInstallations(staleDays = mobilePushStaleDays()): Promise<{ staled: number; deleted: number }> {
  const staled = await pgClient`
    UPDATE mobile_push_installations
       SET status = 'revoked', status_reason = 'inactive', push_token_enc = NULL, push_token_hash = NULL,
           revoked_at = now(), updated_at = now()
     WHERE status = 'active' AND last_seen_at < now() - make_interval(days => ${staleDays})
    RETURNING id`;
  const deleted = await pgClient`
    DELETE FROM mobile_push_installations
     WHERE status <> 'active' AND updated_at < now() - interval '90 days'
    RETURNING id`;
  return { staled: staled.length, deleted: deleted.length };
}

/** `MOBILE_PUSH_STALE_DAYS` (défaut 180, borné 30-400). */
export function mobilePushStaleDays(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MOBILE_PUSH_STALE_DAYS);
  return Number.isInteger(n) && n >= 30 && n <= 400 ? n : 180;
}
