/**
 * « Mes documents », direction 1a « Flux continu » — logique d'affichage.
 *
 * Filtrer, trier, regrouper, compter et mémoriser les préférences : tout ce
 * qui décide de ce que l'utilisateur voit, testé sans monter l'écran.
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_FILTERS,
  NO_ASSET,
  NO_TYPE,
  UNFILED,
  activeFilterChips,
  buildFilterOptions,
  countLabel,
  defaultDirection,
  documentSubtitle,
  effectiveSort,
  emptyRubricsLine,
  filterDocuments,
  formatDateFr,
  groupDocuments,
  limitGroups,
  sortDocuments,
  sortOptionsFor,
  toggleFilter,
  type DocumentItem,
  type RubricRef,
} from '../documents-view';
import {
  DEFAULT_PREFS,
  LEGACY_VIEW_KEYS,
  loadPrefs,
  parsePrefs,
  prefsStorageKey,
  savePrefs,
} from '../view-prefs';
import { RUBRICS, RUBRIC_COLORS, UNFILED_COLORS, rubricColors } from '@/lib/referential/v2/rubrics';

const RUBRIQUES: RubricRef[] = [
  { code: 'PROPERTY_MANAGEMENT', label: 'Propriété et gestion' },
  { code: 'CONTRACTS_WARRANTIES_DOCS', label: 'Contrats, garanties et notices' },
  { code: 'MAINTENANCE_WORKS', label: 'Entretien et travaux' },
  { code: 'MEDIA', label: 'Photos et vidéos' },
  { code: 'OTHER_DOCUMENTS', label: 'Autres documents' },
];

let seq = 0;
function doc(p: Partial<DocumentItem> & { title: string }): DocumentItem {
  seq += 1;
  return {
    id: seq,
    publicId: `p${seq}`,
    originalFilename: `${p.title}.pdf`,
    assetId: 1,
    rubricCode: 'PROPERTY_MANAGEMENT',
    documentTypeCode: 'T',
    documentTypeLabel: 'Facture',
    documentDate: null,
    uploadedAt: '2025-01-01T10:00:00.000Z',
    mimeType: 'application/pdf',
    assetNames: ['Appartement Lyon'],
    ...p,
  };
}

const acte = doc({ title: 'Acte de vente', documentDate: '2023-09-15', uploadedAt: '2023-09-20T08:00:00Z', documentTypeCode: 'DEED', documentTypeLabel: 'Acte notarié' });
const velo = doc({ title: 'Facture achat vélo', assetId: 2, assetNames: ['Vélo Cargo'], documentDate: '2024-03-12', uploadedAt: '2024-03-12T08:00:00Z' });
const notice = doc({ title: 'Notice technique Packster', assetId: 2, assetNames: ['Vélo Cargo'], rubricCode: 'CONTRACTS_WARRANTIES_DOCS', documentTypeCode: 'NOTICE', documentTypeLabel: 'Notice', documentDate: '2024-03-12', uploadedAt: '2024-03-13T08:00:00Z' });
const devis = doc({ title: 'Devis peinture séjour', rubricCode: 'MAINTENANCE_WORKS', documentTypeCode: 'QUOTE', documentTypeLabel: 'Devis', documentDate: '2025-05-14', uploadedAt: '2025-05-14T08:00:00Z' });
const scan = doc({ title: 'Scan_20250912_0034', rubricCode: null, documentTypeCode: null, documentTypeLabel: null, uploadedAt: '2025-09-12T08:00:00Z' });
const orphelin = doc({ title: 'Mode d’emploi', assetId: null, assetNames: [], rubricCode: 'OTHER_DOCUMENTS', uploadedAt: '2022-01-01T08:00:00Z' });
const TOUS = [acte, velo, notice, devis, scan, orphelin];
const titres = (docs: DocumentItem[]) => docs.map((d) => d.title);

describe('tri global', () => {
  it('par défaut : date d’ajout, la plus récente d’abord', () => {
    expect(titres(sortDocuments(TOUS, 'added', 'desc', RUBRIQUES))).toEqual([
      'Scan_20250912_0034', 'Devis peinture séjour', 'Notice technique Packster', 'Facture achat vélo', 'Acte de vente', 'Mode d’emploi',
    ]);
  });

  it('une date absente passe en dernier dans les deux sens', () => {
    const asc = titres(sortDocuments(TOUS, 'docDate', 'asc'));
    const desc = titres(sortDocuments(TOUS, 'docDate', 'desc'));
    expect(asc.slice(-2).sort()).toEqual(['Mode d’emploi', 'Scan_20250912_0034']);
    expect(desc.slice(-2).sort()).toEqual(['Mode d’emploi', 'Scan_20250912_0034']);
    expect(desc[0]).toBe('Devis peinture séjour');
  });

  it('par nom : ordre alphabétique français, insensible à la casse et aux accents', () => {
    const d = [doc({ title: 'élagage' }), doc({ title: 'Assurance' }), doc({ title: 'devis 10' }), doc({ title: 'devis 9' })];
    expect(titres(sortDocuments(d, 'title', 'asc'))).toEqual(['Assurance', 'devis 9', 'devis 10', 'élagage']);
  });

  it('par Rubrique : « Sans rubrique » d’abord, puis l’ordre du référentiel', () => {
    expect(titres(sortDocuments([orphelin, devis, scan, acte], 'rubric', 'asc', RUBRIQUES)))
      .toEqual(['Scan_20250912_0034', 'Acte de vente', 'Devis peinture séjour', 'Mode d’emploi']);
  });

  it('par bien : les documents sans bien en dernier', () => {
    expect(titres(sortDocuments([orphelin, velo, acte], 'bien', 'asc'))).toEqual(['Acte de vente', 'Facture achat vélo', 'Mode d’emploi']);
  });

  it('regroupé, chaque section garde l’ordre global', () => {
    const triee = sortDocuments(TOUS, 'title', 'desc', RUBRIQUES);
    const { groups } = groupDocuments(triee, RUBRIQUES, true);
    for (const g of groups) {
      const positions = g.docs.map((d) => triee.indexOf(d));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it('sens naturel au changement de critère', () => {
    expect(defaultDirection('added')).toBe('desc');
    expect(defaultDirection('docDate')).toBe('desc');
    expect(defaultDirection('title')).toBe('asc');
    expect(defaultDirection('bien')).toBe('asc');
  });

  it('« Rubrique » n’est pas proposé regroupé, « Bien » pas dans l’onglet d’un bien', () => {
    expect(sortOptionsFor(true, 'mes-documents').map((o) => o.value)).toEqual(['added', 'docDate', 'title', 'bien']);
    expect(sortOptionsFor(false, 'mes-documents').map((o) => o.value)).toEqual(['added', 'docDate', 'title', 'bien', 'rubric']);
    expect(sortOptionsFor(false, 'fiche-bien').map((o) => o.value)).not.toContain('bien');
    expect(effectiveSort('rubric', true, 'mes-documents')).toBe('added');
    expect(effectiveSort('rubric', false, 'mes-documents')).toBe('rubric');
    expect(effectiveSort('bien', false, 'fiche-bien')).toBe('added');
  });
});

describe('regroupement par rubrique', () => {
  it('« Sans rubrique » en tête, puis les Rubriques dans l’ordre du référentiel', () => {
    const { groups } = groupDocuments(sortDocuments(TOUS, 'added', 'desc'), RUBRIQUES, true);
    expect(groups.map((g) => g.code)).toEqual([UNFILED, 'PROPERTY_MANAGEMENT', 'CONTRACTS_WARRANTIES_DOCS', 'MAINTENANCE_WORKS', 'OTHER_DOCUMENTS']);
    expect(groups[0].label).toBe('Sans rubrique');
    expect(groups[0].dot).toBe(UNFILED_COLORS.dot);
    expect(groups.every((g) => g.showHeader)).toBe(true);
  });

  it('les Rubriques vides n’ont pas de section, elles sont citées', () => {
    const { groups, emptyRubrics } = groupDocuments([acte], RUBRIQUES, true);
    expect(groups.map((g) => g.code)).toEqual(['PROPERTY_MANAGEMENT']);
    expect(emptyRubrics).toEqual(['Contrats, garanties et notices', 'Entretien et travaux', 'Photos et vidéos', 'Autres documents']);
    expect(emptyRubricsLine(['Photos et vidéos', 'Autres documents'])).toBe('Rubriques sans document : Photos et vidéos, Autres documents.');
    expect(emptyRubricsLine([])).toBe('');
  });

  it('pas de « Sans rubrique » quand tout est classé', () => {
    const { groups } = groupDocuments([acte, devis], RUBRIQUES, true);
    expect(groups.map((g) => g.code)).not.toContain(UNFILED);
  });

  it('sans regroupement : une seule liste, sans titre, dans le même ordre', () => {
    const triee = sortDocuments(TOUS, 'added', 'desc');
    const { groups, emptyRubrics } = groupDocuments(triee, RUBRIQUES, false);
    expect(groups).toHaveLength(1);
    expect(groups[0].showHeader).toBe(false);
    expect(groups[0].docs).toEqual(triee);
    expect(emptyRubrics).toEqual([]);
  });

  it('un document d’une Rubrique hors périmètre ne disparaît pas', () => {
    const inconnu = doc({ title: 'Bail', rubricCode: 'RENTAL_MANAGEMENT' });
    const { groups } = groupDocuments([inconnu], RUBRIQUES, true);
    expect(groups.map((g) => g.code)).toEqual(['RENTAL_MANAGEMENT']);
  });

  it('plafond de rendu : suit l’ordre d’affichage, compte le reste', () => {
    const { groups } = groupDocuments(sortDocuments(TOUS, 'added', 'desc'), RUBRIQUES, true);
    const limite = limitGroups(groups, 2);
    expect(limite.groups.flatMap((g) => g.docs)).toHaveLength(2);
    expect(limite.hidden).toBe(TOUS.length - 2);
    expect(limitGroups(groups, 100).hidden).toBe(0);
  });
});

describe('filtres', () => {
  it('ET entre dimensions, OU à l’intérieur', () => {
    let f = toggleFilter(EMPTY_FILTERS, 'biens', '2');
    expect(titres(filterDocuments(TOUS, f))).toEqual(['Facture achat vélo', 'Notice technique Packster']);
    f = toggleFilter(f, 'rubrics', 'CONTRACTS_WARRANTIES_DOCS');
    expect(titres(filterDocuments(TOUS, f))).toEqual(['Notice technique Packster']);
    f = toggleFilter(f, 'biens', '1');
    f = toggleFilter(f, 'rubrics', 'PROPERTY_MANAGEMENT');
    expect(titres(filterDocuments(TOUS, f))).toEqual(['Acte de vente', 'Facture achat vélo', 'Notice technique Packster']);
    expect(toggleFilter(f, 'biens', '2').biens).toEqual(['1']);
  });

  it('« Sans rubrique », « Sans bien » et « Type à compléter » sont filtrables', () => {
    expect(titres(filterDocuments(TOUS, { ...EMPTY_FILTERS, rubrics: [UNFILED] }))).toEqual(['Scan_20250912_0034']);
    expect(titres(filterDocuments(TOUS, { ...EMPTY_FILTERS, biens: [NO_ASSET] }))).toEqual(['Mode d’emploi']);
    expect(titres(filterDocuments(TOUS, { ...EMPTY_FILTERS, types: [NO_TYPE] }))).toEqual(['Scan_20250912_0034']);
  });

  it('options comptées sur le périmètre, sans les options vides', () => {
    const o = buildFilterOptions(TOUS, { ...EMPTY_FILTERS, biens: ['2'] }, RUBRIQUES);
    expect(o.biens.map((b) => [b.label, b.count, b.active])).toEqual([
      ['Appartement Lyon', 3, false], ['Vélo Cargo', 2, true], ['Sans bien', 1, false],
    ]);
    expect(o.rubrics.map((r) => r.label)).toEqual([
      'Sans rubrique', 'Propriété et gestion', 'Contrats, garanties et notices', 'Entretien et travaux', 'Autres documents',
    ]);
    expect(o.rubrics.find((r) => r.label === 'Photos et vidéos')).toBeUndefined();
    expect(o.types.map((t) => t.label)).toContain('Type à compléter');
  });

  it('pastilles « Filtré par » : libellés lisibles, dans l’ordre Bien, Rubrique, Type', () => {
    const f = { biens: ['2'], rubrics: [UNFILED], types: ['NOTICE'] };
    const chips = activeFilterChips(f, buildFilterOptions(TOUS, f, RUBRIQUES));
    expect(chips.map((c) => c.label)).toEqual(['Vélo Cargo', 'Sans rubrique', 'Notice']);
  });
});

describe('textes', () => {
  it('décompte selon le contexte et les filtres', () => {
    expect(countLabel(19, 19, false, 'mes-documents')).toBe('19 documents');
    expect(countLabel(1, 1, false, 'mes-documents')).toBe('1 document');
    expect(countLabel(4, 19, true, 'mes-documents')).toBe('4 documents sur 19');
    expect(countLabel(12, 12, false, 'fiche-bien')).toBe('12 documents rattachés à ce bien');
    expect(countLabel(1, 1, false, 'fiche-bien')).toBe('1 document rattaché à ce bien');
  });

  it('dates courtes françaises, jour de Paris pour un horodatage', () => {
    expect(formatDateFr('2025-09-02')).toBe('2 sept. 2025');
    expect(formatDateFr('2025-06-30T23:30:00Z')).toBe('1 juil. 2025');
    expect(formatDateFr(null)).toBe('—');
    expect(formatDateFr('n’importe quoi')).toBe('—');
  });

  it('sous-titre : Type · date du tri · bien (pas de bien dans l’onglet d’un bien)', () => {
    expect(documentSubtitle(acte, 'added', 'mes-documents')).toBe('Acte notarié · 20 sept. 2023 · Appartement Lyon');
    expect(documentSubtitle(acte, 'docDate', 'fiche-bien')).toBe('Acte notarié · 15 sept. 2023');
    expect(documentSubtitle(scan, 'added', 'fiche-bien')).toBe('Type à compléter · 12 sept. 2025');
  });
});

describe('couleurs des rubriques', () => {
  it('une couleur par Rubrique du référentiel, conforme au design system', () => {
    expect(Object.keys(RUBRIC_COLORS).sort()).toEqual(RUBRICS.map((r) => r.code).sort());
    expect(RUBRIC_COLORS.PROPERTY_MANAGEMENT).toEqual({ dot: '#60A5FA', accent: '#3B82F6' });
    expect(RUBRIC_COLORS.RENTAL_MANAGEMENT).toEqual({ dot: '#2DD4BF', accent: '#0D9488' });
    expect(rubricColors(null)).toBe(UNFILED_COLORS);
    expect(rubricColors('INCONNU')).toBe(UNFILED_COLORS);
  });

  it('les libellés du référentiel sont ceux de la maquette', () => {
    expect(RUBRICS.map((r) => r.label)).toEqual([
      'Propriété et gestion', 'Contrats, garanties et notices', 'Entretien et travaux', 'Assurances et sinistres',
      'Contrôles et conformité', 'Photos et vidéos', 'Gestion locative', 'Autres documents',
    ]);
  });
});

describe('préférences d’affichage mémorisées', () => {
  function memoire(initial: Record<string, string> = {}) {
    const m = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v); },
      dump: () => Object.fromEntries(m),
    };
  }

  it('valeurs par défaut de la maquette', () => {
    expect(DEFAULT_PREFS).toEqual({ grouped: true, view: 'list', sort: 'added', dir: 'desc' });
    expect(loadPrefs('mes-documents', memoire())).toEqual(DEFAULT_PREFS);
    expect(loadPrefs('mes-documents', null)).toEqual(DEFAULT_PREFS);
  });

  it('une clé par contexte', () => {
    const s = memoire();
    savePrefs('fiche-bien', { grouped: false, view: 'grid', sort: 'title', dir: 'asc' }, s);
    expect(loadPrefs('fiche-bien', s)).toEqual({ grouped: false, view: 'grid', sort: 'title', dir: 'asc' });
    expect(loadPrefs('mes-documents', s)).toEqual(DEFAULT_PREFS);
    expect(Object.keys(s.dump())).toEqual([prefsStorageKey('fiche-bien')]);
  });

  it('ne mémorise jamais de filtre', () => {
    const s = memoire();
    savePrefs('mes-documents', { ...DEFAULT_PREFS, filters: { biens: ['1'] } } as never, s);
    expect(s.dump()[prefsStorageKey('mes-documents')]).not.toMatch(/filters|biens/);
  });

  it('valeurs corrompues ou stockage inaccessible : retour aux défauts, sans erreur', () => {
    expect(loadPrefs('mes-documents', memoire({ [prefsStorageKey('mes-documents')]: '{pas du json' }))).toEqual(DEFAULT_PREFS);
    expect(parsePrefs({ grouped: 'oui', view: 'mosaïque', sort: 'poids', dir: 'haut' })).toEqual(DEFAULT_PREFS);
    expect(parsePrefs({ grouped: false, view: 'grid' })).toEqual({ ...DEFAULT_PREFS, grouped: false, view: 'grid' });
    const bloque = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    expect(loadPrefs('mes-documents', bloque)).toEqual(DEFAULT_PREFS);
    expect(() => savePrefs('mes-documents', DEFAULT_PREFS, bloque)).not.toThrow();
  });

  it('reprend l’ancien choix liste / vignettes', () => {
    const s = memoire({ [LEGACY_VIEW_KEYS['fiche-bien']]: 'grid' });
    expect(loadPrefs('fiche-bien', s).view).toBe('grid');
  });
});

describe('page complète : aucun document classé inatteignable', async () => {
  const { rubricsForPage } = await import('@/lib/documents/rubric-page');
  const { readFileSync } = await import('fs');
  const { join } = await import('path');
  const visibles = RUBRICS.filter((r) => r.code !== 'RENTAL_MANAGEMENT' && r.code !== 'MEDIA');

  it('une Rubrique hors périmètre mais non vide est rendue, à sa place', () => {
    const counts = new Map([['MEDIA', 2], ['__UNFILED__', 1]]);
    const codes = rubricsForPage(visibles, counts, true).map((r) => r.code);
    expect(codes).toContain('MEDIA');
    expect(codes).not.toContain('RENTAL_MANAGEMENT');
    expect(codes).not.toContain('__UNFILED__');
    expect(codes.indexOf('MEDIA')).toBeLessThan(codes.indexOf('OTHER_DOCUMENTS'));
  });

  it('un code inconnu du référentiel est rendu en dernier ; aperçu paginé inchangé', () => {
    const counts = new Map([['LEGACY_X', 3]]);
    const page = rubricsForPage(visibles, counts, true);
    expect(page[page.length - 1]).toEqual({ code: 'LEGACY_X', label: 'LEGACY_X' });
    expect(rubricsForPage(visibles, counts, false).map((r) => r.code)).toEqual(visibles.map((r) => r.code));
  });

  it('le groupement côté écran place ces documents dans leur section', () => {
    const rubrics = rubricsForPage(visibles, new Map([['MEDIA', 1]]), true);
    const photo = doc({ title: 'Photo', rubricCode: 'MEDIA' });
    const { groups } = groupDocuments([photo], rubrics, true);
    expect(groups.map((g) => g.code)).toEqual(['MEDIA']);
    expect(groups[0].label).toBe('Photos et vidéos');
  });

  it('requête limitée au compte, découpée en lots ; plus aucun chargement complet (DOC-PERF)', () => {
    const service = readFileSync(join(process.cwd(), 'src/services/documents/rubric-query.service.ts'), 'utf-8');
    expect(service).toMatch(/const scope = \[eq\(assetFiles\.accountId, query\.accountId\), isNull\(assetFiles\.deletedAt\)\]/);
    expect(service).toMatch(/\.limit\(query\.limit \+ 1\)/);
    expect(service).toMatch(/rubricsForPage\(visibleRubrics, scopeByRubric, true\)/);
    expect(service).not.toMatch(/MAX_LOADED_DOCUMENTS|query\.pageSize/);
    const vue = readFileSync(join(process.cwd(), 'src/components/documents/v2/DocumentsByRubric.tsx'), 'utf-8');
    expect(vue).not.toMatch(/params\.set\('pageSize'|MAX_LOADED_DOCUMENTS/);
  });
});
