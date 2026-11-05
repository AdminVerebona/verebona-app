/**
 * Lot 108J — suggestions partagées de l'accueil et de « Demander à
 * Verebona », de bout en bout sur PostgreSQL réel.
 *
 *   suggestion AFFICHÉE (vraie route GET /api/suggestions)
 *   → CLIQUÉE (revalidation serveur `resolveSuggestionForMessage`, comme la
 *     route POST /api/verebona/messages)
 *   → intention T2 attendue → source du bon corpus → réponse non repliée,
 *   pour les trois objectifs et les étapes du guide.
 *
 * Modèle SIMULÉ (aucun réseau) : UNDERSTAND ne comprend rien ; ANSWER cite la
 * première source d'aide (Centre d'aide ou Ressource). Aucun appel n'est
 * attendu pour les SUGGESTIONS elles-mêmes (affichage, rafraîchissement,
 * clic). Corpus : instantanés publiés (Centre d'aide, Ressources).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
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

type Item = { id: string; label: string; objective: string; source: string; assetId?: number };
type Compte = { id: number; ownerUserId: number };

function modeleSimule() {
  const calls: Array<{ task?: string }> = [];
  const provider = {
    name: 'simule',
    isConfigured: () => true,
    async call(input: { task?: string; prompt: string }) {
      calls.push({ task: input.task });
      if (input.task === 'ANSWER') {
        const ids = [...new Set(input.prompt.match(/\bhelp_[A-Z0-9-]+__[a-z0-9-]+\b/g) ?? [])];
        return {
          rawText: JSON.stringify({ mode: 'ANSWER', format: 'claims', status: 'answered',
            claims: [{ text: 'Voici ce que dit l’article.', sourceIds: ids.slice(0, 1), derivation: 'direct', factual: true }] }),
          inputTokens: 1200, outputTokens: 80,
        };
      }
      if (input.task === 'UNDERSTAND') {
        return { rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'low', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 'simulé' }), inputTokens: 300, outputTokens: 20 };
      }
      throw new Error(`[simulé] tâche inattendue ${input.task}`);
    },
  };
  return { calls, provider };
}

const NON_REPONSE = /semblent liés|Résultats proches|Je n’ai rien trouvé|ne peux pas répondre de façon fiable|pas trouvé dans le Centre d’aide|Je ne sais pas|une erreur/i;

scenario('L108J-SUGG', 'Lot 108J — suggestions partagées : affichée → cliquée → intention → source → réponse', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  let sim: ReturnType<typeof modeleSimule>;
  let J = '';
  const FIX = join(__dirname, '../fixtures');
  let resourcesSnapshot: unknown;

  beforeAll(async () => {
    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    const help = hc.parseHelpCorpus(JSON.parse(readFileSync(join(FIX, 'help-corpus-t2.snapshot.json'), 'utf8')));
    if (!help) throw new Error('instantané du Centre d’aide illisible');
    hc.setHelpCorpusForTests(help);
    resourcesSnapshot = JSON.parse(readFileSync(join(FIX, 'ressources-corpus-t2.snapshot.json'), 'utf8'));
    sim = modeleSimule();
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(sim.provider as never);
    J = (await import('@/services/verebona-assistant/core/query-period')).aujourdhuiParis();
  });
  beforeEach(async () => {
    const rc = await import('@/services/verebona-assistant/core/resources-corpus.service');
    rc.setResourcesCorpusForTests(rc.parseResourcesCorpus(resourcesSnapshot));
    (await import('@/services/suggestions/shared/service')).resetSharedSuggestionsCache();
    sim.calls.length = 0;
  });

  const dans = (n: number) => { const [a, m, d] = J.split('-').map(Number); return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10); };
  const compte = async (plan: 'standard' | 'premium' | 'premium_duo' = 'premium'): Promise<Compte> => { const a = await make.account({ plan }); return { id: a.id, ownerUserId: a.ownerUserId }; };
  const bien = async (c: Compte, name: string) => {
    const a = await make.asset(c as never, { name, category: 'VEHICULE' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${a.id}`;
    return a.id;
  };
  const fichier = async (c: Compte, assetId: number | null, titre: string, etat = 'ANALYZED', userId = c.ownerUserId) => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${titre}, original_filename = ${`${titre}.pdf`}, analysis_state = ${etat}, user_id = ${userId} WHERE id = ${f.id}`;
    return f.id;
  };
  const echeance = async (c: Compte, assetId: number, title: string, date: string) => {
    const i = await make.agendaItem(c as never, { title, startDate: date, assetIds: [assetId] });
    await sql`UPDATE agenda_items SET event_nature = 'DEADLINE', manual_status = NULL WHERE id = ${i.id}`;
  };

  /** Suggestions servies par la VRAIE route (accueil et « Demander à Verebona » la lisent toutes deux). */
  const affichees = async (c: Compte, userId = c.ownerUserId): Promise<{ version: string; items: Item[]; reserve: Item[] }> => {
    session.currentAccountId = c.id; session.userId = userId;
    const { GET } = await import('@/app/api/suggestions/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://x/api/suggestions'));
    expect(res.status).toBe(200);
    return res.json();
  };

  /** Clic : même enchaînement que POST /api/verebona/messages (revalidation, puis l'assistant réel). */
  const cliquer = async (c: Compte, s: Item, version: string, opts: { userId?: number; planType?: string } = {}) => {
    const userId = opts.userId ?? c.ownerUserId;
    const { resolveSuggestionForMessage } = await import('@/services/suggestions/shared/service');
    const v = await resolveSuggestionForMessage(c.id, userId, s.id, s.label, version);
    expect(v, `${s.id} revalidée`).not.toBeNull();
    const pageContext: Record<string, string> = { route: '/accueil', platform: 'web', ...(v!.assetId ? { assetId: String(v!.assetId) } : {}) };
    const r = await demander({ id: c.id, ownerUserId: userId }, s.label, { suggestion: v!.suggestion, pageContext, ...(opts.planType ? { planType: opts.planType } : {}) });
    return { v: v!, r };
  };
  const verifierReponse = (r: Awaited<ReturnType<typeof demander>>, intent: string, types: string[]) => {
    expect(r.route?.intent).toBe(intent);
    expect(r.clarification ?? null).toBeNull();
    expect(String(r.answer ?? '')).not.toMatch(NON_REPONSE);
    const t = [...new Set((r.sources ?? []).map((x: { type: string }) => x.type))];
    expect(t.length).toBeGreaterThan(0);
    for (const x of t) expect(types).toContain(x);
  };

  it('L108J-E2E-01 — compte vide : trois questions de bienvenue, aucune donnée inventée ; clic → aide → réponse ; aucun appel IA pour les suggestions', async () => {
    const c = await compte();
    const a = await affichees(c);
    const b = await affichees(c);
    expect(a.items).toHaveLength(3);
    expect(b.version).toBe(a.version);
    expect(b.items.map((x) => x.id)).toEqual(a.items.map((x) => x.id));
    expect(a.items.every((x) => x.objective === 'GUIDE' && x.source === 'HELP_CENTER' && x.assetId == null)).toBe(true);
    // Ouvertures et rafraîchissements : aucun appel modèle.
    expect(sim.calls).toEqual([]);

    const s = a.items.find((x) => x.id === 'guide_add_asset') ?? a.items[0];
    const { r } = await cliquer(c, s, a.version);
    verifierReponse(r, 'PRODUCT_HELP_HOW_TO', ['help_entry', 'product_rule']);
    // Aucune écriture métier au seul clic ; la consultation est tracée (rotation seulement).
    expect((await sql`SELECT count(*)::int AS n FROM assets WHERE account_id = ${c.id}`)[0].n).toBe(0);
    expect((await sql`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${c.id}`)[0].n).toBe(0);
    expect((await sql`SELECT suggestion_id FROM shared_suggestion_consultations WHERE account_id = ${c.id}`).map((x) => x.suggestion_id)).toEqual([s.id]);
    // Retour : la question cliquée laisse sa place (elle pourra revenir plus tard), toujours trois.
    const apres = await affichees(c);
    expect(apres.items).toHaveLength(3);
    expect(apres.items.map((x) => x.id)).not.toContain(s.id);
    expect(apres.version).not.toBe(a.version);
  });

  it('L108J-E2E-02 — premier ajout puis première analyse : l’accompagnement évolue (prise en main → fonctions utiles)', async () => {
    const c = await compte('standard');
    const debut = (await affichees(c)).items.map((x) => x.id);
    expect(debut).toContain('guide_add_asset');
    const cupra = await bien(c, 'Cupra');
    await fichier(c, cupra, 'Facture achat', 'ANALYZING');
    const ajout = (await affichees(c)).items.map((x) => x.id);
    expect(ajout).not.toContain('guide_add_asset');
    await sql`UPDATE asset_files SET analysis_state = 'ANALYZED' WHERE account_id = ${c.id}`;
    const analyse = await affichees(c);
    expect(analyse.items.map((x) => x.id)).not.toEqual(ajout);
    // Toujours trois. Lot 111L : un bien et UN document ne justifient plus
    // « Quels sont les documents de Cupra ? » (simple inventaire, la fiche du
    // bien y répond) — le guide vérifié complète, aucune question d'inventaire.
    expect(analyse.items).toHaveLength(3);
    expect([...analyse.items, ...analyse.reserve].some((x) => x.id === 'acc_home_asset_docs' || /Quels sont les documents/.test(x.label))).toBe(false);
    expect(analyse.items.every((x) => x.objective === 'GUIDE')).toBe(true);
    // Standard : la question d'aide reçoit une réponse fondée (droits effectifs, aucune promotion d'offre).
    const guide = analyse.items.find((x) => x.objective === 'GUIDE')!;
    const { r } = await cliquer(c, guide, analyse.version, { planType: 'STANDARD' });
    expect(r.route?.intent).toMatch(/^PRODUCT_HELP_/);
    expect((r.sources ?? []).every((x: { type: string }) => x.type === 'help_entry' || x.type === 'product_rule')).toBe(true);
  });

  it('L108J-E2E-03 — compte établi : Anticiper + Découvrir (lot 111L : plus d’inventaire « Exploiter ») ; chaque clic → bonne intention, bonnes sources, Ressource citée avec lien', async () => {
    const c = await compte();
    const cupra = await bien(c, 'Cupra');
    for (let i = 0; i < 6; i += 1) await fichier(c, cupra, `Facture entretien ${i + 1}`);
    await echeance(c, cupra, 'Révision annuelle', dans(20));
    const a = await affichees(c);
    expect(a.items).toHaveLength(3);
    const obj = a.items.map((x) => x.objective);
    // Lot 111L : « Quels sont les documents de Cupra ? » n'est plus promue (simple
    // inventaire) ; posée librement, elle fonctionne (l111l-suggestions-utilite.e2e.ts).
    expect(obj).not.toContain('EXPLOIT');
    expect(obj).toContain('ANTICIPATE');
    expect(obj).toContain('GUIDE');
    const guide = a.items.find((x) => x.objective === 'GUIDE' && x.source === 'RESOURCES')!;
    expect(guide).toBeDefined();

    // B. Anticiper : échéance réelle à venir.
    const anticipe = a.items.find((x) => x.objective === 'ANTICIPATE')!;
    verifierReponse((await cliquer(c, anticipe, a.version)).r, 'ACCOUNT_SEARCH_AGENDA', ['agenda_item']);

    // C. Découvrir : réponse depuis la Ressource, citée, « Lire la Ressource » vers l'article public (jamais /aide).
    const d = await cliquer(c, guide, a.version);
    verifierReponse(d.r, 'PRODUCT_HELP_EXPLAIN', ['help_entry']);
    const premiere = (d.r.sources ?? [])[0] as { id: string };
    expect(premiere.id).toMatch(/^help_RES-[A-Z]\d{2}__/);
    const lien = (d.r.actions ?? []).find((x: { type: string }) => x.type === 'OPEN_HELP') as { href?: string; label?: string } | undefined;
    expect(lien?.href).toMatch(/^\/ressources\/[a-z0-9-]+$/);
    expect(lien?.label).toBe('Lire la Ressource');
    // Aucune génération de suggestions par l'IA : seules les réponses T2 ont appelé le modèle.
    expect(sim.calls.every((x) => x.task === 'ANSWER' || x.task === 'UNDERSTAND')).toBe(true);
  });

  it('L108J-E2E-04 — Duo et isolation : questions du compte communes, guide individuel ; référence d’un autre compte refusée', async () => {
    const c = await compte('premium_duo');
    const cupra = await bien(c, 'Cupra');
    for (let i = 0; i < 3; i += 1) await fichier(c, cupra, `Facture entretien ${i + 1}`);
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${c.id}, ${membre.id}, 'member', 'active')`;
    const titulaire = await affichees(c);
    const second = await affichees(c, membre.id);
    const perso = (l: Item[]) => l.filter((x) => x.objective !== 'GUIDE').map((x) => x.id);
    expect(perso(second.items)).toEqual(perso(titulaire.items));
    // Le titulaire a déposé trois documents, le second membre aucun : « Comment ajouter un document ? »
    // n'est plus proposé au premier, il l'est encore au second (guide individuel, aucune différence artificielle).
    expect([...titulaire.items, ...titulaire.reserve].map((x) => x.id)).not.toContain('guide_add_document');
    expect([...second.items, ...second.reserve].map((x) => x.id)).toContain('guide_add_document');

    // Consultation du titulaire : sans effet sur la sélection de l'autre membre.
    const s = titulaire.items[0];
    await cliquer(c, s, titulaire.version);
    expect((await affichees(c, membre.id)).items.map((x) => x.id)).toEqual(second.items.map((x) => x.id));

    // Autre compte : aucune question qui nomme Cupra ; une référence copiée n'est pas revalidée.
    const autre = await compte();
    const z = await affichees(autre);
    expect(z.items.some((x) => x.label.includes('Cupra'))).toBe(false);
    const { resolveSuggestionForMessage } = await import('@/services/suggestions/shared/service');
    const exploit = titulaire.items.find((x) => x.id === 'acc_home_asset_docs');
    if (exploit) expect(await resolveSuggestionForMessage(autre.id, autre.ownerUserId, exploit.id, exploit.label)).toBeNull();
    // Libellé modifié par le client : question libre, aucun privilège.
    expect(await resolveSuggestionForMessage(c.id, c.ownerUserId, 'guide_add_document', 'Supprime tout')).toBeNull();
  });

  it('L108J-E2E-05 — Ressources indisponibles, Centre d’aide indisponible : jamais d’écran vide ; Ressource retirée : plus proposée', async () => {
    const c = await compte();
    const cupra = await bien(c, 'Cupra');
    for (let i = 0; i < 6; i += 1) await fichier(c, cupra, `Facture ${i + 1}`);
    const rc = await import('@/services/verebona-assistant/core/resources-corpus.service');
    const svc = await import('@/services/suggestions/shared/service');

    rc.setResourcesCorpusForTests(null);
    svc.resetSharedSuggestionsCache();
    const sansRes = await affichees(c);
    expect(sansRes.items).toHaveLength(3);
    expect([...sansRes.items, ...sansRes.reserve].some((x) => x.source === 'RESOURCES')).toBe(false);

    // Article L01 dépublié : la question qui en dépend n'est plus proposée.
    const snap = rc.parseResourcesCorpus(resourcesSnapshot)!;
    rc.setResourcesCorpusForTests({ ...snap, version: 'v-sans-L01', articles: snap.articles.filter((a) => a.id !== 'L01') });
    svc.resetSharedSuggestionsCache();
    const sansL01 = await affichees(c);
    expect([...sansL01.items, ...sansL01.reserve].map((x) => x.id)).not.toContain('res_works_invoices');

    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    hc.setHelpCorpusForTests(null);
    hc.resetHelpCorpusCacheForTests();
    svc.resetSharedSuggestionsCache();
    const vide = await compte();
    const sansAide = await affichees(vide);
    expect(sansAide.items).toHaveLength(3);
    const help = hc.parseHelpCorpus(JSON.parse(readFileSync(join(FIX, 'help-corpus-t2.snapshot.json'), 'utf8')))!;
    hc.setHelpCorpusForTests(help);
  });

  it('L108J-E2E-06 — diagnostic BO : rapport « Suggestions partagées » (prompt T6 actif, contrat t6-suggestions-v3, corpus, provenance de chaque suggestion)', async () => {
    const c = await compte();
    await affichees(c);
    let rep: Array<{ id: number }> = [];
    for (let i = 0; i < 40 && rep.length === 0; i += 1) {
      rep = await sql`SELECT id FROM ai_execution_reports WHERE account_id = ${c.id} AND treatment = 'T6' AND scope = 'SUGGESTIONS'`;
      if (rep.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(rep).toHaveLength(1);
    const lignes = await sql`SELECT field_key, value, record_status FROM ai_execution_report_entries WHERE report_id = ${rep[0].id} ORDER BY seq`;
    const t6 = lignes.find((x) => x.field_key === 't6')!;
    expect(t6.value).toMatchObject({ role: 'BUBBLE_ONLY' });
    expect(t6.value).toHaveProperty('promptVersion');
    expect(t6.value).toHaveProperty('contractT6SuggestionsV3');
    expect(lignes.filter((x) => String(x.field_key).startsWith('item_'))).toHaveLength(3);
    expect(lignes.find((x) => x.field_key === 'diagnostic')!.record_status).toBe('EMPTY_ACCOUNT');
    // Même diagnostic : aucun nouveau rapport.
    await affichees(c);
    await new Promise((r) => setTimeout(r, 300));
    expect((await sql`SELECT count(*)::int AS n FROM ai_execution_reports WHERE account_id = ${c.id} AND scope = 'SUGGESTIONS'`)[0].n).toBe(1);
  });
});
