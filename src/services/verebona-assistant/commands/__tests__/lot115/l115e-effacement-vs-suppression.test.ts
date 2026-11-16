/**
 * Carte #790, passage 115E (E01) — UNE DEMANDE D'EFFACEMENT DE CHAMP N'EST JAMAIS
 * UNE SUPPRESSION DE BIEN.
 *
 *   E01-1  « Efface la couleur de la Clio » : aucune suppression proposée, une question ;
 *   E01-2  l'arbitrage se fait par TYPE D'OBJET et par CHAMP, pas par le verbe seul ;
 *   E01-3  les vraies suppressions de bien restent possibles (nom porteur, « le bien … »,
 *          désignation de famille ou de catégorie, bien du fil) ;
 *   E01-4  les autres familles d'objets et les formes indirectes gardent leur sens.
 *
 * Aucun accès base : `pgClient` est bouchonné, la résolution reçoit un `lookup` en mémoire.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { parseCommand } = await import('../../parser');
const { resolveDraft } = await import('../../plan.service');
type Lookup = import('../../plan.service').CommandLookup;
type Asset = import('../../plan.service').AssetState;

const TODAY = '2026-11-13';
const input = { accountId: 1, userId: 2, planType: 'STANDARD', message: '', clientRequestId: 'x', locale: 'fr-FR' } as never;
const sansAccent = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const bien = (id: number, name: string, category: string): Asset =>
  ({ id, name, city: null, category, status: 'ACTIVE', lockState: 'NONE', characteristics: {} });
const CLIO = bien(7, 'Clio', 'VEHICULE');
const CLIO_DE_PAUL = bien(10, 'Clio de Paul', 'VEHICULE');
const MAISON = bien(5, 'Maison', 'IMMOBILIER');
const CARGO = bien(8, 'Vélo cargo', 'OBJECT');

const lookup = (biens: Asset[] = [CLIO, MAISON, CARGO]): Lookup => ({
  today: () => TODAY,
  async findAssets(_a, w) {
    return biens.filter((b) => w.some((x) => sansAccent(b.name).includes(x) || sansAccent(b.category).includes(x)))
      .map((b) => ({ id: b.id, name: b.name, city: null }));
  },
  async getAsset(_a, id) { const b = biens.find((x) => x.id === id); return b ? { id: b.id, name: b.name, city: null } : null; },
  async getAssetState(_a, id) { return biens.find((b) => b.id === id) ?? null; },
  async assetDeletionSummary(_a, id) {
    const b = biens.find((x) => x.id === id);
    // Le contrat veut un relevé de compteurs portant aussi le nom : la conversion le dit explicitement.
    return b ? ({ name: b.name, documents: 12, deadlines: 1, events: 0, photos: 3, rooms: 0, equipments: 2 } as unknown as Record<string, number> & { name: string }) : null;
  },
});
const besoin = (a: unknown) => (a as { needInfo?: string }).needInfo;

describe('E01-1 — « Efface la couleur de la Clio » ne propose jamais de supprimer la Clio', () => {
  it('la demande est découpée en propriété présumée + bien porteur présumé', () => {
    expect(parseCommand('Efface la couleur de la Clio', TODAY)).toEqual({
      command: 'DELETE_ASSET', assetWords: ['couleur', 'clio'], assetFromContext: false,
      propertyWords: ['couleur'], ownerWords: ['clio'],
    });
  });

  it('la résolution ne rend AUCUN plan : une question, et la vraie formulation de suppression', async () => {
    const a = await resolveDraft(parseCommand('Efface la couleur de la Clio', TODAY)!, input, lookup());
    expect(besoin(a)).toBeTypeOf('string');
    expect(a).not.toHaveProperty('params');
    expect(a).not.toHaveProperty('preview');
    expect(besoin(a)).not.toMatch(/[Ss]upprimer définitivement/);
    expect(besoin(a)).toContain('Je ne sais pas effacer « couleur » sur Clio.');
    expect(besoin(a)).toContain('Pour supprimer le bien lui-même, écrivez « Supprime le bien Clio ».');
  });

  it('les champs proposés sont ceux du registre POUR LA FAMILLE du bien (aucune liste parallèle)', async () => {
    const voiture = besoin(await resolveDraft(parseCommand('Efface la couleur de la Clio', TODAY)!, input, lookup()))!;
    const maison = besoin(await resolveDraft(parseCommand('Efface la couleur de la Maison', TODAY)!, input, lookup()))!;
    expect(voiture).toMatch(/kilométrage/);
    expect(maison).not.toMatch(/kilométrage/);
    expect(maison).toMatch(/date d’achat|date d'achat/i);
  });

  it.each([
    'Efface la couleur de la Clio',
    'Supprime la couleur de la Clio',
    'Efface la puissance fiscale de la Clio',
    'Supprime la date de péremption de la Clio',
    'Efface la surface habitable de la Maison',
    'Supprime le numéro de série du Vélo cargo',
    'Peux-tu effacer la couleur de la Clio ?',
  ])('%s : jamais un plan de suppression de bien', async (q) => {
    const d = parseCommand(q, TODAY);
    if (d === null) return; // non reconnue : parcours de réponse normal, rien d'écrit
    expect(d.command).toBe('DELETE_ASSET');
    const a = await resolveDraft(d, input, lookup());
    expect(besoin(a)).toBeTypeOf('string');
    expect(a).not.toHaveProperty('params');
  });
});

describe('E01-2 — arbitrage par type d’objet et par champ', () => {
  it('un champ CONNU du registre reste géré par l’effacement de caractéristique (comportement d’avant)', () => {
    expect(parseCommand('Efface la date d’achat de la Clio', TODAY))
      .toEqual({ command: 'CLEAR_ASSET_FIELD', fieldKey: 'acquisitionDate', assetWords: ['clio'], assetFromContext: false });
    expect(parseCommand('Efface le kilométrage de la Clio', TODAY)?.command).toBe('CLEAR_ASSET_FIELD');
  });

  it('le mot « bien » lève le doute : l’intention porte sur l’objet, pas sur un champ', async () => {
    const d = parseCommand('Supprime le bien Clio de Paul', TODAY)!;
    expect(d).toMatchObject({ command: 'DELETE_ASSET' });
    expect(d).not.toHaveProperty('propertyWords');
    const a = await resolveDraft(d, input, lookup([CLIO_DE_PAUL]));
    expect(a).toMatchObject({ command: 'DELETE_ASSET', params: { assetId: 10 } });
  });

  it('un autre objet métier garde son analyseur (aucun changement)', () => {
    for (const q of ['Supprime le document de la Clio', 'Supprime la facture de la Clio', 'Supprime la photo de la Maison']) {
      expect(parseCommand(q, TODAY)?.command).not.toBe('DELETE_ASSET');
    }
  });
});

describe('E01-3 — les vraies suppressions de bien restent possibles', () => {
  it('« Supprime la Clio » : décompte exact, irréversible, inchangé', async () => {
    const d = parseCommand('Supprime la Clio', TODAY)!;
    expect(d).toEqual({ command: 'DELETE_ASSET', assetWords: ['clio'], assetFromContext: false });
    const a = await resolveDraft(d, input, lookup()) as { preview: string; effects: string[] };
    expect(a.preview).toBe('Supprimer définitivement le bien « Clio » et tout ce qui lui est rattaché : 12 documents, 1 échéance, 3 photos, 2 équipements.');
    expect(a.effects).toContain('Cette action est irréversible.');
  });

  it('« Supprime la Clio de Paul » : le nom du bien porte les mots → suppression', async () => {
    const d = parseCommand('Supprime la Clio de Paul', TODAY)!;
    expect(d).toMatchObject({ propertyWords: ['clio'], ownerWords: ['paul'] });
    const a = await resolveDraft(d, input, lookup([CLIO_DE_PAUL]));
    expect(a).toMatchObject({ command: 'DELETE_ASSET', params: { assetId: 10 } });
  });

  it('une désignation de famille ou de catégorie n’est jamais prise pour un champ', () => {
    expect(parseCommand('Supprime la voiture de Paul', TODAY)).not.toHaveProperty('propertyWords');
    expect(parseCommand('Supprime le vélo cargo de la maison', TODAY)).not.toHaveProperty('propertyWords');
  });

  it('« Supprime ce bien » depuis la fiche : inchangé', async () => {
    const d = parseCommand('Supprime ce bien', TODAY)!;
    expect(d).toMatchObject({ command: 'DELETE_ASSET', assetFromContext: true });
    expect(d).not.toHaveProperty('propertyWords');
    const a = await resolveDraft(d, { ...(input as object), pageContext: { assetId: '7' } } as never, lookup());
    expect(a).toMatchObject({ command: 'DELETE_ASSET', params: { assetId: 7 } });
  });

  it('bien introuvable : le message d’avant, jamais un repli', async () => {
    const a = await resolveDraft(parseCommand('Supprime la Polo', TODAY)!, input, lookup());
    expect(besoin(a)).toMatch(/pas trouvé ce bien/);
  });
});

describe('E01-4 — formes indirectes et citations', () => {
  it.each([
    'Il faudrait effacer la couleur de la Clio',
    'Il m’a dit « supprime la Clio »',
    'Ai-je supprimé la Clio ?',
    'Comment supprimer un bien ?',
  ])('%s : aucune commande de suppression', (q) => {
    expect(parseCommand(q, TODAY)?.command).not.toBe('DELETE_ASSET');
  });
});
