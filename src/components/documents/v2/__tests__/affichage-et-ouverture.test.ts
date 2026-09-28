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
    expect(VUE).toMatch(/const openDocument = \(doc: DocumentItem\) => \{[\s\S]*?setDocumentDrawerOpen\(true\)/);
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

describe('choix d’affichage — maquette 1a « Flux continu »', () => {
  const BARRE = read('src/components/documents/v2/DocumentsToolbar.tsx');

  it('propose liste et vignettes, en contrôle segmenté annonçant son état', () => {
    expect(BARRE).toMatch(/\{ value: 'list', label: 'Liste' \}, \{ value: 'grid', label: 'Vignettes' \}/);
    expect(BARRE).toMatch(/aria-pressed=\{on\}/);
    expect(VUE).toMatch(/grid-cols-2 gap-4 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5/);
  });

  it('regroupement optionnel « Par rubrique », tri global et son sens', () => {
    expect(BARRE).toMatch(/<Switch checked=\{grouped\} onCheckedChange=\{onGroupedChange\} \/>\s*Par rubrique/);
    expect(BARRE).toMatch(/aria-label="Trier par"/);
    expect(BARRE).toMatch(/Ordre décroissant/);
    expect(VUE).toMatch(/sortDocuments\(filterDocuments\(scope, filters\), sort, prefs\.dir, rubrics\)/);
    expect(VUE).toMatch(/groupDocuments\(visibles, rubrics, prefs\.grouped\)/);
  });

  it('les rubriques sont des titres de section, plus des boîtes', () => {
    expect(VUE).toMatch(/<h2 className="m-0">/);
    expect(VUE).toMatch(/aria-expanded=\{ouvert\}/);
    expect(VUE).not.toMatch(/function RubricSection/);
    expect(VUE).not.toMatch(/<section className="rounded-lg border">/);
  });

  it('mémorise regroupement, affichage et tri par contexte, jamais les filtres', () => {
    expect(VUE).toMatch(/const context: DocumentsContext = assetId \? 'fiche-bien' : 'mes-documents'/);
    expect(VUE).toMatch(/setPrefs\(loadPrefs\(context\)\)/);
    expect(VUE).toMatch(/savePrefs\(context, next\)/);
    expect(VUE).not.toMatch(/localStorage/);
  });

  it('n’ajoute aucune recherche locale (UX-01)', () => {
    for (const f of [VUE, BARRE, read('src/components/documents/v2/DocumentsFilterPanel.tsx')]) {
      expect(f).not.toMatch(/type="search"/);
    }
  });
});

describe('filtres — panneau dans la page', () => {
  const PANNEAU = read('src/components/documents/v2/DocumentsFilterPanel.tsx');

  it('Bien, Rubrique, Type ; pas de filtre Bien dans l’onglet d’un bien', () => {
    expect(PANNEAU).toMatch(/title="Bien"/);
    expect(PANNEAU).toMatch(/title="Rubrique"/);
    expect(PANNEAU).toMatch(/title="Type"/);
    expect(PANNEAU).toMatch(/const avecBien = context === 'mes-documents'/);
  });

  it('filtres actifs visibles « Filtré par … », retirables, avec « Tout effacer »', () => {
    expect(PANNEAU).toMatch(/Filtré par/);
    expect(PANNEAU).toMatch(/aria-label=\{`Retirer le filtre \$\{c\.label\}`\}/);
    expect(PANNEAU).toMatch(/Tout effacer/);
    expect(PANNEAU).toMatch(/aria-pressed=\{option\.active\}/);
  });

  it('l’ancien tiroir « Tri & filtres » a disparu', () => {
    expect(() => read('src/components/documents/v2/DocumentsFilterDrawer.tsx')).toThrow();
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

  it('maquette 1a : cadre 4:3, page posée en bas, titre sous l’aperçu', () => {
    expect(VUE).toMatch(/aspect-\[4\/3\]/);
    expect(VUE).toMatch(/items-end justify-center/);
    expect(VUE).toMatch(/text-\[13px\] font-medium">\{document\.title\}/);
  });

  it('document sans rubrique : badge « À classer »', () => {
    expect(VUE).toMatch(/isToClassify\(document\) && <ToClassifyBadge \/>/);
    expect(VUE).toMatch(/<Badge\s+variant="pending"/);
  });

  it('l’aperçu PDF est rendu à la demande et mémorisé', () => {
    const pdf = read('src/components/ui/pdf-thumbnail.tsx');
    expect(pdf).toContain('IntersectionObserver');
    expect(pdf).toMatch(/rendus\.set\(fileId, dataUrl\)/);
  });
});
