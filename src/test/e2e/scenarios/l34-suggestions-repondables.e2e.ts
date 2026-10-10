/**
 * Lot 34 — ticket « ne proposer que des questions pertinentes et réellement
 * répondables par T2 » : TEST CONTRACTUEL DU CATALOGUE, de bout en bout sur
 * PostgreSQL réel.
 *
 * Pour CHAQUE suggestion du catalogue unique (`ALL_SUGGESTIONS`) :
 *
 *   préconditions satisfaites (données réelles créées pour elle seule)
 *   → suggestion AFFICHÉE (vraie route `/api/verebona/suggestions`, et pour
 *     l'accueil, vraie mascotte `getMascotPresentation`)
 *   → CLIQUÉE (le libellé, avec le contexte que le champ / la mascotte envoie)
 *   → intention T2 attendue (`canonicalIntent`)
 *   → sources du domaine attendu (`SUGGESTION_DOMAIN_SOURCES`)
 *   → réponse NON fallback (ni « semblent liés », ni « résultats proches »,
 *     ni « rien trouvé », ni clarification, ni erreur).
 *
 * Une entrée absente de ce parcours fait échouer le test : une suggestion
 * qui ne satisfait pas ce contrat n'est pas publiable.
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

/** Sujets de la mascotte équivalents à une question (SEC-004) : la question n'est alors pas répétée. */
const EQUIVALENT: Record<string, string[]> = { deadlines: ['DATE-NEXT', 'DATE-NEXT-2'], analysis: ['PROC-DOC-ANALYSIS'] };

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

  const compte = async (): Promise<Compte> => { const a = await make.account({ plan: 'premium' }); return { id: a.id, ownerUserId: a.ownerUserId }; };
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
    const c = await compte();
    const req = new Map((e.requires ?? []).map((r) => [r.fact, r.is]));
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
        case 'documentsFailed': await fichier(c, cupra, 'Scan illisible', 'ANALYSIS_FAILED'); break;
        case 'documentsUnlinked': await fichier(c, null, 'Contrat assurance habitation'); break;
        case 'exportsReady':
          await sql`INSERT INTO export_generation (asset_id, account_id, user_id, export_type, status)
                    VALUES (${cupra}, ${c.id}, ${c.ownerUserId}, 'DOSSIER_COMPLET', 'ready')`;
          break;
        case 'asset.documents': break; // le document de base est rattaché à Cupra
        default: throw new Error(`précondition non préparée : ${fact}`);
      }
    }
    return { c, assetId: cupra };
  };

  const routeDe = (e: Entree, assetId: number | null) =>
    e.routeExact?.[1] ?? e.routeExact?.[0] ?? e.routePrefix ?? (e.routePattern ? `/assets/${assetId}` : '/fournisseurs');

  /** Exemples d'une page, servis par la VRAIE route. */
  const exemples = async (c: Compte, route: string): Promise<Array<{ id: string; label: string }>> => {
    session.currentAccountId = c.id; session.userId = c.ownerUserId;
    const { GET } = await import('@/app/api/verebona/suggestions/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest(`http://x/api/verebona/suggestions?route=${encodeURIComponent(route)}`));
    expect(res.status).toBe(200);
    return ((await res.json()) as { suggestions: Array<{ id: string; label: string }> }).suggestions;
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
    const { getMascotPresentation } = await import('@/services/home/mascot/mascot.service');
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

      // Accueil : la mascotte propose la même question, avec l'intention canonique.
      let contexteClic: Record<string, unknown> = { ...(await contexte(route)) };
      if (e.routeExact?.includes('/accueil')) {
        const p = await getMascotPresentation(c.id, 'display');
        const q = p.secondaries.find((x) => x.action.label === s.label);
        // SEC-004 / T2-02 : une question équivalente à un sujet DÉJÀ dit par
        // la mascotte (date à venir, analyse en cours) n'est pas répétée.
        const sujetAffiche = (EQUIVALENT[e.topic ?? e.id] ?? []).some((code) => p.paragraphs.some((x) => x.sourceCode === code));
        if (!q && !sujetAffiche) { echecs.push(`${e.id} : absente de la mascotte (${p.secondaries.map((x) => x.action.label).join(' | ')})`); continue; }
        if (q && q.action.target.kind === 'ask') {
          if (q.action.target.context.intent !== e.canonicalIntent) echecs.push(`${e.id} : mascotte intention ${q.action.target.context.intent}`);
          // Contexte que la mascotte envoie au clic (bien revalidé côté serveur).
          contexteClic = { ...contexteClic, intent: q.action.target.context.intent, ...(q.action.target.context.assetId ? { assetId: String(q.action.target.context.assetId) } : {}) };
        }
      }

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
                    // Offre : réponse calculée par les règles d'offre (gabarit), sans source document.
                    : (r.sources ?? []).length === 0 && !(e.domain === 'PLAN' && String(r.cascade?.strategy).startsWith('template.')) ? 'aucune source'
                      : types.some((t) => !admis.includes(t)) ? `sources hors domaine ${e.domain} : ${types.join(', ')}`
                        : null;
      if (raison) echecs.push(`${e.id} « ${s.label} » (${route}) → ${raison}`);
      verifies.push(e.id);

      // Demandes d'actions : lecture canonique SQL, aucun appel modèle.
      if (e.domain === 'ACTIONS' || e.domain === 'TO_PROCESS') {
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

  it('Cas 3 (réel) — « À traiter » seul : « Que dois-je traiter en priorité ? » ; avec une échéance du jour : « Que dois-je faire aujourd’hui ? »', async () => {
    const c = await compte();
    const cupra = await bien(c, 'Cupra');
    await fichier(c, cupra, 'Facture entretien garage');
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
              VALUES (${c.id}, 'ASSET', ${cupra}, 'purchasePriceCents', 'ARBITRATE', 'DATA-ACQUISITION-PRICE', 'Prix d’achat ?')`;
    let l = (await exemples(c, '/accueil')).map((x) => x.label);
    expect(l).toContain('Que dois-je traiter en priorité ?');
    expect(l).not.toContain('Que dois-je faire aujourd’hui ?');
    // Échéance d'hier réalisée : toujours pas « aujourd'hui » (résolveur réel).
    const faite = await echeance(c, cupra, 'Vidange', dans(-1));
    await sql`UPDATE agenda_items SET manual_status = 'realise' WHERE id = ${faite}`;
    l = (await exemples(c, '/accueil')).map((x) => x.label);
    expect(l).not.toContain('Que dois-je faire aujourd’hui ?');
    await echeance(c, cupra, 'Contrôle technique', J);
    l = (await exemples(c, '/accueil')).map((x) => x.label);
    expect(l).toContain('Que dois-je faire aujourd’hui ?');
    expect(l).not.toContain('Que dois-je traiter en priorité ?');
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
    // Cas 1 : un document → « Quels sont les documents de Cupra ? ».
    await fichier(c, cupra, 'Facture entretien garage');
    expect((await exemples(c, `/assets/${cupra}`)).map((x) => x.label)).toContain('Quels sont les documents de Cupra ?');
    expect((await exemples(c, '/accueil')).map((x) => x.label)).toEqual(['Quels sont les documents de Cupra ?']);
    // Cas 5 : un document en analyse → « Où en est l'analyse de mes documents ? ».
    await fichier(c, cupra, 'Diagnostic énergie', 'ANALYZING');
    expect((await exemples(c, '/accueil')).map((x) => x.label)).toContain('Où en est l’analyse de mes documents ?');
  });
});
