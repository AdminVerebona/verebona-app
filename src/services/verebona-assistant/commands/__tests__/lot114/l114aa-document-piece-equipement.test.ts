/**
 * Passage 114AA (Trello #753, CDC T2 §14.3 W13, §14.4 « Documents ») — RATTACHER UN DOCUMENT À UNE PIÈCE OU À
 * UN ÉQUIPEMENT, ou l'en détacher. Complète W13, jusqu'ici limité aux biens.
 *
 *   D01  phrases reconnues : le type (pièce, équipement) et les mots de son nom ;
 *   D02  aperçu : liste complète du niveau concerné figée, bien porteur annoncé, autres niveaux conservés ;
 *   D03  jamais un choix au hasard : introuvable, plusieurs candidats, déjà fait → question, aucun plan ;
 *   D04  empreinte : les pièces et les équipements y entrent — un changement depuis l'aperçu bloque l'écriture ;
 *        sans pièce ni équipement, l'empreinte reste celle d'avant (plans déjà préparés valides) ;
 *   D05  exécution : même façade que le tiroir du document, seul le niveau concerné est envoyé.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { parseCommand } = await import('../../parser');
const { resolveDraft, documentVersion, documentTargetsVersion } = await import('../../plan.service');
const { WRITE_COMMAND_CATALOG } = await import('../../catalog');
type Lookup = import('../../plan.service').CommandLookup;
type Doc = import('../../plan.service').DocumentState;
type Cibles = import('../../plan.service').DocumentAssetTargets;
type Structure = import('../../plan.service').StructureCandidate;

const TODAY = '2026-11-13';
const input = { accountId: 1, userId: 2, planType: 'PREMIUM', message: '', clientRequestId: 'x', locale: 'fr-FR' } as never;
const sansAccent = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const doc = (id: number, title: string): Doc => {
  const b = { id, title, documentDate: '2026-03-10', notesShown: '' };
  return { ...b, originalFilename: `${title}.pdf`, notesUserOwned: false, isWebLink: false, webLinkUrl: null, assetLabel: null, version: documentVersion(b) };
};
const GARANTIE = doc(33, 'Garantie');

const CUISINE: Structure = { id: 71, name: 'Cuisine', assetId: 5, assetName: 'Maison' };
const CUISINE_ETE: Structure = { id: 72, name: 'Cuisine d’été', assetId: 5, assetName: 'Maison' };
const CELLIER: Structure = { id: 73, name: 'Cellier', assetId: 5, assetName: 'Maison' };
const CHAUDIERE: Structure = { id: 81, name: 'Chaudière', assetId: 5, assetName: 'Maison' };

const lookup = (o: { cibles?: Cibles; pieces?: Structure[]; equipements?: Structure[] } = {}): Lookup => ({
  today: () => TODAY,
  async findAssets() { return []; },
  async getAsset() { return null; },
  async findDocuments(_a, w) { return w.every((x) => sansAccent(GARANTIE.title).includes(x)) ? [{ id: GARANTIE.id, title: GARANTIE.title, documentDate: GARANTIE.documentDate }] : []; },
  async getDocumentState(_a, id) { return id === GARANTIE.id ? GARANTIE : null; },
  async getDocumentAssetTargets(_a, id) { return id === GARANTIE.id ? (o.cibles ?? { chosen: [], implied: [], rooms: [], equipments: [] }) : null; },
  async findRooms(_a, w) { return (o.pieces ?? [CUISINE, CELLIER]).filter((s) => w.every((x) => sansAccent(s.name).includes(x))); },
  async findEquipments(_a, w) { return (o.equipements ?? [CHAUDIERE]).filter((s) => w.every((x) => sansAccent(s.name).includes(x))); },
});
const besoin = (a: unknown) => (a as { needInfo: string }).needInfo;

describe('L114AA-D01 — phrases reconnues', () => {
  it.each([
    ['Rattache le document Garantie à la pièce Cuisine', 'attach', 'room', ['cuisine']],
    ['Rattache le document Garantie à l’équipement Chaudière', 'attach', 'equipment', ['chaudiere']],
    ['Détache le document Garantie de la pièce Cuisine', 'detach', 'room', ['cuisine']],
    ['Détache le document Garantie de l’équipement Chaudière', 'detach', 'equipment', ['chaudiere']],
    ['Associe le document Garantie à la pièce Cuisine d’été', 'attach', 'room', ['cuisine', 'ete']],
  ])('%s', (phrase, mode, kind, words) => {
    expect(parseCommand(phrase, TODAY)).toMatchObject({
      command: 'UPDATE_DOCUMENT_TARGETS', mode, structureTarget: { kind, words }, assetWords: [], documentWords: ['garantie'],
    });
  });

  it('une pièce nommée sans aucun mot utile n’est pas une commande', () => {
    expect(parseCommand('Rattache le document Garantie à la pièce', TODAY)).toBeNull();
  });

  it('le rattachement à un BIEN est inchangé', () => {
    expect(parseCommand('Rattache le document Garantie à la Clio', TODAY))
      .toMatchObject({ command: 'UPDATE_DOCUMENT_TARGETS', mode: 'attach', structureTarget: null, assetWords: ['clio'] });
  });
});

describe('L114AA-D02 — aperçu : liste complète figée, bien porteur annoncé', () => {
  it('rattacher à une pièce : les équipements et les biens gardent leur sélection', async () => {
    const cibles: Cibles = { chosen: [{ id: 7, name: 'Clio' }], implied: [], rooms: [{ id: 73, name: 'Cellier' }], equipments: [{ id: 81, name: 'Chaudière' }] };
    const d = parseCommand('Rattache le document Garantie à la pièce Cuisine', TODAY)!;
    const a = await resolveDraft(d, input, lookup({ cibles }));
    expect(a).toMatchObject({
      command: 'UPDATE_DOCUMENT_TARGETS',
      preview: 'Rattacher le document « Garantie » à la pièce « Cuisine » (Maison).',
      params: {
        kind: 'document_targets', documentId: 33, level: 'room',
        targetStructureIds: [73, 71], expectedStructureIds: [73],
        // Le niveau « bien » n'est pas touché : la liste envoyée est celle d'avant.
        targetAssetIds: [7], expectedAssetIds: [7],
      },
    });
    const effets = (a as { effects: string[] }).effects;
    expect(effets).toContain('Pièces rattachées : Cellier → Cellier, Cuisine');
    expect(effets).toContain('Le bien « Maison » reste rattaché par cette pièce.');
    expect(effets).toContain('Les autres rattachements du document sont conservés.');
    expect(effets).toContain('Ce rattachement est votre décision : il ne sera pas défait par une analyse.');
    // Cibles de la trace : le document et la pièce.
    expect((a as { targets: unknown[] }).targets).toEqual([
      { type: 'document', id: 33, label: 'Garantie' }, { type: 'room', id: 71, label: 'Cuisine' },
    ]);
  });

  it('détacher un équipement : le document reste dans les documents', async () => {
    const cibles: Cibles = { chosen: [], implied: [{ id: 5, name: 'Maison' }], rooms: [], equipments: [{ id: 81, name: 'Chaudière' }] };
    const d = parseCommand('Détache le document Garantie de l’équipement Chaudière', TODAY)!;
    const a = await resolveDraft(d, input, lookup({ cibles }));
    expect(a).toMatchObject({
      preview: 'Détacher le document « Garantie » de l’équipement « Chaudière » (Maison).',
      params: { level: 'equipment', targetStructureIds: [], expectedStructureIds: [81] },
    });
    expect((a as { effects: string[] }).effects).toContain('Équipements rattachés : Chaudière → aucun');
    expect((a as { effects: string[] }).effects).toContain('Le document reste dans vos documents : il n’est pas supprimé.');
  });
});

describe('L114AA-D03 — jamais un choix au hasard', () => {
  it('pièce introuvable : une question, aucun plan', async () => {
    const d = parseCommand('Rattache le document Garantie à la pièce Grenier', TODAY)!;
    expect(besoin(await resolveDraft(d, input, lookup())))
      .toBe('Je n’ai pas trouvé cette pièce dans votre compte. À quelle pièce voulez-vous rattacher « Garantie » ?');
  });

  it('plusieurs pièces correspondent : la liste et une question, aucun plan', async () => {
    const d = parseCommand('Rattache le document Garantie à la pièce Cuisine', TODAY)!;
    expect(besoin(await resolveDraft(d, input, lookup({ pieces: [CUISINE, CUISINE_ETE] }))))
      .toBe('Plusieurs pièces correspondent : « Cuisine » (Maison), « Cuisine d’été » (Maison). Précisez laquelle dans votre demande.');
  });

  it('déjà rattaché, ou pas rattaché : c’est dit, rien n’est préparé', async () => {
    const cibles: Cibles = { chosen: [], implied: [], rooms: [{ id: 71, name: 'Cuisine' }], equipments: [] };
    expect(besoin(await resolveDraft(parseCommand('Rattache le document Garantie à la pièce Cuisine', TODAY)!, input, lookup({ cibles }))))
      .toBe('« Garantie » est déjà rattaché à la pièce « Cuisine » (Maison).');
    expect(besoin(await resolveDraft(parseCommand('Détache le document Garantie de l’équipement Chaudière', TODAY)!, input, lookup({ cibles }))))
      .toBe('« Garantie » n’est pas rattaché à l’équipement « Chaudière » (Maison).');
  });

  it('document introuvable : une question, aucun plan', async () => {
    const d = parseCommand('Rattache le document Inconnu à la pièce Cuisine', TODAY)!;
    expect(besoin(await resolveDraft(d, input, lookup()))).toContain('Je n’ai pas trouvé');
  });
});

describe('L114AA-D04 — empreinte des rattachements présentés', () => {
  it('sans pièce ni équipement, l’empreinte est celle d’avant (plans déjà préparés valides)', () => {
    expect(documentTargetsVersion('v1', [7, 5], [], [])).toBe(documentTargetsVersion('v1', [7, 5]));
    expect(documentTargetsVersion('v1', [5, 7])).toBe(documentTargetsVersion('v1', [7, 5]));
  });

  it('une pièce ou un équipement change l’empreinte ; l’ordre n’y entre pas', () => {
    const sans = documentTargetsVersion('v1', [7]);
    expect(documentTargetsVersion('v1', [7], [71])).not.toBe(sans);
    expect(documentTargetsVersion('v1', [7], [], [81])).not.toBe(sans);
    expect(documentTargetsVersion('v1', [7], [71])).not.toBe(documentTargetsVersion('v1', [7], [], [71]));
    expect(documentTargetsVersion('v1', [7], [73, 71])).toBe(documentTargetsVersion('v1', [7], [71, 73]));
  });

  it('l’empreinte figée à l’aperçu couvre les trois niveaux', async () => {
    const cibles: Cibles = { chosen: [{ id: 7, name: 'Clio' }], implied: [], rooms: [{ id: 73, name: 'Cellier' }], equipments: [{ id: 81, name: 'Chaudière' }] };
    const a = await resolveDraft(parseCommand('Rattache le document Garantie à la pièce Cuisine', TODAY)!, input, lookup({ cibles }));
    expect((a as { params: { expectedVersion: string } }).params.expectedVersion)
      .toBe(documentTargetsVersion(GARANTIE.version, [7], [73], [81]));
  });
});

describe('L114AA-D06 — actions comprises par le sens (bloc PO n° 40, facultatif)', () => {
  type Hint = import('@/services/verebona-assistant/types/contracts').ActionHint;
  const hint = (over: Partial<Hint>): Hint => ({ operation: 'LINK', entityType: 'document', targetHint: null, fieldChanges: [], evidencePhrase: null, ...over });
  const ch = (fieldHint: string, value: string | null) => ({ fieldHint, value, unit: null });

  it('un indice « pièce » ou « équipement » aboutit à la MÊME commande que la phrase directe', async () => {
    const { draftsFromActionHints } = await import('../../action-hints');
    const un = (h: Hint) => draftsFromActionHints([h], TODAY)?.drafts[0] ?? null;
    expect(un(hint({ targetHint: 'le document Garantie', fieldChanges: [ch('pièce', 'Cuisine')] }))).toEqual({
      command: 'UPDATE_DOCUMENT_TARGETS', mode: 'attach', structureTarget: { kind: 'room', words: ['cuisine'] },
      assetWords: [], assetFromContext: false, documentWords: ['garantie'], documentFromContext: false,
    });
    expect(un(hint({ targetHint: 'le document Garantie', fieldChanges: [ch('équipement', 'Chaudière')] })))
      .toMatchObject({ command: 'UPDATE_DOCUMENT_TARGETS', mode: 'attach', structureTarget: { kind: 'equipment', words: ['chaudiere'] } });
    expect(un(hint({ operation: 'UNLINK', targetHint: 'Garantie', fieldChanges: [ch('pièce', 'Cuisine')] })))
      .toMatchObject({ command: 'UPDATE_DOCUMENT_TARGETS', mode: 'detach', structureTarget: { kind: 'room', words: ['cuisine'] } });
    // Même chose par le type « relation » (l'objet rattaché ouvre la désignation).
    expect(un(hint({ entityType: 'relation', targetHint: 'le document Garantie', fieldChanges: [ch('pièce', 'Cuisine')] })))
      .toMatchObject({ command: 'UPDATE_DOCUMENT_TARGETS', structureTarget: { kind: 'room', words: ['cuisine'] } });
  });

  it('indices écartés : pièce sans nom, pièce ET bien dans le même indice', async () => {
    const { draftsFromActionHints } = await import('../../action-hints');
    expect(draftsFromActionHints([hint({ targetHint: 'le document Garantie', fieldChanges: [ch('pièce', null)] })], TODAY)).toBeNull();
    expect(draftsFromActionHints([hint({ targetHint: 'le document Garantie', fieldChanges: [ch('pièce', 'Cuisine'), ch('bien', 'la Clio')] })], TODAY)).toBeNull();
    // Le rattachement à un BIEN est inchangé.
    expect(draftsFromActionHints([hint({ targetHint: 'le document Garantie', fieldChanges: [ch('bien', 'la Clio')] })], TODAY)?.drafts[0])
      .toMatchObject({ command: 'UPDATE_DOCUMENT_TARGETS', structureTarget: null, assetWords: ['clio'] });
  });
});

describe('L114AA-D05 — exécution : une seule écriture métier', () => {
  const src = readFileSync(join(__dirname, '../../executors.ts'), 'utf8');
  const lier = src.slice(src.indexOf('document_targets'), src.indexOf('async CREATE_ASSET('));

  it('même façade que le tiroir du document ; seul le niveau concerné est envoyé', () => {
    expect(lier).toMatch(/updateDocumentForAccount\(/);
    expect(lier).toMatch(/if \(p\.level === 'room'\) body\.substructureIds = p\.targetStructureIds \?\? \[\];/);
    expect(lier).toMatch(/if \(p\.level === 'equipment'\) body\.equipmentIds = p\.targetStructureIds \?\? \[\];/);
    // Aucun SQL propre à l'Assistant.
    expect(lier).not.toMatch(/INSERT INTO|UPDATE asset_files|document_links/);
  });

  it('l’état est relu et l’empreinte des trois niveaux recontrôlée avant d’écrire', () => {
    expect(lier).toMatch(/const relue = documentTargetsVersion\(/);
    expect(lier).toMatch(/\(cibles\.rooms \?\? \[\]\)\.map\(\(s\) => s\.id\), \(cibles\.equipments \?\? \[\]\)\.map\(\(s\) => s\.id\)/);
    // Règle complétée (carte #843, E07) : l'écart est un CONFLIT explicite (relecture, nouvelle proposition) et la
    // version relue est exigée en plus DANS l'instruction d'écriture de la façade.
    expect(lier).toMatch(/if \(relue !== p\.expectedVersion\) return conflit\(action, DOCUMENT_CHANGED_SINCE_PREVIEW\)/);
    expect(lier).toMatch(/updateDocumentForAccount\([^)]*body, \{ expectedUpdatedAtMicros: jeton \}\)/);
  });

  it('la fiche de la commande déclare les champs du niveau pièce / équipement', () => {
    expect(WRITE_COMMAND_CATALOG.UPDATE_DOCUMENT_TARGETS.spec).toMatchObject({
      capabilityCode: 'DOCUMENT_LINK', targetKind: 'document', readBeforeWrite: true,
      optionalFields: ['level', 'targetStructureIds', 'expectedStructureIds'],
    });
    expect(WRITE_COMMAND_CATALOG.UPDATE_DOCUMENT_TARGETS.label).toBe('Rattacher un document');
  });
});
