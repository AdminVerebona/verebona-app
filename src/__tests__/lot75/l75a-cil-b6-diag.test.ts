/**
 * Lot 75A — ticket 1 « Diagnostics réels — incohérences résiduelles B6 et
 * schéma PostgreSQL » (tests L75A-B6-xx, L75A-SCH-xx, L75A-REF-xx) et
 * ticket 2 « Affichage contextuel du champ Usage énergétique » (L75A-UE-xx).
 *
 * Tests purs (évaluation, préparation, mappeur, template, présentation du
 * tiroir). Les parcours qui écrivent en base sont sur PostgreSQL 16 dans
 * `src/test/e2e/scenarios/l75a-cil-b6-contradiction.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: vi.fn() } }));
// Transformation JSX classique en environnement `node` (même convention que l75h).
(globalThis as { React?: typeof React }).React = React;

const { evaluateCilB6, cilB6NotApplicableRefusedMessage } = await import('@/services/exports/cil-preparation.service');
const { buildPreparation } = await import('@/services/exports/v12/preparation/prepare');
const { mapDossierData } = await import('@/services/exports/v12/data/mappers');
const { buildDefaultChoices, planSelection } = await import('@/services/exports/v12/data/choices');
const { renderDossierHtml } = await import('@/services/exports/v12/templates');
const { makeSource, TODAY } = await import('@/services/exports/v12/__tests__/fixtures/sources');
const { schemaNotReadyMessage, schemaProbeState, missingFromPresenceFlags, probeCount } = await import('@/lib/schema-readiness-log');
const {
  classifyCilEnergyEquipment, isCilEnergyEquipment, isEnergyUsageFieldRelevant, suggestEnergyUsageFromType, cilEnergyEquipments,
} = await import('@/lib/cil/energy-equipment');
const {
  ENERGY_USAGE_UNSET, energyUsageFormPresentation, energyUsagePayload, showEnergyUsageInView,
  EquipmentEnergyUsageField, EquipmentEnergyUsageView,
} = await import('@/components/assets/equipment-energy-usage-field');

import type { CilBlock, CilReadiness, CilEquipmentRow } from '@/services/exports/cil-preparation.service';
import type { SourceEquipment } from '@/services/exports/v12/data/source';
import type { CilData } from '@/services/exports/v12/types';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// ── Chaîne préparation → DTO → mappeur → PDF ──────────────────────────────

const LABELS: Record<string, string> = {
  B1: 'Identification du logement', B3: 'Plans et coupes', B4: 'Réseaux', B5: 'Matériaux à incidence énergétique',
  B6: 'Équipements à incidence énergétique', B7: 'Travaux de rénovation énergétique', B8: 'Documents de performance énergétique', B9: 'Documents annexes',
};
const equip = (id: number, over: Partial<SourceEquipment>): SourceEquipment => ({
  id, name: `Équipement ${id}`, type: null, category: null, brand: null, model: null, energyType: null, ...over,
});
const JUSTIF = 'Logement sans chauffage propre (déclaration 2025)';

function chain(list: SourceEquipment[], resolution: string | undefined) {
  const rows: CilEquipmentRow[] = list.map((e) => ({ id: e.id, type: e.type, category: e.category, energyType: e.energyType, energyUsage: (e as { energyUsage?: string | null }).energyUsage ?? null }));
  const b6 = evaluateCilB6(rows, resolution);
  const blocks: CilBlock[] = ['B1', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9'].map((id) => (id === 'B6' ? b6.block : {
    id, label: LABELS[id], status: 'complete', blocking: false, missingItems: [],
  }));
  const readiness: CilReadiness = {
    globalStatus: 'ready', completion: { resolvedBlocks: 8, applicableBlocks: 8, totalBlocks: 8, percentage: 100 },
    blocks, blockingBlocks: [], energyEquipmentIds: b6.energyEquipmentIds,
  };
  const resolutions = resolution ? [{ blockId: 'B6', resolution, justification: JUSTIF }] : [];
  const source = makeSource('IMMOBILIER', 'CIL', { cil: { readiness, profile: null, materials: [], works: [], resolutions }, equipments: list });
  const plan = planSelection('CIL', source, buildDefaultChoices('CIL', source, { today: TODAY }), TODAY);
  const meta = { reference: 'VBN-TEST-75A', generatedAt: '2026-10-20T09:00:00+02:00', preparedBy: null, templateLabel: 't', zipName: null, label: 'T' };
  const data = mapDossierData('CIL', { source, plan, resolved: null, meta, today: TODAY }) as CilData;
  const html = renderDossierHtml('CIL', data as never, { sys: 'SYS/', asset: () => null, stylesheets: [], pageMap: null }).html;
  const dto = buildPreparation('CIL', source, { today: TODAY, lastGeneration: null }).cil!.blocks.find((b) => b.id === 'B6')!;
  return { b6, dto, data, html, mapped: data.cil.blocks.find((b) => b.code === 'B6')!, rendered: (data.cil.equipments ?? []).map((r) => r.equipment) };
}

describe('L75A-B6 — B6 « Non applicable » vs équipements énergétiques retenus', () => {
  it('L75A-B6-01 — non applicable sans équipement énergétique : déclaration appliquée partout (préparation, DTO, mappeur, PDF)', () => {
    const c = chain([equip(1, { name: 'TV salon', type: 'Téléviseur' })], 'not_applicable');
    expect(c.b6.block.status).toBe('not_applicable');
    expect(c.b6.block.neutralizedResolution).toBeUndefined();
    expect(c.dto).toMatchObject({ status: 'not_applicable', notice: null, neutralizedResolution: null, canMarkNotApplicable: true });
    expect(c.mapped).toMatchObject({ status: 'not_applicable', resolution: JUSTIF });
    expect(c.data.cil.notApplicableNote).toBe(JUSTIF);
    expect(c.rendered).toEqual([]);
    expect(c.html).toContain(JUSTIF);
  });

  it('L75A-B6-02 — PAC ajoutée après « non applicable » : B6 renseigné, déclaration neutralisée (conservée, signalée)', () => {
    const c = chain([equip(2, { name: 'PAC jardin', type: 'Pompe à chaleur air/eau' })], 'not_applicable');
    expect(c.b6.block.status).toBe('complete');
    expect(c.b6.energyEquipmentIds).toEqual([2]);
    expect(c.b6.block.neutralizedResolution).toBe('not_applicable');
    expect(c.b6.block.notice).toMatch(/déclaration « Non applicable » avait été enregistrée/);
    expect(c.b6.block.notice).toMatch(/reste conservée/);
    // DTO (desktop et mobile : même panneau) : renseigné, plus de « marquer non applicable », information explicite.
    expect(c.dto).toMatchObject({ status: 'complete', neutralizedResolution: 'not_applicable', canMarkNotApplicable: false });
    expect(c.dto.notice).toBe(c.b6.block.notice);
    // Mappeur et PDF : renseigné, équipement présent, justification NON reprise.
    expect(c.mapped).toMatchObject({ status: 'complete', source: '1 équipement', resolution: null });
    expect(c.data.cil.notApplicableNote).toBeNull();
    expect(c.rendered).toEqual(['PAC jardin']);
    expect(c.html).toContain('PAC jardin');
    expect(c.html).not.toContain(JUSTIF);
    expect(c.html).not.toContain('Blocs non applicables.');
  });

  it('L75A-B6-03 — équipement non énergétique devenu énergétique (type puis usage déclaré) : recalcul', () => {
    const avant = chain([equip(3, { name: 'Appareil buanderie', type: 'Sèche-linge' })], 'not_applicable');
    expect(avant.b6.block.status).toBe('not_applicable');
    const parType = chain([equip(3, { name: 'Appareil buanderie', type: 'Chauffe-eau thermodynamique' })], 'not_applicable');
    expect(parType.b6.block.status).toBe('complete');
    expect(parType.rendered).toEqual(['Appareil buanderie']);
    const parUsage = chain([equip(3, { name: 'Appareil buanderie', type: 'Sèche-linge', energyUsage: 'ecs' } as never)], 'not_applicable');
    expect(parUsage.b6.block).toMatchObject({ status: 'complete', neutralizedResolution: 'not_applicable' });
  });

  it('L75A-B6-04 — retrait / archivage / « Aucun » sur le dernier équipement énergétique : la déclaration conservée redevient effective', () => {
    // Archivé = absent de la lecture B6 (filtre `archived_at IS NULL`, couvert en e2e) ; ici : liste vide.
    expect(chain([], 'not_applicable').b6.block.status).toBe('not_applicable');
    const aucun = chain([equip(4, { name: 'Chaudière', type: 'Chaudière gaz', energyUsage: 'aucun' } as never)], 'not_applicable');
    expect(aucun.b6.block.status).toBe('not_applicable');
    expect(aucun.rendered).toEqual([]);
    // Sans déclaration : « à compléter », jamais de repli vers tous les équipements.
    const sans = chain([equip(5, { name: 'TV', type: 'Téléviseur' })], undefined);
    expect(sans.b6.block.status).toBe('unknown');
    expect(sans.rendered).toEqual([]);
  });

  it('L75A-B6-05 — message de refus de la déclaration (route) : nombre réel d’équipements', () => {
    expect(cilB6NotApplicableRefusedMessage(1)).toMatch(/un équipement à incidence énergétique est identifié/);
    expect(cilB6NotApplicableRefusedMessage(3)).toMatch(/3 équipements à incidence énergétique sont identifiés/);
  });

  it('L75A-B6-06 — sources : la route refuse, l’évaluation et la route partagent la même lecture ; panneau informé', () => {
    const route = read('src/app/api/assets/[id]/exports/cil/resolutions/route.ts');
    expect(route).toMatch(/blockId === 'B6' && resolution === 'not_applicable'/);
    expect(route).toContain('cilB6EnergyEquipmentIds(assetId)');
    expect(route).toContain('status: 409');
    // DELETE inchangé : seule une action explicite retire une déclaration.
    expect(route.match(/\.delete\(cilBlockResolutions\)/g)?.length).toBe(1);
    const svc = read('src/services/exports/cil-preparation.service.ts');
    expect(svc).toContain('const equips = await loadCilB6Equipments(assetId);');
    expect(svc).not.toMatch(/if \(resolution === 'not_applicable'\) status = 'not_applicable';/);
    const panel = read('src/components/exports/preparation/CilBlocksPanel.tsx');
    expect(panel).toContain('{b.notice}');
    expect(panel).toContain("'CIL_B6_ENERGY_EQUIPMENT_PRESENT'");
    expect(panel).toContain('Retirer l’ancienne déclaration « non applicable »');
  });
});

// ── Diagnostics de schéma (DIAG-AU03 adapté) ─────────────────────────────

describe('L75A-SCH — diagnostics de schéma PostgreSQL : jamais « migration non appliquée »', () => {
  const base = { scope: '[x]', migration: '0223', expected: ['a', 'b', 'c'], consequence: 'Effet.' };
  const all = [
    { ...base, found: 3 }, { ...base, found: 2 }, { ...base, found: 0 }, { ...base, missing: [] as string[] },
    { ...base, missing: ['b'] }, { ...base, missing: ['a', 'b', 'c'] }, { ...base, error: new Error('x') }, { ...base },
  ];

  it('L75A-SCH-01 — toutes présentes : « Schéma conforme »', () => {
    expect(schemaProbeState({ ...base, found: 3 })).toBe('conforme');
    expect(schemaProbeState({ ...base, missing: [] })).toBe('conforme');
    expect(schemaNotReadyMessage({ ...base, missing: [] })).toContain('Schéma conforme');
  });

  it('L75A-SCH-02 — certaines absentes : « Schéma incomplet » avec la liste exacte', () => {
    const m = schemaNotReadyMessage({ ...base, missing: ['b'] });
    expect(m).toContain('Schéma incomplet');
    expect(m).toContain(': b absent (2/3 présents)');
    expect(m).not.toMatch(/\ba absent|c absent/);
    // Contrôle par comptage : n/N, sans prétendre savoir lesquels.
    const n = schemaNotReadyMessage({ ...base, found: 2 });
    expect(n).toContain('Schéma incomplet');
    expect(n).toContain('2/3');
    expect(n).toContain('éléments absents non identifiés');
  });

  it('L75A-SCH-03 — aucune trouvée : « Aucun élément attendu trouvé », cause non présumée', () => {
    for (const p of [{ ...base, found: 0 }, { ...base, missing: ['a', 'b', 'c'] }]) {
      const m = schemaNotReadyMessage(p);
      expect(m).toContain('Aucun élément attendu trouvé');
      expect(m).toContain('Cause non déterminée');
    }
  });

  it('L75A-SCH-04 — vérification en échec : « impossible » avec la cause technique', () => {
    const m = schemaNotReadyMessage({ ...base, found: null, error: new Error('permission denied for schema public') });
    expect(m).toContain('Vérification du schéma (migration 0223) impossible : permission denied for schema public');
    expect(m).toContain('État du schéma non constaté');
  });

  it('L75A-SCH-05 — résultat indéterminé : jamais présenté comme une absence', () => {
    const m = schemaNotReadyMessage({ ...base });
    expect(schemaProbeState({ ...base })).toBe('indetermine');
    expect(m).toContain('État du schéma indéterminé');
    expect(m).not.toMatch(/absent/);
    // Résultats inexploitables → inconnu (null), jamais 0 ni « tout absent ».
    expect(probeCount([])).toBeNull();
    expect(probeCount(undefined)).toBeNull();
    expect(probeCount([{ n: 'x' }])).toBeNull();
    expect(probeCount([{ n: 2 }])).toBe(2);
    expect(probeCount([{ n: '3' }])).toBe(3);
    expect(missingFromPresenceFlags(['a', 'b'], undefined)).toBeNull();
    expect(missingFromPresenceFlags(['a', 'b'], [true, null])).toBeNull();
    expect(missingFromPresenceFlags(['a', 'b'], [true, false])).toEqual(['b']);
  });

  it('L75A-SCH-06 — aucun message n’affirme « MIGRATION … NON APPLIQUÉE »', () => {
    for (const p of all) expect(schemaNotReadyMessage(p)).not.toMatch(/NON APPLIQU|non appliqu|n'a pas été appliqu/i);
  });

  it('L75A-SCH-07 — contrôles booléens : un drapeau par élément (liste exacte), plus de fallback « au moins un élément absent »', () => {
    for (const f of ['src/services/ai/source-analysis/source-units/repository.ts', 'src/services/ai/source-analysis/operation-candidates/persist.ts', 'src/services/agenda/agenda-columns.ts']) {
      const src = read(f);
      expect(src, f).toContain('missingFromPresenceFlags(');
      expect(src, f).toContain('missing: absents');
    }
    expect(read('src/lib/schema-readiness-log.ts')).not.toContain('au moins un élément absent');
  });
});

// ── §4 CI : scénarios e2e CIL regroupés (étape CI ajoutée par l'intégrateur) ──

describe('L75A-CI — scénarios e2e CIL exécutables d’une seule commande', () => {
  it('L75A-CI-01 — `npm run test:e2e:cil` : l69, l70b et les nouveaux scénarios B6 (échec = code non nul de vitest --run)', () => {
    const script = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['test:e2e:cil'];
    expect(script).toMatch(/^vitest --run --config vitest\.e2e\.config\.ts /);
    for (const f of ['l69-diag-etat-reel', 'l70b-usage-energetique', 'l75a-cil-b6-contradiction']) {
      expect(script).toContain(`src/test/e2e/scenarios/${f}.e2e.ts`);
      expect(() => read(`src/test/e2e/scenarios/${f}.e2e.ts`)).not.toThrow();
    }
  });
});

// ── §5 Référentiel énergétique (TYPE_USAGES) ─────────────────────────────

describe('L75A-REF — référentiel energy-equipment : types inconnus, libellés ambigus, « aucun »', () => {
  it('L75A-REF-01 — types inconnus / historiques non référencés : non classés (aucun repli)', () => {
    for (const type of ['Sèche-serviettes', 'Ventilateur', 'Hotte aspirante', 'Aspirateur', 'Téléviseur', 'Lave-linge', 'Box internet', 'Onduleur', 'Thermostat', '']) {
      expect(classifyCilEnergyEquipment({ type }), type).toBeNull();
    }
    expect(cilEnergyEquipments([{ type: 'Aspirateur' }, { type: 'Lave-linge' }])).toEqual([]);
  });

  it('L75A-REF-02 — libellés ambigus : seule la TÊTE du champ type compte, mot entier', () => {
    expect(classifyCilEnergyEquipment({ type: 'Pacman arcade' })).toBeNull();
    expect(classifyCilEnergyEquipment({ type: 'Pac air/eau' })).toEqual({ usage: 'chauffage', basis: 'type' });
    expect(classifyCilEnergyEquipment({ type: 'Ventilation mécanique' })).toEqual({ usage: 'ventilation', basis: 'type' });
    expect(classifyCilEnergyEquipment({ type: 'Ventilations' })).toBeNull();
    expect(classifyCilEnergyEquipment({ type: 'Insert bois' })).toEqual({ usage: 'chauffage', basis: 'type' });
    expect(classifyCilEnergyEquipment({ type: 'Robot avec chauffage intégré' })).toBeNull();
    expect(classifyCilEnergyEquipment({ type: 'Panneau solaire thermique' })).toEqual({ usage: 'enr', basis: 'type' });
    expect(classifyCilEnergyEquipment({ type: 'CHAUFFE-EAU électrique' })).toEqual({ usage: 'ecs', basis: 'type' });
    // Comportement existant conservé (documenté) : « Poêle » est lu comme chauffage — l'usage déclaré « Aucun » corrige.
    expect(classifyCilEnergyEquipment({ type: 'Poêle' })).toEqual({ usage: 'chauffage', basis: 'type' });
    expect(classifyCilEnergyEquipment({ type: 'Poêle', energyUsage: 'aucun' })).toBeNull();
    // La catégorie exige une égalité stricte (pas de recherche de mot).
    expect(classifyCilEnergyEquipment({ category: 'chauffage d’appoint décoratif' })).toBeNull();
  });

  it('L75A-REF-03 — exclusion explicite « aucun » : prioritaire sur type, catégorie et caractéristiques CIL ; null jamais lu comme « aucun »', () => {
    expect(isCilEnergyEquipment({ energyUsage: 'aucun', type: 'Pompe à chaleur', category: 'CHAUFFAGE', energyType: 'ELEC' })).toBe(false);
    expect(isCilEnergyEquipment({ energyUsage: null, type: 'Pompe à chaleur' })).toBe(true);
    expect(isCilEnergyEquipment({ energyUsage: 'AUCUN', type: 'Pompe à chaleur' })).toBe(true); // valeur hors liste ignorée
    expect(suggestEnergyUsageFromType('Aspirateur')).toBeNull();
  });
});

// ── Ticket 2 : affichage contextuel du champ « Usage énergétique » ───────

const pres = (o: Partial<Parameters<typeof energyUsageFormPresentation>[0]>) => energyUsageFormPresentation({
  persistedEnergyUsage: null, formValue: ENERGY_USAGE_UNSET, type: '', base: null, advancedOpen: false, ...o,
});
const vue = (knownEnergyUsage: string | null | undefined, type: string | null, base = null as Parameters<typeof showEnergyUsageInView>[0]['base']) =>
  showEnergyUsageInView({ knownEnergyUsage, type, base });

describe('L75A-UE — champ « Usage énergétique » affiché selon sa pertinence', () => {
  it('L75A-UE-01 — aspirateur sans usage déclaré : absent en consultation et du formulaire standard (Roborock S8 Pro Ultra)', () => {
    expect(vue(null, 'Aspirateur')).toBe(false);
    expect(pres({ type: 'Aspirateur' })).toEqual({ placement: 'advanced', visible: false });
    const html = renderToStaticMarkup(h(EquipmentEnergyUsageField, {
      presentation: pres({ type: 'Aspirateur' }), value: ENERGY_USAGE_UNSET, onChange: () => {}, editable: true, type: 'Aspirateur',
      advancedOpen: false, onAdvancedOpenChange: () => {},
    }));
    expect(html).toContain('Options avancées');
    expect(html).not.toContain('equipment-energy-usage"');
    expect(html).not.toContain('Non renseigné');
  });

  it('L75A-UE-02 — tableau du ticket : masqué / visible', () => {
    for (const t of ['Aspirateur', 'Téléviseur', 'Lave-linge']) expect(vue(null, t), t).toBe(false);
    for (const t of ['Chaudière', 'Pompe à chaleur', 'VMC', 'Chauffe-eau', 'Panneaux photovoltaïques']) expect(vue(null, t), t).toBe(true);
    // Atypique déclaré énergétique.
    expect(vue('chauffage', 'Sèche-serviettes')).toBe(true);
    // Catégorie ou caractéristique CIL structurée (type inconnu).
    expect(vue(null, 'Appareil', { category: 'CHAUFFAGE' })).toBe(true);
    expect(vue(null, 'Appareil', { energyType: 'GAZ' })).toBe(true);
    // Valeur pas encore lue : rien n'est affirmé.
    expect(vue(undefined, 'Chaudière')).toBe(false);
  });

  it('L75A-UE-03 — chaudière sans usage déclaré : visible, « Non renseigné » ; formulaire direct', () => {
    expect(vue(null, 'Chaudière gaz')).toBe(true);
    expect(renderToStaticMarkup(h(EquipmentEnergyUsageView, { value: null }))).toContain('Non renseigné');
    expect(pres({ type: 'Chaudière gaz' })).toEqual({ placement: 'direct', visible: true });
  });

  it('L75A-UE-04 — VMC avec usage déclaré : valeur affichée et modifiable', () => {
    expect(vue('ventilation', 'VMC simple flux')).toBe(true);
    expect(renderToStaticMarkup(h(EquipmentEnergyUsageView, { value: 'ventilation' }))).toContain('Ventilation');
    const p = pres({ persistedEnergyUsage: 'ventilation', formValue: 'ventilation', type: 'VMC simple flux' });
    expect(p).toEqual({ placement: 'direct', visible: true });
    expect(energyUsagePayload({ isCreateMode: false, knownEnergyUsage: 'ventilation', visible: p.visible, formValue: 'ecs' })).toBe('ecs');
  });

  it('L75A-UE-05 — chaudière « Aucun usage énergétique » : choix visible et modifiable, exclusion B6 conservée', () => {
    expect(isCilEnergyEquipment({ energyUsage: 'aucun', type: 'Chaudière' })).toBe(false);
    expect(isEnergyUsageFieldRelevant({ energyUsage: 'aucun', type: 'Chaudière' })).toBe(true);
    expect(vue('aucun', 'Chaudière')).toBe(true);
    expect(renderToStaticMarkup(h(EquipmentEnergyUsageView, { value: 'aucun' }))).toContain('Aucun usage énergétique');
    expect(pres({ persistedEnergyUsage: 'aucun', formValue: 'aucun', type: 'Chaudière' }).placement).toBe('direct');
    // Même « aucun » sur un type non énergétique : le choix explicite reste visible (donnée de l'utilisateur).
    expect(vue('aucun', 'Aspirateur')).toBe(true);
  });

  it('L75A-UE-06 — équipement atypique : section avancée ; déclaré énergétique → visible et direct', () => {
    const ouverte = pres({ type: 'Sèche-serviettes', advancedOpen: true });
    expect(ouverte).toEqual({ placement: 'advanced', visible: true });
    // Une valeur choisie dans la section la garde ouverte (jamais masquée, jamais perdue).
    expect(pres({ type: 'Sèche-serviettes', formValue: 'chauffage', advancedOpen: false })).toEqual({ placement: 'advanced', visible: true });
    expect(energyUsagePayload({ isCreateMode: true, knownEnergyUsage: null, visible: true, formValue: 'chauffage' })).toBe('chauffage');
    // Persisté : présenté directement ensuite.
    expect(pres({ type: 'Sèche-serviettes', persistedEnergyUsage: 'chauffage', formValue: 'chauffage' }).placement).toBe('direct');
    const html = renderToStaticMarkup(h(EquipmentEnergyUsageField, {
      presentation: ouverte, value: ENERGY_USAGE_UNSET, onChange: () => {}, editable: true, type: 'Sèche-serviettes',
      advancedOpen: true, onAdvancedOpenChange: () => {},
    }));
    expect(html).toContain('data-placement="advanced"');
    expect(html).toContain('Usage énergétique');
    expect(html).toContain('aria-expanded="true"');
  });

  it('L75A-UE-07 — type non énergétique → énergétique : mise à jour immédiate du formulaire', () => {
    expect(pres({ type: 'Aspirateur' }).placement).toBe('advanced');
    expect(pres({ type: 'Pompe à chaleur' }).placement).toBe('direct');
    expect(pres({ type: 'Pompe' }).placement).toBe('advanced');
  });

  it('L75A-UE-08 — masquage : aucune modification ni suppression de la valeur persistée ; NULL jamais converti en « aucun »', () => {
    // Champ masqué : rien n'est envoyé (champ absent du corps = inchangé côté serveur, cf. L70-ENER-E02).
    expect(energyUsagePayload({ isCreateMode: false, knownEnergyUsage: null, visible: false, formValue: ENERGY_USAGE_UNSET })).toBeUndefined();
    expect(energyUsagePayload({ isCreateMode: true, knownEnergyUsage: null, visible: false, formValue: ENERGY_USAGE_UNSET })).toBeUndefined();
    // Valeur non lue en modification : rien n'est envoyé.
    expect(energyUsagePayload({ isCreateMode: false, knownEnergyUsage: undefined, visible: true, formValue: 'chauffage' })).toBeUndefined();
    // « Non renseigné » visible : null, jamais « aucun ».
    expect(energyUsagePayload({ isCreateMode: false, knownEnergyUsage: null, visible: true, formValue: ENERGY_USAGE_UNSET })).toBeNull();
    // Un type changé vers non énergétique ne masque jamais une valeur persistée.
    expect(pres({ type: 'Aspirateur', persistedEnergyUsage: 'chauffage', formValue: 'chauffage' })).toEqual({ placement: 'direct', visible: true });
  });

  it('L75A-UE-09 — desktop et mobile : même composant dans le tiroir unique ; condition non dupliquée', () => {
    const drawer = read('src/components/assets/EquipmentDrawer.tsx');
    expect(drawer).toContain('<EquipmentEnergyUsageField');
    expect(drawer).toContain('showEnergyUsageInView({ knownEnergyUsage, type: eq.type, base: energyRelevanceBase })');
    expect(drawer).not.toContain('knownEnergyUsage !== undefined && (');
    expect(drawer).toContain('energyUsagePayload({ isCreateMode, knownEnergyUsage, visible: energyPresentation.visible, formValue: energyUsage })');
    // 75H conservé (cartes cliquables).
    expect(drawer).toMatch(/<EntityCard\s+key=\{s\.supplierId\}\s+kind="fournisseur"/);
    const field = read('src/components/assets/equipment-energy-usage-field.tsx');
    expect(field).toContain('isEnergyUsageFieldRelevant(');
    expect(field).not.toMatch(/TYPE_USAGES|chaudiere|aspirateur/i);
    expect(field).not.toMatch(/#[0-9a-f]{3,6}\b|bg-(blue|green|red|yellow|gray)-/i);
    // Lecture des caractéristiques CIL pour la pertinence.
    expect(read('src/app/api/equipments/[id]/route.ts')).toContain('LEFT JOIN equipment_cil_specs s ON s.equipment_id = e.id');
  });

  it('L75A-UE-10 — aucune carte « À traiter » liée à l’usage énergétique', () => {
    for (const f of ['src/app/api/v2/to-process/[publicId]/resolve/route.ts']) expect(read(f)).not.toMatch(/energy_?usage/i);
  });
});
