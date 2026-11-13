/**
 * Lot 114B (Trello #753, CDC T2 §9.2, §14.3 W01 / W03, §14.4 « Biens », M19-M21) —
 * CRÉER ET SUPPRIMER UN BIEN DEPUIS L'ASSISTANT.
 *
 *   B01  W01 : famille et catégorie du référentiel, nom donné ; seuls le nom
 *        et la catégorie sont demandés ; quota de l'offre contrôlé avant le plan ;
 *   B02  W01 : « ajoute une facture pour ma voiture » ne crée aucun bien ;
 *   B03  W03 : décompte réel annoncé, aucune conservation promise, figé ;
 *   B04  W03 : jamais un bien choisi à la place de l'utilisateur ; « supprime
 *        le document de la Clio » ne supprime pas la Clio ;
 *   B05  la route et l'Assistant partagent la même façade métier.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { parseCommand } = await import('../../parser');
const { resolveDraft, deletionCounts } = await import('../../plan.service');
const { WRITE_COMMAND_CATALOG } = await import('../../catalog');
type Lookup = import('../../plan.service').CommandLookup;

const TODAY = '2026-11-13';
const input = { accountId: 1, userId: 2, planType: 'STANDARD', message: '', clientRequestId: 'x', locale: 'fr-FR' } as never;
const clio = { id: 7, name: 'Clio', city: null };
const cargo = { id: 8, name: 'Vélo cargo', city: null };
const route = { id: 9, name: 'Vélo de route', city: null };
const resume = { name: 'Clio', documents: 12, photos: 3, deadlines: 1, events: 0, rooms: 0, equipments: 2 };

const lookup = (o: { refus?: string | null; biens?: Array<typeof clio>; resume?: typeof resume | null } = {}): Lookup => ({
  today: () => TODAY,
  async findAssets(_a, w) { return (o.biens ?? [clio, cargo, route]).filter((a) => w.some((x) => a.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(x))); },
  async getAsset(_a, id) { return (o.biens ?? [clio, cargo, route]).find((a) => a.id === id) ?? null; },
  async assetCreationRefusal() { return o.refus ?? null; },
  async assetDeletionSummary(_a, id) { return o.resume === null ? null : id === 7 ? (o.resume ?? resume) as never : { name: 'x', documents: 0, photos: 0, deadlines: 0, events: 0, rooms: 0, equipments: 0 } as never; },
});

describe('L114B-B01 — W01 : créer un bien', () => {
  it('« ajoute une voiture nommée Mégane » : famille et catégorie du référentiel, nom tel qu’écrit', async () => {
    const d = parseCommand('Ajoute une voiture nommée Mégane', TODAY)!;
    expect(d).toEqual({ command: 'CREATE_ASSET', family: 'VEHICULE', category: 'Voiture', name: 'Mégane' });
    const a = await resolveDraft(d, input, lookup());
    expect(a).toMatchObject({
      command: 'CREATE_ASSET', targets: [],
      params: { kind: 'asset_create', category: 'VEHICULE', subtype: 'Voiture', objectCategory: null, name: 'Mégane' },
      preview: 'Créer le bien « Mégane » (voiture).',
    });
  });

  it('nom entre guillemets ; demande polie', () => {
    expect(parseCommand('Peux-tu créer une maison « Maison de Lyon » ?', TODAY))
      .toMatchObject({ command: 'CREATE_ASSET', family: 'IMMOBILIER', category: 'Maison', name: 'Maison de Lyon' });
  });

  it('nom absent : seule information réellement nécessaire demandée', async () => {
    const a = await resolveDraft(parseCommand('Ajoute un vélo', TODAY)!, input, lookup());
    expect((a as { needInfo: string }).needInfo).toBe('Quel nom voulez-vous donner à ce bien (vélo) ?');
  });

  it('quota de l’offre atteint : refus AVANT tout plan, avec le message de l’offre', async () => {
    const a = await resolveDraft(parseCommand('Ajoute une voiture nommée Mégane', TODAY)!, input, lookup({ refus: 'Vous avez atteint le nombre de biens de votre offre.' }));
    expect(a).toEqual({ needInfo: 'Vous avez atteint le nombre de biens de votre offre.' });
  });

  it('bien du même nom déjà présent : dit dans l’aperçu, jamais créé en silence', async () => {
    const a = await resolveDraft(parseCommand('Ajoute une voiture nommée Clio', TODAY)!, input, lookup()) as { effects: string[] };
    expect(a.effects.join(' ')).toMatch(/un bien nommé « Clio » existe déjà/);
  });
});

describe('L114B-B02 — ce qui ne crée pas un bien', () => {
  it.each([
    'Ajoute une facture pour ma voiture',
    'Ajoute un entretien pour la voiture',
    'Enregistre le kilométrage de ma voiture à 85 000 km',
    'Quelle voiture ai-je ajoutée ?',
    'Ajoute un équipement à la maison',
  ])('%s', (q) => {
    expect(parseCommand(q, TODAY)?.command).not.toBe('CREATE_ASSET');
  });
});

describe('L114B-B03 — W03 : supprimer un bien', () => {
  it('décompte réel, aucune conservation promise, irréversible', async () => {
    const d = parseCommand('Supprime la Clio', TODAY)!;
    expect(d).toEqual({ command: 'DELETE_ASSET', assetWords: ['clio'], assetFromContext: false });
    const a = await resolveDraft(d, input, lookup()) as { params: object; preview: string; effects: string[]; targets: unknown[] };
    expect(a.targets).toEqual([{ type: 'asset', id: 7, label: 'Clio' }]);
    expect(a.params).toEqual({ kind: 'asset_delete', assetId: 7, expectedSummary: { documents: 12, deadlines: 1, events: 0, photos: 3, rooms: 0, equipments: 2 } });
    expect(a.preview).toBe('Supprimer définitivement le bien « Clio » et tout ce qui lui est rattaché : 12 documents, 1 échéance, 3 photos, 2 équipements.');
    expect(a.effects).toContain('Cette action est irréversible.');
    expect(a.effects).toContain('Pour garder un document, téléchargez-le avant de supprimer le bien.');
    expect(a.effects.join(' ')).not.toMatch(/conserv/);
  });

  it('décompte : éléments à zéro omis, singulier et pluriel', () => {
    expect(deletionCounts({ documents: 1, deadlines: 2, events: 0, photos: 0, rooms: 1, equipments: 0 })).toEqual(['1 document', '2 échéances', '1 pièce']);
  });

  it('« supprime ce bien » depuis la fiche : le bien de la page', async () => {
    const a = await resolveDraft(parseCommand('Supprime ce bien', TODAY)!, { ...(input as object), pageContext: { assetId: '7' } } as never, lookup());
    expect(a).toMatchObject({ command: 'DELETE_ASSET', params: { assetId: 7 } });
  });
});

describe('L114B-B04 — jamais le mauvais bien', () => {
  it('deux vélos : liste, aucun choix à la place de l’utilisateur', async () => {
    const a = await resolveDraft(parseCommand('Supprime mon vélo', TODAY)!, input, lookup());
    expect((a as { needInfo: string }).needInfo).toMatch(/Plusieurs biens correspondent : Vélo cargo, Vélo de route/);
  });

  it('bien absent : aucun repli vers un autre bien', async () => {
    const a = await resolveDraft(parseCommand('Supprime la Polo', TODAY)!, input, lookup());
    expect((a as { needInfo: string }).needInfo).toMatch(/pas trouvé ce bien/);
  });

  it.each([
    'Supprime le document de la Clio',
    'Supprime la facture de la Clio',
    'Supprime l’échéance vidange de la Clio',
    'Supprime la photo de la maison',
    'Supprime l’équipement chaudière',
    'Ai-je supprimé la Clio ?',
  ])('%s : pas une suppression de bien', (q) => {
    expect(parseCommand(q, TODAY)?.command).not.toBe('DELETE_ASSET');
  });
});

describe('L114B-B05 — une seule logique métier', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  it('la route appelle la façade ; elle ne porte plus la création ni la suppression', () => {
    const r = read('src/app/api/assets/route.ts');
    expect(r).toMatch(/createAssetForAccount\(/);
    expect(r).toMatch(/deleteAssetForAccount\(/);
    expect(r).not.toMatch(/db\.insert\(assets\)|deleteAssetCompletely\(/);
  });
  it('les exécuteurs appellent la même façade, jamais une route ni un INSERT', () => {
    const e = read('src/services/verebona-assistant/commands/executors.ts');
    expect(e).toMatch(/createAssetForAccount\(/);
    expect(e).toMatch(/deleteAssetForAccount\(/);
    expect(e).not.toMatch(/INSERT INTO assets|fetch\(/);
  });
  it('fiche de commande complète', () => {
    expect(WRITE_COMMAND_CATALOG.DELETE_ASSET.spec).toMatchObject({ deletePolicy: 'HARD_DELETE_WITH_CONTENT', undoPolicy: 'IRREVERSIBLE', readBeforeWrite: true });
    expect(WRITE_COMMAND_CATALOG.CREATE_ASSET.spec).toMatchObject({ capabilityCode: 'ASSET_CREATE', requiredFields: ['category', 'name'] });
  });
});
