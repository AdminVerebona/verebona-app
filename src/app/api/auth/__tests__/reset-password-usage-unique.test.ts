/**
 * Réinitialisation du mot de passe — usage unique garanti même en
 * concurrence, et aucun secret par défaut en production.
 *
 * La base est simulée : l'UPDATE conditionnel est réellement évalué — la
 * condition Drizzle est rendue en SQL (PgDialect) et n'aboutit que si
 * l'empreinte attendue est encore l'empreinte courante, comme PostgreSQL le
 * ferait après sérialisation des deux UPDATE sur la même ligne.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = { hash: '$2b$10$ancien', writes: 0 };
const dialect = new PgDialect();

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  const user = () => ({ id: 12, email: 'jean@exemple.fr', passwordHash: state.hash });
  const select = { select: () => select, from: () => select, where: () => select, limit: async () => [user()] };
  const db = {
    ...select,
    update: () => {
      let values: { passwordHash?: string } = {};
      const q = {
        set: (v: { passwordHash?: string }) => { values = v; return q; },
        where: (cond: SQL) => ({
          returning: async () => {
            // On laisse l'autre requête avancer : c'est le pire cas.
            await new Promise((r) => setTimeout(r, 1));
            const { sql, params } = dialect.sqlToQuery(cond);
            if (!/"password_hash" = \$/.test(sql)) throw new Error(`UPDATE non conditionnel : ${sql}`);
            if (!params.includes(state.hash)) return [];
            state.hash = values.passwordHash!;
            state.writes += 1;
            return [{ id: 12 }];
          },
        }),
      };
      return q;
    },
  };
  return { ...actual, db, revokeAllUserSessions: async () => {} };
});
vi.mock('@/lib/notifications', () => ({ emit: async () => {} }));
vi.mock('bcrypt', () => ({ default: { hash: async (p: string) => `$hash$${p}` } }));

const { POST } = await import('../reset-password/route');
const { createPasswordResetToken, resetSecret } = await import('@/services/auth/password-reset.service');

const req = (token: string, newPassword: string) => new NextRequest('http://x/api/auth/reset-password', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token, newPassword }),
});

beforeEach(() => { state.hash = '$2b$10$ancien'; state.writes = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

describe('POST /api/auth/reset-password — usage unique', () => {
  it('deux requêtes simultanées avec le même lien : une seule aboutit', async () => {
    const token = createPasswordResetToken({ id: 12, email: 'jean@exemple.fr', passwordHash: state.hash });
    const [a, b] = await Promise.all([POST(req(token, 'Motdepasse1!A')), POST(req(token, 'Motdepasse2!B'))]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(state.writes).toBe(1);
    const refus = a.status === 400 ? a : b;
    expect((await refus.json()).code).toBe('INVALID_TOKEN');
  });

  it('un lien déjà utilisé est refusé', async () => {
    const token = createPasswordResetToken({ id: 12, email: 'jean@exemple.fr', passwordHash: state.hash });
    expect((await POST(req(token, 'Motdepasse1!A'))).status).toBe(200);
    expect((await POST(req(token, 'Motdepasse2!B'))).status).toBe(400);
    expect(state.writes).toBe(1);
  });
});

describe('secret de signature', () => {
  it('production sans secret configuré : erreur explicite, pas de valeur par défaut', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PASSWORD_RESET_SECRET', '');
    vi.stubEnv('JWT_SECRET', '');
    expect(() => resetSecret()).toThrow(/Aucun secret configuré/);
  });

  it('production avec la valeur par défaut publique : refusée aussi', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PASSWORD_RESET_SECRET', '');
    vi.stubEnv('JWT_SECRET', 'your-secret-key-change-in-production');
    expect(() => resetSecret()).toThrow(/PASSWORD_RESET_SECRET/);
  });

  it('production avec un secret : utilisé', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PASSWORD_RESET_SECRET', 's3cr3t-aleatoire');
    expect(resetSecret()).toBe('s3cr3t-aleatoire');
  });
});
