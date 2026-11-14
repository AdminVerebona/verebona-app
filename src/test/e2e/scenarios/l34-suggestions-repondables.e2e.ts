/**
 * Lot 34 — ticket « ne proposer que des questions pertinentes et réellement
 * répondables par T2 » : TEST CONTRACTUEL DU CATALOGUE, de bout en bout sur
 * PostgreSQL réel.
 *
 * Pour CHAQUE suggestion du catalogue unique (`ALL_SUGGESTIONS`) :
 *
 *   préconditions satisfaites (données réelles créées pour elle seule)
 *   → suggestion AFFICHÉE (catalogue de la page rendu avec le contexte serveur
 *     RÉEL — lot 112C : la route `/api/verebona/suggestions` sert désormais la
 *     sélection partagée, vérifiée par l112c-suggestions-exploiter.e2e.ts ; le
 *     catalogue est lu ici avec le même contexte qu'elle, faits « Exploiter »
 *     prouvés compris)
 *   → CLIQUÉE (le libellé, avec le contexte que le champ / la mascotte envoie)
 *   → intention T2 attendue (`canonicalIntent`)
 *   → sources du domaine attendu (`SUGGESTION_DOMAIN_SOURCES`)
 *   → réponse NON fallback (ni « semblent liés », ni « résultats proches »,
 *     ni « rien trouvé », ni clarification, ni erreur).
 *
 * Une entrée absente de ce parcours fait échouer le test : une suggestion
 * qui ne satisfait pas ce contrat n'est pas publiable.
 *
 * Carte #773 (lot 114S) : sept formulations sont retirées du catalogue
 * (`home_year_spend`, `home_today`, `home_analysis`, `home_asset_docs`,
 * `asset_docs`, `docs_asset`, `todo_arbitrate`, `account_plan`,
 * `state_failed`). Le contrat porte sur les entrées RESTANTES, toutes
 * vérifiées ; les cas réels qui imposaient ces libellés imposent désormais
 * leur absence (règles remplacées, voir chaque test).
 *
 * Modèle SIMULÉ (aucun réseau) : UNDERSTAND ne comprend rien (les questions
 * doivent être routées sans lui) ; ANSWER cite la première source d'aide.
 * Centre d'aide : instantané publié (`fixtures/help-corpus-t2.snapshot.json`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, expect, it, vi } from 'vitest';
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
type Entree = import('@/services/verebona-assistant/registries/capability-registry').SuggestionEntry;

/** Modèle simulé : UNDERSTAND ne comprend rien ; ANSWER cite la première source d'aide du prompt. */
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
          rawText: JSON.stringify({
            mode: 'ANSWER', format: 'claims', status: 'answered',
            claims: [{ text: 'Voici la marche à suivre décrite dans l’aide.', sourceIds: ids.slice(0, 1), derivation: 'direct', factual: true }],
          }),
          inputTokens: 1200, outputTokens: 80,
        };
      }
      if (input.task === 'UNDERSTAND') {
        return {
          rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'low', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 'simulé' }),
          inputTokens: 300, outputTokens: 20,
        };
      }
      throw new Error(`[simulé] tâche inattendue ${input.task}`);
    },
  };
  return { calls, provider };
}


/** Réponses qui ne sont PAS une réponse (repli, aveu, erreur). */
const NON_REPONSE = /semblent liés|Résultats proches|Je n’ai rien trouvé|ne peux pas répondre de façon fiable|pas trouvé dans le Centre d’aide|Je ne sais pas|n’est plus disponible|une erreur/i;

scenario('L34-SUGG', 'Lot 34 — chaque suggestion affichée → cliquée → intention → domaine → réponse non fallback', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });

  let sim: ReturnType<typeof modeleSimule>;
  let J = '';
  const dans = (n: number) => {
    const [a, m, d] = J.split('-').map(Number);
    return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
  };

  beforeAll(async () => {
    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    const corpus = hc.parseHelpCorpus(JSON.parse(readFileSync(join(__dirname, '../fixtures/help-corpus-t2.snapshot.json'), 'utf8')));
    if (!corpus) throw new Error('instantané du Centre d’aide illisible');
    hc.setHelpCorpusForTests(corpus);
    sim = modeleSimule();
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(sim.provider as never);
    J = (await import('@/services/verebona-assistant/core/query-period')).aujourdhuiParis();
  });

  const compte = async (plan: 'premium' | 'standard' = 'premium'): Promise<Compte> => { const a = await make.account({ plan }); return { id: a.id, ownerUserId: a.ownerUserId }; };
  const bien = async (c: Compte, name: string) => {
    const a = await make.asset(c as never, { name, category: 'VEHICULE' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${a.id}`;
    return a.id;
  };
  const fichier = async (c: Compte, assetId: number | null, titre: string, etat = 'ANALYZED') => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${titre}, original_filename = ${`${titre}.pdf`}, analysis_state = ${etat} WHERE id = ${f.id}`;
    return f.id;
  };
  const echeance = async (c: Compte, assetId: number, title: string, date: string) => {
    const i = await make.agendaItem(c as never, { title, startDate: date, assetIds: [assetId] });
    await sql`UPDATE agenda_items SET event_nature = 'DEADLINE', manual_status = NULL WHERE id = ${i.id}`;
    return i.id;
  };

  /** Compte dont les données satisfont EXACTEMENT les préconditions de l'entrée. */
  const preparer = async (e: Entree): Promise<{ c: Compte; assetId: number | null }> => {
    const req = new Map((e.requires ?? []).map((r) => [r.fact, r.is]));
    // Lot 112C : « dépenses d'entretien » partage le sujet du coût de possession (Premium) — compte Standard
    // pour qu'elle soit la question de son sujet (l'offre ne change pas la réponse calculée).
    const c = await compte(req.has('asset.maintenanceSpend') && !req.has('ownershipCostAvailable') ? 'standard' : 'premium');
    const sansBien = req.get('assetsTotal') === 'zero';
    const sansDocument = sansBien || req.get('documentsTotal') === 'zero';
    const cupra = sansBien ? null : await bien(c, 'Cupra');
    if (cupra && !sansDocument) await fichier(c, cupra, 'Facture entretien garage');
    for (const [fact, is] of req) {
      if (is !== 'positive') continue;
      switch (fact) {
        case 'toProcessPending':
          await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
                    VALUES (${c.id}, 'ASSET', ${cupra}, 'purchasePriceCents', 'ARBITRATE', 'DATA-ACQUISITION-PRICE', 'Prix d’achat ?')`;
          break;
        case 'actionsDueToday': await echeance(c, cupra!, 'Contrôle technique', J); break;
        case 'deadlinesSoon': case 'deadlinesUpcoming': case 'asset.deadlines': await echeance(c, cupra!, 'Révision annuelle', dans(10)); break;
        case 'documentsInAnalysis': await fichier(c, cupra, 'Diagnostic énergie', 'ANALYZING'); break;
        case 'documentsUnlinked': await fichier(c, null, 'Contrat assurance habitation'); break;
        case 'exportsReady':
          await sql`INSERT INTO export_generation (asset_id, account_id, user_id, export_type, status)
                    VALUES (${cupra}, ${c.id}, ${c.ownerUserId}, 'DOSSIER_COMPLET', 'ready')`;
          break;
        // Lot 112C — faits « Exploiter » prouvés par les lectures de T2.
        case 'asset.spend': case 'asset.maintenanceSpend': {
          const f = await fichier(c, cupra, 'Facture révision garage');
          await sql`UPDATE asset_files SET document_type_code = 'MAINTENANCE_INVOICE', amount_cents = 32000, supplier = 'Garage Martin', document_date = ${J} WHERE id = ${f}`;
          break;
        }
        case 'asset.warrantyUpcoming':
          await sql`UPDATE assets SET key_characteristics = jsonb_set(coalesce(nullif(key_characteristics, '')::jsonb, '{}'::jsonb), '{warrantyEndDate}', to_jsonb(${dans(400)}::text))::text WHERE id = ${cupra}`;
          break;
        case 'asset.lastService':
          await sql`UPDATE assets SET key_characteristics = jsonb_set(coalesce(nullif(key_characteristics, '')::jsonb, '{}'::jsonb), '{lastRevision}', to_jsonb(${dans(-60)}::text))::text WHERE id = ${cupra}`;
          break;
        case 'ownershipCostAvailable': break; // compte Premium
        default: throw new Error(`précondition non préparée : ${fact}`);
      }
    }
    return { c, assetId: cupra };
  };

  const routeDe = (e: Entree, assetId: number | null) =>
    e.routeExact?.[1] ?? e.routeExact?.[0] ?? e.routePrefix ?? (e.routePattern ? `/assets/${assetId}` : '/fournisseurs');

  /**
   * Exemples d'une page : catalogue rendu avec le contexte serveur RÉEL de la page
   * (état du compte, biens nommés) ET les faits « Exploiter » prouvés (lot 112C).
   * Lot 112C : la route `/api/verebona/suggestions` est alignée sur le service
   * partagé (même sélection que /api/suggestions, l112c-suggestions-exploiter.e2e.ts) ;
   * ce contrat porte sur le CATALOGUE, lu ici comme elle le lisait.
   */
  const exemples = async (c: Compte, route: string): Promise<Array<{ id: string; label: string }>> => {
    session.currentAccountId = c.id; session.userId = c.ownerUserId;
    const { suggestionsForRoute } = await import('@/services/verebona-assistant/registries/capability-registry');
    const { loadSharedSuggestionContext } = await import('@/services/suggestions/shared/exploit-facts');
    const { ctx } = await loadSharedSuggestionContext(c.id, { route, fresh: true });
    return suggestionsForRoute(route, ctx).map((s) => ({ id: s.id, label: s.label }));
  };

  /** Contexte envoyé par le champ « Demander à Verebona ». */
  const contexte = async (route: string) => {
    const { buildPageContext } = await import('@/lib/verebona/page-context');
    const { enrichPageContext } = await import('@/lib/help-center/screens');
    const { sanitizePageContext } = await import('@/services/verebona-assistant/core/page-context');
    return sanitizePageContext(enrichPageContext(buildPageContext(route), 'web'));
  };

  it('CONTRAT — chaque suggestion publiable : affichée → cliquée → intention attendue → source du bon domaine → réponse non fallback', async () => {
    const { ALL_SUGGESTIONS, SUGGESTION_DOMAIN_SOURCES } = await import('@/services/verebona-assistant/registries/capability-registry');
    const echecs: string[] = [];
    const verifies: string[] = [];

    for (const e of ALL_SUGGESTIONS) {
      const { c, assetId } = await preparer(e);
      const route = routeDe(e, assetId);

      // 1. Affichée (champ desktop / espace mobile : vraie route API).
      const affichees = await exemples(c, route);
      const s = affichees.find((x) => x.id === e.id);
      if (!s) { echecs.push(`${e.id} : non affichée sur ${route} (${affichees.map((x) => x.id).join(', ')})`); continue; }
      expect(affichees.length, `${e.id} ${route}`).toBeLessThanOrEqual(3);

      // Lot 55A : la mascotte ne propose plus le catalogue — ses questions
      // sont rédigées par T6 (voir l55a-suggestions.e2e.ts) ; le champ
      // « Demander à Verebona » garde ce catalogue, vérifié ici.
      const contexteClic: Record<string, unknown> = { ...(await contexte(route)) };

      // 2. Cliquée : le libellé part au moteur réel.
      sim.calls.length = 0;
      const r = await demander(c, s.label, { pageContext: contexteClic });
      const answer = String(r.answer ?? '');
      const types = [...new Set((r.sources ?? []).map((x: { type: string }) => x.type))];
      const admis = SUGGESTION_DOMAIN_SOURCES[e.domain];
      const raison =
        r.route?.intent !== e.canonicalIntent ? `intention ${r.route?.intent} ≠ ${e.canonicalIntent}`
          : sim.calls.some((x) => x.task === 'UNDERSTAND') ? 'routée par le modèle (formulation non déterministe)'
            : r.clarification ? 'clarification'
              : r.cascade?.diagnostic === 'SEARCH_NO_RESULT' || r.cascade?.diagnostic === 'TARGET_NOT_FOUND' ? r.cascade.diagnostic
                : r.cascade?.fallbackUsed === true ? `repli ${r.cascade?.fallbackReason ?? ''}`
                  : NON_REPONSE.test(answer) ? `réponse « ${answer.slice(0, 90)} »`
                    // Carte #773 : l'entrée d'offre (domaine PLAN, réponse par gabarit sans source) est retirée du catalogue.
                    : (r.sources ?? []).length === 0 ? 'aucune source'
                      : types.some((t) => !admis.includes(t)) ? `sources hors domaine ${e.domain} : ${types.join(', ')}`
                        : null;
      if (raison) echecs.push(`${e.id} « ${s.label} » (${route}) → ${raison}`);
      verifies.push(e.id);

      // Demandes d'actions : lecture canonique SQL, aucun appel modèle.
      if (e.domain === 'TO_PROCESS') {
        // Appels T2 seulement (la formulation T6 de la mascotte, asynchrone, n'en est pas un).
        expect(sim.calls.filter((x) => x.task === 'UNDERSTAND' || x.task === 'ANSWER'), e.id).toEqual([]);
        expect(r.cascade?.aiCalls, e.id).toBe(0);
        expect(r.cascade?.actionable?.queryStrategy, e.id).toBe('SQL_CANONICAL');
      }
    }

    expect(echecs).toEqual([]);
    // Chaque entrée du catalogue a été vérifiée (aucune n'échappe au contrat).
    expect(verifies.sort()).toEqual(ALL_SUGGESTIONS.map((x) => x.id).sort());
  });

  // Règle remplacée (carte #773, décision PO n° 27) : avec une échéance du jour, le catalogue proposait
  // « Que dois-je faire aujourd'hui ? » (`home_today`) ; cette formulation est RETIRÉE — elle n'apparaît
  // plus dans aucun cas. « Que dois-je traiter en priorité ? » (n° 28, conservée) reste proposée tant
  // qu'un « À traiter » existe.
  it('Cas 3 (réel) — « À traiter » : « Que dois-je traiter en priorité ? » ; même avec une échéance du jour, plus jamais « Que dois-je faire aujourd’hui ? » (carte #773)', async () => {
    const c = await compte();
    const cupra = await bien(c, 'Cupra');
    await fichier(c, cupra, 'Facture entretien garage');
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
              VALUES (${c.id}, 'ASSET', ${cupra}, 'purchasePriceCents', 'ARBITRATE', 'DATA-ACQUISITION-PRICE', 'Prix d’achat ?')`;
    let l = (await exemples(c, '/accueil')).map((x) => x.label);
    expect(l).toContain('Que dois-je traiter en priorité ?');
    expect(l).not.toContain('Que dois-je faire aujourd’hui ?');
    // #715 : échéance d'hier (sans statut) : une date passée n'est pas une action — toujours pas « aujourd'hui ».
    await echeance(c, cupra, 'Vidange', dans(-1));
    l = (await exemples(c, '/accueil')).map((x) => x.label);
    expect(l).not.toContain('Que dois-je faire aujourd’hui ?');
    await echeance(c, cupra, 'Contrôle technique', J);
    const avecEcheanceDuJour = await exemples(c, '/accueil');
    l = avecEcheanceDuJour.map((x) => x.label);
    expect(l).not.toContain('Que dois-je faire aujourd’hui ?');
    expect(avecEcheanceDuJour.map((x) => x.id)).not.toContain('home_today');
    // L'entrée d'accueil garde sa condition (rien en retard ni dû aujourd'hui) ; la question n° 28 reste
    // rendue par l'entrée d'état du compte `state_todo` (même libellé), « À traiter » étant non vide.
    expect(avecEcheanceDuJour.map((x) => x.id)).not.toContain('home_todo_priority');
    expect(l).toContain('Que dois-je traiter en priorité ?');
    // Posée librement, la question retirée reste traitée par T2 (lecture canonique, aucun appel modèle).
    sim.calls.length = 0;
    const r = await demander(c, 'Que dois-je faire aujourd’hui ?', { pageContext: await contexte('/accueil') });
    expect(r.route?.intent).toBe('ACCOUNT_TO_PROCESS');
    expect(r.cascade?.actionable?.queryStrategy).toBe('SQL_CANONICAL');
    expect(String(r.answer ?? '')).toMatch(/Contrôle technique/);
  });

  it('Cas 1, 2, 4, 5, 6 (réel) — ni « Que sais-tu sur X ? », ni question sans données, moins de 3 accepté', async () => {
    const c = await compte();
    const cupra = await bien(c, 'Cupra');
    // Cas 2 / 4 / 6 : bien sans document ni échéance, rien en attente.
    const accueil = await exemples(c, '/accueil');
    expect(accueil).toEqual([
      { id: 'home_add_doc', label: 'Comment ajouter un document ?' },
      { id: 'home_analysis_help', label: 'L’analyse automatique, c’est quoi ?' },
    ]);
    const fiche = (await exemples(c, `/assets/${cupra}`)).map((x) => x.label);
    expect(fiche.join('|')).not.toMatch(/documents de Cupra|échéances de Cupra|Que sais-tu/);
    expect((await exemples(c, '/agenda')).map((x) => x.id)).toEqual(['agenda_sync']);
    // Règle remplacée (carte #773, décision PO n° 30) — cas 1 : un document rattaché ne fait plus proposer
    // « Quels sont les documents de Cupra ? » (ni sur la fiche, ni sur l'accueil, ni sur Documents).
    await fichier(c, cupra, 'Facture entretien garage');
    for (const route of [`/assets/${cupra}`, '/accueil', '/documents']) {
      expect((await exemples(c, route)).map((x) => x.label).join('|'), route).not.toMatch(/Quels sont les documents d/);
    }
    expect(await exemples(c, '/accueil')).toEqual([]);
    // Posée librement, la recherche des documents d'un bien reste traitée par T2 (CA05).
    const docs = await demander(c, 'Quels sont les documents de Cupra ?', { pageContext: await contexte('/accueil') });
    expect(docs.route?.intent).toBe('ACCOUNT_SEARCH_DOCUMENT');
    expect((docs.sources ?? []).some((x: { type: string }) => x.type === 'document')).toBe(true);
    expect(String(docs.answer ?? '')).not.toMatch(NON_REPONSE);
    // Règle remplacée (carte #773, décision PO n° 29) — cas 5 : un document en analyse ne fait plus proposer
    // « Où en est l'analyse de mes documents ? » ; la question n° 35 conservée garde sa précondition.
    await fichier(c, cupra, 'Diagnostic énergie', 'ANALYZING');
    expect((await exemples(c, '/accueil')).map((x) => x.label)).not.toContain('Où en est l’analyse de mes documents ?');
    expect((await exemples(c, '/documents')).map((x) => x.label)).toContain('Pourquoi un document est-il encore en analyse ?');
  });
});
