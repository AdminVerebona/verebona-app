/**
 * Lot 72 (72E) — décision PO du 19/10/2026 : filtre « Équipement » dans
 * l'onglet Agenda de la fiche d'un bien (ordinateur et téléphone).
 *
 * Réutilise le lot 71C : `EquipmentFilterSection` / `FilterControls`, modèle
 * `buildEquipmentFilterModel`, paramètres `equipment` et `equipmentFacet=1`
 * de `GET /api/agenda`. Le bien est fixé par la fiche.
 *
 * Environnement `node` : rendu serveur des composants, contrat de l'onglet
 * lu dans la source, route avec services simulés. Le filtrage réel sur
 * PostgreSQL est prouvé par `l72e-agenda-bien-equipement.e2e.ts`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';

(globalThis as { React?: typeof React }).React = React;
vi.mock('@/db', () => ({ db: {}, pgClient: vi.fn() }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: vi.fn(async () => ({ userId: 1, currentAccountId: 10 })),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
const svc = vi.hoisted(() => ({ getAgendaItems: vi.fn(), getAgendaItemsWithEquipmentFacet: vi.fn() }));
vi.mock('@/services/agenda/AgendaQueryService', () => ({
  getAgendaItems: (...a: unknown[]) => svc.getAgendaItems(...a),
  getAgendaItemsWithEquipmentFacet: (...a: unknown[]) => svc.getAgendaItemsWithEquipmentFacet(...a),
}));
vi.mock('@/services/agenda/AgendaWriteService', () => ({ createAgendaItem: vi.fn() }));
vi.mock('@/lib/write-access-guard', () => ({ refuserSiLectureSeule: vi.fn() }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvent: vi.fn() }));

const { buildEquipmentFilterModel } = await import('@/lib/filters/equipment-filter');
const filtres = await import('@/lib/agenda/asset-agenda-filters');
const { AssetAgendaFilterPanel } = await import('@/components/assets/AssetAgendaFilters');

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const TAB = 'src/components/assets/AssetAgendaTab.tsx';
const noop = () => {};

const facet = {
  all: 4,
  assetOnly: 1,
  items: [
    { id: 7, name: 'Chaudière', assetId: 3, assetName: 'Maison', count: 2 },
    { id: 8, name: 'Adoucisseur', assetId: 3, assetName: 'Maison', count: 0 },
    { id: 9, name: 'Ancien cumulus', assetId: 3, assetName: 'Maison', archived: true, count: 1 },
    { id: 10, name: 'Vieux portail', assetId: 3, assetName: 'Maison', archived: true, count: 0 },
  ],
};
const panel = (over: Partial<Parameters<typeof AssetAgendaFilterPanel>[0]> = {}) => renderToStaticMarkup(h(AssetAgendaFilterPanel, {
  id: 'f', view: 'list', period: 'all', includeCancelled: false,
  equipment: buildEquipmentFilterModel(facet, 'all', 1),
  onPeriod: noop, onToggleCancelled: noop, onEquipment: noop,
  ...over,
}));

describe('L72E-EQ-01 — section Équipement de l’onglet Agenda du bien', () => {
  it('L72E-EQ-01a — options : « Tous (bien et équipements) », « Bien uniquement », chaque équipement (archivé seulement s’il porte des éléments)', () => {
    const html = panel();
    expect(html).toContain('data-testid="filtre-equipement"');
    expect(html).toContain('Tous (bien et équipements)');
    expect(html).toContain('Bien uniquement');
    expect(html).toContain('Chaudière');
    expect(html).toContain('Adoucisseur'); // en service : proposé même à 0
    expect(html).toContain('Ancien cumulus (archivé)');
    expect(html).not.toContain('Vieux portail');
    // Bien fixé par la fiche : jamais « Biens uniquement », jamais de sous-groupe par bien.
    expect(html).not.toContain('Biens uniquement');
    expect(html).not.toContain('équipement de Maison</'); // pas de titre de groupe
  });

  it('L72E-EQ-01b — bien sans équipement (ou seulement archivés sans élément) : section masquée', () => {
    expect(panel({ equipment: buildEquipmentFilterModel(null, 'all', 1) })).not.toContain('filtre-equipement');
    const archivesVides = { all: 0, assetOnly: 0, items: [{ id: 10, name: 'Vieux portail', assetId: 3, assetName: 'Maison', archived: true, count: 0 }] };
    expect(panel({ equipment: buildEquipmentFilterModel(archivesVides, 'all', 1) })).not.toContain('filtre-equipement');
    // Les autres filtres de l'onglet restent proposés.
    expect(panel({ equipment: buildEquipmentFilterModel(null, 'all', 1) })).toContain('Afficher les annulés');
  });

  it('L72E-EQ-01c — mêmes composants que « Mon agenda » : panneau, sections Période et Statut, radiogroup accessible', () => {
    const html = panel({ equipment: buildEquipmentFilterModel(facet, '7', 1) });
    expect(html).toContain('data-testid="agenda-bien-filtres"');
    expect(html).toContain('Période');
    expect(html).toContain('Statut');
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/aria-checked="true"[^>]*>[\s\S]*?Chaudière/);
    // Une seule colonne sur téléphone (grille à partir de md) : même panneau pour tous les écrans.
    expect(html).toContain('grid grid-cols-1');
    expect(html).not.toMatch(/hidden md:/);
  });

  it('L72E-EQ-01d — période : options inchangées de l’onglet (Tout, À venir, Passés) ; masquée en vue annuelle', () => {
    expect(filtres.ASSET_AGENDA_PERIOD_OPTIONS.map((o) => o.value)).toEqual(['all', 'upcoming', 'past']);
    expect(panel()).toContain('À venir');
    expect(panel({ view: 'year' })).not.toContain('Période');
  });
});

describe('L72E-EQ-02 — pastilles « Filtré par … » et état vide', () => {
  it('L72E-EQ-02a — pastilles Période, Équipement, Statut (jamais le bien, fixé par la fiche)', () => {
    const model = buildEquipmentFilterModel(facet, '7', 1);
    expect(filtres.assetAgendaChips({ view: 'list', period: 'past', includeCancelled: true, equipmentChipLabel: model.chipLabel }))
      .toEqual([{ key: 'period', label: 'Passés' }, { key: 'equipment', label: 'Chaudière' }, { key: 'cancelled', label: 'Annulés affichés' }]);
    const bienSeul = buildEquipmentFilterModel(facet, 'asset', 1);
    expect(filtres.assetAgendaChips({ view: 'list', period: 'all', includeCancelled: false, equipmentChipLabel: bienSeul.chipLabel }))
      .toEqual([{ key: 'equipment', label: 'Bien uniquement' }]);
  });

  it('L72E-EQ-02b — vue annuelle : la période ne s’applique pas, aucune pastille Période', () => {
    expect(filtres.assetAgendaChips({ view: 'year', period: 'past', includeCancelled: false, equipmentChipLabel: null })).toEqual([]);
  });

  it('L72E-EQ-02c — agenda « vide » seulement sans filtre actif (un filtre trop restrictif reste retirable)', () => {
    expect(filtres.isAssetAgendaEmpty({ loading: false, itemCount: 0, view: 'list', activeFilters: 0 })).toBe(true);
    expect(filtres.isAssetAgendaEmpty({ loading: false, itemCount: 0, view: 'list', activeFilters: 1 })).toBe(false);
    expect(filtres.isAssetAgendaEmpty({ loading: false, itemCount: 0, view: 'calendar', activeFilters: 0 })).toBe(false);
    expect(filtres.isAssetAgendaEmpty({ loading: true, itemCount: 0, view: 'list', activeFilters: 0 })).toBe(false);
  });

  it('L72E-EQ-02d — équipement disparu (supprimé entre deux chargements) : sélection signalée et retirable', () => {
    const model = buildEquipmentFilterModel(facet, '999', 1);
    expect(model.chipLabel).toBe('Équipement indisponible');
    expect(panel({ equipment: model })).toContain('Équipement indisponible');
  });
});

describe('L72E-EQ-03 — onglet Agenda du bien : contrat avec /api/agenda (ordinateur et téléphone)', () => {
  const tab = lire(TAB);

  it('L72E-EQ-03a — demande la facette et transmet le filtre normalisé, bien fixé par la fiche', () => {
    expect(tab).toContain('assetIds: String(assetId)');
    expect(tab).toContain("params.set('equipmentFacet', '1');");
    expect(tab).toContain("if (equipment) params.set('equipment', equipment);");
    expect(tab).toMatch(/equipmentFilterParam\(/);
    expect(tab).toMatch(/buildEquipmentFilterModel\(equipmentFacet, equipment, 1\)/);
  });

  it('L72E-EQ-03b — même présentation que « Mon agenda » : bouton « Filtres », panneau, pastilles actives, aucun tiroir', () => {
    expect(tab).toContain('<FiltersToggleButton');
    expect(tab).toContain('<AssetAgendaFilterPanel');
    expect(tab).toContain('<ActiveFilterChips');
    expect(tab).not.toMatch(/Drawer[^\n]*[Ff]iltre|AgendaFiltersDrawer/);
    // Plus de rangée de pastilles de période propre à l'onglet : un seul jeu de filtres.
    expect(tab).not.toMatch(/\(\['all', 'upcoming', 'past'\] as PeriodFilter\[\]\)\.map/);
  });

  it('L72E-EQ-03c — un seul rendu pour tous les écrans : aucune variante cachée selon la largeur', () => {
    const bloc = tab.slice(tab.indexOf('<FiltersToggleButton'), tab.indexOf('<AgendaViewControls'));
    expect(bloc).not.toMatch(/hidden (sm|md|lg):|(sm|md|lg):hidden/);
  });

  it('L72E-EQ-03d — dernier chargement seul appliqué (filtres enchaînés) ; changement de bien → « Tous »', () => {
    expect(tab).toMatch(/let actuel = true;/);
    expect(tab).toMatch(/setEquipment\(null\)[\s\S]{0,80}\[assetId\]/);
  });

  it('L72E-EQ-03e — résultat vide avec filtres : « Aucun résultat avec ces filtres » (pas l’invitation à créer)', () => {
    expect(tab).toContain('Aucun résultat avec ces filtres.');
  });

  it('L72E-EQ-03f — garde d’écriture conservée (création depuis l’onglet)', () => {
    expect(tab).toContain('onClick={ouvrirCreation}');
    expect(tab).toContain('prefilledAssetId={assetId}');
  });
});

describe('L72E-EQ-04 — GET /api/agenda avec un seul bien (onglet de la fiche)', () => {
  beforeEach(() => { svc.getAgendaItems.mockReset(); svc.getAgendaItemsWithEquipmentFacet.mockReset(); });

  it('L72E-EQ-04a — `equipmentFacet=1` + `equipment=<id>` : service facetté, bien et compte de la session', async () => {
    svc.getAgendaItemsWithEquipmentFacet.mockResolvedValue({ items: [], equipmentFacet: facet });
    const { GET } = await import('@/app/api/agenda/route');
    const res = await GET(new NextRequest('http://localhost/api/agenda?assetIds=3&period=all&includeCancelled=false&includeUndated=true&equipmentFacet=1&equipment=7'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], equipmentFacet: facet });
    expect(svc.getAgendaItemsWithEquipmentFacet).toHaveBeenCalledWith(expect.objectContaining({ accountId: 10, assetIds: [3], equipment: '7' }));
  });

  it('L72E-EQ-04b — valeur illisible : neutralisée (liste complète)', async () => {
    svc.getAgendaItemsWithEquipmentFacet.mockResolvedValue({ items: [], equipmentFacet: null });
    const { GET } = await import('@/app/api/agenda/route');
    await GET(new NextRequest('http://localhost/api/agenda?assetIds=3&equipmentFacet=1&equipment=chaudiere'));
    expect(svc.getAgendaItemsWithEquipmentFacet).toHaveBeenCalledWith(expect.objectContaining({ equipment: undefined }));
  });
});
