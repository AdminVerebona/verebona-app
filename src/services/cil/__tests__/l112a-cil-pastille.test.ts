/**
 * Lot 112A — pastille « Partiel » du PDF CIL (décision PO du 06/11).
 *
 * L112A-U-RULE    règle pure `cilBlockPillStatus` (statut de bloc + statut
 *                 granulaire du service commun d'état CIL, 111U).
 * L112A-U-LABELS  mêmes libellés texte dans le PDF et la préparation ;
 *                 couleurs = tons du moteur V12 (aucune couleur brute).
 * L112A-U-CHAIN   chaîne pure entrée commune → `readinessFromCilInput` →
 *                 préparation (DTO) → mappeur → template : pastille
 *                 identique bloc par bloc, « Partiel » rendu en TEXTE,
 *                 compteurs et en-tête cohérents, manques cités.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: vi.fn() } }));

const { cilBlockPillStatus, cilPillIsTodo, CIL_BLOCK_PILL } = await import('@/lib/cil/cil-block-pill');
const { CIL_STATUS_LABELS } = await import('@/lib/cil/cil-catalog');
const { STATUS } = await import('@/services/exports/v12/html/components');
const { readinessFromCilInput } = await import('@/services/exports/cil-preparation.service');
const { buildPreparation } = await import('@/services/exports/v12/preparation/prepare');
const { mapDossierData } = await import('@/services/exports/v12/data/mappers');
const { buildDefaultChoices, planSelection } = await import('@/services/exports/v12/data/choices');
const { renderDossierHtml } = await import('@/services/exports/v12/templates');
const { makeSource, TODAY } = await import('@/services/exports/v12/__tests__/fixtures/sources');

import type { CilStateInput } from '@/services/cil/state/evaluate';
import type { CilData } from '@/services/exports/v12/types';

describe('L112A-U-RULE — pastille d’un bloc', () => {
  it('bloc renseigné + état renseigné → Renseigné ; + partiel / à confirmer → Partiel ; + manquant → À compléter', () => {
    expect(cilBlockPillStatus('complete', 'renseigne')).toBe('complete');
    expect(cilBlockPillStatus('complete', 'non_applicable')).toBe('complete');
    expect(cilBlockPillStatus('complete', 'partiel')).toBe('partial');
    expect(cilBlockPillStatus('complete', 'a_confirmer')).toBe('partial');
    // B9 : des documents existent mais aucune annexe (Informations : « Manquant ») → jamais « Renseigné » ni « Partiel ».
    expect(cilBlockPillStatus('complete', 'manquant')).toBe('unknown');
  });
  it('bloc non bloquant sans élément mais donnée partielle → Partiel ; sinon statut de bloc inchangé', () => {
    expect(cilBlockPillStatus('unknown', 'partiel')).toBe('partial');
    expect(cilBlockPillStatus('unknown', 'manquant')).toBe('unknown');
    expect(cilBlockPillStatus('unknown', 'a_confirmer')).toBe('unknown');
    // Bloquant CIL-RULE-002 : reste « Manquant » (le blocage ne change pas).
    expect(cilBlockPillStatus('missing', 'partiel')).toBe('missing');
    expect(cilBlockPillStatus('invalid', 'partiel')).toBe('invalid');
    // « Non applicable » : seulement la déclaration effective du bloc.
    expect(cilBlockPillStatus('not_applicable', 'non_applicable')).toBe('not_applicable');
    expect(cilBlockPillStatus('not_applicable', 'partiel')).toBe('not_applicable');
  });
  it('instantané antérieur sans état granulaire : statut de bloc', () => {
    expect(cilBlockPillStatus('complete', undefined)).toBe('complete');
    expect(cilBlockPillStatus('unknown', null)).toBe('unknown');
  });
  it('« à compléter » des compteurs : partiel, inconnu, à corriger', () => {
    expect(['complete', 'partial', 'missing', 'unknown', 'invalid', 'not_applicable'].filter((s) => cilPillIsTodo(s as never))).toEqual(['partial', 'unknown', 'invalid']);
  });
});

describe('L112A-U-LABELS — libellés et charte', () => {
  it('le PDF reprend les libellés partagés ; « Partiel » = libellé de l’onglet Informations', () => {
    for (const [k, v] of Object.entries(CIL_BLOCK_PILL)) expect(STATUS[k].label).toBe(v.label);
    expect(CIL_BLOCK_PILL.partial.label).toBe(CIL_STATUS_LABELS.partiel);
    expect(CIL_BLOCK_PILL.complete.label).toBe(CIL_STATUS_LABELS.renseigne);
    expect(CIL_BLOCK_PILL.missing.label).toBe(CIL_STATUS_LABELS.manquant);
    expect(CIL_BLOCK_PILL.not_applicable.label).toBe(CIL_STATUS_LABELS.non_applicable);
  });
  it('tons du moteur V12 uniquement (classes .pill.ok/.warn/.bad), jamais une couleur brute', () => {
    expect(STATUS.partial).toEqual({ label: 'Partiel', tone: 'warn' });
    expect(STATUS.complete).toEqual({ label: 'Renseigné', tone: 'ok' });
    expect(STATUS.missing).toEqual({ label: 'Manquant', tone: 'bad' });
    expect(STATUS.not_applicable).toEqual({ label: 'Non applicable', tone: '' });
    for (const v of Object.values(STATUS)) expect(['ok', 'warn', 'bad', '']).toContain(v.tone);
  });
});

// ── Chaîne pure : entrée commune → préparation → PDF ───────────────────────

const base = (o: Partial<CilStateInput> = {}): CilStateInput => ({
  asset: { id: 1, address: '1 rue A', postalCode: '69001', city: 'Lyon', subtype: 'Appartement' },
  fields: {}, fieldSources: {}, profile: null, resolutions: [], documents: [], materials: [], equipments: [], works: [], journal: [],
  now: '2026-11-06T10:00:00Z', ...o,
});
const eq = (id: number, name: string, type: string, over: Record<string, unknown> = {}) => ({
  id, name, type, category: null, energyUsage: null, energyType: null, evacuationMode: null, heatNetworkDeliveryStation: null, brand: null, model: null, powerKw: null, fieldOrigins: {}, ...over,
});

function chain(input: CilStateInput) {
  const readiness = readinessFromCilInput(input);
  const source = makeSource('IMMOBILIER', 'CIL', {
    cil: { readiness, profile: null, materials: [], works: [], resolutions: input.resolutions },
    equipments: input.equipments.map((e) => ({ id: e.id, name: e.name, type: e.type ?? null, category: e.category ?? null, brand: e.brand, model: e.model, energyType: e.energyType ?? null, energyUsage: e.energyUsage ?? null })),
  });
  const plan = planSelection('CIL', source, buildDefaultChoices('CIL', source, { today: TODAY }), TODAY);
  const meta = { reference: 'VBN-TEST-112A', generatedAt: '2026-11-06T09:00:00+01:00', preparedBy: null, templateLabel: 't', zipName: null, label: 'T' };
  const data = mapDossierData('CIL', { source, plan, resolved: null, meta, today: TODAY }) as CilData;
  const html = renderDossierHtml('CIL', data as never, { sys: 'SYS/', asset: () => null, stylesheets: [], pageMap: null }).html;
  const dto = buildPreparation('CIL', source, { today: TODAY, lastGeneration: null }).cil!;
  return { readiness, data, html, dto };
}

describe('L112A-U-CHAIN — préparation ↔ PDF identiques', () => {
  it('B6 avec un seul usage couvert : « Partiel » au PDF ET à la préparation, manques cités dans la source', () => {
    const c = chain(base({ equipments: [eq(5, 'PAC', 'Pompe à chaleur air/eau', { energyType: 'électricité' })] }));
    const b6 = c.readiness.blocks.find((b) => b.id === 'B6')!;
    // Statut de bloc inchangé (présence, lot 75A) ; état commun « partiel ».
    expect(b6.status).toBe('complete');
    expect(b6.cilStatus).toBe('partiel');
    expect(c.dto.blocks.find((b) => b.id === 'B6')).toMatchObject({ status: 'complete', pillStatus: 'partial', canMarkNotApplicable: false });
    const mapped = c.data.cil.blocks.find((b) => b.code === 'B6')!;
    expect(mapped.status).toBe('partial');
    expect(mapped.source).toMatch(/^1 équipement · à compléter : /);
    expect(mapped.source).toContain('Eau chaude sanitaire');
    // Rendu TEXTE (impression N&B) avec la classe de ton du moteur.
    expect(c.html).toContain('<span class="pill warn ">Partiel</span>');
    expect(c.html).toContain('« Partiel » signale un bloc documenté');
  });

  it('pastille identique bloc par bloc (préparation = PDF) ; compteurs et en-tête cohérents', () => {
    const c = chain(base({ equipments: [eq(5, 'PAC', 'Pompe à chaleur air/eau', { energyType: 'électricité' })] }));
    for (const m of c.data.cil.blocks) {
      const d = c.dto.blocks.find((b) => b.id === m.code)!;
      expect({ code: m.code, pill: d.pillStatus ?? d.status }).toEqual({ code: m.code, pill: m.status });
    }
    const nPartial = c.data.cil.blocks.filter((b) => b.status === 'partial').length;
    expect(nPartial).toBeGreaterThan(0);
    expect(c.html).toMatch(new RegExp(`à compléter dont ${nPartial} partiels?`));
    // B1 (données réglementaires présentes) reste « Renseigné » ; bloquants inchangés.
    expect(c.data.cil.blocks.find((b) => b.code === 'B1')!.status).toBe('complete');
    expect(c.readiness.blockingBlocks.map((b) => b.id)).toEqual(['B3', 'B8']);
  });

  it('usages réglementaires tous couverts : « Renseigné », aucun « Partiel » pour B6', () => {
    const c = chain(base({
      equipments: [
        eq(5, 'PAC', 'Pompe à chaleur air/eau', { energyType: 'électricité' }),
        eq(6, 'Chauffe-eau', 'Chauffe-eau thermodynamique', { energyType: 'électricité' }),
        eq(7, 'VMC', 'VMC simple flux', { energyType: 'électricité' }),
      ],
      resolutions: [{ blockId: 'B6.refroidissement', resolution: 'not_applicable', justification: 'Pas de climatisation' }, { blockId: 'B6.enr', resolution: 'not_applicable', justification: 'Aucune production' }],
    }));
    const b6 = c.readiness.blocks.find((b) => b.id === 'B6')!;
    expect(b6.cilStatus).toBe('renseigne');
    expect(c.dto.blocks.find((b) => b.id === 'B6')!.pillStatus).toBe('complete');
    expect(c.data.cil.blocks.find((b) => b.code === 'B6')).toMatchObject({ status: 'complete', source: '3 équipements' });
  });

  it('bloc déclaré non applicable (justifié) : « Non applicable » partout, jamais « Partiel »', () => {
    const c = chain(base({ resolutions: [{ blockId: 'B5', resolution: 'not_applicable', justification: 'Logement sans paroi isolée' }] }));
    expect(c.dto.blocks.find((b) => b.id === 'B5')!.pillStatus).toBe('not_applicable');
    expect(c.data.cil.blocks.find((b) => b.code === 'B5')).toMatchObject({ status: 'not_applicable', resolution: 'Logement sans paroi isolée' });
  });

  it('blocs bloquants : « Manquant » (PDF) et « Bloquant » (préparation) inchangés', () => {
    const c = chain(base({ asset: { id: 1, address: null, postalCode: null, city: null, subtype: 'Appartement' } }));
    expect(c.data.cil.blocks.find((b) => b.code === 'B1')!.status).toBe('missing');
    expect(c.dto.blocks.find((b) => b.id === 'B1')).toMatchObject({ pillStatus: 'missing', blocksGeneration: true });
  });
});
