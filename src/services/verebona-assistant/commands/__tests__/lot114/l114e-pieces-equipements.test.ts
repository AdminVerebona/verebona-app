/**
 * Lot 114 (Trello #753, CDC T2 §14.3 W04 – W09, §14.4 « Équipements » et « Pièces », E2E-07) —
 * CRÉER, RENOMMER, RETIRER UNE PIÈCE OU UN ÉQUIPEMENT DEPUIS L'ASSISTANT.
 *
 *   S01  créer : nom et bien seulement ; refus de l'offre ou du type de bien AVANT tout plan ; jamais de doublon ;
 *   S02  équipement situé dans une pièce du même bien ;
 *   S03  renommer : ancien → nouveau, empreinte figée ;
 *   S04  supprimer une pièce : contenu annoncé, conservé dans le bien ; retirer un équipement : archivage ;
 *   S05  désignation : jamais un bien, une pièce ou un équipement choisi à la place de l'utilisateur ;
 *   S06  faux positifs (« pièce jointe », questions) ; façade partagée ; fiches de commande.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { parseCommand } = await import('../../parser');
const { resolveDraft, structureVersion } = await import('../../plan.service');
const { WRITE_COMMAND_CATALOG } = await import('../../catalog');
type Lookup = import('../../plan.service').CommandLookup;
type Room = import('../../plan.service').RoomState;
type Equip = import('../../plan.service').EquipmentState;

const TODAY = '2026-11-13';
const base = { accountId: 1, userId: 2, planType: 'PREMIUM', message: '', clientRequestId: 'x', locale: 'fr-FR' };
const input = base as never;
const maison = { id: 5, name: 'Maison', city: null };
const appart = { id: 6, name: 'Appartement', city: null };
const clio = { id: 7, name: 'Clio', city: null };
const room = (id: number, name: string, assetId = 5, o: Partial<Room> = {}): Room => {
  const b = { id, name, assetId, assetName: assetId === 5 ? 'Maison' : 'Appartement', documents: 0, equipments: 0, agenda: 0, ...o };
  return { ...b, version: structureVersion('room', b, [b.documents, b.equipments, b.agenda]) };
};
const equip = (id: number, name: string, assetId = 5, o: Partial<Equip> = {}): Equip => {
  const b = { id, name, assetId, assetName: assetId === 5 ? 'Maison' : 'Appartement', roomName: null, documents: 0, agenda: 0, ...o };
  return { ...b, version: structureVersion('equipment', b, [b.documents, b.agenda]) };
};
const CUISINE = room(21, 'Cuisine', 5, { documents: 2, equipments: 1, agenda: 1 });
const CUISINE_APPART = room(22, 'Cuisine', 6);
const CELLIER = room(23, 'Cellier');
const CHAUDIERE = equip(31, 'Chaudière', 5, { documents: 3, agenda: 2, roomName: 'Cellier' });
const sansAccent = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const lookup = (o: { refus?: string | null; rooms?: Room[]; equips?: Equip[] } = {}): Lookup => {
  const rooms = o.rooms ?? [CUISINE, CUISINE_APPART, CELLIER];
  const equips = o.equips ?? [CHAUDIERE];
  const biens = [maison, appart, clio];
  return {
    today: () => TODAY,
    async findAssets(_a, w) { return biens.filter((b) => w.some((x) => sansAccent(b.name).includes(x))); },
    async getAsset(_a, id) { return biens.find((b) => b.id === id) ?? null; },
    async getAssetKind(_a, id) { return id === 7 ? { category: 'VEHICULE', subtype: 'Voiture' } : biens.some((b) => b.id === id) ? { category: 'IMMOBILIER', subtype: 'Maison' } : null; },
    async structureRefusal(_a, asset, kind) {
      if (asset.category !== 'IMMOBILIER') return kind === 'room' ? 'Ce type de bien ne supporte pas la gestion des pièces' : 'Ce type de bien ne supporte pas la gestion des équipements';
      return o.refus ?? null;
    },
    async findRooms(_a, w, assetId) { return rooms.filter((r) => (assetId === null || r.assetId === assetId) && w.every((x) => sansAccent(r.name).includes(x))); },
    async getRoomState(_a, id) { return rooms.find((r) => r.id === id) ?? null; },
    async findEquipments(_a, w, assetId) { return equips.filter((e) => (assetId === null || e.assetId === assetId) && w.every((x) => sansAccent(e.name).includes(x))); },
    async getEquipmentState(_a, id) { return equips.find((e) => e.id === id) ?? null; },
  };
};
const besoin = (a: unknown) => (a as { needInfo: string }).needInfo;

describe('L114E-S01 — créer une pièce ou un équipement', () => {
  it('« ajoute une pièce Salle de bain dans la maison » : nom tel qu’écrit, bien résolu', async () => {
    const d = parseCommand('Ajoute une pièce Salle de bain dans la maison', TODAY)!;
    expect(d).toEqual({ command: 'CREATE_ROOM', name: 'Salle de bain', roomWords: [], assetWords: ['maison'], assetFromContext: false });
    expect(await resolveDraft(d, input, lookup())).toMatchObject({
      command: 'CREATE_ROOM', targets: [{ type: 'asset', id: 5, label: 'Maison' }],
      params: { kind: 'room_create', roomAssetId: 5, roomName: 'Salle de bain' }, preview: 'Créer la pièce « Salle de bain » dans Maison.',
    });
  });

  it('nom entre guillemets (« du » dans le nom) ; demande polie ; « de l’appartement »', () => {
    expect(parseCommand('Peux-tu créer une pièce « Chambre du haut » dans la maison ?', TODAY))
      .toMatchObject({ command: 'CREATE_ROOM', name: 'Chambre du haut', assetWords: ['maison'] });
    expect(parseCommand('Crée la pièce Bureau de l’appartement', TODAY)).toMatchObject({ command: 'CREATE_ROOM', name: 'Bureau', assetWords: ['appartement'] });
  });

  it('nom ou bien absents : seule l’information manquante est demandée ; bien du fil utilisé', async () => {
    expect(besoin(await resolveDraft(parseCommand('Ajoute une pièce dans la maison', TODAY)!, input, lookup()))).toBe('Quel nom voulez-vous donner à cette pièce ?');
    expect(besoin(await resolveDraft(parseCommand('Ajoute une pièce Buanderie', TODAY)!, input, lookup()))).toBe('Dans quel bien voulez-vous créer cette pièce ?');
    const fil = { ...base, reference: { type: 'asset', id: 6, method: 'thread' } } as never;
    expect(await resolveDraft(parseCommand('Ajoute une pièce Buanderie', TODAY)!, fil, lookup())).toMatchObject({ params: { roomAssetId: 6 } });
    expect(await resolveDraft(parseCommand('Ajoute une pièce Buanderie dans ce bien', TODAY)!, fil, lookup())).toMatchObject({ params: { roomAssetId: 6, roomName: 'Buanderie' } });
  });

  it('E2E-07 — type de bien incompatible ou offre : refus de la façade métier AVANT tout plan', async () => {
    expect(besoin(await resolveDraft(parseCommand('Ajoute une pièce Coffre dans la Clio', TODAY)!, input, lookup()))).toBe('Ce type de bien ne supporte pas la gestion des pièces');
    expect(besoin(await resolveDraft(parseCommand('Ajoute un équipement Autoradio dans la Clio', TODAY)!, input, lookup()))).toBe('Ce type de bien ne supporte pas la gestion des équipements');
    expect(besoin(await resolveDraft(parseCommand('Ajoute une pièce Buanderie dans la maison', TODAY)!, input, lookup({ refus: 'Cette fonctionnalité est disponible avec Premium et Premium Duo.' }))))
      .toBe('Cette fonctionnalité est disponible avec Premium et Premium Duo.');
  });

  it('jamais un doublon de nom dans le même bien ; le même nom dans un autre bien est permis', async () => {
    expect(besoin(await resolveDraft(parseCommand('Ajoute une pièce cuisine dans la maison', TODAY)!, input, lookup()))).toBe('La pièce « Cuisine » existe déjà dans Maison.');
    expect(await resolveDraft(parseCommand('Ajoute une pièce Cellier dans l’appartement', TODAY)!, input, lookup())).toMatchObject({ params: { roomAssetId: 6, roomName: 'Cellier' } });
    expect(besoin(await resolveDraft(parseCommand('Ajoute un équipement Chaudière dans la maison', TODAY)!, input, lookup()))).toBe('L’équipement « Chaudière » existe déjà dans Maison.');
  });
});

describe('L114E-S02 — équipement situé dans une pièce', () => {
  it('« ajoute un équipement Lave-linge dans la pièce Cellier de la maison »', async () => {
    const d = parseCommand('Ajoute un équipement Lave-linge dans la pièce Cellier de la maison', TODAY)!;
    expect(d).toEqual({ command: 'CREATE_EQUIPMENT', name: 'Lave-linge', roomWords: ['cellier'], assetWords: ['maison'], assetFromContext: false });
    expect(await resolveDraft(d, input, lookup())).toMatchObject({
      command: 'CREATE_EQUIPMENT', params: { kind: 'equipment_create', equipmentAssetId: 5, equipmentName: 'Lave-linge', equipmentRoomId: 23 },
      preview: 'Créer l’équipement « Lave-linge » dans Maison (pièce « Cellier »).',
    });
  });
  it('sans pièce : équipement du bien ; pièce inconnue de CE bien : demandée, jamais celle d’un autre bien', async () => {
    expect(await resolveDraft(parseCommand('Ajoute un équipement Portail électrique dans la maison', TODAY)!, input, lookup()))
      .toMatchObject({ params: { equipmentRoomId: null }, effects: expect.arrayContaining(['Pièce : aucune']) });
    expect(besoin(await resolveDraft(parseCommand('Ajoute un équipement Four dans la pièce Cellier de l’appartement', TODAY)!, input, lookup())))
      .toBe('Je n’ai pas trouvé cette pièce dans Appartement. Dans quelle pièce se trouve cet équipement ?');
  });
});

describe('L114E-S03 — renommer', () => {
  it('pièce : désignée dans son bien, ancien → nouveau', async () => {
    const d = parseCommand('Renomme la pièce Cuisine de la maison en Cuisine d’été', TODAY)!;
    expect(d).toEqual({ command: 'RENAME_ROOM', targetWords: ['cuisine'], newName: 'Cuisine d’été', assetWords: ['maison'], assetFromContext: false });
    expect(await resolveDraft(d, input, lookup())).toMatchObject({
      command: 'RENAME_ROOM', targets: [{ type: 'room', id: 21, label: 'Cuisine' }],
      params: { kind: 'room_rename', roomId: 21, roomAssetId: 5, roomName: 'Cuisine d’été', expectedVersion: CUISINE.version },
      preview: 'Renommer la pièce « Cuisine » (Maison) en « Cuisine d’été ».',
    });
  });
  it('équipement ; même nom ou nom déjà pris : aucune écriture préparée', async () => {
    expect(await resolveDraft(parseCommand('Renomme l’équipement Chaudière en Chaudière gaz', TODAY)!, input, lookup())).toMatchObject({
      command: 'RENAME_EQUIPMENT', params: { kind: 'equipment_rename', equipmentId: 31, equipmentAssetId: 5, equipmentName: 'Chaudière gaz', expectedVersion: CHAUDIERE.version },
    });
    expect(besoin(await resolveDraft(parseCommand('Renomme l’équipement Chaudière en Chaudière', TODAY)!, input, lookup()))).toBe('Cet équipement s’appelle déjà « Chaudière ».');
    expect(besoin(await resolveDraft(parseCommand('Renomme la pièce Cellier en Cuisine', TODAY)!, input, lookup()))).toBe('La pièce « Cuisine » existe déjà dans Maison.');
  });
});

describe('L114E-S04 — supprimer une pièce, retirer un équipement', () => {
  it('pièce : ce qui y est rattaché est annoncé, conservé dans le bien', async () => {
    const d = parseCommand('Supprime la pièce Cuisine de la maison', TODAY)!;
    expect(d).toEqual({ command: 'DELETE_ROOM', targetWords: ['cuisine'], assetWords: ['maison'], assetFromContext: false });
    expect(await resolveDraft(d, input, lookup())).toMatchObject({
      command: 'DELETE_ROOM', params: { kind: 'room_delete', roomId: 21, roomAssetId: 5, expectedVersion: CUISINE.version },
      preview: 'Supprimer la pièce « Cuisine » de Maison.',
      effects: [
        'Conservés dans Maison, sans pièce : 2 documents, 1 équipement.',
        '1 échéance ne sera plus liée à cette pièce (elle reste dans l’Agenda).',
        'Cette action est irréversible.',
      ],
    });
    const vide = await resolveDraft(parseCommand('Supprime la pièce Cellier', TODAY)!, input, lookup()) as { effects: string[] };
    expect(vide.effects).toEqual(['Aucun document ni équipement n’est rattaché à cette pièce.', 'Cette action est irréversible.']);
  });
  it('équipement : archivage annoncé, rien n’est supprimé', async () => {
    const d = parseCommand('Retire l’équipement Chaudière', TODAY)!;
    expect(d).toEqual({ command: 'ARCHIVE_EQUIPMENT', targetWords: ['chaudiere'], assetWords: [], assetFromContext: false });
    expect(parseCommand('Supprime l’équipement Chaudière de la maison', TODAY)).toMatchObject({ command: 'ARCHIVE_EQUIPMENT', assetWords: ['maison'] });
    expect(await resolveDraft(d, input, lookup())).toMatchObject({
      command: 'ARCHIVE_EQUIPMENT', params: { kind: 'equipment_archive', equipmentId: 31, equipmentAssetId: 5, expectedVersion: CHAUDIERE.version },
      preview: 'Retirer l’équipement « Chaudière » de Maison.',
      effects: ['L’équipement est archivé : il n’apparaît plus dans le bien, rien n’est supprimé.', 'Conservés : 3 documents, 2 échéances.'],
    });
  });
});

describe('L114E-S05 — désignation', () => {
  it('même nom dans deux biens : le bien est demandé, jamais choisi ; bien nommé : la bonne pièce', async () => {
    expect(besoin(await resolveDraft(parseCommand('Supprime la pièce Cuisine', TODAY)!, input, lookup())))
      .toBe('Plusieurs pièces correspondent : Cuisine (Maison), Cuisine (Appartement). Précisez laquelle dans votre demande.');
    expect(await resolveDraft(parseCommand('Supprime la pièce Cuisine de l’appartement', TODAY)!, input, lookup())).toMatchObject({ params: { roomId: 22 } });
    expect(besoin(await resolveDraft(parseCommand('Supprime la pièce Grenier', TODAY)!, input, lookup())))
      .toBe('Je n’ai pas trouvé cette pièce dans votre compte. Quelle pièce voulez-vous supprimer ?');
    expect(besoin(await resolveDraft(parseCommand('Retire l’équipement Climatisation', TODAY)!, input, lookup())))
      .toBe('Je n’ai pas trouvé cet équipement dans votre compte. Quel équipement voulez-vous retirer ?');
  });
});

describe('L114E-S06 — faux positifs, façade, fiches', () => {
  it.each([
    'Ajoute une pièce jointe au document Facture EDF',
    'Supprime la pièce d’identité',
    'Quelles pièces a la maison ?',
    'Montre-moi les équipements de la maison',
    'Supprime la Clio',
  ])('« %s » n’est pas une commande de pièce ou d’équipement', (message) => {
    const d = parseCommand(message, TODAY);
    expect(['CREATE_ROOM', 'RENAME_ROOM', 'DELETE_ROOM', 'CREATE_EQUIPMENT', 'RENAME_EQUIPMENT', 'ARCHIVE_EQUIPMENT']).not.toContain(d?.command);
  });
  const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  it('les routes appellent la façade ; l’Assistant n’écrit jamais ces tables lui-même', () => {
    expect(lire('src/app/api/assets/[id]/substructures/route.ts')).toContain('createRoomForAccount');
    const sub = lire('src/app/api/assets/[id]/substructures/[subId]/route.ts');
    expect(sub).toContain('renameRoomForAccount');
    expect(sub).toContain('deleteRoomForAccount');
    expect(lire('src/app/api/assets/[id]/equipments/route.ts')).toContain('createEquipmentForAccount');
    const eq = lire('src/app/api/assets/[id]/equipments/[equipId]/route.ts');
    expect(eq).toContain('updateEquipmentForAccount');
    expect(eq).toContain('archiveEquipmentForAccount');
    const ex = lire('src/services/verebona-assistant/commands/executors.ts');
    for (const fn of ['createRoomForAccount', 'renameRoomForAccount', 'deleteRoomForAccount', 'createEquipmentForAccount', 'updateEquipmentForAccount', 'archiveEquipmentForAccount']) expect(ex).toContain(fn);
    expect(ex).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+(substructures|equipments)/);
  });
  it('fiches : pièce supprimée (contenu détaché), équipement archivé (liens conservés)', () => {
    expect(WRITE_COMMAND_CATALOG.DELETE_ROOM.spec).toMatchObject({ capabilityCode: 'ROOM_DELETE', deletePolicy: 'HARD_DELETE_DETACHING_CONTENT', readBeforeWrite: true });
    expect(WRITE_COMMAND_CATALOG.ARCHIVE_EQUIPMENT.spec).toMatchObject({ capabilityCode: 'EQUIPMENT_ARCHIVE', deletePolicy: 'ARCHIVE_KEEPING_LINKS' });
    expect(WRITE_COMMAND_CATALOG.ARCHIVE_EQUIPMENT.label).toBe('Retirer un équipement');
    for (const c of ['CREATE_ROOM', 'RENAME_ROOM', 'CREATE_EQUIPMENT', 'RENAME_EQUIPMENT'] as const) expect(WRITE_COMMAND_CATALOG[c].spec?.retrySafety).toBe('PLAN_TAKEN_ONCE');
  });
});
