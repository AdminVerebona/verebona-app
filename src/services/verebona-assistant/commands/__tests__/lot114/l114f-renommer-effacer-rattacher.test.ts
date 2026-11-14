/**
 * Lot 114F (Trello #753, CDC T2 §14.3 W02, W27, W13, §14.4 « Biens » et « Documents ») —
 * RENOMMER UN BIEN, EFFACER UNE CARACTÉRISTIQUE, RATTACHER UN DOCUMENT À UN BIEN DEPUIS L'ASSISTANT.
 *
 *   F01  W02 : ancien nom → nouveau nom, tel qu'écrit ; nom figé ; jamais un bien choisi au hasard ;
 *   F02  W27 : champ de la liste fermée, valeur actuelle présentée et figée ; rien à effacer → aucun plan ;
 *   F03  W27 : « efface la date d'achat de la Clio » n'est JAMAIS une suppression de la Clio ; l'Agenda garde
 *        ses formulations ;
 *   F04  W13 : rattacher / détacher un bien, liste complète figée, autres rattachements conservés ;
 *   F05  faux positifs, priorités entre analyseurs, messages à plusieurs commandes ;
 *   F06  une seule écriture métier (service de la fiche, façade des documents) ; fiches de commande.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { parseCommand, parseCommands } = await import('../../parser');
const { resolveDraft, documentVersion, documentTargetsVersion } = await import('../../plan.service');
const { WRITE_COMMAND_CATALOG } = await import('../../catalog');
type Lookup = import('../../plan.service').CommandLookup;
type Asset = import('../../plan.service').AssetState;
type Doc = import('../../plan.service').DocumentState;
type Cibles = import('../../plan.service').DocumentAssetTargets;

const TODAY = '2026-11-13';
const base = { accountId: 1, userId: 2, planType: 'STANDARD', message: '', clientRequestId: 'x', locale: 'fr-FR' };
const input = base as never;
const sansAccent = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const bien = (id: number, name: string, category: string, characteristics: Record<string, unknown> = {}, o: Partial<Asset> = {}): Asset =>
  ({ id, name, city: null, category, status: 'ACTIVE', lockState: 'NONE', characteristics, ...o });
const CLIO = bien(7, 'Clio', 'VEHICULE', { acquisitionDate: '2021-05-25', mileage: 45000, insurer: 'MAIF' });
const MAISON = bien(5, 'Maison', 'IMMOBILIER', { acquisitionDate: '2015-06-01' });
const CARGO = bien(8, 'Vélo cargo', 'OBJECT', {});
const ROUTE = bien(9, 'Vélo de route', 'OBJECT', {});

const doc = (id: number, title: string): Doc => {
  const b = { id, title, documentDate: '2026-03-10', notesShown: '' };
  return { ...b, originalFilename: `${title}.pdf`, notesUserOwned: false, isWebLink: false, webLinkUrl: null, assetLabel: null, version: documentVersion(b) };
};
const EDF = doc(31, 'Facture EDF');
const EDF_MARS = doc(32, 'Facture EDF mars');
const GARANTIE = doc(33, 'Garantie');

const lookup = (o: { biens?: Asset[]; cibles?: Record<number, Cibles> } = {}): Lookup => {
  const biens = o.biens ?? [CLIO, MAISON, CARGO, ROUTE];
  const docs = [EDF, EDF_MARS, GARANTIE];
  return {
    today: () => TODAY,
    async findAssets(_a, w) { return biens.filter((b) => w.some((x) => sansAccent(b.name).includes(x))).map((b) => ({ id: b.id, name: b.name, city: null })); },
    async getAsset(_a, id) { const b = biens.find((x) => x.id === id); return b ? { id: b.id, name: b.name, city: null } : null; },
    async getAssetState(_a, id) { return biens.find((b) => b.id === id) ?? null; },
    async findDocuments(_a, w) { return docs.filter((d) => w.every((x) => sansAccent(d.title).includes(x))).map((d) => ({ id: d.id, title: d.title, documentDate: d.documentDate })); },
    async getDocumentState(_a, id) { return docs.find((d) => d.id === id) ?? null; },
    async getDocumentAssetTargets(_a, id) { return docs.some((d) => d.id === id) ? (o.cibles?.[id] ?? { chosen: [], implied: [] }) : null; },
  };
};
const besoin = (a: unknown) => (a as { needInfo: string }).needInfo;

describe('L114F-F01 — W02 : renommer un bien', () => {
  it('« renomme la Clio en Clio de Paul » : ancien → nouveau, nom figé', async () => {
    const d = parseCommand('Renomme la Clio en Clio de Paul', TODAY)!;
    expect(d).toEqual({ command: 'RENAME_ASSET', newName: 'Clio de Paul', assetWords: ['clio'], assetFromContext: false });
    const a = await resolveDraft(d, input, lookup());
    expect(a).toMatchObject({
      command: 'RENAME_ASSET', targets: [{ type: 'asset', id: 7, label: 'Clio' }],
      params: { kind: 'asset_rename', renamedAssetId: 7, assetNewName: 'Clio de Paul', expectedName: 'Clio' },
      preview: 'Renommer le bien « Clio » en « Clio de Paul ».',
    });
    expect((a as { effects: string[] }).effects[0]).toBe('Nom : Clio → Clio de Paul');
  });

  it('nom tel qu’écrit (accents, casse, guillemets) ; demande polie ; « change le nom de … »', () => {
    expect(parseCommand('Peux-tu renommer ma maison en « Maison d’Écully » ?', TODAY))
      .toEqual({ command: 'RENAME_ASSET', newName: 'Maison d’Écully', assetWords: ['maison'], assetFromContext: false });
    expect(parseCommand('Change le nom de la Clio en Clio de Paul.', TODAY))
      .toEqual({ command: 'RENAME_ASSET', newName: 'Clio de Paul', assetWords: ['clio'], assetFromContext: false });
    expect(parseCommand('Modifie le nom du bien Clio par Clio IV', TODAY))
      .toEqual({ command: 'RENAME_ASSET', newName: 'Clio IV', assetWords: ['clio'], assetFromContext: false });
  });

  it('« renomme ce bien en … » : bien du fil ou de la page ; sinon demandé', async () => {
    const d = parseCommand('Renomme ce bien en Twingo', TODAY)!;
    expect(d).toEqual({ command: 'RENAME_ASSET', newName: 'Twingo', assetWords: [], assetFromContext: true });
    expect(await resolveDraft(d, { ...base, reference: { type: 'asset', id: 7 } } as never, lookup()))
      .toMatchObject({ params: { kind: 'asset_rename', renamedAssetId: 7, assetNewName: 'Twingo', expectedName: 'Clio' } });
    expect(await resolveDraft(d, { ...base, pageContext: { assetId: 5 } } as never, lookup()))
      .toMatchObject({ params: { renamedAssetId: 5, expectedName: 'Maison' } });
    expect(besoin(await resolveDraft(d, input, lookup()))).toBe('Quel bien voulez-vous renommer ?');
  });

  it('deux biens correspondent : question, jamais un choix au hasard ; bien inconnu : dit', async () => {
    expect(besoin(await resolveDraft(parseCommand('Renomme le vélo en VTT', TODAY)!, input, lookup())))
      .toBe('Plusieurs biens correspondent : Vélo cargo, Vélo de route. Précisez lequel dans votre demande.');
    expect(besoin(await resolveDraft(parseCommand('Renomme la Mégane en Scénic', TODAY)!, input, lookup())))
      .toBe('Je n’ai pas trouvé ce bien dans votre compte. Quel bien voulez-vous renommer ?');
  });

  it('même nom : aucune écriture préparée ; bien archivé ou verrouillé par l’offre : refus avant tout plan', async () => {
    expect(besoin(await resolveDraft(parseCommand('Renomme la Clio en Clio', TODAY)!, input, lookup()))).toBe('Ce bien s’appelle déjà « Clio ».');
    const archive = lookup({ biens: [{ ...CLIO, status: 'ARCHIVED' }] });
    expect(besoin(await resolveDraft(parseCommand('Renomme la Clio en Twingo', TODAY)!, input, archive)))
      .toBe('Clio n’est pas modifiable actuellement (bien archivé ou verrouillé par votre offre).');
    const verrou = lookup({ biens: [{ ...CLIO, lockState: 'LOCKED_BY_PLAN' }] });
    expect(besoin(await resolveDraft(parseCommand('Renomme la Clio en Twingo', TODAY)!, input, verrou))).toMatch(/n’est pas modifiable actuellement/);
  });
});

describe('L114F-F02 — W27 : effacer une caractéristique d’un bien', () => {
  it('« efface la date d’achat de la Clio » : champ du registre, valeur actuelle présentée et figée', async () => {
    const d = parseCommand('Efface la date d’achat de la Clio', TODAY)!;
    expect(d).toEqual({ command: 'CLEAR_ASSET_FIELD', fieldKey: 'acquisitionDate', assetWords: ['clio'], assetFromContext: false });
    const a = await resolveDraft(d, input, lookup());
    expect(a).toMatchObject({
      command: 'CLEAR_ASSET_FIELD', targets: [{ type: 'asset', id: 7, label: 'Clio' }],
      params: { kind: 'asset_field_clear', clearAssetId: 7, clearSection: 'common', clearedField: 'acquisitionDate', clearedPrevious: '2021-05-25' },
      preview: 'Effacer « Date d’achat » de Clio (valeur actuelle : 25 mai 2021).',
    });
    expect((a as { effects: string[] }).effects).toEqual([
      'Bien : Clio', 'Champ : Date d’achat', 'Valeur actuelle : 25 mai 2021', 'Nouvelle valeur : non renseigné',
      'Le champ sera vide : cet effacement est enregistré comme votre décision.',
    ]);
  });

  it('autres verbes et champs ; section de la fiche propre à la famille ; bien du fil', async () => {
    expect(parseCommand('Supprime le kilométrage de la Clio.', TODAY)).toMatchObject({ command: 'CLEAR_ASSET_FIELD', fieldKey: 'mileage', assetWords: ['clio'] });
    expect(parseCommand('Peux-tu vider l’assureur de ma Clio ?', TODAY)).toMatchObject({ command: 'CLEAR_ASSET_FIELD', fieldKey: 'insurer', assetWords: ['clio'] });
    expect(await resolveDraft(parseCommand('Retire l’assureur de la Clio', TODAY)!, input, lookup()))
      .toMatchObject({ params: { clearSection: 'vehicle_insurance', clearedField: 'insurer', clearedPrevious: 'MAIF' } });
    const ctx = parseCommand('Efface le kilométrage de ce véhicule', TODAY)!;
    expect(ctx).toEqual({ command: 'CLEAR_ASSET_FIELD', fieldKey: 'mileage', assetWords: [], assetFromContext: true });
    expect(await resolveDraft(ctx, { ...base, reference: { type: 'asset', id: 7 } } as never, lookup()))
      .toMatchObject({ params: { clearAssetId: 7, clearedPrevious: 45000 }, preview: expect.stringMatching(/^Effacer « Kilométrage » de Clio \(valeur actuelle : 45\s000 km\)\.$/) });
    // Bien non nommé : celui du fil, sinon la question.
    const nu = parseCommand('Efface la date d’achat', TODAY)!;
    expect(nu).toEqual({ command: 'CLEAR_ASSET_FIELD', fieldKey: 'acquisitionDate', assetWords: [], assetFromContext: false });
    expect(besoin(await resolveDraft(nu, input, lookup()))).toBe('Pour quel bien voulez-vous effacer « Date d’achat » ?');
  });

  it('rien à effacer, champ non applicable, plusieurs biens, bien non modifiable : aucun plan', async () => {
    expect(besoin(await resolveDraft(parseCommand('Efface le prix d’achat de la Clio', TODAY)!, input, lookup())))
      .toBe('« Prix d’achat » de Clio n’est pas renseigné : il n’y a rien à effacer.');
    expect(besoin(await resolveDraft(parseCommand('Efface le kilométrage de la maison', TODAY)!, input, lookup())))
      .toBe('« Kilométrage » ne s’applique pas à Maison.');
    expect(besoin(await resolveDraft(parseCommand('Efface la date d’achat du vélo', TODAY)!, input, lookup())))
      .toBe('Plusieurs biens correspondent : Vélo cargo, Vélo de route. Précisez lequel dans votre demande.');
    expect(besoin(await resolveDraft(parseCommand('Efface la date d’achat de la Clio', TODAY)!, input, lookup({ biens: [{ ...CLIO, status: 'ARCHIVED' }] }))))
      .toMatch(/n’est pas modifiable actuellement/);
  });
});

describe('L114F-F03 — W27 passe avant la suppression d’un bien ; l’Agenda garde ses formulations', () => {
  it('« efface la date d’achat de la Clio » n’est jamais DELETE_ASSET ; « supprime la Clio » le reste', () => {
    for (const phrase of ['Efface la date d’achat de la Clio', 'Supprime la date d’achat de la Clio', 'Efface le prix d’achat de ma Clio', 'Supprime l’immatriculation de la Clio']) {
      expect(parseCommand(phrase, TODAY)?.command, phrase).toBe('CLEAR_ASSET_FIELD');
    }
    expect(parseCommand('Supprime la Clio', TODAY)).toEqual({ command: 'DELETE_ASSET', assetWords: ['clio'], assetFromContext: false });
    expect(parseCommand('Supprime ce bien', TODAY)).toMatchObject({ command: 'DELETE_ASSET', assetFromContext: true });
  });

  it('formulation qui nomme une échéance : reste une demande sur l’Agenda, sauf « la date du … »', () => {
    expect(parseCommand('Supprime le contrôle technique de la Clio', TODAY)?.command).toBe('DELETE_AGENDA_ITEM');
    expect(parseCommand('Supprime l’échéance de l’assurance de la Clio', TODAY)?.command).toBe('DELETE_AGENDA_ITEM');
    expect(parseCommand('Supprime le rappel de la date d’achat de la Clio', TODAY)?.command).toBe('DELETE_AGENDA_ITEM');
    expect(parseCommand('Efface la date du contrôle technique de la Clio', TODAY))
      .toEqual({ command: 'CLEAR_ASSET_FIELD', fieldKey: 'nextInspection', assetWords: ['clio'], assetFromContext: false });
    expect(parseCommand('Efface la fin d’assurance de la Clio', TODAY)).toMatchObject({ command: 'CLEAR_ASSET_FIELD', fieldKey: 'insuranceExpiry' });
  });

  it('autres objets : leurs analyseurs gardent la main', () => {
    expect(parseCommand('Efface le téléphone du fournisseur Durand', TODAY)?.command).toBe('UPDATE_SUPPLIER');
    expect(parseCommand('Efface la date du document Facture EDF', TODAY)?.command).toBe('UPDATE_DOCUMENT');
    expect(parseCommand('Efface la date d’achat de l’équipement Chaudière', TODAY)).toBeNull();
    // Le champ ne suit pas le verbe : pas un effacement de caractéristique.
    expect(parseCommand('Efface tout sauf la date d’achat de la Clio', TODAY)?.command).not.toBe('CLEAR_ASSET_FIELD');
  });
});

describe('L114F-F04 — W13 : rattacher un document à un bien, l’en détacher', () => {
  it('« rattache le document Garantie à la Clio » : liste complète figée, autres rattachements conservés', async () => {
    const d = parseCommand('Rattache le document Garantie à la Clio', TODAY)!;
    expect(d).toEqual({ command: 'UPDATE_DOCUMENT_TARGETS', mode: 'attach', structureTarget: false, assetWords: ['clio'], assetFromContext: false, documentWords: ['garantie'], documentFromContext: false });
    const cibles = { 33: { chosen: [{ id: 5, name: 'Maison' }], implied: [] } };
    const a = await resolveDraft(d, input, lookup({ cibles }));
    expect(a).toMatchObject({
      command: 'UPDATE_DOCUMENT_TARGETS',
      targets: [{ type: 'document', id: 33, label: 'Garantie' }, { type: 'asset', id: 7, label: 'Clio' }],
      params: { kind: 'document_targets', documentId: 33, targetAssetIds: [5, 7], expectedAssetIds: [5], expectedVersion: documentTargetsVersion(GARANTIE.version, [5]) },
      preview: 'Rattacher le document « Garantie » à Clio.',
    });
    expect((a as { effects: string[] }).effects).toEqual([
      'Document : Garantie', 'Biens rattachés : Maison → Maison, Clio', 'Les autres rattachements du document sont conservés.',
      'Ce rattachement est votre décision : il ne sera pas défait par une analyse.',
    ]);
  });

  it('« détache le document Garantie de la maison » : dissociation, jamais une suppression', async () => {
    const d = parseCommand('Détache le document Garantie de la maison', TODAY)!;
    expect(d).toMatchObject({ command: 'UPDATE_DOCUMENT_TARGETS', mode: 'detach', assetWords: ['maison'], documentWords: ['garantie'] });
    const cibles = { 33: { chosen: [{ id: 5, name: 'Maison' }, { id: 7, name: 'Clio' }], implied: [] } };
    const a = await resolveDraft(d, input, lookup({ cibles }));
    expect(a).toMatchObject({
      params: { kind: 'document_targets', documentId: 33, targetAssetIds: [7], expectedAssetIds: [5, 7] },
      preview: 'Détacher le document « Garantie » de Maison.',
    });
    expect((a as { effects: string[] }).effects).toContain('Le document reste dans vos documents : il n’est pas supprimé.');
    expect((a as { effects: string[] }).effects).toContain('Biens rattachés : Maison, Clio → Clio');
  });

  it('empreinte : indépendante de l’ordre des biens, sensible à leur liste et au document', () => {
    expect(documentTargetsVersion('v', [5, 7])).toBe(documentTargetsVersion('v', [7, 5]));
    expect(documentTargetsVersion('v', [5, 7])).not.toBe(documentTargetsVersion('v', [5]));
    expect(documentTargetsVersion('v', [5])).not.toBe(documentTargetsVersion('w', [5]));
  });

  it('déjà rattaché, non rattaché, rattaché par une pièce ou un équipement : aucun plan', async () => {
    const cibles = { 33: { chosen: [{ id: 5, name: 'Maison' }], implied: [{ id: 7, name: 'Clio' }] } };
    expect(besoin(await resolveDraft(parseCommand('Rattache le document Garantie à la maison', TODAY)!, input, lookup({ cibles })))).toBe('« Garantie » est déjà rattaché à Maison.');
    expect(besoin(await resolveDraft(parseCommand('Détache le document Garantie du vélo cargo', TODAY)!, input, lookup({ cibles, biens: [CLIO, MAISON, CARGO] })))).toBe('« Garantie » n’est pas rattaché à Vélo cargo.');
    expect(besoin(await resolveDraft(parseCommand('Détache le document Garantie de la Clio', TODAY)!, input, lookup({ cibles }))))
      .toBe('« Garantie » est rattaché à Clio par une pièce ou un équipement. Ouvrez le document pour modifier ce rattachement.');
  });

  it('désignation : plusieurs documents ou plusieurs biens → question ; « ce document », « ce bien » : fil ou page', async () => {
    expect(besoin(await resolveDraft(parseCommand('Rattache le document Facture à la Clio', TODAY)!, input, lookup()))).toMatch(/^Plusieurs documents correspondent : « Facture EDF »/);
    expect(besoin(await resolveDraft(parseCommand('Rattache le document Garantie au vélo', TODAY)!, input, lookup())))
      .toBe('Plusieurs biens correspondent : Vélo cargo, Vélo de route. Précisez lequel dans votre demande.');
    const d = parseCommand('Associe ce document à la Clio', TODAY)!;
    expect(d).toMatchObject({ command: 'UPDATE_DOCUMENT_TARGETS', mode: 'attach', documentWords: [], documentFromContext: true, assetWords: ['clio'] });
    expect(await resolveDraft(d, { ...base, reference: { type: 'document', id: 33 } } as never, lookup())).toMatchObject({ params: { documentId: 33, targetAssetIds: [7] } });
    expect(besoin(await resolveDraft(d, input, lookup()))).toBe('Quel document voulez-vous rattacher ?');
    const b = parseCommand('Rattache le document Garantie à ce bien', TODAY)!;
    expect(b).toMatchObject({ assetWords: [], assetFromContext: true, documentWords: ['garantie'] });
    expect(await resolveDraft(b, { ...base, pageContext: { assetId: 5 } } as never, lookup())).toMatchObject({ params: { targetAssetIds: [5] } });
    expect(besoin(await resolveDraft(b, input, lookup()))).toBe('À quel bien voulez-vous rattacher « Garantie » ?');
  });

  it('pièce ou équipement : dit, rien n’est proposé (depuis le document)', async () => {
    const d = parseCommand('Rattache le document Garantie à la pièce Cuisine', TODAY)!;
    expect(d).toMatchObject({ command: 'UPDATE_DOCUMENT_TARGETS', structureTarget: true, assetWords: [] });
    expect(besoin(await resolveDraft(d, input, lookup())))
      .toBe('Depuis l’assistant, un document se rattache à un bien. Pour une pièce ou un équipement, ouvrez le document et modifiez ses rattachements.');
  });
});

describe('L114F-F05 — faux positifs, priorités, plusieurs commandes', () => {
  it('questions et demandes de lecture : jamais une commande', () => {
    for (const q of ['Comment renommer la Clio en Twingo ?', 'Quand ai-je effacé la date d’achat de la Clio ?', 'Dis-moi à quel bien est rattaché le document Garantie', 'Quel est le nom de la Clio ?']) {
      expect(parseCommand(q, TODAY), q).toBeNull();
    }
  });

  it('renommer : échéance, document, pièce, équipement, fournisseur gardent leur analyseur', () => {
    expect(parseCommand('Renomme l’échéance vidange en révision annuelle', TODAY)?.command).toBe('UPDATE_AGENDA_ITEM');
    expect(parseCommand('Renomme le document Facture EDF en Facture électricité', TODAY)?.command).toBe('UPDATE_DOCUMENT');
    expect(parseCommand('Renomme la pièce Cuisine en Cuisine d’été', TODAY)?.command).toBe('RENAME_ROOM');
    expect(parseCommand('Renomme l’équipement Chaudière en Chaudière gaz', TODAY)?.command).toBe('RENAME_EQUIPMENT');
    expect(parseCommand('Renomme le fournisseur Durand en Durand & Fils', TODAY)?.command).toBe('UPDATE_SUPPLIER');
    // Bien non désigné par un mot exploitable : pas une commande (jamais le bien de la page à sa place).
    expect(parseCommand('Renomme la C3 en C3 de Paul', TODAY)).toBeNull();
  });

  it('commandes historiques inchangées', () => {
    expect(parseCommand('Mets la date d’achat le 25/05/2021 pour la Clio', TODAY)).toMatchObject({ command: 'UPDATE_ASSET_FIELD', field: 'acquisitionDate', value: '2021-05-25' });
    expect(parseCommand('Supprime le document Garantie', TODAY)).toMatchObject({ command: 'DELETE_DOCUMENT', documentWords: ['garantie'] });
    expect(parseCommand('Ajoute une voiture nommée Mégane', TODAY)).toMatchObject({ command: 'CREATE_ASSET', name: 'Mégane' });
  });

  it('plusieurs commandes : « … puis … » rend la seconde dépendante', () => {
    const s = parseCommands('Renomme la Clio en Clio de Paul puis efface la date d’achat de la Clio', TODAY)!;
    expect(s.map((x) => [x.draft.command, x.dependsOnPrevious])).toEqual([['RENAME_ASSET', false], ['CLEAR_ASSET_FIELD', true]]);
    const t = parseCommands('Rattache le document Garantie à la Clio et détache le document Garantie de la maison', TODAY)!;
    expect(t.map((x) => [x.draft.command, x.dependsOnPrevious])).toEqual([['UPDATE_DOCUMENT_TARGETS', false], ['UPDATE_DOCUMENT_TARGETS', false]]);
  });
});

describe('L114F-F06 — une seule écriture métier, fiches de commande', () => {
  const src = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
  const executeur = (nom: string) => {
    const s = src('src/services/verebona-assistant/commands/executors.ts');
    const debut = s.indexOf(`  async ${nom}(action, ctx) {`);
    expect(debut, nom).toBeGreaterThan(-1);
    return s.slice(debut, s.indexOf('\n  },', debut));
  };

  it('renommer et effacer : service de la fiche, origine USER, état attendu vérifié sous verrou ; aucune requête d’écriture directe', () => {
    const renommer = executeur('RENAME_ASSET');
    expect(renommer).toMatch(/updateAssetDetails\(/);
    expect(renommer).toMatch(/section: 'common', fields: \{ name: p\.assetNewName \}/);
    expect(renommer).toMatch(/origin: 'USER'/);
    expect(renommer).toMatch(/expectedCurrent: \{ name: p\.expectedName \}/);
    expect(renommer).not.toMatch(/UPDATE assets|INSERT INTO/);
    const effacer = executeur('CLEAR_ASSET_FIELD');
    expect(effacer).toMatch(/ecrireChampDeBien\(action, ctx, \{[^}]*value: null/);
    expect(executeur('UPDATE_ASSET_FIELD')).toMatch(/ecrireChampDeBien\(action, ctx, p\)/);
    const commun = src('src/services/verebona-assistant/commands/executors.ts');
    const corps = commun.slice(commun.indexOf('async function ecrireChampDeBien'));
    expect(corps).toMatch(/expectedCurrent: \{ \[p\.field\]: p\.previous \?\? null \}/);
    expect(corps).toMatch(/origin: 'USER'/);
    // Le service vérifie le nom attendu dans la transaction, ligne verrouillée.
    expect(src('src/services/asset-details-write.service.ts')).toMatch(/'name' in p\.expectedCurrent[\s\S]{0,200}AssetDetailsError\('CONFLICT'/);
  });

  it('rattacher : façade des documents (celle du tiroir), liste complète des biens, état recontrôlé', () => {
    const lier = executeur('UPDATE_DOCUMENT_TARGETS');
    expect(lier).toMatch(/updateDocumentForAccount\(/);
    expect(lier).toMatch(/assetIds: p\.targetAssetIds/);
    expect(lier).toMatch(/documentTargetsVersion\(etat\.version, cibles\.chosen\.map\(\(a\) => a\.id\)\) !== p\.expectedVersion/);
    expect(lier).not.toMatch(/INSERT INTO|UPDATE asset_files|document_links/);
  });

  it('fiches : capacité, lecture avant écriture, annulation', () => {
    expect(WRITE_COMMAND_CATALOG.RENAME_ASSET.spec).toMatchObject({ capabilityCode: 'ASSET_UPDATE', targetKind: 'asset', readBeforeWrite: true, undoPolicy: 'IRREVERSIBLE', successEvent: 'ASSET_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE' });
    expect(WRITE_COMMAND_CATALOG.CLEAR_ASSET_FIELD.spec).toMatchObject({ capabilityCode: 'ASSET_FIELD_CLEAR', targetKind: 'asset', readBeforeWrite: true, undoPolicy: 'REVERSIBLE_15_MIN', deletePolicy: 'NONE' });
    expect(WRITE_COMMAND_CATALOG.UPDATE_DOCUMENT_TARGETS.spec).toMatchObject({ capabilityCode: 'DOCUMENT_LINK', targetKind: 'document', readBeforeWrite: true, undoPolicy: 'IRREVERSIBLE', successEvent: 'DOCUMENT_UPDATED' });
    for (const c of ['RENAME_ASSET', 'CLEAR_ASSET_FIELD', 'UPDATE_DOCUMENT_TARGETS'] as const) expect(WRITE_COMMAND_CATALOG[c].requiresWriteAccess).toBe(true);
  });
});
