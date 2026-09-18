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

  it('n’ouvre plus le tiroir de classement au clic', () => {
    const corps = VUE.slice(VUE.indexOf('const openDocument'), VUE.indexOf('const classifyDocument'));
    expect(corps).not.toMatch(/setDrawerOpen\(true\)/);
  });

  it('garde le classement accessible par une action dédiée', () => {
    expect(VUE).toMatch(/onClassify\(document\)/);
    expect(VUE).toMatch(/const classifyDocument = \(doc: DocumentView\) => \{[\s\S]*?setDrawerOpen\(true\)/);
  });

  it('ouvre le classement sur la rubrique réelle du document', () => {
    // `rubricCode: null` affichait « Sans rubrique » pour un document classé,
    // et vidait la liste des Types, donc le Type déjà renseigné.
    expect(VUE).toMatch(/rubricCode: doc\.rubricCode/);
    expect(read('src/services/documents/rubric-query.service.ts')).toMatch(/rubricCode: row\.rubricCode/);
    expect(read('src/components/documents/v2/RubricClassificationDrawer.tsx'))
      .toMatch(/document\?\.rubricCode \?\? deduite/);
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
    expect(VUE).toMatch(/localStorage\.setItem\(VIEW_MODE_KEY, mode\)/);
    expect(VUE).toMatch(/localStorage\.getItem\(VIEW_MODE_KEY\)/);
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
