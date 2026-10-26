/**
 * Routes hors `SessionService` (`getCurrentUser`, et les routes qui vérifient
 * le jeton elles-mêmes) : borne de révocation et statut de session appliqués,
 * pour que la clôture d'un compte coupe les autres appareils tout de suite.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const cutoff = vi.hoisted(() => ({ value: null as Date | null }));
vi.mock('@/db', async (orig) => ({
  ...(await orig<typeof import('@/db')>()),
  getUserSessionCutoff: vi.fn(async () => cutoff.value),
}));

import { generateAccessToken } from '@/lib/jwt';
import { serverCacheDelete } from '@/lib/server-cache';
import { sessionCutoffCacheKey } from '@/lib/auth/session-cutoff';
import { verifySessionAccessToken } from '@/lib/auth/session-guard';

const USER = 777001;
const token = (status = 'ACTIVE') => generateAccessToken({
  id: USER, email: 'x@exemple.fr', role: 'USER' as never, planType: 'STANDARD' as never, status: status as never,
});
const req = (path: string, method = 'GET') => new NextRequest(`http://localhost:3000${path}`, { method });

beforeEach(() => {
  cutoff.value = null;
  serverCacheDelete(sessionCutoffCacheKey(USER));
});

describe('verifySessionAccessToken', () => {
  it('jeton valide, compte actif : accepté', async () => {
    expect((await verifySessionAccessToken(await token(), req('/api/notifications')))?.userId).toBe(USER);
  });

  it('jeton émis AVANT la révocation (clôture sur un autre appareil) : refusé immédiatement', async () => {
    const t = await token();
    await new Promise((r) => setTimeout(r, 5));
    cutoff.value = new Date();
    expect(await verifySessionAccessToken(t, req('/api/notifications'))).toBeNull();
  });

  it('compte clôturé : seules les routes d’annulation / export / identité', async () => {
    const t = await token('PENDING_DELETION');
    expect(await verifySessionAccessToken(t, req('/api/notifications'))).toBeNull();
    expect(await verifySessionAccessToken(t, req('/api/assets/1/move-request', 'POST'))).toBeNull();
    expect((await verifySessionAccessToken(t, req('/api/users/me')))?.userId).toBe(USER);
  });

  it('suspendu, supprimé, jeton absent ou invalide : refusé', async () => {
    expect(await verifySessionAccessToken(await token('SUSPENDED'), req('/api/users/me'))).toBeNull();
    expect(await verifySessionAccessToken(null, req('/api/users/me'))).toBeNull();
    expect(await verifySessionAccessToken('abc.def.ghi', req('/api/users/me'))).toBeNull();
  });
});

describe('câblage', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  it('getCurrentUser applique la borne ET le statut réel en base', () => {
    const src = read('src/lib/auth.ts');
    expect(src).toContain('await verifySessionAccessToken(token, request)');
    expect(src).toContain('sessionStatusAllows(user.status,');
  });

  it('plus aucune route ne vérifie un jeton d’accès sans la borne de révocation', async () => {
    const { readdirSync } = await import('node:fs');
    const routes = readdirSync(join(process.cwd(), 'src/app/api'), { recursive: true })
      .map(String).filter((f) => f.endsWith('route.ts')).map((f) => `src/app/api/${f}`);
    const bare = routes.filter((p) => /\bverifyAccessToken\s*\(/.test(read(p)));
    expect(bare).toEqual([]);
  });
});
