/**
 * APP-PERF-37 — sondes bornées : vitalité, disponibilité critique, diagnostic.
 *
 * T-01 : commit lu depuis SOURCE_VERSION sans aucune variable Vercel, même
 *        valeur que la télémétrie IA.
 * T-02 : base indisponible, S3 indisponible, migration critique manquante →
 *        statuts distincts selon le contrat de chaque sonde.
 * T-03 : dépendance bloquée, appels répétés → réponses au délai, un seul
 *        contrôle en vol.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const etat = vi.hoisted(() => ({
  execute: vi.fn(async () => [] as unknown[]),
  readiness: vi.fn(async () => ({ ready: true, phase: 'ready', pendingCritical: 0, pendingOptional: 0, firstFailure: null as null | { filename: string; code?: string } })),
  failures: vi.fn(() => [] as Array<{ filename: string; message: string; code?: string; criticality?: string }>),
  s3Send: vi.fn(async () => ({})),
  s3Configured: true,
}));

vi.mock('@/db', () => ({
  db: { execute: etat.execute },
  getMigrationFailures: () => etat.failures(),
  getSchemaReadiness: () => etat.readiness(),
}));
vi.mock('@/lib/s3-config', () => ({
  s3ConfigDiagnostics: () => (etat.s3Configured
    ? { configured: true, errors: [], warnings: [] }
    : { configured: false, errors: ['a', 'b', 'c', 'd'].map((v) => ({ code: 'MISSING', variable: v, message: `${v} manquante` })), warnings: [] }),
  getS3Client: () => ({ send: etat.s3Send }),
  getS3Bucket: () => 'bucket',
  classifyS3Error: (e: { name?: string }) => ({ kind: 'NETWORK', name: e?.name ?? 'Error' }),
}));
vi.mock('@/services/ai/config/prompt-architecture', () => ({ promptArchitectureWarnings: async () => [] }));
vi.mock('@/services/verebona-assistant/core/help-corpus.service', () => ({
  helpCorpusHealth: () => ({ status: 'ok', source: 'live' }),
}));

const { GET: health } = await import('../route');
const { GET: live } = await import('../live/route');
const { GET: ready } = await import('../ready/route');
const { resetHealthProbesForTests } = await import('@/lib/health/probes');
const { getAppVersion } = await import('@/services/ai/telemetry/execution-context');

const req = (headers: Record<string, string> = {}) => new NextRequest('http://localhost/api/health', { headers });
const envInitial = { ...process.env };

beforeEach(() => {
  resetHealthProbesForTests();
  etat.execute.mockReset().mockResolvedValue([]);
  etat.readiness.mockReset().mockResolvedValue({ ready: true, phase: 'ready', pendingCritical: 0, pendingOptional: 0, firstFailure: null });
  etat.failures.mockReset().mockReturnValue([]);
  etat.s3Send.mockReset().mockResolvedValue({});
  etat.s3Configured = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { process.env = { ...envInitial }; vi.restoreAllMocks(); });

describe('T-01 — identité du déploiement (Scalingo, sans Vercel)', () => {
  it('commit = SOURCE_VERSION, identique à la télémétrie ; variables Vercel ignorées', async () => {
    for (const k of ['APP_COMMIT', 'APP_BUILD_COMMIT', 'CONTAINER_VERSION', 'GIT_COMMIT']) delete process.env[k];
    process.env.SOURCE_VERSION = '0123456789abcdef0123456789abcdef01234567';
    process.env.VERCEL_GIT_COMMIT_SHA = 'ffffffffffffffffffffffffffffffffffffffff';
    const b = await (await health(req())).json();
    expect(b.commit).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(b.commitSource).toBe('SOURCE_VERSION');
    expect(getAppVersion()).toBe(b.commit);
    expect((await live().json()).commit).toBe(b.commit);
  });

  it('sans aucune variable : pas de commit inventé', async () => {
    for (const k of ['APP_COMMIT', 'SOURCE_VERSION', 'APP_BUILD_COMMIT', 'CONTAINER_VERSION']) delete process.env[k];
    process.env.GIT_COMMIT = 'abcdef1';
    expect((await (await health(req())).json()).commit).toBeUndefined();
  });
});

describe('T-02 — statuts distincts par contrat', () => {
  it('base indisponible : vitalité 200, readiness 503, diagnostic 503 `down` sans message SQL', async () => {
    etat.execute.mockRejectedValue(new Error('password authentication failed for user "verebona"'));
    expect(live().status).toBe(200);
    const r = await ready();
    expect(r.status).toBe(503);
    expect((await r.json()).reasons).toEqual(['DATABASE_UNAVAILABLE']);
    const h = await health(req());
    expect(h.status).toBe(503);
    const b = await h.json();
    expect(b.status).toBe('down');
    expect(b.checks.database.error).toBe('UNAVAILABLE');
    expect(JSON.stringify(b)).not.toContain('password');
  });

  it('S3 indisponible : readiness 200 (dépendance optionnelle), diagnostic 200 `degraded`', async () => {
    etat.s3Send.mockRejectedValue(Object.assign(new Error('x'), { name: 'NetworkingError' }));
    expect((await ready()).status).toBe(200);
    const h = await health(req());
    expect(h.status).toBe(200);
    const b = await h.json();
    expect(b.status).toBe('degraded');
    expect(b.checks.s3).toMatchObject({ status: 'error', error: 'NETWORK' });
  });

  it('S3 non configuré du tout : pas de dégradation, aucun nom de variable public', async () => {
    etat.s3Configured = false;
    const b = await (await health(req())).json();
    expect(b.status).toBe('ok');
    expect(b.checks.s3.config).toBeUndefined();
  });

  it('migration critique manquante : readiness 503 SCHEMA_NOT_READY, diagnostic `degraded`, message réservé', async () => {
    etat.readiness.mockResolvedValue({ ready: false, phase: 'failed', pendingCritical: 1, pendingOptional: 0, firstFailure: { filename: '0243_x.sql', code: '42703' } });
    etat.failures.mockReturnValue([{ filename: '0243_x.sql', code: '42703', message: 'column "secret_col" does not exist', criticality: 'critical' }]);
    const r = await ready();
    expect(r.status).toBe(503);
    const rb = await r.json();
    expect(rb).toMatchObject({ status: 'not_ready', reasons: ['SCHEMA_NOT_READY'], checks: { schema: { phase: 'failed', pendingCritical: 1, firstFailure: { filename: '0243_x.sql', code: '42703' } } } });
    const b = await (await health(req())).json();
    expect(b.status).toBe('degraded');
    expect(b.checks.migrations).toMatchObject({ status: 'error', failed: ['0243_x.sql'], firstFailure: { filename: '0243_x.sql', code: '42703' } });
    expect(JSON.stringify(b)).not.toContain('secret_col');
  });

  it('index optionnel manquant : readiness 200 `degraded: true`', async () => {
    etat.readiness.mockResolvedValue({ ready: true, phase: 'degraded', pendingCritical: 0, pendingOptional: 1, firstFailure: null });
    const rb = await (await ready()).json();
    expect(rb).toMatchObject({ status: 'ready', degraded: true });
  });

  it('diagnostic détaillé avec HEALTH_DIAGNOSTIC_TOKEN : messages visibles ; mauvais jeton : non', async () => {
    process.env.HEALTH_DIAGNOSTIC_TOKEN = 'jeton-de-diagnostic-0123';
    etat.failures.mockReturnValue([{ filename: '0243_x.sql', code: '42703', message: 'column "secret_col" does not exist', criticality: 'critical' }]);
    etat.readiness.mockResolvedValue({ ready: false, phase: 'failed', pendingCritical: 1, pendingOptional: 0, firstFailure: null });
    const avec = await (await health(req({ 'x-health-token': 'jeton-de-diagnostic-0123' }))).json();
    expect(avec.detailed).toBe(true);
    expect(avec.checks.migrations.firstFailure.message).toContain('secret_col');
    const sans = await (await health(req({ 'x-health-token': 'mauvais-jeton-0000000' }))).json();
    expect(sans.detailed).toBe(false);
    expect(JSON.stringify(sans)).not.toContain('secret_col');
  });
});

describe('T-03 — dépendance bloquée : réponses bornées, aucune accumulation', () => {
  it('base qui ne répond jamais : readiness 503 au délai ; appels simultanés → UNE requête', async () => {
    etat.execute.mockReturnValue(new Promise(() => {}));
    const debut = Date.now();
    const rs = await Promise.all(Array.from({ length: 10 }, () => ready()));
    const duree = Date.now() - debut;
    expect(duree).toBeLessThan(3_000);
    expect(rs.every((r) => r.status === 503)).toBe(true);
    expect((await rs[0].json()).reasons).toEqual(['DATABASE_TIMEOUT']);
    expect(etat.execute).toHaveBeenCalledTimes(1);
  });

  it('S3 bloqué : diagnostic borné, contrôle S3 réutilisé entre appels rapprochés', async () => {
    etat.s3Send.mockReturnValue(new Promise(() => {}));
    const debut = Date.now();
    const b = await (await health(req())).json();
    expect(Date.now() - debut).toBeLessThan(4_500);
    expect(b.checks.s3).toMatchObject({ status: 'error', error: 'TIMEOUT' });
    await health(req());
    await health(req());
    expect(etat.s3Send).toHaveBeenCalledTimes(1);
  });

  it('vitalité : aucune E/S', () => {
    live();
    expect(etat.execute).not.toHaveBeenCalled();
    expect(etat.readiness).not.toHaveBeenCalled();
    expect(etat.s3Send).not.toHaveBeenCalled();
  });
});
