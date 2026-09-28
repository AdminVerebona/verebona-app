/**
 * Routes de la suppression volontaire — authentification.
 *
 *  - /api/users/me/deletion : chaque handler exige la session, et porte
 *    toujours sur l'utilisateur de la session (jamais un identifiant fourni) ;
 *  - DELETE /api/users/me : délègue au parcours différé (plus d'anonymisation
 *    immédiate) ;
 *  - /api/cron/account-deletion/process : CRON_SECRET exigé, même absent.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (p: string) => strip(readFileSync(join(process.cwd(), p), 'utf8'));
const HANDLER = /export\s+async\s+function\s+(GET|POST|PATCH|PUT|DELETE)\b/g;

describe('/api/users/me/deletion', () => {
  const route = read('src/app/api/users/me/deletion/route.ts');
  const close = read('src/app/api/users/me/deletion/close-account.ts');

  it('chaque handler exige la session (POST via le parcours de clôture)', () => {
    expect([...route.matchAll(HANDLER)].map((m) => m[1]).sort()).toEqual(['DELETE', 'GET', 'POST']);
    expect((route.match(/SessionService\.getSession\s*\(/g) ?? []).length).toBe(2);
    expect(route).toContain('return handleCloseAccount(request)');
    expect(close).toMatch(/userId = \(await SessionService\.getSession\(request\)\)\.userId/);
  });

  it('aucun identifiant d’utilisateur lu dans la requête', () => {
    for (const src of [route, close]) {
      expect(src).not.toMatch(/searchParams/);
      expect(src).not.toMatch(/body\.userId|params\)/);
    }
  });

  it('sans session : 401, sans toucher à la base', async () => {
    const { GET, POST, DELETE } = await import('@/app/api/users/me/deletion/route');
    const r = (m: string) => new NextRequest('http://localhost:3000/api/users/me/deletion', { method: m });
    expect((await GET(r('GET'))).status).toBe(401);
    expect((await POST(r('POST'))).status).toBe(401);
    expect((await DELETE(r('DELETE'))).status).toBe(401);
  });

  it('la clôture exige le texte ET le mot de passe', () => {
    expect(close).toContain('password: typeof body.password === \'string\' ? body.password : null');
    expect(close).toContain('confirmation: typeof body.confirmation === \'string\' ? body.confirmation : null');
  });
});

describe('limitation des essais de mot de passe (clôture)', () => {
  it('même limiteur que la connexion, par IP et par utilisateur, remis à zéro après succès', () => {
    const close = read('src/app/api/users/me/deletion/close-account.ts');
    expect(close).toContain('checkAuthRateLimit(key)');
    expect(close).toContain('`account-deletion:ip:${ip}`');
    expect(close).toContain('`account-deletion:user:${userId}`');
    expect(close.indexOf('checkAuthRateLimit(key)')).toBeLessThan(close.indexOf('closeAccountForDeletion({'));
    expect(close).toContain('resetAuthRateLimit(`account-deletion:user:${userId}`)');
  });
});

describe('DELETE /api/users/me', () => {
  it('délègue à la suppression différée ; plus d’anonymisation immédiate', () => {
    const src = read('src/app/api/users/me/route.ts');
    expect(src).toContain('return handleCloseAccount(req)');
    expect(src).not.toMatch(/status: 'DELETED'/);
    expect(src).not.toMatch(/deleted_\$\{session\.userId\}/);
  });
});

describe('GET /api/cron/account-deletion/process', () => {
  const saved = process.env.CRON_SECRET;
  afterEach(() => { process.env.CRON_SECRET = saved; });

  it('401 sans secret configuré, sans en-tête ou avec un mauvais secret', async () => {
    const { GET } = await import('@/app/api/cron/account-deletion/process/route');
    const call = (auth?: string) => GET(new NextRequest('http://localhost:3000/api/cron/account-deletion/process', {
      headers: auth ? { authorization: auth } : {},
    }));
    delete process.env.CRON_SECRET;
    expect((await call('Bearer undefined')).status).toBe(401);
    process.env.CRON_SECRET = 'secret-de-test';
    expect((await call()).status).toBe(401);
    expect((await call('Bearer autre')).status).toBe(401);
  });

  it('même traitement que la tâche interne quotidienne', () => {
    const src = read('src/app/api/cron/account-deletion/process/route.ts');
    // Même balayage, même verrou d'exécution, même règle d'arriéré.
    expect(src).toContain('runAccountDeletionSweepExclusive({ dryRun, includeBacklog: options.includeBacklog })');
    expect(src).toContain("{ error: 'LOCKED'");
    expect(read('src/services/scheduling/daily-maintenance-scheduler.ts'))
      .toContain('runAccountDeletionSweepExclusive(sweepOptionsFor(deletionMode))');
  });
});
