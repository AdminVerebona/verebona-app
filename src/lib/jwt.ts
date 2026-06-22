/**
 * JWT utilities for Verebona
 * Uses Web Crypto API (HS256) — no external deps, Edge Runtime compatible.
 */

import { UserRole, PlanType, UserStatus } from '@/types/domain';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_ACCESS_EXPIRY_S  = 2 * 60 * 60;        // 2h
const JWT_REFRESH_EXPIRY_S = 30 * 24 * 60 * 60;  // 30d

export interface JWTPayload {
  userId: number;
  email: string;
  role: UserRole;
  planType: PlanType;
  status: UserStatus;
  currentAccountId?: number;
  hasActiveAccount?: boolean;
  type: 'access' | 'refresh';
  iat?: number;
  exp?: number;
}

export type AccessTokenPayload = JWTPayload;

// ── Internal helpers ──────────────────────────────────────────────────────────

function b64url(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function importKey(usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

async function createToken(claims: Record<string, unknown>, expiresInSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now, exp: now + expiresInSeconds };
  const enc = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));
  const header = enc({ alg: 'HS256', typ: 'JWT' });
  const body   = enc(payload);
  const msg    = `${header}.${body}`;
  const sig    = await crypto.subtle.sign('HMAC', await importKey('sign'), new TextEncoder().encode(msg));
  return `${msg}.${b64url(new Uint8Array(sig))}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function generateAccessToken(user: {
  id: number; email: string; role: UserRole; planType: PlanType; status: UserStatus;
  currentAccountId?: number; hasActiveAccount?: boolean;
}): Promise<string> {
  return createToken({
    userId: user.id, email: user.email, role: user.role,
    planType: user.planType, status: user.status,
    currentAccountId: user.currentAccountId,
    hasActiveAccount: user.hasActiveAccount,
    type: 'access',
  }, JWT_ACCESS_EXPIRY_S);
}

export async function generateRefreshToken(user: {
  id: number; email: string; role: UserRole; planType: PlanType; status: UserStatus;
  currentAccountId?: number; hasActiveAccount?: boolean;
}): Promise<string> {
  return createToken({
    userId: user.id, email: user.email, role: user.role,
    planType: user.planType, status: user.status,
    currentAccountId: user.currentAccountId,
    hasActiveAccount: user.hasActiveAccount,
    type: 'refresh',
  }, JWT_REFRESH_EXPIRY_S);
}

export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const msg = `${header}.${body}`;
    const valid = await crypto.subtle.verify(
      'HMAC', await importKey('verify'),
      b64urlDecode(sig).buffer as ArrayBuffer,
      new TextEncoder().encode(msg),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload as JWTPayload;
  } catch {
    return null;
  }
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  return verifyToken(token);
}

export function extractToken(authHeader: string | null, cookieHeader: string | null): string | null {
  if (authHeader?.startsWith('Bearer ')) return authHeader.substring(7);
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').reduce((acc, c) => {
      const [k, v] = c.trim().split('=');
      acc[k] = v;
      return acc;
    }, {} as Record<string, string>);
    return cookies.access_token || null;
  }
  return null;
}
