/**
 * Registre des sessions — lot 92 (CDC 18 §20, §31.4 ; SESS-05..08, SEC-03 ;
 * décision PO Q5 : recommandation appliquée).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÔLE
 *
 * Une ligne `user_sessions` par session (famille `sid` des jetons, lot 37) :
 * appareil (empreinte first-party), type de client, libellés, création,
 * dernière activité, échéance d'inactivité, révocation, empreinte et version
 * du jeton de renouvellement courant.
 *
 *   · INSCRIPTION : à l'ouverture de session (fonction d'émission unique,
 *     `session-issuance.ts`) et, pour une session ouverte AVANT le
 *     déploiement du registre, à son prochain renouvellement (Q5 : personne
 *     n'est déconnecté au déploiement ; `registered_via = 'REFRESH'`) ;
 *   · RÉVOCATION UNITAIRE immédiate : contrôlée au renouvellement ET à chaque
 *     accès (`isSessionRevoked`, appelé par `SessionService.getSession` et
 *     `verifySessionAccessToken`, comme `isRevokedByCutoff`) ; aucun cache —
 *     une lecture par clé primaire ;
 *   · RÉVOCATION GLOBALE (borne `user_session_revocations`, lot 37) :
 *     inchangée, et reflétée dans le registre par `revokeAllUserSessions`
 *     (`@/db`) ;
 *   · PURGE : sessions expirées ou révoquées depuis plus de
 *     `SESSION_REGISTRY_RETENTION_DAYS`, tâche `auth-rate-limits-purge`.
 *
 * Le registre ne remplace PAS les protections du lot 37 : rotation atomique
 * et détection de rejeu restent portées par `revoked_tokens` (autorité),
 * l'empreinte du jeton courant (`refresh_token_hash`, `refresh_version`)
 * sert à la traçabilité et au diagnostic.
 *
 * Une session sans `sid` (jeton antérieur au lot 37) ou absente du registre
 * (ouverte avant le déploiement) n'est jamais refusée pour cette raison.
 *
 * Aucune importation statique de `@/db` : les tests unitaires installent un
 * registre en mémoire (`__setSessionRegistryStoreForTests`, setup.ts).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHmac } from 'node:crypto';
import type { SessionClientInfo } from './session-client';
import { notifySessionsRevoked, type RevokedSessionInfo, type SessionRevocationScope } from './session-hooks';
import { SESSION_UNAVAILABLE_CODE } from './session-errors';

/** Conservation des lignes terminées (expirées / révoquées) avant purge — sert aussi à « appareil déjà vu ». */
export const SESSION_REGISTRY_RETENTION_DAYS = 90;

export type SessionRegisteredVia = 'LOGIN' | 'REFRESH' | 'REISSUE';

export interface SessionRecord {
  sid: string;
  userId: number;
  deviceKey: string | null;
  deviceSource: 'installation' | 'cookie' | null;
  clientType: string;
  appVersion: string | null;
  deviceLabel: string;
  browserLabel: string;
  authMethod: string | null;
  registeredVia: SessionRegisteredVia;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revocationReason: string | null;
  refreshTokenHash: string | null;
  refreshVersion: number;
}

export interface SessionUpsert {
  sid: string;
  userId: number;
  client: SessionClientInfo;
  authMethod: string | null;
  registeredVia: SessionRegisteredVia;
  refreshTokenHash: string;
  expiresAt: Date;
  now: Date;
}

/** `created` / `updated` : ligne active ; `revoked` : session terminée (rien écrit) ; `foreign` : `sid` d'un autre utilisateur. */
export type SessionUpsertOutcome = 'created' | 'updated' | 'revoked' | 'foreign';

/** Accès au stockage (base en production et e2e, mémoire en test unitaire). */
export interface SessionRegistryStore {
  upsert(input: SessionUpsert): Promise<SessionUpsertOutcome>;
  get(sid: string): Promise<SessionRecord | null>;
  listActive(userId: number, now: Date): Promise<SessionRecord[]>;
  /** Révoque les sessions actives de `userId` qui correspondent ; rend celles révoquées par CET appel. */
  revoke(
    match: { userId: number; sid?: string; exceptSid?: string; deviceKey?: string },
    reason: string,
    now: Date,
  ): Promise<SessionRecord[]>;
  /** Une session (active ou terminée, non purgée) de cet utilisateur a-t-elle déjà utilisé cet appareil ? */
  hasDevice(userId: number, deviceKey: string, exceptSid: string): Promise<boolean>;
  purge(now: Date, retentionMs: number): Promise<number>;
}

// ── Stockage en base ──────────────────────────────────────────────────────

interface Row {
  sid: string; user_id: number; device_key: string | null; device_source: string | null; client_type: string;
  app_version: string | null; device_label: string; browser_label: string; auth_method: string | null;
  registered_via: string; created_at: Date; last_seen_at: Date; expires_at: Date; revoked_at: Date | null;
  revocation_reason: string | null; refresh_token_hash: string | null; refresh_version: number;
}

function fromRow(r: Row): SessionRecord {
  return {
    sid: r.sid,
    userId: Number(r.user_id),
    deviceKey: r.device_key,
    deviceSource: r.device_source === 'installation' || r.device_source === 'cookie' ? r.device_source : null,
    clientType: r.client_type,
    appVersion: r.app_version,
    deviceLabel: r.device_label,
    browserLabel: r.browser_label,
    authMethod: r.auth_method,
    registeredVia: (r.registered_via as SessionRegisteredVia) ?? 'LOGIN',
    createdAt: new Date(r.created_at),
    lastSeenAt: new Date(r.last_seen_at),
    expiresAt: new Date(r.expires_at),
    revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
    revocationReason: r.revocation_reason,
    refreshTokenHash: r.refresh_token_hash,
    refreshVersion: Number(r.refresh_version),
  };
}

const sqlClient = async () => (await import('@/db')).pgClient;

const dbStore: SessionRegistryStore = {
  async upsert(i) {
    const sql = await sqlClient();
    const c = i.client;
    // Horloge de l'APPLICATION (celle des jetons) pour toutes les dates.
    const rows = await sql<{ inserted: boolean }[]>`
      INSERT INTO user_sessions (
        sid, user_id, device_key, device_source, client_type, app_version, device_label, browser_label,
        auth_method, registered_via, created_at, last_seen_at, expires_at, refresh_token_hash, refresh_version)
      VALUES (
        ${i.sid}, ${i.userId}, ${c.deviceKey}, ${c.deviceSource}, ${c.clientType}, ${c.appVersion},
        ${c.deviceLabel}, ${c.browserLabel}, ${i.authMethod}, ${i.registeredVia},
        ${i.now.toISOString()}, ${i.now.toISOString()}, ${i.expiresAt.toISOString()}, ${i.refreshTokenHash}, 1)
      ON CONFLICT (sid) DO UPDATE SET
        last_seen_at = EXCLUDED.last_seen_at,
        expires_at = EXCLUDED.expires_at,
        refresh_token_hash = EXCLUDED.refresh_token_hash,
        refresh_version = user_sessions.refresh_version + 1,
        device_key = COALESCE(user_sessions.device_key, EXCLUDED.device_key),
        device_source = COALESCE(user_sessions.device_source, EXCLUDED.device_source),
        client_type = EXCLUDED.client_type,
        app_version = COALESCE(EXCLUDED.app_version, user_sessions.app_version),
        device_label = EXCLUDED.device_label,
        browser_label = EXCLUDED.browser_label
      WHERE user_sessions.revoked_at IS NULL AND user_sessions.user_id = EXCLUDED.user_id
      RETURNING (xmax = 0) AS inserted`;
    if (rows[0]) return rows[0].inserted ? 'created' : 'updated';
    const existing = await this.get(i.sid);
    return existing && existing.userId !== i.userId ? 'foreign' : 'revoked';
  },
  async get(sid) {
    const sql = await sqlClient();
    const rows = await sql<Row[]>`SELECT * FROM user_sessions WHERE sid = ${sid} LIMIT 1`;
    return rows[0] ? fromRow(rows[0]) : null;
  },
  async listActive(userId, now) {
    const sql = await sqlClient();
    const rows = await sql<Row[]>`
      SELECT * FROM user_sessions
       WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > ${now.toISOString()}
       ORDER BY last_seen_at DESC`;
    return rows.map(fromRow);
  },
  async revoke(m, reason, now) {
    const sql = await sqlClient();
    const rows = await sql<Row[]>`
      UPDATE user_sessions SET revoked_at = ${now.toISOString()}, revocation_reason = ${reason}
       WHERE user_id = ${m.userId} AND revoked_at IS NULL
         AND (${m.sid ?? null}::text IS NULL OR sid = ${m.sid ?? null})
         AND (${m.exceptSid ?? null}::text IS NULL OR sid <> ${m.exceptSid ?? null})
         AND (${m.deviceKey ?? null}::text IS NULL OR device_key = ${m.deviceKey ?? null})
      RETURNING *`;
    if (rows.length > 0) {
      await sql`DELETE FROM reauth_proofs WHERE sid IN ${sql(rows.map((r) => r.sid))}`.catch(() => null);
    }
    return rows.map(fromRow);
  },
  async hasDevice(userId, deviceKey, exceptSid) {
    const sql = await sqlClient();
    const rows = await sql`SELECT 1 FROM user_sessions WHERE user_id = ${userId} AND device_key = ${deviceKey} AND sid <> ${exceptSid} LIMIT 1`;
    return rows.length > 0;
  },
  async purge(now, retentionMs) {
    const sql = await sqlClient();
    const limit = new Date(now.getTime() - retentionMs).toISOString();
    const rows = await sql`
      DELETE FROM user_sessions
       WHERE (revoked_at IS NOT NULL AND revoked_at < ${limit}) OR expires_at < ${limit}
      RETURNING sid`;
    return rows.length;
  },
};

// Surcharge portée par `globalThis` : elle survit à `vi.resetModules()` dans les tests.
const OVERRIDE_KEY = '__verebonaSessionRegistryStore';
const store = (): SessionRegistryStore =>
  ((globalThis as Record<string, unknown>)[OVERRIDE_KEY] as SessionRegistryStore | null | undefined) ?? dbStore;

/** TESTS UNITAIRES SEULEMENT (`src/test/setup.ts`) : registre en mémoire. `null` rétablit la base. */
export function __setSessionRegistryStoreForTests(s: SessionRegistryStore | null): void {
  (globalThis as Record<string, unknown>)[OVERRIDE_KEY] = s;
}

/** Table absente (migration 0802 pas encore appliquée) : le registre est inerte, jamais bloquant. */
function isMissingTable(e: unknown): boolean {
  return (e as { code?: string })?.code === '42P01';
}

let missingTableWarned = false;
function warnMissingTable(): void {
  if (missingTableWarned) return;
  missingTableWarned = true;
  console.warn('[session-registry] table user_sessions absente : registre inactif jusqu’à l’application de la migration 0802.');
}

// ── Identifiant public d'une session ──────────────────────────────────────

/**
 * Identifiant présenté à l'interface : dérivé du `sid` (HMAC), jamais le
 * `sid` lui-même (qui figure dans les jetons et les journaux).
 */
export function sessionPublicId(sid: string): string {
  return createHmac('sha256', `verebona/session-public/v1/${process.env.JWT_SECRET || 'dev'}`)
    .update(sid).digest('base64url').slice(0, 22);
}

// ── Écriture ──────────────────────────────────────────────────────────────

/**
 * Inscrit ou met à jour la session (ouverture, rotation, réémission). Ne lève
 * jamais : un échec est journalisé, la session sera inscrite au prochain
 * renouvellement. Rend l'issue (`null` : échec technique).
 */
export async function recordSession(input: SessionUpsert): Promise<SessionUpsertOutcome | null> {
  try {
    return await store().upsert(input);
  } catch (e) {
    if (isMissingTable(e)) { warnMissingTable(); return null; }
    console.error('[session-registry] inscription impossible :', (e as Error)?.message ?? e);
    return null;
  }
}

/** Un autre appareil de cet utilisateur porte-t-il déjà cette empreinte ? (donnée « appareil déjà vu », §20.4 — aucun envoi ici) */
export async function isKnownDevice(userId: number, deviceKey: string | null, exceptSid: string): Promise<boolean | null> {
  if (!deviceKey) return null;
  try {
    return await store().hasDevice(userId, deviceKey, exceptSid);
  } catch {
    return null;
  }
}

function toRevokedInfo(r: SessionRecord, scope: SessionRevocationScope, replacedBySid?: string): RevokedSessionInfo {
  return {
    sid: r.sid, userId: r.userId, deviceKey: r.deviceKey, clientType: r.clientType,
    reason: r.revocationReason ?? '', scope, sameDeviceContinues: scope === 'replaced',
    ...(scope === 'replaced' && replacedBySid ? { replacedBySid } : {}),
  };
}

async function revokeWith(
  match: Parameters<SessionRegistryStore['revoke']>[0],
  reason: string,
  scope: SessionRevocationScope,
  now = new Date(),
): Promise<SessionRecord[]> {
  const revoked = await store().revoke(match, reason, now);
  await notifySessionsRevoked(revoked.map((r) => toRevokedInfo(r, scope, match.exceptSid)));
  return revoked;
}

/** Fin de la session courante (déconnexion) — jamais bloquant. */
export async function endSession(userId: number, sid: string, reason = 'LOGOUT'): Promise<boolean> {
  try {
    if ((await revokeWith({ userId, sid }, reason, 'logout')).length > 0) return true;
    // Lot 96A (CDC 18 P3) : session ouverte AVANT le registre, jamais
    // renouvelée depuis (aucune ligne). Le jeton de renouvellement est révoqué
    // par l'appelant, mais son jeton d'ACCÈS restait utilisable jusqu'à son
    // expiration (15 min). Une ligne « terminée » est inscrite pour ce `sid` :
    // le contrôle de chaque requête (`isSessionRevoked`) la refuse aussitôt.
    if (await store().get(sid)) return false;
    const now = new Date();
    const outcome = await store().upsert({
      sid, userId, authMethod: null, registeredVia: 'REFRESH', refreshTokenHash: '', now,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      client: { deviceKey: null, deviceSource: null, clientType: 'WEB', appVersion: null, deviceLabel: 'Appareil', browserLabel: 'Session antérieure' } as SessionUpsert['client'],
    });
    if (outcome !== 'created') return false;
    return (await revokeWith({ userId, sid }, reason, 'logout')).length > 0;
  } catch (e) {
    if (!isMissingTable(e)) console.error('[session-registry] fin de session :', (e as Error)?.message ?? e);
    return false;
  }
}

/**
 * Remplacement sur le MÊME appareil : la session `sid` (ou les autres
 * sessions de cet appareil) cède la place à une session neuve. Jamais
 * bloquant ; l'appareil reste connecté (`sameDeviceContinues`).
 */
export async function replaceSessions(match: { userId: number; sid?: string; deviceKey?: string; exceptSid: string }): Promise<void> {
  if (!match.sid && !match.deviceKey) return;
  try {
    await revokeWith(match, 'SESSION_REPLACED', 'replaced');
  } catch (e) {
    if (!isMissingTable(e)) console.error('[session-registry] remplacement :', (e as Error)?.message ?? e);
  }
}

/** « Déconnecter » une session de l'utilisateur, désignée par son identifiant public. `null` : introuvable / déjà terminée. */
export async function revokeUserSessionByPublicId(
  userId: number,
  publicId: string,
  reason: string,
  now = new Date(),
): Promise<SessionRecord | null> {
  const target = (await store().listActive(userId, now)).find((s) => sessionPublicId(s.sid) === publicId);
  if (!target) return null;
  const [revoked] = await revokeWith({ userId, sid: target.sid }, reason, 'single', now);
  return revoked ?? null;
}

/** « Déconnecter tous les autres appareils » : toutes les sessions actives sauf `keepSid`. */
export async function revokeOtherUserSessions(userId: number, keepSid: string, reason: string): Promise<SessionRecord[]> {
  return revokeWith({ userId, exceptSid: keepSid }, reason, 'others');
}

// ── Lecture ───────────────────────────────────────────────────────────────

/**
 * Contrôle d'accès ET de renouvellement : la session `sid` a-t-elle été
 * révoquée dans le registre ? `false` sans `sid` ou si la session n'y figure
 * pas (ouverte avant le déploiement — Q5). Lève `SESSION_UNAVAILABLE` si la
 * base ne répond pas (fail closed, comme la borne globale).
 */
export async function isSessionRevoked(payload: { userId: number; sid?: string | null }): Promise<boolean> {
  if (typeof payload.sid !== 'string' || !payload.sid) return false;
  let row: SessionRecord | null;
  try {
    row = await store().get(payload.sid);
  } catch (e) {
    if (isMissingTable(e)) { warnMissingTable(); return false; }
    throw new Error(SESSION_UNAVAILABLE_CODE);
  }
  if (!row) return false;
  return row.userId !== payload.userId || row.revokedAt !== null;
}

/** Ligne du registre (ou `null`). */
export async function getSessionRecord(sid: string): Promise<SessionRecord | null> {
  try {
    return await store().get(sid);
  } catch (e) {
    if (isMissingTable(e)) return null;
    throw e;
  }
}

/** Vue « Appareils connectés » (aucune IP, aucune localisation — SESS-09). */
export interface UserSessionView {
  id: string;
  current: boolean;
  clientType: string;
  deviceLabel: string;
  browserLabel: string;
  createdAt: string;
  lastSeenAt: string;
}

export function toSessionView(r: SessionRecord, currentSid: string | null | undefined): UserSessionView {
  return {
    id: sessionPublicId(r.sid),
    current: !!currentSid && r.sid === currentSid,
    clientType: r.clientType,
    deviceLabel: r.deviceLabel,
    browserLabel: r.browserLabel,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
  };
}

/** Sessions actives de l'utilisateur, la session courante d'abord. */
export async function listUserSessions(userId: number, currentSid: string | null | undefined, now = new Date()): Promise<UserSessionView[]> {
  const rows = await store().listActive(userId, now);
  return rows
    .map((r) => toSessionView(r, currentSid))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.localeCompare(a.lastSeenAt));
}

/** Purge (tâche planifiée) : lignes terminées depuis plus de la durée de conservation. */
export async function purgeSessionRegistry(now = new Date()): Promise<number> {
  try {
    return await store().purge(now, SESSION_REGISTRY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  } catch (e) {
    if (isMissingTable(e)) return 0;
    throw e;
  }
}
