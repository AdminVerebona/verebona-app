/**
 * Lot 111U, deuxième passe — coefficient U (L111U-U-U), contexte B2 depuis un
 * fait explicite (L111U-U-B2), travaux B7 réalisés prouvés (L111U-U-B7).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: vi.fn() } }));

const { recognizeCilFact, recognizeCilContextFact } = await import('@/lib/cil/cil-fact-vocabulary');
const { evaluateCilState } = await import('@/services/cil/state/evaluate');
const { readinessFromCilInput } = await import('@/services/exports/cil-preparation.service');
import type { CilFactInput } from '@/lib/cil/cil-fact-vocabulary';
import type { CilStateInput } from '@/services/cil/state/evaluate';

const fact = (o: Partial<CilFactInput>): CilFactInput => ({
  id: 1, fileId: 10, factKey: 'k', subject: null, attribute: null, label: null, valueText: null, valueNumber: null, valueUnit: null,
  normalizedValue: null, confidence: 'certain', targetType: 'ASSET', targetEntityId: null, semanticEventNature: null, ...o,
});
const base = (o: Partial<CilStateInput> = {}): CilStateInput => ({
  asset: { id: 1, address: '1 rue A', postalCode: '69001', city: 'Lyon', subtype: 'Maison' },
  fields: {}, fieldSources: {}, profile: null, resolutions: [], documents: [], materials: [], equipments: [], works: [], journal: [],
  now: '2026-11-05T10:00:00Z', ...o,
});
const doc = (id: number, title: string, code: string, date = '2025-06-01') => ({ id, title, date, documentType: null, documentTypeCode: code, retainedFunctionCode: null, cilRubricCodes: null, planState: null });
const itemOf = (s: ReturnType<typeof evaluateCilState>, id: string) => s.blocks.flatMap((b) => b.items).find((i) => i.id === id)!;

describe('L111U-U-U — coefficient U', () => {
  it('reconnu (Uw, coefficient U) ; jamais converti en R', () => {
    expect(recognizeCilFact(fact({ subject: 'Fenêtres', attribute: 'Uw', valueNumber: 1.4, valueUnit: 'W/m2.K' }))).toEqual({ kind: 'material', post: 'parois_vitrees', attribute: 'uValue', value: 1.4 });
    expect(recognizeCilFact(fact({ subject: 'Murs', attribute: 'Coefficient U', valueNumber: 0.36 }))).toMatchObject({ attribute: 'uValue', value: 0.36 });
  });
  it('compte comme performance ; affiché avec son unité', () => {
    const s = evaluateCilState(base({ materials: [{ id: 1, category: 'parois_vitrees', materialNature: 'Double vitrage', brand: null, reference: null, thermalResistanceR: null, lambda: null, thicknessMm: null, surfaceSqm: null, uValue: 1.4, origin: 'USER', installationState: null, sourceFileId: null, documentId: null }] }));
    const it = itemOf(s, 'B5.parois_vitrees');
    expect(it.status).toBe('renseigne');
    expect(it.values[0].value).toContain('U = 1,4 W/(m²·K)');
    expect(it.values[0].value).not.toContain('R =');
  });
});

describe('L111U-U-B2 — contexte de constitution établi par un document', () => {
  it('faits explicites seulement', () => {
    expect(recognizeCilContextFact(fact({ subject: 'Carnet d’information du logement', attribute: 'Motif', valueText: 'Rénovation énergétique' }))).toEqual({ kind: 'trigger', value: 'renovation_energetique' });
    expect(recognizeCilContextFact(fact({ subject: 'Carnet d’information du logement', attribute: 'Date de constitution', normalizedValue: '2025-09-01' }))).toEqual({ kind: 'triggerDate', value: '2025-09-01' });
    expect(recognizeCilContextFact(fact({ subject: 'Permis de construire', attribute: 'Nature des travaux', valueText: 'Construction d’une maison individuelle' }))).toEqual({ kind: 'trigger', value: 'construction' });
    // Un permis pour une extension établit l'autorisation, pas le motif.
    expect(recognizeCilContextFact(fact({ subject: 'Permis de construire', attribute: 'Nature des travaux', valueText: 'Extension de 20 m²' }))).toEqual({ kind: 'authorization', value: 'permis_de_construire' });
    // Un permis ne date jamais la constitution du carnet ; « permis de conduire », « carnet d'entretien » : hors sujet.
    expect(recognizeCilContextFact(fact({ subject: 'Permis de construire', attribute: 'Date de constitution', normalizedValue: '2024-01-01' }))).toEqual({ kind: 'authorization', value: 'permis_de_construire' });
    expect(recognizeCilContextFact(fact({ subject: 'Permis de conduire', attribute: 'Numéro', valueText: '123' }))).toBeNull();
    expect(recognizeCilContextFact(fact({ subject: 'Carnet d’entretien', attribute: 'Motif', valueText: 'Construction' }))).toBeNull();
    // Un projet / une recommandation n'établit rien.
    expect(recognizeCilContextFact(fact({ subject: 'Carnet d’information du logement', attribute: 'Motif', label: 'Projet', valueText: 'Rénovation énergétique' }))).toBeNull();
  });
  it('profil DOCUMENT : source ouvrable ; sans date : partiel ; conflit : à confirmer', () => {
    const s = evaluateCilState(base({ documents: [doc(30, 'Permis', 'BUILDING_PERMIT')], profile: { triggerType: 'construction', triggerDate: null, origin: 'DOCUMENT', sourceFileId: 30 } }));
    expect(itemOf(s, 'B2.trigger')).toMatchObject({ status: 'partiel', missing: ['Date de constitution'], values: [{ source: { kind: 'document', fileId: 30 } }] });
    const c = evaluateCilState(base({ journal: [{ projectionKey: 'cil:profile', status: 'CONFLICT', reason: 'DOCUMENTS_DIFFER', sourceFileIds: [30, 31], targetId: null }] }));
    expect(itemOf(c, 'B2.trigger').status).toBe('a_confirmer');
  });
});

describe('L111U-U-B7 — travaux réalisés prouvés', () => {
  const facture = doc(40, 'Facture isolation combles', 'WORKS_INVOICE', '2024-10-02');
  it('Opération réalisée prouvée : renseigné, source = facture ; préparation B7 complète', () => {
    const input = base({
      documents: [facture],
      opWorks: [{ operationId: 7, title: null, provider: 'Iso Plus', realizedDate: '2024-10-02', categories: ['isolation_toiture'], fileIds: [40] }],
    });
    const s = evaluateCilState(input);
    expect(itemOf(s, 'B7.works')).toMatchObject({ status: 'renseigne', values: [{ label: 'Travaux : isolation de la toiture', source: { kind: 'document', fileId: 40 } }] });
    expect(s.works).toEqual([expect.objectContaining({ kind: 'operation', id: 7, company: 'Iso Plus', date: '2024-10-02' })]);
    expect(readinessFromCilInput(input).blocks.find((b) => b.id === 'B7')!.status).toBe('complete');
  });
  it('devis / projet / sans facture : jamais réalisé, signalé', () => {
    const s = evaluateCilState(base({
      journal: [{ projectionKey: 'cil:work:8', status: 'ABSTAINED', reason: 'NOT_REALIZED', sourceFileIds: [41], targetId: 8 }],
    }));
    expect(itemOf(s, 'B7.works')).toMatchObject({ status: 'a_confirmer', values: [] });
    expect(itemOf(s, 'B7.works').reason).toMatch(/envisagée.*non comptée/);
    expect(s.works).toEqual([]);
  });
  it('date de réalisation inconnue : partiel', () => {
    const s = evaluateCilState(base({ opWorks: [{ operationId: 9, title: 'Remplacement chaudière', provider: null, realizedDate: null, categories: ['chauffage'], fileIds: [] }] }));
    expect(itemOf(s, 'B7.works')).toMatchObject({ status: 'partiel', missing: ['Date de réalisation : Remplacement chaudière'] });
  });
});
