/**
 * Lot 55A — ticket « T6 / T2 — Cohérence des suggestions IA et correction des
 * cartes d'échéance » — de bout en bout sur PostgreSQL 16 réel : vrai
 * collecteur, vraie mascotte (`getMascotPresentation`), vraie passerelle IA,
 * vrai T2 (`runAssistant` + ports réels). Modèle SIMULÉ (aucun réseau) :
 *   · T6 (`MODE = FORMULATE`) : recopie les textes de secours et rend les
 *     questions que le scénario lui confie ; le prompt reçu est conservé ;
 *   · T2 : UNDERSTAND ne comprend rien (les questions doivent être routées
 *     sans lui), ANSWER cite la première source.
 *
 *  L55A-E2E-01  constat du ticket (« Aucun sujet à traiter en priorité »)
 *               → questions de T6, contexte = message affiché + compte ;
 *               jamais « Que dois-je traiter en priorité ? » du catalogue ;
 *  L55A-E2E-02  questions cliquées → T2 répond (sources du compte, sans repli) ;
 *  L55A-E2E-03  actualisation : changement du compte → nouvelles questions,
 *               jamais celles de l'ancien état sous le nouveau message ;
 *  L55A-E2E-04  IA indisponible : accueil fonctionnel, aucune question ;
 *  L55A-E2E-05  isolation stricte des comptes (contexte, cache, biens) ;
 *  L55A-E2E-06  cartes d'échéance : intitulé métier, « bien · date complète »,
 *               une seule action « Voir », même cible.
 *
 * Lot 87C (contrat des questions fondées `t6-suggestions-v3`) : les questions
 * simulées portent sujet, finalité, décision et fondements ; la version du
 * prompt porteuse du contrat est SIMULÉE (`activerContratQuestions`, aucun
 * prompt modifié). L87C-E2E-01 à 05 : AC01, AC02, AC06, AC07, AC09, AC10,
 * AC12, AC14 de bout en bout (Homiris en non-régression, sans règle propre).
 *
 * Lot 108J (décision PO du ticket « Suggestions de l'accueil et de T2 ») :
 * L55A-E2E-01 à 05 et L87C-E2E-01 à 05 sont RETIRÉS — la mascotte ne
 * transmet plus de contexte de questions à T6 et n'affiche plus de
 * suggestions (service unique `src/services/suggestions/shared`, scénario
 * `l108j-suggestions-partagees.e2e.ts`). Le contrat T6 des questions reste
 * couvert par les tests unitaires (l55a-suggestions-t6, l106b). Reste ici
 * L55A-E2E-06 (cartes d'échéance de la bulle), inchangé.
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import { dansJours, evaluerEcheance } from '../t6-assessment';
import { activerContratQuestions } from '../t6-suggestions-v3';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));

type Compte = { id: number; ownerUserId: number };
type Q = Record<string, unknown>;
type Candidat = { subjectId: string; title: string; evidence: Array<{ ref: string; kind: string }> };

/** Modèle simulé : T6 piloté par le scénario ; T2 sans compréhension modèle. */
const modele = vi.hoisted(() => ({
  t6Prompts: [] as string[],
  questions: (_ctx: Record<string, unknown>): Q[] => [],
  t6Down: false,
  /** Lot 87C : décision EVALUATE d'un candidat (null : SUPPRESS « aucune démarche »). */
  juger: (_c: Candidat): Record<string, unknown> | null => null,
}));

function provider() {
  return {
    name: 'simule-l55a',
    isConfigured: () => true,
    async call(input: { task?: string; prompt: string }) {
      // Lot 61 : MODE=EVALUATE (pertinence des interpellations) — rien à signaler.
      if (/^MODE = EVALUATE$/m.test(input.prompt)) {
        const ctx = JSON.parse(/Candidats à évaluer : (.*)\n/.exec(input.prompt)![1]) as { candidates: Candidat[] };
        return {
          rawText: JSON.stringify({ schemaVersion: 't6-evaluation-v1', decisions: ctx.candidates.map((c) => ({
            subjectId: c.subjectId, decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED',
            reason: 'Échéance connue et suivie dans l’agenda.', expectedAction: null, actionDeadline: null, suggestedReviewAt: null,
            priorityHint: null, evidenceRefs: [`${c.subjectId}.title`], uncertainties: [],
            ...(modele.juger(c) ?? {}),
          })) }),
          inputTokens: 100, outputTokens: 20,
        };
      }
      if (/^MODE = FORMULATE$/m.test(input.prompt)) {
        if (modele.t6Down) throw new Error('T6 indisponible (simulation)');
        modele.t6Prompts.push(input.prompt);
        const entree = JSON.parse(/Entrée structurée : (.*)\n/.exec(input.prompt)![1]) as { subjects: Array<{ subjectId: string; fallbackText: string }> };
        const brut = /Contexte des questions suggérées : (.*)\n/.exec(input.prompt)?.[1] ?? 'null';
        const ctx = JSON.parse(brut) as Record<string, unknown> | null;
        return {
          rawText: JSON.stringify({
            schemaVersion: 't6-output-v2',
            messages: entree.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText, highlight: null })),
            suggestions: ctx ? modele.questions(ctx) : [],
          }),
          inputTokens: 200, outputTokens: 40,
        };
      }
      if (input.task === 'ANSWER') {
        const ids = [...new Set(input.prompt.match(/\b(?:document|agenda_item|help)_[A-Za-z0-9_-]+\b/g) ?? [])];
        return {
          rawText: JSON.stringify({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: [{ text: 'Voici ce que j’ai trouvé.', sourceIds: ids.slice(0, 1), derivation: 'direct', factual: true }] }),
          inputTokens: 100, outputTokens: 20,
        };
      }
      return {
        rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'low', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 'simulé' }),
        inputTokens: 50, outputTokens: 10,
      };
    },
  };
}

scenario('L55A-SUGG', 'Lot 55A — questions suggérées par T6, cohérentes avec la bulle ; cartes d’échéance', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(provider() as never);
  });
  beforeEach(async () => {
    modele.t6Prompts.length = 0;
    modele.t6Down = false;
    modele.questions = () => [];
    modele.juger = () => null;
    (await import('@/services/home/mascot/t6-runner')).resetT6Breaker();
    (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
    // Lot 87C : version du prompt T6 porteuse du contrat des questions fondées (simulée, activée « au BO »).
    await activerContratQuestions(true);
  });
  afterEach(async () => {
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
    await activerContratQuestions(false);
  });

  const svc = () => import('@/services/home/mascot/mascot.service');
  const compte = async (): Promise<Compte> => { const a = await make.account({ plan: 'premium' }); return { id: a.id, ownerUserId: a.ownerUserId }; };
  /** Compte du ticket : Cupra (voiture), un document, contrôle technique à venir, un « À traiter » non prioritaire. */
  async function compteDuTicket(nom = 'Cupra') {
    const c = await compte();
    const cupra = await make.asset(c as never, { category: 'VEHICULE', name: nom });
    await sql`UPDATE assets SET status = 'EN_SERVICE', subtype = 'Voiture' WHERE id = ${cupra.id}`;
    const f = await make.assetFile(c as never, { assetId: cupra.id });
    await sql`UPDATE asset_files SET retained_title = 'Facture entretien garage', original_filename = 'facture.pdf', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    const ech = await make.agendaItem(c as never, { title: `Prochain contrôle technique — ${nom.toUpperCase()} LEON`, startDate: '2028-04-18', assetIds: [cupra.id] });
    await sql`UPDATE agenda_items SET is_automatic = TRUE, origin_type = 'asset_field', event_nature = 'DEADLINE', manual_status = NULL WHERE id = ${ech.id}`;
    // « À traiter » qui n'est pas « À faire en premier » : la bulle dit « Aucun sujet… ».
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question, priority)
              VALUES (${c.id}, 'ASSET', ${cupra.id}, 'purchasePriceCents', 'COMPLETE', 'DATA-ACQUISITION-PRICE', 'Prix d’achat ?', 'CAN_WAIT')`;
    return { c, cupra: cupra.id, echeance: ech.id };
  }

  it('L55A-E2E-06 — carte d’échéance : « Contrôle technique » / « Cupra · 18 avril 2028 » / « Voir → », tiroir de l’échéance', async () => {
    const { c, echeance } = await compteDuTicket();
    // Lot 60 : le contrôle de 2028 n'est plus présenté d'office (au-delà du
    // seuil, aucune démarche) ; une échéance proche, jugée « à traiter » par
    // T6, garde la même carte — l'état d'interpellation s'ajoute au statut.
    const date = dansJours(20);
    await sql`UPDATE agenda_items SET start_date = ${date} WHERE id = ${echeance}`;
    await evaluerEcheance(sql, echeance);
    const p = await (await svc()).getMascotPresentation(c.id, 'pregen');
    // Lot 68 : métadonnées de tuile conservées (nature, fenêtre de rappel) ; l'accueil affiche un bloc « Voir ».
    const { actionTiles, subjectBlocks } = await import('@/services/home/mascot/bubble');
    const { formatDateFr } = await import('@/services/home/mascot/signals');
    expect(actionTiles(p)[0]).toMatchObject({ label: 'Contrôle technique', sub: `Cupra · Action à prévoir · ${formatDateFr(date)}` });
    const [bloc] = subjectBlocks(p);
    expect(bloc.actions.map((a) => a.label)).toEqual(['Voir']);
    expect(bloc.actions[0].action.target).toEqual({ kind: 'drawer', drawer: 'echeance', id: echeance, mode: 'view' });
  });
});
