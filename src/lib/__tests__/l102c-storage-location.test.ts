/**
 * Lot 102C — localisation du stockage documentaire (décision PO « stockage
 * durable des documents en France ») : garde au démarrage, santé, Supervision.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertStorageLocationAllowed, evaluateStorageLocation, ovhRegionOfHost } from '../storage-location';

const read = (p: string) => readFileSync(resolve(__dirname, '../../..', p), 'utf8');
const base = { OVH_S3_BUCKET: 'verebona-preprod', OVH_S3_ENDPOINT: 'https://s3.gra.io.cloud.ovh.net', OVH_S3_REGION: 'gra' };

describe('L102C-STO-01 — évaluation (pure)', () => {
  it('régions OVH françaises reconnues (standard, performance, ancien hôte, virtual-host)', () => {
    expect(ovhRegionOfHost('s3.gra.io.cloud.ovh.net')).toBe('gra');
    expect(ovhRegionOfHost('s3.eu-west-par.io.cloud.ovh.net')).toBe('eu-west-par');
    expect(ovhRegionOfHost('mybucket.s3.sbg.perf.cloud.ovh.net')).toBe('sbg');
    expect(ovhRegionOfHost('s3.rbx.cloud.ovh.net')).toBe('rbx');
    expect(ovhRegionOfHost('s3.amazonaws.com')).toBeNull();
  });
  it('Gravelines / Paris : ok', () => {
    expect(evaluateStorageLocation(base).status).toBe('ok');
    expect(evaluateStorageLocation({ ...base, OVH_S3_ENDPOINT: 'https://s3.eu-west-par.io.cloud.ovh.net', OVH_S3_REGION: 'eu-west-par' }).status).toBe('ok');
  });
  it('région absente : même défaut que s3-config (gra) — ok', () => {
    expect(evaluateStorageLocation({ ...base, OVH_S3_REGION: '' }).status).toBe('ok');
  });
  it('hors France : erreur avec motifs (point d’accès et région)', () => {
    const s = evaluateStorageLocation({ ...base, OVH_S3_ENDPOINT: 'https://s3.de.io.cloud.ovh.net', OVH_S3_REGION: 'de' });
    expect(s.status).toBe('error');
    expect(s.problems).toEqual(expect.arrayContaining(['ENDPOINT_REGION_NOT_ALLOWED', 'REGION_NOT_ALLOWED']));
  });
  it('hôte non OVH : refusé sauf déclaration explicite STORAGE_ALLOWED_ENDPOINT_HOSTS', () => {
    const env = { ...base, OVH_S3_ENDPOINT: 'https://stockage.example.fr' };
    expect(evaluateStorageLocation(env).problems).toContain('ENDPOINT_NOT_RECOGNIZED');
    expect(evaluateStorageLocation({ ...env, STORAGE_ALLOWED_ENDPOINT_HOSTS: 'stockage.example.fr' }).status).toBe('ok');
  });
  it('liste paramétrable et buckets restreints', () => {
    expect(evaluateStorageLocation({ ...base, STORAGE_ALLOWED_REGIONS: 'sbg' }).status).toBe('error');
    expect(evaluateStorageLocation({ ...base, STORAGE_ALLOWED_BUCKETS: 'autre' }).problems).toContain('BUCKET_NOT_ALLOWED');
  });
  it('point d’accès public (navigateur) hors France : signalé', () => {
    expect(evaluateStorageLocation({ ...base, NEXT_PUBLIC_OVH_S3_ENDPOINT: 'https://s3.uk.io.cloud.ovh.net' }).problems).toContain('PUBLIC_ENDPOINT_NOT_ALLOWED');
  });
  it('non configuré : « unconfigured », jamais « ok »', () => {
    expect(evaluateStorageLocation({}).status).toBe('unconfigured');
  });
  it('aucune valeur de secret dans le statut', () => {
    const s = evaluateStorageLocation({ ...base, OVH_S3_SECRET_ACCESS_KEY: 'SECRET-123', OVH_S3_ACCESS_KEY_ID: 'AKID-456' });
    expect(JSON.stringify(s)).not.toMatch(/SECRET-123|AKID-456/);
  });
});

describe('L102C-STO-02 — garde au démarrage (préproduction ET production)', () => {
  const bad = { ...base, OVH_S3_ENDPOINT: 'https://s3.de.io.cloud.ovh.net', OVH_S3_REGION: 'de' };
  it('NODE_ENV=production : démarrage refusé, message explicite', () => {
    expect(() => assertStorageLocationAllowed({ ...bad, NODE_ENV: 'production' })).toThrow(/Démarrage refusé[\s\S]*STORAGE_LOCATION_ACKNOWLEDGED_REGION=de/);
  });
  it('reconnaissance explicite : démarre, mais statut reste en erreur (Dégradé, anomalie)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = assertStorageLocationAllowed({ ...bad, NODE_ENV: 'production', STORAGE_LOCATION_ACKNOWLEDGED_REGION: 'de' });
    expect(s).toMatchObject({ status: 'error', acknowledged: true });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
  it('une reconnaissance pour une AUTRE région ne vaut rien', () => {
    expect(() => assertStorageLocationAllowed({ ...bad, NODE_ENV: 'production', STORAGE_LOCATION_ACKNOWLEDGED_REGION: 'uk' })).toThrow();
  });
  it('hors production : avertissement seulement', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(assertStorageLocationAllowed({ ...bad, NODE_ENV: 'development' }).status).toBe('error');
    err.mockRestore();
  });
  it('branchée au démarrage AVANT les migrations, Supervision après', () => {
    const src = read('src/instrumentation-node.ts');
    const garde = src.indexOf('assertStorageLocationAllowed()');
    expect(garde).toBeGreaterThan(0);
    expect(garde).toBeLessThan(src.indexOf('assertMigrationBootPolicy(await ensureMigrations())'));
    expect(src.indexOf('syncStorageLocationAnomaly(storageLocation)')).toBeGreaterThan(src.indexOf('assertMigrationBootPolicy(await ensureMigrations())'));
  });
});

describe('L102C-STO-03 — santé, diagnostic global, Supervision', () => {
  it('/api/health : section storageLocation, statut seul en public, Dégradé si erreur', () => {
    const src = read('src/lib/health/diagnostic.ts');
    expect(src).toMatch(/result\.checks\.storageLocation = detailed\s*\?/);
    expect(src).toMatch(/: \{ status: l\.status \};/);
    expect(src).toMatch(/storageLocation\?\.status === 'error'\) \{[\s\S]{0,300}result\.status = 'degraded'/);
  });
  it('diagnostic global : technique/versions.json › stockageDocumentaire', () => {
    expect(read('src/services/admin/diagnostics-export/engine.ts')).toMatch(/stockageDocumentaire: await safe\(/);
  });
  it('Supervision : balayage quotidien et à l’ouverture de l’écran', () => {
    expect(read('src/services/admin/supervision-sweep.service.ts')).toMatch(/syncStorageLocationAnomaly\(\)/);
  });
});
