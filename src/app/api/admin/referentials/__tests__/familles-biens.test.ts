/**
 * BO Référentiels — familles et sous-catégories de biens.
 *
 * Preprod, 2 oct. 2026 : onglets vides. Ils lisaient `asset_types` /
 * `asset_type_subcategories`, alimentées par un seed manuel jamais joué,
 * alors que l'application classe les biens via `lib/asset-taxonomy.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn() } }));
const { buildAssetTaxonomyReferentials } = await import('../referentials-data');

describe('buildAssetTaxonomyReferentials', () => {
  it('base vide : toutes les familles et catégories du classement, à 0', () => {
    const { assetFamilies, assetSubcategories } = buildAssetTaxonomyReferentials([], []);
    expect(assetFamilies.map((f) => f.label)).toEqual(['Véhicule', 'Immobilier', 'Objet']);
    expect(assetFamilies.every((f) => f.active && f.usage === 0)).toBe(true);
    expect(assetSubcategories.length).toBeGreaterThanOrEqual(13);
    expect(assetSubcategories.find((c) => c.code === 'Maison')).toMatchObject({ details: 'Immobilier', usage: 0, active: true });
  });

  it('compte les biens ; anciens libellés ramenés aux actuels', () => {
    const { assetFamilies, assetSubcategories } = buildAssetTaxonomyReferentials(
      [{ family: 'IMMOBILIER', n: 3 }, { family: 'VEHICULE', n: 2 }],
      [
        { family: 'IMMOBILIER', value: 'Maison', n: 1 },
        { family: 'IMMOBILIER', value: 'Garage', n: 1 },
        { family: 'IMMOBILIER', value: 'Garage/box', n: 1 },
        { family: 'VEHICULE', value: 'Vélo', n: 2 },
      ],
    );
    expect(assetFamilies.find((f) => f.code === 'IMMOBILIER')?.usage).toBe(3);
    expect(assetSubcategories.find((c) => c.code === 'Garage/box')?.usage).toBe(2);
    expect(assetSubcategories.find((c) => c.code === 'Vélo')?.usage).toBe(2);
  });

  it('valeurs hors classement : visibles, « Inactif » ; PO-Q14 : MATERIEL_PRO compté sous « Objet », sans ligne propre', () => {
    const { assetFamilies, assetSubcategories } = buildAssetTaxonomyReferentials(
      [{ family: 'MATERIEL_PRO', n: 1 }, { family: 'OBJECT', n: 2 }, { family: 'FAMILLE_X', n: 1 }],
      [{ family: 'IMMOBILIER', value: 'Studio', n: 1 }, { family: 'VEHICULE', value: null, n: 4 }],
    );
    expect(assetFamilies.find((f) => f.code === 'MATERIEL_PRO')).toBeUndefined();
    expect(assetFamilies.some((f) => /Matériel/i.test(f.label))).toBe(false);
    expect(assetFamilies.find((f) => f.code === 'OBJECT')?.usage).toBe(3);
    expect(assetFamilies.find((f) => f.code === 'FAMILLE_X')).toMatchObject({ active: false, usage: 1, details: 'Famille ancienne, plus proposée' });
    expect(assetSubcategories.find((c) => c.code === 'Studio')).toMatchObject({ active: false, details: 'Immobilier — hors classement' });
    expect(assetSubcategories.find((c) => c.label === 'Catégorie non renseignée')).toMatchObject({ usage: 4, details: 'Véhicule' });
  });
});
