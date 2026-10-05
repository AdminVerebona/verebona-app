/**
 * APP-PERF-26 — configuration OVH S3 centralisée, validée, observable.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import {
  classifyS3Error,
  getS3Client,
  getS3Config,
  readS3Config,
  resetS3ForTests,
  s3ClientOptions,
  S3ConfigError,
  S3_ENV,
  signGetUrl,
} from '@/lib/s3-config';

const SECRET = 'tr3s-s3cret-valeur';
const base = {
  OVH_S3_ENDPOINT: 'https://s3.gra.io.cloud.ovh.net',
  OVH_S3_REGION: 'gra',
  OVH_S3_BUCKET: 'verebona-test',
  OVH_S3_ACCESS_KEY_ID: 'AKIDTEST',
  OVH_S3_SECRET_ACCESS_KEY: SECRET,
};

describe('readS3Config', () => {
  it('T-01 : variables canoniques seules → configuration valide, style chemin par défaut', () => {
    const r = readS3Config(base);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.config).toMatchObject({ bucket: 'verebona-test', region: 'gra', forcePathStyle: true, signedUrlTtlSeconds: 3600 });
  });

  it('mode d’adressage réglable (virtual-host)', () => {
    expect(readS3Config({ ...base, OVH_S3_FORCE_PATH_STYLE: 'false' }).config?.forcePathStyle).toBe(false);
    expect(readS3Config({ ...base, OVH_S3_FORCE_PATH_STYLE: 'peut-être' }).config).toBeNull();
  });

  it('CA-01 : l’ancienne paire seule n’est JAMAIS utilisée — diagnostic LEGACY_ONLY', () => {
    const { OVH_S3_ACCESS_KEY_ID: _a, OVH_S3_SECRET_ACCESS_KEY: _s, ...sansCanon } = base;
    const r = readS3Config({ ...sansCanon, OVH_S3_ACCESS_KEY: 'AKIDTEST', OVH_S3_SECRET_KEY: SECRET });
    expect(r.config).toBeNull();
    expect(r.errors.map((e) => e.code)).toEqual(['LEGACY_ONLY', 'LEGACY_ONLY']);
    expect(r.errors.map((e) => e.variable).sort()).toEqual(['OVH_S3_ACCESS_KEY_ID', 'OVH_S3_SECRET_ACCESS_KEY']);
  });

  it('valeurs contradictoires détectées, SANS exposer les secrets', () => {
    const r = readS3Config({ ...base, OVH_S3_SECRET_KEY: 'autre-secret-ancien' });
    expect(r.config).not.toBeNull();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ code: 'CONFLICT', variable: 'OVH_S3_SECRET_KEY' });
    const tout = JSON.stringify(r);
    expect(tout.replace(JSON.stringify(r.config), '')).not.toContain(SECRET);
    expect(tout).not.toContain('autre-secret-ancien');
  });

  it('région incohérente avec l’endpoint OVH, endpoint invalide, variables manquantes', () => {
    expect(readS3Config({ ...base, OVH_S3_REGION: 'sbg' }).warnings[0]).toMatchObject({ code: 'CONFLICT', variable: 'OVH_S3_REGION' });
    expect(readS3Config({ ...base, OVH_S3_ENDPOINT: 'pas une url' }).errors[0]).toMatchObject({ code: 'INVALID', variable: 'OVH_S3_ENDPOINT' });
    const vide = readS3Config({});
    expect(vide.config).toBeNull();
    expect(vide.errors.map((e) => e.variable).sort()).toEqual(['OVH_S3_ACCESS_KEY_ID', 'OVH_S3_BUCKET', 'OVH_S3_ENDPOINT', 'OVH_S3_SECRET_ACCESS_KEY']);
  });

  it('délais : profils interactive/worker, valeurs hors bornes → défaut + avertissement', () => {
    const r = readS3Config({ ...base, OVH_S3_REQUEST_TIMEOUT_MS: '12000', EXPORTS_S3_REQUEST_TIMEOUT_MS: '5', OVH_S3_SIGNED_URL_TTL_S: '900' });
    expect(r.config?.timeouts.interactive).toEqual({ connectionTimeout: 5000, requestTimeout: 12000, maxAttempts: 2 });
    expect(r.config?.timeouts.worker).toEqual({ connectionTimeout: 10000, requestTimeout: 60000, maxAttempts: 3 });
    expect(r.config?.signedUrlTtlSeconds).toBe(900);
    expect(r.warnings.some((w) => w.variable === 'EXPORTS_S3_REQUEST_TIMEOUT_MS')).toBe(true);
  });

  it('options du client : seuls délais et tentatives diffèrent entre profils', () => {
    const c = readS3Config(base).config!;
    const i = s3ClientOptions(c, 'interactive');
    const w = s3ClientOptions(c, 'worker');
    expect({ ...i, maxAttempts: 0, requestHandler: null }).toEqual({ ...w, maxAttempts: 0, requestHandler: null });
    expect(i.maxAttempts).toBe(2);
    expect(w.maxAttempts).toBe(3);
  });
});

describe('fabrique et erreurs', () => {
  const avant = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('OVH_S3_')) delete process.env[k];
    Object.assign(process.env, Object.fromEntries(Object.entries(avant).filter(([k]) => k.startsWith('OVH_S3_'))));
    resetS3ForTests();
  });

  it('CA-03 : configuration invalide → S3ConfigError typée, sans secret', () => {
    for (const k of Object.values(S3_ENV)) delete process.env[k];
    process.env.OVH_S3_SECRET_KEY = SECRET;
    resetS3ForTests();
    let err: unknown;
    try { getS3Config(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(S3ConfigError);
    expect((err as S3ConfigError).code).toBe('S3_CONFIG_INVALID');
    expect((err as Error).message).not.toContain(SECRET);
    expect(classifyS3Error(err).kind).toBe('CONFIG');
  });

  it('client partagé par profil ; URL signée calculée localement avec la config canonique', async () => {
    Object.assign(process.env, base);
    resetS3ForTests();
    expect(getS3Client('interactive')).toBe(getS3Client('interactive'));
    expect(getS3Client('worker')).not.toBe(getS3Client('interactive'));
    const url = await signGetUrl({ key: 'a/b.pdf', expiresIn: 120 });
    expect(url).toMatch(/^https:\/\/s3\.gra\.io\.cloud\.ovh\.net\/verebona-test\/a\/b\.pdf\?/);
    expect(url).toContain('X-Amz-Expires=120');
    const d = new Date('2026-10-05T10:00:00Z');
    expect(await signGetUrl({ key: 'k', signingDate: d })).toBe(await signGetUrl({ key: 'k', signingDate: d }));
  });

  it('T-03 : classification des erreurs (403, absent, délai, plage, 304, réseau)', () => {
    expect(classifyS3Error({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }).kind).toBe('ACCESS_DENIED');
    expect(classifyS3Error({ name: 'NoSuchKey' }).kind).toBe('NOT_FOUND');
    expect(classifyS3Error({ name: 'TimeoutError' }).kind).toBe('TIMEOUT');
    expect(classifyS3Error({ name: 'InvalidRange', $metadata: { httpStatusCode: 416 } }).kind).toBe('INVALID_RANGE');
    expect(classifyS3Error({ name: '304', $metadata: { httpStatusCode: 304 } }).kind).toBe('NOT_MODIFIED');
    expect(classifyS3Error({ code: 'ENOTFOUND', name: 'Error' }).kind).toBe('UNREACHABLE');
    expect(classifyS3Error({ name: 'AbortError' }).kind).toBe('ABORTED');
  });

  it('journalisation : ni secret ni URL signée', async () => {
    const { logS3Error } = await import('@/lib/s3-config');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logS3Error('test', Object.assign(new Error(`https://s3/x?X-Amz-Signature=abc&cred=${SECRET}`), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
    const sortie = JSON.stringify(spy.mock.calls);
    expect(sortie).toContain('ACCESS_DENIED');
    expect(sortie).not.toContain('X-Amz-Signature');
    expect(sortie).not.toContain(SECRET);
  });
});

// ── Garde-fou de non-divergence ─────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f === '__tests__' || f === 'node_modules' || p.endsWith(join('src', 'test'))) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(f) && !/\.(test|e2e)\.tsx?$/.test(f)) {
      out.push(p);
    }
  }
  return out;
}

describe('garde-fou de non-divergence', () => {
  const racine = process.cwd();
  const fichiers = walk(join(racine, 'src'));

  it('aucune lecture de process.env.OVH_S3_* hors de src/lib/s3-config.ts', () => {
    const fautifs = fichiers
      .filter((p) => !p.endsWith(join('lib', 's3-config.ts')))
      // Composant navigateur : NEXT_PUBLIC_*, divergence signalée par la config serveur.
      .filter((p) => /process\.env(\.|\[['"])OVH_S3_/.test(readFileSync(p, 'utf-8')))
      .map((p) => relative(racine, p));
    expect(fautifs).toEqual([]);
  });

  it('aucun `new S3Client(` hors de la fabrique', () => {
    const fautifs = fichiers
      .filter((p) => !p.endsWith(join('lib', 's3-config.ts')))
      .filter((p) => /new\s+S3Client\s*\(/.test(readFileSync(p, 'utf-8')))
      .map((p) => relative(racine, p));
    expect(fautifs).toEqual([]);
  });

  it('les variables canoniques sont documentées dans .env.example', () => {
    const ex = readFileSync(join(racine, '.env.example'), 'utf-8');
    for (const v of Object.values(S3_ENV)) expect(ex).toMatch(new RegExp(`^${v}=`, 'm'));
    expect(ex).not.toMatch(/^OVH_S3_ACCESS_KEY=/m);
    expect(ex).not.toMatch(/^OVH_S3_SECRET_KEY=/m);
  });
});
