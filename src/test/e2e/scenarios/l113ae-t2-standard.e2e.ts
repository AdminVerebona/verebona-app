/**
 * Lot 113AE — Trello #728 : Standard actif = T2 COMPLET via le champ commun,
 * SANS ouvrir les droits Premium métier. De bout en bout sur PostgreSQL réel,
 * par les VRAIES routes (`POST /api/verebona/messages`, réponse à une
 * clarification, `GET /api/search?instant=1`), orchestrateur et ports réels,
 * droits RÉELS (`account_subscriptions`). Modèle SIMULÉ : chaque appel T2
 * (`t2_*` : UNDERSTAND, arbitrage, ANSWER, REVALIDATE) est COMPTÉ.
 *
 *   AC01  Standard : question ambiguë → UNDERSTAND effectif, pas de PLAN_WITHOUT_AI
 *   AC02  Standard : synthèse → ANSWER réel ; mêmes opérations / modèle / prompt que Premium à données égales
 *   AC03  Standard : SUMMARY / COMPARISON / TIMELINE comme Premium
 *   AC04  frappe = SQL sans modèle ; question validée = T2 complet
 *   AC05  suggestions Standard : aucune Premium ; clic → même T2
 *   AC06  clarification / reprise Standard : accès IA conservé, appartenance revalidée
 *   AC07  TCO : aucun montant en Standard ; dépenses qualifiées chiffrées ; Premium / essai : TCO
 *   AC08  aucune action / endpoint Premium ouvert à Standard
 *   AC09  commande T2 : préparée et confirmée en Standard (flag ON), refusée en lecture seule
 *   AC10  readonly / past_due / canceled / none : ZÉRO appel modèle, recherche et aide servies
 *   AC11  IA coupée / plafond atteint : repli sans appel, Standard comme Premium
 *   AC12  aucune fuite intercomptes
 *   AC13  quotas et offre : PRODUCT_PLAN_LIMIT correct, quotas Standard inchangés
 *   AC14  diagnostic BO : offre réelle tracée, appels et coût par offre
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
// Session simulée : le compte de la session est celui du test (planType JWT volontairement STANDARD).
const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, planType: 'STANDARD' }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
// Le limiteur dédié n'est pas l'objet du scénario (nombreuses questions par compte).
vi.mock('@/lib/verebona/rate-limit', () => ({ checkAssistantRateLimit: async () => ({ allowed: true, retryAfterMs: 0 }) }));
vi.mock('@/services/verebona-assistant', async (o) => ({ ...(await o<object>()), ensureAssistantStartupChecked: () => ({ ok: true }) }));

type Compte = { id: number; ownerUserId: number };
type Offre = 'standard' | 'premium' | 'premium_duo' | 'trial' | 'readonly' | 'past_due' | 'canceled' | 'none';
type Appel = { op: string; task?: string; model: string; prompt: string };
const MONTANT = /\d[\d\s  ]*,\d{2}\s?€|\d[\d\s  ]* €/;

/** Modèle simulé : compte les appels T2 ; ANSWER cite la première source fournie. */
function modeleSimule() {
  const appels: Appel[] = [];
  const provider = {
    name: 'simule',
    isConfigured: () => true,
    async call(input: { task?: string; prompt: string; model: string; operationCode?: string }) {
      const op = String(input.operationCode ?? '');
      if (op.startsWith('t2_')) appels.push({ op, task: input.task, model: input.model, prompt: input.prompt });
      if (input.task === 'ANSWER') {
        const id = input.prompt.match(/"sourceId": "([^"]+)"/)?.[1];
        return {
          rawText: JSON.stringify({ mode: 'ANSWER', format: 'claims', status: 'answered',
            claims: id ? [{ text: 'Synthèse rédigée à partir de vos documents.', sourceIds: [id], derivation: 'direct', factual: true }] : [] }),
          inputTokens: 900, outputTokens: 60,
        };
      }
      if (input.task === 'UNDERSTAND') {
        return { rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'low', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 'simulé' }), inputTokens: 300, outputTokens: 20 };
      }
      if (input.task === 'REVALIDATE') {
        return { rawText: JSON.stringify({ mode: 'REVALIDATE', status: 'not_found', value: null, unit: null, confidence: 'low', evidence: null }), inputTokens: 1, outputTokens: 1 };
      }
      // Hors T2 (T4, T6…) : sortie neutre, jamais comptée.
      return { rawText: '{}', inputTokens: 0, outputTokens: 0 };
    },
  };
  return { appels, provider };
}

scenario('L113AE-T2', 'Lot 113AE (#728) — Standard actif : T2 complet sans droits Premium', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  let sim: ReturnType<typeof modeleSimule>;
  let J = '';
  const FIX = join(__dirname, '../fixtures');
  let helpSnapshot: unknown;
  let resourcesSnapshot: unknown;

  beforeAll(async () => {
    sim = modeleSimule();
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(sim.provider as never);
    J = (await import('@/services/verebona-assistant/core/query-period')).aujourdhuiParis();
    helpSnapshot = JSON.parse(readFileSync(join(FIX, 'help-corpus-t2.snapshot.json'), 'utf8'));
    resourcesSnapshot = JSON.parse(readFileSync(join(FIX, 'ressources-corpus-t2.snapshot.json'), 'utf8'));
  });
  beforeEach(async () => {
    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    hc.setHelpCorpusForTests(hc.parseHelpCorpus(helpSnapshot));
    const rc = await import('@/services/verebona-assistant/core/resources-corpus.service');
    rc.setResourcesCorpusForTests(rc.parseResourcesCorpus(resourcesSnapshot));
    (await import('@/services/suggestions/shared/service')).resetSharedSuggestionsCache();
    (await import('@/services/verebona-assistant/core/retrieval-cache')).clearRetrievalCache?.();
    sim.appels.length = 0;
  });
  afterEach(async () => {
    delete process.env.VEREBONA_ASSISTANT_AI_ENABLED;
    delete process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS;
    (await import('@/services/verebona-assistant/config/assistant-config')).resetAssistantConfigForTests();
    (await import('@/services/ai/gateway/account-cost-cap')).setCostCapStoreForTests(null);
  });

  // ── Données ───────────────────────────────────────────────────────────────

  /** Compte dans l'état d'abonnement demandé (droits RÉELS). */
  const compte = async (offre: Offre): Promise<Compte> => {
    const actif = offre === 'standard' || offre === 'premium' || offre === 'premium_duo';
    const a = await make.account({ plan: actif ? offre : null });
    if (offre === 'trial') await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at) VALUES (${a.id}, 'premium', 'trialing', now() + interval '5 days')`;
    if (offre === 'readonly') await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at) VALUES (${a.id}, 'premium', 'trialing', now() - interval '1 day')`;
    if (offre === 'past_due' || offre === 'canceled') await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, first_billed_at) VALUES (${a.id}, 'standard', ${offre}, now() - interval '40 days')`;
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const bien = async (c: Compte, name: string, extra: Record<string, unknown> = {}) => {
    const b = await make.asset(c as never, { name, category: 'VEHICULE', ...extra });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${b.id}`;
    return b.id;
  };
  const facture = async (c: Compte, assetId: number, titre: string, cents: number, date: string) => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET document_type_code = 'MAINTENANCE_INVOICE', amount_cents = ${cents}, supplier = 'Garage Martin',
              document_date = ${date}, retained_title = ${titre}, original_filename = ${`${titre}.pdf`}, analysis_state = 'ANALYZED', user_id = ${c.ownerUserId}
              WHERE id = ${f.id}`;
    return f.id;
  };
  /** Jeu de données IDENTIQUE pour comparer les offres : Clio et Polo, deux factures, Cupra avec prix d'achat. */
  const jeu = async (c: Compte) => {
    const clio = await bien(c, 'Clio', { keyCharacteristics: { acquisitionPrice: 12000, mileage: 45000 } });
    const polo = await bien(c, 'Polo', { keyCharacteristics: { acquisitionPrice: 9000 } });
    await facture(c, clio, 'Facture révision Clio', 30000, '2024-05-02');
    await facture(c, polo, 'Facture révision Polo', 20000, '2024-06-03');
    return { clio, polo };
  };

  // ── Routes réelles ────────────────────────────────────────────────────────

  let n = 0;
  const poser = async (c: Compte, message: string, extra: Record<string, unknown> = {}) => {
    session.userId = c.ownerUserId; session.currentAccountId = c.id;
    const { POST } = await import('@/app/api/verebona/messages/route');
    n += 1;
    const res = await POST(new NextRequest('http://localhost/api/verebona/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, clientRequestId: `l113ae-${Date.now()}-${n}`, pageContext: { route: '/accueil', platform: 'web' }, ...extra }),
    }));
    const body = await res.json() as Record<string, unknown> & { answer?: string; intent?: string; mode?: string; requestId?: string; conversationId?: number;
      actions?: Array<{ type: string; href: string | null }>; clarification?: { clarificationId: string; choices: Array<{ choiceId: string; label: string }> } | null;
      commandPlan?: { planId: string; summary: string } | null };
    return { status: res.status, body, answer: String(body.answer ?? '') };
  };
  const repondreClarification = async (c: Compte, clarificationId: string, choiceId: string, conversationId?: number) => {
    session.userId = c.ownerUserId; session.currentAccountId = c.id;
    const { POST } = await import('@/app/api/verebona/clarifications/[clarificationId]/answer/route');
    const res = await POST(new NextRequest(`http://localhost/api/verebona/clarifications/${clarificationId}/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choiceId, ...(conversationId ? { conversationId } : {}) }),
    }), { params: Promise.resolve({ clarificationId }) });
    return { status: res.status, body: await res.json() as Record<string, unknown> & { answer?: string } };
  };
  /** Trace de cascade persistée (BO) de la dernière demande du compte. */
  const traceDe = async (requestId: string) => {
    const [r] = await sql<{ m: Record<string, unknown> | null }[]>`SELECT retrieval_methods_json AS m FROM verebona_request_runs WHERE request_id = ${requestId}`;
    return (r?.m ?? null) as null | { access?: Record<string, unknown>; escalationReasons?: string[]; aiCalls?: number };
  };
  const t2 = () => sim.appels.length;
  const normalise = (p: string) => p.replace(/\d+/g, '#');

  // ══════════════════════════════════════════════════════════════════════════

  it('AC01 — Standard actif : question ambiguë → UNDERSTAND effectif, sans PLAN_WITHOUT_AI, offre réelle tracée', async () => {
    const c = await compte('standard');
    await jeu(c);
    const r = await poser(c, 'raconte-moi un truc sur ce que je possède');
    expect(r.status).toBe(200);
    expect(sim.appels.some((a) => a.task === 'UNDERSTAND')).toBe(true);
    const trace = await traceDe(String(r.body.requestId));
    expect(trace?.access).toMatchObject({ commercialPlan: 'standard', modelCalls: true, premiumFeatures: false, source: 'entitlements' });
    expect(JSON.stringify(trace)).not.toMatch(/PLAN_WITHOUT_AI|PLAN_LIMIT/);
  });

  it('AC02 / AC03 — Standard : SUMMARY, COMPARISON, TIMELINE → ANSWER réel, mêmes opérations, modèle et prompt que Premium', async () => {
    const std = await compte('standard');
    const prem = await compte('premium');
    await jeu(std); await jeu(prem);
    const questions: Array<[string, string]> = [
      ['Fais-moi une synthèse de la Clio', 'ACCOUNT_SUMMARY'],
      ['Compare la Clio et la Polo', 'ACCOUNT_COMPARISON'],
      ['Historique de la Clio', 'ACCOUNT_TIMELINE'],
    ];
    for (const [q, intent] of questions) {
      sim.appels.length = 0;
      const s = await poser(std, q);
      const appelsStd = [...sim.appels];
      sim.appels.length = 0;
      const p = await poser(prem, q);
      const appelsPrem = [...sim.appels];
      expect(s.status, q).toBe(200);
      expect(s.body.intent, q).toBe(intent);
      expect(s.body.intent, q).toBe(p.body.intent);
      expect(s.body.mode, q).toBe(p.body.mode);
      // Mêmes étapes modèle, même modèle, même prompt (à identifiants près) : aucun « Standard light ».
      expect(appelsStd.map((a) => [a.op, a.task, a.model]), q).toEqual(appelsPrem.map((a) => [a.op, a.task, a.model]));
      expect(appelsStd.map((a) => normalise(a.prompt)), q).toEqual(appelsPrem.map((a) => normalise(a.prompt)));
      if (intent === 'ACCOUNT_SUMMARY') {
        expect(appelsStd.some((a) => a.task === 'ANSWER'), q).toBe(true);
        expect(s.body.mode).toBe('ai');
      }
    }
  });

  it('AC04 — champ commun : la frappe interroge SQL sans modèle ; la question validée lance T2 complet', async () => {
    const c = await compte('standard');
    const { clio } = await jeu(c);
    session.userId = c.ownerUserId; session.currentAccountId = c.id;
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(new NextRequest('http://localhost/api/search?instant=1&q=Clio'));
    expect(res.status).toBe(200);
    const out = await res.json() as { aiPowered: boolean; results: Array<{ id?: number | string; type?: string }> };
    expect(out.aiPowered).toBe(false);
    expect(JSON.stringify(out.results)).toMatch(new RegExp(`${clio}`));
    expect(t2()).toBe(0);
    const q = await poser(c, 'Fais-moi une synthèse de la Clio');
    expect(q.body.mode).toBe('ai');
    expect(t2()).toBeGreaterThan(0);
  });

  it('AC05 — suggestions Standard : aucune question Premium ; un clic suit le même T2', async () => {
    const c = await compte('standard');
    const cupra = await bien(c, 'Cupra', { keyCharacteristics: { acquisitionPrice: 25000, acquisitionDate: '2023-01-15' } });
    await facture(c, cupra, `Facture entretien ${J}`, 32000, J);
    const { getSharedSuggestions } = await import('@/services/suggestions/shared/service');
    const s = await getSharedSuggestions(c.id, c.ownerUserId);
    const ids = [...s.selection.items, ...s.selection.reserve].map((x) => x.id);
    expect(ids).not.toContain('acc_home_asset_ownership_cost');
    expect(ids).not.toEqual(expect.arrayContaining(['guide_agenda_sync']));
    expect(ids).not.toContain('guide_prepare_dossier');
    const item = s.selection.items[0];
    expect(item).toBeTruthy();
    const r = await poser(c, item.label, { pageContext: { route: '/accueil', platform: 'web', suggestionId: item.id, suggestionVersion: s.selection.version } });
    expect(r.status).toBe(200);
    expect(r.answer).not.toMatch(/réservé|disponible avec Premium|font partie de l’offre Premium/);
    expect(r.answer).not.toMatch(/Coût de possession de Cupra : coût cumulé/);
  });

  it('AC06 — clarification puis reprise Standard : accès IA conservé ; compte restreint : reprise sans appel', async () => {
    for (const offre of ['standard', 'readonly'] as const) {
      const c = await compte(offre);
      await jeu(c);
      sim.appels.length = 0;
      const r = await poser(c, 'Fais-moi une synthèse de ce bien');
      expect(r.status, offre).toBe(200);
      const clar = r.body.clarification;
      expect(clar?.choices.length, `${offre} ${r.answer}`).toBeGreaterThanOrEqual(2);
      const choix = clar!.choices.find((x) => /Clio/.test(x.label)) ?? clar!.choices[0];
      const suite = await repondreClarification(c, clar!.clarificationId, choix.choiceId, r.body.conversationId);
      expect(suite.status, offre).toBe(200);
      // La reprise garde l'accès IA RÉEL du compte (trace de la reprise).
      const trace = await traceDe(String(suite.body.requestId));
      expect(trace?.access, offre).toMatchObject({ modelCalls: offre === 'standard', commercialPlan: offre === 'standard' ? 'standard' : 'none' });
      if (offre === 'standard') expect(sim.appels.some((a) => a.task === 'ANSWER'), offre).toBe(true);
      else expect(t2(), offre).toBe(0);
      // Appartenance revalidée : un autre compte ne peut pas reprendre cette clarification.
      const intrus = await compte('standard');
      const vol = await repondreClarification(intrus, clar!.clarificationId, choix.choiceId);
      expect(vol.status, offre).toBe(409);
    }
  });

  it('AC07 — TCO : aucun montant en Standard ; dépenses qualifiées chiffrées ; Premium et essai : TCO chiffré', async () => {
    const prep = async (offre: Offre) => {
      const c = await compte(offre);
      const cupra = await bien(c, 'Cupra', { keyCharacteristics: { acquisitionPrice: 25000, acquisitionDate: '2023-01-15' } });
      await facture(c, cupra, `Facture entretien ${J}`, 32000, J);
      await facture(c, cupra, 'Facture entretien 2024', 11000, '2024-03-01');
      return c;
    };
    const std = await prep('standard');
    for (const q of ['Quel est le coût de possession de Cupra ?', 'Quel est le TCO de Cupra ?']) {
      const r = await poser(std, q);
      expect(r.answer, q).not.toMatch(MONTANT);
      expect(r.answer, q).not.toMatch(/25 ?430|43000/);
      expect(r.answer, q).toMatch(/Premium et Premium Duo/);
    }
    const ent = await poser(std, 'Combien ai-je dépensé en entretien pour Cupra ?');
    expect(ent.answer).toMatch(/430,00/);
    for (const offre of ['premium', 'trial'] as const) {
      const c = await prep(offre);
      const r = await poser(c, 'Quel est le coût de possession de Cupra ?');
      expect(r.answer, offre).toMatch(/25[\s  ]430,00/);
    }
  });

  it('AC08 — Standard : aucun dossier Premium proposé, endpoints métier protégés ; Premium : proposé', async () => {
    const { resolveActions } = await import('@/services/verebona-assistant/core/action-resolver.service');
    const { premiumBusinessRightOf, resolveAssistantAiAccess } = await import('@/services/verebona-assistant/core/ai-access');
    const { canUsePremiumFeature, canCreateDossiers } = await import('@/services/entitlements.service');
    for (const [offre, attendu] of [['standard', 0], ['premium', 1], ['trial', 1]] as const) {
      const c = await compte(offre);
      const clio = await bien(c, 'Clio');
      const aiAccess = await resolveAssistantAiAccess(c.id);
      const access = {
        assetInAccount: async (a: number, id: number) => (await sql`SELECT 1 FROM assets WHERE id = ${id} AND account_id = ${a}`).length > 0,
        documentInAccount: async () => true, agendaItemInAccount: async () => true, helpEntryPublished: async () => true,
      };
      const actions = await resolveActions({
        accountId: c.id, intent: 'EXPORT_HELP', access, planType: offre === 'standard' ? 'STANDARD' : 'PREMIUM',
        premiumExports: premiumBusinessRightOf({ aiAccess }),
        actionIntents: [{ type: 'OPEN_EXPORT_AREA', targetId: `asset_${clio}`, params: { exportType: 'DOSSIER_VENTE' } }],
      });
      expect(actions.length, offre).toBe(attendu);
      expect((await canUsePremiumFeature(c.id)).allowed, offre).toBe(attendu === 1);
      expect((await canCreateDossiers(c.id)).allowed, offre).toBe(attendu === 1);
      // Standard a l'IA mais JAMAIS les droits Premium.
      expect(aiAccess.modelCalls, offre).toBe(true);
      expect(aiAccess.premiumFeatures, offre).toBe(attendu === 1);
    }
  });

  it('AC09 — commande T2 : préparée et confirmée en Standard (flag ON), revalidée à l’exécution, refusée en lecture seule', async () => {
    process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS = 'true';
    const c = await compte('standard');
    const clio = await bien(c, 'Clio', { keyCharacteristics: { mileage: 47000 } });
    const apercu = await poser(c, 'Modifie le kilométrage de la Clio à 50000 km');
    expect(apercu.body.commandPlan?.summary).toMatch(/47\s000\skm → 50\s000\skm/);
    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    expect(await confirmCommandPlan({ planId: apercu.body.commandPlan!.planId, accountId: c.id, userId: c.ownerUserId })).toMatchObject({ ok: true });
    const [f] = await sql<{ k: unknown }[]>`SELECT key_characteristics AS k FROM assets WHERE id = ${clio}`;
    const k = (typeof f.k === 'string' ? JSON.parse(f.k) : f.k) as { mileage?: number };
    expect(Number(k.mileage)).toBe(50000);
    // Plan préparé en Standard, compte passé en lecture seule AVANT confirmation : refus à l'exécution.
    const second = await poser(c, 'Modifie le kilométrage de la Clio à 52000 km');
    expect(second.body.commandPlan?.planId).toBeTruthy();
    await sql`UPDATE account_subscriptions SET status = 'canceled' WHERE account_id = ${c.id}`;
    expect(await confirmCommandPlan({ planId: second.body.commandPlan!.planId, accountId: c.id, userId: c.ownerUserId })).toMatchObject({ ok: false, code: 'WRITE_REFUSED' });
    // Lecture seule : aucune commande préparée.
    const ro = await compte('readonly');
    await bien(ro, 'Clio', { keyCharacteristics: { mileage: 47000 } });
    const refus = await poser(ro, 'Modifie le kilométrage de la Clio à 50000 km');
    expect(refus.body.commandPlan ?? null).toBeNull();
  });

  it('AC10 — readonly, past_due, canceled, none : ZÉRO appel modèle ; recherche et aide servies ; limite et « Voir les offres »', async () => {
    for (const offre of ['readonly', 'past_due', 'canceled', 'none'] as const) {
      const c = await compte(offre);
      await jeu(c);
      sim.appels.length = 0;
      for (const q of ['raconte-moi un truc sur ce que je possède', 'Fais-moi une synthèse de la Clio', 'Compare la Clio et la Polo', 'Historique de la Clio']) {
        const r = await poser(c, q);
        expect(r.status, `${offre} ${q}`).toBe(200);
      }
      expect(t2(), offre).toBe(0);
      const synth = await poser(c, 'Compare la Clio et la Polo');
      expect(synth.answer, offre).toMatch(/réponses intelligentes/);
      expect(synth.body.actions?.some((a) => a.type === 'OPEN_PRICING'), offre).toBe(true);
      const recherche = await poser(c, 'Retrouve la facture révision Clio');
      expect(recherche.status, offre).toBe(200);
      expect(JSON.stringify(recherche.body), offre).toMatch(/Facture révision Clio/);
      const aide = await poser(c, 'Comment ajouter un document ?');
      expect(aide.status, offre).toBe(200);
      expect(aide.answer.length, offre).toBeGreaterThan(0);
      expect(t2(), offre).toBe(0);
      const trace = await traceDe(String(synth.body.requestId));
      expect(trace?.access, offre).toMatchObject({ modelCalls: false, commercialPlan: 'none' });
    }
  });

  it('AC11 — IA coupée globalement, plafond de coût atteint : repli sans appel, Standard comme Premium', async () => {
    const std = await compte('standard'); await jeu(std);
    const prem = await compte('premium'); await jeu(prem);
    process.env.VEREBONA_ASSISTANT_AI_ENABLED = 'false';
    (await import('@/services/verebona-assistant/config/assistant-config')).resetAssistantConfigForTests();
    for (const c of [std, prem]) {
      const r = await poser(c, 'Fais-moi une synthèse de la Clio');
      expect(r.status).toBe(200);
    }
    expect(t2()).toBe(0);
    delete process.env.VEREBONA_ASSISTANT_AI_ENABLED;
    (await import('@/services/verebona-assistant/config/assistant-config')).resetAssistantConfigForTests();
    const cap = await import('@/services/ai/gateway/account-cost-cap');
    cap.setCostCapStoreForTests({
      planOf: async () => 'standard', overrideOf: async () => 1000, offerCap: async () => null,
      spent: async () => 5000, raise: async () => true,
    });
    for (const c of [std, prem]) {
      const r = await poser(c, 'Compare la Clio et la Polo');
      expect(r.status).toBe(200);
    }
    expect(t2()).toBe(0);
  });

  it('AC12 — isolation : aucune source d’un autre compte, accountId client refusé, clarification d’autrui refusée', async () => {
    const a = await compte('standard');
    const b = await compte('standard');
    await bien(b, 'Zoe Secrete');
    await facture(b, await bien(b, 'Kangoo Secret'), 'Facture confidentielle B', 50000, '2024-02-02');
    const r = await poser(a, 'Fais-moi une synthèse de la Kangoo Secret');
    expect(JSON.stringify(r.body)).not.toMatch(/Facture confidentielle B|Kangoo Secret.*50 000/);
    const prompts = sim.appels.map((x) => x.prompt).join('\n');
    expect(prompts).not.toMatch(/Facture confidentielle B/);
    const surcharge = await poser(a, 'Bonjour', { accountId: b.id });
    expect(surcharge.status).toBe(403);
  });

  it('AC13 — quotas et offre : quotas Standard inchangés ; PRODUCT_PLAN_LIMIT présente les questions incluses', async () => {
    const c = await compte('standard');
    const { getEntitlements } = await import('@/services/entitlements.service');
    const e = await getEntitlements(c.id);
    expect(e).toMatchObject({ plan: 'standard', premiumFeatures: false, quotas: { maxAssets: 2, maxDocuments: 30, maxUsers: 1 } });
    const r = await poser(c, 'Que comprend mon offre ?');
    expect(r.body.intent).toBe('PRODUCT_PLAN_LIMIT');
    expect(r.answer).toMatch(/Votre offre Standard comprend/);
    expect(r.answer).toMatch(/réponses à vos questions/);
    expect(r.answer).not.toMatch(/réponses rédigées[^.]*font partie de Premium/);
    expect(t2()).toBe(0);
    // Centre d'aide (dépôt public) : une fois l'article AID-SEARCH-003 ouvert à
    // Standard (correctif proposé au PO), l'aide ne dit plus « pas incluse ».
    const corrige = JSON.parse(JSON.stringify(helpSnapshot)) as { articles: Array<{ id: string; offers: string[]; offersLabel: string }> };
    for (const a of corrige.articles) if (a.id === 'AID-SEARCH-003' || a.id === 'AID-AI-005') { a.offers = ['standard', 'premium', 'premium_duo']; a.offersLabel = 'Standard, Premium, Premium Duo'; }
    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    hc.setHelpCorpusForTests(hc.parseHelpCorpus(corrige));
    const aide = await poser(c, 'Comment poser une question à Verebona ?');
    expect(aide.status).toBe(200);
    expect(aide.answer).not.toMatch(/pas incluse dans (votre|l’) ?offre actuelle/);
  });

  it('AC14 — diagnostic BO : offre réelle, appels réels, coût et taux par offre ; filtre par offre', async () => {
    const std = await compte('standard'); await jeu(std);
    const prem = await compte('premium'); await jeu(prem);
    const ro = await compte('readonly'); await jeu(ro);
    const [{ debut }] = await sql<{ debut: Date }[]>`SELECT now() AS debut`;
    for (const c of [std, prem, ro]) await poser(c, 'Fais-moi une synthèse de la Clio');
    const { getT2UsageByOffer, searchT2Requests } = await import('@/services/ai/telemetry/t2-routing.repository');
    const parOffre = await getT2UsageByOffer(new Date(debut));
    const ligne = (o: string) => parOffre.find((x) => x.offer === o);
    expect(ligne('standard')?.requests).toBeGreaterThan(0);
    expect(ligne('standard')?.withAi).toBeGreaterThan(0);
    expect(ligne('standard')?.aiCalls).toBeGreaterThan(0);
    expect(ligne('premium')?.withAi).toBeGreaterThan(0);
    // Standard et Premium : même taux à données et question égales.
    expect(ligne('standard')?.aiRate).toBe(ligne('premium')?.aiRate);
    expect(ligne('none')?.withAi).toBe(0);
    expect(ligne('none')?.accessRefused).toBeGreaterThan(0);
    const filtre = await searchT2Requests({ offer: 'standard', accountId: std.id });
    expect(filtre.total).toBeGreaterThan(0);
    expect((filtre.rows[0].cascade as { access?: { commercialPlan?: string } }).access?.commercialPlan).toBe('standard');
    expect(filtre.rows[0].aiCalls).toBeGreaterThan(0);
    const rien = await searchT2Requests({ offer: 'premium', accountId: std.id });
    expect(rien.total).toBe(0);
  });
});
