/**
 * Onglet « Documents » d'un bien : même présentation que « Mes documents »
 * (Rubriques, Types, cartes, tiroir), restreinte au bien.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const ONGLET = read('src/components/assets/AssetDocumentsTab.tsx');
const VUE = read('src/components/documents/v2/DocumentsByRubric.tsx');

describe('onglet Documents d’un bien', () => {
  it('réutilise le composant de « Mes documents », restreint au bien', () => {
    expect(ONGLET).toMatch(/<DocumentsByRubric assetId=\{assetId\} assetName=\{assetName\} \/>/);
    expect(ONGLET).not.toMatch(/api\/files\?/);
    expect(existsSync(join(process.cwd(), 'src/components/asset-documents-panel.tsx'))).toBe(false);
  });

  it('même source de données : regroupement par Rubrique filtré sur le bien', () => {
    expect(VUE).toMatch(/const assets = assetId \? \[assetId\] : filters\.assetIds/);
    expect(VUE).toMatch(/\/api\/v2\/documents\?\$\{query\}/);
  });

  it('ajout rattaché au bien, gardé en lecture seule', () => {
    expect(VUE).toMatch(/preselectedAssetId=\{assetId\}/);
    expect(VUE).toMatch(/allowAssetSelection=\{false\}/);
    expect(VUE).toMatch(/garder\(\(\) => setUploadOpen\(true\), 'documents'\)/);
    expect(VUE).not.toMatch(/onClick=\{\(\) => setUploadOpen\(true\)\}/);
  });

  it('vignettes par défaut et choix mémorisé dans l’onglet', () => {
    expect(VUE).toMatch(/useState<ViewMode>\(assetId \? 'grid' : 'list'\)/);
    expect(VUE).toMatch(/ASSET_VIEW_MODE_KEY = 'assetDocumentsViewMode'/);
  });

  it('un document ajouté ailleurs rafraîchit la liste', () => {
    expect(VUE).toMatch(/addEventListener\('document-added'/);
  });
});
