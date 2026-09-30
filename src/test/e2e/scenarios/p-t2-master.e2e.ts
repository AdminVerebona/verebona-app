/**
 * P-T2-01 à P-T2-04 et recettes T2-23, T2-24, T2-31 — prompt maître T2 sur
 * base réelle (CDC 15 §24, §30, T2-41 ; D-08 : sorties modèle SYNTHÉTIQUES
 * enregistrées, D-17 : aucun réseau).
 *
 * Chaîne exercée : lecture de données du compte EN BASE (couche canonique
 * de X, `answerFromData`) → sources → passerelle réelle (master
 * `t2_master_v1` du dépôt, MODE imposé, validation discriminée) → contrôle
 * serveur des affirmations (T2-31) → réponse ; revalidation d'une
 * observation visuelle → fait réinjecté, signal et trace d'impact en base.
 *
 * L'architecture T2 `master` est celle de la version de configuration
 * (D-04), posée ici par le cache du résolveur.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

scenario('P-T2-MASTER', 'Prompt maître T2 : compréhension, réponse vérifiée, revalidation', ({ sql, make, useRecordings }) => {
  const env = { ...process.env };
  let cfg: typeof import('@/services/ai/config/config-resolver');
  let gen: typeof import('@/services/verebona-assistant/core/generation.adapter');
  let budget: typeof import('@/services/verebona-assistant/core/ai-call-budget');
  let router: typeof import('@/services/verebona-assistant/core/intent-router.service');
  let repo: typeof import('@/services/verebona-assistant/core/account-data.repository');
  let da: typeof import('@/services/verebona-assistant/core/data-answer.service');
  let thresholds: typeof import('@/services/verebona-assistant/core/sufficiency')['DEFAULT_THRESHOLDS'];

  beforeAll(async () => {
    cfg = await import('@/services/ai/config/config-resolver');
    const { emptyTreatmentConfig } = await import('@/services/ai/config/config-types');
    cfg.__setConfigForTests({ versionId: 1500, entries: [{ ...emptyTreatmentConfig('T2'), promptArchitecture: 'master' }] });
    gen = await import('@/services/verebona-assistant/core/generation.adapter');
    budget = await import('@/services/verebona-assistant/core/ai-call-budget');
    router = await import('@/services/verebona-assistant/core/intent-router.service');
    repo = await import('@/services/verebona-assistant/core/account-data.repository');
    da = await import('@/services/verebona-assistant/core/data-answer.service');
    ({ DEFAULT_THRESHOLDS: thresholds } = await import('@/services/verebona-assistant/core/sufficiency'));
  });
  afterAll(() => cfg.__setConfigForTests(null));
  afterEach(() => {
    for (const k of ['ASSISTANT_CANONICAL_READ', 'AI_T4_EFFECTS']) {
      if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
    }
  });

  const input = (compte: { id: number; ownerUserId: number }, message: string) => ({
    accountId: compte.id, userId: compte.ownerUserId, planType: 'PREMIUM', message, clientRequestId: `e2e-${Math.random()}`,
    locale: 'fr-FR', aiBudget: budget.createAiCallBudget(2), aiReport: { securityEvents: [], events: [] as string[] },
  });
  /** Sources construites par le serveur à partir de la base (couche de X). */
  const sourcesFor = async (accountId: number, message: string) => {
    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const r = await da.answerFromData({ port: repo.accountDataRepository, accountId, message, thresholds });
    return r.sources;
  };
  /** Trace passerelle de la dernière opération (ai_usage_event). */
  const trace = async (accountId: number, operationCode: string) => {
    for (let i = 0; i < 20; i += 1) {
      const [t] = await sql<{ task: string | null; master_prompt_code: string | null }[]>`
        SELECT task, master_prompt_code FROM ai_usage_event
         WHERE account_id = ${accountId} AND operation_code = ${operationCode} ORDER BY id DESC LIMIT 1`;
      if (t) return t;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  };

  it('P-T2-01 : « Indique-moi la date d’achat » → intention de LECTURE (jamais une commande), fait du catalogue', async () => {
    const compte = await make.account();
    const replay = await useRecordings([{
      operationCode: 't2_understand', task: 'UNDERSTAND',
      output: {
        mode: 'UNDERSTAND', intent: 'ACCOUNT_FACT_ASSET', confidence: 'exact',
        entityHints: [{ type: 'asset', value: 'Clio' }], requestedFacts: ['acquisitionDate', 'dateAchatInventee'],
        requestedTopics: [], filters: {}, reason: 'lecture d’un champ',
      },
    }]);
    const { understandWithT2Master } = await import('@/services/ai/assistant/master/t2-understand');
    const { toIntentRoute } = await import('@/services/verebona-assistant/core/classification.adapter');
    const r = await understandWithT2Master('Indique-moi la date d’achat de la Clio', input(compte, ''));
    expect(replay.calls[0].task).toBe('UNDERSTAND');
    expect(replay.calls[0].prompt).toContain('MODE = UNDERSTAND');
    expect(r?.requestedFacts).toEqual(['acquisitionDate']);
    const route = toIntentRoute(r!.plan, 'PREMIUM');
    expect(route.intent).toBe('ACCOUNT_FACT_ASSET');
    // Navigation et sources seulement : aucune action d'écriture (commande).
    expect(route.allowedActionTypes.every((a) => /^(OPEN_|SHOW_)/.test(a))).toBe(true);
    expect(await trace(compte.id, 't2_understand')).toMatchObject({ task: 'UNDERSTAND', master_prompt_code: 't2_master_v1' });
  });

  it('P-T2-02 + T2-23 + T2-31 : valeur USER de la fiche, jamais l’ancienne colonne ; affirmation non soutenue rejetée', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, {
      category: 'VEHICULE', name: 'Clio', purchaseDate: '2019-01-01',
      keyCharacteristics: { acquisitionDate: '2021-05-25', acquisitionDate__origin: 'USER' },
    });
    const message = 'Quand ai-je acheté la Clio ?';
    const sources = await sourcesFor(compte.id, message);
    const champ = `asset_field:${bien.id}:acquisitionDate`;
    expect(sources.map((s) => s.id)).toContain(champ);

    await useRecordings([{
      operationCode: 't2_answer', task: 'ANSWER',
      output: {
        mode: 'ANSWER', format: 'claims', status: 'answered',
        claims: [
          { text: 'Vous avez acheté la Clio le 25 mai 2021.', sourceIds: [champ], derivation: 'direct', factual: true,
            support: { kind: 'field', sourceId: champ, value: '2021-05-25' } },
          // Cas limite T2-31 : sourceId valide, mais la source ne porte pas cette date.
          { text: 'Un ancien document la date du 1 janvier 2019.', sourceIds: [champ], factual: true },
        ],
      },
    }]);
    const i = input(compte, message);
    const r = await gen.generateAssistantAnswerDetailed(router.routeForIntent('ACCOUNT_FACT_ASSET', 'PREMIUM', 'e2e'), sources, i);
    if ('failed' in r) throw new Error(r.reason);
    expect(r.answer).toBe('Vous avez acheté la Clio le 25 mai 2021.');
    expect(r.answer).not.toMatch(/2019/);
    expect(r.claims.map((c) => c.sourceIds)).toEqual([[champ]]);
    expect(r.supportLevel).toBe('partial');
    expect(r.generationEvents?.some((e) => e.startsWith('CLAIM_UNSUPPORTED:DATA_NOT_IN_SOURCES'))).toBe(true);
    expect(await trace(compte.id, 't2_answer')).toMatchObject({ task: 'ANSWER', master_prompt_code: 't2_master_v1' });
  });

  it('T2-24 + T2-31 : total d’entretien qualifié (nominal) ; un total qui inclut un document non qualifié est rejeté', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    for (const [v2, legacy, cents] of [['MAINTENANCE_INVOICE', null, 20000], ['MAINTENANCE_INVOICE', null, 25000], [null, 'FACTURE', 7000]] as const) {
      const f = await make.assetFile(compte, { assetId: bien.id });
      await sql`UPDATE asset_files SET document_type_code = ${v2}, document_type = ${legacy}, amount_cents = ${cents},
                document_date = '2025-06-01', retained_title = ${`Doc ${cents}`} WHERE id = ${f.id}`;
    }
    const message = 'Combien ai-je dépensé en entretien pour la Polo ?';
    // Total QUALIFIÉ calculé par le serveur (couche canonique de X, T2-24) :
    // le seul ensemble déclaré complet pour le calcul (B4). La source de la
    // réponse structurée de X ne porte pas encore ce total (besoin signalé) :
    // elle est construite ici à partir de la même lecture.
    const can = await import('@/services/verebona-assistant/canonical');
    const q = await can.sumQualifiedExpenses(compte.id, { assetIds: [bien.id], theme: 'maintenance' });
    expect(q).toMatchObject({ qualifiedSumCents: 45000, complete: false, unqualified: { count: 1 } });
    const sources = [{
      id: `expenses:${bien.id}:maintenance`, type: 'document_extraction' as const, title: 'Dépenses d’entretien qualifiées — Polo',
      content: `Entretien : ${(q.qualifiedSumCents / 100).toFixed(2).replace('.', ',')} € (${q.qualifiedCount} documents). `
        + `${q.unqualified.count} document au thème non établi, exclu du total.`,
    }];
    const ids = sources.map((s) => s.id);
    await useRecordings([{
      operationCode: 't2_answer', task: 'ANSWER',
      output: {
        mode: 'ANSWER', format: 'claims', status: 'answered',
        claims: [
          { text: 'Vos dépenses d’entretien qualifiées pour la Polo s’élèvent à 450,00 €.', sourceIds: ids, derivation: 'calculated', factual: true },
          { text: 'En comptant toutes les factures, le total atteint 520,00 €.', sourceIds: ids, derivation: 'calculated', factual: true },
        ],
      },
    }]);
    const r = await gen.generateAssistantAnswerDetailed(router.routeForIntent('ACCOUNT_FACT_DOCUMENT', 'PREMIUM', 'e2e'), sources, input(compte, message));
    if ('failed' in r) throw new Error(r.reason);
    expect(r.answer).toContain('450,00');
    expect(r.answer).not.toContain('520');
    expect(r.supportLevel).toBe('partial');
  });

  it('P-T2-03 : chronologie → events[] ordonnés et structurés, une ligne par événement (pas de phrases aplaties)', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'OBJECT', name: 'Draisienne' });
    const achat = await make.agendaItem(compte, { title: 'Achat de la draisienne', startDate: '2026-04-24', assetIds: [bien.id] });
    const revision = await make.agendaItem(compte, { title: 'Révision de la draisienne', startDate: '2026-09-12', assetIds: [bien.id] });
    const can = await import('@/services/verebona-assistant/canonical');
    const sources = [];
    for (const it of [achat, revision]) {
      const item = await can.getCanonicalAgendaItem(compte.id, it.id);
      sources.push(can.canonicalAgendaSource(item!));
    }
    const [s1, s2] = sources.map((s) => s.id);
    await useRecordings([{
      operationCode: 't2_answer', task: 'ANSWER',
      output: {
        mode: 'ANSWER', format: 'timeline', status: 'answered',
        events: [
          { date: '2026-04-24', text: 'Achat de la draisienne', sourceIds: [s1] },
          { date: '2026-09-12', text: 'Révision de la draisienne', sourceIds: [s2] },
        ],
      },
    }]);
    const r = await gen.generateAssistantAnswerDetailed(router.routeForIntent('ACCOUNT_TIMELINE', 'PREMIUM', 'e2e'), sources, input(compte, 'Historique de la draisienne'));
    if ('failed' in r) throw new Error(r.reason);
    expect(r.events).toEqual([
      { date: '2026-04-24', text: 'Achat de la draisienne', sourceIds: [s1] },
      { date: '2026-09-12', text: 'Révision de la draisienne', sourceIds: [s2] },
    ]);
    expect(r.answer.split('\n')).toHaveLength(2);
    expect(r.supportLevel).toBe('supported');
  });

  it('P-T2-04 + T2-27/28/30 : observation visuelle → preuve visuelle, aucun faux extrait ; impact tracé, aucune écriture directe', async () => {
    process.env.AI_T4_EFFECTS = 'enabled';
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const fichier = await make.assetFile(compte, { assetId: bien.id, name: 'chaufferie.jpg', mimeType: 'image/jpeg' });
    const [ext] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, full_text, full_text_chars)
      VALUES (${compte.id}, ${fichier.id}, '', 0) RETURNING id`;
    const [fait] = await sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, attribute, value_text, confidence, excerpt,
                                  location, evidence_origin, visual_evidence)
      VALUES (${compte.id}, ${fichier.id}, ${ext.id}, 'heatingInstallationType', 'Type de chaudière', 'murale', 'probable', NULL,
              '{"page":1}'::jsonb, 'VISUAL_ANALYSIS', '{"description":"chaudière accrochée au mur","page":1}'::jsonb)
      RETURNING id::int AS id`;
    const avant = await sql<{ key_characteristics: unknown; updated_at: Date }[]>`SELECT key_characteristics, updated_at FROM assets WHERE id = ${bien.id}`;

    const replay = await useRecordings([{
      operationCode: 't2_revalidate', task: 'REVALIDATE',
      output: {
        mode: 'REVALIDATE', status: 'confirmed', value: 'murale', unit: null, confidence: 'certain',
        // Le modèle invente un extrait : il doit être retiré (C3, P-T2-04).
        evidence: { provenance: 'VISUAL_ANALYSIS', excerpt: 'Chaudière murale (texte inventé)', page: 1,
          visualEvidence: { description: 'chaudière murale fixée au mur de la chaufferie', page: 1 } },
      },
    }]);
    const rv = await import('@/services/verebona-assistant/core/revalidation.service');
    const r = await rv.revalidateFact({
      accountId: compte.id, userId: compte.ownerUserId, factId: fait.id, question: 'Quel type de chaudière ?', trigger: 'LOW_CONFIDENCE',
    }, { ...rv.defaultRevalidationDeps, sourceUrl: async () => ({ url: 'https://e2e.invalid/chaufferie.jpg', mimeType: 'image/jpeg' }) });

    expect(replay.calls[0].task).toBe('REVALIDATE');
    expect(replay.calls[0].prompt).toMatch(/Provenance attendue : VISUAL/);
    expect(r).toMatchObject({ mode: 'VISUAL_RECHECK', status: 'CONFIRMED', excerpt: null, confidence: 'probable' });

    const [nouveau] = await sql<{ evidence_origin: string; excerpt: string | null; visual_evidence: { description: string }; provenance: string }[]>`
      SELECT evidence_origin, excerpt, visual_evidence, provenance FROM document_facts WHERE id = ${r!.reinjectedFactId!}`;
    expect(nouveau).toMatchObject({ evidence_origin: 'VISUAL_ANALYSIS', excerpt: null, provenance: 'REVALIDATION_T2' });
    expect(nouveau.visual_evidence.description).toContain('chaudière murale');

    const [signal] = await sql<{ t2_result: { mode: string; impact: Record<string, unknown> } }[]>`
      SELECT t2_result FROM t1_quality_signals WHERE file_id = ${fichier.id} ORDER BY id DESC LIMIT 1`;
    expect(signal.t2_result.mode).toBe('VISUAL_RECHECK');
    expect(signal.t2_result.impact).toMatchObject({ assetId: bien.id, projected: true, directAssetWrites: 0, t4Effects: 'enabled' });
    const [rev] = await sql<{ mode: string; excerpt: string | null }[]>`
      SELECT mode, excerpt FROM verebona_fact_revalidations WHERE id = ${r!.revalidationId!}`;
    expect(rev).toEqual({ mode: 'VISUAL_RECHECK', excerpt: null });
    // T2-27 : la fiche n'est modifiée que par le pipeline protégé (preuves → T3) ;
    // ici aucune clé canonique n'est concernée, elle est donc inchangée.
    const apres = await sql<{ key_characteristics: unknown }[]>`SELECT key_characteristics FROM assets WHERE id = ${bien.id}`;
    expect(apres[0].key_characteristics).toEqual(avant[0].key_characteristics);
  });
});
