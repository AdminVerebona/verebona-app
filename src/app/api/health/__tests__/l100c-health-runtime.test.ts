/**
 * Lot 100C — `/api/health` : section `runtime` (runtime Node EN SERVICE),
 * distincte de `version` (version applicative), et alerte de Supervision.
 *
 * H-01 sonde publique : statut seul (ni version de Node ni binaire).
 * H-02 diagnostic autorisé : version, binaire, verdict, seuil, plage.
 * H-03 runtime non corrigé en production : statut global jamais `ok` ;
 *      hors production : statut global inchangé (section en `error`).
 * H-04 la `version` reste la version applicative (APP_VERSION).
 * S-01 Supervision : non corrigé → anomalie « other » ; corrigé → résolution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/db', () => ({
  db: { execute: async () => [] }, getMigrationFailures: () => [],
  getSchemaReadiness: async () => ({ ready: true, phase: 'ready', pendingCritical: 0, pendingOptional: 0, firstFailure: null }),
}));
vi.mock('@/lib/s3-config', () => ({
  s3ConfigDiagnostics: () => ({ configured: true, errors: [], warnings: [] }),
  getS3Client: () => ({ send: async () => ({}) }), getS3Bucket: () => 'b',
  classifyS3Error: () => ({ kind: 'NETWORK', name: 'Error' }),
}));
vi.mock('@/services/ai/config/prompt-architecture', () => ({ promptArchitectureWarnings: async () => [] }));
vi.mock('@/services/verebona-assistant/core/help-corpus.service', () => ({
  loadHelpCorpus: async () => null, helpCorpusHealth: () => ({ status: 'ok', source: 'live' }),
}));
const anomalies = vi.hoisted(() => ({ report: vi.fn(async () => 7 as number | null), resolve: vi.fn(async () => true) }));
vi.mock('@/services/admin/anomaly.service', () => ({
  buildFingerprint: (d: string, ...p: string[]) => [d, ...p].join(':'),
  reportAnomaly: anomalies.report,
  autoResolveAnomaly: anomalies.resolve,
}));

const { GET } = await import('../route');
const { resetHealthProbesForTests } = await import('@/lib/health/probes');
const { syncNodeRuntimeAnomaly, NODE_RUNTIME_FINGERPRINT } = await import('@/services/admin/node-runtime-supervision');
const { evaluateNodeRuntime } = await import('@/lib/health/node-runtime');

const TOKEN = 'jeton-de-diagnostic-0123456789';
const req = (h: Record<string, string> = {}) => new NextRequest('http://localhost/api/health', { headers: h });
const versionInitiale = process.version;
const fixerVersion = (v: string) => Object.defineProperty(process, 'version', { value: v, configurable: true, writable: true });

beforeEach(() => {
  resetHealthProbesForTests();
  vi.stubEnv('HEALTH_DIAGNOSTIC_TOKEN', TOKEN);
  vi.stubEnv('JWT_SECRET', 'x'.repeat(48) + 'secret-de-test-assez-long');
  anomalies.report.mockClear();
  anomalies.resolve.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  fixerVersion(versionInitiale);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('H — section runtime de /api/health', () => {
  it('H-01 sonde publique : statut seul, aucune version de Node ni binaire', async () => {
    fixerVersion('v24.22.1');
    const b = await (await GET(req())).json();
    expect(b.checks.runtime).toEqual({ status: 'ok', production: false });
    expect(JSON.stringify(b)).not.toContain(process.execPath);
  });

  it('H-02 diagnostic autorisé : version, binaire, verdict, seuil, plage', async () => {
    fixerVersion('v24.22.1');
    const b = await (await GET(req({ 'x-health-token': TOKEN }))).json();
    expect(b.detailed).toBe(true);
    expect(b.checks.runtime).toMatchObject({
      status: 'ok', verdict: 'patched', node: 'v24.22.1', execPath: process.execPath, major: 24,
      patchedThreshold: '24.22.1', enginesRange: '>=24.22.1 <25', withinEngines: true,
    });
  });

  it('H-03 runtime non corrigé en production : statut global dégradé (jamais vert), HTTP 200', async () => {
    fixerVersion('v24.21.0');
    vi.stubEnv('NODE_ENV', 'production');
    const r = await GET(req({ 'x-health-token': TOKEN }));
    const b = await r.json();
    expect(r.status).toBe(200);
    expect(b.checks.runtime).toMatchObject({ status: 'error', verdict: 'vulnerable', production: true });
    expect(b.status).toBe('degraded');
    // Même configuration sur un runtime corrigé : vert (le runtime est bien la cause).
    resetHealthProbesForTests();
    fixerVersion('v24.22.1');
    expect((await (await GET(req({ 'x-health-token': TOKEN }))).json()).status).toBe('ok');
  });

  it('H-03 hors production : section en erreur, statut global inchangé', async () => {
    fixerVersion('v22.13.0');
    const b = await (await GET(req())).json();
    expect(b.checks.runtime).toEqual({ status: 'error', production: false });
    expect(b.status).toBe('ok');
  });

  it('H-04 `version` = version applicative, pas celle de Node', async () => {
    fixerVersion('v24.22.1');
    vi.stubEnv('APP_VERSION', '3.2.1');
    const b = await (await GET(req({ 'x-health-token': TOKEN }))).json();
    expect(b.version).toBe('3.2.1');
    expect(b.checks.runtime.node).toBe('v24.22.1');
  });
});

describe('S-01 — alerte de Supervision', () => {
  it('runtime non corrigé → anomalie « Autres traitements techniques » avec version et binaire', async () => {
    const r = { ...evaluateNodeRuntime('v22.13.0'), execPath: '/app/bin/node' };
    expect(await syncNodeRuntimeAnomaly(r, 'web-1')).toBe('reported');
    expect(anomalies.report).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'other',
      fingerprint: NODE_RUNTIME_FINGERPRINT,
      title: expect.stringContaining('v22.13.0'),
      detail: expect.objectContaining({ node: 'v22.13.0', execPath: '/app/bin/node', verdict: 'vulnerable', patchedThreshold: '22.23.4', container: 'web-1' }),
    }));
    expect(anomalies.resolve).not.toHaveBeenCalled();
  });

  it('ligne non prise en charge → anomalie', async () => {
    expect(await syncNodeRuntimeAnomaly({ ...evaluateNodeRuntime('v20.19.0'), execPath: '/n' }, null)).toBe('reported');
  });

  it('runtime corrigé → résolution automatique, aucun signalement', async () => {
    expect(await syncNodeRuntimeAnomaly({ ...evaluateNodeRuntime('v24.22.1'), execPath: '/n' }, 'web-2')).toBe('resolved');
    expect(anomalies.report).not.toHaveBeenCalled();
    expect(anomalies.resolve).toHaveBeenCalledWith(NODE_RUNTIME_FINGERPRINT, expect.objectContaining({ origin: 'node_runtime_startup_check' }));
  });

  it('corrigé mais hors plage déclarée (warning) : pas d’anomalie', async () => {
    await syncNodeRuntimeAnomaly({ ...evaluateNodeRuntime('v22.23.4'), execPath: '/n' }, null);
    expect(anomalies.report).not.toHaveBeenCalled();
  });

  it('ne lève jamais', async () => {
    anomalies.report.mockRejectedValueOnce(new Error('base'));
    await expect(syncNodeRuntimeAnomaly({ ...evaluateNodeRuntime('v22.13.0'), execPath: '/n' }, null)).resolves.toBe('none');
  });
});
