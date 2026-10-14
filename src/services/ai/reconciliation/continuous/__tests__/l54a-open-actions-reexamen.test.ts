/**
 * Lot 54A — réexamen réel des « À traiter » ouverts : règles pures
 * (Candidate Builder élément LINK-ELT, mode d'évaluation, contrat de
 * périmètre « passage global du compte »).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildElementCandidates, decideElementDeterministic } from '../document-element-link';
import { classifyEvaluation, EVALUATION_MODES } from '../open-actions.service';

const eq = (id: number, name: string, over: Record<string, unknown> = {}) => ({
  id, name, type: null, category: null, brand: null, model: null, serialNumber: null, room: null, ...over,
});

describe('T3-OPEN-E02 — Candidate Builder élément (LINK-ELT)', () => {
  it('n° de série lu dans les données persistées → candidat unique, appliqué', () => {
    const c = buildElementCandidates(
      { title: 'Facture', supplier: null, description: null, texts: ['N° série : PAC 778899'] },
      [eq(1, 'Chaudière'), eq(2, 'Pompe à chaleur', { serialNumber: 'PAC-778899' })],
    );
    expect(decideElementDeterministic(c)).toMatchObject({ equipmentId: 2, method: 'SERIAL_NUMBER' });
  });
  it('nom dans le titre → appliqué ; deux candidats forts → aucun choix déterministe (arbitrage)', () => {
    const un = buildElementCandidates({ title: 'Entretien Vitodens 200', supplier: null, description: null, texts: [] }, [eq(1, 'Vitodens 200'), eq(2, 'Radiateur')]);
    expect(decideElementDeterministic(un)?.equipmentId).toBe(1);
    const deux = buildElementCandidates({ title: 'Radiateur salon et radiateur chambre', supplier: null, description: null, texts: [] },
      [eq(1, 'Radiateur salon'), eq(2, 'Radiateur chambre')]);
    expect(deux.filter((x) => x.score >= 0.7)).toHaveLength(2);
    expect(decideElementDeterministic(deux)).toBeNull();
  });
  it('aucune correspondance → aucun candidat (la carte reste ouverte)', () => {
    expect(buildElementCandidates({ title: 'Assurance habitation', supplier: null, description: null, texts: [] }, [eq(1, 'Tondeuse')])).toEqual([]);
  });
});

describe('T3-OPEN-E04 — examined ≠ resolutionAttempted', () => {
  it('modes définis ; un constat n’est jamais une résolution', () => {
    expect(EVALUATION_MODES).toEqual(['FULL_REEVALUATION', 'DETERMINISTIC_REEVALUATION', 'AI_REEVALUATION', 'OBSOLESCENCE_ONLY', 'NOT_T3', 'SUPERSEDED', 'ERROR']);
    const base = { actionId: 1, ruleCode: 'X', targetType: 'ASSET', targetId: 1, previousResolution: null, resolver: 'T3_ASSET', candidateCount: null, deterministicAttempted: false, aiCalled: false, newResolution: null };
    expect(classifyEvaluation({ ...base, actionEffect: 'STILL_OPEN' })).toEqual({ evaluationMode: 'OBSOLESCENCE_ONLY', resolutionAttempted: false });
    expect(classifyEvaluation({ ...base, actionEffect: 'SKIPPED_NOT_T3' })).toEqual({ evaluationMode: 'NOT_T3', resolutionAttempted: false });
    expect(classifyEvaluation({ ...base, actionEffect: 'STILL_OPEN', aiCalled: true })).toEqual({ evaluationMode: 'AI_REEVALUATION', resolutionAttempted: true });
  });
});

describe('T3-OPEN-E05 — contrat : seul le passage GLOBAL du compte réexamine tous les « À traiter »', () => {
  it('la phase n’est appelée que par reconcileAccount (aucun sous-job spécialisé)', () => {
    const racine = join(process.cwd(), 'src/services/ai/reconciliation');
    const compte = readFileSync(join(racine, 'account-reconciliation.service.ts'), 'utf-8');
    expect(compte).toMatch(/reconcileOpenToProcessActions\(accountId/);
    for (const f of ['t3-queue.ts', 'document-asset/queue.ts', 'entity-reconciliation.ts']) {
      expect(readFileSync(join(racine, f), 'utf-8'), f).not.toMatch(/reconcileOpenToProcessActions\(/);
    }
  });
});
