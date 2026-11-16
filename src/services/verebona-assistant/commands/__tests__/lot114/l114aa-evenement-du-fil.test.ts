/**
 * Passage 114AA (Trello #753, CDC T2 §6.1, §14.3 W21 – W26) — « CELUI-CI » D'UN TOUR À L'AUTRE : l'ÉVÉNEMENT
 * DE RÉFÉRENCE DU FIL.
 *
 *   B01  mémoire du fil : le dernier événement de référence sur lequel une action a ABOUTI ; une suppression
 *        l'oublie ; un plan refusé, en échec ou sans événement ne change rien ;
 *   B02  désignation : « cet événement de référence » sans mot ni date vise l'événement du fil, relu dans le
 *        compte ; sans événement dans le fil, la question est posée comme avant ;
 *   B03  le pronom SEUL (« à celui-ci ») ne vaut que pour « relie le fournisseur … » — la seule forme qui ne
 *        peut rien désigner d'autre ; « rattache le document … à celui-ci » reste le rattachement au BIEN ;
 *   B04  sans événement dans le fil, une phrase pronominale n'est PAS une commande : parcours de réponse normal ;
 *   B05  isolation : l'identifiant vient du contexte du FIL de l'utilisateur, et il est toujours relu dans le
 *        compte (un événement d'un autre compte n'est jamais trouvé) ; l'action demande une confirmation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

type Etat = import('../../reference-event-model').ReferenceEventState;
type Lookup = import('../../plan.service').CommandLookup;
type Action = import('../../catalog').PlannedAction;
type Resultat = import('../../catalog').ActionResult;

vi.mock('../../../canonical/operations', () => ({
  operationReader: () => ({ async listForAssistant() { return []; } }),
  operationNoun: () => 'intervention',
}));
vi.mock('@/services/business-operations/graph/read', () => ({ readOperationGraph: async () => ({ agendaItems: [] }) }));
vi.mock('@/services/documents/business-period-surfaces', async (o) => ({ ...(await o<object>()), readReferenceEvent: async () => null }));

const { parseCommands } = await import('../../parser');
const { prepareCommandSegments, evenementDuFilApres, documentVersion, supplierVersion } = await import('../../plan.service');
const { isReferenceEventCommand } = await import('../../reference-events');

const TODAY = '2026-11-13';
/** Événement de référence du compte 1, celui que le fil a retenu. */
const DU_FIL: Etat = {
  id: 909, typeCode: 'INTERVENTION', status: 'REALIZED', label: 'Intervention — Vidange', technicalLabel: 'Vidange',
  provider: null, plannedDate: null, startDate: null, realizedDate: '2025-03-12', endDate: null,
  assets: [{ id: 7, name: 'Clio' }], documentTitles: [], version: 3,
};
const DOC = { id: 55, title: 'Facture Norauto', originalFilename: 'f.pdf', documentDate: '2025-03-12', notesShown: '', notesUserOwned: false, isWebLink: false, webLinkUrl: null, assetLabel: 'Clio' };
const DOC_ETAT = { ...DOC, version: documentVersion(DOC) };
const FOURNISSEUR = { id: 31, name: 'Garage Martin', status: 'active', phone: null, email: null, website: null };
const FOURNISSEUR_ETAT = { ...FOURNISSEUR, version: supplierVersion(FOURNISSEUR), links: { documents: 0, assets: 0, equipments: 0, agenda: 0 } };

const vu = { etats: [] as Array<[number, number]> };

const lookup = (): Lookup => ({
  today: () => TODAY,
  async findAssets(_a, w) { return [{ id: 7, name: 'Clio' }].filter((b) => w.some((x) => b.name.toLowerCase().includes(x))); },
  async getAsset(_a, id) { return id === 7 ? { id: 7, name: 'Clio' } : null; },
  async findReferenceEvents() { return []; },
  // Lecture BORNÉE AU COMPTE : un événement d'un autre compte n'est jamais rendu.
  async getReferenceEventState(a, id) { vu.etats.push([a, id]); return a === 1 && id === DU_FIL.id ? { ...DU_FIL } : null; },
  async getDocumentAssetTargets() { return { chosen: [], implied: [] }; },
  async findDocuments(_a, w) { return w.every((x) => DOC.title.toLowerCase().includes(x)) ? [{ id: DOC.id, title: DOC.title, documentDate: DOC.documentDate }] : []; },
  async getDocumentState(_a, id) { return id === DOC.id ? DOC_ETAT : null; },
  async findSuppliers(_a, w) { return w.every((x) => FOURNISSEUR.name.toLowerCase().includes(x)) ? [{ id: 31, name: FOURNISSEUR.name, status: 'active' }] : []; },
  async getSupplierState(_a, id) { return id === 31 ? FOURNISSEUR_ETAT : null; },
});

const entree = (message: string, extra: Record<string, unknown> = {}) =>
  ({ accountId: 1, userId: 2, planType: 'PREMIUM', message, clientRequestId: 'aa', locale: 'fr-FR', ...extra }) as never;

const preparer = async (message: string, extra: Record<string, unknown> = {}) => {
  const segments = parseCommands(message, TODAY);
  return segments ? prepareCommandSegments(segments, entree(message, extra), lookup()) : null;
};

const action = (actionId: string, command: Action['command']): Action =>
  ({ actionId, command, targets: [], params: {} as never, dependsOn: [], preview: '', effects: [] });
const ok = (actionId: string, id?: number): Resultat =>
  ({ actionId, status: 'SUCCESS', message: '', ...(id ? { entity: { type: 'reference_event' as const, id } } : {}) });

beforeEach(() => { vu.etats = []; });

describe('L114AA-B01 — mémoire du fil : le dernier événement sur lequel une action a abouti', () => {
  it('une déclaration réussie devient l’événement du fil', () => {
    expect(evenementDuFilApres([action('a1', 'CREATE_REFERENCE_EVENT')], [ok('a1', 909)])).toBe(909);
  });

  it('correction, association, rattachement, lien : l’événement visé devient celui du fil', () => {
    for (const c of ['UPDATE_REFERENCE_EVENT', 'ASSOCIATE_REFERENCE_EVENTS', 'LINK_DOCUMENT_REFERENCE_EVENT', 'LINK_SUPPLIER_REFERENCE_EVENT'] as const) {
      expect(evenementDuFilApres([action('a1', c)], [ok('a1', 404)])).toBe(404);
    }
  });

  it('une suppression réussie OUBLIE l’événement du fil (il n’existe plus)', () => {
    expect(evenementDuFilApres([action('a1', 'INVALIDATE_REFERENCE_EVENT')], [ok('a1', 909)])).toBeNull();
  });

  it('plan à deux actions : c’est la DERNIÈRE qui a abouti qui compte', () => {
    const actions = [action('a1', 'CREATE_REFERENCE_EVENT'), action('a2', 'LINK_SUPPLIER_REFERENCE_EVENT')];
    expect(evenementDuFilApres(actions, [ok('a1', 909), ok('a2', 909)])).toBe(909);
    // La seconde action n'a pas été exécutée : l'événement créé reste celui du fil.
    expect(evenementDuFilApres(actions, [ok('a1', 909), { actionId: 'a2', status: 'SKIPPED_DEPENDENCY', message: '' }])).toBe(909);
  });

  it('rien à mémoriser : action refusée, en échec, sans événement, ou qui ne porte pas sur un événement', () => {
    expect(evenementDuFilApres([action('a1', 'CREATE_REFERENCE_EVENT')], [{ actionId: 'a1', status: 'REFUSED', message: '' }])).toBeUndefined();
    expect(evenementDuFilApres([action('a1', 'CREATE_REFERENCE_EVENT')], [{ actionId: 'a1', status: 'FAILED', message: '' }])).toBeUndefined();
    // Réussie mais sans identifiant rendu par la façade : le fil garde ce qu'il avait.
    expect(evenementDuFilApres([action('a1', 'UPDATE_REFERENCE_EVENT')], [ok('a1')])).toBeUndefined();
    // Une action sur un bien ne touche jamais l'événement du fil.
    expect(evenementDuFilApres([action('a1', 'RENAME_ASSET')], [ok('a1', 909)])).toBeUndefined();
    // Résultat orphelin (action absente du plan) : ignoré.
    expect(evenementDuFilApres([], [ok('a1', 909)])).toBeUndefined();
  });
});

describe('L114AA-B02 — « cet événement de référence » vise l’événement du fil', () => {
  it.each([
    ['Supprime cet événement de référence', 'INVALIDATE_REFERENCE_EVENT'],
    ['Corrige la date de cet événement de référence : 14 mars 2025', 'UPDATE_REFERENCE_EVENT'],
    ['Relie le fournisseur Garage Martin à cet événement de référence', 'LINK_SUPPLIER_REFERENCE_EVENT'],
    ['Rattache le document Facture Norauto à cet événement de référence', 'LINK_DOCUMENT_REFERENCE_EVENT'],
  ])('%s → proposition sur l’événement du fil, à confirmer', async (phrase, commande) => {
    const p = await preparer(phrase, { threadReferenceEventId: DU_FIL.id });
    expect(p?.kind).toBe('plan');
    const plan = p as Extract<typeof p, { kind: 'plan' }>;
    expect(plan.plan.actions[0].command).toBe(commande);
    // L'aperçu NOMME l'événement : l'utilisateur voit sur quoi il s'engage avant de confirmer.
    expect(plan.preview.summary).toContain('Intervention — Vidange');
    expect(plan.preview.summary).toContain('Confirmez-vous ?');
    // Jamais le mot interdit.
    expect(plan.preview.summary).not.toMatch(/Opération/);
    // L'identifiant du fil est RELU dans le compte de la session, jamais utilisé tel quel.
    expect(vu.etats).toContainEqual([1, DU_FIL.id]);
  });

  it('sans événement dans le fil : la question d’avant, aucun plan', async () => {
    const p = await preparer('Supprime cet événement de référence');
    expect(p).toMatchObject({ kind: 'need_info', message: 'Quel événement de référence voulez-vous supprimer ? Donnez son intitulé, sa date complète ou son bien.' });
  });

  it('événement du fil devenu introuvable (supprimé depuis, ou hors du compte) : la question, aucun plan', async () => {
    // Identifiant présent dans le contexte du fil, mais absent du compte : il n'est jamais retenu.
    const p = await preparer('Supprime cet événement de référence', { threadReferenceEventId: 4242 });
    expect(p).toMatchObject({ kind: 'need_info' });
    expect((p as { message: string }).message).toContain('Quel événement de référence voulez-vous supprimer ?');
    expect(vu.etats).toContainEqual([1, 4242]);
  });

  it('une désignation par des MOTS garde la priorité sur l’événement du fil', async () => {
    // « l'intervention Vidange » est une désignation explicite : elle passe par la recherche habituelle, qui ne
    // trouve rien ici — l'événement du fil ne se substitue jamais à une désignation donnée par l'utilisateur.
    const p = await preparer('Supprime l’intervention Freins', { threadReferenceEventId: DU_FIL.id });
    expect(p).toBeNull();
  });
});

describe('L114AA-B03 — le pronom seul : une seule forme admise', () => {
  it('« Relie le fournisseur … à celui-ci » vise l’événement du fil', async () => {
    const p = await preparer('Relie le fournisseur Garage Martin à celui-ci', { threadReferenceEventId: DU_FIL.id });
    expect(p?.kind).toBe('plan');
    const plan = p as Extract<typeof p, { kind: 'plan' }>;
    expect(plan.plan.actions[0]).toMatchObject({ command: 'LINK_SUPPLIER_REFERENCE_EVENT' });
    expect(plan.preview.summary).toContain('Relier le fournisseur « Garage Martin » à l’événement de référence « Intervention — Vidange »');
  });

  it('« Rattache le document … à celui-ci » reste le rattachement au BIEN (comportement d’avant)', async () => {
    const segments = parseCommands('Rattache le document Facture Norauto à celui-ci', TODAY)!;
    expect(segments[0].draft.command).toBe('UPDATE_DOCUMENT_TARGETS');
    // Même avec un événement dans le fil : la phrase n'est pas détournée.
    const p = await preparer('Rattache le document Facture Norauto à celui-ci', { threadReferenceEventId: DU_FIL.id });
    expect(p?.kind === 'plan' ? p.plan.actions[0].command : null).not.toBe('LINK_DOCUMENT_REFERENCE_EVENT');
  });
});

describe('L114AA-B04 — sans événement dans le fil, une phrase pronominale n’est pas une commande', () => {
  it('le brouillon est écarté : parcours de réponse normal, comme avant ce passage', async () => {
    const draft = parseCommands('Relie le fournisseur Garage Martin à celui-ci', TODAY)![0].draft;
    expect(draft).toMatchObject({ target: { pronounOnly: true } });
    expect(await isReferenceEventCommand(draft as never, entree('x'), lookup())).toBe(false);
    expect(await preparer('Relie le fournisseur Garage Martin à celui-ci')).toBeNull();
  });

  it('avec un événement dans le fil, la même phrase devient une commande', async () => {
    const draft = parseCommands('Relie le fournisseur Garage Martin à celui-ci', TODAY)![0].draft;
    expect(await isReferenceEventCommand(draft as never, entree('x', { threadReferenceEventId: DU_FIL.id }), lookup())).toBe(true);
  });

  it('phrase à deux actions (« Déclare … puis relie … à celui-ci ») : admise sans événement dans le fil', async () => {
    const draft = parseCommands('Déclare une intervention « Vidange » réalisée le 12 mars 2025 pour la Clio puis relie le fournisseur Garage Martin à celui-ci', TODAY)![1].draft;
    // Le quatrième argument dit que le segment vise l'événement de la MÊME phrase : le fil n'a rien à porter.
    expect(await isReferenceEventCommand(draft as never, entree('x'), lookup(), true)).toBe(true);
    expect(await isReferenceEventCommand(draft as never, entree('x'), lookup(), false)).toBe(false);
  });
});

describe('L114AA-B05 — isolation du compte et du fil', () => {
  it('l’événement du fil est relu avec le compte de la SESSION', async () => {
    await preparer('Supprime cet événement de référence', { accountId: 99, threadReferenceEventId: DU_FIL.id });
    expect(vu.etats).toEqual([[99, DU_FIL.id]]);
    // Compte 99 : la lecture ne rend rien → aucune action n'est préparée sur l'événement du compte 1.
  });

  it('un événement du fil d’un autre compte n’aboutit à aucun plan', async () => {
    const p = await preparer('Supprime cet événement de référence', { accountId: 99, threadReferenceEventId: DU_FIL.id });
    expect(p).toMatchObject({ kind: 'need_info' });
  });
});
