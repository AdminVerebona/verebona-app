/**
 * CDC 15 §25 (LINK_AMBIGUITY), T3-07, P-T3-02 — départage des liens par le
 * master T3 : candidats en ordre neutre, relation par section (monde fermé),
 * marge minimale et abstention explicite ; master seul depuis le lot 16b-3.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const traces: Array<Record<string, unknown>> = [];
vi.mock('../../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../../telemetry/ai-trace.service')>()),
  recordCallTrace: async (t: Record<string, unknown>) => { traces.push(t); },
}));

const { reconcileLinks, retainAbove, LINK_SCORE_THRESHOLDS, LINK_MIN_MARGIN } = await import('../../link-reconciler');
const { parseCandidates, decideLinks } = await import('../link-ambiguity');
const { FakeProvider, setAiProvider } = await import('../../../gateway/providers');
const { __setConfigForTests } = await import('../../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../../config/config-types');

const FIXTURE = JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', 'p-t3-02-deux-candidats-equivalents.json'), 'utf8'));

let fake: InstanceType<typeof FakeProvider>;
const T3 = (arch: 'master' = 'master') => __setConfigForTests({
  versionId: 32, entries: [{ ...emptyTreatmentConfig('T3'), primaryModel: 'm-a', promptArchitecture: arch }],
});
const match = (candidateId: number, score: number) => ({ candidateId, score, confidence: 'probable' as const, reason: 'signal' });

beforeEach(() => { traces.length = 0; fake = new FakeProvider(); setAiProvider(fake); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => __setConfigForTests(null));

describe('règles déterministes T3-07', () => {
  it('marge par défaut documentée : 0,15', () => {
    expect(LINK_MIN_MARGIN).toBe(0.15);
  });

  it('relation exclusive : marge suffisante → lien ; insuffisante ou égalité → abstention', () => {
    expect(decideLinks([match(1, 0.9), match(2, 0.6)], { exclusive: true }).retained.map((m) => m.candidateId)).toEqual([1, 2]);
    expect(decideLinks([match(1, 0.8), match(2, 0.65)], { exclusive: true }).ambiguity).toBeNull();
    expect(decideLinks([match(1, 0.8), match(2, 0.7)], { exclusive: true })).toEqual({
      retained: [], ambiguity: {
        reasonCode: 'LINK_MARGIN_INSUFFICIENT', candidateIds: [1, 2],
        candidates: [{ candidateId: 1, score: 0.8, reason: 'signal' }, { candidateId: 2, score: 0.7, reason: 'signal' }],
      },
    });
    expect(decideLinks([match(2, 0.7), match(1, 0.7), match(3, 0.2)], { exclusive: true })).toMatchObject({
      retained: [], ambiguity: { reasonCode: 'LINK_TIE', candidateIds: [1, 2] },
    });
    expect(decideLinks([match(1, 0.9)], { exclusive: true }).retained).toHaveLength(1);
  });

  it('la marge ne se mesure qu’au-dessus du seuil : un second candidat sous le seuil ne bloque jamais le premier', () => {
    // 0,55 / 0,45 : écart 0,10 < 0,15, mais 0,45 < seuil 0,5 ⇒ aucun rival.
    expect(decideLinks([match(1, 0.55), match(2, 0.45)], { exclusive: true, threshold: 0.5 })).toEqual({
      retained: [match(1, 0.55), match(2, 0.45)], ambiguity: null,
    });
    // Sans seuil, le même couple serait ambigu.
    expect(decideLinks([match(1, 0.55), match(2, 0.45)], { exclusive: true }).ambiguity).not.toBeNull();
    // Trois candidats : seuls les deux au-dessus du seuil comptent.
    expect(decideLinks([match(1, 0.9), match(2, 0.8), match(3, 0.3)], { exclusive: true, threshold: 0.5 }).ambiguity)
      .toMatchObject({ reasonCode: 'LINK_MARGIN_INSUFFICIENT', candidateIds: [1, 2] });
  });

  it('relation non exclusive : tous les candidats justifiés sont conservés', () => {
    expect(decideLinks([match(1, 0.8), match(2, 0.8)], { exclusive: false }).retained).toHaveLength(2);
  });

  it('candidats lus depuis les listes historiques, ordre neutre (tri par identifiant), doublons retirés', () => {
    expect(parseCandidates('[id:12] "B"\n[id:3] "A" | type:x\nligne libre\n[id:12] "B bis"')).toEqual([
      { candidateId: 3, description: '"A" | type:x' }, { candidateId: 12, description: '"B"' },
    ]);
    expect(parseCandidates('(sans objet)')).toEqual([]);
  });
});

describe('P-T3-02 — deux candidats équivalents : aucune liaison automatique', () => {
  it('master : abstention explicite, rien au-dessus du seuil pour l’appelant', async () => {
    T3('master');
    fake.onAny(() => ({ rawText: JSON.stringify(FIXTURE.recording.output), inputTokens: 1, outputTokens: 1 }));
    const r = await reconcileLinks({ accountId: 1, variables: FIXTURE.context.variables, sourceIds: [40] });

    expect(r.matches).toEqual(FIXTURE.expected.matches);
    expect(retainAbove(r.matches, LINK_SCORE_THRESHOLDS.documentToEquipment)).toEqual([]);
    expect(r.ambiguities).toEqual([{
      section: 'matches', reasonCode: 'LINK_MARGIN_INSUFFICIENT', candidateIds: FIXTURE.expected.ambiguity.candidateIds,
      candidates: [
        { candidateId: 9, score: 0.74, reason: 'type chaudière commun' },
        { candidateId: 12, score: 0.7, reason: 'type chaudière commun' },
      ],
    }]);

    // Une seule section non vide ⇒ un seul appel, candidats triés par identifiant.
    expect(fake.calls).toHaveLength(1);
    const prompt = fake.calls[0].prompt;
    expect(prompt).toContain('TASK = LINK_AMBIGUITY');
    expect(prompt.indexOf('"candidateId":9')).toBeLessThan(prompt.indexOf('"candidateId":12'));
    expect(prompt).toContain('DOCUMENT_EQUIPMENT');
    expect(traces[0]).toMatchObject({ operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', masterPromptCode: 't3_master_v1' });
  });

  it('sans version de configuration : master quand même (lot 16b-3), jamais reconcile_links', async () => {
    fake.onAny(() => ({ rawText: JSON.stringify({ task: 'LINK_AMBIGUITY', matches: [match(9, 0.74), match(12, 0.7)] }), inputTokens: 1, outputTokens: 1 }));
    await reconcileLinks({ accountId: 1, variables: FIXTURE.context.variables });
    expect(traces[0]).toMatchObject({ operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY' });
  });
});

describe('seuil d’application dans le chemin master', () => {
  it('document → équipement : 0,6 / 0,48 (sous le seuil 0,5) ⇒ lien au premier', async () => {
    T3('master');
    fake.onAny(() => ({ rawText: JSON.stringify({ task: 'LINK_AMBIGUITY', matches: [match(12, 0.6), match(9, 0.48)] }), inputTokens: 1, outputTokens: 1 }));
    const r = await reconcileLinks({ accountId: 1, variables: FIXTURE.context.variables });
    expect(r.ambiguities).toEqual([]);
    expect(retainAbove(r.matches, LINK_SCORE_THRESHOLDS.documentToEquipment).map((m) => m.id)).toEqual([12]);
  });
});

describe('master : sections et monde fermé', () => {
  const variables = {
    SUBJECT_CONTEXT: 'Équipement "Chaudière"',
    DOCUMENTS_LIST: '[id:5] "Facture A"\n[id:6] "Facture B"',
    AGENDA_LIST: 'Aucun événement agenda disponible.',
    SUPPLIERS_LIST: '[id:5] "Chauffage Martin"',
    EQUIPMENTS_LIST: '(sans objet)',
  };

  it('un appel par relation ; identifiants jamais mélangés ; non exclusif conservé', async () => {
    T3('master');
    fake.onAny((input) => {
      const docs = input.prompt.includes('EQUIPMENT_DOCUMENT');
      return {
        rawText: JSON.stringify({
          task: 'LINK_AMBIGUITY',
          matches: docs ? [match(5, 0.8), match(6, 0.78)] : [match(5, 0.9)],
        }),
        inputTokens: 1, outputTokens: 1,
      };
    });
    const r = await reconcileLinks({ accountId: 1, variables });
    expect(fake.calls).toHaveLength(2);
    expect(r.documents.map((m) => m.id)).toEqual([5, 6]);
    expect(r.suppliers).toEqual([{ id: 5, score: 0.9, reason: 'signal' }]);
    expect(r.ambiguities).toEqual([]);
  });

  it('identifiant hors liste : abstention de la section, avertissement', async () => {
    T3('master');
    fake.onAny(() => ({ rawText: JSON.stringify({ task: 'LINK_AMBIGUITY', matches: [match(77, 0.95)] }), inputTokens: 1, outputTokens: 1 }));
    const r = await reconcileLinks({ accountId: 1, variables: { ...variables, SUPPLIERS_LIST: '(sans objet)', DOCUMENTS_LIST: '[id:5] "Facture A"' } });
    expect(r.documents).toEqual([]);
    expect(r.ambiguities).toEqual([{ section: 'documents', reasonCode: 'CLOSED_WORLD_VIOLATION', candidateIds: [5] }]);
  });

  it('panne fournisseur : résultat vide, jamais d’exception (déterministe seul)', async () => {
    T3('master');
    fake.onAny(() => { throw new Error('503'); });
    const r = await reconcileLinks({ accountId: 1, variables });
    expect(r).toMatchObject({ documents: [], suppliers: [], matches: [], agendaItems: [] });
  });
});
