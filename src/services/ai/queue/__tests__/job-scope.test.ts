/**
 * Lot 49 — SEC-08 : périmètre d'un travail de la file revalidé à la mise en
 * file ET à l'exécution (jobs anciens, différés, relancés). Sans base :
 * exécutant simulé. Le contrôle réel (PostgreSQL, boucleur, T1/T3/T4) est
 * couvert par `l49-sec-p0-intercomptes.e2e.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  __setJobScopeCheckForTests, assertJobScope, enqueueScopeAllowed, foreignJobRefs, jobRefs,
} from '../job-scope';
import { isPermanentJobError } from '../queue-policy';

const dialect = new PgDialect();

/** Base simulée : `kind:id` → compte. */
function exec(owners: Record<string, number>) {
  return {
    execute: async (q: SQL) => {
      const { sql, params } = dialect.sqlToQuery(q);
      const kinds = [...sql.matchAll(/SELECT '([a-z_]+)' AS kind/g)].map((m) => m[1]);
      return kinds.flatMap((kind, i) => String(params[i]).replace(/[{}]/g, '').split(',').map(Number)
        .filter((id) => owners[`${kind}:${id}`] !== undefined)
        .map((id) => ({ kind, id, account_id: owners[`${kind}:${id}`] })));
    },
  };
}

afterEach(() => { __setJobScopeCheckForTests(async () => {}); });

describe('lot 49 — AC05 : périmètre des travaux T1 / T3 / T4', () => {
  it('AC05 — jobRefs : cible et identifiants du contexte (T1, T3, T4)', () => {
    expect(jobRefs({ targetType: 'asset_file', targetId: '12', payload: { assetId: 3, leadSourceId: 12, candidates: [] } }))
      .toEqual({ file: [12, 12], asset: [3] });
    expect(jobRefs({ targetType: 'asset', targetId: '3', payload: { sourceFileId: 9, userId: 77 } }))
      .toEqual({ asset: [3], file: [9] });
    expect(jobRefs({ targetType: 'equipment', targetId: '5', payload: null })).toEqual({ equipment: [5] });
    expect(jobRefs({ targetType: 'room', targetId: '6', payload: {} })).toEqual({ substructure: [6] });
    expect(jobRefs({ targetType: 'document', targetId: '8', payload: { fileIds: [8, 'x', 9] } })).toEqual({ file: [8, 8, 9] });
    // Balayages et cibles « compte » : rien à contrôler.
    expect(jobRefs({ targetType: 't3_sweep', targetId: '1:2', payload: { cycleId: 'c', afterAccountId: 4 } })).toEqual({});
  });

  it('AC05 — job sans compte (balayage) : aucun contrôle', async () => {
    expect(await foreignJobRefs({ accountId: null, targetType: 'asset', targetId: '1' }, exec({ 'asset:1': 2 }))).toEqual([]);
  });

  it('AC05 — exécution : référence d’un autre compte → échec DÉFINITIF (PermanentJobError)', async () => {
    const e = exec({ 'file:12': 10, 'asset:3': 20 });
    const err = await assertJobScope(
      { id: 1, treatment: 'T4', accountId: 10, targetType: 'asset_file', targetId: '12', payload: { assetId: 3, leadSourceId: 12 } }, e,
    ).catch((x) => x);
    expect(isPermanentJobError(err)).toBe(true);
    expect(String(err.message)).toContain('asset 3');
  });

  it('AC05 — exécution : tout du compte (ou disparu) → l’exécutant tourne normalement', async () => {
    const e = exec({ 'file:12': 10, 'asset:3': 10 });
    await expect(assertJobScope({ id: 1, accountId: 10, targetType: 'asset_file', targetId: '12', payload: { assetId: 3 } }, e)).resolves.toBeUndefined();
    // Cible supprimée entre-temps : TARGET_GONE reste du ressort de l'exécutant.
    await expect(assertJobScope({ id: 2, accountId: 10, targetType: 'asset', targetId: '99', payload: null }, e)).resolves.toBeUndefined();
  });

  it('AC05 — mise en file : référence étrangère → refusée ; panne du contrôle → REFUSÉE (lot 54, SEC-05 : fail closed)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    __setJobScopeCheckForTests((job) => assertJobScope(job, exec({ 'asset:3': 20 })));
    expect(await enqueueScopeAllowed({ treatment: 'T3', scope: { accountId: 10, targetType: 'asset', targetId: 3 } })).toBe(false);
    __setJobScopeCheckForTests((job) => assertJobScope(job, exec({ 'asset:3': 10 })));
    expect(await enqueueScopeAllowed({ treatment: 'T3', scope: { accountId: 10, targetType: 'asset', targetId: 3 } })).toBe(true);
    __setJobScopeCheckForTests(async () => { throw new Error('base indisponible'); });
    expect(await enqueueScopeAllowed({ treatment: 'T3', scope: { accountId: 10, targetType: 'asset', targetId: 3 } })).toBe(false);
    warn.mockRestore();
    err.mockRestore();
  });
});
