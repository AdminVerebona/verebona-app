/**
 * WF-04, VER-021, PKG-01 — préparation et import d'un package de MEP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unsafe = vi.fn();
const txQueries: Array<{ sql: string; params: unknown[] }> = [];
let txAnswers: Array<unknown[]> = [];
let env = 'preprod';

vi.mock('@/db', () => ({
  pgClient: {
    unsafe: (sql: string, params: unknown[]) => unsafe(sql, params),
    begin: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      unsafe: async (sql: string, params: unknown[]) => {
        txQueries.push({ sql, params });
        return txAnswers.shift() ?? [];
      },
    }),
  },
}));

const getVersion = vi.fn();
const getActiveVersion = vi.fn(async () => null);
vi.mock('../config-version.repository', () => ({
  getVersion: (id: number) => getVersion(id),
  getActiveVersion: () => getActiveVersion(),
}));
vi.mock('../environment', async (orig) => ({
  ...(await orig<typeof import('../environment')>()),
  getAiEnvironment: () => env,
}));

const { preparePackage, importPackage, buildPayload } = await import('../config-package.service');
const { emptyTreatmentConfig } = await import('../config-types');

const CASCADE = { database: 0.8, text: 0.6, semantic: 0.5, semanticEnabled: false };
const entries = (['T1', 'T2', 'T3', 'T4', 'T5', 'T6'] as const).map((t) => ({
  ...emptyTreatmentConfig(t),
  prompt: `prompt ${t}`,
  primaryModel: 'gemini-3.1-flash-lite',
  cascade: t === 'T2' ? CASCADE : null,
}));

const version = (over: Record<string, unknown> = {}) => ({
  id: 9, uid: '11111111-1111-4111-8111-111111111111', environment: 'preprod',
  status: 'ACTIVE', visibleNumber: 4, label: 'Printemps', entries, ...over,
});

const PKG_ROW = {
  id: 1, uid: '11111111-1111-4111-8111-111111111111', source_environment: 'preprod',
  visible_number: 4, label: 'Printemps', created_at: '2026-09-25T10:00:00Z',
  imported_at: null, imported_version_id: null,
};

beforeEach(() => {
  unsafe.mockReset();
  getVersion.mockReset();
  txQueries.length = 0;
  txAnswers = [];
  env = 'preprod';
});

describe('preparePackage', () => {
  it('prépare l’Active de préproduction (INSERT idempotent)', async () => {
    getVersion.mockResolvedValue(version());
    unsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([PKG_ROW]);
    const pkg = await preparePackage(9, 1);
    expect(pkg.uid).toBe(PKG_ROW.uid);
    const insert = unsafe.mock.calls.find(([sql]) => /INSERT INTO ai_config_packages/.test(sql));
    expect(insert?.[0]).toMatch(/ON CONFLICT \(uid\) DO NOTHING/);
  });

  it('rend le package existant au lieu d’une violation d’unicité', async () => {
    getVersion.mockResolvedValue(version({ status: 'VALIDATED' }));
    unsafe.mockResolvedValueOnce([PKG_ROW]);
    await expect(preparePackage(9, 1)).resolves.toMatchObject({ id: 1, visibleNumber: 4 });
    expect(unsafe.mock.calls.some(([sql]) => /INSERT/.test(sql))).toBe(false);
  });

  it('refuse une version qui n’est pas l’Active', async () => {
    getVersion.mockResolvedValue(version({ status: 'VALIDATED' }));
    unsafe.mockResolvedValueOnce([]);
    await expect(preparePackage(9, 1)).rejects.toMatchObject({ code: 'VERSION_NOT_ACTIVE' });
  });

  it('refuse en production : la production importe, elle ne prépare pas', async () => {
    env = 'production';
    getVersion.mockResolvedValue(version({ environment: 'production' }));
    await expect(preparePackage(9, 1)).rejects.toMatchObject({ code: 'PRODUCTION_ENVIRONMENT' });
    expect(unsafe).not.toHaveBeenCalled();
  });
});

describe('importPackage', () => {
  const payload = buildPayload('preprod', 4, 'Printemps', entries);

  it('crée la version et ses lignes dans UNE transaction, cascade comprise', async () => {
    env = 'production';
    txAnswers = [[], [], [{ id: 42 }]];
    const r = await importPackage(payload, PKG_ROW.uid, 1);
    expect(r).toMatchObject({ outcome: 'created', versionId: 42, visibleNumber: 4, divergence: null });

    const lignes = txQueries.filter((q) => /INSERT INTO ai_config_entries/.test(q.sql));
    expect(lignes).toHaveLength(6);
    for (const l of lignes) expect(l.sql).toMatch(/cascade/);
    const t2 = lignes.find((l) => l.params[1] === 'T2')!;
    expect(JSON.parse(String(t2.params[12]))).toEqual(CASCADE);
    const t1 = lignes.find((l) => l.params[1] === 'T1')!;
    expect(t1.params[12]).toBeNull();
    // Aucune écriture hors transaction.
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('reconnaît un package déjà importé sans rien écrire', async () => {
    env = 'production';
    txAnswers = [[{ id: 42, visible_number: 4 }]];
    await expect(importPackage(payload, PKG_ROW.uid, 1)).resolves.toMatchObject({ outcome: 'recognized', versionId: 42 });
    expect(txQueries.some((q) => /INSERT/.test(q.sql))).toBe(false);
  });

  it('bloque une collision de numéro (VER-013), sans créer de version', async () => {
    env = 'production';
    txAnswers = [[], [{ id: 3, uid: 'autre' }]];
    await expect(importPackage(payload, PKG_ROW.uid, 1)).rejects.toMatchObject({ code: 'VERSION_NUMBER_COLLISION' });
    expect(txQueries.some((q) => /INSERT/.test(q.sql))).toBe(false);
  });
});
