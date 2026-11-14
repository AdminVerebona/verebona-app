/**
 * Lot 114S — carte #773 « Assistant Verebona — Retirer les 7 suggestions
 * rejetées (catalogue actif et historique) », de bout en bout sur PostgreSQL
 * réel (vraies routes GET /api/suggestions et GET /api/verebona/suggestions,
 * revalidation du clic comme POST /api/verebona/messages, assistant réel).
 *
 *   E01  compte RICHE (tout ce qui faisait autrefois proposer les 7
 *        formulations est présent : dépense de l'année, documents rattachés,
 *        document en analyse, document en erreur, « À traiter », échéance du
 *        jour) : aucune des 7 n'est servie, ni en réserve, par aucune des
 *        deux routes ; mêmes éléments et même version sur les deux ; trois
 *        suggestions au plus ; aucun appel IA (CA01, CA02, CA06) ;
 *   E02  compte PAUVRE (un bien, un document) et compte VIDE : idem ; le
 *        repli reste le guide (CA01) ;
 *   E03  rotation, réserve et clic : après consultation des suggestions
 *        servies, aucune formulation retirée ne prend la place (CA06) ;
 *   E04  un onglet resté ouvert envoie un ancien identifiant : aucune
 *        revalidation, aucune consultation enregistrée ; la question part en
 *        question LIBRE et T2 y répond (CA05) — les 7 formulations ;
 *   E05  Duo et autre compte : même liste personnelle pour les deux membres,
 *        rien d'un compte chez l'autre (CA06) ;
 *   E06  diagnostic BO « Suggestions partagées » : version du stock en
 *        vigueur, aucune entrée retirée dans les suggestions servies ni dans
 *        les candidates écartées, plus de preuve annuelle (point 4.3).
 *
 * Modèle SIMULÉ (aucun réseau), comme L108J / L111L / L112C. Les dates sont
 * relatives au jour courant de Paris lu par le code (jamais une date fixe).
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
type Selection = { version: string; items: Item[]; reserve: Item[] };
type Compte = { id: number; ownerUserId: number };

/** Modèle simulé : UNDERSTAND ne comprend rien ; ANSWER cite la première source d'aide du prompt. */
function modeleSimule() {
  const calls: Array<{ task?: string }> = [];
  const provider = {
    name: 'simule',
    isConfigured: () => true,
    async call(input: { task?: string; prompt: string }) {
      calls.push({ task: input.task });
      if (input.task === 'UNDERSTAND') {
        return { rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'low', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 'simulé' }), inputTokens: 300, outputTokens: 20 };
      }
      if (input.task === 'ANSWER') {
        const ids = [...new Set(input.prompt.match(/\bhelp_[A-Z0-9-]+__[a-z0-9-]+\b/g) ?? [])];
        return {
          rawText: JSON.stringify({
            mode: 'ANSWER', format: 'claims', status: 'answered',
            claims: [{ text: 'Voici la marche à suivre décrite dans l’aide.', sourceIds: ids.slice(0, 1), derivation: 'direct', factual: true }],
          }),
          inputTokens: 1200, outputTokens: 80,
        };
      }
      throw new Error(`[simulé] tâche inattendue ${input.task}`);
    },
  };
  return { calls, provider };
}

/** Anciens identifiants (catalogue) des 7 décisions PO, et forme RENDUE de chaque libellé retiré. */
const IDS_RETIRES = ['home_year_spend', 'home_today', 'home_analysis', 'home_asset_docs', 'asset_docs', 'docs_asset', 'todo_arbitrate', 'account_plan', 'state_failed'];
const LIBELLES_RETIRES: readonly RegExp[] = [
  /^Combien ai-je dépensé en \d{4} \?$/,
  /^Que dois-je faire aujourd[’']hui \?$/,
  /^Où en est l[’']analyse de mes documents \?$/,
  /^Quels sont les documents (de |d[’'])/,
  /^Comment arbitrer entre deux valeurs \?$/,
  /^Que comprend mon offre \?$/,
  /^Pourquoi un document est-il en erreur \?$/,
];
const estRetiree = (x: { id: string; label: string }) =>
  IDS_RETIRES.includes(x.id) || IDS_RETIRES.includes(x.id.replace(/^acc_/, '')) || LIBELLES_RETIRES.some((r) => r.test(x.label));

scenario('L114S-RETR', 'Lot 114S — carte #773 : les 7 suggestions rejetées ne sont plus jamais proposées', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  let sim: ReturnType<typeof modeleSimule>;
  let J = '';
  const FIX = join(__dirname, '../fixtures');
  let resourcesSnapshot: unknown;
  let helpSnapshot: unknown;

  beforeAll(async () => {
    helpSnapshot = JSON.parse(readFileSync(join(FIX, 'help-corpus-t2.snapshot.json'), 'utf8'));
    resourcesSnapshot = JSON.parse(readFileSync(join(FIX, 'ressources-corpus-t2.snapshot.json'), 'utf8'));
    sim = modeleSimule();
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(sim.provider as never);
    J = (await import('@/services/verebona-assistant/core/query-period')).aujourdhuiParis();
  });
  beforeEach(async () => {
    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    hc.setHelpCorpusForTests(hc.parseHelpCorpus(helpSnapshot));
    const rc = await import('@/services/verebona-assistant/core/resources-corpus.service');
    rc.setResourcesCorpusForTests(rc.parseResourcesCorpus(resourcesSnapshot));
    (await import('@/services/suggestions/shared/service')).resetSharedSuggestionsCache();
    (await import('@/services/suggestions/shared/exploit-facts')).resetExploitFactsMemo();
    sim.calls.length = 0;
  });

  const dans = (n: number) => { const [a, m, d] = J.split('-').map(Number); return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10); };
  const compte = async (plan: 'standard' | 'premium' | 'premium_duo' = 'premium'): Promise<Compte> => { const a = await make.account({ plan }); return { id: a.id, ownerUserId: a.ownerUserId }; };
  const bien = async (c: Compte, name: string, champs: Record<string, unknown> = {}, category = 'VEHICULE') => {
    const a = await make.asset(c as never, { name, category, keyCharacteristics: champs });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${a.id}`;
    return a.id;
  };
  const fichier = async (c: Compte, assetId: number | null, titre: string, o: { etat?: string; cents?: number | null; date?: string | null; type?: string | null } = {}) => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${titre}, original_filename = ${`${titre}.pdf`}, analysis_state = ${o.etat ?? 'ANALYZED'}, user_id = ${c.ownerUserId},
              document_type_code = ${o.type ?? null}, amount_cents = ${o.cents ?? null}, supplier = 'Garage Martin', document_date = ${o.date ?? null} WHERE id = ${f.id}`;
    return f.id;
  };
  const echeance = async (c: Compte, assetId: number, title: string, date: string) => {
    const i = await make.agendaItem(c as never, { title, startDate: date, assetIds: [assetId] });
    await sql`UPDATE agenda_items SET event_nature = 'DEADLINE', manual_status = NULL WHERE id = ${i.id}`;
    return i.id;
  };
  /** Compte RICHE : chaque donnée qui déclenchait une des 7 formulations est présente. */
  const compteRiche = async (plan: 'standard' | 'premium' | 'premium_duo' = 'premium') => {
    const c = await compte(plan);
    const cupra = await bien(c, 'Cupra', { warrantyEndDate: dans(300), lastRevision: dans(-40), acquisitionPrice: 25000, acquisitionDate: '2023-01-15' });
    // n° 04 : dépense qualifiée de l'année en cours ; n° 30 : documents rattachés au bien.
    await fichier(c, cupra, 'Facture révision', { cents: 32000, date: J, type: 'MAINTENANCE_INVOICE' });
    await fichier(c, cupra, 'Facture vidange', { cents: 11000, date: dans(-5), type: 'MAINTENANCE_INVOICE' });
    await fichier(c, cupra, 'Carte grise Cupra');
    // n° 29 : document en analyse ; n° 39 : document en erreur ; n° 34 conservée : document sans bien.
    await fichier(c, cupra, 'Diagnostic énergie', { etat: 'ANALYZING' });
    await fichier(c, cupra, 'Scan illisible', { etat: 'ANALYSIS_FAILED' });
    await fichier(c, null, 'Contrat assurance habitation');
    // n° 27 / 33 : « À traiter » ouvert (arbitrage) et échéance du jour.
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
              VALUES (${c.id}, 'ASSET', ${cupra}, 'purchasePriceCents', 'ARBITRATE', 'DATA-ACQUISITION-PRICE', 'Prix d’achat ?')`;
    await echeance(c, cupra, 'Contrôle technique', J);
    await echeance(c, cupra, 'Révision annuelle', dans(10));
    // n° 40 conservée : export prêt.
    await sql`INSERT INTO export_generation (asset_id, account_id, user_id, export_type, status) VALUES (${cupra}, ${c.id}, ${c.ownerUserId}, 'DOSSIER_COMPLET', 'ready')`;
    return { c, cupra };
  };

  const get = async (c: Compte, path: '/api/suggestions' | '/api/verebona/suggestions', userId = c.ownerUserId, route = '/accueil') => {
    session.currentAccountId = c.id; session.userId = userId;
    const mod = path === '/api/suggestions' ? await import('@/app/api/suggestions/route') : await import('@/app/api/verebona/suggestions/route');
    const { NextRequest } = await import('next/server');
    const res = await mod.GET(new NextRequest(`http://x${path}${path === '/api/verebona/suggestions' ? `?route=${encodeURIComponent(route)}` : ''}`));
    expect(res.status).toBe(200);
    return res.json();
  };
  const affichees = async (c: Compte, userId = c.ownerUserId): Promise<Selection> => get(c, '/api/suggestions', userId);
  const historique = async (c: Compte, route = '/accueil', userId = c.ownerUserId): Promise<{ contract: string; version: string; suggestions: Array<{ id: string; label: string }> }> =>
    get(c, '/api/verebona/suggestions', userId, route);
  const tout = (s: Selection) => [...s.items, ...s.reserve];
  /** Aucune formulation retirée, trois au plus, mêmes éléments et même version sur les deux routes. */
  const controler = async (c: Compte, userId = c.ownerUserId): Promise<Selection> => {
    const s = await affichees(c, userId);
    expect(s.items.length).toBeLessThanOrEqual(3);
    for (const x of tout(s)) expect(estRetiree(x), `${x.id} « ${x.label} »`).toBe(false);
    for (const route of ['/accueil', '/assets', '/documents', '/agenda', '/mon-compte', '/accueil/a-traiter']) {
      const h = await historique(c, route, userId);
      expect(h.version, route).toBe(s.version);
      expect(h.suggestions, route).toEqual(s.items.map((x) => ({ id: x.id, label: x.label })));
      for (const x of h.suggestions) expect(estRetiree(x), `${route} ${x.id} « ${x.label} »`).toBe(false);
    }
    return s;
  };

  it('L114S-E2E-01 — CA01/CA02/CA06 : compte riche → aucune des 7 formulations, ni servie ni en réserve, sur les deux routes ; même liste, même version ; aucun appel IA', async () => {
    for (const plan of ['premium', 'standard'] as const) {
      const { c, cupra } = await compteRiche(plan);
      const s = await controler(c);
      // Les questions personnelles CONSERVÉES restent proposées dans leurs conditions (CA04).
      const perso = s.items.filter((x) => x.objective !== 'GUIDE');
      expect(perso.length, plan).toBeGreaterThan(0);
      for (const x of perso) expect(x.assetId ?? cupra, x.label).toBe(cupra);
      if (plan === 'premium') expect(s.items[0]).toMatchObject({ id: 'acc_home_asset_ownership_cost', label: 'Quel est le coût de possession de Cupra ?' });
      else expect(tout(s).map((x) => x.id)).not.toContain('acc_home_asset_ownership_cost');
      // CA02 : total annuel positif et qualifié (factures de l'année) — aucune question annuelle, aucune remplaçante :
      // les questions personnelles promouvables sont exactement celles d'avant, moins la question annuelle.
      const { loadSharedSuggestionContext } = await import('@/services/suggestions/shared/exploit-facts');
      const { reviewAccountCandidates } = await import('@/services/suggestions/shared/service');
      const revue = reviewAccountCandidates((await loadSharedSuggestionContext(c.id, { fresh: true })).ctx);
      expect(revue.accepted.map((x) => x.catalogId).sort(), plan).toEqual([
        'assets_deadlines', 'home_asset_last_service', 'home_asset_maintenance_spend',
        ...(plan === 'premium' ? ['home_asset_ownership_cost'] : []), 'home_asset_warranty_end', 'home_next_deadline',
      ]);
      // Les deux inventaires conservés (n° 34, n° 40) restent écartés : jamais réactivés.
      expect(revue.rejected, plan).toEqual([{ id: 'acc_docs_unlinked', decision: 'INVENTORY_DECLARED' }, { id: 'acc_state_exports', decision: 'INVENTORY_DECLARED' }]);
    }
    expect(sim.calls).toEqual([]);
  });

  it('L114S-E2E-02 — CA01 : compte pauvre (un bien, un document) et compte vide → aucune formulation retirée ; le guide complète', async () => {
    const pauvre = await compte('standard');
    const polo = await bien(pauvre, 'Polo');
    await fichier(pauvre, polo, 'Facture achat');
    const s = await controler(pauvre);
    expect(s.items.length).toBeGreaterThan(0);
    expect(s.items.every((x) => x.objective === 'GUIDE')).toBe(true);
    const vide = await compte('premium');
    const v = await controler(vide);
    expect(v.items).toHaveLength(3);
    expect(v.items.every((x) => x.objective === 'GUIDE')).toBe(true);
    expect(sim.calls).toEqual([]);
  });

  it('L114S-E2E-03 — CA06 : réserve, clic et rotation → aucune formulation retirée ne prend la place d’une suggestion consultée', async () => {
    const { c } = await compteRiche('premium');
    const { resolveSuggestionForMessage } = await import('@/services/suggestions/shared/service');
    const vues = new Set<string>();
    let s = await controler(c);
    // Trois tours : on consulte tout ce qui est servi (revalidation serveur du clic), puis on relit.
    for (let tour = 0; tour < 3; tour += 1) {
      for (const x of s.items) {
        vues.add(x.id);
        const v = await resolveSuggestionForMessage(c.id, c.ownerUserId, x.id, x.label, s.version);
        expect(v, `${x.id} « ${x.label} »`).not.toBeNull();
      }
      const suivante = await controler(c);
      expect(suivante.version).not.toBe(s.version);
      s = suivante;
    }
    for (const id of vues) expect(IDS_RETIRES.map((x) => `acc_${x}`), id).not.toContain(id);
    expect(sim.calls).toEqual([]);
  });

  it('L114S-E2E-04 — CA05 : ancien identifiant (onglet resté ouvert) → aucune revalidation ni consultation ; les 7 questions posées librement sont traitées par T2', async () => {
    const { c } = await compteRiche('premium');
    const { resolveSuggestionForMessage } = await import('@/services/suggestions/shared/service');
    const annee = J.slice(0, 4);
    const QUESTIONS: Array<{ ancien: string[]; texte: string; intent: string; reponse?: RegExp; sansModele?: boolean }> = [
      { ancien: ['acc_home_year_spend', 'home_year_spend'], texte: `Combien ai-je dépensé en ${annee} ?`, intent: 'ACCOUNT_FACT_ASSET', reponse: /430,00/, sansModele: true },
      { ancien: ['home_today'], texte: 'Que dois-je faire aujourd’hui ?', intent: 'ACCOUNT_TO_PROCESS', reponse: /Contrôle technique/, sansModele: true },
      { ancien: ['acc_home_analysis', 'home_analysis'], texte: 'Où en est l’analyse de mes documents ?', intent: 'ACCOUNT_FACT_DOCUMENT' },
      { ancien: ['acc_home_asset_docs', 'home_asset_docs', 'asset_docs', 'docs_asset'], texte: 'Quels sont les documents de Cupra ?', intent: 'ACCOUNT_SEARCH_DOCUMENT', reponse: /Carte grise Cupra|Facture/ },
      { ancien: ['todo_arbitrate'], texte: 'Comment arbitrer entre deux valeurs ?', intent: 'PRODUCT_HELP_HOW_TO' },
      { ancien: ['account_plan'], texte: 'Que comprend mon offre ?', intent: 'PRODUCT_PLAN_LIMIT' },
      { ancien: ['state_failed'], texte: 'Pourquoi un document est-il en erreur ?', intent: 'PRODUCT_HELP_STATUS' },
    ];
    for (const q of QUESTIONS) {
      // L'ancienne référence (version d'avant la carte) n'est plus revalidée : question libre, sans privilège.
      for (const id of q.ancien) expect(await resolveSuggestionForMessage(c.id, c.ownerUserId, id, q.texte, '7523f7a3be3a'), id).toBeNull();
      sim.calls.length = 0;
      const r = await demander(c, q.texte, { pageContext: { route: '/accueil', platform: 'web' } });
      // Aucune interdiction lexicale : T2 comprend la question (routage déterministe) et produit une issue normale
      // — réponse, clarification ou absence de données selon le contexte —, jamais un refus ni une erreur.
      expect(r.route?.intent, q.texte).toBe(q.intent);
      expect(sim.calls.some((x) => x.task === 'UNDERSTAND'), q.texte).toBe(false);
      expect(String(r.answer ?? '').trim().length, q.texte).toBeGreaterThan(0);
      expect(String(r.answer ?? ''), q.texte).not.toMatch(/une erreur|n’est plus disponible|ne peux pas répondre à cette question/i);
      if (q.reponse) expect(String(r.answer ?? ''), q.texte).toMatch(q.reponse);
      if (q.sansModele) expect(sim.calls, q.texte).toEqual([]);
    }
    expect((await sql`SELECT count(*)::int AS n FROM shared_suggestion_consultations WHERE account_id = ${c.id}`)[0].n).toBe(0);
  });

  it('L114S-E2E-05 — CA06 : Duo → même liste personnelle pour les deux membres ; autre compte → rien du premier ; changement de compte → aucune formulation retirée', async () => {
    const { c } = await compteRiche('premium_duo');
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${c.id}, ${membre.id}, 'member', 'active')`;
    const titulaire = await controler(c);
    const second = await controler(c, membre.id);
    const perso = (s: Selection) => s.items.filter((x) => x.objective !== 'GUIDE').map((x) => `${x.id}:${x.label}:${x.assetId ?? ''}`);
    expect(perso(titulaire).length).toBeGreaterThan(0);
    expect(perso(second)).toEqual(perso(titulaire));
    // Autre compte (changement de compte dans la même session de test) : sa propre liste, rien de « Cupra ».
    const autre = await compte('premium');
    await bien(autre, 'Clio');
    const z = await controler(autre);
    expect(tout(z).some((x) => x.label.includes('Cupra'))).toBe(false);
    expect(z.version).not.toBe(titulaire.version);
    // Retour au premier compte : toujours aucune formulation retirée.
    await controler(c);
    expect(sim.calls).toEqual([]);
  });

  it('L114S-E2E-06 — diagnostic BO « Suggestions partagées » : version du stock en vigueur, aucune entrée retirée, plus de preuve annuelle', async () => {
    const { c } = await compteRiche('premium');
    const svc = await import('@/services/suggestions/shared/service');
    const { diagnostic, selection } = await svc.getSharedSuggestions(c.id, c.ownerUserId);
    expect(diagnostic.code).toBe('OK');
    expect(diagnostic.exploit).toMatchObject({ premium: true, proven: { spend: 1, maintenance: 1, warranty: 1, lastService: 1 } });
    expect(Object.keys(diagnostic.exploit!.proven).sort()).toEqual(['lastService', 'maintenance', 'spend', 'warranty']);
    for (const x of diagnostic.notUseful ?? []) expect(estRetiree({ id: x.id, label: '' }), x.id).toBe(false);
    expect(diagnostic.quota).toMatchObject({ max: 3, served: selection.items.length });
    // Version du stock : celle du code livré, différente de la version d'avant la carte.
    expect(svc.STOCK_VERSION).not.toBe('7523f7a3be3a');

    // Rapport écrit pour le BO (T6, périmètre SUGGESTIONS) : étapes, compteurs et suggestions servies.
    let rep: Array<{ id: number; steps: unknown; counters: Record<string, number> }> = [];
    for (let i = 0; i < 40 && rep.length === 0; i += 1) {
      rep = await sql`SELECT id, steps, counters FROM ai_execution_reports WHERE account_id = ${c.id} AND treatment = 'T6' AND scope = 'SUGGESTIONS' ORDER BY id DESC LIMIT 1`;
      if (rep.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(rep).toHaveLength(1);
    const steps = (typeof rep[0].steps === 'string' ? JSON.parse(rep[0].steps) : rep[0].steps) as Array<{ step: string; detail?: Record<string, unknown> }>;
    expect(steps.find((x) => x.step === 'stock')?.detail).toMatchObject({ stockVersion: svc.STOCK_VERSION });
    expect(steps.find((x) => x.step === 'selection')?.detail).toMatchObject({ version: selection.version });
    const lignes = await sql`SELECT field_key, value FROM ai_execution_report_entries WHERE report_id = ${rep[0].id} ORDER BY seq`;
    const texte = JSON.stringify(lignes.map((x) => ({ k: x.field_key, v: x.value })));
    for (const id of IDS_RETIRES) expect(texte, id).not.toMatch(new RegExp(`"(acc_)?${id}"`));
    expect(texte).not.toContain('yearSpend');
    const servies = lignes.filter((x) => String(x.field_key).startsWith('item_'));
    expect(servies).toHaveLength(selection.items.length);
    for (const x of servies) expect(IDS_RETIRES.map((i) => `acc_${i}`)).not.toContain((x.value as { id: string }).id);
  });
});
