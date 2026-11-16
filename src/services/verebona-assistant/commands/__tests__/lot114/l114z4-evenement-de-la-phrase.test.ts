/**
 * Passage 114Z4 (Trello #753, CDC T2 §9.5, §14.3 W21, W25, W26) — « DÉCLARE … PUIS RELIE … À CELUI-CI »
 * dans une même phrase : l'événement visé par la seconde action est celui que la première enregistre.
 *
 *   D01  phrases reconnues : « à celui-ci », « à ce dernier », « à cet événement de référence » ;
 *   D02  plan : le document ou le fournisseur sont figés dès l'aperçu, l'événement est annoncé comme celui de
 *        l'action précédente ; la seconde action dépend de la première ;
 *   D03  hors de ce cas (une seule action, ou « et » sans dépendance) : rien ne change — la question est posée ;
 *   D04  exécution : l'identifiant créé est posé à l'exécution ; la première action échoue → la seconde n'est pas
 *        exécutée et rien n'est écrit ; l'événement créé est relu à sa version, pas à celle de l'aperçu.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

type Etat = import('../../reference-event-model').ReferenceEventState;
type Lookup = import('../../plan.service').CommandLookup;

const base = vi.hoisted(() => ({
  appels: [] as Array<{ commande: string; entree: Record<string, unknown> }>,
  /** Événement « créé » par la façade simulée (identifiant inconnu à l'aperçu). */
  cree: { id: 0, version: 0 },
  creation: 'ok' as 'ok' | 'ko',
}));
vi.mock('../../../canonical/operations', () => ({
  operationReader: () => ({ async listForAssistant() { return []; } }),
  operationNoun: () => 'intervention',
}));
vi.mock('@/services/business-operations/graph/read', () => ({ readOperationGraph: async () => ({ agendaItems: [] }) }));
vi.mock('@/services/documents/business-period-surfaces', async (o) => ({ ...(await o<object>()), readReferenceEvent: async () => null }));
vi.mock('@/services/business-operations/operation-write.facade', () => {
  const journal = (nom: string) => async (_ctx: Record<string, unknown>, entree: Record<string, unknown>) => {
    base.appels.push({ commande: nom, entree });
    if (nom === 'createOperation') {
      if (base.creation === 'ko') return { status: 'FORBIDDEN', code: 'INVALID_INPUT', changed: false, replayed: false };
      base.cree = { id: 909, version: 1 };
      return { status: 'APPLIED', code: 'OK', changed: true, replayed: false, data: { operationId: 909, version: 1 } };
    }
    return { status: 'APPLIED', code: 'OK', changed: true, replayed: false, data: { operationId: entree.operationId } };
  };
  return {
    createOperation: journal('createOperation'), updateOperation: journal('updateOperation'), invalidateOperation: journal('invalidateOperation'),
    associateOperations: journal('associateOperations'), linkDocument: journal('linkDocument'), linkSupplier: journal('linkSupplier'),
  };
});

const { parseCommands } = await import('../../parser');
const { prepareCommandSegments, executeActions, documentVersion, supplierVersion, sqlLookup } = await import('../../plan.service');
// Les exécuteurs relisent l'état par les lectures de production : elles sont remplacées ici (aucune base).
const lectures = sqlLookup as Required<typeof sqlLookup>;

const TODAY = '2026-11-13';
const input = { accountId: 1, userId: 2, planType: 'PREMIUM', message: '', clientRequestId: 'z4', locale: 'fr-FR' } as never;

const DOC = { id: 55, title: 'Facture Norauto', originalFilename: 'f.pdf', documentDate: '2025-03-12', notesShown: '', notesUserOwned: false, isWebLink: false, webLinkUrl: null, assetLabel: 'Clio' };
const DOC_ETAT = { ...DOC, version: documentVersion(DOC) };
const FOURNISSEUR = { id: 31, name: 'Garage Martin', status: 'active', phone: null, email: null, website: null };
const FOURNISSEUR_ETAT = { ...FOURNISSEUR, version: supplierVersion(FOURNISSEUR), links: { documents: 0, assets: 0, equipments: 0, agenda: 0 } };
/** L'événement « créé » devient lisible, à SA version — jamais celle de l'aperçu (il n'en avait pas). */
const CREE = (): Etat => ({
  id: base.cree.id, typeCode: 'INTERVENTION', status: 'REALIZED', label: 'Intervention — Vidange', technicalLabel: 'Vidange', provider: null,
  plannedDate: null, startDate: null, realizedDate: '2025-03-12', endDate: null, assets: [{ id: 7, name: 'Clio' }], documentTitles: [], version: base.cree.version,
});

const lookup = (): Lookup => ({
  today: () => TODAY,
  async findAssets(_a, w) { return [{ id: 7, name: 'Clio' }].filter((b) => w.some((x) => b.name.toLowerCase().includes(x))); },
  async getAsset(_a, id) { return id === 7 ? { id: 7, name: 'Clio' } : null; },
  async findReferenceEvents() { return []; },
  async getReferenceEventState(_a, id) { return base.cree.id && id === base.cree.id ? CREE() : null; },
  async findDocuments(_a, w) { return w.every((x) => DOC.title.toLowerCase().includes(x)) ? [{ id: DOC.id, title: DOC.title, documentDate: DOC.documentDate }] : []; },
  async getDocumentState(_a, id) { return id === DOC.id ? DOC_ETAT : null; },
  async findSuppliers(_a, w) { return w.every((x) => FOURNISSEUR.name.toLowerCase().includes(x)) ? [{ id: 31, name: FOURNISSEUR.name, status: 'active' }] : []; },
  async getSupplierState(_a, id) { return id === 31 ? FOURNISSEUR_ETAT : null; },
});

const DECLARE = 'Déclare une intervention « Vidange » réalisée le 12 mars 2025 pour la Clio';
const preparer = async (message: string) => {
  const segments = parseCommands(message, TODAY);
  return segments ? prepareCommandSegments(segments, { ...(input as object), message } as never, lookup()) : null;
};

beforeEach(() => {
  base.appels = []; base.cree = { id: 0, version: 0 }; base.creation = 'ok';
  vi.restoreAllMocks();
  vi.spyOn(lectures, 'getReferenceEventState').mockImplementation(async (_a, id) => (base.cree.id && id === base.cree.id ? CREE() : null));
  vi.spyOn(lectures, 'findReferenceEvents').mockImplementation(async () => []);
  vi.spyOn(lectures, 'getDocumentState').mockImplementation(async (_a, id) => (id === DOC.id ? DOC_ETAT : null));
  vi.spyOn(lectures, 'getSupplierState').mockImplementation(async (_a, id) => (id === 31 ? FOURNISSEUR_ETAT : null));
});

describe('L114Z4-D01 — phrases reconnues', () => {
  it.each([
    `${DECLARE} puis relie le fournisseur Garage Martin à celui-ci`,
    `${DECLARE} puis relie le fournisseur Garage Martin à ce dernier`,
    `${DECLARE} puis relie le fournisseur Garage Martin à cet événement de référence`,
    `${DECLARE} puis relie le fournisseur Garage Martin à celui-ci comme intervenant`,
  ])('fournisseur : %s', (phrase) => {
    const segments = parseCommands(phrase, TODAY)!;
    expect(segments).toHaveLength(2);
    expect(segments[1]).toMatchObject({
      dependsOnPrevious: true,
      draft: { command: 'LINK_SUPPLIER_REFERENCE_EVENT', supplierWords: ['garage', 'martin'], target: { fromContext: true, words: [] } },
    });
    expect(segments[1].draft).toMatchObject({ role: phrase.endsWith('intervenant') ? 'INTERVENER' : 'PROVIDER' });
  });

  it('document : « puis rattache le document … à celui-ci »', () => {
    const segments = parseCommands(`${DECLARE} puis rattache le document Facture Norauto à celui-ci`, TODAY)!;
    expect(segments[1]).toMatchObject({
      dependsOnPrevious: true,
      draft: { command: 'LINK_DOCUMENT_REFERENCE_EVENT', documentWords: ['facture', 'norauto'], documentFromContext: false, target: { fromContext: true } },
    });
  });

  it('hors d’une phrase à deux actions, « à celui-ci » n’est pas un événement de référence (comportement d’avant)', () => {
    // « Rattache le document X à celui-ci » reste le rattachement au bien de la page ou du fil.
    expect(parseCommands('Rattache le document Facture Norauto à celui-ci', TODAY)![0].draft.command).toBe('UPDATE_DOCUMENT_TARGETS');
    // Règle remplacée (carte #753, passage 114AA) : « Relie le fournisseur … à celui-ci » SEUL rendait `null`.
    // C'est désormais un lien vers l'événement de référence DU FIL — la seule forme pronominale qui ne peut
    // rien désigner d'autre. Le brouillon est reconnu ici ; sans événement dans le fil, la préparation du plan
    // le rejette et la phrase suit le parcours de réponse normal, exactement comme avant
    // (`isReferenceEventCommand`, prouvé dans `l114aa-evenement-du-fil.test.ts`).
    const seul = parseCommands('Relie le fournisseur Garage Martin à celui-ci', TODAY)!;
    expect(seul).toHaveLength(1);
    expect(seul[0].draft).toMatchObject({
      command: 'LINK_SUPPLIER_REFERENCE_EVENT', supplierWords: ['garage', 'martin'],
      target: { fromContext: true, pronounOnly: true },
    });
    // « et » (actions indépendantes) après une déclaration : l'anaphore n'est pas admise — « celui-ci » ne
    // peut pas désigner un événement que la même phrase n'a pas encore enregistré.
    expect(parseCommands(`${DECLARE} et relie le fournisseur Garage Martin à celui-ci`, TODAY)).toBeNull();
  });

  it('une désignation par des MOTS n’est jamais une anaphore', () => {
    const segments = parseCommands(`${DECLARE} puis relie le fournisseur Garage Martin à l’intervention Vidange`, TODAY)!;
    expect((segments[1].draft as { target: { words: string[]; fromContext?: boolean } }).target)
      .toMatchObject({ words: ['vidange'] });
    expect((segments[1].draft as { target: { fromContext?: boolean } }).target.fromContext).toBeUndefined();
  });
});

describe('L114Z4-D02 — plan : une confirmation, deux actions, la seconde dépendante', () => {
  it('fournisseur figé dès l’aperçu ; l’événement est celui de l’action précédente', async () => {
    const p = await preparer(`${DECLARE} puis relie le fournisseur Garage Martin à celui-ci`);
    expect(p?.kind).toBe('plan');
    const plan = (p as { kind: 'plan'; preview: { summary: string; actions: Array<{ actionId: string; preview: string; effects: string[]; dependsOn: string[] }> } }).preview;
    expect(plan.summary).toBe('Je vais effectuer 2 actions, dans l’ordre indiqué. Confirmez-vous l’ensemble ?');
    expect(plan.actions[0].preview).toContain('Enregistrer l’événement de référence « Intervention — Vidange »');
    expect(plan.actions[1].preview).toBe('Relier le fournisseur « Garage Martin » à l’événement de référence qui vient d’être enregistré.');
    expect(plan.actions[1].effects).toEqual([
      'Fournisseur : Garage Martin', 'Rôle : Prestataire',
      'Événement de référence : celui que l’action précédente enregistre.',
      'Si cet enregistrement n’aboutit pas, ce lien n’est pas fait et rien n’est écrit.',
      'Aucun document, aucun coût et aucune échéance ne sont créés.',
      'Ce lien est votre décision : il ne sera pas modifié par une analyse.',
    ]);
    expect(plan.actions[1].dependsOn).toEqual([plan.actions[0].actionId]);
    expect(JSON.stringify(plan)).not.toMatch(/op[ée]ration/i);
    // Rien n'est écrit par la préparation.
    expect(base.appels).toEqual([]);
  });

  it('document : même plan, l’aperçu nomme le document et dit la dépendance', async () => {
    const p = await preparer(`${DECLARE} puis rattache le document Facture Norauto à celui-ci`);
    const plan = (p as { preview: { actions: Array<{ preview: string; effects: string[] }> } }).preview;
    expect(plan.actions[1].preview).toBe('Rattacher le document « Facture Norauto » à l’événement de référence qui vient d’être enregistré.');
    expect(plan.actions[1].effects[0]).toBe('Document : Facture Norauto du 12 mars 2025');
  });

  it('un fournisseur introuvable est dit avant tout plan (rien n’est préparé)', async () => {
    const p = await preparer(`${DECLARE} puis relie le fournisseur Plomberie Dupont à celui-ci`);
    expect(p?.kind).toBe('need_info');
    expect((p as { message: string }).message).toContain('Action 2 :');
  });
});

describe('L114Z4-D03 — hors de ce cas, rien ne change', () => {
  it('« à celui-ci » sans déclaration qui précède : la question est posée, aucun plan', async () => {
    const p = await preparer('Relie le fournisseur Garage Martin à cet événement de référence');
    expect(p === null || p.kind === 'need_info').toBe(true);
    if (p?.kind === 'need_info') expect(p.message).toMatch(/[Qq]uel événement de référence/);
  });

  it('« et » (actions indépendantes) ne désigne pas l’événement de la première', async () => {
    const p = await preparer(`${DECLARE} et relie le fournisseur Garage Martin à cet événement de référence`);
    expect(p === null || p.kind === 'need_info').toBe(true);
    if (p?.kind === 'need_info') expect(p.message).toMatch(/événement de référence/);
  });
});

describe('L114Z4-D04 — exécution', () => {
  const executer = async (message: string) => {
    const p = await preparer(message);
    const plan = (p as { preview: { actions: Array<{ actionId: string }> } }).preview;
    const actions = (p as unknown as { plan: { actions: import('../../catalog').PlannedAction[] } }).plan.actions;
    const results = await executeActions(actions, {
      accountId: 1, userId: 2, planId: 'p-z4', referenceEventVersions: new Map(), recordUndo: () => {},
    } as never);
    return { plan, results };
  };

  it('l’identifiant créé est posé à l’exécution ; la façade reçoit l’événement créé', async () => {
    const { results } = await executer(`${DECLARE} puis relie le fournisseur Garage Martin à celui-ci`);
    expect(results.map((r) => r.status)).toEqual(['SUCCESS', 'SUCCESS']);
    expect(base.appels.map((a) => a.commande)).toEqual(['createOperation', 'linkSupplier']);
    expect(base.appels[1].entree).toMatchObject({ operationId: 909, supplierId: 31, role: 'PROVIDER' });
    expect(results[1].message).toBe('Fournisseur « Garage Martin » relié à l’événement de référence « Intervention — Vidange ».');
  });

  it('document : rattaché à l’événement créé', async () => {
    const { results } = await executer(`${DECLARE} puis rattache le document Facture Norauto à celui-ci`);
    expect(results.map((r) => r.status)).toEqual(['SUCCESS', 'SUCCESS']);
    expect(base.appels[1]).toMatchObject({ commande: 'linkDocument', entree: { operationId: 909, fileId: 55 } });
  });

  it('la déclaration échoue : le lien n’est PAS exécuté, et rien n’est écrit', async () => {
    base.creation = 'ko';
    const { results } = await executer(`${DECLARE} puis relie le fournisseur Garage Martin à celui-ci`);
    expect(results.map((r) => r.status)).toEqual(['REFUSED', 'SKIPPED_DEPENDENCY']);
    expect(base.appels.map((a) => a.commande)).toEqual(['createOperation']);
    expect(results[1].message).toContain('non exécutée');
  });
});
