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
  assetId: 5, accountId: 10, commercial: {}, rental: {}, insurance: {}, claim: {}, finance: {}, schemaVersion: 2, version: 3,
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
    const r = patchOf({ version: 1, claim: { damages: [{ id: 'a', zone: 'SDB' }], actions: [] } });
    const q = toSql(mergeExpression('claim', r.patch)!);
    expect(q.sql).toMatch(/coalesce\("asset_additional_infos"\."claim_json", '\{\}'::jsonb\) \|\| \$1::jsonb\) - ARRAY\[\$2\]::text\[\]/);
    expect(JSON.parse(q.params[0] as string)).toEqual({ damages: [{ id: 'a', zone: 'SDB' }] });
    expect(q.params[1]).toBe('actions');
  });

  it('sous-rubrique « Valeur et charges » : colonne finance_json', () => {
    const r = patchOf({ finance: { retainedValueCents: 100 } });
    expect(toSql(mergeExpression('finance', r.patch)!).sql).toContain('"finance_json"');
  });
});

describe('contrôle optimiste', () => {
  it('liste : écriture conditionnée à la version attendue, schéma v2 posé', async () => {
    const r = patchOf({ version: 3, claim: { damages: [{ id: 'a', zone: 'SDB' }] } });
    await updateAssetAdditionalInfos(5, 10, 1, r.patch, { expectedVersion: 3 });
    const where = toSql(captured.conflict!.setWhere!);
    expect(where.sql).toBe('"asset_additional_infos"."version" = $1');
    expect(where.params).toEqual([3]);
    expect(captured.conflict!.set.schemaVersion).toBe(2);
    expect(captured.values).toMatchObject({ schemaVersion: 2, finance: {}, claim: { damages: [{ id: 'a', zone: 'SDB' }] } });
  });

  it('champs simples : aucune condition de version (dernier écrit gagne par champ)', async () => {
    await updateAssetAdditionalInfos(5, 10, 1, patchOf({ claim: { claimType: 'VOL' } }).patch);
    expect(captured.conflict!.setWhere).toBeUndefined();
  });

  it('version périmée : aucune ligne rendue ⇒ AdditionalInfosConflictError', async () => {
    returned = [];
    const r = patchOf({ version: 2, claim: { damages: [{ id: 'a', zone: 'SDB' }] } });
    await expect(updateAssetAdditionalInfos(5, 10, 1, r.patch, { expectedVersion: 2 })).rejects.toBeInstanceOf(AdditionalInfosConflictError);
  });
});

describe('relecture', () => {
  it('listes assainies, sous-rubrique finance rendue, `{}` si aucune ligne', async () => {
    returned = [row({ claim: { damages: [{ id: 'a', zone: 'SDB' }, { id: 'b' }], claimType: 'VOL' }, finance: { retainedValueCents: 'x', charges: [{ id: 'c', kind: 'ENERGIE', amountCents: 9000 }] } })];
    const r = await getAssetAdditionalInfos(5, 10);
    expect(r.claim).toEqual({ damages: [{ id: 'a', zone: 'SDB' }], claimType: 'VOL' });
    expect(r.finance).toEqual({ charges: [{ id: 'c', kind: 'ENERGIE', amountCents: 9000 }] });
    returned = [];
    expect((await getAssetAdditionalInfos(5, 10)).finance).toEqual({});
  });
});

describe('références citées (vérifiées ensuite par compte et par bien)', () => {
  it('photos, pièces (multiples et uniques) et événement lié, avec le chemin de chaque citation', () => {
    const r = patchOf({
      version: 1,
      claim: {
        claimEventKey: 'agenda:34',
        damages: [{ id: 'a', zone: 'SDB', photoIds: [11, 12], documentIds: [21] }, { id: 'b', zone: 'Chambre', photoIds: [12] }],
        actions: [{ id: 'x', title: 'Séchage', invoiceDocumentId: 22 }],
        exchanges: [{ id: 'e', date: '2026-08-04', summary: 'AR', documentId: 21 }],
      },
      insurance: { insuredItems: [{ id: 'i', label: 'Housse', documentId: 23 }] },
    });
    const refs = collectReferences(r.patch);
    expect(Object.fromEntries(refs.photos)).toEqual({ 11: ['claim.damages[0].photoIds'], 12: ['claim.damages[0].photoIds', 'claim.damages[1].photoIds'] });
    expect(Object.fromEntries(refs.documents)).toEqual({
      21: ['claim.damages[0].documentIds', 'claim.exchanges[0].documentId'],
      22: ['claim.actions[0].invoiceDocumentId'],
      23: ['insurance.insuredItems[0].documentId'],
    });
    expect(Object.fromEntries(refs.events)).toEqual({ 'agenda:34': ['claim.claimEventKey'] });
  });

  it('valeurs retirées : rien à vérifier', () => {
    const refs = collectReferences(patchOf({ version: 1, claim: { damages: null, claimEventKey: null } }).patch);
    expect(refs.photos.size + refs.documents.size + refs.events.size).toBe(0);
  });
});
