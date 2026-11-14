/**
 * Lot 114 (Trello #753, CDC T2 §14.3 W10 / W12 / W14, §14.4 « Documents ») —
 * AJOUTER UN LIEN WEB, MODIFIER ET SUPPRIMER UN DOCUMENT DEPUIS L'ASSISTANT.
 *
 *   D01  W10 : adresse http(s) et titre obligatoires, bien facultatif ; le lien n'est jamais lu ;
 *   D02  W12 : titre, date, note — un champ à la fois, ancien → nouveau ; effacement ; valeurs refusées ;
 *   D03  W14 : suppression annoncée telle qu'elle est (le document quitte le compte) ;
 *   D04  désignation : « ce document » du fil, titre exact, jamais un document choisi à la place de l'utilisateur ;
 *   D05  ce qui n'est PAS une commande de document ; priorité sur l'Agenda ;
 *   D06  les routes et l'Assistant partagent la même façade métier ; fiches de commande.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { parseCommand, documentDateFr } = await import('../../parser');
const { resolveDraft, documentVersion } = await import('../../plan.service');
const { WRITE_COMMAND_CATALOG, DOCUMENT_COMMAND_FIELDS } = await import('../../catalog');
type Lookup = import('../../plan.service').CommandLookup;
type State = import('../../plan.service').DocumentState;

const TODAY = '2026-11-13';
const base = { accountId: 1, userId: 2, planType: 'STANDARD', message: '', clientRequestId: 'x', locale: 'fr-FR' };
const input = base as never;
const doc = (id: number, title: string, o: Partial<State> = {}): State => {
  const b = { id, title, documentDate: '2026-03-10', notesShown: '', ...o };
  return { originalFilename: `${title}.pdf`, notesUserOwned: !!b.notesShown, isWebLink: false, webLinkUrl: null, assetLabel: 'Maison', ...b, version: documentVersion(b) };
};
const EDF = doc(31, 'Facture EDF');
const EDF_MARS = doc(32, 'Facture EDF mars', { documentDate: '2026-03-28' });
const NOTICE = doc(33, 'Notice chaudière', { notesShown: 'À relire avant l’entretien', documentDate: null });
const maison = { id: 5, name: 'Maison', city: 'Lyon' };
const sansAccent = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const lookup = (docs: State[] = [EDF, EDF_MARS, NOTICE]): Lookup => ({
  today: () => TODAY,
  async findAssets(_a, w) { return w.some((x) => 'maison'.includes(x)) ? [maison] : []; },
  async getAsset(_a, id) { return id === 5 ? maison : null; },
  async findDocuments(_a, w) { return docs.filter((d) => w.every((x) => sansAccent(d.title).includes(x))).map((d) => ({ id: d.id, title: d.title, documentDate: d.documentDate })); },
  async getDocumentState(_a, id) { return docs.find((d) => d.id === id) ?? null; },
});
const besoin = (a: unknown) => (a as { needInfo: string }).needInfo;

describe('L114D-D01 — W10 : ajouter un lien web', () => {
  it('adresse, titre entre guillemets et bien : repris tels qu’écrits ; aucune lecture de la page annoncée', async () => {
    const d = parseCommand('Ajoute le lien https://www.fabricant.fr/notice-chaudiere.pdf intitulé « Notice de la chaudière » pour la maison', TODAY)!;
    expect(d).toEqual({ command: 'CREATE_WEB_DOCUMENT', url: 'https://www.fabricant.fr/notice-chaudiere.pdf', title: 'Notice de la chaudière', assetWords: ['maison'], assetFromContext: false });
    const a = await resolveDraft(d, input, lookup());
    expect(a).toMatchObject({
      command: 'CREATE_WEB_DOCUMENT', targets: [{ type: 'asset', id: 5, label: 'Maison (Lyon)' }],
      params: { kind: 'document_web_create', url: 'https://www.fabricant.fr/notice-chaudiere.pdf', linkTitle: 'Notice de la chaudière', linkAssetId: 5 },
      preview: 'Ajouter le lien « Notice de la chaudière », rattaché à Maison (Lyon).',
    });
    expect((a as { effects: string[] }).effects).toContain('Le lien est enregistré tel quel : la page n’est pas lue.');
  });

  it('sans bien : lien du compte ; « enregistre https://… sous le nom … » ; demande polie', async () => {
    const d = parseCommand('Peux-tu enregistrer https://impots.gouv.fr sous le nom Espace impôts ?', TODAY)!;
    expect(d).toMatchObject({ command: 'CREATE_WEB_DOCUMENT', url: 'https://impots.gouv.fr', title: 'Espace impôts', assetWords: [] });
    expect(await resolveDraft(d, input, lookup())).toMatchObject({ targets: [], params: { linkAssetId: null }, preview: 'Ajouter le lien « Espace impôts ».' });
  });

  it('adresse ou titre absents : seule l’information manquante est demandée', async () => {
    expect(besoin(await resolveDraft(parseCommand('Ajoute un lien intitulé « Notice »', TODAY)!, input, lookup())))
      .toBe('Quelle est l’adresse du lien à enregistrer (elle commence par http:// ou https://) ?');
    expect(besoin(await resolveDraft(parseCommand('Ajoute le lien https://exemple.fr/notice', TODAY)!, input, lookup())))
      .toBe('Quel titre voulez-vous donner à ce lien ?');
    expect(besoin(await resolveDraft({ command: 'CREATE_WEB_DOCUMENT', url: 'ftp://exemple.fr', title: 'X', assetWords: [], assetFromContext: false }, input, lookup())))
      .toBe('Cette adresse ne semble pas valide : elle doit commencer par http:// ou https://.');
  });

  it('bien introuvable ou « ce bien » sans bien dans le fil : demandé, jamais deviné', async () => {
    expect(besoin(await resolveDraft({ command: 'CREATE_WEB_DOCUMENT', url: 'https://x.fr', title: 'X', assetWords: ['bateau'], assetFromContext: false }, input, lookup())))
      .toMatch(/^Je n’ai pas trouvé ce bien dans votre compte\./);
    expect(besoin(await resolveDraft({ command: 'CREATE_WEB_DOCUMENT', url: 'https://x.fr', title: 'X', assetWords: [], assetFromContext: true }, input, lookup())))
      .toBe('À quel bien voulez-vous rattacher ce lien ?');
  });
});

describe('L114D-D02 — W12 : modifier un document', () => {
  it('renommer : nouveau titre tel qu’écrit, protégé des analyses', async () => {
    const d = parseCommand('Renomme le document Notice chaudière en Notice chaudière Saunier Duval', TODAY)!;
    expect(d).toEqual({ command: 'UPDATE_DOCUMENT', field: 'title', value: 'Notice chaudière Saunier Duval', clear: false, documentWords: ['notice', 'chaudiere'], documentFromContext: false });
    expect(parseCommand('Change le titre du document Notice chaudière en « Notice Saunier Duval »', TODAY)).toMatchObject({ field: 'title', value: 'Notice Saunier Duval' });
    const a = await resolveDraft(d, input, lookup());
    expect(a).toMatchObject({
      command: 'UPDATE_DOCUMENT', targets: [{ type: 'document', id: 33, label: 'Notice chaudière' }],
      params: { kind: 'document_update', documentId: 33, documentField: 'title', newValue: 'Notice chaudière Saunier Duval', expectedVersion: NOTICE.version },
      preview: 'Renommer le document « Notice chaudière » en « Notice chaudière Saunier Duval ».',
      effects: ['Titre : Notice chaudière → Notice chaudière Saunier Duval', 'Ce titre ne sera pas remplacé par une analyse.'],
    });
  });

  it('date : ancienne → nouvelle ; sans année écrite, la dernière occurrence passée ; jamais dans le futur', async () => {
    expect(documentDateFr('12 mars', TODAY)).toBe('2026-03-12');
    expect(documentDateFr('12 décembre', TODAY)).toBe('2025-12-12');
    expect(documentDateFr('12 décembre 2026', TODAY)).toBe('2026-12-12');
    const d = parseCommand('Change la date du document Notice chaudière au 12 mars 2025', TODAY)!;
    expect(d).toMatchObject({ command: 'UPDATE_DOCUMENT', field: 'date', value: '2025-03-12', documentWords: ['notice', 'chaudiere'] });
    expect(await resolveDraft(d, input, lookup())).toMatchObject({
      params: { documentField: 'date', newValue: '2025-03-12' }, preview: 'Changer la date du document « Notice chaudière » : (aucune) → 12 mars 2025.',
    });
    expect(besoin(await resolveDraft({ command: 'UPDATE_DOCUMENT', field: 'date', value: '2026-12-12', clear: false, documentWords: ['notice'], documentFromContext: false }, input, lookup())))
      .toBe('La date d’un document ne peut pas être dans le futur. Pouvez-vous la vérifier ?');
    expect(besoin(await resolveDraft({ command: 'UPDATE_DOCUMENT', field: 'date', value: null, clear: false, documentWords: ['notice'], documentFromContext: false }, input, lookup())))
      .toBe('Quelle date voulez-vous enregistrer pour « Notice chaudière » ?');
  });

  it('note : ajoutée (avant ou après la cible), remplacée avec le texte actuel montré, effacée', async () => {
    const avant = parseCommand('Ajoute la note « Payée le 2 avril » au document Facture EDF mars', TODAY)!;
    expect(avant).toEqual({ command: 'UPDATE_DOCUMENT', field: 'notes', value: 'Payée le 2 avril', clear: false, documentWords: ['facture', 'edf', 'mars'], documentFromContext: false });
    const apres = parseCommand('Modifie la note du document Facture EDF mars : Payée le 2 avril', TODAY)!;
    expect(apres).toMatchObject({ field: 'notes', value: 'Payée le 2 avril', documentWords: ['facture', 'edf', 'mars'] });
    expect(await resolveDraft(avant, input, lookup())).toMatchObject({
      params: { documentField: 'notes', newValue: 'Payée le 2 avril' }, preview: 'Ajouter une note au document « Facture EDF mars ».',
    });
    const remplace = await resolveDraft({ command: 'UPDATE_DOCUMENT', field: 'notes', value: 'Relue', clear: false, documentWords: ['notice'], documentFromContext: false }, input, lookup()) as { preview: string; effects: string[] };
    expect(remplace.preview).toBe('Remplacer la note du document « Notice chaudière ».');
    expect(remplace.effects).toContain('Texte actuel : « À relire avant l’entretien »');
    const efface = parseCommand('Efface la note du document Notice chaudière', TODAY)!;
    expect(efface).toMatchObject({ field: 'notes', value: null, clear: true });
    expect(await resolveDraft(efface, input, lookup())).toMatchObject({ params: { documentField: 'notes', newValue: null }, preview: 'Effacer la note du document « Notice chaudière ».' });
    expect(besoin(await resolveDraft({ command: 'UPDATE_DOCUMENT', field: 'notes', value: null, clear: true, documentWords: ['facture', 'edf', 'mars'], documentFromContext: false }, input, lookup())))
      .toBe('« Facture EDF mars » n’a aucune note.');
  });

  it('valeur identique : aucune écriture préparée ; un titre ne s’efface pas', async () => {
    expect(besoin(await resolveDraft({ command: 'UPDATE_DOCUMENT', field: 'title', value: 'Notice chaudière', clear: false, documentWords: ['notice'], documentFromContext: false }, input, lookup())))
      .toBe('Ce document s’appelle déjà « Notice chaudière ».');
    expect(parseCommand('Efface le titre du document Notice chaudière', TODAY)).toBeNull();
    expect(DOCUMENT_COMMAND_FIELDS).toEqual(['title', 'date', 'notes']);
  });
});

describe('L114D-D03 — W14 : supprimer un document', () => {
  it('aperçu fidèle : document, date, bien ; conséquences dites ; aucune annulation promise', async () => {
    const d = parseCommand('Supprime le document Notice chaudière', TODAY)!;
    expect(d).toEqual({ command: 'DELETE_DOCUMENT', documentWords: ['notice', 'chaudiere'], documentFromContext: false });
    const a = await resolveDraft(d, input, lookup());
    expect(a).toMatchObject({
      command: 'DELETE_DOCUMENT', targets: [{ type: 'document', id: 33, label: 'Notice chaudière' }],
      params: { kind: 'document_delete', documentId: 33, expectedVersion: NOTICE.version },
      preview: 'Supprimer le document « Notice chaudière » (Maison).',
      effects: [
        'Le document ne sera plus visible dans votre compte.',
        'Les informations qu’il justifiait sont retirées des fiches concernées, qui sont recalculées.',
        'Cette suppression ne s’annule pas depuis l’Assistant.',
      ],
    });
  });
});

describe('L114D-D04 — désignation', () => {
  it('plusieurs documents : jamais un choix à la place de l’utilisateur ; un titre exact l’emporte', async () => {
    expect(besoin(await resolveDraft({ command: 'DELETE_DOCUMENT', documentWords: ['facture'], documentFromContext: false }, input, lookup())))
      .toBe('Plusieurs documents correspondent : « Facture EDF » du 10 mars 2026, « Facture EDF mars » du 28 mars 2026. Précisez lequel dans votre demande.');
    expect(await resolveDraft({ command: 'DELETE_DOCUMENT', documentWords: ['facture', 'edf'], documentFromContext: false }, input, lookup())).toMatchObject({ targets: [{ id: 31 }] });
    expect(besoin(await resolveDraft({ command: 'DELETE_DOCUMENT', documentWords: ['inconnu'], documentFromContext: false }, input, lookup())))
      .toBe('Je n’ai pas trouvé ce document dans votre compte. Quel document voulez-vous supprimer ?');
  });

  it('« ce document » : celui du fil ou de la page ; sinon demandé', async () => {
    const d = parseCommand('Supprime ce document', TODAY)!;
    expect(d).toEqual({ command: 'DELETE_DOCUMENT', documentWords: [], documentFromContext: true });
    expect(besoin(await resolveDraft(d, input, lookup()))).toBe('Quel document voulez-vous supprimer ?');
    const fil = { ...base, reference: { type: 'document', id: 33, method: 'thread' } } as never;
    expect(await resolveDraft(d, fil, lookup())).toMatchObject({ targets: [{ id: 33 }] });
    const page = { ...base, pageContext: { documentId: 31 } } as never;
    expect(await resolveDraft(parseCommand('Renomme ce document en Facture électricité', TODAY)!, page, lookup())).toMatchObject({ targets: [{ id: 31 }], params: { newValue: 'Facture électricité' } });
  });
});

describe('L114D-D05 — faux positifs et priorités', () => {
  it('« supprime le document Entretien chaudière » ne vise jamais une échéance', () => {
    expect(parseCommand('Supprime le document Entretien chaudière', TODAY)).toEqual({ command: 'DELETE_DOCUMENT', documentWords: ['entretien', 'chaudiere'], documentFromContext: false });
  });
  it.each([
    'Quelle est la date du document Facture EDF ?',
    'Montre-moi le document Facture EDF',
    'Ajoute le site web du fournisseur Martin : https://martin.fr',
    'Supprime la Clio',
    'Ajoute une voiture nommée Mégane',
    'Ajoute un rappel pour envoyer le document Facture EDF le 12 mars',
  ])('« %s » n’est pas une commande de document', (message) => {
    const d = parseCommand(message, TODAY);
    expect(['CREATE_WEB_DOCUMENT', 'UPDATE_DOCUMENT', 'DELETE_DOCUMENT']).not.toContain(d?.command);
  });
});

describe('L114D-D06 — une seule façade métier, fiches de commande', () => {
  const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  it('les routes appellent la façade ; l’Assistant n’écrit jamais la table des documents', () => {
    expect(lire('src/app/api/documents/[id]/route.ts')).toContain('updateDocumentForAccount');
    expect(lire('src/app/api/documents/[id]/route.ts')).not.toMatch(/\.update\(assetFiles\)/);
    expect(lire('src/app/api/web-links/route.ts')).toContain('createWebDocumentForAccount');
    expect(lire('src/app/api/web-links/route.ts')).not.toMatch(/db\.insert\(assetFiles\)/);
    expect(lire('src/app/api/files/[id]/route.ts')).toContain('softDeleteDocument');
    const ex = lire('src/services/verebona-assistant/commands/executors.ts');
    for (const fn of ['createWebDocumentForAccount', 'updateDocumentForAccount', 'softDeleteDocument']) expect(ex).toContain(fn);
    expect(ex).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+asset_files/);
  });
  it('fiches : capacité, lecture avant écriture, politique de suppression', () => {
    expect(WRITE_COMMAND_CATALOG.CREATE_WEB_DOCUMENT.spec).toMatchObject({ capabilityCode: 'DOCUMENT_WEB_CREATE', requiredFields: ['url', 'title'], optionalFields: ['assetId'] });
    expect(WRITE_COMMAND_CATALOG.UPDATE_DOCUMENT.spec).toMatchObject({ capabilityCode: 'DOCUMENT_UPDATE', readBeforeWrite: true, deletePolicy: 'NONE' });
    expect(WRITE_COMMAND_CATALOG.DELETE_DOCUMENT.spec).toMatchObject({ capabilityCode: 'DOCUMENT_DELETE', deletePolicy: 'SOFT_DELETE', undoPolicy: 'IRREVERSIBLE' });
  });
});
