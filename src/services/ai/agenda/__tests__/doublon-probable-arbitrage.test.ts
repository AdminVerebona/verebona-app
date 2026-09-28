/**
 * T4 — un rapprochement PROBABLE d'échéances n'est jamais fusionné : il est
 * soumis à arbitrage (« même échéance » / « échéances différentes »).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('../../gateway/ai-gateway', () => ({ AiGateway: { execute: vi.fn(async () => { throw new Error('pas de modèle'); }) } }));
import { processAgendaCandidates } from '../agenda-intelligence.service';
import { findDuplicate } from '../dedupe.service';
import type { ExistingAgendaItem } from '../types';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const existant = (over: Partial<ExistingAgendaItem> = {}): ExistingAgendaItem => ({
  id: 7, title: 'Contrôle technique', date: '2026-11-15', category: 'action', status: null, manual: false, originFieldKey: null, ...over,
});
const traiter = (title: string, date: string, existing: ExistingAgendaItem[]) =>
  processAgendaCandidates({ accountId: 1, assetId: 2, candidates: [{ title, date, confidence: 'certain', excerpt: '' } as never], existing, sourceFileId: 9 });

describe('findDuplicate', () => {
  it('« Contrôle technique » 15/11 / « Contrôle technique véhicule » 17/11 : probable', () => {
    const d = findDuplicate({ title: 'Contrôle technique véhicule', date: '2026-11-17' }, [existant()]);
    expect(d.kind).toBe('probable');
    expect(d.dayGap).toBe(2);
    expect(d.similarity).toBeGreaterThanOrEqual(0.82);
  });
});

describe('décision T4', () => {
  it('événement AUTOMATIQUE : arbitrage, plus de fusion silencieuse', async () => {
    const [d] = await traiter('Contrôle technique véhicule', '2026-11-17', [existant()]);
    expect(d.action).toBe('arbitrate_duplicate');
    expect(d.action).not.toBe('update');
    expect(d.existingItemId).toBe(7);
    expect(d.duplicate).toMatchObject({ dayGap: 2, existingTitle: 'Contrôle technique', existingDate: '2026-11-15', existingManual: false });
  });

  it('événement MANUEL : même principe', async () => {
    const [d] = await traiter('Contrôle technique véhicule', '2026-11-17', [existant({ manual: true })]);
    expect(d.action).toBe('arbitrate_duplicate');
    expect(d.reasonCode).toBe('PROBABLE_DUPLICATE_MANUAL_EVENT');
  });

  it('doublon exact : ignoré ; aucun rapprochement : création', async () => {
    expect((await traiter('Contrôle technique', '2026-11-15', [existant()]))[0].action).toBe('skip_duplicate');
    expect(['create', 'propose']).toContain((await traiter('Assurance habitation', '2027-03-01', [existant()]))[0].action);
  });
});

describe('persistance et arbitrage', () => {
  const P = read('src/services/agenda/agenda-persistence.ts');
  const R = read('src/services/to-process/resolve-action.service.ts');

  it('le rapprochement probable devient une action « À arbitrer » de la file commune', () => {
    expect(P).toMatch(/case 'arbitrate_duplicate':\s+await createDuplicateArbitration/);
    expect(P).toMatch(/ruleCode: 'AGENDA-DUPLICATE'/);
    expect(read('src/services/to-process/rules-catalog.ts')).toMatch(/code: 'AGENDA-DUPLICATE'/);
  });

  it('une mise à jour issue d’un rapprochement probable est refusée à la persistance', () => {
    expect(P).toMatch(/mise à jour refusée pour un rapprochement probable/);
  });

  it('déduplication par couple et décision conservée', () => {
    expect(P).toMatch(/resolution_reason = 'USER_ARBITRATED'/);
    expect(P).toMatch(/relationKey = duplicatePairKey\(decision\)/);
  });

  it('choix SAME / DIFFERENT appliqués seulement à l’arbitrage, valeurs utilisateur protégées', () => {
    expect(R).toMatch(/if \(action\.ruleCode === 'AGENDA-DUPLICATE'\)/);
    expect(R).toMatch(/const automatiqueIntact = existing\.isAutomatic && !existing\.isAutomaticModified/);
    expect(R).toMatch(/reason: 'USER_VALUES_PROTECTED'/);
    expect(R).toMatch(/consolidation = \{ createdItemId: created\.id \}/);
  });
});
