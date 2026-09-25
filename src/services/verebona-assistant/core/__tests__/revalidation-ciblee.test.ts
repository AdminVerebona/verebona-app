/**
 * Revalidation ciblée par T2 et réinjection des faits améliorés.
 *
 * données T1 → contrôle de suffisance → revalidation ciblée → réponse →
 * réinjection (provenance REVALIDATION_T2) → signal de lacune T1.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  confirmFromPersistedText, windowAround, excerptIsGrounded, comparable, gapProblem, RevalidationOutput,
  type FactToCheck,
} from '../revalidation.service';
import { answerFromData, type AccountDataPort, type FactHit } from '../data-answer.service';
import { DEFAULT_THRESHOLDS } from '../sufficiency';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const fact = (over: Partial<FactToCheck> = {}): FactToCheck => ({
  id: 1, accountId: 1, fileId: 10, extractionId: 5, factKey: 'chaudiere.puissance', subject: 'Chaudière', attribute: 'puissance',
  label: null, valueText: '24', valueNumber: 24, valueUnit: 'kW', confidence: 'conflictual',
  excerpt: 'Puissance nominale : 24 kW', location: { page: 3 },
  fullText: 'FACTURE. Chaudière gaz. Puissance nominale : 24 kW. Installée le 12/03/2026.',
  extractionVersion: 'v1', t1Model: 'm', t1PromptVersion: 'extract_source_v2', analysisRunId: null, assetId: 42,
  ...over,
});

describe('niveau 1 — contenu persisté, sans modèle', () => {
  it('extrait présent dans le texte et portant la valeur : confirmé', () => {
    expect(confirmFromPersistedText(fact())).toBe(true);
  });
  it('extrait absent du texte, ou valeur absente de l’extrait : non confirmé', () => {
    expect(confirmFromPersistedText(fact({ excerpt: 'puissance 28kW' }))).toBe(false);
    expect(confirmFromPersistedText(fact({ valueText: '28', valueNumber: 28 }))).toBe(false);
    expect(confirmFromPersistedText(fact({ fullText: null }))).toBe(false);
  });
});

describe('niveau 2 — modèle sur une FENÊTRE du contenu persisté', () => {
  it('jamais tout le document', () => {
    const long = `${'x '.repeat(10_000)}Puissance nominale : 24 kW${' y'.repeat(10_000)}`;
    const w = windowAround(fact({ fullText: long }), 6000);
    expect(w.length).toBeLessThanOrEqual(6000);
    expect(w).toContain('Puissance nominale : 24 kW');
  });
  it('un extrait rendu par le modèle doit exister dans le texte (anti-invention)', () => {
    expect(excerptIsGrounded('Puissance nominale : 24 kW', fact().fullText)).toBe(true);
    expect(excerptIsGrounded('Puissance : 30 kW', fact().fullText)).toBe(false);
  });
  it('schéma de sortie strict', () => {
    expect(RevalidationOutput.parse({ status: 'confirmed', value: 24, excerpt: 'x' }).value).toBe('24');
    expect(() => RevalidationOutput.parse({ status: 'maybe' })).toThrow();
  });
});

describe('comparaison et signal de lacune', () => {
  it('« 24 kW » ≡ 24 + kW', () => {
    expect(comparable('24 kW', null)).toBe(comparable('24', 'kW'));
    expect(comparable('28', 'kW')).not.toBe(comparable('24', 'kW'));
  });
  it('problème T1 selon le déclencheur et le résultat', () => {
    expect(gapProblem('LOW_CONFIDENCE', 'CONFIRMED')).toBe('LOW_CONFIDENCE');
    expect(gapProblem('LOW_CONFIDENCE', 'CORRECTED')).toBe('POORLY_STRUCTURED');
    expect(gapProblem('CONFLICT', 'CONFIRMED')).toBe('CONFLICT');
    expect(gapProblem('LOW_CONFIDENCE', 'NOT_FOUND')).toBe('MISSING');
  });
});

describe('déclenchement depuis la cascade', () => {
  const hit = (id: number, v: string, conf: string): FactHit => ({
    id, fileId: 10, factKey: 'chaudiere.puissance', subject: 'Chaudière', attribute: 'puissance', label: null,
    valueText: v, valueNumber: Number(v), valueUnit: 'kW', confidence: conf, excerpt: 'e', documentTitle: 'Facture', matchedTerms: 2,
  });
  const port = (facts: FactHit[]): AccountDataPort => ({
    today: () => '2026-09-25', findAssets: async () => [], listAssets: async () => [], countDocuments: async () => 0,
    countAgenda: async () => 0, upcomingAgenda: async () => [], sumDocumentAmounts: async () => ({ sumCents: 0, count: 0 }),
    searchFacts: async () => facts, searchDocuments: async () => [],
  });

  it('confiance insuffisante → revalidation demandée, pas de réponse', async () => {
    const r = await answerFromData({ port: port([hit(1, '24', 'conflictual')]), accountId: 1, message: 'Quelle est la puissance de la chaudière ?', thresholds: DEFAULT_THRESHOLDS });
    expect(r.handled).toBe(false);
    expect(r.revalidation).toEqual({ trigger: 'LOW_CONFIDENCE', factIds: [1] });
  });

  it('conflit → réponse explicite ET revalidation possible des faits en cause', async () => {
    const r = await answerFromData({ port: port([hit(1, '24', 'probable'), hit(2, '28', 'probable')]), accountId: 1, message: 'Quelle est la puissance de la chaudière ?', thresholds: DEFAULT_THRESHOLDS });
    expect(r.handled).toBe(true);
    expect(r.revalidation).toEqual({ trigger: 'CONFLICT', factIds: [1, 2] });
  });

  it('fait suffisant : aucune revalidation', async () => {
    const r = await answerFromData({ port: port([hit(1, '24', 'certain')]), accountId: 1, message: 'Quelle est la puissance de la chaudière ?', thresholds: DEFAULT_THRESHOLDS });
    expect(r.revalidation).toBeUndefined();
  });
});

describe('câblage et garanties', () => {
  const S = read('src/services/verebona-assistant/core/revalidation.service.ts');
  const O = read('src/services/verebona-assistant/core/assistant-orchestrator.service.ts');
  const P = read('src/services/verebona-assistant/core/ports.ts');

  it('jamais d’analyse T1 complète', () => {
    expect(S).not.toMatch(/analyzeFileSources|runSourceAnalysis|enqueue/);
  });
  it('provenance REVALIDATION_T2 et trace complète', () => {
    expect(S).toMatch(/'active','REVALIDATION_T2'/);
    expect(S).toMatch(/INSERT INTO verebona_fact_revalidations/);
    expect(S).toMatch(/INSERT INTO t1_quality_signals/);
  });
  it('réinjection par les règles communes (projection + T3), jamais d’écriture directe sur le bien', () => {
    expect(S).toMatch(/projectDocumentKnowledgeToAsset/);
    expect(S).not.toMatch(/UPDATE assets|INSERT INTO field_evidence/);
  });
  it('déduplication tant que la source et le fait n’ont pas changé', () => {
    expect(S).toMatch(/WHERE fact_id = \$1 AND extraction_version = \$2/);
  });
  it('coût imputé à T2 (usage assistant), appels modèle soumis au même drapeau que la génération', () => {
    expect(S).toMatch(/useCaseCode: 'INTELLIGENT_ASSISTANT',\s+operationCode: 'revalidate_fact'/);
    expect(P).toMatch(/allowModel: isUseCaseRunning\('INTELLIGENT_ASSISTANT'\) && isPlanAiEligible/);
    expect(read('src/services/ai/registry/operations.ts')).toMatch(/promptCode: 'revalidate_fact_v1'/);
  });
  it('la cascade est rejouée UNE fois sur la connaissance mise à jour', () => {
    expect(O).toMatch(/!input\.revalidationDone/);
    expect(O).toMatch(/input = \{ \.\.\.input, revalidationDone: true \}/);
  });
});
