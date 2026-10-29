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
    expect(close).toMatch(/const session = await SessionService\.getSession\(request\);\s*userId = session\.userId;/);
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

  // Lot 92 (CDC 18 §25, REAUTH-07) : texte ET preuve d'identité — mot de passe
  // dans la requête OU preuve de réauthentification fraîche de la session
  // (lot 93 : Google / Apple, seule voie d'un compte sans mot de passe).
  it('la clôture exige le texte ET une preuve d’identité (mot de passe ou réauthentification fraîche)', () => {
    expect(close).toContain("const password = typeof body.password === 'string' && body.password ? body.password : null");
    expect(close).toContain("const confirmation = typeof body.confirmation === 'string' ? body.confirmation : null");
    expect(close).toContain("reauthProven: reauth?.state === 'fresh'");
    expect(close).toContain("consumeReauthProof(reauth.proof.id, 'account_deletion', now)");
    expect(close).toContain('revokeAppleAuthorizationsForUser(userId)');
    expect(close).not.toContain('reauth-bridge');
  });
});

describe('limitation des essais de mot de passe (clôture)', () => {
  // Lot 53A (CDC 18 §33 / SEC-04) : limiteur PARTAGÉ de la réauthentification
  // (par utilisateur et par IP) au lieu du `Map` en mémoire de l'instance.
  it('PO-Q21-REAUTH-02 limiteur partagé, par IP et par utilisateur, vérifié avant la clôture, remis à zéro après succès', () => {
    const close = read('src/app/api/users/me/deletion/close-account.ts');
    expect(close).toContain('reauthBlockedResponse(request, userId)');
    expect(close.indexOf('reauthBlockedResponse(request, userId)')).toBeLessThan(close.indexOf('closeAccountForDeletion({'));
    expect(close).toContain("if (result.code === 'INVALID_PASSWORD') await recordReauthFailure(request, userId, 'account_deletion')");
    expect(close).toContain('await recordReauthSuccess(userId)');
    expect(close).not.toMatch(/checkAuthRateLimit|resetAuthRateLimit/);
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
