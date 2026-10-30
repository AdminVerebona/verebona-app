/**
 * Lot 71 (71C) — Harmonisation des filtres « Mes documents » / « Mon
 * agenda » et filtre dynamique « Équipement ».
 *
 * Environnement `node` : logique pure, rendu serveur des composants
 * partagés (`renderToStaticMarkup`), contrat des pages lu dans les sources,
 * routes avec services simulés. Les associations réelles en base sont
 * prouvées sur PostgreSQL par `l71c-filtres-equipement.e2e.ts`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';

(globalThis as { React?: typeof React }).React = React;
vi.mock('@/db', () => ({ db: {}, pgClient: vi.fn() }));
const session = vi.hoisted(() => ({ current: { userId: 1, currentAccountId: 10 } as { userId: number; currentAccountId: number | null } }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: vi.fn(async () => session.current),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
const svc = vi.hoisted(() => ({
  getDocumentFeed: vi.fn(),
  getAgendaItems: vi.fn(),
  getAgendaItemsWithEquipmentFacet: vi.fn(),
}));
vi.mock('@/services/documents/rubric-query.service', async (orig) => ({
  ...(await orig<typeof import('@/services/documents/rubric-query.service')>()),
  getDocumentFeed: (...a: unknown[]) => svc.getDocumentFeed(...a),
}));
vi.mock('@/services/agenda/AgendaQueryService', () => ({
  getAgendaItems: (...a: unknown[]) => svc.getAgendaItems(...a),
  getAgendaItemsWithEquipmentFacet: (...a: unknown[]) => svc.getAgendaItemsWithEquipmentFacet(...a),
}));
vi.mock('@/services/agenda/AgendaWriteService', () => ({ createAgendaItem: vi.fn() }));
vi.mock('@/lib/write-access-guard', () => ({ refuserSiLectureSeule: vi.fn() }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvent: vi.fn() }));

const {
  EQUIPMENT_FILTER_ALL, buildEquipmentFilterModel, equipmentFilterParam, parseEquipmentFilter, selectedEquipmentId,
} = await import('@/lib/filters/equipment-filter');
const { filterItemsByEquipment, countItemsByEquipment, documentEquipmentFilterCondition, equipmentScopeAssetIds } =
  await import('@/services/equipments/equipment-filter-scope');
const { buildFeedQuery, parseFeedParams } = await import('@/lib/documents/document-feed');
const { matchesFilters, buildFeedMeta, equipmentAssetScope } = await import('@/services/documents/rubric-query.service');
const view = await import('@/components/documents/v2/documents-view');
const { parseSnapshot } = await import('@/components/documents/v2/list-restore');
const { agendaFilterChips, parseAgendaPeriod, AGENDA_PERIOD_OPTIONS } = await import('@/lib/agenda/agenda-filters');
const { EquipmentFilterSection } = await import('@/components/filters/EquipmentFilterSection');
const { ActiveFilterChips, FilterChoiceSection, FilterPanel, FilterPillSection, FiltersToggleButton } =
  await import('@/components/filters/FilterControls');
const { DocumentsFilterPanel } = await import('@/components/documents/v2/DocumentsFilterPanel');

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const noop = () => {};

const MAISON = { assetId: 1, assetName: 'Maison' };
const STUDIO = { assetId: 2, assetName: 'Studio' };
const chaudiere = { id: 11, name: 'Chaudière', ...MAISON, count: 3 };
const robot = { id: 12, name: 'Robot aspirateur', ...MAISON, count: 1 };
const chaudiereStudio = { id: 21, name: 'Chaudière', ...STUDIO, count: 2 };

// ── Modèle du filtre Équipement ───────────────────────────────────────────

describe('FILT-01 — le filtre Équipement n’apparaît que si le contexte le justifie', () => {
  it('FILT-01a — aucun bien sélectionné : masqué (même si des équipements sont connus)', () => {
    const m = buildEquipmentFilterModel({ all: 5, assetOnly: 2, items: [chaudiere] }, 'all', 0);
    expect(m.visible).toBe(false);
    expect(m.chipLabel).toBeNull();
  });

  it('FILT-01b — bien sans équipement : masqué', () => {
    expect(buildEquipmentFilterModel({ all: 5, assetOnly: 5, items: [] }, 'all', 1).visible).toBe(false);
    expect(buildEquipmentFilterModel(null, 'all', 1).visible).toBe(false);
    expect(buildEquipmentFilterModel(undefined, '11', 1).visible).toBe(false);
  });

  it('FILT-01c — bien avec UN équipement : affiché, « Tous (bien et équipements) » par défaut', () => {
    const m = buildEquipmentFilterModel({ all: 5, assetOnly: 2, items: [chaudiere] }, undefined, 1);
    expect(m.visible).toBe(true);
    expect(m.multi).toBe(false);
    expect(m.general.map((o) => o.label)).toEqual(['Tous (bien et équipements)', 'Bien uniquement']);
    expect(m.general[0]).toMatchObject({ active: true, count: 5 });
    expect(m.general[1]).toMatchObject({ active: false, count: 2, value: 'asset' });
    expect(m.groups).toHaveLength(1);
    expect(m.groups[0].options).toEqual([expect.objectContaining({ value: '11', label: 'Chaudière', count: 3, active: false })]);
    expect(m.value).toBe(EQUIPMENT_FILTER_ALL);
  });

  it('FILT-01d — bien avec PLUSIEURS équipements : chacun proposé (ordre alphabétique), sélection exclusive', () => {
    const m = buildEquipmentFilterModel({ all: 5, assetOnly: 1, items: [robot, chaudiere] }, '12', 1);
    expect(m.groups[0].options.map((o) => o.label)).toEqual(['Chaudière', 'Robot aspirateur']);
    expect(m.groups[0].options.filter((o) => o.active).map((o) => o.value)).toEqual(['12']);
    expect(m.general.every((o) => !o.active)).toBe(true);
    expect(m.chipLabel).toBe('Robot aspirateur');
  });

  it('FILT-01e — plusieurs biens : groupes par bien, nom accessible et pastille préfixés par le bien', () => {
    const m = buildEquipmentFilterModel({ all: 9, assetOnly: 3, items: [chaudiereStudio, chaudiere] }, '21', 2);
    expect(m.multi).toBe(true);
    expect(m.general[1].label).toBe('Biens uniquement');
    expect(m.groups.map((g) => g.assetName)).toEqual(['Maison', 'Studio']);
    expect(m.groups[1].options[0].ariaLabel).toBe('Chaudière, équipement de Studio');
    expect(m.chipLabel).toBe('Studio · Chaudière');
  });

  it('FILT-01f — équipement archivé : proposé seulement s’il porte des éléments ou s’il est sélectionné', () => {
    const archiveVide = { ...robot, archived: true, count: 0 };
    const archivePlein = { ...robot, id: 13, name: 'Ancien chauffe-eau', archived: true, count: 2 };
    const m = buildEquipmentFilterModel({ all: 5, assetOnly: 1, items: [chaudiere, archiveVide, archivePlein] }, 'all', 1);
    expect(m.groups[0].options.map((o) => o.label)).toEqual(['Ancien chauffe-eau (archivé)', 'Chaudière']);
    const seulArchive = buildEquipmentFilterModel({ all: 5, assetOnly: 5, items: [archiveVide] }, 'all', 1);
    expect(seulArchive.visible).toBe(false);
  });

  it('FILT-01g — équipement inconnu (lien ancien) : sélection conservée, signalée, retirable', () => {
    const m = buildEquipmentFilterModel({ all: 5, assetOnly: 1, items: [chaudiere] }, '999', 1);
    expect(m.chipLabel).toBe('Équipement indisponible');
    expect(m.groups.at(-1)!.options[0]).toMatchObject({ value: '999', active: true, count: 0 });
  });

  it('FILT-01h — encodage : `all` jamais transmis, valeurs illisibles neutralisées', () => {
    expect(parseEquipmentFilter('asset')).toBe('asset');
    expect(parseEquipmentFilter('42')).toBe('42');
    for (const v of [null, undefined, '', 'all', '0', '-3', '4.2', 'abc', "1'; DROP", '99999999999']) {
      expect(parseEquipmentFilter(v)).toBe('all');
      expect(equipmentFilterParam(v)).toBeNull();
    }
    expect(selectedEquipmentId('42')).toBe(42);
    expect(selectedEquipmentId('asset')).toBeNull();
  });
});

// ── Distinction bien / équipement (événements chargés) ─────────────────────

describe('FILT-02 — résultats : distinction bien / équipement fondée sur les associations', () => {
  const items = [
    { id: 1, title: 'Taxe foncière', equipmentLinks: [] },
    { id: 2, title: 'Entretien', equipmentLinks: [{ equipmentId: 11 }] },
    { id: 3, title: 'Révision', equipmentLinks: [{ equipmentId: 11 }, { equipmentId: 12 }] },
    // Le titre cite l'équipement, mais aucune association : élément du bien.
    { id: 4, title: 'Facture Chaudière', equipmentLinks: [] },
    // Équipement d'un AUTRE bien (non retenu) : ne fait pas un élément d'équipement ici.
    { id: 5, title: 'Autre', equipmentLinks: [{ equipmentId: 99 }] },
  ];
  const ids = [11, 12];

  it('FILT-02a — « Tous » : bien ET équipements (l’élément d’équipement apparaît dans les résultats du bien parent)', () => {
    expect(filterItemsByEquipment(items, 'all', ids).map((i) => i.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('FILT-02b — « Bien uniquement » exclut les éléments propres aux équipements', () => {
    expect(filterItemsByEquipment(items, 'asset', ids).map((i) => i.id)).toEqual([1, 4, 5]);
  });

  it('FILT-02c — un équipement : seulement ses éléments explicitement associés (jamais déduits du titre)', () => {
    expect(filterItemsByEquipment(items, '11', ids).map((i) => i.id)).toEqual([2, 3]);
    expect(filterItemsByEquipment(items, '12', ids).map((i) => i.id)).toEqual([3]);
  });

  it('FILT-02d — équipement étranger aux biens retenus : aucun résultat ; biens sans équipement : filtre sans effet', () => {
    expect(filterItemsByEquipment(items, '99', ids)).toEqual([]);
    expect(filterItemsByEquipment(items, 'asset', []).map((i) => i.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('FILT-02e — compteurs : « Tous », « Bien uniquement », par équipement (0 compris : le défaut reste visible)', () => {
    const c = countItemsByEquipment(items, [11, 12, 13]);
    expect(c.all).toBe(5);
    expect(c.assetOnly).toBe(3);
    expect(Object.fromEntries(c.byEquipment)).toEqual({ 11: 2, 12: 1, 13: 0 });
  });

  it('FILT-02f — documents : condition SQL nulle pour « Tous » ou sans équipement, FALSE pour un équipement étranger', () => {
    expect(documentEquipmentFilterCondition('all', [{ id: 11 }])).toBeNull();
    expect(documentEquipmentFilterCondition('asset', [])).toBeNull();
    expect(documentEquipmentFilterCondition('11', [{ id: 11 }])).not.toBeNull();
    expect(documentEquipmentFilterCondition('asset', [{ id: 11 }])).not.toBeNull();
    const etranger = documentEquipmentFilterCondition('77', [{ id: 11 }])!;
    expect(JSON.stringify(etranger)).toContain('FALSE');
    expect(equipmentScopeAssetIds([3, 3, -1, 0, 2.5, 7])).toEqual([3, 7]);
  });

  it('FILT-02g — aucune lecture du nom ou du titre pour décider d’une association', () => {
    const src = lire('src/services/equipments/equipment-filter-scope.ts');
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/retained_?[Tt]itle|original_?[Ff]ilename|\.title\b|ILIKE|LIKE /);
    expect(code).toMatch(/asset_files.*equipment_id|assetFiles\.equipmentId/);
    expect(code).toMatch(/document_asset_links dal/);
  });
});

// ── Documents : état des filtres et contrat d'API ───────────────────────────

describe('FILT-03 — « Mes documents » : filtre Équipement combiné aux filtres existants', () => {
  it('FILT-03a — changer de bien réinitialise le filtre Équipement', () => {
    let f = view.setEquipmentFilter({ ...view.EMPTY_FILTERS, biens: ['1'] }, '11');
    expect(f.equipment).toBe('11');
    f = view.toggleFilter(f, 'biens', '2');
    expect(f.equipment).toBeUndefined();
    expect(f.biens).toEqual(['1', '2']);
    // Rubrique et Type ne touchent pas au filtre Équipement.
    const g = view.toggleFilter(view.setEquipmentFilter({ ...view.EMPTY_FILTERS, biens: ['1'] }, 'asset'), 'rubrics', 'MEDIA');
    expect(g.equipment).toBe('asset');
  });

  it('FILT-03b — « Tous » retire le filtre ; compteur « Filtres · N » et pastilles l’intègrent', () => {
    const f = view.setEquipmentFilter({ biens: ['1'], rubrics: ['MEDIA'], types: [] }, 'asset');
    expect(view.activeFilterCount(f)).toBe(3);
    expect(view.hasActiveFilters(view.setEquipmentFilter(view.EMPTY_FILTERS, 'all'))).toBe(false);
    const chips = view.activeFilterChips(f, { biens: [{ value: '1', label: 'Maison', count: 2, active: true }], rubrics: [], types: [] }, 'Bien uniquement');
    expect(chips.map((c) => `${c.dim}:${c.label}`)).toEqual(['biens:Maison', 'equipment:Bien uniquement', 'rubrics:MEDIA']);
  });

  it('FILT-03c — API : `equipment` lu, écrit, normalisé ; clé de requête stable', () => {
    const p = parseFeedParams(new URLSearchParams('biens=4&equipment=12&rubrics=MEDIA'));
    expect(p.filters).toEqual({ biens: ['4'], rubrics: ['MEDIA'], types: [], equipment: '12' });
    expect(parseFeedParams(new URLSearchParams('equipment=all')).filters.equipment).toBeUndefined();
    expect(parseFeedParams(new URLSearchParams('equipment=1 OR 1=1')).filters.equipment).toBeUndefined();
    const base = { assetIds: [], sort: 'added' as const, direction: 'desc' as const, grouped: false, ids: null };
    expect(buildFeedQuery({ ...base, filters: { biens: ['4'], rubrics: [], types: [], equipment: 'asset' } })).toContain('equipment=asset');
    expect(buildFeedQuery({ ...base, filters: { biens: ['4'], rubrics: [], types: [], equipment: 'all' } })).not.toContain('equipment');
    expect(buildFeedQuery({ ...base, filters: { biens: ['4'], rubrics: [], types: [] } }))
      .toBe(buildFeedQuery({ ...base, filters: { biens: ['4'], rubrics: [], types: [], equipment: 'all' } }));
  });

  it('FILT-03d — biens retenus : ceux de l’onglet, sinon ceux du filtre Bien (« Sans bien » écarté)', () => {
    expect(equipmentAssetScope({ assetIds: [5], filters: { biens: ['7'], rubrics: [], types: [] } })).toEqual([5]);
    expect(equipmentAssetScope({ assetIds: [], filters: { biens: ['7', '__NO_ASSET__'], rubrics: [], types: [] } })).toEqual([7]);
    expect(equipmentAssetScope({ assetIds: [], filters: { biens: [], rubrics: [], types: [] } })).toEqual([]);
  });

  it('FILT-03e — compteurs globaux : le total filtré respecte le filtre Équipement, le périmètre non', () => {
    const rows = [
      { assetId: 1, assetName: 'Maison', rubricCode: 'MEDIA', documentTypeCode: null, count: 3, equipmentMatch: true },
      { assetId: 1, assetName: 'Maison', rubricCode: 'MEDIA', documentTypeCode: null, count: 4, equipmentMatch: false },
    ];
    const filters = { biens: ['1'], rubrics: [], types: [], equipment: '11' };
    const meta = buildFeedMeta(rows, filters, { families: [], hasRentedAsset: false });
    expect(meta.total).toBe(3);
    expect(meta.scopeTotal).toBe(7);
    // Sans filtre Équipement (`equipmentMatch` absent), aucune ligne n'est écartée.
    expect(matchesFilters({ assetId: 1, rubricCode: null, documentTypeCode: null }, { biens: ['1'], rubrics: [], types: [] })).toBe(true);
  });

  it('FILT-03f — retour sur l’écran : le filtre Équipement est repris s’il est lisible', () => {
    const base = { v: 1, key: 'k', savedAt: 1000, documents: [], pageEnds: [], nextCursor: null, meta: null, scrollTop: 0 };
    expect(parseSnapshot({ ...base, filters: { biens: ['1'], rubrics: [], types: [], equipment: '11' } }, 1000)?.filters.equipment).toBe('11');
    expect(parseSnapshot({ ...base, filters: { biens: ['1'], rubrics: [], types: [], equipment: 'x' } }, 1000)?.filters.equipment).toBeUndefined();
    expect(parseSnapshot({ ...base, filters: { biens: [], rubrics: [], types: [] } }, 1000)?.filters).toEqual({ biens: [], rubrics: [], types: [] });
  });
});

// ── Composants partagés : rendu et accessibilité ────────────────────────────

describe('FILT-04 — composants de filtre mutualisés, accessibles', () => {
  it('FILT-04a — section Équipement : radiogroup nommé, état sélectionné, une seule pastille tabulable', () => {
    const model = buildEquipmentFilterModel({ all: 5, assetOnly: 2, items: [chaudiere, robot] }, '11', 1);
    const html = renderToStaticMarkup(h(EquipmentFilterSection, { id: 'eq', model, onSelect: noop }));
    expect(html).toContain('role="radiogroup" aria-labelledby="eq"');
    expect(html).toMatch(/<p id="eq" class="vb-app-label">Équipement<\/p>/);
    expect(html.match(/role="radio"/g)).toHaveLength(4);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-checked="true" aria-label="Chaudière, équipement de Maison" tabindex="0"/);
    expect(html).toContain('Tous (bien et équipements) · 5');
    expect(html).toContain('Bien uniquement · 2');
  });

  it('FILT-04b — section masquée : aucun rendu', () => {
    const html = renderToStaticMarkup(h(EquipmentFilterSection, { id: 'eq', model: buildEquipmentFilterModel(null, 'all', 1), onSelect: noop }));
    expect(html).toBe('');
  });

  it('FILT-04c — plusieurs biens : un sous-titre par bien, la sélection hors repli reste visible', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, name: `Équipement ${String(i).padStart(2, '0')}`, ...MAISON, count: 0 }));
    const model = buildEquipmentFilterModel({ all: 1, assetOnly: 1, items: [...many, chaudiereStudio] }, '111', 2);
    const html = renderToStaticMarkup(h(EquipmentFilterSection, { id: 'eq', model, onSelect: noop }));
    expect(html).toContain('>Maison</p>');
    // 8 premiers + la sélection (Équipement 11), le reste replié.
    expect(html).toContain('Équipement 11');
    expect(html).not.toContain('Équipement 09');
    expect(html).toMatch(/aria-expanded="false"[^>]*>Afficher les 4 autres</);
  });

  it('FILT-04d — pastilles à bascule, bouton « Filtres », panneau, ligne « Filtré par … »', () => {
    const pills = renderToStaticMarkup(h(FilterPillSection, { id: 's', title: 'Bien', options: [{ value: '1', label: 'Maison', active: true }], onToggle: noop }));
    expect(pills).toContain('aria-pressed="true"');
    expect(pills).toContain('>Maison</button>');
    const choix = renderToStaticMarkup(h(FilterChoiceSection, { id: 'p', title: 'Période', options: [{ value: 'all', label: 'Tout', active: true }, { value: 'past', label: 'Passés', active: false }], onSelect: noop }));
    expect(choix).toContain('role="radiogroup"');
    const bouton = renderToStaticMarkup(h(FiltersToggleButton, { count: 2, open: true, panelId: 'pan', onToggle: noop }));
    expect(bouton).toContain('aria-expanded="true"');
    expect(bouton).toContain('aria-controls="pan"');
    expect(bouton).toContain('Filtres · 2');
    const panneau = renderToStaticMarkup(h(FilterPanel, { id: 'pan', columns: 'md:grid-cols-2', children: 'x' }));
    expect(panneau).toContain('grid grid-cols-1');
    expect(panneau).not.toMatch(/role="dialog"|data-slot="sheet/);
    const chips = renderToStaticMarkup(h(ActiveFilterChips, { chips: [{ key: 'equipment', label: 'Maison · Chaudière' }], onRemove: noop, onClear: noop }));
    expect(chips).toContain('aria-label="Retirer le filtre Maison · Chaudière"');
    expect(chips).toContain('Tout effacer');
  });

  it('FILT-04e — « Mes documents » et onglet d’un bien : section Équipement dans le panneau', () => {
    const options = { biens: [], rubrics: [], types: [] };
    const model = buildEquipmentFilterModel({ all: 2, assetOnly: 1, items: [chaudiere] }, 'all', 1);
    const doc = renderToStaticMarkup(h(DocumentsFilterPanel, { id: 'f', context: 'mes-documents', options, onToggle: noop, equipment: model, onEquipment: noop }));
    expect(doc).toContain('data-testid="filtre-equipement"');
    const bien = renderToStaticMarkup(h(DocumentsFilterPanel, { id: 'f', context: 'fiche-bien', options, onToggle: noop, equipment: model, onEquipment: noop }));
    expect(bien).toContain('data-testid="filtre-equipement"');
    expect(bien).not.toContain('>Bien</p>');
    const sans = renderToStaticMarkup(h(DocumentsFilterPanel, { id: 'f', context: 'mes-documents', options, onToggle: noop, equipment: buildEquipmentFilterModel(null, 'all', 0), onEquipment: noop }));
    expect(sans).not.toContain('filtre-equipement');
  });
});

// ── « Mon agenda » : plus de tiroir, mêmes composants ───────────────────────

describe('FILT-05 — « Mon agenda » : filtres dans la page, sans tiroir (ordinateur et téléphone)', () => {
  const PAGE = lire('src/app/(dashboard)/agenda/page.tsx');

  it('FILT-05a — le tiroir de filtres a disparu, et aucun autre n’est monté', () => {
    expect(existsSync(join(process.cwd(), 'src/components/agenda/AgendaFiltersDrawer.tsx'))).toBe(false);
    expect(PAGE).not.toMatch(/AgendaFiltersDrawer|SheetContent|@\/components\/ui\/sheet|@\/components\/ui\/drawer|setShowFilters/);
  });

  it('FILT-05b — mêmes composants que « Mes documents » : bouton, panneau, sections, pastilles actives', () => {
    for (const c of ['<FiltersToggleButton', '<FilterPanel', '<FilterChoiceSection', '<FilterPillSection', '<EquipmentFilterSection', '<ActiveFilterChips']) {
      expect(PAGE).toContain(c);
    }
    expect(lire('src/components/documents/v2/DocumentsToolbar.tsx')).toContain('<FiltersToggleButton');
    expect(lire('src/components/documents/v2/DocumentsFilterPanel.tsx')).toMatch(/<FilterPanel[\s\S]*<FilterPillSection[\s\S]*<EquipmentFilterSection/);
  });

  it('FILT-05c — un seul panneau pour tous les écrans (aucune variante mobile en tiroir, aucun `hidden md:` sur le panneau)', () => {
    const panneau = PAGE.slice(PAGE.indexOf('<FilterPanel'), PAGE.indexOf('</FilterPanel>'));
    expect(panneau).not.toMatch(/hidden (sm|md|lg):/);
    expect(PAGE).toMatch(/\{filtersOpen && !masquerCommandes && \(\s*<FilterPanel/);
    expect(lire('src/components/filters/FilterControls.tsx')).toContain("grid grid-cols-1");
  });

  it('FILT-05d — filtres propres à l’agenda conservés : période, statut annulé, vues Liste/Mensuel/Annuel', () => {
    // Lot 100E (A8) : « Tous » (libellé de la décision PO) remplace « Tout ».
    expect(AGENDA_PERIOD_OPTIONS.map((o) => o.label)).toEqual(['Tous', 'À venir', "Aujourd'hui", 'Passés']);
    expect(PAGE).toContain('title="Période"');
    expect(PAGE).toContain("label: 'Afficher les annulés'");
    expect(PAGE).toContain('<AgendaViewControls');
    expect(parseAgendaPeriod('upcoming')).toBe('upcoming');
    expect(parseAgendaPeriod('demain')).toBe('all');
  });

  it('FILT-05e — filtre Équipement dans l’URL ; changer de bien le réinitialise ; « Tout effacer » garde la vue', () => {
    expect(PAGE).toMatch(/const equipment = equipmentFilterParam\(searchParams\.get\('equipment'\)\)/);
    // Lot 75B : le filtre Pièce est réinitialisé avec le filtre Équipement.
    expect(PAGE).toMatch(/updateURL\(\{ assetIds: next\.length > 0 \? next\.join\(','\) : null, equipment: null, piece: null \}\)/);
    // Lot 100E (A8) : la période suspendue par une recherche est aussi effacée.
    expect(PAGE).toMatch(/const clearFilters = \(\) => updateURL\(\{ period: null, \[SUSPENDED_PERIOD_PARAM\]: null, assetIds: null, equipment: null, piece: null, includeCancelled: null \}\)/);
    expect(PAGE).toMatch(/params\.set\('equipmentFacet', '1'\)/);
  });

  it('FILT-05f — rechargement après un filtre : le panneau reste monté (focus clavier conservé)', () => {
    expect(PAGE).toContain('const masquerCommandes = (loading && !loadedOnce) || agendaVide;');
  });

  it('FILT-05g — pastilles « Filtré par … » : Période, Bien, Équipement, Statut', () => {
    const chips = agendaFilterChips({
      period: 'past', assetIds: [1, 2], includeCancelled: true,
      assetOptions: [{ id: 1, name: 'Maison' }, { id: 2, name: 'Studio' }],
      equipmentChipLabel: 'Studio · Chaudière',
    });
    expect(chips).toEqual([
      { key: 'period', label: 'Passés' }, { key: 'bien:1', label: 'Maison' }, { key: 'bien:2', label: 'Studio' },
      { key: 'equipment', label: 'Studio · Chaudière' }, { key: 'cancelled', label: 'Annulés affichés' },
    ]);
    expect(agendaFilterChips({ period: 'all', assetIds: [], includeCancelled: false, assetOptions: [], equipmentChipLabel: null })).toEqual([]);
  });
});

// ── API ────────────────────────────────────────────────────────────────────

describe('FILT-06 — API : paramètre `equipment`, compte de la session', () => {
  beforeEach(() => {
    session.current = { userId: 1, currentAccountId: 10 };
    svc.getDocumentFeed.mockReset();
    svc.getAgendaItems.mockReset();
    svc.getAgendaItemsWithEquipmentFacet.mockReset();
  });

  it('FILT-06a — GET /api/v2/documents transmet le filtre Équipement normalisé, compte de la session', async () => {
    const { GET } = await import('@/app/api/v2/documents/route');
    svc.getDocumentFeed.mockResolvedValue({ documents: [], nextCursor: null, hasMore: false, limit: 50 });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await GET(new NextRequest('http://localhost/api/v2/documents?biens=4&equipment=12&accountId=99'));
    expect(svc.getDocumentFeed).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 10, filters: { biens: ['4'], rubrics: [], types: [], equipment: '12' },
    }));
    expect(info.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/"filtered":true/);
    info.mockRestore();
  });

  it('FILT-06b — GET /api/agenda : `equipment` et `equipmentFacet=1` (« Mon agenda ») ; sinon contrat inchangé', async () => {
    const { GET } = await import('@/app/api/agenda/route');
    svc.getAgendaItemsWithEquipmentFacet.mockResolvedValue({ items: [], equipmentFacet: { all: 0, assetOnly: 0, items: [] } });
    const res = await GET(new NextRequest('http://localhost/api/agenda?assetIds=4&equipment=asset&equipmentFacet=1'));
    expect(svc.getAgendaItemsWithEquipmentFacet).toHaveBeenCalledWith(expect.objectContaining({ accountId: 10, assetIds: [4], equipment: 'asset' }));
    expect(await res.json()).toEqual({ items: [], equipmentFacet: { all: 0, assetOnly: 0, items: [] } });

    svc.getAgendaItems.mockResolvedValue([]);
    const res2 = await GET(new NextRequest('http://localhost/api/agenda?assetIds=4&equipment=bidon'));
    expect(svc.getAgendaItems).toHaveBeenCalledWith(expect.objectContaining({ accountId: 10, assetIds: [4], equipment: undefined }));
    expect(await res2.json()).toEqual({ items: [] });
  });
});
