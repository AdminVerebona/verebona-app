/**
 * Primitive unique (CDC 15 T4-09, SVC-07, lot 14 volet B) : traduction de
 * l'entrée en colonnes, liens, clé fonctionnelle ; rattrapage §14.6.
 */
import { describe, it, expect } from 'vitest';
import { agendaItemValues, agendaItemLinks, functionalKeyFor, primarySource, type AgendaUpsertInput } from '../agenda-write-primitive';
import { manualUpsertInput } from '../AgendaWriteService';
import { t4UpsertInput } from '../agenda-persistence';
import { computeAgendaFunctionalKey } from '../agenda-functional-key';
import { planAgendaDedupe, type DedupeRow } from '../backfill/agenda-backfill';

const evenement = (over: Partial<AgendaUpsertInput> = {}): AgendaUpsertInput => ({
  accountId: 1, assetId: 7, origin: 'AUTOMATIC', category: 'action', date: '2027-03-01', title: 'Contrôle technique',
  originFieldKey: 'nextInspection', sources: [{ fileId: 9, role: 'SOURCE' }], ...over,
});

describe('même événement, manuel ou automatique → même état, à l’origine près', () => {
  it('colonnes communes identiques ; seules diffèrent les colonnes d’origine', () => {
    const auto = agendaItemValues(evenement({ details: { occurrence: null } }));
    const manuel = agendaItemValues(evenement({ origin: 'MANUAL', sources: [{ fileId: 9, role: 'ATTACHMENT' }] }));
    const communes = ['title', 'startDate', 'homeCategory', 'originFieldKey', 'isAutomaticModified', 'requiresQualification'] as const;
    for (const k of communes) expect(manuel[k], k).toEqual(auto[k]);
    expect([auto.isAutomatic, manuel.isAutomatic]).toEqual([true, false]);
    expect([auto.originType, manuel.originType]).toEqual(['asset_field', 'manual']);
  });
  it('liens identiques : bien + cible fine', () => {
    expect(agendaItemLinks(evenement({ target: { type: 'EQUIPMENT', id: 3 } }))).toEqual({ assetIds: [7], substructureIds: [], equipmentIds: [3] });
    expect(agendaItemLinks(evenement({ origin: 'MANUAL', target: { type: 'ROOM', id: 4 } }))).toEqual({ assetIds: [7], substructureIds: [4], equipmentIds: [] });
  });
});

describe('parité des deux chemins historiques', () => {
  it('agenda manuel : entrée → colonnes historiques de createAgendaItem', () => {
    const input = manualUpsertInput({ title: 'Achat vélo', startDate: '2026-01-02', assetIds: [1, 2], fileIds: [5] }, 3, 7, 'information');
    expect(input).toMatchObject({ assetId: 1, origin: 'MANUAL', sources: [{ fileId: 5, role: 'ATTACHMENT' }], links: { assetIds: [1, 2], fileIds: [5] } });
  });
  it('T4 : nature et type métier du registre, source principale, occurrence', () => {
    const d = { action: 'create', title: 'CT', date: '2026-11-15', category: 'action', confidence: 'certain', reasonCode: 'X', deterministic: true, sourceFileId: 9, originFieldKey: 'nextInspection' } as never;
    const input = t4UpsertInput(d, 1, 7, false, 'k');
    expect(input).toMatchObject({ origin: 'AUTOMATIC', nature: 'DEADLINE', businessType: 'inspection', functionalKey: 'k', sources: [{ fileId: 9, role: 'SOURCE' }] });
    expect(primarySource(input)?.fileId).toBe(9);
  });
  it('mise à jour : seulement ce qui est fourni (statut seul : aucune autre colonne)', () => {
    const v = agendaItemValues({ itemId: 5, accountId: 1, assetId: null, origin: 'MANUAL', details: { manualStatus: 'realise' } });
    expect(Object.keys(v).sort()).toEqual(['manualStatus', 'updatedAt']);
    const preuve = agendaItemValues({ itemId: 5, accountId: 1, assetId: null, origin: 'AUTOMATIC', sources: [{ fileId: 2, role: 'PROOF' }], details: { manualStatus: 'realise' } });
    expect(preuve.originRefId).toBeUndefined();
    const maj = agendaItemValues({ itemId: 5, accountId: 1, assetId: null, origin: 'AUTOMATIC', title: 'CT', date: '2027-04-01', sources: [] });
    expect(maj).toMatchObject({ title: 'CT', startDate: '2027-04-01', originRefType: null, originRefId: null });
    expect(agendaItemLinks({ itemId: 5, accountId: 1, assetId: null, origin: 'MANUAL' })).toBeUndefined();
  });
});

describe('clé fonctionnelle (T4-08)', () => {
  it('fournie, sinon calculée depuis source + cible + type métier + champ + occurrence', () => {
    expect(functionalKeyFor(evenement({ functionalKey: 'x' }))).toBe('x');
    expect(functionalKeyFor(evenement({ occurrenceIndex: 'single' }))).toBe(computeAgendaFunctionalKey({
      sourceFileId: 9, target: { type: 'ASSET', id: 7 }, businessType: 'inspection', originFieldKey: 'nextInspection', occurrence: 'single',
    }));
    // La cible fine fait partie de la clé.
    expect(functionalKeyFor(evenement({ occurrenceIndex: 'single', target: { type: 'EQUIPMENT', id: 3 } })))
      .not.toBe(functionalKeyFor(evenement({ occurrenceIndex: 'single' })));
  });
  it('jamais pour un élément manuel, ni sans source ou occurrence', () => {
    expect(functionalKeyFor(evenement({ origin: 'MANUAL', occurrenceIndex: 'single' }))).toBeNull();
    expect(functionalKeyFor(evenement({ sources: [], occurrenceIndex: 'single' }))).toBeNull();
    expect(functionalKeyFor(evenement())).toBeNull();
  });
});

describe('§14.6 — dédoublonnage des éléments automatiques', () => {
  const r = (over: Partial<DedupeRow>): DedupeRow => ({
    id: 1, accountId: 1, assetId: 7, sourceFileId: 9, originFieldKey: 'nextInspection', title: 'CT', startDate: '2027-03-01',
    isAutomaticModified: false, manualStatus: null, ...over,
  });
  it('le plus ancien est gardé, les autres retirés', () => {
    const p = planAgendaDedupe([r({ id: 3 }), r({ id: 1 }), r({ id: 2 }), r({ id: 4, startDate: '2027-04-01' })]);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]).toMatchObject({ keep: [1], remove: [2, 3] });
    expect(p.remove).toEqual([2, 3]);
  });
  it('un élément modifié par l’utilisateur est gardé, jamais retiré', () => {
    const p = planAgendaDedupe([r({ id: 1 }), r({ id: 2, isAutomaticModified: true }), r({ id: 3, manualStatus: 'realise' })]);
    expect(p.groups[0]).toMatchObject({ keep: [2, 3], remove: [1], protected: [2, 3] });
  });
  it('sans champ d’origine : même titre normalisé ; un élément gardé ailleurs n’est pas retiré', () => {
    const p = planAgendaDedupe([
      r({ id: 1, originFieldKey: null, title: 'Révision' }), r({ id: 2, originFieldKey: null, title: 'revision' }),
      r({ id: 2, assetId: 8, originFieldKey: null, title: 'Revision' }), r({ id: 5, assetId: 8, originFieldKey: null, title: 'Révision' }),
    ]);
    expect(p.remove).toEqual([5]);
  });
});

describe('décision T4 enrichie (A, enabled) : sources, cible, occurrence du candidat', () => {
  const base = {
    action: 'create', title: 'Entretien', date: '2027-01-15', category: 'action', confidence: 'certain', reasonCode: 'X',
    deterministic: true, sourceFileId: 9, originFieldKey: 'maintenanceDueDate',
  };
  it('sources du candidat avec rôle et preuve ; document principal en tête ; repli sur sourceFileId', async () => {
    const { decisionSources } = await import('../agenda-persistence');
    expect(decisionSources({ ...base, sources: [{ fileId: 3, role: 'SOURCE', evidenceId: 7 }, { fileId: 9, role: 'SOURCE', evidenceId: 8 }, { fileId: 9, role: 'SOURCE' }] } as never))
      .toEqual([{ fileId: 9, role: 'SOURCE', evidenceId: 8 }, { fileId: 3, role: 'SOURCE', evidenceId: 7 }]);
    expect(decisionSources(base as never)).toEqual([{ fileId: 9, role: 'SOURCE' }]);
  });
  it('clé : occurrence et cible du candidat ; lien équipement ou pièce (sous-structure, D-G)', () => {
    const eq = t4UpsertInput({ ...base, occurrenceIndex: '2027-01-15', target: { type: 'EQUIPMENT', id: 4 } } as never, 1, 7, false, null);
    expect(eq).toMatchObject({ target: { type: 'EQUIPMENT', id: 4 }, keyTarget: { type: 'EQUIPMENT', id: 4 }, occurrenceIndex: '2027-01-15' });
    expect(functionalKeyFor(eq)).toBe(computeAgendaFunctionalKey({
      sourceFileId: 9, target: { type: 'EQUIPMENT', id: 4 }, businessType: 'maintenance', originFieldKey: 'maintenanceDueDate', occurrence: '2027-01-15',
    }));
    const piece = t4UpsertInput({ ...base, occurrenceIndex: 'single', target: { type: 'ROOM', id: 5 } } as never, 1, 7, false, null);
    expect(piece.target).toEqual({ type: 'ROOM', id: 5 });
    expect(piece.keyTarget).toEqual({ type: 'ROOM', id: 5 });
    expect(agendaItemLinks(piece)).toEqual({ assetIds: [7], substructureIds: [5], equipmentIds: [] });
  });
});
