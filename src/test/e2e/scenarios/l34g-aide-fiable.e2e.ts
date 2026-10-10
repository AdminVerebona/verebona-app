/**
 * Lot 34G — T2 Aide produit : Centre d'aide fiable, réponses HOW_TO courtes,
 * parcours de création ouverts directement — de bout en bout sur PostgreSQL
 * réel.
 *
 * `runAssistant` + PORTS RÉELS (`buildOrchestratorPorts` : chargement du
 * corpus par HTTP — `fetch` simulé, aucun réseau —, dernier corpus valide
 * enregistré en BASE, rôles lus en base, actions résolues et contrôlées en
 * base, persistance de la trace et des actions). Master T2 rejoué par la
 * vraie passerelle : `replay.calls` est le compteur d'appels LLM.
 *
 *  · HELP2-E2E-01 : préproduction, corpus de préproduction lu en direct —
 *    AID-DOC-001, réponse courte, 0 appel, observabilité persistée ;
 *    [Ajouter un document] [Lire l'article], action de création persistée
 *    SANS href et rejouée en commande ;
 *  · HELP2-E2E-02 : site public injoignable après redémarrage — dernier
 *    corpus valide relu en BASE (même environnement), réponse trouvée ;
 *  · HELP2-E2E-03 : corpus de production servi à la préproduction — refusé,
 *    HELP_CORPUS_WRONG_ENVIRONMENT persisté, support proposé ;
 *  · HELP2-E2E-04 : bien de la page présélectionné ; bien d'un autre compte
 *    jamais présélectionné (contrôle serveur).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
const BRUT = JSON.parse(readFileSync(join(__dirname, '../fixtures/help-corpus-t2.snapshot.json'), 'utf8')) as Record<string, unknown>;
const publie = (environment: string, version: string) => JSON.stringify({ ...BRUT, environment, version });
const FALLBACK = /pas trouvé dans le Centre d’aide d’information suffisamment fiable/;
const articles = (r: { sources: Array<{ id: string }> }) => [...new Set(r.sources.map((s) => s.id.replace(/^help_/, '').split('__')[0]))];

scenario('L34G-AIDE', 'Lot 34G — Centre d’aide fiable et parcours de création directs', ({ sql, make, useRecordings }) => {
  useTargetState({ NEXT_PUBLIC_APP_ENV: 'preprod', NEXT_PUBLIC_PUBLIC_SITE_URL: 'https://preprod.verebona.fr' }, { masters: ['T1', 'T2'] });

  let reponse: () => Promise<Response>;
  const fetchMock = vi.fn(async (..._a: unknown[]) => reponse());
  const env = { version: 1 };

  beforeEach(async () => {
    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    hc.resetHelpCorpusCacheForTests();
    // Dernier corpus valide enregistré dans la VRAIE base.
    hc.setHelpCorpusStoreForTests(hc.dbHelpCorpusStore);
    env.version += 1;
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    reponse = async () => new Response(publie('preprod', `v-e2e-${env.version}`), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    hc.setHelpCorpusStoreForTests(null);
    hc.resetHelpCorpusCacheForTests();
  });

  const compte = async (): Promise<Compte> => { const a = await make.account({ plan: 'premium' }); return { id: a.id, ownerUserId: a.ownerUserId }; };
  const run = async (requestId: string) => {
    const [row] = await sql<{ j: Record<string, any> }[]>`SELECT retrieval_methods_json AS j FROM verebona_request_runs WHERE request_id = ${requestId}`;
    return row?.j ?? null;
  };

  it('HELP2-E2E-01 — « Comment ajouter un document ? » : AID-DOC-001, réponse courte, 0 appel, observabilité et actions persistées', async () => {
    const c = await compte();
    const replay = await useRecordings([]);
    const clientRequestId = `l34g-${Date.now()}`;
    const r = await demander(c, 'Comment ajouter un document ?', { clientRequestId, pageContext: { route: '/documents', platform: 'web' } });
    expect(fetchMock).toHaveBeenCalledWith('https://preprod.verebona.fr/aide/corpus-t2.json', expect.anything());
    expect(r.route.intent).toBe('PRODUCT_HELP_HOW_TO');
    expect(articles(r)[0]).toBe('AID-DOC-001');
    expect(r.answer).not.toMatch(FALLBACK);
    expect(r.answer.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(2);
    expect(replay.calls).toHaveLength(0);
    expect(r.cascade?.aiCalls).toBe(0);
    expect(r.actions.slice(0, 2).map((a) => a.type)).toEqual(['START_ADD_DOCUMENT', 'OPEN_HELP']);
    expect(r.actions[1].href).toBe('/aide?page=%2Faide%2Fajouter-un-document');
    expect(r.actions.map((a) => a.type)).not.toContain('OPEN_CONTACT');

    const j = await run(r.requestId);
    expect(j!.fallbackReason ?? null).toBeNull();
    expect(j!.observability.truthSource).toBe('centre_aide');
    expect(j!.help.observability).toMatchObject({
      corpusAvailable: true, corpusSource: 'live', applicationEnvironment: 'preprod', corpusEnvironment: 'preprod',
      articleId: 'AID-DOC-001', fallbackReason: null,
    });
    expect(j!.help.observability.sourceCount).toBeGreaterThanOrEqual(1);
    expect(j!.help.observability.candidateCount).toBeGreaterThan(0);

    // Action de création persistée SANS href (plus de faux lien), rejouée en commande.
    const [act] = await sql<{ resolved_href: string | null }[]>`
      SELECT a.resolved_href FROM verebona_message_actions a JOIN verebona_messages m ON m.id = a.message_id
       WHERE m.request_id = ${r.requestId} AND a.action_type = 'START_ADD_DOCUMENT'`;
    expect(act.resolved_href).toBeNull();
    const { findReplayedAnswer } = await import('@/services/verebona-assistant/core/conversation.service');
    const rejoue = await findReplayedAnswer(c.id, c.ownerUserId, clientRequestId);
    expect(rejoue!.actions.find((a) => a.type === 'START_ADD_DOCUMENT')).toMatchObject({ href: null, command: { kind: 'CREATE', flow: 'document', assetId: null } });
  });

  it('HELP2-E2E-02 — redémarrage avec site public injoignable : dernier corpus valide relu en BASE (même environnement), réponse trouvée', async () => {
    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    await hc.loadHelpCorpus();
    // Enregistrement asynchrone du dernier corpus valide (clé réservée).
    await vi.waitFor(async () => {
      const [row] = await sql<{ v: string }[]>`SELECT result_json->>'version' AS v FROM ai_operation_idempotency WHERE key_hash = 'help-corpus:last-valid:preprod'`;
      expect(row?.v).toBe(`v-e2e-${env.version}`);
    });
    hc.resetHelpCorpusCacheForTests();
    reponse = async () => { throw new TypeError('fetch failed'); };
    const c = await compte();
    await useRecordings([]);
    const r = await demander(c, 'Comment ajouter un document ?');
    expect(articles(r)[0]).toBe('AID-DOC-001');
    expect(r.answer).not.toMatch(FALLBACK);
    const j = await run(r.requestId);
    expect(j!.help.observability).toMatchObject({ corpusAvailable: true, corpusSource: 'last_valid_db', corpusDiagnostic: 'HELP_CORPUS_UNAVAILABLE', corpusEnvironment: 'preprod' });
    expect(j!.fallbackReason ?? null).toBeNull();
  });

  it('HELP2-E2E-03 — corpus de production servi à la préproduction : refusé, HELP_CORPUS_WRONG_ENVIRONMENT persisté, aide puis support', async () => {
    await sql`DELETE FROM ai_operation_idempotency WHERE key_hash = 'help-corpus:last-valid:preprod'`;
    reponse = async () => new Response(publie('production', 'v-prod'), { status: 200 });
    const c = await compte();
    await useRecordings([]);
    const r = await demander(c, 'Comment ajouter un document ?');
    expect(r.answer).toMatch(FALLBACK);
    expect(r.sources).toEqual([]);
    const j = await run(r.requestId);
    expect(j!.fallbackReason).toBe('HELP_CORPUS_WRONG_ENVIRONMENT');
    expect(j!.help.observability).toMatchObject({ corpusAvailable: false, applicationEnvironment: 'preprod', corpusDiagnostic: 'HELP_CORPUS_WRONG_ENVIRONMENT' });
    expect(r.actions.map((a) => a.type)).toEqual(expect.arrayContaining(['OPEN_HELP', 'OPEN_CONTACT']));
  });

  it('HELP2-E2E-04 — bien de la page présélectionné (contrôlé en base) ; bien d’un autre compte jamais présélectionné', async () => {
    const c = await compte();
    const autre = await compte();
    const bien = await make.asset(c as never, { category: 'IMMOBILIER', name: 'Maison' });
    const etranger = await make.asset(autre as never, { category: 'IMMOBILIER', name: 'Chez un autre' });
    await useRecordings([]);
    const r = await demander(c, 'Comment ajouter un document ?', { pageContext: { route: `/assets/${bien.id}`, assetId: String(bien.id), platform: 'web' } });
    expect(r.actions.filter((a) => a.type === 'START_ADD_DOCUMENT')).toEqual([
      expect.objectContaining({ href: null, command: { kind: 'CREATE', flow: 'document', assetId: bien.id } }),
    ]);
    const r2 = await demander(c, 'Comment ajouter un document ?', { pageContext: { route: `/assets/${etranger.id}`, assetId: String(etranger.id), platform: 'web' } });
    expect(r2.actions.filter((a) => a.type === 'START_ADD_DOCUMENT').every((a) => a.command?.assetId !== etranger.id)).toBe(true);
  });
});
