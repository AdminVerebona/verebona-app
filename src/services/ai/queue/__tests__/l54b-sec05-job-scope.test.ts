/**
 * Lot 54 (54B) — ticket SEC-P0-CORR, SEC-05 « Isolation exhaustive des
 * traitements IA » : toutes les cibles (dont les Opérations), références
 * imbriquées, fail closed, travaux techniques sans compte encadrés. Sans
 * base : exécutant simulé. Le contrôle réel est exercé sur PostgreSQL par
 * `l54b-sec-p0-isolation.e2e.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  __setJobScopeCheckForTests, analyseJob, assertJobScope, enqueueScopeAllowed, jobRefs, structuralJobRefusal,
  PAYLOAD_MAX_DEPTH,
} from '../job-scope';
import { isPermanentJobError } from '../queue-policy';

const dialect = new PgDialect();

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

const job = (over: Partial<Parameters<typeof assertJobScope>[0]>) => ({
  id: 1, treatment: 'T3', accountId: 10, targetType: null, targetId: null, payload: null, ...over,
}) as Parameters<typeof assertJobScope>[0];

afterEach(() => { __setJobScopeCheckForTests(async () => {}); vi.restoreAllMocks(); });

describe('SEC-05 — inventaire des cibles et références imbriquées', () => {
  it('SEC-05-01 — références imbriquées (tableaux, objets) des contextes T1/T3/T4/Opérations', () => {
    // T3 Opérations : events[].fileId / assetId / agendaItemId ; projection agenda : events[].operationIds[].
    expect(jobRefs({
      targetType: 'business_operations', targetId: '10',
      payload: { kind: 'business_operations', accountId: 10, events: [{ trigger: 'document_analyzed', fileId: 5 }, { trigger: 'asset_updated', assetId: 7 }, { agendaItemId: 9 }] },
    })).toEqual({ file: [5], asset: [7], agenda_item: [9] });
    expect(jobRefs({ targetType: 'business_operations_agenda', targetId: '10', payload: { events: [{ operationIds: [11, 12] }] } }))
      .toEqual({ operation: [11, 12] });
    // T4 : candidats imbriqués.
    expect(jobRefs({ targetType: 'asset_file', targetId: '3', payload: { leadSourceId: 3, candidates: [{ assetId: 4, equipmentId: 6, nested: { supplierId: 8 } }] } }))
      .toEqual({ file: [3, 3], asset: [4], equipment: [6], supplier: [8] });
  });

  it('SEC-05-02 — cible « compte » des Opérations : target_id = compte du travail, sinon refus', () => {
    expect(structuralJobRefusal({ accountId: 10, targetType: 'business_operations', targetId: '10', payload: {} })).toBeNull();
    expect(structuralJobRefusal({ accountId: 10, targetType: 'business_operations', targetId: '11', payload: {} })).toMatch(/hors du compte 10/);
    expect(structuralJobRefusal({ accountId: 10, targetType: 'business_operations_agenda', targetId: '99', payload: {} })).toMatch(/hors du compte/);
  });

  it('SEC-05-03 — accountId du contexte différent du compte du travail : refus', () => {
    expect(structuralJobRefusal({ accountId: 10, targetType: 'business_operations', targetId: '10', payload: { accountId: 11 } })).toMatch(/compte 11/);
    expect(structuralJobRefusal({ accountId: 10, targetType: null, targetId: null, payload: { events: [{ accountId: 12 }] } })).toMatch(/compte 12/);
    expect(structuralJobRefusal({ accountId: 10, targetType: null, targetId: null, payload: { accountId: 10 } })).toBeNull();
  });

  it('SEC-05-04 — cible inconnue d’un travail de compte (contrat T3 futur) : non bloquante, mais son contexte reste contrôlé', async () => {
    expect(structuralJobRefusal({ accountId: 10, targetType: 'banane', targetId: '4', payload: null })).toBeNull();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const err = await assertJobScope(job({ targetType: 'banane', targetId: '4', payload: { events: [{ fileId: 5 }] } }), exec({ 'file:5': 20 })).catch((x) => x);
    expect(isPermanentJobError(err)).toBe(true);
  });

  it('SEC-05-05 — travaux techniques sans compte : balayages admis sans référence métier, refusés sinon', () => {
    for (const t of ['t3_sweep', 'document_sweep', 'document_title_sweep', 'business_operations_sweep']) {
      expect(structuralJobRefusal({ accountId: null, targetType: t, targetId: 'c:0', payload: { cycleId: 'c', page: 0, afterFileId: 0, afterAccountId: 0 } }), t).toBeNull();
    }
    expect(structuralJobRefusal({ accountId: null, targetType: null, targetId: null, payload: { scheduled: true, triggerCode: 'x' } })).toBeNull();
    expect(structuralJobRefusal({ accountId: null, targetType: 'asset', targetId: '1', payload: null })).toMatch(/sans compte/);
    expect(structuralJobRefusal({ accountId: null, targetType: 't3_sweep', targetId: 'c:0', payload: { events: [{ fileId: 4 }] } })).toMatch(/sans compte/);
    expect(structuralJobRefusal({ accountId: null, targetType: 'inconnu', targetId: '1', payload: null })).toMatch(/non autorisée/);
  });

  it('SEC-05-06 — contexte illisible (trop profond) : refus, jamais un contrôle partiel', () => {
    let p: Record<string, unknown> = { assetId: 1 };
    for (let i = 0; i < PAYLOAD_MAX_DEPTH + 3; i++) p = { x: p };
    expect(analyseJob({ accountId: 10, payload: p }).unreadable).toMatch(/trop profond/);
    expect(structuralJobRefusal({ accountId: 10, targetType: null, targetId: null, payload: p })).toMatch(/trop profond/);
  });
});

describe('SEC-05 — exécution et mise en file', () => {
  it('SEC-05-07 — exécution : référence étrangère IMBRIQUÉE → échec définitif', async () => {
    const e = exec({ 'file:5': 20, 'operation:11': 10 });
    const err = await assertJobScope(job({
      targetType: 'business_operations', targetId: '10', payload: { events: [{ fileId: 5 }, { operationIds: [11] }] },
    }), e).catch((x) => x);
    expect(isPermanentJobError(err)).toBe(true);
    expect(String(err.message)).toContain('file 5');
  });

  it('SEC-05-08 — exécution : Opération étrangère dans la projection agenda → échec définitif', async () => {
    const err = await assertJobScope(job({
      targetType: 'business_operations_agenda', targetId: '10', payload: { events: [{ operationIds: [11, 12] }] },
    }), exec({ 'operation:11': 10, 'operation:12': 20 })).catch((x) => x);
    expect(isPermanentJobError(err)).toBe(true);
    expect(String(err.message)).toContain('operation 12');
  });

  it('SEC-05-09 — exécution : tout du compte → l’exécutant tourne (non-régression)', async () => {
    await expect(assertJobScope(job({
      targetType: 'business_operations', targetId: '10', payload: { accountId: 10, events: [{ fileId: 5 }, { assetId: 7 }] },
    }), exec({ 'file:5': 10, 'asset:7': 10 }))).resolves.toBeUndefined();
  });

  it('SEC-05-10 — contrôle indisponible : mise en file REFUSÉE (fail closed) et journalisée sans donnée métier', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    __setJobScopeCheckForTests(async () => { throw new Error('connexion refusée'); });
    expect(await enqueueScopeAllowed({ treatment: 'T1', scope: { accountId: 10, targetType: 'asset_file', targetId: 3 }, payload: { fileId: 3 } })).toBe(false);
    const ligne = String(err.mock.calls[0]?.[0] ?? '');
    expect(ligne).toContain('security.job_scope_unavailable');
    expect(ligne).not.toMatch(/retainedTitle|contenu/);
  });

  it('SEC-05-11 — contrôle indisponible à l’exécution : l’erreur remonte (exécutant non lancé)', async () => {
    const panne = { execute: async () => { throw new Error('base injoignable'); } };
    await expect(assertJobScope(job({ targetType: 'asset', targetId: '3' }), panne)).rejects.toThrow('base injoignable');
  });

  it('SEC-05-12 — job rejoué / relancé : même contrôle à chaque exécution (refus structurel sans base)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const panne = { execute: async () => { throw new Error('jamais appelée'); } };
    const err = await assertJobScope(job({ targetType: 'business_operations', targetId: '99', payload: {} }), panne).catch((x) => x);
    expect(isPermanentJobError(err)).toBe(true);
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('security.job_scope_refused');
  });
});
