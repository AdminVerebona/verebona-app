/**
 * Lot 32C — PO 9 : « Un document qui concerne plusieurs biens doit apparaître
 * dans les 2 listes ». Compteurs et filtres (sans base) ; la requête réelle
 * est couverte par `l32c-rattrapage-rattachement.e2e.ts` (PO9-xx).
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildFeedMeta, matchesFilters } from '@/services/documents/rubric-query.service';
import { documentInAssetsCondition, documentWithoutAssetCondition } from '@/services/documents/asset-document-scope';
import { FEED_NO_ASSET } from '@/lib/documents/document-feed';
import { metaWithout } from '@/components/documents/v2/documents-feed';

const context = { families: ['IMMOBILIER' as const], hasRentedAsset: false };
const sansFiltre = { biens: [], rubrics: [], types: [] };

describe('PO9 — compteurs : un document compte sous CHACUN de ses biens', () => {
  const rows = [
    // Facture commune A (principal) + B (lié).
    { assetId: 1, assetName: 'Maison A', otherAssets: [{ id: 2, name: 'Maison B' }], rubricCode: null, documentTypeCode: null, count: 1 },
    // Document propre à A.
    { assetId: 1, assetName: 'Maison A', rubricCode: null, documentTypeCode: null, count: 2 },
    // Document multi-biens SANS principal (liens SECONDARY seulement).
    { assetId: null, assetName: null, otherAssets: [{ id: 2, name: 'Maison B' }, { id: 3, name: 'Studio' }], rubricCode: null, documentTypeCode: null, count: 1 },
    // Vraiment sans bien.
    { assetId: null, assetName: null, rubricCode: null, documentTypeCode: null, count: 4 },
  ];

  it('facettes par bien : A = 3, B = 2, Studio = 1, Sans bien = 4 ; total du périmètre inchangé (pas de doublon)', () => {
    const meta = buildFeedMeta(rows, sansFiltre, context);
    const f = Object.fromEntries(meta.facets.biens.map((b) => [b.value, [b.label, b.count]]));
    expect(f).toEqual({ 1: ['Maison A', 3], 2: ['Maison B', 2], 3: ['Studio', 1], [FEED_NO_ASSET]: [null, 4] });
    expect(meta.scopeTotal).toBe(8);
    expect(meta.total).toBe(8);
  });

  it('filtre « Maison B » : le document commun et le document multi-biens (2), une seule fois chacun', () => {
    expect(buildFeedMeta(rows, { ...sansFiltre, biens: ['2'] }, context).total).toBe(2);
    expect(buildFeedMeta(rows, { ...sansFiltre, biens: ['1', '2'] }, context).total).toBe(4);
    expect(buildFeedMeta(rows, { ...sansFiltre, biens: [FEED_NO_ASSET] }, context).total).toBe(4);
    expect(matchesFilters(rows[2], { ...sansFiltre, biens: [FEED_NO_ASSET] })).toBe(false);
  });

  it('suppression d’un document affiché : décompté de chacun de ses biens', () => {
    const meta = buildFeedMeta(rows, sansFiltre, context);
    const apres = metaWithout(meta, {
      id: 9, publicId: 'x', title: 't', originalFilename: null, assetId: 1, assetIds: [1, 2], rubricCode: null,
      documentTypeCode: null, documentTypeLabel: null, documentDate: null, mimeType: null, assetNames: ['Maison A', 'Maison B'],
    });
    const f = Object.fromEntries(apres.facets.biens.map((b) => [b.value, b.count]));
    expect(f).toMatchObject({ 1: 2, 2: 1, 3: 1 });
  });
});

describe('PO9 — périmètre SQL : colonnes OU liens PRIMARY / SECONDARY, jamais MENTIONED', () => {
  const dialect = new PgDialect();
  it('condition d’appartenance (sous-requête, aucune jointure : aucun doublon)', () => {
    const q = dialect.sqlToQuery(documentInAssetsCondition([7, 7, 8]));
    expect(q.sql).toContain('"asset_files"."asset_id" IN ($1, $2)');
    expect(q.sql).toContain('"asset_files"."linked_asset_id" IN ($3, $4)');
    expect(q.sql).toContain("dal.status = 'ACTIVE'");
    expect(q.sql).toContain("dal.link_role IN ('PRIMARY', 'SECONDARY')");
    expect(q.sql).not.toContain('MENTIONED');
    expect(q.sql).not.toMatch(/JOIN/i);
    expect(q.params).toEqual([7, 8, 7, 8, 7, 8]);
    expect(dialect.sqlToQuery(documentInAssetsCondition([])).sql).toBe('FALSE');
  });
  it('« Sans bien » : ni colonne, ni lien PRIMARY / SECONDARY', () => {
    const q = dialect.sqlToQuery(documentWithoutAssetCondition()).sql;
    expect(q).toContain('"asset_files"."asset_id" IS NULL AND "asset_files"."linked_asset_id" IS NULL');
    expect(q).toContain('NOT EXISTS');
  });
});
