/**
 * Passage 114AA (Trello #753, CDC T2 §14.3 W02, §14.4 « Biens ») — CATÉGORIE DE BIEN ET STATUT D'UN BIEN.
 * Complète W02, jusqu'ici limité au nom et aux caractéristiques.
 *
 *   C01  phrases reconnues : le champ est NOMMÉ (« la catégorie », « le statut »), ou le statut est un statut
 *        du référentiel (« marque … comme vendue ») ; toute autre tournure garde son comportement d'avant ;
 *   C02  catégorie : référentiel seulement, applicable à la famille du bien ; aperçu avant → après ;
 *   C03  statut : référentiel seulement, archivage non proposé ; sortie du portefeuille annoncée ;
 *   C04  jamais un choix au hasard : bien introuvable ou ambigu, valeur inconnue, valeur déjà en place ;
 *   C05  exécution : un seul service d'écriture (celui de la fiche), état relu avant d'écrire, fiches de commande.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { parseCommand } = await import('../../parser');
const { resolveDraft } = await import('../../plan.service');
const { WRITE_COMMAND_CATALOG } = await import('../../catalog');
type Lookup = import('../../plan.service').CommandLookup;
type Asset = import('../../plan.service').AssetState;

const TODAY = '2026-11-13';
const input = { accountId: 1, userId: 2, planType: 'PREMIUM', message: '', clientRequestId: 'x', locale: 'fr-FR' } as never;
const sansAccent = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const bien = (id: number, name: string, category: string, o: Partial<Asset> = {}): Asset =>
  ({ id, name, city: null, category, status: 'EN_SERVICE', lockState: 'NONE', characteristics: {}, subtype: null, objectCategory: null, ...o });
const CLIO = bien(7, 'Clio', 'VEHICULE', { subtype: 'Voiture' });
const MAISON = bien(5, 'Maison', 'IMMOBILIER', { subtype: 'Maison' });
const SANS_CATEGORIE = bien(6, 'Dépendance', 'IMMOBILIER', { subtype: null });
const CARGO = bien(8, 'Vélo cargo', 'OBJECT', { objectCategory: 'LEISURE_SPORT' });
// Carte #849 — règles remplacées dans ce fichier : deux statuts (EN_SERVICE, TRANSMIS) ; « vendu » et « archivé »
// sont compris comme une sortie du portefeuille (TRANSMIS, aperçu soumis à confirmation) ; un bien TRANSMIS est en
// consultation seule (sa remise en service passe par sa fiche, quota contrôlé). Fixture : ancien VENDU → TRANSMIS.
const VENDU = bien(10, 'Twingo', 'VEHICULE', { subtype: 'Voiture', status: 'TRANSMIS' });

const lookup = (biens: Asset[] = [CLIO, MAISON, SANS_CATEGORIE, CARGO, VENDU]): Lookup => ({
  today: () => TODAY,
  async findAssets(_a, w) { return biens.filter((b) => w.some((x) => sansAccent(b.name).includes(x))).map((b) => ({ id: b.id, name: b.name, city: null })); },
  async getAsset(_a, id) { const b = biens.find((x) => x.id === id); return b ? { id: b.id, name: b.name, city: null } : null; },
  async getAssetState(_a, id) { return biens.find((b) => b.id === id) ?? null; },
});
const besoin = (a: unknown) => (a as { needInfo: string }).needInfo;
const effets = (a: unknown) => (a as { effects: string[] }).effects;

describe('L114AA-C01 — phrases reconnues', () => {
  it.each([
    ['Change la catégorie de la Clio en moto', 'moto'],
    ['Modifie la catégorie de la Clio en Moto', 'moto'],
    ['Mets la catégorie de la Clio à moto', 'moto'],
    ['Peux-tu changer la catégorie de la Clio en moto', 'moto'],
  ])('catégorie — %s', (phrase, valeur) => {
    expect(parseCommand(phrase, TODAY)).toEqual({
      command: 'UPDATE_ASSET_CATEGORY', requestedCategory: valeur, assetWords: ['clio'], assetFromContext: false,
    });
  });

  it.each([
    ['Change le statut de la Clio en vendu', 'TRANSMIS'],
    ['Mets le statut de la Clio à vendue', 'TRANSMIS'],
    ['Marque la Clio comme vendue', 'TRANSMIS'],
    ['Indique la Clio comme transmise', 'TRANSMIS'],
    ['Change le statut de la Clio en en service', 'EN_SERVICE'],
  ])('statut — %s', (phrase, code) => {
    expect(parseCommand(phrase, TODAY)).toEqual({
      command: 'UPDATE_ASSET_STATUS', requestedStatus: code, assetWords: ['clio'], assetFromContext: false,
    });
  });

  it('« ce bien » depuis une fiche ; bien non désigné : pas une commande', () => {
    expect(parseCommand('Change la catégorie de ce bien en appartement', TODAY))
      .toEqual({ command: 'UPDATE_ASSET_CATEGORY', requestedCategory: 'appartement', assetWords: [], assetFromContext: true });
    expect(parseCommand('Marque ce bien comme vendu', TODAY))
      .toEqual({ command: 'UPDATE_ASSET_STATUS', requestedStatus: 'TRANSMIS', assetWords: [], assetFromContext: true });
    expect(parseCommand('Change la catégorie de en moto', TODAY)).toBeNull();
  });

  it('le champ nommé sans valeur comprise reste une commande (la valeur est demandée)', () => {
    expect(parseCommand('Change le statut de la Clio en prioritaire', TODAY))
      .toMatchObject({ command: 'UPDATE_ASSET_STATUS', requestedStatus: null });
  });

  it('« marque … comme <autre chose> » n’est PAS une commande : comportement d’avant inchangé', () => {
    expect(parseCommand('Marque la Clio comme prioritaire', TODAY)).toBeNull();
    expect(parseCommand('Marque l’échéance vidange comme faite', TODAY)?.command).not.toBe('UPDATE_ASSET_STATUS');
  });

  it('non-régression : les autres commandes sur un bien gardent leur analyseur', () => {
    expect(parseCommand('Renomme la Clio en Clio de Paul', TODAY)?.command).toBe('RENAME_ASSET');
    expect(parseCommand('Change le nom de la Clio en Clio de Paul', TODAY)?.command).toBe('RENAME_ASSET');
    expect(parseCommand('Efface la date d’achat de la Clio', TODAY)?.command).toBe('CLEAR_ASSET_FIELD');
    expect(parseCommand('Supprime la Clio', TODAY)?.command).toBe('DELETE_ASSET');
    expect(parseCommand('Mets le kilométrage à 52 000 km pour la Clio', TODAY)?.command).toBe('UPDATE_ASSET_FIELD');
    // Une question n'est jamais une commande.
    expect(parseCommand('Quelle est la catégorie de la Clio ?', TODAY)).toBeNull();
    // Un autre objet nommé exclut le classement d'un bien.
    expect(parseCommand('Change la catégorie du document Garantie en facture', TODAY)?.command).not.toBe('UPDATE_ASSET_CATEGORY');
  });
});

describe('L114AA-C02 — catégorie : référentiel seulement', () => {
  it('aperçu avant → après, famille inchangée', async () => {
    const a = await resolveDraft(parseCommand('Change la catégorie de la Clio en moto', TODAY)!, input, lookup());
    expect(a).toMatchObject({
      command: 'UPDATE_ASSET_CATEGORY', targets: [{ type: 'asset', id: 7, label: 'Clio' }],
      params: { kind: 'asset_category', classifiedAssetId: 7, categoryValue: 'Moto', expectedCategory: 'Voiture' },
      preview: 'Modifier « Catégorie de bien » de Clio : Voiture → Moto.',
    });
    expect(effets(a)).toEqual([
      'Bien : Clio',
      'Catégorie de bien : Voiture → Moto',
      'La famille du bien (immobilier, véhicule, objet) n’est pas modifiée.',
      'La catégorie oriente les rubriques de la fiche et les documents attendus.',
      'Pour revenir en arrière, refaites une demande.',
    ]);
  });

  it('catégorie non renseignée : « non renseigné → … »', async () => {
    const a = await resolveDraft(parseCommand('Mets la catégorie de la Dépendance à garage', TODAY)!, input, lookup());
    expect(a).toMatchObject({
      params: { classifiedAssetId: 6, categoryValue: 'Garage/box', expectedCategory: null },
      preview: 'Modifier « Catégorie de bien » de Dépendance : non renseigné → Garage/box.',
    });
  });

  it('une formulation utilisateur du référentiel est acceptée (« auto » = Voiture)', async () => {
    const a = await resolveDraft(parseCommand('Change la catégorie de la Clio en auto', TODAY)!, input, lookup());
    // Déjà « Voiture » : c'est dit, rien n'est préparé.
    expect(besoin(a)).toBe('La catégorie de Clio est déjà « Voiture ».');
  });

  it('catégorie d’une AUTRE famille : refusée, les catégories possibles sont listées', async () => {
    const a = await resolveDraft(parseCommand('Change la catégorie de la Clio en appartement', TODAY)!, input, lookup());
    expect(besoin(a)).toBe('« appartement » n’est pas une catégorie de véhicule. Catégories possibles pour Clio : voiture, moto, vélo, camping-car, bateau, camion.');
  });

  it('valeur inconnue du référentiel : la question liste les catégories', async () => {
    const a = await resolveDraft(parseCommand('Change la catégorie de la Maison en loft', TODAY)!, input, lookup());
    expect(besoin(a)).toBe('Quelle catégorie voulez-vous donner à Maison ? Par exemple : maison, appartement, immeuble, terrain, garage/box, mobil-home, local professionnel/commercial.');
  });

  // Règle remplacée (carte #753, passage 114AB) : la catégorie d'un bien de la famille OBJET se modifie
  // désormais aussi depuis l'Assistant — sur le champ canonique `objectCategory` de sa fiche, et non sur la
  // colonne `subtype`. Le refus « se modifie pour un bien immobilier ou un véhicule » n'existe plus pour lui ;
  // une catégorie d'une AUTRE famille continue d'être refusée en le disant (voir `l114ab-nature-document` et
  // `l114ab-categorie-objet`).
  it('un OBJET : une catégorie d’une autre famille est refusée, et les catégories d’objet sont listées', async () => {
    const a = await resolveDraft(parseCommand('Change la catégorie du Vélo cargo en moto', TODAY)!, input, lookup());
    expect(besoin(a)).toBe('« moto » n’est pas une catégorie d’objet. Catégories possibles pour Vélo cargo : Tech / IT / Électronique, Loisir / Sport, Maison & équipement.');
  });
});

describe('L114AA-C03 — statut : référentiel seulement, archivage exclu', () => {
  it('aperçu avant → après ; sortie du portefeuille annoncée', async () => {
    const a = await resolveDraft(parseCommand('Marque la Clio comme vendue', TODAY)!, input, lookup());
    expect(a).toMatchObject({
      command: 'UPDATE_ASSET_STATUS', targets: [{ type: 'asset', id: 7, label: 'Clio' }],
      params: { kind: 'asset_status', classifiedAssetId: 7, statusValue: 'TRANSMIS', expectedStatus: 'EN_SERVICE' },
      preview: 'Modifier « Statut » de Clio : En service → Transmis.',
    });
    expect(effets(a)).toEqual([
      'Bien : Clio',
      'Statut : En service → Transmis',
      'Ce bien sort du portefeuille actif : il n’apparaît plus par défaut dans vos listes et vos compteurs.',
      'Ses documents, ses échéances et son historique sont conservés : rien n’est supprimé.',
      'Il devient consultable seulement : pour le modifier à nouveau, utilisez « Remettre en service » depuis sa fiche.',
      'L’assistant ne le retrouvera plus par son nom : pour revenir en arrière, passez par sa fiche.',
    ]);
  });

  /**
   * Retour au portefeuille actif : la commande existe et se prépare (le référentiel la porte), mais un bien
   * VENDU ou TRANSMIS n'est plus une cible de l'assistant (règle existante `core/asset-availability`) — il n'est
   * donc pas joignable par son nom en préproduction. Limite dite dans la fiche de recette.
   */
  it('#849 : retour au portefeuille actif d’un bien transmis — action dédiée de la fiche (quota), jamais un plan de l’assistant', async () => {
    const a = await resolveDraft(parseCommand('Change le statut de la Twingo en en service', TODAY)!, input, lookup());
    expect(besoin(a)).toBe('Twingo n’est pas modifiable actuellement (bien transmis ou verrouillé par votre offre).');
  });

  it('#849 : aucun statut « Archivé » — « archivée » est comprise comme une sortie du portefeuille (Transmis), à confirmer', async () => {
    const d = parseCommand('Marque la Clio comme archivée', TODAY)!;
    expect(d).toMatchObject({ command: 'UPDATE_ASSET_STATUS', requestedStatus: 'TRANSMIS' });
    expect(await resolveDraft(d, input, lookup())).toMatchObject({ preview: 'Modifier « Statut » de Clio : En service → Transmis.' });
  });
});

describe('L114AA-C04 — jamais un choix au hasard', () => {
  it('bien introuvable, bien ambigu, bien non modifiable', async () => {
    expect(besoin(await resolveDraft(parseCommand('Marque la Megane comme vendue', TODAY)!, input, lookup())))
      .toMatch(/^Je n’ai pas trouvé ce bien/);
    const velos = [bien(8, 'Vélo cargo', 'VEHICULE', { subtype: 'Vélo' }), bien(9, 'Vélo de route', 'VEHICULE', { subtype: 'Vélo' })];
    expect(besoin(await resolveDraft(parseCommand('Marque le vélo comme vendu', TODAY)!, input, lookup(velos))))
      .toMatch(/^Plusieurs biens correspondent : /);
    const archive = [bien(7, 'Clio', 'VEHICULE', { subtype: 'Voiture', status: 'TRANSMIS' })];
    expect(besoin(await resolveDraft(parseCommand('Marque la Clio comme vendue', TODAY)!, input, lookup(archive))))
      .toBe('Clio n’est pas modifiable actuellement (bien transmis ou verrouillé par votre offre).');
  });

  it('statut non compris : la question liste les statuts proposés', async () => {
    expect(besoin(await resolveDraft(parseCommand('Change le statut de la Clio en prioritaire', TODAY)!, input, lookup())))
      .toBe('Quel statut voulez-vous donner à Clio ? Par exemple : en service, transmis.');
  });

  it('statut déjà en place, catégorie déjà en place : c’est dit, rien n’est préparé', async () => {
    expect(besoin(await resolveDraft(parseCommand('Change le statut de la Clio en en service', TODAY)!, input, lookup())))
      .toBe('Le statut de Clio est déjà « En service ».');
    expect(besoin(await resolveDraft(parseCommand('Change la catégorie de la Maison en maison', TODAY)!, input, lookup())))
      .toBe('La catégorie de Maison est déjà « Maison ».');
  });
});

describe('L114AA-C06 — actions comprises par le sens (bloc PO n° 40, facultatif)', () => {
  type Hint = import('@/services/verebona-assistant/types/contracts').ActionHint;
  const hint = (over: Partial<Hint>): Hint => ({ operation: 'UPDATE', entityType: 'asset', targetHint: null, fieldChanges: [], evidencePhrase: null, ...over });
  const ch = (fieldHint: string, value: string | null) => ({ fieldHint, value, unit: null });

  it('un indice « catégorie » ou « statut » aboutit à la MÊME commande que la phrase directe', async () => {
    const { draftsFromActionHints } = await import('../../action-hints');
    const un = (h: Hint) => draftsFromActionHints([h], TODAY)?.drafts[0] ?? null;
    expect(un(hint({ targetHint: 'la Clio', fieldChanges: [ch('catégorie', 'moto')] })))
      .toEqual({ command: 'UPDATE_ASSET_CATEGORY', requestedCategory: 'moto', assetWords: ['clio'], assetFromContext: false });
    expect(un(hint({ fieldChanges: [ch('catégorie de bien', 'appartement')] })))
      .toEqual({ command: 'UPDATE_ASSET_CATEGORY', requestedCategory: 'appartement', assetWords: [], assetFromContext: true });
    expect(un(hint({ targetHint: 'la Clio', fieldChanges: [ch('statut', 'vendu')] })))
      .toEqual({ command: 'UPDATE_ASSET_STATUS', requestedStatus: 'TRANSMIS', assetWords: ['clio'], assetFromContext: false });
  });

  it('indices écartés : famille, statut hors référentiel, valeur absente, plusieurs champs', async () => {
    const { draftsFromActionHints } = await import('../../action-hints');
    const un = (h: Hint) => draftsFromActionHints([h], TODAY)?.drafts[0] ?? null;
    // La FAMILLE d'un bien ne se change pas : l'indice est ignoré.
    expect(draftsFromActionHints([hint({ targetHint: 'la Clio', fieldChanges: [ch('famille', 'immobilier')] })], TODAY)).toBeNull();
    // Un statut hors référentiel n'aboutit JAMAIS à une question : l'indice est écarté.
    expect(draftsFromActionHints([hint({ targetHint: 'la Clio', fieldChanges: [ch('statut', 'prioritaire')] })], TODAY)).toBeNull();
    expect(draftsFromActionHints([hint({ targetHint: 'la Clio', fieldChanges: [ch('catégorie', null)] })], TODAY)).toBeNull();
    expect(draftsFromActionHints([hint({ targetHint: 'la Clio', fieldChanges: [ch('catégorie', 'moto'), ch('statut', 'vendu')] })], TODAY)).toBeNull();
    expect(un(hint({ targetHint: 'la Clio', fieldChanges: [ch('kilométrage', '52000')] }))?.command).toBe('UPDATE_ASSET_FIELD');
  });
});

describe('L114AA-C05 — exécution : une seule écriture métier', () => {
  const src = readFileSync(join(__dirname, '../../executors.ts'), 'utf8');
  const bloc = src.slice(src.indexOf('async function ecrireClassement('), src.indexOf('async function ecrireChampDeBien('));

  // Règle remplacée (carte #753, passage 114AB) : la section n'est plus écrite en dur (« common ») mais figée
  // par la préparation (`p.section`) — « common » pour la catégorie de bien et le statut, « object_identification »
  // pour la catégorie d'un OBJET. Le service appelé et l'origine sont inchangés.
  it('les deux commandes passent par le service de la fiche, dans la section figée par la préparation', () => {
    expect(bloc).toMatch(/updateAssetDetails\(\{/);
    expect(bloc).toMatch(/section: p\.section, fields: \{ \[p\.field\]: p\.value \}/);
    expect(bloc).toMatch(/origin: 'USER'/);
    // Aucun SQL propre à l'Assistant.
    expect(bloc).not.toMatch(/UPDATE assets|INSERT INTO/);
  });

  it('l’état est relu et la valeur de l’aperçu exigée avant d’écrire', () => {
    expect(bloc).toMatch(/const etat = await sqlLookup\.getAssetState!\(ctx\.accountId, p\.assetId\)/);
    expect(bloc).toMatch(/if \(texte\(p\.relire\(etat\)\) !== texte\(p\.attendu\)\) return ko\(action, change\)/);
    expect(bloc).toMatch(/a changé depuis l’aperçu : rien n’a été écrit/);
    // Aucun bouton « Annuler » : une correction se refait par une nouvelle demande.
    expect(bloc).toMatch(/reversible: false/);
  });

  it('les fiches de commande déclarent la lecture avant écriture et le service', () => {
    for (const type of ['UPDATE_ASSET_CATEGORY', 'UPDATE_ASSET_STATUS'] as const) {
      const def = WRITE_COMMAND_CATALOG[type];
      expect(def.requiresWriteAccess, type).toBe(true);
      expect(def.service, type).toBe('asset-details-write.service.updateAssetDetails');
      expect(def.spec, type).toMatchObject({
        capabilityCode: 'ASSET_UPDATE', targetKind: 'asset', readBeforeWrite: true,
        deletePolicy: 'NONE', undoPolicy: 'IRREVERSIBLE', successEvent: 'ASSET_UPDATED', retrySafety: 'PLAN_TAKEN_ONCE',
      });
    }
    expect(WRITE_COMMAND_CATALOG.UPDATE_ASSET_CATEGORY.label).toBe('Modifier la catégorie d’un bien');
    expect(WRITE_COMMAND_CATALOG.UPDATE_ASSET_STATUS.label).toBe('Modifier le statut d’un bien');
  });

  it('le mot « Opération » n’apparaît dans aucun texte de ces commandes', async () => {
    const textes = JSON.stringify([
      await resolveDraft(parseCommand('Change la catégorie de la Clio en moto', TODAY)!, input, lookup()),
      await resolveDraft(parseCommand('Marque la Clio comme vendue', TODAY)!, input, lookup()),
    ]);
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(textes).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
  });
});
