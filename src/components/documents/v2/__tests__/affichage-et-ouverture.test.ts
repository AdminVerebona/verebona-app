/**
 * Page « Mes documents » — ouverture d'un document et choix d'affichage.
 *
 * Lecture des sources, comme les autres tests d'interface du dossier : ce qui
 * est figé ici, c'est la destination du clic et la présence des deux modes
 * d'affichage.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const VUE = read('src/components/documents/v2/DocumentsByRubric.tsx');

describe('le clic sur un document ouvre le document', () => {
  it('ouvre le tiroir document, celui des autres écrans', () => {
    expect(VUE).toMatch(/import \{ DocumentDrawer, type DocumentDrawerItem \}/);
    expect(VUE).toMatch(/<DocumentDrawer/);
    expect(VUE).toMatch(/const openDocument = \(doc: DocumentView\) => \{[\s\S]*?setDocumentDrawerOpen\(true\)/);
  });

  it('plus de bouton « Classer » ni de tiroir de classement par le bas', () => {
    expect(VUE).not.toMatch(/onClassify/);
    expect(VUE).not.toMatch(/RubricClassificationDrawer/);
    expect(() => read('src/components/documents/v2/RubricClassificationDrawer.tsx')).toThrow();
  });

  it('Rubrique et Type se modifient dans le tiroir document (à droite)', () => {
    const tiroir = read('src/components/assets/DocumentDrawer.tsx');
    expect(tiroir).toMatch(/<RubricTypeFields value=\{editClassement\}/);
    expect(tiroir).toMatch(/apiClient\.patch\(`\/api\/v2\/documents\/\$\{fullData\.publicId\}\/classification`/);
    // Le classement est lu sur la rubrique réelle du document.
    expect(tiroir).toMatch(/rubricCode: f\.rubricCode \?\? f\.rubric_code/);
    expect(read('src/services/documents/rubric-query.service.ts')).toMatch(/rubricCode: row\.rubricCode/);
  });

  it('les règles du référentiel sont conservées (§5.1, §2.2)', () => {
    const champs = read('src/components/documents/v2/RubricTypeFields.tsx');
    // Rubrique changée : Type incompatible vidé.
    expect(champs).toMatch(/typeCompatible \? typeCode : null/);
    // Type choisi : Rubrique déduite.
    expect(champs).toMatch(/rubricOfType\(next\) \?\? rubricCode/);
  });

  it('transmet ce que l’en-tête du tiroir attend', () => {
    // Sans nom de fichier ni bien, le tiroir s'ouvrait sur un en-tête vide.
    const service = read('src/services/documents/rubric-query.service.ts');
    expect(service).toMatch(/originalFilename: row\.filename/);
    expect(service).toMatch(/assetId: row\.assetId/);
  });
});

describe('choix d’affichage', () => {
  it('propose la vue vignettes et la vue liste', () => {
    expect(VUE).toMatch(/aria-label="Vue vignettes"/);
    expect(VUE).toMatch(/aria-label="Vue liste"/);
    expect(VUE).toMatch(/grid-cols-2 gap-2 sm:grid-cols-3/);
  });

  it('mémorise le choix d’une visite à l’autre', () => {
    // Clé propre à chaque écran (« Mes documents » / onglet d'un bien).
    expect(VUE).toMatch(/const viewModeKey = assetId \? ASSET_VIEW_MODE_KEY : VIEW_MODE_KEY/);
    expect(VUE).toMatch(/localStorage\.setItem\(viewModeKey, mode\)/);
    expect(VUE).toMatch(/localStorage\.getItem\(viewModeKey\)/);
  });

  it('propose le choix dans les deux contextes de la vue', () => {
    // « Mes documents » et l'onglet Documents d'un bien partagent ce composant.
    expect(VUE.match(/aria-label="Vue liste"/g)).toHaveLength(2);
  });

  it('n’ajoute aucune recherche locale (UX-01)', () => {
    expect(VUE).not.toMatch(/type="search"/);
  });
});

describe('offres : libellé des boutons', () => {
  const OFFRES = read('src/app/(dashboard)/mon-compte/offres/page.tsx');

  it('propose « Passer à Premium », pas « Programmer Premium »', () => {
    expect(OFFRES).toMatch(/`Passer à \$\{theme\.label\}`/);
    const sansCommentaires = OFFRES.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(sansCommentaires).not.toMatch(/Programmer \$\{/);
  });

  it('indique la prise d’effet sous le bouton', () => {
    expect(OFFRES).toMatch(/Prise d\\?'effet à votre prochaine échéance/);
    expect(OFFRES).toMatch(/\{btn\.hint\}/);
  });
});

describe('vignettes avec aperçu du document', () => {
  it('le fond de la vignette est un aperçu réel (image ou 1re page PDF)', () => {
    expect(VUE).toMatch(/src=\{`\/api\/files\/\$\{document\.id\}\/proxy`\}/);
    expect(VUE).toMatch(/<PdfThumbnail\s+fileId=\{String\(document\.id\)\}/);
  });

  it('le texte est posé sur l’aperçu, avec un dégradé de lisibilité', () => {
    expect(VUE).toMatch(/bg-gradient-to-t from-black\/85/);
    expect(VUE).toMatch(/absolute inset-x-0 bottom-0/);
  });

  it('l’aperçu PDF est rendu à la demande et mémorisé', () => {
    const pdf = read('src/components/ui/pdf-thumbnail.tsx');
    expect(pdf).toContain('IntersectionObserver');
    expect(pdf).toMatch(/rendus\.set\(fileId, dataUrl\)/);
  });
});
