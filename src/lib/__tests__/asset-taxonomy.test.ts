/**
 * Familles et catégories de biens — liste exacte du besoin, et continuité
 * des biens existants (anciens libellés).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSET_FAMILIES,
  assetCategoryLabel,
  categoryOptionsWithCurrent,
  getAssetCategories,
  normalizeAssetCategory,
} from '../asset-taxonomy';
import { getAssetIcon } from '../asset-icons';

const labels = (code: string) => getAssetCategories(code).map((c) => c.label);

describe('familles de bien', () => {
  it('Véhicule, Immobilier, Objet — dans cet ordre', () => {
    expect(ASSET_FAMILIES.map((f) => f.label)).toEqual(['Véhicule', 'Immobilier', 'Objet']);
    expect(ASSET_FAMILIES.map((f) => f.code)).toEqual(['VEHICULE', 'IMMOBILIER', 'OBJECT']);
  });
});

describe('catégories de bien', () => {
  it('Immobilier', () => {
    expect(labels('IMMOBILIER')).toEqual([
      'Maison', 'Appartement', 'Immeuble', 'Terrain', 'Garage/box', 'Mobil-home', 'Local professionnel/commercial',
    ]);
  });
  it('Véhicule', () => {
    expect(labels('VEHICULE')).toEqual(['Voiture', 'Moto', 'Vélo', 'Camping-car', 'Bateau', 'Camion']);
  });
  it('Objet', () => {
    expect(labels('OBJECT')).toEqual(['Tech / IT / Électronique', 'Loisir / Sport', 'Maison & équipement']);
    expect(getAssetCategories('OBJECT').map((c) => c.value)).toEqual([
      'OBJECT_CATEGORY_TECH', 'OBJECT_CATEGORY_SPORT', 'OBJECT_CATEGORY_HOME',
    ]);
  });
});

describe('biens existants', () => {
  it('anciens libellés reconnus', () => {
    expect(normalizeAssetCategory('Garage')).toBe('Garage/box');
    expect(normalizeAssetCategory(' local commercial ')).toBe('Local professionnel/commercial');
    expect(normalizeAssetCategory('Maison')).toBe('Maison');
  });
  it('une catégorie hors liste reste proposée, jamais effacée', () => {
    const options = categoryOptionsWithCurrent('IMMOBILIER', 'Studio').map((o) => o.value);
    expect(options).toContain('Studio');
    expect(categoryOptionsWithCurrent('IMMOBILIER', 'Garage').map((o) => o.value)).not.toContain('Garage');
  });
  it('libellé de catégorie d’un objet', () => {
    expect(assetCategoryLabel({ category: 'OBJECT', objectCategory: 'OBJECT_CATEGORY_SPORT' })).toBe('Loisir / Sport');
  });
  it('chaque catégorie Immobilier / Véhicule a son icône', () => {
    for (const family of ['IMMOBILIER', 'VEHICULE']) {
      const generic = getAssetIcon(family, null, '');
      for (const c of getAssetCategories(family)) {
        if (c.value === 'Voiture') continue; // l'icône générique Véhicule EST la voiture
        expect(getAssetIcon(family, c.value, ''), `${family} ${c.value}`).not.toBe(generic);
      }
    }
  });
});

describe('formulaire', () => {
  it('libellés « Famille de bien » et « Catégorie de bien », liste issue de la taxonomie', () => {
    const form = readFileSync(join(process.cwd(), 'src/components/AssetFormDialog.tsx'), 'utf8');
    expect(form).toContain('Famille de bien');
    expect(form).toContain('Catégorie de bien');
    expect(form).toContain('ASSET_FAMILIES.map');
    expect(form).not.toMatch(/const (IMMOBILIER|VEHICULE)_SUBTYPES/);
  });
});
