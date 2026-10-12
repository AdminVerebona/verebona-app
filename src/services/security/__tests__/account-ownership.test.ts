/**
 * Lot 49 — SEC-P0 « contrôles transversaux » : fonctions communes de
 * vérification d'appartenance (AC04). Sans base : l'exécutant est simulé et
 * rend, pour chaque type demandé, le compte propriétaire connu.
 * Le comportement réel (PostgreSQL) est couvert par
 * `src/test/e2e/scenarios/l49-sec-p0-intercomptes.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  assertRefsInAccount, assertTargetInAccount, cleanIds, CrossAccountReferenceError, findForeignRefs,
  findRejectedRefs, isCrossAccountReferenceError, knownAssetOfAccount, ownedSql, refsInAccount,
  TargetCoherenceError, type SqlExecutor,
} from '../account-ownership';

const dialect = new PgDialect();

/** Base simulée : `kind:id` → compte ; `parents` : pièce / équipement → bien. */
function fakeDb(owners: Record<string, number>, parents: Record<string, number> = {}) {
  const requetes: string[] = [];
  const exec: SqlExecutor = {
    execute: async (q: SQL) => {
      const { sql, params } = dialect.sqlToQuery(q);
      requetes.push(sql);
      if (sql.includes('asset_id FROM substructures')) {
        const [sub, eq] = params as Array<number | null>;
        return [
          ...(sub ? [{ kind: 'substructure', asset_id: parents[`substructure:${sub}`] }] : []),
          ...(eq ? [{ kind: 'equipment', asset_id: parents[`equipment:${eq}`] }] : []),
        ].filter((r) => r.asset_id !== undefined);
      }
      // Lecture « identifiant → compte » : un tableau d'entiers par type.
      const kinds = [...sql.matchAll(/SELECT '([a-z_]+)' AS kind/g)].map((m) => m[1]);
      const rows: Array<{ kind: string; id: number; account_id: number }> = [];
      kinds.forEach((kind, i) => {
        const ids = String(params[i]).replace(/[{}]/g, '').split(',').map(Number);
        for (const id of ids) {
          const acc = owners[`${kind}:${id}`];
          if (acc !== undefined) rows.push({ kind, id, account_id: acc });
        }
      });
      return rows;
    },
  };
  return { exec, requetes };
}

describe('lot 49 — AC04 : fonctions communes de vérification d’appartenance', () => {
  it('AC04 — cleanIds : entiers positifs dédoublonnés, rien d’autre', () => {
    expect(cleanIds([3, 3, '4' as unknown as number, null, undefined, -1, 0, 1.5, 2_147_483_648])).toEqual([3, 4]);
    expect(cleanIds(7)).toEqual([7]);
    expect(cleanIds(null)).toEqual([]);
  });

  it('AC04 — une seule requête par appel, quels que soient les types (UNION ALL)', async () => {
    const { exec, requetes } = fakeDb({ 'asset:1': 10, 'file:2': 10, 'equipment:3': 10, 'supplier:4': 10, 'event:5': 10 });
    expect(await refsInAccount(10, { asset: 1, file: [2], equipment: 3, supplier: 4, event: 5 }, exec)).toBe(true);
    expect(requetes).toHaveLength(1);
    expect(requetes[0]).toContain('UNION ALL');
  });

  it('AC04 — aucune référence : aucune requête', async () => {
    const { exec, requetes } = fakeDb({});
    expect(await findRejectedRefs(10, { asset: [], file: null }, exec)).toEqual([]);
    expect(requetes).toHaveLength(0);
  });

  it('AC01/AC02 — objet d’un autre compte : « foreign » ; introuvable : « missing » ; refus entier', async () => {
    const { exec } = fakeDb({ 'asset:1': 10, 'asset:2': 20, 'deadline:9': 20, 'agenda_item:8': 10 });
    const r = await findRejectedRefs(10, { asset: [1, 2, 3], deadline: 9, agenda_item: 8 }, exec);
    expect(r).toEqual(expect.arrayContaining([
      { kind: 'asset', id: 2, reason: 'foreign' },
      { kind: 'asset', id: 3, reason: 'missing' },
      { kind: 'deadline', id: 9, reason: 'foreign' },
    ]));
    expect(r).toHaveLength(3);
    expect(await findForeignRefs(10, { asset: [1, 2, 3] }, exec)).toEqual([{ kind: 'asset', id: 2, reason: 'foreign' }]);
    await expect(assertRefsInAccount(10, { asset: [1, 2] }, exec)).rejects.toBeInstanceOf(CrossAccountReferenceError);
  });

  it('AC01 — le refus ne révèle rien de l’autre compte (pas de numéro de compte étranger)', async () => {
    const { exec } = fakeDb({ 'file:2': 20 });
    const e = await assertRefsInAccount(10, { file: 2 }, exec).catch((x) => x);
    expect(isCrossAccountReferenceError(e)).toBe(true);
    expect(e.status).toBe(404);
    expect(e.message).not.toContain('20');
  });

  it('AC05 — knownAssetOfAccount : bien du compte gardé, bien étranger ignoré (null)', async () => {
    const { exec } = fakeDb({ 'asset:1': 10, 'asset:2': 20 });
    expect(await knownAssetOfAccount(10, 1, 'test', exec)).toBe(1);
    expect(await knownAssetOfAccount(10, 2, 'test', exec)).toBeNull();
    expect(await knownAssetOfAccount(10, null, 'test', exec)).toBeNull();
  });

  it('AC03 — assertTargetInAccount : pièce et équipement du bien indiqué, et du même bien', async () => {
    const owners = { 'asset:1': 10, 'asset:2': 10, 'substructure:5': 10, 'equipment:6': 10, 'equipment:7': 10 };
    const parents = { 'substructure:5': 1, 'equipment:6': 1, 'equipment:7': 2 };
    const { exec } = fakeDb(owners, parents);
    await expect(assertTargetInAccount(10, { assetId: 1, substructureId: 5, equipmentId: 6 }, exec)).resolves.toBeUndefined();
    await expect(assertTargetInAccount(10, { assetId: 1, equipmentId: 7 }, exec)).rejects.toBeInstanceOf(TargetCoherenceError);
    await expect(assertTargetInAccount(10, { substructureId: 5, equipmentId: 7 }, exec)).rejects.toBeInstanceOf(TargetCoherenceError);
    const { exec: e2 } = fakeDb({ ...owners, 'asset:3': 20 }, parents);
    await expect(assertTargetInAccount(10, { assetId: 3 }, e2)).rejects.toBeInstanceOf(CrossAccountReferenceError);
  });

  it('AC04 — ownedSql : condition de compte écrite DANS le SQL de l’écriture', () => {
    for (const kind of ['asset', 'file', 'substructure', 'equipment', 'supplier', 'event', 'deadline', 'agenda_item'] as const) {
      const { sql, params } = dialect.sqlToQuery(ownedSql(kind, 42, 7));
      expect(sql).toMatch(/^EXISTS \(SELECT 1 FROM /);
      expect(sql).toMatch(/account_id = \$2::int\)$/);
      expect(params).toEqual([42, 7]);
    }
    // Pièce et équipement : compte du BIEN porteur.
    expect(dialect.sqlToQuery(ownedSql('equipment', 1, 2)).sql).toContain('JOIN assets b ON b.id = o.asset_id');
  });
});
