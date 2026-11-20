/**
 * Lot 114X (Trello #753, CDC T2 §14.3 W21 – W26, §14.4 « Opérations », X69 – X73) —
 * LES ÉVÉNEMENTS DE RÉFÉRENCE DEPUIS L'ASSISTANT.
 *
 *   P01  W21 : déclarer un événement de référence (type, intitulé, situation dite, date, bien) ;
 *   P02  W21 : « j'ai fait … de la Clio hier » — une commande seulement si le bien est un bien du compte ;
 *   P03  W22 à W26 : formes reconnues ;
 *   P04  non-régression : ce que les analyseurs existants prenaient reste à eux ; une question n'est jamais une commande ;
 *   R01  W21 : aperçu, situation demandée (jamais déduite), date jamais inventée, comparable annoncé, limite dite ;
 *   R02  W22 : un champ à la fois, avant → après ; refus dits avant tout plan ;
 *   R03  W23 : invalidation annoncée avec ce qui est conservé ; jamais un choix au hasard ;
 *   R04  W24 à W26 : nature de l'association, document, fournisseur ;
 *   X01  exécution : état relu, façade appelée (acteur, canal, clé d'idempotence, version), rien d'autre ;
 *   X02  chaque résultat de la façade est traduit — jamais un code, jamais le mot interdit ;
 *   C01  catalogue fermé : six fiches complètes ; vocabulaire aligné sur celui de l'Assistant.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

type Etat = import('../../reference-event-model').ReferenceEventState;
type Lookup = import('../../plan.service').CommandLookup;
type Result = import('@/services/business-operations/graph/model').OperationWriteResult<Record<string, unknown>>;

/** Événements « en base » pour les exécuteurs (lecteur canonique simulé) et appels reçus par la façade simulée. */
const base = vi.hoisted(() => ({
  ops: [] as Array<Record<string, unknown>>,
  appels: [] as Array<{ commande: string; ctx: Record<string, unknown>; entree: Record<string, unknown> }>,
  reponse: null as unknown,
  /** La correction simulée fait avancer la version de l'événement, comme la vraie façade. */
  avancer: false,
}));
vi.mock('../../../canonical/operations', () => ({
  operationReader: () => ({
    async listForAssistant(_accountId: number, f: { ids?: number[]; typeCodes?: string[] }) {
      return base.ops.filter((o) => (!f.ids || f.ids.includes(o.id as number)) && (!f.typeCodes || f.typeCodes.includes(o.typeCode as string)));
    },
  }),
  operationNoun: (code: string | null) => ({ ACQUISITION: 'achat', INTERVENTION: 'intervention', CONTRACT: 'contrat', FINANCING: 'financement', CLAIM: 'sinistre', DISPOSAL: 'vente' } as Record<string, string>)[code ?? ''] ?? 'dépense',
}));
vi.mock('@/services/business-operations/graph/read', () => ({ readOperationGraph: async () => ({ agendaItems: [] }) }));
vi.mock('@/services/documents/business-period-surfaces', async (o) => ({ ...(await o<object>()), readReferenceEvent: async () => null }));
vi.mock('@/services/business-operations/operation-write.facade', () => {
  const commande = (nom: string) => async (ctx: Record<string, unknown>, entree: Record<string, unknown>) => {
    base.appels.push({ commande: nom, ctx, entree });
    if (base.avancer && nom === 'updateOperation') {
      const cible = base.ops.find((o) => o.id === entree.operationId)!;
      if (entree.expectedVersion !== cible.version) return { status: 'CONFLICT', code: 'VERSION_MISMATCH', changed: false, replayed: false };
      cible.version = (cible.version as number) + 1;
      return { status: 'APPLIED', code: 'OK', changed: true, replayed: false, data: { operationId: cible.id, version: cible.version } };
    }
    return base.reponse;
  };
  return {
    createOperation: commande('createOperation'), updateOperation: commande('updateOperation'), invalidateOperation: commande('invalidateOperation'),
    associateOperations: commande('associateOperations'), linkDocument: commande('linkDocument'), linkSupplier: commande('linkSupplier'),
  };
});

const { parseCommand, parseCommands } = await import('../../parser');
const { resolveDraft, prepareCommand, documentVersion, supplierVersion, sqlLookup } = await import('../../plan.service');
// Les lectures d'état sont optionnelles dans le contrat (substituts de test) : l'espion a besoin du type complet.
const lectures = sqlLookup as Required<typeof sqlLookup>;
const { WRITE_COMMAND_CATALOG } = await import('../../catalog');
const modele = await import('../../reference-event-model');
const { REFERENCE_EVENT_EXECUTORS, NOT_YET_VISIBLE } = await import('../../reference-events');
const { runAction } = await import('../../executors');
const { executeActions } = await import('../../plan.service');
const { BUSINESS_OPERATION_TYPE_CODES } = await import('@/services/business-operations/model');

const TODAY = '2026-11-13';
const input = { accountId: 1, userId: 2, planType: 'PREMIUM', message: '', clientRequestId: 'x', locale: 'fr-FR' } as never;
const INTERDIT = /op[ée]ration/i;

const etat = (id: number, o: Partial<Etat> = {}): Etat => ({
  id, typeCode: 'INTERVENTION', status: 'REALIZED', label: `Intervention — ${o.technicalLabel ?? 'Vidange'}`, technicalLabel: 'Vidange', provider: null,
  plannedDate: null, startDate: null, realizedDate: '2025-03-12', endDate: null, assets: [{ id: 7, name: 'Clio' }], documentTitles: [], version: 3, ...o,
});
const VIDANGE = etat(101);
const VIDANGE_FILTRES = etat(102, { technicalLabel: 'Vidange et filtres', label: 'Intervention — Vidange et filtres', realizedDate: '2024-03-10' });
const PRET = etat(201, { typeCode: 'FINANCING', label: 'Financement — Prêt auto', technicalLabel: 'Prêt auto', realizedDate: null, startDate: '2021-05-03', assets: [] });
const ACHAT = etat(202, { typeCode: 'ACQUISITION', label: 'Achat — Clio', technicalLabel: 'Achat Clio', realizedDate: '2021-05-03' });
const CONTRAT = etat(203, { typeCode: 'CONTRACT', label: 'Contrat — Assurance auto', technicalLabel: 'Assurance auto', realizedDate: null, startDate: '2024-01-01', status: 'REALIZED', documentTitles: ['Attestation'], agendaItems: 2 });
const PREVUE = etat(104, { technicalLabel: 'Pneus hiver', label: 'Intervention — Pneus hiver', status: 'ENVISAGED', realizedDate: null, plannedDate: '2026-12-01' });
const TOUS = [VIDANGE, VIDANGE_FILTRES, PRET, ACHAT, CONTRAT, PREVUE];

const DOC = { id: 55, title: 'Facture Norauto', originalFilename: 'f.pdf', documentDate: '2025-03-12', notesShown: '', notesUserOwned: false, isWebLink: false, webLinkUrl: null, assetLabel: 'Clio' };
const DOC_ETAT = { ...DOC, version: documentVersion(DOC) };
const FOURNISSEUR = { id: 31, name: 'Garage Martin', status: 'active', phone: null, email: null, website: null };
const FOURNISSEUR_ETAT = { ...FOURNISSEUR, version: supplierVersion(FOURNISSEUR), links: { documents: 0, assets: 0, equipments: 0, agenda: 0 } };

const sansAccent = (t: string): string => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const lookup = (o: { etats?: Etat[]; biens?: Array<{ id: number; name: string }> } = {}): Lookup => ({
  today: () => TODAY,
  async findAssets(_a, w) { return (o.biens ?? [{ id: 7, name: 'Clio' }, { id: 8, name: 'Maison' }]).filter((b) => w.some((x) => sansAccent(b.name).includes(x))); },
  async getAsset(_a, id) { return (o.biens ?? [{ id: 7, name: 'Clio' }, { id: 8, name: 'Maison' }]).find((b) => b.id === id) ?? null; },
  async findReferenceEvents(_a, q) { return modele.matchReferenceEvents(o.etats ?? TOUS, q); },
  async getReferenceEventState(_a, id) { return (o.etats ?? TOUS).find((s) => s.id === id) ?? null; },
  async findDocuments(_a, w) { return w.every((x) => DOC.title.toLowerCase().includes(x)) ? [{ id: DOC.id, title: DOC.title, documentDate: DOC.documentDate }] : []; },
  async getDocumentState(_a, id) { return id === DOC.id ? DOC_ETAT : null; },
  async findSuppliers(_a, w) { return w.every((x) => FOURNISSEUR.name.toLowerCase().includes(x)) ? [{ id: 31, name: FOURNISSEUR.name, status: 'active' }] : []; },
  async getSupplierState(_a, id) { return id === 31 ? FOURNISSEUR_ETAT : null; },
});
const besoin = (a: unknown): string => (a as { needInfo: string }).needInfo;
const resoudre = async (phrase: string, l: Lookup = lookup()) => resolveDraft(parseCommand(phrase, TODAY)!, input, l);
type Action = import('../../catalog').PlannedAction;
const action = async (phrase: string, l: Lookup = lookup()): Promise<Action> => {
  const a = await resoudre(phrase, l);
  if ('needInfo' in (a as object)) throw new Error(`action attendue, reçu : ${besoin(a)}`);
  return a as Action;
};

describe('L114X-P01 — W21 : déclarer un événement de référence', () => {
  it('type, intitulé entre guillemets, situation dite, date, bien', () => {
    expect(parseCommand('Déclare une intervention « Vidange » réalisée le 12 mars 2025 pour la Clio', TODAY)).toEqual({
      command: 'CREATE_REFERENCE_EVENT', typeCode: 'INTERVENTION', status: 'REALIZED', dateText: '12 mars 2025', label: 'Vidange', labelQuoted: true,
      fullLabel: 'Vidange', assetWords: ['clio'], assetFromContext: false, implicit: false,
      declaration: 'Déclare une intervention « Vidange » réalisée le 12 mars 2025 pour la Clio',
    });
  });

  it('intitulé sans guillemets : le dernier complément est le bien — l’intitulé complet reste disponible', () => {
    expect(parseCommand('Peux-tu déclarer une intervention Remplacement de la chaudière de la maison, à prévoir ?', TODAY)).toMatchObject({
      command: 'CREATE_REFERENCE_EVENT', typeCode: 'INTERVENTION', status: 'ENVISAGED', dateText: null,
      label: 'Remplacement de la chaudière', fullLabel: 'Remplacement de la chaudière de la maison', assetWords: ['maison'], labelQuoted: false,
    });
  });

  it('« événement de référence » : le type n’est pas dit ; la situation non dite reste à demander', () => {
    expect(parseCommand('Enregistre un événement de référence « Travaux toiture »', TODAY)).toMatchObject({
      command: 'CREATE_REFERENCE_EVENT', typeCode: null, status: null, label: 'Travaux toiture', assetWords: [], assetFromContext: false,
    });
  });

  it.each([
    ['Déclare un achat « Vélo cargo » réalisé le 3/05/2021', 'ACQUISITION'], ['Déclare un contrat « Assurance auto » pour la Clio', 'CONTRACT'],
    ['Déclare un financement « Prêt auto »', 'FINANCING'], ['Déclare une vente « Ancienne Twingo »', 'DISPOSAL'], ['Déclare une cession « Ancienne Twingo »', 'DISPOSAL'],
  ])('%s → %s', (phrase, type) => {
    expect(parseCommand(phrase, TODAY)).toMatchObject({ command: 'CREATE_REFERENCE_EVENT', typeCode: type });
  });

  it('« ce véhicule » : bien du fil ; « hier » repris tel quel', () => {
    expect(parseCommand('Déclare une intervention « Vidange » faite hier pour ce véhicule', TODAY)).toMatchObject({ status: 'REALIZED', dateText: 'hier', assetFromContext: true, assetWords: [] });
  });
});

describe('L114X-P02 — W21 : « j’ai fait … » (déclaration implicite)', () => {
  it('« J’ai fait la vidange de la Clio hier » : intervention qui a eu lieu, sur un bien désigné', () => {
    expect(parseCommand('J’ai fait la vidange de la Clio hier', TODAY)).toMatchObject({
      command: 'CREATE_REFERENCE_EVENT', typeCode: 'INTERVENTION', status: 'REALIZED', dateText: 'hier', label: 'Vidange', assetWords: ['clio'], implicit: true,
    });
    expect(parseCommand('J’ai fait faire l’entretien de ma voiture le 12 mars', TODAY)).toMatchObject({ label: 'Entretien', assetWords: ['voiture'], dateText: '12 mars', implicit: true });
  });

  it.each(['J’ai fait une erreur dans la date d’achat de la Clio', 'J’ai fait le ménage', 'J’ai fait un devis pour la maison', 'J’ai fait'])('pas une commande : %s', (q) => {
    expect(parseCommand(q, TODAY)).toBeNull();
  });

  it('bien absent du compte : le message n’est pas pris comme une action (parcours de réponse normal)', async () => {
    const m = 'J’ai fait le tour de la question hier';
    expect(parseCommand(m, TODAY)).toMatchObject({ command: 'CREATE_REFERENCE_EVENT', implicit: true });
    expect(await prepareCommand({ ...(input as object), message: m } as never, lookup())).toBeNull();
    const ok = await prepareCommand({ ...(input as object), message: 'J’ai fait la vidange de la Clio hier' } as never, lookup());
    expect(ok).toMatchObject({ kind: 'plan' });
  });
});

describe('L114X-P03 — W22 à W26 : formes reconnues', () => {
  it('W22 : date, prestataire, intitulé, type, situation', () => {
    expect(parseCommand('Corrige la date de l’intervention Vidange de la Clio : 14 mars 2025', TODAY)).toMatchObject({
      command: 'UPDATE_REFERENCE_EVENT', field: 'date', value: '14 mars 2025', target: { typeCode: 'INTERVENTION', words: ['vidange', 'clio'], date: null },
    });
    expect(parseCommand('Change la date de l’intervention Vidange du 12 mars 2025 au 14 mars 2025', TODAY)).toMatchObject({
      field: 'date', value: '14 mars 2025', target: { words: ['vidange'], date: '2025-03-12' },
    });
    expect(parseCommand('Change le prestataire de l’intervention Vidange en Garage Martin', TODAY)).toMatchObject({ field: 'provider', value: 'Garage Martin', target: { words: ['vidange'] } });
    expect(parseCommand('Renomme l’intervention Vidange en Vidange et filtres', TODAY)).toMatchObject({ command: 'UPDATE_REFERENCE_EVENT', field: 'label', value: 'Vidange et filtres' });
    expect(parseCommand('Change le type de l’événement de référence Travaux toiture en intervention', TODAY)).toMatchObject({ field: 'type', value: 'intervention', target: { typeCode: null, words: ['travaux', 'toiture'] } });
    expect(parseCommand('Mets la date de fin du contrat Assurance auto au 31/12/2026', TODAY)).toMatchObject({ field: 'endDate', value: '31/12/2026', target: { typeCode: 'CONTRACT' } });
    expect(parseCommand('Indique que l’intervention Pneus hiver a eu lieu', TODAY)).toMatchObject({ command: 'UPDATE_REFERENCE_EVENT', field: 'status', value: 'REALIZED', target: { words: ['pneus', 'hiver'] } });
    expect(parseCommand('Corrige le prestataire de l’intervention Vidange', TODAY)).toMatchObject({ field: 'provider', value: null });
  });

  it('W23 : supprimer un événement de référence — jamais l’Agenda, jamais un bien', () => {
    expect(parseCommand('Supprime l’intervention Vidange de la Clio', TODAY)).toEqual({ command: 'INVALIDATE_REFERENCE_EVENT', target: { typeCode: 'INTERVENTION', words: ['vidange', 'clio'], date: null } });
    expect(parseCommand('Supprime l’événement de référence Travaux toiture du 2 juin 2024', TODAY)).toEqual({ command: 'INVALIDATE_REFERENCE_EVENT', target: { typeCode: null, words: ['travaux', 'toiture'], date: '2024-06-02' } });
    expect(parseCommand('Annule le contrat Assurance auto', TODAY)).toMatchObject({ command: 'INVALIDATE_REFERENCE_EVENT', target: { typeCode: 'CONTRACT' } });
  });

  it('W24, W25, W26 : associer, rattacher un document, relier un fournisseur', () => {
    expect(parseCommand('Associe le financement Prêt auto à l’achat de la Clio', TODAY)).toEqual({
      command: 'ASSOCIATE_REFERENCE_EVENTS', first: { typeCode: 'FINANCING', words: ['pret', 'auto'], date: null }, second: { typeCode: 'ACQUISITION', words: ['clio'], date: null },
    });
    expect(parseCommand('Rattache le document Facture Norauto à l’intervention Vidange', TODAY)).toEqual({
      command: 'LINK_DOCUMENT_REFERENCE_EVENT', documentWords: ['facture', 'norauto'], documentFromContext: false, target: { typeCode: 'INTERVENTION', words: ['vidange'], date: null },
    });
    expect(parseCommand('Associe ce document au contrat Assurance auto', TODAY)).toMatchObject({ command: 'LINK_DOCUMENT_REFERENCE_EVENT', documentFromContext: true, target: { typeCode: 'CONTRACT' } });
    expect(parseCommand('Relie le fournisseur Garage Martin à l’intervention Vidange', TODAY)).toEqual({
      command: 'LINK_SUPPLIER_REFERENCE_EVENT', supplierWords: ['garage', 'martin'], role: 'PROVIDER', target: { typeCode: 'INTERVENTION', words: ['vidange'], date: null },
    });
    expect(parseCommand('Ajoute le fournisseur Garage Martin à l’intervention Vidange comme intervenant', TODAY)).toMatchObject({ command: 'LINK_SUPPLIER_REFERENCE_EVENT', role: 'INTERVENER', target: { words: ['vidange'] } });
  });

  it('plusieurs commandes : « puis » rend la seconde dépendante', () => {
    const s = parseCommands('Déclare une intervention « Vidange » réalisée hier pour la Clio puis relie le fournisseur Garage Martin à l’intervention Vidange', TODAY)!;
    expect(s.map((x) => x.draft.command)).toEqual(['CREATE_REFERENCE_EVENT', 'LINK_SUPPLIER_REFERENCE_EVENT']);
    expect(s[1].dependsOnPrevious).toBe(true);
  });
});

describe('L114X-P04 — non-régression des analyseurs existants', () => {
  it.each([
    ['Supprime l’échéance vidange du 12 mars', 'DELETE_AGENDA_ITEM'],
    ['Supprime l’entretien de la Clio', 'DELETE_AGENDA_ITEM'],
    ['Ajoute un rappel vidange pour la Clio', 'CREATE_AGENDA_ITEM'],
    ['Rattache le document Garantie à la Clio', 'UPDATE_DOCUMENT_TARGETS'],
    ['Supprime le document Facture EDF', 'DELETE_DOCUMENT'],
    ['Ajoute le fournisseur Plomberie Durand, téléphone 06 12 34 56 78', 'CREATE_SUPPLIER'],
    ['Archive le fournisseur Durand', 'ARCHIVE_SUPPLIER'],
    ['Mets la date d’achat le 25/05/2021 pour la Clio', 'UPDATE_ASSET_FIELD'],
    ['Efface la date d’achat de la Clio', 'CLEAR_ASSET_FIELD'],
    ['Supprime la Clio', 'DELETE_ASSET'],
    ['Renomme la Clio en Clio de Paul', 'RENAME_ASSET'],
    ['Ajoute une voiture nommée Mégane', 'CREATE_ASSET'],
  ])('%s → %s', (phrase, commande) => {
    expect(parseCommand(phrase, TODAY)?.command).toBe(commande);
  });

  it.each([
    'Quelles interventions ai-je faites sur la Clio ?', 'Combien a coûté l’intervention Vidange ?', 'Indique-moi les contrats de la maison',
    'Marque l’entretien de la Clio comme fait', 'Ajoute un contrat d’assurance pour la maison', 'Ajoute une intervention du plombier le 12 mars',
  ])('pas une commande sur un événement de référence : %s', (q) => {
    const d = parseCommand(q, TODAY);
    expect(d === null || !d.command.includes('REFERENCE_EVENT')).toBe(true);
  });
});

describe('L114X-P05 — non-régression : une phrase qui ne désigne rien de réel n’est pas une commande', () => {
  const demander = (message: string, l: Lookup = lookup()) => prepareCommand({ ...(input as object), message } as never, l);
  const vide = lookup({ etats: [] });

  it('type nommé sans aucun événement de référence correspondant : parcours de réponse normal, comme avant', async () => {
    // « Fin de contrat » d'un bien (lot 54E) : ces phrases ne sont pas détournées vers un événement de référence.
    for (const m of [
      'Mets la date de fin du contrat au 31/12/2026 pour la maison', 'Supprime le contrat d’assurance de la maison', 'Supprime l’intervention Toiture',
      'Rattache le document Facture Norauto à l’intervention Toiture', 'Relie le fournisseur Garage Martin à l’intervention Toiture',
      'Associe le financement Prêt auto à l’achat de la Clio',
    ]) expect(await demander(m, vide), m).toBeNull();
    // Le même message devient une commande quand un événement du compte y répond.
    expect(await demander('Supprime le contrat Assurance auto')).toMatchObject({ kind: 'plan' });
    expect(await demander('Supprime l’intervention de la Clio')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Plusieurs événements de référence correspondent/) });
  });

  it('« événement de référence » dit en toutes lettres : toujours une commande — question précise si rien n’est trouvé', async () => {
    expect(await demander('Supprime l’événement de référence Toiture', vide)).toEqual({ kind: 'need_info', message: 'Je n’ai pas trouvé cet événement de référence dans votre compte. Lequel voulez-vous supprimer ?' });
  });

  // Règle remplacée (carte #807, E05) : « Déclare un sinistre … : jamais une action ». Un sinistre se déclare
  // désormais comme toute opération (distincte de celle du contrat d'assurance, jamais fusionnée avec elle).
  it('règle remplacée (carte #807) : « Déclare un sinistre … » est une action — la situation est demandée si elle n’est pas dite', async () => {
    expect(await demander('Déclare un sinistre')).toMatchObject({ kind: 'need_info' });
    expect(await demander('Déclare un sinistre « Dégât des eaux » réalisé hier pour la maison')).not.toBeNull();
  });
});

describe('L114X-R01 — W21 : aperçu d’une déclaration', () => {
  it('annonce complète ; la limite d’affichage est dite ; rien n’est promis', async () => {
    const a = await action('Déclare une intervention « Vidange » réalisée le 12 mars 2024 pour la Clio');
    expect(a).toMatchObject({
      command: 'CREATE_REFERENCE_EVENT', targets: [{ type: 'asset', id: 7, label: 'Clio' }],
      params: {
        kind: 'reference_event_create', typeCode: 'INTERVENTION', status: 'REALIZED', eventLabel: 'Vidange', dateField: 'realizedDate', eventDate: '2024-03-12',
        eventAssetIds: [7], distinctFrom: [], declaration: 'Déclare une intervention « Vidange » réalisée le 12 mars 2024 pour la Clio',
      },
      preview: 'Enregistrer l’événement de référence « Intervention — Vidange » du 12 mars 2024 pour Clio.',
    });
    expect(a.effects).toEqual([
      'Type : Intervention', 'Intitulé : Vidange', 'Situation : A eu lieu', 'Date : 12 mars 2024', 'Bien : Clio',
      'Il est enregistré sur votre déclaration : aucun document, aucune échéance et aucun montant ne sont créés.',
      NOT_YET_VISIBLE, 'Vous pourrez le corriger ou le supprimer depuis l’assistant.',
    ]);
    expect(NOT_YET_VISIBLE).toMatch(/n’apparaît sur aucun écran/);
  });

  it('situation non dite : demandée, jamais déduite de la date', async () => {
    expect(besoin(await resoudre('Déclare une intervention « Vidange » le 12 mars 2024 pour la Clio'))).toMatch(/^Cet événement est-il à prévoir ou a-t-il déjà eu lieu \?/);
  });

  it('sans date : aucune date n’est inventée ; contrat : la date est un début ; à prévoir : date prévue', async () => {
    const sans = await action('Déclare une intervention « Ramonage » à prévoir pour la maison');
    expect(sans.params).toMatchObject({ status: 'ENVISAGED', dateField: null, eventDate: null, eventAssetIds: [8] });
    expect(sans.effects).toContain('Date : non précisée (aucune date n’est inventée)');
    expect((await action('Déclare un contrat « Entretien chaudière » réalisé le 1/01/2025 pour la maison')).params).toMatchObject({ dateField: 'startDate', eventDate: '2025-01-01' });
    expect((await action('Déclare une intervention « Ramonage » prévue le 3 mars 2027')).params).toMatchObject({ dateField: 'plannedDate', eventDate: '2027-03-03', eventAssetIds: [] });
  });

  it('« hier » ; date sans année d’un événement qui a eu lieu : dernière occurrence passée ; date future refusée', async () => {
    expect((await action('J’ai fait la vidange de la Clio hier')).params).toMatchObject({ typeCode: 'INTERVENTION', status: 'REALIZED', eventDate: '2026-11-12', eventLabel: 'Vidange', eventAssetIds: [7] });
    expect((await action('Déclare une intervention « Freins » réalisée le 20 décembre pour la Clio')).params).toMatchObject({ eventDate: '2025-12-20' });
    expect(besoin(await resoudre('Déclare une intervention « Freins » réalisée le 20 décembre 2030 pour la Clio'))).toMatch(/ne peut pas avoir une date future/);
  });

  it('complément final qui n’est pas un bien du compte : il reste dans l’intitulé, « Bien : aucun » est annoncé', async () => {
    const a = await action('Déclare une intervention Remplacement de la chaudière, réalisée le 2 juin 2024');
    expect(a.params).toMatchObject({ eventLabel: 'Remplacement de la chaudière', eventAssetIds: [] });
    expect(a.effects).toContain('Bien : aucun');
    // Bien nommé avec un intitulé entre guillemets : jamais un autre bien, jamais une recherche élargie.
    expect(besoin(await resoudre('Déclare une intervention « Vidange » réalisée hier pour la Polo'))).toMatch(/Je n’ai pas trouvé ce bien/);
  });

  it('événement comparable (même type, même bien, même date) : annoncé, décision « autre événement » figée', async () => {
    const a = await action('Déclare une intervention « Plaquettes » réalisée le 12 mars 2025 pour la Clio');
    expect(a.params).toMatchObject({ distinctFrom: [101] });
    expect(a.effects.join(' ')).toMatch(/un événement de référence comparable existe déjà : « Intervention — Vidange » du 12 mars 2025 — Clio\./);
    expect(a.effects).toContain('En confirmant, vous indiquez qu’il s’agit d’un autre événement.');
  });

  // Règle remplacée (carte #807, E05) : le refus « je ne peux pas enregistrer un sinistre » n'existe plus — la
  // déclaration d'un sinistre prépare un plan, qui dit qu'il reste distinct du contrat d'assurance.
  it('règle remplacée (carte #807) : un sinistre se déclare ; refus dits avant tout plan : rien à enregistrer, bien ambigu', async () => {
    const sinistre = await resoudre('Déclare un sinistre « Dégât des eaux » réalisé hier pour la maison');
    expect(sinistre).toMatchObject({ command: 'CREATE_REFERENCE_EVENT', params: { kind: 'reference_event_create', typeCode: 'CLAIM', status: 'REALIZED' } });
    expect((sinistre as { effects: string[] }).effects.join(' ')).toMatch(/opération distincte de celle de votre contrat d’assurance : rien n’est fusionné/);
    expect(besoin(await resoudre('Déclare une intervention à prévoir'))).toBe('Que voulez-vous enregistrer ? Donnez au moins un intitulé, un bien ou une date.');
    const deux = lookup({ biens: [{ id: 1, name: 'Vélo cargo' }, { id: 2, name: 'Vélo de route' }] });
    expect(besoin(await resoudre('Déclare une intervention « Révision » réalisée hier pour le vélo', deux))).toMatch(/^Plusieurs biens correspondent : Vélo cargo, Vélo de route/);
  });
});

describe('L114X-R02 — W22 : corriger', () => {
  it('date : avant → après ; version figée ; correction protégée', async () => {
    const a = await action('Corrige la date de l’intervention Vidange du 12 mars 2025 : 14 mars 2025');
    expect(a).toMatchObject({
      command: 'UPDATE_REFERENCE_EVENT', targets: [{ type: 'reference_event', id: 101, label: 'Intervention — Vidange' }],
      params: { kind: 'reference_event_update', operationId: 101, change: { field: 'realizedDate', value: '2025-03-14' }, expectedVersion: 3 },
      preview: 'Modifier la date de l’événement de référence « Intervention — Vidange » du 12 mars 2025 — Clio : 12 mars 2025 → 14 mars 2025.',
    });
    expect(a.effects).toEqual([
      'Événement de référence : Intervention — Vidange', 'Date : 12 mars 2025 → 14 mars 2025',
      'Cette correction est enregistrée comme votre décision : elle ne sera pas remplacée par une analyse.',
      'Pour revenir en arrière, refaites une demande de correction.',
    ]);
  });

  it('« la date » suit la situation et le type : date prévue (à prévoir), début (contrat)', async () => {
    expect((await action('Change la date de l’intervention Pneus hiver au 15 décembre 2026')).params).toMatchObject({ change: { field: 'plannedDate', value: '2026-12-15' } });
    expect((await action('Change la date du contrat Assurance auto au 1/02/2024')).params).toMatchObject({ change: { field: 'startDate', value: '2024-02-01' } });
    expect((await action('Mets la date de fin du contrat Assurance auto au 31/12/2026')).params).toMatchObject({ change: { field: 'endDate', value: '2026-12-31' } });
  });

  it('prestataire, intitulé, type, situation', async () => {
    expect((await action('Change le prestataire de l’intervention Vidange du 12 mars 2025 en Garage Martin')).params).toMatchObject({ change: { field: 'provider', value: 'Garage Martin' } });
    expect((await action('Renomme l’intervention Pneus hiver en Pneus neige')).params).toMatchObject({ change: { field: 'label', value: 'Pneus neige' } });
    const t = await action('Change le type de l’intervention Pneus hiver en achat');
    expect(t.params).toMatchObject({ change: { field: 'type', value: 'ACQUISITION' } });
    expect(t.effects).toContain('Type : Intervention → Achat');
    const s = await action('Indique que l’intervention Pneus hiver a eu lieu');
    expect(s.params).toMatchObject({ change: { field: 'status', value: 'REALIZED' } });
    expect(s.effects).toContain('Situation : À prévoir → A eu lieu');
  });

  it('refus dits avant tout plan', async () => {
    expect(besoin(await resoudre('Corrige le prestataire de l’intervention Pneus hiver'))).toBe('Quelle valeur voulez-vous enregistrer pour le prestataire de « Intervention — Pneus hiver » ?');
    expect(besoin(await resoudre('Change la date de l’intervention Vidange du 12 mars 2025 au 12 mars 2025'))).toMatch(/c’est déjà le 12 mars 2025/);
    expect(besoin(await resoudre('Change la date de l’intervention Vidange du 12 mars 2025 au 12 mars 2031'))).toBe('Un événement qui a eu lieu ne peut pas avoir une date future.');
    expect(besoin(await resoudre('Mets la date de fin du contrat Assurance auto au 31/12/2023'))).toBe('La date de fin ne peut pas précéder la date de début.');
    expect(besoin(await resoudre('Change le type de l’intervention Pneus hiver en bidule'))).toMatch(/^Quel type voulez-vous donner à « Intervention — Pneus hiver » \? Par exemple : achat, intervention, contrat, financement, sinistre, cession\.$/);
    expect(besoin(await resoudre('Indique que l’intervention Vidange du 12 mars 2025 a eu lieu'))).toMatch(/déjà indiqué comme ayant eu lieu/);
  });
});

describe('L114X-R03 — W23 : supprimer = invalider ; jamais un choix au hasard', () => {
  it('ce qui est conservé est annoncé ; aucune annulation promise', async () => {
    const a = await action('Supprime le contrat Assurance auto');
    expect(a).toMatchObject({
      command: 'INVALIDATE_REFERENCE_EVENT', params: { kind: 'reference_event_invalidate', operationId: 203, expectedVersion: 3 },
      preview: 'Supprimer l’événement de référence « Contrat — Assurance auto » du 1 janvier 2024 — Clio.',
    });
    expect(a.effects).toEqual([
      'Seul cet événement de référence est retiré : il n’est plus pris en compte (dépenses, réponses de l’assistant).',
      'Conservés dans votre compte : 1 document, 2 échéances, ainsi que ses fournisseurs.',
      'Ses échéances restent dans l’Agenda, à leur date, avec leurs rappels ; elles ne lui sont plus rattachées.',
      'Ses documents ne sont pas supprimés : une prochaine analyse de ces documents peut faire apparaître un nouvel événement de référence.',
      'Depuis l’assistant, cette suppression ne s’annule pas.',
    ]);
  });

  it('plusieurs correspondances : question ; intitulé exact : retenu ; inconnu : rien', async () => {
    expect(besoin(await resoudre('Supprime l’intervention de la Clio'))).toMatch(/^Plusieurs événements de référence correspondent : « Intervention — Vidange » du 12 mars 2025 — Clio ; « Intervention — Vidange et filtres » du 10 mars 2024 — Clio ; /);
    expect((await action('Supprime l’intervention Vidange')).params).toMatchObject({ operationId: 101 });
    expect(besoin(await resoudre('Supprime l’intervention Toiture'))).toBe('Je n’ai pas trouvé cet événement de référence dans votre compte. Lequel voulez-vous supprimer ?');
    expect(besoin(await resoudre('Supprime l’événement de référence'))).toMatch(/^Quel événement de référence voulez-vous supprimer \?/);
    // Le type nommé borne la recherche : « le contrat Vidange » ne désigne pas une intervention.
    expect(besoin(await resoudre('Supprime le contrat Vidange'))).toMatch(/Je n’ai pas trouvé/);
  });
});

describe('L114X-R04 — W24 à W26', () => {
  it('W24 : financement d’un achat — orienté quel que soit l’ordre ; jamais une fusion', async () => {
    const a = await action('Associe l’achat de la Clio au financement Prêt auto');
    expect(a.params).toEqual({ kind: 'reference_events_associate', fromOperationId: 201, toOperationId: 202, nature: 'FINANCING', expectedVersions: [3, 3] });
    expect(a.effects).toEqual([
      '« Financement — Prêt auto » sera indiqué comme le financement de « Achat — Clio ».',
      'Ils restent deux événements de référence distincts : rien n’est fusionné.',
      'Aucun document n’est déplacé ; aucun montant, aucune date et aucune échéance ne sont modifiés.',
    ]);
    const simple = await action('Associe l’intervention Pneus hiver au contrat Assurance auto');
    expect(simple.params).toMatchObject({ nature: 'ASSOCIATED', fromOperationId: 104, toOperationId: 203 });
    expect(simple.effects[0]).toBe('Les deux événements de référence seront simplement associés.');
    expect(besoin(await resoudre('Associe l’intervention Pneus hiver à l’intervention Pneus hiver'))).toMatch(/même événement de référence/);
  });

  it('nature d’une association : règle structurelle du graphe', () => {
    const r = modele.relationBetween;
    expect(r({ id: 1, typeCode: 'CLAIM' }, { id: 2, typeCode: 'INTERVENTION' })).toEqual({ nature: 'CLAIM_REPAIR', fromOperationId: 1, toOperationId: 2 });
    expect(r({ id: 2, typeCode: 'INTERVENTION' }, { id: 1, typeCode: 'CLAIM' })).toEqual({ nature: 'CLAIM_REPAIR', fromOperationId: 1, toOperationId: 2 });
    expect(r({ id: 1, typeCode: 'FINANCING' }, { id: 2, typeCode: 'INTERVENTION' }).nature).toBe('ASSOCIATED');
    expect(r({ id: 1, typeCode: null }, { id: 2, typeCode: null }).nature).toBe('ASSOCIATED');
  });

  it('W25 : document et événement figés tels que présentés', async () => {
    const a = await action('Rattache le document Facture Norauto à l’intervention Vidange');
    expect(a).toMatchObject({
      command: 'LINK_DOCUMENT_REFERENCE_EVENT', targets: [{ type: 'document', id: 55 }, { type: 'reference_event', id: 101 }],
      params: { kind: 'reference_event_document', operationId: 101, linkedDocumentId: 55, expectedVersion: 3, documentVersion: DOC_ETAT.version },
      preview: 'Rattacher le document « Facture Norauto » à l’événement de référence « Intervention — Vidange » du 12 mars 2025 — Clio.',
    });
    expect(a.effects.join(' ')).toMatch(/Il n’ajoute par lui-même aucun montant/);
    expect(besoin(await resoudre('Rattache le document Devis à l’intervention Vidange'))).toMatch(/Je n’ai pas trouvé ce document/);
  });

  it('W26 : rôle annoncé ; fournisseur inconnu : rien', async () => {
    const a = await action('Relie le fournisseur Garage Martin à l’intervention Vidange comme intervenant');
    expect(a).toMatchObject({
      command: 'LINK_SUPPLIER_REFERENCE_EVENT',
      params: { kind: 'reference_event_supplier', operationId: 101, linkedSupplierId: 31, role: 'INTERVENER', expectedVersion: 3, supplierVersion: FOURNISSEUR_ETAT.version },
      preview: 'Relier le fournisseur « Garage Martin » à l’événement de référence « Intervention — Vidange » du 12 mars 2025 — Clio.',
    });
    expect(a.effects).toContain('Rôle : Intervenant');
    expect((await action('Relie le fournisseur Garage Martin à l’intervention Vidange')).effects).toContain('Rôle : Prestataire');
    expect(besoin(await resoudre('Relie le fournisseur Dupont à l’intervention Vidange'))).toMatch(/Je n’ai pas trouvé ce fournisseur/);
  });
});

// ── Exécution ──────────────────────────────────────────────────────────────

const op = (s: Etat) => ({
  id: s.id, typeCode: s.typeCode, status: s.status, technicalLabel: s.technicalLabel, provider: s.provider, plannedDate: s.plannedDate, startDate: s.startDate,
  realizedDate: s.realizedDate, endDate: s.endDate, version: s.version, assetIds: [], documents: [],
});
const applique = (data: Record<string, unknown> = {}): Result => ({ status: 'APPLIED', code: 'OK', changed: true, replayed: false, data });
const ctx = { accountId: 1, userId: 2, planId: '3f0c9c0e-1111-4222-8333-444455556666' };

describe('L114X-X01 — exécution : état relu, puis la façade — et elle seule', () => {
  beforeEach(() => {
    base.ops = TOUS.map(op);
    base.appels = [];
    base.avancer = false;
    base.reponse = applique({ operationId: 900 });
    vi.spyOn(lectures, 'getDocumentState').mockImplementation(async (_a, id) => (id === DOC.id ? DOC_ETAT : null));
    vi.spyOn(lectures, 'getSupplierState').mockImplementation(async (_a, id) => (id === 31 ? FOURNISSEUR_ETAT : null));
  });

  it('W21 : createOperation — acteur utilisateur, canal Assistant, clé d’idempotence du plan et de l’action', async () => {
    const a = await action('Déclare une intervention « Courroie » réalisée le 2 juin 2024 pour la Clio');
    const r = await runAction(a, ctx);
    expect(r).toEqual({
      actionId: 'a1', status: 'SUCCESS', entity: { type: 'reference_event', id: 900 },
      message: `Événement de référence « Intervention — Courroie » enregistré. ${NOT_YET_VISIBLE}`,
    });
    expect(base.appels).toEqual([{
      commande: 'createOperation',
      ctx: { accountId: 1, actor: { kind: 'USER', userId: 2, channel: 'ASSISTANT' }, idempotencyKey: `t2.${ctx.planId}.a1`, correlationId: `t2-plan-${ctx.planId}` },
      entree: {
        declaration: 'Déclare une intervention « Courroie » réalisée le 2 juin 2024 pour la Clio', type: { code: 'INTERVENTION' }, status: 'REALIZED',
        attributes: { realizedDate: '2024-06-02' }, label: 'Courroie', assetIds: [7],
      },
    }]);
  });

  it('W21 : même déclaration déjà enregistrée → dit, rien en double ; comparable apparu depuis l’aperçu → rien n’est créé', async () => {
    const a = await action('Déclare une intervention « Courroie » réalisée le 2 juin 2024');
    base.reponse = { status: 'APPLIED', code: 'NO_CHANGE', changed: false, replayed: false, data: { operationId: 77, alreadyExisted: true } };
    expect(await runAction(a, ctx)).toMatchObject({ status: 'SUCCESS', message: 'Cet événement de référence était déjà enregistré (même déclaration) : rien n’a été créé en double.' });
    base.appels = [];
    base.ops = [...base.ops, { ...op(etat(300, { technicalLabel: 'Autre', realizedDate: '2024-06-02', assets: [] })) }];
    expect(await runAction(a, ctx)).toEqual({ actionId: 'a1', status: 'FAILED', message: 'Un événement de référence comparable est apparu depuis l’aperçu : rien n’a été créé. Refaites votre demande.' });
    expect(base.appels).toEqual([]);
  });

  it('W22 : updateOperation avec la version présentée ; version changée depuis l’aperçu → la façade n’est pas appelée', async () => {
    const a = await action('Change le prestataire de l’intervention Vidange du 12 mars 2025 en Garage Martin');
    expect(await runAction(a, ctx)).toMatchObject({ status: 'SUCCESS', message: 'Événement de référence « Intervention — Vidange » corrigé.', entity: { type: 'reference_event', id: 101 } });
    expect(base.appels[0]).toMatchObject({
      commande: 'updateOperation',
      entree: { operationId: 101, expectedVersion: 3, attributes: { provider: 'Garage Martin' }, declaration: 'Change le prestataire de l’intervention Vidange du 12 mars 2025 en Garage Martin' },
    });
    for (const [phrase, attendu] of [
      ['Renomme l’intervention Pneus hiver en Pneus neige', { label: 'Pneus neige' }],
      ['Change le type de l’intervention Pneus hiver en achat', { type: { code: 'ACQUISITION' } }],
      ['Indique que l’intervention Pneus hiver a eu lieu', { status: 'REALIZED' }],
      ['Change la date de l’intervention Pneus hiver au 15 décembre 2026', { attributes: { plannedDate: '2026-12-15' } }],
    ] as const) {
      base.appels = [];
      await runAction(await action(phrase), ctx);
      expect(base.appels[0].entree).toMatchObject({ operationId: 104, ...attendu });
    }
    base.appels = [];
    base.ops = base.ops.map((o) => (o.id === 101 ? { ...o, version: 4 } : o));
    expect(await runAction(a, ctx)).toEqual({ actionId: 'a1', status: 'FAILED', message: modele.REFERENCE_EVENT_CHANGED_SINCE_PREVIEW });
    base.ops = base.ops.filter((o) => o.id !== 101);
    expect(await runAction(a, ctx)).toEqual({ actionId: 'a1', status: 'REFUSED', message: modele.REFERENCE_EVENT_NOT_FOUND });
    expect(base.appels).toEqual([]);
  });

  it('W23 : invalidateOperation — jamais autre chose', async () => {
    const a = await action('Supprime l’intervention Vidange');
    expect(await runAction(a, ctx)).toMatchObject({ status: 'SUCCESS', message: 'Événement de référence « Intervention — Vidange » supprimé. Ses documents, ses échéances et ses fournisseurs sont conservés.' });
    expect(base.appels).toEqual([expect.objectContaining({ commande: 'invalidateOperation', entree: { operationId: 101, expectedVersion: 3 } })]);
  });

  it('W24 : associateOperations (origine → cible, nature) ; déjà associés : dit', async () => {
    const a = await action('Associe l’achat de la Clio au financement Prêt auto');
    // Règle remplacée (carte #813) : un achat dont l'intitulé dit déjà « Achat … » n'est plus rendu « Achat — Achat … ».
    expect(await runAction(a, ctx)).toMatchObject({ status: 'SUCCESS', message: 'Événements de référence « Financement — Prêt auto » et « Achat Clio » associés. Ils restent distincts.' });
    expect(base.appels[0]).toMatchObject({ commande: 'associateOperations', entree: { fromOperationId: 201, toOperationId: 202, nature: 'FINANCING' } });
    base.reponse = { status: 'APPLIED', code: 'NO_CHANGE', changed: false, replayed: false };
    expect((await runAction(a, ctx)).message).toMatch(/étaient déjà associés : rien n’a été modifié\.$/);
  });

  it('W25 : linkDocument ; document modifié ou disparu depuis l’aperçu → la façade n’est pas appelée', async () => {
    const a = await action('Rattache le document Facture Norauto à l’intervention Vidange');
    expect(await runAction(a, ctx)).toMatchObject({ status: 'SUCCESS', message: 'Document « Facture Norauto » rattaché à l’événement de référence « Intervention — Vidange ».' });
    expect(base.appels[0]).toMatchObject({ commande: 'linkDocument', entree: { operationId: 101, fileId: 55 } });
    base.appels = [];
    vi.spyOn(lectures, 'getDocumentState').mockImplementation(async () => ({ ...DOC_ETAT, version: 'autre' }));
    expect(await runAction(a, ctx)).toMatchObject({ status: 'FAILED', message: 'Ce document a été modifié depuis l’aperçu : rien n’a été fait. Refaites votre demande.' });
    vi.spyOn(lectures, 'getDocumentState').mockImplementation(async () => null);
    expect(await runAction(a, ctx)).toMatchObject({ status: 'REFUSED' });
    expect(base.appels).toEqual([]);
  });

  it('W26 : linkSupplier avec le rôle annoncé', async () => {
    const a = await action('Relie le fournisseur Garage Martin à l’intervention Vidange comme intervenant');
    expect(await runAction(a, ctx)).toMatchObject({ status: 'SUCCESS', message: 'Fournisseur « Garage Martin » relié à l’événement de référence « Intervention — Vidange ».' });
    expect(base.appels[0]).toMatchObject({ commande: 'linkSupplier', entree: { operationId: 101, supplierId: 31, role: 'INTERVENER' } });
    base.reponse = { status: 'APPLIED', code: 'NO_CHANGE', changed: false, replayed: false };
    expect((await runAction(a, ctx)).message).toMatch(/était déjà relié/);
  });

  it('deux actions du même plan sur le même événement : la seconde n’est pas refusée à cause de la première ; une modification extérieure l’est', async () => {
    base.avancer = true;
    const plan = async () => [
      { ...(await action('Change le prestataire de l’intervention Vidange du 12 mars 2025 en Garage Martin')), actionId: 'a1' },
      { ...(await action('Renomme l’intervention Vidange en Vidange complète')), actionId: 'a2' },
      { ...(await action('Relie le fournisseur Garage Martin à l’intervention Vidange')), actionId: 'a3' },
    ];
    const r = await executeActions(await plan(), { ...ctx, referenceEventVersions: new Map() });
    expect(r.map((x) => x.status)).toEqual(['SUCCESS', 'SUCCESS', 'SUCCESS']);
    // La façade a reçu, à chaque fois, la version de l'état relu (jamais une version périmée) et une clé propre à l'action.
    expect(base.appels.map((x) => [x.commande, x.entree.expectedVersion, x.ctx.idempotencyKey])).toEqual([
      ['updateOperation', 3, `t2.${ctx.planId}.a1`], ['updateOperation', 4, `t2.${ctx.planId}.a2`], ['linkSupplier', undefined, `t2.${ctx.planId}.a3`],
    ]);
    // Sans écriture de ce plan : l'événement modifié ailleurs depuis l'aperçu (version 5 ≠ 3) est refusé, rien n'est appelé.
    base.appels = [];
    const autre = await executeActions((await plan()).slice(2), { ...ctx, referenceEventVersions: new Map() });
    expect(autre).toEqual([{ actionId: 'a3', status: 'FAILED', message: modele.REFERENCE_EVENT_CHANGED_SINCE_PREVIEW }]);
    expect(base.appels).toEqual([]);
  });

  it('aucune action n’est annulable : chaque réussite est déclarée irréversible', async () => {
    const captures: Array<{ reversible: boolean }> = [];
    await REFERENCE_EVENT_EXECUTORS.INVALIDATE_REFERENCE_EVENT(await action('Supprime l’intervention Vidange'), { ...ctx, recordUndo: (c) => { captures.push(c); } });
    expect(captures).toEqual([expect.objectContaining({ reversible: false })]);
  });
});

describe('L114X-X02 — chaque résultat de la façade est traduit', () => {
  beforeEach(() => { base.ops = TOUS.map(op); base.appels = []; base.avancer = false; });

  it.each([
    ['FORBIDDEN', 'OPERATION_INACTIVE', 'REFUSED', /n’est plus actif/],
    ['FORBIDDEN', 'NOT_FOUND_IN_ACCOUNT', 'REFUSED', /introuvable dans votre compte/],
    ['FORBIDDEN', 'READ_ONLY_ACCOUNT', 'REFUSED', /lecture seule/],
    ['FORBIDDEN', 'TYPE_DETAILS_PRESENT', 'REFUSED', /ne peut pas être changé/],
    ['FORBIDDEN', 'STATUS_TRANSITION_REFUSED', 'REFUSED', /situation/],
    ['CONFLICT', 'VERSION_MISMATCH', 'FAILED', /modifié depuis l’aperçu/],
    ['CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'FAILED', /déjà été traitée/],
    ['ARBITRATION_REQUIRED', 'NEW_EVIDENCE_AFTER_REFUSAL', 'REFUSED', /« À traiter »/],
    ['FAILED', 'TECHNICAL_FAILURE', 'FAILED', /erreur technique/],
  ] as const)('%s / %s → %s', async (status, code, attendu, texte) => {
    base.reponse = { status, code, changed: false, replayed: false };
    const r = await runAction(await action('Supprime l’intervention Vidange'), ctx);
    expect(r.status).toBe(attendu);
    expect(r.message).toMatch(texte);
    expect(r.message).not.toContain(code);
    expect(r.message).toMatch(/rien n’a été (écrit|fait|refait|modifié)|Rien n’a été écrit/);
  });

  it('tous les codes ont un texte ; aucun texte ne montre un code ni le mot interdit', () => {
    for (const [code, texte] of Object.entries(modele.WRITE_CODE_TEXT)) {
      expect(texte.length, code).toBeGreaterThan(20);
      expect(texte, code).not.toMatch(INTERDIT);
      expect(texte, code).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
    }
    expect(modele.translateWriteResult({ actionId: 'a1' }, { status: 'APPLIED', code: 'OK', changed: false, replayed: true }, { done: 'fait', alreadyDone: 'déjà' })).toMatchObject({ status: 'SUCCESS', message: 'fait' });
  });

  it('aucun aperçu, aucun effet, aucune question ne dit le mot interdit', async () => {
    const phrases = [
      'Déclare une intervention « Plaquettes » réalisée le 12 mars 2025 pour la Clio', 'Corrige la date de l’intervention Vidange du 12 mars 2025 : 14 mars 2025',
      'Supprime le contrat Assurance auto', 'Associe l’achat de la Clio au financement Prêt auto', 'Rattache le document Facture Norauto à l’intervention Vidange',
      'Relie le fournisseur Garage Martin à l’intervention Vidange', 'Supprime l’intervention de la Clio', 'Supprime l’intervention Toiture', 'Déclare une intervention « X » pour la Clio',
    ];
    for (const p of phrases) expect(JSON.stringify(await resoudre(p)).replace(/"(kind|command|operationId|fromOperationId|toOperationId)"/g, ''), p).not.toMatch(INTERDIT);
  });
});

describe('L114X-C01 — catalogue fermé et vocabulaire', () => {
  it('six commandes d’écriture confirmées, fiche complète, service = la façade métier du graphe', () => {
    const attendu = {
      CREATE_REFERENCE_EVENT: 'createOperation', UPDATE_REFERENCE_EVENT: 'updateOperation', INVALIDATE_REFERENCE_EVENT: 'invalidateOperation',
      ASSOCIATE_REFERENCE_EVENTS: 'associateOperations', LINK_DOCUMENT_REFERENCE_EVENT: 'linkDocument', LINK_SUPPLIER_REFERENCE_EVENT: 'linkSupplier',
    } as const;
    for (const [commande, fonction] of Object.entries(attendu)) {
      const def = WRITE_COMMAND_CATALOG[commande as keyof typeof attendu];
      expect(def).toMatchObject({ type: commande, requiresWriteAccess: true, service: `operation-write.facade.${fonction}` });
      expect(def.label).not.toMatch(INTERDIT);
      expect(def.spec).toMatchObject({ targetKind: 'reference_event', readBeforeWrite: true, undoPolicy: 'IRREVERSIBLE', retrySafety: 'PLAN_TAKEN_ONCE_AND_IDEMPOTENCY_KEY' });
      expect(def.spec!.requiredFields.length).toBeGreaterThan(0);
      expect(def.spec!.sideEffects.length).toBeGreaterThan(0);
    }
    expect(WRITE_COMMAND_CATALOG.INVALIDATE_REFERENCE_EVENT.spec!.deletePolicy).toBe('LOGICAL_INVALIDATION');
  });

  it('vocabulaire des types : dérivé du référentiel ; tout nom employé par l’Assistant est compris ; OTHER jamais proposé', async () => {
    const { operationNoun } = await import('../../../canonical/operations');
    for (const code of BUSINESS_OPERATION_TYPE_CODES.filter((c) => c !== 'OTHER')) {
      expect(modele.TYPE_NOUNS.get(operationNoun(code)), code).toBe(code);
      expect(modele.TYPE_NOUNS.get(modele.typeLabel(code).toLowerCase()), code).toBe(code);
    }
    expect([...modele.TYPE_NOUNS.values()]).not.toContain('OTHER');
    expect(modele.situationLabel('REALIZED')).toBe('A eu lieu');
    expect(modele.situationLabel('ENVISAGED')).toBe('À prévoir');
  });

  it('désignation : tous les mots, le type et la date complète', () => {
    const m = (q: Partial<import('../../reference-event-model').ReferenceEventQuery>) => modele.matchReferenceEvents(TOUS, { typeCode: null, words: [], date: null, ...q }).map((s) => s.id);
    expect(m({ words: ['vidange'] })).toEqual([101, 102]);
    expect(m({ words: ['vidange'], date: '2024-03-10' })).toEqual([102]);
    expect(m({ words: ['clio'], typeCode: 'ACQUISITION' })).toEqual([202]);
    expect(m({ words: ['attestation'] })).toEqual([203]);
    expect(m({ words: ['vidange', 'maison'] })).toEqual([]);
  });
});
