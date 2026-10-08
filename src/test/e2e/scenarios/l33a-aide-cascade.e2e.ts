/**
 * Lot 33 (33A) — T2 PRODUCT_HELP_HOW_TO : cascade du Centre d'aide, de bout
 * en bout sur PostgreSQL réel.
 *
 * `runAssistant` + PORTS RÉELS (`buildOrchestratorPorts` : recherche du
 * Centre d'aide `openHelpSearch`, rôles lus en base, actions résolues,
 * persistance de la trace), master T2 rejoué par la vraie passerelle (aucun
 * réseau) — `replay.calls` est le compteur d'appels LLM. Le Centre d'aide est
 * l'instantané publié (`fixtures/help-corpus-t2.snapshot.json`).
 *
 *  · HELP-T1-E2E : « comment ajouter un document » — non-régression : article
 *    AID-DOC-001, procédure, 0 appel, trace persistée (niveaux, requêtes,
 *    sources avec étape, source de vérité « centre_aide ») ;
 *  · HELP-T3-E2E : les formulations du §3.1 et « Je veux mettre une facture
 *    dans Verebona » — même article, 0 appel ;
 *  · HELP-T6-E2E : plein texte insuffisant → UNDERSTAND (1 appel) → source ;
 *  · HELP-T7/T8-E2E : rien de documenté → repli après TOUTE la cascade,
 *    ANSWER jamais appelé, motif persisté.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));

type Compte = { id: number; ownerUserId: number };
const understand = (output: Record<string, unknown>) => ({
  operationCode: 't2_understand', task: 'UNDERSTAND',
  output: { mode: 'UNDERSTAND', confidence: 'exact', entityHints: [], requestedFacts: [], requestedTopics: [], filters: {}, reason: 'e2e', ...output },
});
const FALLBACK = /pas trouvé dans le Centre d’aide d’information suffisamment fiable/;
const articles = (r: { sources: Array<{ id: string }> }) => [...new Set(r.sources.map((s) => s.id.replace(/^help_/, '').split('__')[0]))];

scenario('L33A-AIDE', 'Lot 33A — cascade du Centre d’aide (PRODUCT_HELP_HOW_TO)', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });

  const installer = async () => {
    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    const corpus = hc.parseHelpCorpus(JSON.parse(readFileSync(join(__dirname, '../fixtures/help-corpus-t2.snapshot.json'), 'utf8')));
    if (!corpus) throw new Error('instantané du Centre d’aide illisible');
    hc.setHelpCorpusForTests(corpus);
    // L'article d'ajout de document existe bien dans le corpus publié.
    expect(corpus.articles.find((a) => a.id === 'AID-DOC-001')?.title).toBe('Ajouter un document');
  };
  const compte = async (): Promise<Compte> => { const a = await make.account({ plan: 'premium' }); return { id: a.id, ownerUserId: a.ownerUserId }; };
  const run = async (requestId: string) => {
    const [row] = await sql<{ j: Record<string, any> }[]>`SELECT retrieval_methods_json AS j FROM verebona_request_runs WHERE request_id = ${requestId}`;
    return row?.j ?? null;
  };

  it('HELP-T1-E2E — « comment ajouter un document » : AID-DOC-001, procédure, 0 appel LLM, trace persistée cohérente', async () => {
    await installer();
    const c = await compte();
    const replay = await useRecordings([]);
    const r = await demander(c, 'comment ajouter un document', { pageContext: { route: '/documents', platform: 'web' } });
    expect(r.route.intent).toBe('PRODUCT_HELP_HOW_TO');
    expect(articles(r)[0]).toBe('AID-DOC-001');
    expect(r.answer).toContain('1. Ouvrez l’ajout de document');
    expect(r.answer).not.toMatch(FALLBACK);
    expect(r.actions.map((a) => a.type)).toEqual(expect.arrayContaining(['START_ADD_DOCUMENT', 'OPEN_HELP']));
    expect(replay.calls).toHaveLength(0);
    expect(r.cascade?.aiCalls).toBe(0);
    const j = await run(r.requestId);
    expect(j).toBeTruthy();
    expect(j!.intent).toBe('PRODUCT_HELP_HOW_TO');
    expect(j!.answeredBy).toBe('retrieval');
    expect(j!.strategy).toBe('help.exact_article');
    expect(j!.sourceCount).toBeGreaterThanOrEqual(1);
    expect(j!.levelsReached).toContain('fulltext');
    expect(j!.notices ?? []).not.toContain('NO_RELEVANT_SOURCE');
    expect(j!.escalationReasons).not.toContain('N2:SYNTHESIS_REQUIRED');
    expect(j!.observability.truthSource).toBe('centre_aide');
    expect(j!.retrievalQueryInitial).toBe('comment ajouter un document');
    expect(j!.help.levels[0]).toMatchObject({ level: 2, strategy: 'help.fulltext', status: 'SUFFICIENT', threshold: 0.6 });
    expect(j!.help.levels[0].candidateCount).toBeGreaterThan(0);
    expect(j!.help.sources[0]).toMatchObject({ type: 'help_entry', stage: 'fulltext' });
    expect(j!.help.sources[0].id).toMatch(/^help_AID-DOC-001__/);
    expect(j!.fallbackReason ?? null).toBeNull();
  });

  it('HELP-T3-E2E — variantes lexicales et « Je veux mettre une facture dans Verebona » : même article, 0 appel LLM', async () => {
    await installer();
    const c = await compte();
    const replay = await useRecordings([]);
    for (const q of [
      'comment importer un document', 'comment déposer un document', 'comment mettre un document', 'comment ajouter une facture',
      'où ajouter un document', 'je veux ajouter un fichier', 'comment joindre un fichier', 'où déposer ma facture',
      'Je veux mettre une facture dans Verebona', 'Ajouter un fichier',
    ]) {
      const r = await demander(c, q);
      expect(r.route.intent, q).toBe('PRODUCT_HELP_HOW_TO');
      expect(articles(r)[0], q).toBe('AID-DOC-001');
      expect(r.answer, q).not.toMatch(FALLBACK);
      expect(r.cascade?.aiCalls, q).toBe(0);
    }
    expect(replay.calls).toHaveLength(0);
    const r = await demander(c, 'Je veux mettre une facture dans Verebona');
    const j = await run(r.requestId);
    expect(j!.levelsReached).toEqual(expect.arrayContaining(['fulltext', 'expanded']));
    expect(j!.retrievalQueriesExpanded).toEqual(expect.arrayContaining(['ajouter un document']));
    expect(j!.help.concept).toEqual({ id: 'DOCUMENT_UPLOAD', certain: true });
  });

  it('HELP-T6-E2E — plein texte insuffisant : UNDERSTAND (1 appel, requêtes de recherche) puis l’article', async () => {
    await installer();
    const c = await compte();
    const replay = await useRecordings([understand({ intent: 'PRODUCT_HELP_HOW_TO', requestedTopics: ['importer un document'], reason: 'ajout de document' })]);
    const r = await demander(c, 'Comment je fais pour que mon PDF apparaisse dans l’appli ?');
    expect(r.route.intent).toBe('PRODUCT_HELP_HOW_TO');
    expect(replay.calls.map((x) => x.task)).toEqual(['UNDERSTAND']);
    expect(r.cascade?.aiCalls).toBe(1);
    expect(articles(r)).toContain('AID-DOC-001');
    expect(r.answer).not.toMatch(FALLBACK);
    const j = await run(r.requestId);
    expect(j!.levelsReached).toEqual(expect.arrayContaining(['fulltext', 'understand', 'reformulated']));
    expect(j!.help.understanding).toMatchObject({ task: 'UNDERSTAND', operation: 't2_understand', status: 'called' });
    expect(j!.help.sources[0].stage).toBe('reformulated');
  });

  it('HELP-T7/T8-E2E — rien de documenté : repli au bout de la cascade, ANSWER jamais appelé, motif persisté, aucune action métier', async () => {
    await installer();
    const c = await compte();
    const replay = await useRecordings([understand({ intent: 'PRODUCT_HELP_HOW_TO', requestedTopics: ['connexion Tesla'] })]);
    const r = await demander(c, 'Comment connecter Verebona à ma Tesla ?');
    expect(replay.calls.map((x) => x.task)).toEqual(['UNDERSTAND']);
    expect(r.answer).toMatch(FALLBACK);
    expect(r.sources).toEqual([]);
    expect(r.actions.map((a) => a.type).filter((t) => t.startsWith('START_'))).toEqual([]);
    const j = await run(r.requestId);
    expect(j!.strategy).toBe('fallback.help');
    expect(j!.answeredBy).toBe('fallback');
    expect(j!.aiCalls).toBe(1);
    expect(j!.fallbackReason).toBe('NO_RELIABLE_SOURCE');
    expect(j!.observability.truthSource).toBe('aucune');
    expect(j!.help.levels.map((l: { level: number }) => l.level)).toEqual([2, 3, 4, 5]);
  });
});
