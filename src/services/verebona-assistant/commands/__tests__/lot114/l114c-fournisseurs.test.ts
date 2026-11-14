/**
 * Lot 114 (Trello #753, CDC T2 §14.3 W18 – W20, §14.4 « Fournisseurs », X65 – X68, M30) —
 * CRÉER, MODIFIER ET ARCHIVER UN FOURNISSEUR DEPUIS L'ASSISTANT.
 *
 *   F01  W18 : seul le nom est demandé ; coordonnées facultatives reprises telles qu'écrites ;
 *   F02  W18 : doublon certain jamais créé ; fiches proches annoncées, « distinct » décidé par la confirmation ;
 *   F03  W19 : une coordonnée à la fois, ancienne → nouvelle ; effacement volontaire ; valeur invalide refusée ;
 *   F04  W20 : le retrait est un ARCHIVAGE — rien n'est supprimé, les relations sont annoncées conservées ;
 *   F05  ce qui n'est PAS une commande fournisseur ; jamais un fournisseur choisi à la place de l'utilisateur ;
 *   F06  les routes et l'Assistant partagent la même façade métier ; fiche de commande complète.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { parseCommand } = await import('../../parser');
const { resolveDraft, supplierVersion } = await import('../../plan.service');
const { WRITE_COMMAND_CATALOG, SUPPLIER_COMMAND_FIELDS } = await import('../../catalog');
type Lookup = import('../../plan.service').CommandLookup;
type State = import('../../plan.service').SupplierState;

const TODAY = '2026-11-13';
const input = { accountId: 1, userId: 2, planType: 'STANDARD', message: '', clientRequestId: 'x', locale: 'fr-FR' } as never;
const fiche = (id: number, name: string, o: Partial<State> = {}): State => {
  const base = { id, name, status: 'active', phone: '01 23 45 67 89', email: null, website: null, ...o };
  return { ...base, version: supplierVersion(base), links: { documents: 3, assets: 1, equipments: 0, agenda: 2 }, ...(o.links ? { links: o.links } : {}) };
};
const DURAND = fiche(11, 'Plomberie Durand');
const MARTIN = fiche(12, 'Chauffage Martin');
const DURAND_FILS = fiche(13, 'Durand & Fils');
const sansAccent = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const lookup = (o: { fiches?: State[]; doublon?: { decision: 'certain' | 'uncertain' | 'new'; candidates: Array<{ id: number; name: string }> } } = {}): Lookup => ({
  today: () => TODAY,
  async findAssets() { return []; },
  async getAsset() { return null; },
  async findSuppliers(_a, w) { return (o.fiches ?? [DURAND, MARTIN, DURAND_FILS]).filter((s) => w.every((x) => sansAccent(s.name).includes(x))).map((s) => ({ id: s.id, name: s.name, status: s.status })); },
  async getSupplierState(_a, id) { return (o.fiches ?? [DURAND, MARTIN, DURAND_FILS]).find((s) => s.id === id) ?? null; },
  async supplierDuplicates() { return o.doublon ?? { decision: 'new', candidates: [] }; },
});
const besoin = (a: unknown) => (a as { needInfo: string }).needInfo;

describe('L114C-F01 — W18 : créer un fournisseur', () => {
  it('« ajoute le fournisseur Électricité Générale Bernard » : nom tel qu’écrit, rien d’autre demandé', async () => {
    const d = parseCommand('Ajoute le fournisseur Électricité Générale Bernard', TODAY)!;
    expect(d).toEqual({ command: 'CREATE_SUPPLIER', name: 'Électricité Générale Bernard', phone: null, email: null, website: null });
    const a = await resolveDraft(d, input, lookup());
    expect(a).toMatchObject({
      command: 'CREATE_SUPPLIER', targets: [],
      params: { kind: 'supplier_create', name: 'Électricité Générale Bernard', phone: null, email: null, website: null, distinctFrom: [] },
      preview: 'Créer le fournisseur « Électricité Générale Bernard ».', effects: ['Nom : Électricité Générale Bernard'],
    });
  });

  it('coordonnées facultatives : téléphone, e-mail, site repris tels qu’écrits ; demande polie', async () => {
    const d = parseCommand('Peux-tu créer un fournisseur Toiture Lambert, téléphone 06 12 34 56 78, email contact@lambert.fr, site www.lambert.fr ?', TODAY)!;
    expect(d).toEqual({ command: 'CREATE_SUPPLIER', name: 'Toiture Lambert', phone: '06 12 34 56 78', email: 'contact@lambert.fr', website: 'www.lambert.fr' });
    const a = await resolveDraft(d, input, lookup()) as { effects: string[] };
    expect(a.effects).toEqual(['Nom : Toiture Lambert', 'Téléphone : 06 12 34 56 78', 'E-mail : contact@lambert.fr', 'Site web : www.lambert.fr']);
  });

  it('nom entre guillemets ou après « nommé » ; « prestataire » compris', () => {
    expect(parseCommand('Crée un fournisseur « Garage du Centre »', TODAY)).toMatchObject({ command: 'CREATE_SUPPLIER', name: 'Garage du Centre' });
    expect(parseCommand('Enregistre un nouveau prestataire nommé Serrurerie Petit', TODAY)).toMatchObject({ command: 'CREATE_SUPPLIER', name: 'Serrurerie Petit' });
  });

  it('X65 — nom absent : aucune écriture, seul le nom est demandé', async () => {
    const d = parseCommand('Ajoute un fournisseur', TODAY)!;
    expect(d).toMatchObject({ command: 'CREATE_SUPPLIER', name: null });
    expect(besoin(await resolveDraft(d, input, lookup()))).toBe('Quel est le nom du fournisseur à créer ?');
    // Une coordonnée seule n'est jamais prise pour un nom.
    expect(parseCommand('Ajoute un fournisseur 06 12 34 56 78', TODAY)).toMatchObject({ name: null, phone: '06 12 34 56 78' });
  });

  it('e-mail invalide : refusé avant tout plan', async () => {
    const a = await resolveDraft({ command: 'CREATE_SUPPLIER', name: 'Lambert', phone: null, email: 'contact@lambert', website: null }, input, lookup());
    expect(besoin(a)).toBe('Cette adresse e-mail ne semble pas valide. Pouvez-vous la vérifier ?');
  });
});

describe('L114C-F02 — W18 : doublons (X66, X67)', () => {
  it('doublon CERTAIN : jamais créé, la fiche existante est nommée', async () => {
    const a = await resolveDraft(parseCommand('Ajoute le fournisseur Plomberie Durand', TODAY)!, input,
      lookup({ doublon: { decision: 'certain', candidates: [{ id: 11, name: 'Plomberie Durand' }] } }));
    expect(besoin(a)).toBe('Le fournisseur « Plomberie Durand » existe déjà dans votre compte : je ne crée pas de doublon.');
  });

  it('fiches PROCHES : jamais fusionnées par similarité ; annoncées, et la confirmation vaut décision « distinct »', async () => {
    const a = await resolveDraft(parseCommand('Ajoute le fournisseur Durand Plomberie', TODAY)!, input,
      lookup({ doublon: { decision: 'uncertain', candidates: [{ id: 11, name: 'Plomberie Durand' }, { id: 13, name: 'Durand & Fils' }] } })) as { params: { distinctFrom: number[] }; effects: string[] };
    expect(a.params.distinctFrom).toEqual([11, 13]);
    expect(a.effects).toContain('Attention : des fournisseurs proches existent déjà : « Plomberie Durand », « Durand & Fils ».');
    expect(a.effects).toContain('En confirmant, vous indiquez qu’il s’agit d’un fournisseur différent : ce choix sera conservé.');
  });
});

describe('L114C-F03 — W19 : modifier une coordonnée', () => {
  it('téléphone : ancienne → nouvelle valeur, fiche figée par son empreinte', async () => {
    const d = parseCommand('Change le téléphone du fournisseur Plomberie Durand : 06 98 76 54 32', TODAY)!;
    expect(d).toEqual({ command: 'UPDATE_SUPPLIER', supplierWords: ['plomberie', 'durand'], field: 'phone', value: '06 98 76 54 32', clear: false });
    const a = await resolveDraft(d, input, lookup());
    expect(a).toMatchObject({
      command: 'UPDATE_SUPPLIER', targets: [{ type: 'supplier', id: 11, label: 'Plomberie Durand' }],
      params: { kind: 'supplier_update', supplierId: 11, patch: { phone: '06 98 76 54 32' }, expectedVersion: DURAND.version },
      preview: 'Modifier le téléphone du fournisseur « Plomberie Durand » : 01 23 45 67 89 → 06 98 76 54 32.',
    });
    expect((a as { effects: string[] }).effects).toContain('Cette valeur ne sera pas remplacée par celle d’un document.');
  });

  it.each([
    ['Mets l’e-mail du fournisseur Chauffage Martin à contact@martin.fr', 'email', 'contact@martin.fr', ['chauffage', 'martin']],
    ['Modifie le mail du prestataire Martin en contact@martin.fr', 'email', 'contact@martin.fr', ['martin']],
    ['Ajoute le site web du fournisseur Martin : https://martin.fr', 'website', 'https://martin.fr', ['martin']],
    ['Corrige le numéro de téléphone du fournisseur Martin par +33 6 12 34 56 78', 'phone', '+33 6 12 34 56 78', ['martin']],
  ])('%s', (message, field, value, words) => {
    expect(parseCommand(message, TODAY)).toEqual({ command: 'UPDATE_SUPPLIER', supplierWords: words, field, value, clear: false });
  });

  it('renommer : nouveau nom tel qu’écrit', async () => {
    const d = parseCommand('Renomme le fournisseur Chauffage Martin en Martin Énergies', TODAY)!;
    expect(d).toEqual({ command: 'UPDATE_SUPPLIER', supplierWords: ['chauffage', 'martin'], field: 'name', value: 'Martin Énergies', clear: false });
    expect(parseCommand('Change le nom du fournisseur Chauffage Martin en « Martin Énergies »', TODAY)).toMatchObject({ field: 'name', value: 'Martin Énergies' });
    const a = await resolveDraft(d, input, lookup());
    expect(a).toMatchObject({ params: { patch: { name: 'Martin Énergies' } }, preview: 'Modifier le nom du fournisseur « Chauffage Martin » : Chauffage Martin → Martin Énergies.' });
  });

  it('X68 — effacement volontaire : valeur annoncée, protégée des documents ; rien à effacer → pas de plan', async () => {
    const d = parseCommand('Efface le téléphone du fournisseur Plomberie Durand', TODAY)!;
    expect(d).toEqual({ command: 'UPDATE_SUPPLIER', supplierWords: ['plomberie', 'durand'], field: 'phone', value: null, clear: true });
    const a = await resolveDraft(d, input, lookup());
    expect(a).toMatchObject({
      params: { patch: { phone: null } }, preview: 'Effacer le téléphone du fournisseur « Plomberie Durand » (01 23 45 67 89).',
    });
    expect((a as { effects: string[] }).effects).toContain('Cette valeur ne sera pas rétablie par un document.');
    expect(besoin(await resolveDraft(parseCommand('Efface l’e-mail du fournisseur Plomberie Durand', TODAY)!, input, lookup())))
      .toBe('E-mail de « Plomberie Durand » : aucune valeur n’est enregistrée.');
  });

  it('valeur absente, identique ou invalide : aucune écriture préparée', async () => {
    expect(besoin(await resolveDraft(parseCommand('Change le téléphone du fournisseur Plomberie Durand', TODAY)!, input, lookup())))
      .toBe('Quelle valeur voulez-vous enregistrer pour le téléphone de « Plomberie Durand » ?');
    expect(besoin(await resolveDraft(parseCommand('Change le téléphone du fournisseur Plomberie Durand : 01 23 45 67 89', TODAY)!, input, lookup())))
      .toBe('Téléphone de « Plomberie Durand » : c’est déjà 01 23 45 67 89.');
    expect(besoin(await resolveDraft({ command: 'UPDATE_SUPPLIER', supplierWords: ['martin'], field: 'email', value: 'pas-un-mail', clear: false }, input, lookup())))
      .toBe('Cette adresse e-mail ne semble pas valide. Pouvez-vous la vérifier ?');
    expect(besoin(await resolveDraft({ command: 'UPDATE_SUPPLIER', supplierWords: ['martin'], field: 'name', value: null, clear: true }, input, lookup())))
      .toBe('Le nom d’un fournisseur ne peut pas être vide.');
  });

  it('les coordonnées bancaires ne se modifient jamais depuis l’Assistant', () => {
    expect(SUPPLIER_COMMAND_FIELDS).toEqual(['name', 'phone', 'email', 'website']);
    expect(parseCommand('Change l’IBAN du fournisseur Martin : FR76 3000 6000 0112 3456 7890 189', TODAY)).toBeNull();
  });
});

describe('L114C-F04 — W20 : retirer un fournisseur = l’archiver', () => {
  it('« supprime le fournisseur … » : archivage annoncé, relations conservées, aucune suppression promise', async () => {
    const d = parseCommand('Supprime le fournisseur Chauffage Martin', TODAY)!;
    expect(d).toEqual({ command: 'ARCHIVE_SUPPLIER', supplierWords: ['chauffage', 'martin'] });
    expect(parseCommand('Archive le prestataire Chauffage Martin.', TODAY)).toEqual(d);
    const a = await resolveDraft(d, input, lookup());
    expect(a).toMatchObject({
      command: 'ARCHIVE_SUPPLIER', targets: [{ type: 'supplier', id: 12, label: 'Chauffage Martin' }],
      params: { kind: 'supplier_archive', supplierId: 12, expectedVersion: MARTIN.version },
      preview: 'Archiver le fournisseur « Chauffage Martin ».',
      effects: [
        'Un fournisseur ne se supprime pas : il est archivé.',
        'Conservés et toujours rattachés à lui : 3 documents, 1 bien, 2 échéances.',
        'Sa fiche reste consultable et peut être réactivée depuis vos fournisseurs.',
      ],
    });
  });

  it('déjà archivé ; sans relation', async () => {
    expect(besoin(await resolveDraft({ command: 'ARCHIVE_SUPPLIER', supplierWords: ['martin'] }, input, lookup({ fiches: [fiche(12, 'Chauffage Martin', { status: 'archived' })] }))))
      .toBe('Le fournisseur « Chauffage Martin » est déjà archivé.');
    const a = await resolveDraft({ command: 'ARCHIVE_SUPPLIER', supplierWords: ['martin'] }, input,
      lookup({ fiches: [fiche(12, 'Chauffage Martin', { links: { documents: 0, assets: 0, equipments: 0, agenda: 0 } })] })) as { effects: string[] };
    expect(a.effects[1]).toBe('Aucun document, bien, équipement ni échéance ne lui est rattaché.');
  });
});

describe('L114C-F05 — désignation et faux positifs', () => {
  it('jamais un fournisseur choisi à la place de l’utilisateur ; un nom exact l’emporte', async () => {
    expect(besoin(await resolveDraft({ command: 'ARCHIVE_SUPPLIER', supplierWords: ['durand'] }, input, lookup())))
      .toBe('Plusieurs fournisseurs correspondent : Plomberie Durand, Durand & Fils. Précisez lequel dans votre demande.');
    expect(besoin(await resolveDraft({ command: 'ARCHIVE_SUPPLIER', supplierWords: ['inconnu'] }, input, lookup())))
      .toBe('Je n’ai pas trouvé ce fournisseur dans votre compte. Quel fournisseur voulez-vous archiver ?');
    const exact = await resolveDraft({ command: 'ARCHIVE_SUPPLIER', supplierWords: ['durand'] }, input, lookup({ fiches: [fiche(21, 'Durand'), DURAND_FILS] }));
    expect(exact).toMatchObject({ targets: [{ id: 21 }] });
  });

  it.each([
    'Quel est le téléphone du fournisseur Durand ?',
    'Donne-moi le téléphone du fournisseur Durand',
    'Ajoute le rappel du fournisseur Durand',
    'Change l’adresse du fournisseur Durand : 3 rue des Lilas',
  ])('« %s » n’est pas une commande fournisseur', (message) => {
    const d = parseCommand(message, TODAY);
    expect(d?.command === 'CREATE_SUPPLIER' || d?.command === 'UPDATE_SUPPLIER' || d?.command === 'ARCHIVE_SUPPLIER').toBe(false);
  });

  it('« ajoute un rappel pour appeler le fournisseur Durand le 12 mars » reste une échéance ; « ajoute le fournisseur … » ne crée jamais un bien', () => {
    expect(parseCommand('Ajoute un rappel pour appeler le fournisseur Durand le 12 mars', TODAY)).toMatchObject({ command: 'CREATE_AGENDA_ITEM' });
    expect(parseCommand('Ajoute le fournisseur Garage Voiture Service', TODAY)).toMatchObject({ command: 'CREATE_SUPPLIER', name: 'Garage Voiture Service' });
    expect(parseCommand('Ajoute le fournisseur Entretien Service', TODAY)).toMatchObject({ command: 'CREATE_SUPPLIER', name: 'Entretien Service' });
  });
});

describe('L114C-F06 — une seule façade métier, fiches de commande', () => {
  const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  it('les trois routes appellent la façade ; aucune n’écrit plus la table directement', () => {
    for (const [route, fn] of [
      ['src/app/api/suppliers/route.ts', 'createSupplierForAccount'],
      ['src/app/api/suppliers/[id]/route.ts', 'updateSupplierForAccount'],
      ['src/app/api/suppliers/[id]/archive/route.ts', 'setSupplierArchived'],
    ] as const) {
      const t = lire(route);
      expect(t, route).toContain(fn);
      expect(t, route).not.toMatch(/db\.(insert|update)\(suppliers\)/);
    }
    const ex = lire('src/services/verebona-assistant/commands/executors.ts');
    for (const fn of ['createSupplierForAccount', 'updateSupplierForAccount', 'setSupplierArchived']) expect(ex).toContain(fn);
    // L'Assistant n'écrit jamais la table des fournisseurs lui-même.
    expect(ex).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+suppliers/);
  });
  it('fiche de chaque commande : capacité, lecture avant écriture, politique de retrait, rejeu sûr', () => {
    expect(WRITE_COMMAND_CATALOG.CREATE_SUPPLIER.spec).toMatchObject({ capabilityCode: 'SUPPLIER_CREATE', requiredFields: ['name'], readBeforeWrite: true, retrySafety: 'PLAN_TAKEN_ONCE' });
    expect(WRITE_COMMAND_CATALOG.UPDATE_SUPPLIER.spec).toMatchObject({ capabilityCode: 'SUPPLIER_UPDATE', readBeforeWrite: true, deletePolicy: 'NONE' });
    expect(WRITE_COMMAND_CATALOG.ARCHIVE_SUPPLIER.spec).toMatchObject({ capabilityCode: 'SUPPLIER_ARCHIVE', deletePolicy: 'ARCHIVE_KEEPING_LINKS' });
    expect(WRITE_COMMAND_CATALOG.ARCHIVE_SUPPLIER.label).toBe('Archiver un fournisseur');
  });
});
