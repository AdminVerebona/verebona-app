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
    expect(VUE).toMatch(/if \(assetId\) params\.set\('assets', String\(assetId\)\)/);
    expect(VUE).toMatch(/params\.set\('pageSize', 'all'\)/);
    expect(VUE).toMatch(/\/api\/v2\/documents\?\$\{query\}/);
  });

  it('ajout rattaché au bien, gardé en lecture seule', () => {
    expect(VUE).toMatch(/preselectedAssetId=\{assetId\}/);
    expect(VUE).toMatch(/allowAssetSelection=\{false\}/);
    expect(VUE).toMatch(/garder\(\(\) => setUploadOpen\(true\), 'documents'\)/);
    expect(VUE).not.toMatch(/onClick=\{\(\) => setUploadOpen\(true\)\}/);
  });

  it('préférences propres à l’onglet, ancien choix liste / vignettes repris', () => {
    const prefs = read('src/components/documents/v2/view-prefs.ts');
    expect(prefs).toMatch(/'fiche-bien': 'assetDocumentsViewMode'/);
    expect(VUE).toMatch(/const context: DocumentsContext = assetId \? 'fiche-bien' : 'mes-documents'/);
  });

  it('ni titre de page, ni filtre Bien, ni bien dans le sous-titre', () => {
    expect(VUE).toMatch(/\{!assetId && \(\s*<div className="mb-\[18px\]/);
    expect(read('src/components/documents/v2/documents-view.ts'))
      .toMatch(/context === 'mes-documents' \? bienLabel\(d\) : null/);
  });

  it('un document ajouté ailleurs rafraîchit la liste', () => {
    expect(VUE).toMatch(/addEventListener\('document-added'/);
  });
});
