/**
 * Page BO « Exploitation » (lot 25, chantier B) — aucune valeur de variable,
 * aucun secret ni URL signée dans les réponses :
 *   · configuration : noms et présence seulement (valeurs posées absentes du
 *     JSON) ; obligatoires et retirées signalées ;
 *   · santé admin : l'avertissement « variable retirée » de /api/health (qui
 *     cite la valeur) est remplacé par les noms ; filet `redactDeep`.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SECRET = 'sk_live_TRES_SECRET_123456';
const etat = vi.hoisted(() => ({
  report: {
    result: {
      status: 'ok', version: '1', detailed: true, timestamp: 't', uptime: 1,
      checks: {
        database: { status: 'ok', responseTime: 3 },
        readiness: { ready: true, phase: 'ready', pendingCritical: 0, pendingOptional: 0 },
        s3: { status: 'error', error: 'NETWORK (https://bucket.s3.example/k?X-Amz-Signature=abc&X-Amz-Credential=AKIA)' },
        migrations: { status: 'ok' },
        aiPromptArchitecture: { status: 'warning', warnings: [{ treatment: null, code: 'RETIRED_ENV_VARIABLE', switchName: 'AI_AGENDA_ENGINE', switchMode: 'valeur-posee-xyz', message: 'AI_AGENDA_ENGINE=valeur-posee-xyz est posée' }] },
        assistantRateLimiter: { status: 'warning', mode: 'memory', degradedSince: null, lastError: 'postgres://user:motdepasse@db:5432/app' },
      },
    },
    httpStatus: 200,
  },
}));

vi.mock('@/lib/health/diagnostic', () => ({ buildHealthReport: async () => structuredClone(etat.report) }));
vi.mock('@/db', () => ({
  pgClient: Object.assign(async () => [], {}),
  getMigrationStatus: () => ({ phase: 'ready', mode: 'run', startedAt: null, finishedAt: null, durationMs: 5, failures: [] }),
}));
vi.mock('@/db/migration-index', () => ({
  readMigrationFiles: async () => [],
  migrationCatalog: () => [],
  readSchemaState: async () => ({ tracked: true, pendingCritical: [], pendingOptional: ['0242_upload_operations_idx_1.sql'] }),
  listInvalidIndexes: async () => ['x_idx'],
}));

const { buildConfigReport, parseEnvExample, getConfigReport, OBLIGATOIRES } = await import('../env-catalog');
const { getAdminHealth } = await import('../health-admin.service');
const { redactString } = await import('../redact');

describe('configuration : noms seulement, jamais de valeur', () => {
  it('valeurs posées absentes de la réponse ; présence, niveau, retirées', async () => {
    const env = {
      JWT_SECRET: SECRET, STRIPE_SECRET_KEY: SECRET, OVH_S3_SECRET_ACCESS_KEY: SECRET, DATABASE_URL: `postgres://u:${SECRET}@h/db`,
      AI_AGENDA_ENGINE: 'valeur-posee-xyz', OVH_S3_SECRET_KEY: SECRET, MIGRATIONS_REPAIR_ON_BOOT: 'on',
    };
    const r = await getConfigReport(env);
    const json = JSON.stringify(r);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('valeur-posee-xyz');
    expect(r.source).toBe('.env.example');
    const toutes = r.sections.flatMap((s) => s.variables);
    expect(toutes.find((v) => v.name === 'JWT_SECRET')).toMatchObject({ present: true, level: 'obligatoire' });
    expect(toutes.find((v) => v.name === 'DATABASE_URL')).toMatchObject({ present: true, level: 'obligatoire' });
    expect(toutes.find((v) => v.name === 'OVH_S3_BUCKET')).toMatchObject({ present: false, level: 'obligatoire' });
    expect(toutes.find((v) => v.name === 'DB_POOL_METRICS_LOG_INTERVAL_S')).toMatchObject({ level: 'facultative' });
    expect(toutes.find((v) => v.name === 'NEXT_PUBLIC_APP_URL')).toMatchObject({ buildTime: true });
    expect(r.counts.missingRequired).toContain('OVH_S3_BUCKET');
    expect(r.retired.filter((x) => x.present).map((x) => x.name).sort()).toEqual(['AI_AGENDA_ENGINE', 'MIGRATIONS_REPAIR_ON_BOOT', 'OVH_S3_SECRET_KEY']);
    expect(r.reminder).toContain('Scalingo > Environnement');
  });

  it('chaque variable active de .env.example est listée ; valeurs d’exemple non reprises', () => {
    const texte = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
    const actives = [...texte.matchAll(/^([A-Z][A-Z0-9_]{2,})=/gm)].map((m) => m[1]);
    const noms = new Set(parseEnvExample(texte).flatMap((s) => s.variables.map((v) => v.name)));
    for (const n of actives) expect(noms.has(n)).toBe(true);
    for (const n of Object.keys(OBLIGATOIRES)) expect(noms.has(n)).toBe(true);
    const r = buildConfigReport(parseEnvExample(texte), {}, { path: '.env.example', error: null });
    expect(JSON.stringify(r)).not.toContain('gemini-2.5-flash-lite');
    expect(JSON.stringify(r)).not.toContain('s3.gra.io.cloud.ovh.net');
  });

  it('fichier illisible : obligatoires et retirées malgré tout', async () => {
    const r = await getConfigReport({}, '/chemin/inexistant');
    expect(r.source).toBeNull();
    expect(r.sourceError).toContain('ENOENT');
    expect(r.counts.missingRequired).toEqual(expect.arrayContaining(Object.keys(OBLIGATOIRES)));
  });
});

describe('santé admin : diagnostic détaillé sans valeur ni secret', () => {
  it('variables retirées par leur nom, URL signée et identifiants masqués, schéma relu', async () => {
    const r = await getAdminHealth({ AI_AGENDA_ENGINE: 'valeur-posee-xyz', CONTAINER: 'web-1' });
    const json = JSON.stringify(r);
    expect(json).not.toContain('valeur-posee-xyz');
    expect(json).not.toContain('motdepasse');
    expect(json).not.toContain('X-Amz-Signature');
    expect(r.health.checks).not.toHaveProperty('aiPromptArchitecture');
    expect(r.retiredVariablesSet.map((v) => v.name)).toEqual(['AI_AGENDA_ENGINE']);
    expect(r.schema.database).toMatchObject({ pendingOptional: ['0242_upload_operations_idx_1.sql'], invalidIndexes: ['x_idx'] });
    expect(r.schema.postdeploy.traced).toBe(false);
    expect(r.instance).toBe('web-1');
  });

  it('redactString : identifiants d’URL, URL signées, Bearer', () => {
    expect(redactString('postgres://u:p@h:5432/d')).toBe('postgres://***@h:5432/d');
    expect(redactString('voir https://b.s3/k?X-Amz-Signature=abc fin')).toBe('voir [URL signée masquée] fin');
    expect(redactString('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer ***');
    expect(redactString('https://app.verebona.fr/admin')).toBe('https://app.verebona.fr/admin');
  });
});
