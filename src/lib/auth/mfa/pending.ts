/**
 * Contexte d'authentification PROVISOIRE (lot 110B, ticket §2, §6).
 *
 * Après une preuve primaire réussie (mot de passe, Google / Apple, lien
 * d'activation, ou récupération e-mail + code), quand la MFA est obligatoire :
 *   · une ligne `mfa_pending_auth` (10 min, usage unique, révocable) ;
 *   · un jeton signé DISTINCT (`kid` v2-mfa, `lib/jwt.ts`) en cookie HttpOnly
 *     `vb_mfa`, limité au chemin `/api/auth/mfa` ;
 *   · AUCUN jeton d'accès ni de renouvellement : ce contexte n'ouvre aucune
 *     API métier, ni le BO — seulement les routes `MFA_PENDING_ROUTES`.
 * Complétion (`completePending`) : atomique, une seule fois, puis émission
 * d'une session COMPLÈTE de niveau 2 (`issueSession`).
 *
 * Révocation : une révocation globale postérieure (mot de passe réinitialisé,
 * incident) invalide le contexte ; compte suspendu / supprimé / non vérifié :
 * refusé. Plusieurs onglets : le même contexte (même cookie) ; un nouveau
 * démarrage le remplace.
 */
import { randomUUID } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { generateMfaPendingToken, verifyMfaPendingToken } from '@/lib/jwt';
import { MFA_PENDING_COOKIE, MFA_PENDING_COOKIE_PATH, MFA_PENDING_TTL_S } from './constants';
import { sql } from './db';

export type PendingPurpose = 'challenge' | 'enroll';

export interface PendingContext {
  pid: string;
  userId: number;
  email: string;
  firstName: string | null;
  role: string;
  status: string;
  purpose: PendingPurpose;
  primaryMethod: string;
  returnUrl: string | null;
  rememberDevice: boolean;
  factorEnrolledAt: Date | null;
  /** Facteur enrôlé dans ce contexte (décidé par le serveur, jamais par le client). */
  enrolledFactor: 'passkey' | 'otp' | null;
  recoveredAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
  hasPassword: boolean;
}

export async function createPending(
  response: NextResponse,
  input: { userId: number; purpose: PendingPurpose; primaryMethod: string; returnUrl?: string | null; rememberDevice?: boolean; recovered?: boolean },
): Promise<{ pid: string; expiresAt: Date }> {
  const pid = randomUUID();
  const expiresAt = new Date(Date.now() + MFA_PENDING_TTL_S * 1000);
  const db = await sql();
  await db`
    INSERT INTO mfa_pending_auth (id, user_id, purpose, primary_method, return_url, remember_device, recovered_at, created_at, expires_at)
    VALUES (${pid}, ${input.userId}, ${input.purpose}, ${input.primaryMethod}, ${input.returnUrl ?? null},
            ${!!input.rememberDevice}, ${input.recovered ? new Date().toISOString() : null},
            -- Horloge de l'APPLICATION (celle des bornes de révocation).
            ${new Date().toISOString()}, ${expiresAt.toISOString()})`;
  const token = await generateMfaPendingToken({ userId: input.userId, pid, pm: input.primaryMethod }, MFA_PENDING_TTL_S);
  response.cookies.set(MFA_PENDING_COOKIE, token, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: MFA_PENDING_TTL_S, path: MFA_PENDING_COOKIE_PATH,
  });
  return { pid, expiresAt };
}

export function clearPendingCookie(response: NextResponse): void {
  response.cookies.set(MFA_PENDING_COOKIE, '', {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 0, path: MFA_PENDING_COOKIE_PATH,
  });
}

interface Row {
  id: string; user_id: number; purpose: string; primary_method: string; return_url: string | null; remember_device: boolean;
  factor_enrolled_at: Date | null; enrolled_factor: string | null; recovered_at: Date | null; created_at: Date; expires_at: Date; completed_at: Date | null;
  email: string; first_name: string | null; role: string; status: string; is_active: boolean; has_password: boolean;
  revoked_before: Date | null;
}

/** Contexte provisoire VALIDE de la requête, sinon `null` (fail closed). */
export async function readPending(request: Pick<NextRequest, 'cookies'>): Promise<PendingContext | null> {
  const raw = request.cookies.get(MFA_PENDING_COOKIE)?.value;
  if (!raw) return null;
  const claims = await verifyMfaPendingToken(raw);
  if (!claims) return null;
  const db = await sql();
  const rows = await db<Row[]>`
    SELECT p.*, u.email, u.first_name, u.role, u.status, u.is_active,
           (u.password_hash IS NOT NULL AND u.password_hash <> '') AS has_password,
           r.revoked_before
      FROM mfa_pending_auth p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN user_session_revocations r ON r.user_id = p.user_id
     WHERE p.id = ${claims.pid} AND p.user_id = ${claims.userId}`;
  const r = rows[0];
  if (!r) return null;
  const now = Date.now();
  if (r.completed_at || new Date(r.expires_at).getTime() <= now) return null;
  if (r.status === 'SUSPENDED' || r.status === 'DELETED' || !r.is_active) return null;
  if (r.revoked_before && new Date(r.revoked_before).getTime() > new Date(r.created_at).getTime()) return null;
  return {
    pid: r.id,
    userId: Number(r.user_id),
    email: r.email,
    firstName: r.first_name,
    role: r.role,
    status: r.status,
    purpose: r.purpose === 'enroll' ? 'enroll' : 'challenge',
    primaryMethod: r.primary_method,
    returnUrl: r.return_url,
    rememberDevice: !!r.remember_device,
    factorEnrolledAt: r.factor_enrolled_at ? new Date(r.factor_enrolled_at) : null,
    enrolledFactor: r.enrolled_factor === 'passkey' ? 'passkey' : r.enrolled_factor === 'otp' ? 'otp' : null,
    recoveredAt: r.recovered_at ? new Date(r.recovered_at) : null,
    createdAt: new Date(r.created_at),
    expiresAt: new Date(r.expires_at),
    hasPassword: !!r.has_password,
  };
}

/** Bascule le contexte en enrôlement (après récupération) — jamais l'inverse. */
export async function markPendingRecovered(pid: string): Promise<void> {
  const db = await sql();
  await db`UPDATE mfa_pending_auth SET purpose = 'enroll', recovered_at = now() WHERE id = ${pid} AND completed_at IS NULL`;
}

export async function markPendingFactorEnrolled(pid: string, factor: 'passkey' | 'otp'): Promise<void> {
  const db = await sql();
  await db`UPDATE mfa_pending_auth SET factor_enrolled_at = now(), enrolled_factor = ${factor} WHERE id = ${pid} AND completed_at IS NULL`;
}

/** Complétion atomique : vrai pour UN seul appel. */
export async function completePending(pid: string): Promise<boolean> {
  const db = await sql();
  const rows = await db`UPDATE mfa_pending_auth SET completed_at = now() WHERE id = ${pid} AND completed_at IS NULL AND expires_at > now() RETURNING id`;
  return rows.length > 0;
}

export async function cancelPending(pid: string): Promise<void> {
  const db = await sql();
  await db`UPDATE mfa_pending_auth SET completed_at = now(), cancelled = true WHERE id = ${pid} AND completed_at IS NULL`;
}
