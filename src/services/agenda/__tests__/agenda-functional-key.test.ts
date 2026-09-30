/**
 * Clé fonctionnelle, nature et plan de synchronisation — CDC 15 T4-08, D-14,
 * D-15 (lot 14). Fonctions pures.
 */
import { describe, it, expect } from 'vitest';
import {
  computeAgendaFunctionalKey, resolveEventSemantics, planSourceSync, isUserTouched, type SourceItem, type SyncDecision,
} from '../agenda-functional-key';

const d = (over: Partial<SyncDecision>): SyncDecision => ({
  index: 0, action: 'create', title: 'Prochain entretien', date: '2026-03-01', sourceFileId: 9, originFieldKey: 'maintenanceDueDate', ...over,
});
const item = (over: Partial<SourceItem>): SourceItem => ({
  id: 1, functionalKey: null, title: 'Prochain entretien', startDate: '2026-03-01', originFieldKey: 'maintenanceDueDate',
  isAutomatic: true, isAutomaticModified: false, manualStatus: null, ...over,
});

describe('clé fonctionnelle', () => {
  it('source + cible + type + champ + occurrence, stable et versionnée', () => {
    const k = computeAgendaFunctionalKey({ sourceFileId: 9, target: { type: 'ASSET', id: 3 }, businessType: 'maintenance', originFieldKey: 'maintenanceDueDate', occurrence: 'single' });
    expect(k).toMatch(/^[0-9a-f]{40}$/);
    expect(k).toBe(computeAgendaFunctionalKey({ sourceFileId: 9, target: { type: 'ASSET', id: 3 }, businessType: 'maintenance', originFieldKey: 'maintenanceDueDate', occurrence: 'single' }));
    expect(k).not.toBe(computeAgendaFunctionalKey({ sourceFileId: 9, target: { type: 'ASSET', id: 4 }, businessType: 'maintenance', originFieldKey: 'maintenanceDueDate', occurrence: 'single' }));
  });
});

describe('nature et type métier (D-14, D-15)', () => {
  it('déduits du registre et du catalogue ; jamais de la seule date', () => {
    expect(resolveEventSemantics({ originFieldKey: 'acquisitionDate' })).toEqual({ businessType: 'purchase', nature: 'HISTORICAL', notifiable: false });
    expect(resolveEventSemantics({ originFieldKey: 'maintenanceDueDate' })).toEqual({ businessType: 'maintenance', nature: 'DEADLINE', notifiable: true });
    expect(resolveEventSemantics({ businessType: 'claim' })).toMatchObject({ nature: 'HISTORICAL', notifiable: false });
    expect(resolveEventSemantics({ businessType: 'VENTE' })).toMatchObject({ businessType: 'sale', nature: 'HISTORICAL', notifiable: false });
    expect(resolveEventSemantics({ businessType: 'maintenance' })).toEqual({ businessType: 'maintenance', nature: null, notifiable: true });
    expect(resolveEventSemantics({})).toEqual({ businessType: null, nature: null, notifiable: true });
  });
});

describe('planSourceSync (T4-08)', () => {
  const base = { sourceFileId: 9, assetId: 3 };

  it('recette : échéance 01/03 corrigée en 01/04 → un seul élément, MIS À JOUR', () => {
    const premier = planSourceSync({ ...base, decisions: [d({})], items: [] });
    expect(premier.steps).toEqual([expect.objectContaining({ kind: 'create' })]);
    const key = (premier.steps[0] as { key: string }).key;
    const second = planSourceSync({ ...base, decisions: [d({ date: '2026-04-01' })], items: [item({ id: 5, functionalKey: key })] });
    expect(second.steps).toEqual([expect.objectContaining({ kind: 'update', itemId: 5, key, adopted: false })]);
    expect(second.remove).toEqual([]);
  });

  it('réanalyse identique : idempotente (mise à jour du même élément, rien retiré)', () => {
    const key = (planSourceSync({ ...base, decisions: [d({})], items: [] }).steps[0] as { key: string }).key;
    const p = planSourceSync({ ...base, decisions: [d({})], items: [item({ id: 5, functionalKey: key })] });
    expect(p.steps.map((s) => s.kind)).toEqual(['update']);
    expect(p.remove).toEqual([]);
  });

  it('élément antérieur à la clé : ADOPTÉ (pas de doublon)', () => {
    const p = planSourceSync({ ...base, decisions: [d({ date: '2026-04-01' })], items: [item({ id: 7 })] });
    expect(p.steps).toEqual([expect.objectContaining({ kind: 'update', itemId: 7, adopted: true })]);
  });

  it('élément modifié à la main (ou marqué réalisé) : jamais mis à jour ni retiré (§14.6)', () => {
    const key = (planSourceSync({ ...base, decisions: [d({})], items: [] }).steps[0] as { key: string }).key;
    const p = planSourceSync({ ...base, decisions: [d({ date: '2026-05-01' })], items: [item({ id: 5, functionalKey: key, isAutomaticModified: true })] });
    expect(p.steps).toEqual([expect.objectContaining({ kind: 'protected', itemId: 5 })]);
    const vide = planSourceSync({ ...base, decisions: [], items: [item({ id: 5, functionalKey: key, manualStatus: 'realise' }), item({ id: 6, functionalKey: 'x' })] });
    expect(vide.remove).toEqual([6]);
    expect(isUserTouched({ isAutomatic: false, isAutomaticModified: false, manualStatus: null })).toBe(true);
  });

  it('événement disparu : retiré ; élément consolidé (skip_duplicate) conservé', () => {
    const p = planSourceSync({
      ...base,
      decisions: [d({ action: 'skip_duplicate', existingItemId: 8 })],
      items: [item({ id: 8, functionalKey: 'k8' }), item({ id: 9, functionalKey: 'k9' })],
    });
    expect(p.remove).toEqual([9]);
    expect(p.keep).toContain(8);
  });

  it('occurrences de récurrence ou événements sans champ : la date fait l’occurrence ; rang en cas de collision', () => {
    const p = planSourceSync({
      ...base, items: [],
      decisions: [
        d({ index: 0, seriesKey: 's', date: '2026-01-01' }), d({ index: 1, seriesKey: 's', date: '2027-01-01' }),
        d({ index: 2, originFieldKey: null, title: 'Visite', date: '2026-06-01' }), d({ index: 3, originFieldKey: null, title: 'Autre', date: '2026-06-01' }),
      ],
    });
    const keys = p.steps.map((s) => (s as { key: string }).key);
    expect(new Set(keys).size).toBe(4);
    expect(keys[3]).toMatch(/#2$/);
  });

  it('décision d’une autre source : ignorée par le plan', () => {
    expect(planSourceSync({ ...base, decisions: [d({ sourceFileId: 10 })], items: [] }).steps).toEqual([]);
  });
});

describe('plan : occurrence et cible du candidat (A, enabled)', () => {
  it('index d’occurrence explicite et cible équipement dans la clé ; même date sur deux cibles = deux éléments', async () => {
    const { planSourceSync, computeAgendaFunctionalKey } = await import('../agenda-functional-key');
    const d = { action: 'create', title: 'Entretien', date: '2027-01-15', originFieldKey: 'maintenanceDueDate', sourceFileId: 9 };
    const plan = planSourceSync({
      sourceFileId: 9, assetId: 7, items: [],
      decisions: [
        { ...d, index: 0, occurrenceIndex: '2027-01-15' },
        { ...d, index: 1, occurrenceIndex: '2027-01-15', target: { type: 'EQUIPMENT', id: 4 } },
        { ...d, index: 2, occurrenceIndex: '2027-01-15', target: { type: 'EQUIPMENT', id: null } },
      ],
    });
    const cle = (target: { type: string; id: number }) => computeAgendaFunctionalKey({
      sourceFileId: 9, target, businessType: 'maintenance', originFieldKey: 'maintenanceDueDate', occurrence: '2027-01-15',
    });
    expect(plan.steps.map((x) => x.key)).toEqual([cle({ type: 'ASSET', id: 7 }), cle({ type: 'EQUIPMENT', id: 4 }), `${cle({ type: 'ASSET', id: 7 })}#2`]);
  });
});
