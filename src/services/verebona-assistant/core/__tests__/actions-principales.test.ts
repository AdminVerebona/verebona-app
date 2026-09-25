/**
 * Une action principale pertinente — CDC §22.9, §22.10, §10.5, CA-14,
 * 37.4, 37.11, 37.15.
 *
 * Avant : « Ouvre mon agenda » répondait « Je n'ai pas trouvé d'élément
 * suffisant… » avec trois boutons ; « Comment ajouter un document ? »
 * proposait « Ajouter un bien » mais pas « Ajouter un document ».
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => { throw new Error('aucune base en test'); }) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { construireActionIntents } = await import('../ports');
const { resolveActions, exigeUneCible } = await import('../action-resolver.service');
const { routeDeterministic, routeForIntent } = await import('../intent-router.service');
const { runAssistant } = await import('../assistant-orchestrator.service');
const { findNavigationTarget } = await import('../navigation-targets');
type Input = import('../../types/contracts').AssistantRequestInput;
type Route = import('../../types/contracts').IntentRoute;
type Source = import('../../types/sources').RetrievedSource;

const ACCESS = {
  assetInAccount: async (_a: number, id: number) => id === 42,
  documentInAccount: async () => true,
  agendaItemInAccount: async () => true,
  helpEntryPublished: async () => true,
};

function input(message: string, extra: Partial<Input> = {}): Input {
  return { accountId: 7, userId: 3, planType: 'STANDARD', message, clientRequestId: 'c', locale: 'fr-FR', ...extra };
}

function routeOf(message: string): Route {
  const o = routeDeterministic({ message, planType: 'STANDARD', hasPendingClarification: false });
  if (o.kind !== 'route') throw new Error(`non routé : ${message}`);
  return o.route;
}

async function actionsFor(message: string, sources: Source[] = [], extra: Partial<Input> = {}, route = routeOf(message)) {
  const inp = input(message, extra);
  const list = await resolveActions({
    accountId: 7, intent: route.intent, actionIntents: construireActionIntents(route, inp, sources), access: ACCESS,
  });
  // Même filtre que le port réel : pas d'ouverture sans destination.
  return list.filter((a) => a.href !== null || !a.type.startsWith('OPEN_'));
}

describe('navigation explicite (§22.10, 37.11)', () => {
  it('« Ouvre mon agenda » → un seul bouton « Ouvrir l’agenda »', async () => {
    const a = await actionsFor('Ouvre mon agenda');
    expect(a.map((x) => [x.type, x.label, x.href])).toEqual([['OPEN_AGENDA', "Ouvrir l'agenda", '/agenda']]);
  });

  it.each([
    ['Ouvre À traiter', 'OPEN_TO_PROCESS', '/accueil/a-traiter'],
    ['Affiche mes documents', 'OPEN_DOCUMENTS_PAGE', '/documents'],
    ['Ouvre mon compte', 'OPEN_ACCOUNT', '/mon-compte'],
    ['Montre-moi les offres', 'OPEN_PRICING', '/abonnement'],
    ["Ouvre l'aide", 'OPEN_HELP', '/aide'],
  ])('« %s » → %s uniquement', async (message, type, href) => {
    const a = await actionsFor(message);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ type, href });
  });

  it('orchestrateur : « Ouvre mon agenda » → « Voici votre agenda. » + un bouton, sans retrieval ni modèle', async () => {
    const retrieve = vi.fn(async () => []);
    const r = await runAssistant(input('Ouvre mon agenda'), {
      retrieve,
      resolveSources: async () => [],
      resolveActions: (route, inp, sources) => resolveActions({
        accountId: 7, intent: route.intent, actionIntents: construireActionIntents(route, inp, sources), access: ACCESS,
      }),
      persist: async () => null,
      hasPendingClarification: async () => false,
    });
    expect(r.answer).toBe('Voici votre agenda.');
    expect(r.actions.map((a) => a.type)).toEqual(['OPEN_AGENDA']);
    expect(retrieve).not.toHaveBeenCalled();
    expect(r.cascade?.aiCalls).toBe(0);
  });

  it('dictionnaire : « À traiter » l’emporte sur « documents »', () => {
    expect(findNavigationTarget('Ouvre les documents à traiter')?.action).toBe('OPEN_TO_PROCESS');
  });
});

describe('aide produit : l’action qui fait ce que la question demande (§10.5)', () => {
  it('« Comment ajouter un document ? » → « Ajouter un document » en principal, sans « Ajouter un bien »', async () => {
    const a = await actionsFor('Comment ajouter un document ?');
    expect(a[0]).toMatchObject({ type: 'START_ADD_DOCUMENT', label: 'Ajouter un document', href: '/documents' });
    expect(a.map((x) => x.type)).not.toContain('START_ADD_ASSET');
    expect(a.map((x) => x.type)).not.toContain('START_ADD_AGENDA_ITEM');
  });

  it('37.15 « Where can I upload a document? » → « Ajouter un document »', async () => {
    const a = await actionsFor('Where can I upload a document?');
    expect(a[0].type).toBe('START_ADD_DOCUMENT');
  });

  it('37.4 « À quoi sert À traiter ? » → « Ouvrir « À traiter » » en principal', async () => {
    const a = await actionsFor('À quoi sert À traiter ?');
    expect(a[0]).toMatchObject({ type: 'OPEN_TO_PROCESS', label: 'Ouvrir « À traiter »' });
  });

  it('sur la page d’un bien, « Ajouter un document » vise ce bien', async () => {
    const a = await actionsFor('Comment ajouter un document ?', [], { pageContext: { assetId: '42' } });
    expect(a.some((x) => x.type === 'START_ADD_DOCUMENT' && x.href === '/assets/42?tab=documents')).toBe(true);
  });
});

describe('cible facultative de START_ADD_DOCUMENT', () => {
  it('ne l’exige plus, mais contrôle une cible fournie', async () => {
    expect(exigeUneCible('START_ADD_DOCUMENT')).toBe(false);
    expect(exigeUneCible('OPEN_ASSET')).toBe(true);
    const forge = await resolveActions({
      accountId: 7, intent: 'PRODUCT_HELP_HOW_TO', access: ACCESS,
      actionIntents: [{ type: 'START_ADD_DOCUMENT', targetId: 'asset_999' }],
    });
    expect(forge).toEqual([]);
  });
});

describe('plus d’ajout en bloc des types sans cible (§22.9)', () => {
  it('« À traiter » sans résultat : une seule action, la page À traiter', async () => {
    const a = await actionsFor('Que dois-je traiter en priorité ?');
    expect(a.map((x) => x.type)).toEqual(['OPEN_TO_PROCESS']);
  });

  it('recherche de documents : 1 principale + 2 secondaires au plus, entités d’abord', async () => {
    const docs = [1, 2, 3, 4].map((i) => ({ id: `doc_${i}`, type: 'document', title: `D${i}`, content: '', relevanceScore: 1 })) as Source[];
    const a = await actionsFor('Retrouve la facture de mon vélo', docs);
    expect(a.map((x) => x.type)).toEqual(['OPEN_DOCUMENT', 'OPEN_DOCUMENT', 'OPEN_DOCUMENT']);
  });

  it('synthèse avec sources : « Voir les sources » et « Pourquoi ? » hors quota métier', async () => {
    const docs = [{ id: 'doc_1', type: 'document', title: 'D1', content: '', relevanceScore: 1 }] as Source[];
    const a = await actionsFor('Résume les garanties de mon vélo', docs, {}, routeForIntent('ACCOUNT_SUMMARY', 'PREMIUM', 't'));
    expect(a.map((x) => x.type)).toEqual(['OPEN_DOCUMENT', 'SHOW_SOURCES', 'SHOW_EXPLANATION']);
  });
});
