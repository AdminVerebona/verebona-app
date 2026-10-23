/**
 * Informations complémentaires — persistance des listes structurées :
 * fusion côté base (une liste remplacée en bloc), contrôle optimiste de
 * version (409), relecture défensive, et collecte des références citées
 * (photos, pièces, événement lié) avant leur vérification d'appartenance.
 *
 * La base est simulée : on vérifie l'ordre SQL généré (`||`, `-`, `WHERE
 * version = n`). Le comportement réel a été vérifié sur PostgreSQL 16
 * (migration 0214 appliquée deux fois, conflit sur version périmée).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

let returned: unknown[] = [];
const captured: { values?: Record<string, unknown>; conflict?: { set: Record<string, unknown>; setWhere?: SQL } } = {};

vi.mock('@/db', () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured.values = v;
        return {
          onConflictDoUpdate: (cfg: { set: Record<string, unknown>; setWhere?: SQL }) => {
            captured.conflict = cfg;
            return { returning: async () => returned };
          },
        };
      },
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => returned }) }) }),
  },
}));

const { updateAssetAdditionalInfos, getAssetAdditionalInfos, mergeExpression, AdditionalInfosConflictError } = await import('../additional-infos.service');
const { collectReferences } = await import('../additional-infos-references.service');
const { validateAdditionalInfosPatch } = await import('@/lib/assets/additional-infos');

const dialect = new PgDialect();
const toSql = (s: SQL) => dialect.sqlToQuery(s);

const row = (over: Record<string, unknown> = {}) => ({
  assetId: 5, accountId: 10, commercial: {}, rental: {}, insurance: {}, finance: {}, schemaVersion: 2, version: 3,
  createdAt: new Date('2026-09-28T08:00:00Z'), updatedAt: new Date('2026-09-28T08:00:00Z'), updatedBy: 1, ...over,
});

function patchOf(body: unknown) {
  const r = validateAdditionalInfosPatch(body, 'IMMOBILIER');
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r;
}

beforeEach(() => {
  returned = [row()];
  delete captured.values;
  delete captured.conflict;
});

describe('fusion côté base', () => {
  it('liste : posée par `||` (remplacement en bloc), liste vidée retirée par `-`', () => {
    const r = patchOf({ version: 1, insurance: { insuredItems: [{ id: 'a', label: 'SDB' }], protectionItems: [] } });
    const q = toSql(mergeExpression('insurance', r.patch)!);
    expect(q.sql).toMatch(/coalesce\("asset_additional_infos"\."insurance_json", '\{\}'::jsonb\) \|\| \$1::jsonb\) - ARRAY\[\$2\]::text\[\]/);
    expect(JSON.parse(q.params[0] as string)).toEqual({ insuredItems: [{ id: 'a', label: 'SDB' }] });
    expect(q.params[1]).toBe('protectionItems');
  });

  it('sous-rubrique « Valeur et charges » : colonne finance_json', () => {
    const r = patchOf({ finance: { retainedValueCents: 100 } });
    expect(toSql(mergeExpression('finance', r.patch)!).sql).toContain('"finance_json"');
  });
});

describe('contrôle optimiste', () => {
  it('liste : écriture conditionnée à la version attendue, schéma v2 posé', async () => {
    const r = patchOf({ version: 3, insurance: { insuredItems: [{ id: 'a', label: 'SDB' }] } });
    await updateAssetAdditionalInfos(5, 10, 1, r.patch, { expectedVersion: 3 });
    const where = toSql(captured.conflict!.setWhere!);
    expect(where.sql).toBe('"asset_additional_infos"."version" = $1');
    expect(where.params).toEqual([3]);
    expect(captured.conflict!.set.schemaVersion).toBe(2);
    expect(captured.values).toMatchObject({ schemaVersion: 2, finance: {}, insurance: { insuredItems: [{ id: 'a', label: 'SDB' }] } });
    // Lot 83D (V-Q2) : `claim_json` n'est plus jamais écrit.
    expect(captured.values).not.toHaveProperty('claim');
  });

  it('champs simples : aucune condition de version (dernier écrit gagne par champ)', async () => {
    await updateAssetAdditionalInfos(5, 10, 1, patchOf({ insurance: { insuranceObjective: 'SOUSCRIRE' } }).patch);
    expect(captured.conflict!.setWhere).toBeUndefined();
  });

  it('version périmée : aucune ligne rendue ⇒ AdditionalInfosConflictError', async () => {
    returned = [];
    const r = patchOf({ version: 2, insurance: { insuredItems: [{ id: 'a', label: 'SDB' }] } });
    await expect(updateAssetAdditionalInfos(5, 10, 1, r.patch, { expectedVersion: 2 })).rejects.toBeInstanceOf(AdditionalInfosConflictError);
  });
});

describe('relecture', () => {
  it('listes assainies, sous-rubrique finance rendue, `{}` si aucune ligne', async () => {
    returned = [row({ insurance: { insuredItems: [{ id: 'a', label: 'SDB' }, { id: 'b' }], insuranceObjective: 'SOUSCRIRE' }, claim: { claimType: 'VOL' }, finance: { retainedValueCents: 'x', charges: [{ id: 'c', kind: 'ENERGIE', amountCents: 9000 }] } })];
    const r = await getAssetAdditionalInfos(5, 10);
    expect(r.insurance).toEqual({ insuredItems: [{ id: 'a', label: 'SDB' }], insuranceObjective: 'SOUSCRIRE' });
    // Lot 83D (V-Q2) : l'ancien formulaire Sinistre (`claim_json`) n'est plus lu.
    expect(r).not.toHaveProperty('claim');
    expect(r.finance).toEqual({ charges: [{ id: 'c', kind: 'ENERGIE', amountCents: 9000 }] });
    returned = [];
    expect((await getAssetAdditionalInfos(5, 10)).finance).toEqual({});
  });
});

describe('références citées (vérifiées ensuite par compte et par bien)', () => {
  it('pièces citées, avec le chemin de chaque citation (lot 83D : plus d’événement sinistre lié)', () => {
    const r = patchOf({
      version: 1,
      insurance: { insuredItems: [{ id: 'i', label: 'Housse', documentId: 23 }, { id: 'j', label: 'Leash', documentId: 23 }] },
    });
    const refs = collectReferences(r.patch);
    expect(Object.fromEntries(refs.photos)).toEqual({});
    expect(Object.fromEntries(refs.documents)).toEqual({ 23: ['insurance.insuredItems[0].documentId', 'insurance.insuredItems[1].documentId'] });
    expect('events' in refs).toBe(false);
  });

  it('valeurs retirées : rien à vérifier', () => {
    const refs = collectReferences(patchOf({ version: 1, insurance: { insuredItems: null } }).patch);
    expect(refs.photos.size + refs.documents.size).toBe(0);
  });
});
