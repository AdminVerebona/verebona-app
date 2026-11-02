/**
 * Lot 102C — copies de données réelles (production) hors production : règles
 * pures, garde de restauration, détection de copie de base, purge planifiée.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  authorizationValidityHours, classifyRestoreOrigin, copyRetentionDays, decideRestoreOrigin, detectDatabaseCopy, isProductionEnvironment,
} from '../rules';
import { RESTORE_KEEP_CURRENT_TABLES } from '@/services/backup/schema-signature';
import { dailyTasks } from '@/services/scheduling/daily-maintenance-scheduler';

const read = (p: string) => readFileSync(resolve(__dirname, '../../../../..', p), 'utf8');
const PREPROD = { NEXT_PUBLIC_APP_ENV: 'preprod' };
const NOW = new Date('2033-05-10T10:00:00Z');

describe('L102C-COP-01 — environnements et paramètres', () => {
  it('production reconnue (liste paramétrable)', () => {
    expect(isProductionEnvironment('production', {})).toBe(true);
    expect(isProductionEnvironment('preprod', {})).toBe(false);
    expect(isProductionEnvironment('prd', { PRODUCTION_ENVIRONMENT_NAMES: 'prd' })).toBe(true);
  });
  it('durées par défaut et bornes', () => {
    expect(copyRetentionDays({})).toBe(30);
    expect(copyRetentionDays({ PRODUCTION_COPY_RETENTION_DAYS: '7' })).toBe(7);
    expect(copyRetentionDays({ PRODUCTION_COPY_RETENTION_DAYS: '365' })).toBe(30);
    expect(authorizationValidityHours({})).toBe(24);
  });
});

describe('L102C-COP-02 — restauration d’un point d’un autre environnement : refus par défaut', () => {
  it('origine', () => {
    expect(classifyRestoreOrigin('preprod', PREPROD)).toBe('same_environment');
    expect(classifyRestoreOrigin('production', PREPROD)).toBe('foreign_production');
    expect(classifyRestoreOrigin('recette', PREPROD)).toBe('foreign_other');
    expect(classifyRestoreOrigin('unknown', PREPROD)).toBe('unknown_origin');
    expect(classifyRestoreOrigin('production', {})).toBe('same_environment'); // poste sans environnement
  });
  it('même environnement : permis sans autorisation (mécanisme 82E inchangé)', () => {
    expect(decideRestoreOrigin({ manifestEnvironment: 'preprod', backupId: 'b1', authorization: null, now: NOW, env: PREPROD })).toMatchObject({ allowed: true, copyId: null });
  });
  it('point de production en préproduction, sans autorisation : REFUSÉ', () => {
    const d = decideRestoreOrigin({ manifestEnvironment: 'production', backupId: 'b1', authorization: null, now: NOW, env: PREPROD });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toMatch(/refusé par défaut[\s\S]*autoriser explicitement/);
  });
  it('origine inconnue : traitée comme étrangère (prudence)', () => {
    expect(decideRestoreOrigin({ manifestEnvironment: '', backupId: 'b1', authorization: null, now: NOW, env: PREPROD }).allowed).toBe(false);
  });
  it('autorisation pour un AUTRE point : refusé ; pour CE point et valable : permis et tracé', () => {
    const a = { id: 9, backupId: 'b2', authorizedAt: new Date(NOW.getTime() - 3_600_000) };
    expect(decideRestoreOrigin({ manifestEnvironment: 'production', backupId: 'b1', authorization: a, now: NOW, env: PREPROD }).allowed).toBe(false);
    expect(decideRestoreOrigin({ manifestEnvironment: 'production', backupId: 'b2', authorization: a, now: NOW, env: PREPROD })).toEqual({ allowed: true, origin: 'foreign_production', copyId: 9 });
  });
  it('autorisation expirée : refusé', () => {
    const a = { id: 9, backupId: 'b2', authorizedAt: new Date(NOW.getTime() - 25 * 3_600_000) };
    const d = decideRestoreOrigin({ manifestEnvironment: 'production', backupId: 'b2', authorization: a, now: NOW, env: PREPROD });
    expect(d.allowed).toBe(false);
  });
  it('branchée dans la restauration AVANT toute écriture, et la copie importée est tracée', () => {
    const src = read('src/services/backup/database-restore.service.ts');
    const garde = src.indexOf('guardRestoreOrigin(manifest.environment');
    expect(garde).toBeGreaterThan(0);
    expect(garde).toBeLessThan(src.indexOf('inspectRestorePoint(q, manifest)'));
    expect(src).toMatch(/markRestoreImported\(originDecision\.copyId/);
  });
  it('une restauration ne remplace jamais le registre des copies ni l’identité de la base', () => {
    expect(RESTORE_KEEP_CURRENT_TABLES).toEqual(expect.arrayContaining(['production_data_copies', 'environment_identity']));
  });
});

describe('L102C-COP-03 — copie de base hors application : détectée', () => {
  it('base initialisée en production, servie en préproduction → copie', () => {
    expect(detectDatabaseCopy({ storedEnvironment: 'production', env: PREPROD })).toEqual({ copy: true, source: 'production', target: 'preprod' });
  });
  it('pas de faux positif : même environnement, renommage hors production, production elle-même', () => {
    expect(detectDatabaseCopy({ storedEnvironment: 'preprod', env: PREPROD }).copy).toBe(false);
    expect(detectDatabaseCopy({ storedEnvironment: 'preproduction', env: PREPROD }).copy).toBe(false);
    expect(detectDatabaseCopy({ storedEnvironment: 'production', env: { NEXT_PUBLIC_APP_ENV: 'production' } }).copy).toBe(false);
    expect(detectDatabaseCopy({ storedEnvironment: null, env: PREPROD }).copy).toBe(false);
  });
});

describe('L102C-COP-04 — purge planifiée et Supervision', () => {
  it('tâche quotidienne présente hors production, absente en production et sans environnement', () => {
    expect(dailyTasks({ NEXT_PUBLIC_APP_ENV: 'preprod' } as unknown as NodeJS.ProcessEnv).map((t) => t.lock)).toContain('daily-production-copies');
    expect(dailyTasks({ NEXT_PUBLIC_APP_ENV: 'production' } as unknown as NodeJS.ProcessEnv).map((t) => t.lock)).not.toContain('daily-production-copies');
    expect(dailyTasks({} as unknown as NodeJS.ProcessEnv).map((t) => t.lock)).not.toContain('daily-production-copies');
  });
  it('la purge passe par le workflow de suppression existant et n’agit jamais en production', () => {
    const src = read('src/services/admin/production-copies/production-copies.service.ts');
    expect(src).toMatch(/scheduleDeletion\(\{ accountId, userId: owner, reason: 'ADMIN', origin: 'system'/);
    expect(src).toMatch(/executeScheduledDeletion\(schedule\.id/);
    expect(src).toMatch(/isProductionEnvironment\(currentEnvironmentName\(\)\)\) return \{ purged: 0, failed: 0, skipped: 'production' \}/);
  });
  it('anomalie de Supervision tant qu’une copie est active ou en purge ; balayage et démarrage', () => {
    expect(read('src/services/admin/production-copies/production-copies.service.ts')).toMatch(/status IN \('active', 'purging'\) ORDER BY id`/);
    expect(read('src/services/admin/supervision-sweep.service.ts')).toMatch(/syncProductionCopiesAnomaly\(\)/);
    expect(read('src/instrumentation-node.ts')).toMatch(/startupProductionCopyCheck\(\)/);
  });
  it('autorisation et clôture : routes BO gardées, motif obligatoire, journal d’audit', () => {
    const r = read('src/app/api/admin/ops/production-copies/route.ts') + read('src/app/api/admin/ops/production-copies/[id]/route.ts');
    expect((r.match(/requireAdmin\(request\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    const svc = read('src/services/admin/production-copies/production-copies.service.ts');
    expect(svc).toMatch(/action: 'PRODUCTION_COPY_AUTHORIZE'/);
    expect(svc).toMatch(/action: 'PRODUCTION_COPY_CLOSE'/);
    expect(svc).toMatch(/reason\.length < 10/);
  });
});
