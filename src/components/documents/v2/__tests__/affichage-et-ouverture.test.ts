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
    // Rubrique changée : Type incompatible vidé (lot 86E : compatibilité multi-rubrique).
    expect(champs).toMatch(/typeCompatible \? typeCode : null/);
    expect(champs).toMatch(/isTypeCompatibleWithRubric\(typeCode, next\)/);
    // Type choisi : Rubrique courante gardée si le Type y est proposé, sinon déduite.
    expect(champs).toMatch(/rubricForType\(next, rubricCode\) \?\? rubricCode/);
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
    // DOC-PERF : tri et filtres côté serveur, sur tout le périmètre ; l'écran
    // ne retrie jamais un lot, il le découpe en sections.
    expect(VUE).toMatch(/sort,\s*direction: prefs\.dir,\s*grouped: prefs\.grouped,\s*filters,/);
    expect(VUE).not.toMatch(/sortDocuments\(/);
    expect(VUE).toMatch(/groupDocuments\(charges, rubrics, prefs\.grouped\)/);
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

  // Lot 97C — décision PO du 26/10/2026 : l'interdiction UX-01 du CDC V2
  // (« aucun champ de recherche local ») est ANNULÉE. Le test qui la
  // verrouillait vérifie désormais l'inverse : UN champ commun, monté par
  // l'écran (au-dessus de la liste), jamais dupliqué dans la barre d'outils
  // ni dans le panneau de filtres, et appliqué côté serveur (`q` de la requête).
  it('recherche locale : le champ commun, au-dessus de la liste, appliqué par le serveur (lot 97C, UX-01 annulé)', () => {
    expect(VUE).toMatch(/import \{ LocalSearchField \} from '@\/components\/search\/LocalSearchField'/);
    expect(VUE).toMatch(/<LocalSearchField\s+kind="document"/);
    expect(VUE).toMatch(/ids: q \? null : resultIds,\s+q,/);
    for (const f of [VUE, BARRE, read('src/components/documents/v2/DocumentsFilterPanel.tsx')]) {
      expect(f).not.toMatch(/type="search"/);
    }
    expect(read('src/components/search/LocalSearchField.tsx')).toMatch(/type="search"/);
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
    // Lot 71 (71C) : pastilles et ligne « Filtré par … » mutualisées avec « Mon agenda ».
    const PARTAGE = read('src/components/filters/FilterControls.tsx');
    expect(PANNEAU).toMatch(/from '@\/components\/filters\/FilterControls'/);
    expect(PARTAGE).toMatch(/Filtré par/);
    expect(PARTAGE).toMatch(/aria-label=\{`Retirer le filtre \$\{c\.label\}`\}/);
    expect(PARTAGE).toMatch(/Tout effacer/);
    expect(PARTAGE).toMatch(/aria-pressed=\{option\.active\}/);
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
    // Miniature serveur (APP-PERF-06), jamais l'original dans une liste.
    expect(VUE).toMatch(/src=\{`\/api\/files\/\$\{document\.id\}\/thumbnail`\}/);
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
    // Miniature serveur d'abord ; repli navigateur mémorisé (cache borné, APP-PERF-07).
    expect(pdf).toMatch(/rendus\.set\(fileId, dataUrl\)/);
    expect(pdf).toMatch(/\/api\/files\/\$\{fileId\}\/thumbnail/);
  });
});
