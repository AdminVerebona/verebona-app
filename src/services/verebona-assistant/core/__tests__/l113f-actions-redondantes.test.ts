/**
 * Lot 113F (#689) — actions de navigation redondantes, ouverture contextuelle.
 *
 * Avant : « Quelle est ma prochaine échéance ? » → « Ouvrir l'agenda »,
 * « Voir dans l'agenda », « Voir dans l'agenda » (trois liens vers /agenda).
 * Attendu : un seul « Voir cette échéance », ouvrant son tiroir. Règle
 * générale : une action par élément PRÉSENTÉ, une par destination,
 * navigation générale retirée quand une action contextuelle la couvre.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => { throw new Error('aucune base en test'); }) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { construireActionIntents } = await import('../ports');
const { resolveActions } = await import('../action-resolver.service');
const { routeForIntent, routeDeterministic } = await import('../intent-router.service');
const sel = await import('../action-selection');
const { runAssistant } = await import('../assistant-orchestrator.service');
type Source = import('../../types/sources').RetrievedSource;
type Claim = import('../../types/sources').Claim;
type Action = import('../../types/actions').VerebonaAction;

const MON_COMPTE = 7;
const TITRES = new Map([[1, 'Contrôle technique'], [2, 'Entretien chaudière'], [3, 'Assurance auto']]);
const ACCESS = {
  assetInAccount: async (_a: number, id: number) => id === 42,
  documentInAccount: async (_a: number, id: number) => id < 100,
  agendaItemInAccount: async (_a: number, id: number) => id < 100,
  supplierInAccount: async (_a: number, id: number) => id < 100,
  helpEntryPublished: async () => true,
  agendaItemTitles: async (_a: number, ids: number[]) => new Map(ids.filter((i) => TITRES.has(i)).map((i) => [i, TITRES.get(i)!])),
};

const echeance = (id: number, assetId = 42): Source => ({ id: `agenda_${id}`, type: 'agenda_item', title: `E${id}`, content: '', relevanceScore: 1, meta: { assetId } });
const doc = (id: number): Source => ({ id: `doc_${id}`, type: 'document', title: `D${id}`, content: '', relevanceScore: 1, meta: { assetId: 42 } });
const input = (message: string) => ({ accountId: MON_COMPTE, userId: 3, planType: 'STANDARD', message, clientRequestId: 'c', locale: 'fr-FR' }) as never;

async function actions(intent: string, message: string, sources: Source[], claims?: Claim[]) {
  const route = routeForIntent(intent as never, 'STANDARD', 'test');
  const list = await resolveActions({
    accountId: MON_COMPTE, intent: route.intent, access: ACCESS,
    actionIntents: construireActionIntents(route, input(message), sources, sel.idsPresentes(claims, sources)),
  });
  // Même filtre que le port réel : pas d'ouverture sans destination.
  return list.filter((a) => a.href !== null || !a.type.startsWith('OPEN_'));
}
const vue = (l: Action[]) => l.map((a) => [a.type, a.label, a.href]);

afterEach(() => { vi.unstubAllEnvs(); });

describe('prochaine échéance : trois actions candidates → un seul bouton', () => {
  it('trois échéances récupérées, une seule retenue par la réponse → « Voir cette échéance » vers son tiroir', async () => {
    const sources = [echeance(1), echeance(2), echeance(3)];
    const claims: Claim[] = [{ claimKey: 'next', text: 'Votre prochaine échéance…', sourceIds: ['agenda_1'], derivation: 'calculated' }];
    const a = await actions('ACCOUNT_SEARCH_AGENDA', 'Quelle est ma prochaine échéance ?', sources, claims);
    expect(vue(a)).toEqual([['OPEN_AGENDA_ITEM', 'Voir cette échéance', '/agenda?tiroir=echeance%3A1']]);
  });

  it('deux échéances récupérées, une seule retenue → une seule action contextuelle', async () => {
    const claims: Claim[] = [{ claimKey: 'k', text: 't', sourceIds: ['agenda_2'], derivation: 'direct' }];
    const a = await actions('ACCOUNT_FACT_AGENDA', 'Quand a lieu mon entretien ?', [echeance(1), echeance(2)], claims);
    expect(a.filter((x) => x.type.startsWith('OPEN_')).map((x) => x.href)).toEqual(['/agenda?tiroir=echeance%3A2']);
  });
});

describe('plusieurs éléments distincts présentés : une action chacun', () => {
  it('deux échéances présentées → deux liens distincts, libellés par leur titre, sans « Ouvrir l’agenda »', async () => {
    const a = await actions('ACCOUNT_SEARCH_AGENDA', 'Quelles échéances arrivent ?', [echeance(1), echeance(2)]);
    expect(vue(a)).toEqual([
      ['OPEN_AGENDA_ITEM', 'Voir « Contrôle technique »', '/agenda?tiroir=echeance%3A1'],
      ['OPEN_AGENDA_ITEM', 'Voir « Entretien chaudière »', '/agenda?tiroir=echeance%3A2'],
    ]);
  });

  it('jeton disponible, deux échéances : chaque élément a son bouton → pas de « Voir les résultats »', async () => {
    vi.stubEnv('VEREBONA_SEARCH_TOKEN_SECRET', 'secret-de-test-113f-suffisamment-long');
    const a = await actions('ACCOUNT_SEARCH_AGENDA', 'Quelles échéances arrivent ?', [echeance(1), echeance(2)]);
    expect(a.map((x) => x.type)).toEqual(['OPEN_AGENDA_ITEM', 'OPEN_AGENDA_ITEM']);
  });

  it('liste plus longue que la limite d’affichage → « Voir les résultats » seul', async () => {
    vi.stubEnv('VEREBONA_SEARCH_TOKEN_SECRET', 'secret-de-test-113f-suffisamment-long');
    const a = await actions('ACCOUNT_SEARCH_AGENDA', 'Quelles échéances arrivent ?', [1, 2, 3, 4, 5].map((i) => echeance(i)));
    expect(a.map((x) => [x.type, x.label])).toEqual([['OPEN_SEARCH_RESULTS', 'Voir les résultats']]);
  });

  it('sans jeton signable, la liste longue garde les boutons individuels dans la limite (1 + 2)', async () => {
    vi.stubEnv('VEREBONA_SEARCH_TOKEN_SECRET', '');
    vi.stubEnv('JWT_SECRET', '');
    const a = await actions('ACCOUNT_SEARCH_AGENDA', 'Quelles échéances arrivent ?', [1, 2, 3, 4, 5].map((i) => echeance(i)));
    expect(a.map((x) => x.type)).toEqual(['OPEN_AGENDA_ITEM', 'OPEN_AGENDA_ITEM', 'OPEN_AGENDA_ITEM']);
  });
});

describe('déduplication par destination effective', () => {
  it('deux actions identiques vers un document → une seule', async () => {
    const a = await actions('ACCOUNT_FACT_DOCUMENT', 'Quel est le montant ?', [doc(5), { ...doc(5), relevanceScore: 0.5 }]);
    expect(a.filter((x) => x.type === 'OPEN_DOCUMENT').map((x) => x.href)).toEqual(['/documents?tiroir=document%3A5']);
  });

  it('document présenté → ouverture du document, sans bouton général vers les documents', async () => {
    const a = await actions('ACCOUNT_SEARCH_DOCUMENT', 'Retrouve ma facture', [doc(5)]);
    expect(vue(a)).toEqual([['OPEN_DOCUMENT', 'Ouvrir le document', '/documents?tiroir=document%3A5']]);
  });

  it('types différents vers la même destination → une seule action, sources fusionnées', () => {
    const base = { requiresConfirmation: false, expiresAt: null, token: null, analyticsCode: 'x', targetRef: null } as const;
    const a1 = { ...base, actionId: '1', type: 'OPEN_AGENDA', label: "Ouvrir l'agenda", href: '/agenda', payload: {} } as Action;
    const a2 = { ...base, actionId: '2', type: 'OPEN_HELP', label: 'Lire', href: '/agenda', payload: { sourceIds: 'x_1' } } as Action;
    expect(sel.selectionnerActions([a1, a2]).map((a) => a.actionId)).toEqual(['1']);
    expect(sel.sourcesDeLAction(sel.selectionnerActions([a1, a2])[0])).toEqual(['x_1']);
  });

  it('deux objets différents ne sont jamais fusionnés (liens profonds distincts)', async () => {
    const a = await actions('ACCOUNT_SEARCH_DOCUMENT', 'Retrouve mes factures', [doc(5), doc(6)]);
    expect(a.map((x) => x.href)).toEqual(['/documents?tiroir=document%3A5', '/documents?tiroir=document%3A6']);
  });

  it('la sélection est idempotente', async () => {
    const a = await actions('ACCOUNT_SEARCH_AGENDA', 'Quelles échéances ?', [echeance(1), echeance(2)]);
    expect(sel.selectionnerActions(a)).toEqual(a);
  });
});

describe('navigation explicite et absence de cible', () => {
  it('« Ouvre mon agenda » → un seul bouton générique « Ouvrir l’agenda »', async () => {
    const o = routeDeterministic({ message: 'Ouvre mon agenda', planType: 'STANDARD', hasPendingClarification: false });
    if (o.kind !== 'route') throw new Error('non routé');
    const list = await resolveActions({ accountId: MON_COMPTE, intent: o.route.intent, access: ACCESS, actionIntents: construireActionIntents(o.route, input('Ouvre mon agenda'), []) });
    expect(vue(list)).toEqual([['OPEN_AGENDA', "Ouvrir l'agenda", '/agenda']]);
  });

  it('aucune source : aucune ouverture contextuelle inventée', async () => {
    const a = await actions('ACCOUNT_FACT_AGENDA', 'Quand est mon entretien ?', []);
    expect(a).toEqual([]);
  });
});

describe('droits et isolation des comptes', () => {
  it('échéance d’un autre compte : aucune action vers elle ; la navigation générale reste', async () => {
    const a = await actions('ACCOUNT_SEARCH_AGENDA', 'Quelle est ma prochaine échéance ?', [echeance(500)]);
    expect(vue(a)).toEqual([['OPEN_AGENDA', "Ouvrir l'agenda", '/agenda']]);
  });

  it('cible fabriquée d’une autre famille : refusée', async () => {
    const list = await resolveActions({ accountId: MON_COMPTE, intent: 'ACCOUNT_SEARCH_AGENDA', access: ACCESS, actionIntents: [{ type: 'OPEN_AGENDA_ITEM', targetId: 'doc_5' }] });
    expect(list).toEqual([]);
  });

  it('libellés multiples : titres lus par le vérificateur du compte, jamais transmis au client', async () => {
    const a = await actions('ACCOUNT_SEARCH_AGENDA', 'Quelles échéances ?', [echeance(1), echeance(2)]);
    expect(a.every((x) => typeof x.payload?.sourceIds === 'string')).toBe(true);
    const { toApiPayload } = await import('../api-payload');
    const api = toApiPayload({ requestId: 'r', answer: '', sources: [], claims: [], actions: a } as never);
    expect(JSON.stringify(api.actions)).not.toContain('sourceIds');
  });
});

describe('sources et explication conservées', () => {
  it('synthèse : ouverture du document + « Voir les sources » + « Pourquoi cette réponse ? »', async () => {
    const route = routeForIntent('ACCOUNT_SUMMARY', 'PREMIUM', 't');
    const list = await resolveActions({ accountId: MON_COMPTE, intent: route.intent, access: ACCESS, actionIntents: construireActionIntents(route, input('Résume'), [doc(1)]) });
    expect(list.map((x) => x.type)).toEqual(['OPEN_DOCUMENT', 'SHOW_SOURCES', 'SHOW_EXPLANATION']);
  });
});

describe('sélection finale sur les éléments présentés', () => {
  const act = (id: string, type: string, href: string | null, sources?: string): Action => ({
    actionId: id, type, label: id, href, token: null, requiresConfirmation: false, expiresAt: null,
    analyticsCode: 'x', targetRef: null, payload: sources ? { sourceIds: sources } : {},
  }) as Action;

  it('idsPresentes : sources citées, sinon toutes, null sans source', () => {
    const s = [{ id: 'a' }, { id: 'b' }];
    expect([...sel.idsPresentes([{ sourceIds: ['b', 'zz'] }], s)!]).toEqual(['b']);
    expect([...sel.idsPresentes([], s)!]).toEqual(['a', 'b']);
    expect(sel.idsPresentes([{ sourceIds: ['a'] }], [])).toBeNull();
  });

  it('une action issue d’une source non présentée est retirée ; les autres restent', () => {
    const l = [act('1', 'OPEN_AGENDA_ITEM', '/agenda?tiroir=echeance%3A1', 'agenda_1'), act('2', 'OPEN_AGENDA_ITEM', '/agenda?tiroir=echeance%3A2', 'agenda_2'), act('3', 'START_ADD_DOCUMENT', null)];
    expect(sel.retenirActionsPresentees(l, new Set(['agenda_2'])).map((a) => a.actionId)).toEqual(['2', '3']);
    expect(sel.retenirActionsPresentees(l, null).map((a) => a.actionId)).toEqual(['1', '2', '3']);
    expect(sel.retenirActionsPresentees(l, new Set()).map((a) => a.actionId)).toEqual(['3']);
  });

  it('navigation générale couverte par une action contextuelle de sa rubrique → retirée', () => {
    const l = [act('g', 'OPEN_AGENDA', '/agenda'), act('c', 'OPEN_AGENDA_ITEM', '/agenda?tiroir=echeance%3A1', 'agenda_1'), act('d', 'OPEN_DOCUMENTS_PAGE', '/documents')];
    expect(sel.selectionnerActions(l).map((a) => a.actionId)).toEqual(['c', 'd']);
  });

  it('aucune action de remplissage : la limite est un plafond, pas un objectif', () => {
    expect(sel.selectionnerActions([act('c', 'OPEN_AGENDA_ITEM', '/agenda?tiroir=echeance%3A1', 'agenda_1')])).toHaveLength(1);
  });
});

describe('orchestrateur : réponse déterministe « prochaine échéance »', () => {
  it('trois échéances lues, une citée → un seul « Voir cette échéance » dans le résultat persisté', async () => {
    const sources = [echeance(1), echeance(2), echeance(3)];
    const persisted: Action[][] = [];
    const r = await runAssistant(input('Quelle est ma prochaine échéance ?'), {
      retrieve: async () => [],
      resolveSources: async (s) => s.map((x) => ({ id: x.id, type: x.type, typeLabel: 'Échéance', title: x.title, excerpt: '', isAvailable: true })),
      resolveActions: (route, inp, s, claims) => resolveActions({
        accountId: MON_COMPTE, intent: route.intent, access: ACCESS,
        actionIntents: construireActionIntents(route, inp, s, sel.idsPresentes(claims, s)),
      }),
      answerFromData: async () => ({
        handled: true, strategy: 'structured.next_deadline', answer: 'Votre prochaine échéance : « Contrôle technique ».',
        sources, claims: [{ claimKey: 'next', text: 'x', sourceIds: ['agenda_1'], derivation: 'calculated' }],
        decision: { level: 1, status: 'SUFFICIENT_STRUCTURED' }, attempts: [], contextSources: sources,
      }) as never,
      persist: async (res) => { persisted.push(res.actions); return null; },
      hasPendingClarification: async () => false,
    });
    expect(r.actions.map((a) => [a.type, a.label, a.href])).toEqual([['OPEN_AGENDA_ITEM', 'Voir cette échéance', '/agenda?tiroir=echeance%3A1']]);
    expect(persisted[0]).toEqual(r.actions);
  });
});
