/**
 * Sortie du modèle : réparation, escalade, filtrage et limites — CDC §15.4,
 * §15.5, §18.6, §18.7, §13.9, §30.1, CA-07, CA-09, 37.12.
 *
 * Appels comptés au niveau du FOURNISSEUR (faux provider de `src/test/setup.ts`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeProvider } from '@/test/setup';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => { throw new Error('aucune base en test'); }) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { createAiCallBudget } = await import('../ai-call-budget');
const { generateAssistantAnswerDetailed, toGeneratedAnswer } = await import('../generation.adapter');
const { classifyModelFailure } = await import('../model-call-policy');
const { sanitizeModelText, containsUrlOrMarkup } = await import('../output-safety');
const { fitToInputBudget } = await import('../context-budget');
const { runAssistant } = await import('../assistant-orchestrator.service');
const { AiGatewayError } = await import('@/services/ai/gateway/errors');
type Input = import('../../types/contracts').AssistantRequestInput;
type Source = import('../../types/sources').RetrievedSource;
type Route = import('../../types/contracts').IntentRoute;
type Ports = import('../assistant-orchestrator.service').OrchestratorPorts;

const SOURCES: Source[] = [
  { id: 'doc_1', type: 'document', title: 'Garantie vélo', content: 'Garantie 2 ans à compter du 12/03/2024.', relevanceScore: 0.9 },
  { id: 'doc_2', type: 'document', title: 'Facture vélo', content: 'Facture du 12/03/2024, 1 290 €.', relevanceScore: 0.8 },
];

const ROUTE = (intent = 'ACCOUNT_SUMMARY'): Route => ({
  intent: intent as Route['intent'], confidence: 'exact', accountScope: 'server-enforced', entityHints: [],
  requiresRetrieval: true, aiEligible: true, clarificationRequired: false, allowedActionTypes: [], routeReason: 'test',
});

const input = (over: Partial<Input> = {}): Input => ({
  accountId: 7, userId: 3, planType: 'PREMIUM', message: 'Résume les garanties de mon vélo',
  clientRequestId: `c-${Math.random()}`, locale: 'fr-FR', aiBudget: createAiCallBudget(2),
  aiReport: { securityEvents: [], events: [] }, ...over,
});

// Branche ANSWER du master T2 (seul moteur depuis le lot 16b-2).
const ENV = { mode: 'ANSWER', format: 'claims', status: 'answered' };
const OK = JSON.stringify({ ...ENV, claims: [{ text: 'La garantie du vélo court 2 ans à compter du 12/03/2024.', sourceIds: ['doc_1'], factual: true }] });
const ok = () => ({ rawText: OK, inputTokens: 10, outputTokens: 5 });

beforeEach(() => {
  delete process.env.VEREBONA_ASSISTANT_AI_FALLBACK_ENABLED;
  delete process.env.VEREBONA_ASSISTANT_FALLBACK_MODEL;
});

describe('réparation (§18.6) et escalade (§15.4)', () => {
  it('sortie hors schéma → UNE réparation, même modèle, avec les erreurs et sans nouvelle donnée', async () => {
    let n = 0;
    fakeProvider.onAny(() => {
      n += 1;
      // Lot 33D : un nombre serait converti en texte (normalisation déterministe) ;
      // un objet ne l'est jamais — la réparation §18.6 reste exercée.
      return n === 1 ? { rawText: JSON.stringify({ ...ENV, claims: [{ text: { valeur: 42 } }] }), inputTokens: 5, outputTokens: 5 } : ok();
    });
    const inp = input();
    const r = await generateAssistantAnswerDetailed(ROUTE(), SOURCES, inp);
    expect('failed' in r).toBe(false);
    expect(fakeProvider.calls).toHaveLength(2);
    expect(fakeProvider.calls[1].model).toBe(fakeProvider.calls[0].model);
    expect(fakeProvider.calls[1].prompt).toMatch(/CORRECTION DEMANDÉE/);
    expect(fakeProvider.calls[1].prompt).toMatch(/claims\.0\.text/);
    // Aucune nouvelle donnée : mêmes sources dans les deux prompts.
    const data = (p: string) => p.match(/"sourceId": "[^"]*"/g);
    expect(data(fakeProvider.calls[1].prompt)).toEqual(data(fakeProvider.calls[0].prompt));
    expect(data(fakeProvider.calls[0].prompt)!.length).toBeGreaterThanOrEqual(2);
    expect((r as { generationEvents: string[] }).generationEvents).toContain('REPAIR:INVALID_OUTPUT');
    expect(inp.aiBudget!.used).toBe(2);
  });

  it('réparation en échec → repli, jamais de 3e appel', async () => {
    fakeProvider.onAny(() => ({ rawText: 'pas du JSON du tout', inputTokens: 5, outputTokens: 5 }));
    const r = await generateAssistantAnswerDetailed(ROUTE(), SOURCES, input());
    expect('failed' in r).toBe(true);
    expect(fakeProvider.calls).toHaveLength(2);
  });

  it('sortie vide → escalade vers le modèle de repli SEUL', async () => {
    let n = 0;
    fakeProvider.onAny(() => { n += 1; return n === 1 ? { rawText: '', inputTokens: 5, outputTokens: 0 } : ok(); });
    const r = await generateAssistantAnswerDetailed(ROUTE(), SOURCES, input());
    expect('failed' in r).toBe(false);
    expect(fakeProvider.calls).toHaveLength(2);
    expect(fakeProvider.calls[1].model).not.toBe(fakeProvider.calls[0].model);
    expect((r as { generationEvents: string[] }).generationEvents).toContain('ESCALATION:EMPTY_OUTPUT');
  });

  it('panne fournisseur ou timeout → aucune escalade (hors §15.4)', async () => {
    fakeProvider.onAny(() => { throw new Error('503 indisponible'); });
    const r = await generateAssistantAnswerDetailed(ROUTE(), SOURCES, input());
    expect('failed' in r).toBe(true);
    expect(fakeProvider.calls).toHaveLength(1);
  });

  it('synthèse multi-source non produite (aucune affirmation étayée) → escalade', async () => {
    let n = 0;
    fakeProvider.onAny(() => {
      n += 1;
      return n === 1
        ? { rawText: JSON.stringify({ ...ENV, claims: [{ text: 'Garantie de 5 ans.', sourceIds: ['doc_99'] }] }), inputTokens: 5, outputTokens: 5 }
        : ok();
    });
    const r = await generateAssistantAnswerDetailed(ROUTE('ACCOUNT_SUMMARY'), SOURCES, input());
    expect('failed' in r).toBe(false);
    expect((r as { generationEvents: string[] }).generationEvents).toContain('ESCALATION:SYNTHESIS_FAILED');
    expect(fakeProvider.calls[1].model).not.toBe(fakeProvider.calls[0].model);
  });

  it('repli coupé (flag fallback_model) → pas d’escalade', async () => {
    process.env.VEREBONA_ASSISTANT_FALLBACK_MODEL = 'off';
    fakeProvider.onAny(() => ({ rawText: '', inputTokens: 5, outputTokens: 0 }));
    const r = await generateAssistantAnswerDetailed(ROUTE(), SOURCES, input());
    expect('failed' in r).toBe(true);
    expect(fakeProvider.calls).toHaveLength(1);
  });

  it('budget déjà consommé par la classification → pas de réparation', async () => {
    const b = createAiCallBudget(2); b.consume(1);
    fakeProvider.onAny(() => ({ rawText: JSON.stringify({ ...ENV, claims: [{ text: 42 }] }), inputTokens: 5, outputTokens: 5 }));
    const r = await generateAssistantAnswerDetailed(ROUTE(), SOURCES, input({ aiBudget: b }));
    expect('failed' in r).toBe(true);
    expect(fakeProvider.calls).toHaveLength(1);
  });

  it('nature d’un échec de la passerelle', () => {
    const e = (m: string) => new AiGatewayError('ALL_MODELS_FAILED', 't2_answer', m, { recoverable: true });
    expect(classifyModelFailure(e('Tous les modèles ont échoué. m : Sortie non parsable : Aucune structure JSON détectée. Extrait : ')).kind).toBe('EMPTY_OUTPUT');
    expect(classifyModelFailure(e('Tous les modèles ont échoué. m : Sortie non conforme au schéma. claims.0.text : Expected string')).errors).toEqual(['claims.0.text : Expected string']);
    expect(classifyModelFailure(e('Tous les modèles ont échoué. m : timeout after 12000ms')).kind).toBe('TIMEOUT');
    expect(classifyModelFailure(new AiGatewayError('AI_BLOCKED', 'x', 'arrêt')).kind).toBe('BLOCKED');
  });
});

describe('filtrage de la sortie (§18.7, CA-09, 37.12)', () => {
  it('URL, lien Markdown et HTML retirés du texte d’une affirmation sourcée', () => {
    const data = {
      claims: [
        { text: 'La garantie court 2 ans, voir https://evil.example/phish et [ici](http://x.fr).', sourceIds: ['doc_1'], factual: true },
        { text: 'Montant réglé : <b>1 290 €</b> <a href="http://x">lien</a>.', sourceIds: ['doc_2'], factual: true },
      ],
      actionIntents: [], derivations: [],
    };
    const events: Array<{ code: string }> = [];
    const out = toGeneratedAnswer(data as never, SOURCES, events as never)!;
    expect(out).not.toBeNull();
    expect(containsUrlOrMarkup(out.answer)).toBe(false);
    for (const c of out.claims) expect(containsUrlOrMarkup(c.text)).toBe(false);
    expect(out.answer).toContain('ici');
    expect(out.answer).toContain('1 290 €');
    expect(events.map((e) => e.code)).toEqual(expect.arrayContaining(['MODEL_URL_STRIPPED', 'MODEL_MARKUP_STRIPPED']));
  });

  it('script, JavaScript ou SQL → affirmation rejetée en entier ; action inventée tracée', () => {
    const data = {
      claims: [
        { text: 'Cliquez <script>alert(1)</script> maintenant.', sourceIds: ['doc_1'], factual: true },
        { text: 'DELETE FROM assets WHERE 1=1', sourceIds: ['doc_1'], factual: true },
        { text: 'La facture du vélo date du 12/03/2024.', sourceIds: ['doc_2'], factual: true },
      ],
      actionIntents: [{ type: 'DELETE_ACCOUNT' }], derivations: [],
    };
    const events: Array<{ code: string }> = [];
    const out = toGeneratedAnswer(data as never, SOURCES, events as never)!;
    expect(out.claims).toHaveLength(1);
    expect(out.answer).toBe('La facture du vélo date du 12/03/2024.');
    expect(out.supportLevel).toBe('partial');
    expect(events.map((e) => e.code)).toEqual(expect.arrayContaining(['MODEL_SCRIPT_REJECTED', 'MODEL_SQL_REJECTED', 'MODEL_ACTION_REJECTED']));
  });

  it('les chiffres et montants ne sont pas pris pour des domaines', () => {
    const r = sanitizeModelText('Puissance 12.5 kW, montant 1 290,50 €, M. Dupont.');
    expect(r.rejected).toBe(false);
    expect(r.events).toHaveLength(0);
    expect(r.text).toBe('Puissance 12.5 kW, montant 1 290,50 €, M. Dupont.');
  });

  it('37.12 : l’événement de sécurité est enregistré dans la trace de la demande', async () => {
    // Master T2 : aucune action proposée par le modèle (les actions viennent
    // du serveur) ; une URL dans une affirmation est retirée et tracée.
    fakeProvider.onAny(() => ({
      rawText: JSON.stringify({ ...ENV, claims: [{ text: 'La garantie court 2 ans à compter du 12/03/2024, détails sur www.evil.example.', sourceIds: ['doc_1'], factual: true }] }),
      inputTokens: 5, outputTokens: 5,
    }));
    const { generateAssistantAnswer } = await import('../generation.adapter');
    const ports: Ports = {
      retrieve: async () => SOURCES,
      resolveSources: async (s) => s.map((x) => ({ id: x.id, type: x.type, typeLabel: 'Document', title: x.title, excerpt: x.content, isAvailable: true })),
      resolveActions: async () => [],
      persist: async () => null,
      hasPendingClarification: async () => false,
      generateWithAI: generateAssistantAnswer,
    };
    const r = await runAssistant({ ...input(), aiBudget: undefined, aiReport: undefined, message: 'Résume les garanties de mon vélo' }, ports);
    expect(r.mode).toBe('ai');
    expect(containsUrlOrMarkup(r.answer)).toBe(false);
    const codes = (r.cascade?.securityEvents ?? []).map((e) => e.code);
    expect(codes).toEqual(expect.arrayContaining(['MODEL_URL_STRIPPED']));
  });
});

describe('limites avant appel (§13.9, §17.7, §30.1, §31.2)', () => {
  it('500 jetons de sortie et 12 s par tentative transmis au fournisseur', async () => {
    fakeProvider.onAny(ok);
    await generateAssistantAnswerDetailed(ROUTE(), SOURCES, input());
    expect(fakeProvider.calls[0].maxOutputTokens).toBeLessThanOrEqual(500);
    expect(fakeProvider.calls[0].timeoutMs).toBeLessThanOrEqual(12_000);
  });

  it('t2_revalidate : 12 s par tentative (l’opération en déclare 20)', async () => {
    const { z } = await import('zod');
    const { asTestContract } = await import('@/services/ai/gateway/output-resolution/runtime-contract');
    const { executeWithinBudget } = await import('../ai-call-budget');
    const { t2MasterVariables } = await import('@/services/ai/assistant/master/t2-answer');
    fakeProvider.onAny(() => ({ rawText: '{"mode":"REVALIDATE","status":"confirmed"}', inputTokens: 1, outputTokens: 1 }));
    await executeWithinBudget(createAiCallBudget(2), {
      useCaseCode: 'INTELLIGENT_ASSISTANT', operationCode: 't2_revalidate', accountId: 1,
      promptVariables: t2MasterVariables('REVALIDATE', { QUESTION: 'q' }), outputSchema: asTestContract(z.object({ mode: z.literal('REVALIDATE') }).passthrough()),
      idempotencyKey: `k-${Math.random()}`,
    });
    expect(fakeProvider.calls[0].timeoutMs).toBe(12_000);
  });

  it('12 000 jetons d’entrée : moins d’extraits, puis extraits plus courts, sinon aucun appel', () => {
    const gros = Array.from({ length: 8 }, (_, i) => ({
      id: `doc_${i}`, type: 'document' as const, title: `Doc ${i}`, content: 'x'.repeat(1500), relevanceScore: 1 - i / 10,
    }));
    const r = fitToInputBudget({ sources: gros, conversation: 'y'.repeat(2000), fixed: 'q', maxInputTokens: 5000, maxExcerptChars: 1500 });
    expect(r.ok).toBe(true);
    expect(r.sources.length).toBeLessThan(8);
    expect(r.estimatedTokens).toBeLessThanOrEqual(5000);
    // Les moins pertinentes partent d'abord.
    expect(r.sources[0].id).toBe('doc_0');
    const impossible = fitToInputBudget({ sources: gros, conversation: '', fixed: 'q'.repeat(60_000), maxInputTokens: 12_000, maxExcerptChars: 1500 });
    expect(impossible.ok).toBe(false);
  });

  it('dépassement irréductible → aucune requête au modèle', async () => {
    fakeProvider.onAny(ok);
    const r = await generateAssistantAnswerDetailed(ROUTE(), SOURCES, input({ message: 'q '.repeat(25_000) }));
    expect('failed' in r && r.reason).toBe('INPUT_TOKENS_EXCEEDED');
    expect(fakeProvider.calls).toHaveLength(0);
  });
});
