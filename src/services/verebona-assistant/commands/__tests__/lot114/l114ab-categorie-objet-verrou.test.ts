/**
 * Passage 114AB (Trello #753, CDC T2 §14.3 W02) —
 *
 *   · **catégorie d'un bien de la famille OBJET** : elle est portée par un champ CANONIQUE de sa fiche
 *     (`objectCategory`, section « Identification ») et non par la colonne `subtype` des autres familles.
 *     Elle se modifie désormais depuis l'Assistant (règle remplacée du passage 114AA) ;
 *   · **relecture SOUS VERROU** de la catégorie de bien et du statut : la valeur présentée à l'aperçu est
 *     revérifiée par le service de la fiche DANS la transaction d'écriture, comme le nom (lot 114F).
 *
 *   C01  catégorie d'un objet : valeurs et libellés du REGISTRE, aperçu avant → après ;
 *   C02  jamais un choix au hasard : valeur inconnue, catégorie d'une autre famille, déjà en place ;
 *   C03  exécution : même service, champ et section figés par la préparation ;
 *   C04  durcissement sous verrou : le service de la fiche exige la valeur présentée (ajouts seuls).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { parseCommand } = await import('../../parser');
const { resolveDraft } = await import('../../plan.service');
const { getField } = await import('@/services/canonical/registry');
type Lookup = import('../../plan.service').CommandLookup;
type Asset = import('../../plan.service').AssetState;

const TODAY = '2026-11-13';
const input = { accountId: 1, userId: 2, planType: 'PREMIUM', message: '', clientRequestId: 'x', locale: 'fr-FR' } as never;

const LIBELLES = getField('objectCategory')!.enumLabels!;
const VELO: Asset = {
  id: 9, name: 'Vélo cargo', category: 'OBJECT', status: 'EN_SERVICE', lockState: null,
  characteristics: {}, subtype: null, objectCategory: null,
};

const lookup = (asset: Asset = VELO): Lookup => ({
  today: () => TODAY,
  async findAssets(_a, w) { return w.every((x) => asset.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(x)) ? [{ id: asset.id, name: asset.name }] : []; },
  async getAsset() { return { id: asset.id, name: asset.name }; },
  async getAssetState() { return asset; },
});
const besoin = (a: unknown) => (a as { needInfo: string }).needInfo;
const effets = (a: unknown) => (a as { effects: string[] }).effects;

describe('L114AB-C01 — catégorie d’un bien de la famille OBJET', () => {
  it.each([
    ['tech', 'OBJECT_CATEGORY_TECH'],
    ['électronique', 'OBJECT_CATEGORY_TECH'],
    ['sport', 'OBJECT_CATEGORY_SPORT'],
    ['loisir', 'OBJECT_CATEGORY_SPORT'],
    ['maison', 'OBJECT_CATEGORY_HOME'],
  ])('« en %s » → %s (libellés du registre, segments compris)', async (valeur, code) => {
    const a = await resolveDraft(parseCommand(`Change la catégorie du Vélo cargo en ${valeur}`, TODAY)!, input, lookup());
    expect(a).toMatchObject({
      command: 'UPDATE_ASSET_CATEGORY',
      params: { kind: 'asset_category', classifiedAssetId: 9, categoryValue: code, expectedCategory: null, objectCategory: true },
    });
  });

  it('aperçu : avant → après, famille jamais modifiée, aucun code technique', async () => {
    const a = await resolveDraft(parseCommand('Change la catégorie du Vélo cargo en sport', TODAY)!, input, lookup());
    expect(a).toMatchObject({ preview: `Modifier « Catégorie d’objet » de Vélo cargo : non renseigné → ${LIBELLES.OBJECT_CATEGORY_SPORT}.` });
    expect(effets(a)).toContain('La famille du bien (immobilier, véhicule, objet) n’est pas modifiée.');
    expect(effets(a)).toContain(`Catégorie d’objet : non renseigné → ${LIBELLES.OBJECT_CATEGORY_SPORT}`);
    expect(JSON.stringify(effets(a))).not.toContain('OBJECT_CATEGORY_');
  });

  it('valeur déjà enregistrée : l’aperçu part de son libellé', async () => {
    const asset: Asset = { ...VELO, characteristics: { objectCategory: 'OBJECT_CATEGORY_HOME' } };
    const a = await resolveDraft(parseCommand('Change la catégorie du Vélo cargo en sport', TODAY)!, input, lookup(asset));
    expect(a).toMatchObject({ params: { expectedCategory: 'OBJECT_CATEGORY_HOME' } });
    expect(effets(a)).toContain(`Catégorie d’objet : ${LIBELLES.OBJECT_CATEGORY_HOME} → ${LIBELLES.OBJECT_CATEGORY_SPORT}`);
  });
});

describe('L114AB-C02 — jamais un choix au hasard', () => {
  it('catégorie d’une AUTRE famille : c’est dit, et les catégories d’objet sont listées', async () => {
    const a = await resolveDraft(parseCommand('Change la catégorie du Vélo cargo en moto', TODAY)!, input, lookup());
    expect(besoin(a)).toBe(`« moto » n’est pas une catégorie d’objet. Catégories possibles pour Vélo cargo : ${Object.values(LIBELLES).join(', ')}.`);
  });

  it('valeur inconnue : la question liste les catégories possibles', async () => {
    const a = await resolveDraft(parseCommand('Change la catégorie du Vélo cargo en bidule', TODAY)!, input, lookup());
    expect(besoin(a)).toBe(`Quelle catégorie voulez-vous donner à Vélo cargo ? Par exemple : ${Object.values(LIBELLES).join(', ')}.`);
  });

  it('déjà en place : c’est dit, aucun plan', async () => {
    const asset: Asset = { ...VELO, objectCategory: 'OBJECT_CATEGORY_SPORT' };
    expect(besoin(await resolveDraft(parseCommand('Change la catégorie du Vélo cargo en sport', TODAY)!, input, lookup(asset))))
      .toBe(`La catégorie de Vélo cargo est déjà « ${LIBELLES.OBJECT_CATEGORY_SPORT} ».`);
  });

  it('un bien archivé ou verrouillé est refusé, comme pour toute modification', async () => {
    const asset: Asset = { ...VELO, status: 'ARCHIVED' };
    expect(besoin(await resolveDraft(parseCommand('Change la catégorie du Vélo cargo en sport', TODAY)!, input, lookup(asset))))
      .toContain('n’est pas modifiable actuellement');
  });
});

describe('L114AB-C03 — exécution : même service, champ et section figés', () => {
  const src = readFileSync(join(__dirname, '../../executors.ts'), 'utf8');
  const bloc = src.slice(src.indexOf('async UPDATE_ASSET_CATEGORY('), src.indexOf('async UPDATE_ASSET_STATUS('));

  it('un OBJET écrit le champ canonique de sa fiche, dans sa section', () => {
    expect(bloc).toMatch(/if \(p\.objectCategory === true\)/);
    expect(bloc).toMatch(/field: 'objectCategory', section: 'object_identification'/);
    expect(bloc).toMatch(/getField\('objectCategory'\)/);
    // Les autres familles gardent la colonne d'identité et la section commune.
    expect(bloc).toMatch(/field: 'subCategory', section: 'common'/);
    expect(bloc).not.toMatch(/UPDATE assets|INSERT INTO/);
  });
});

describe('L114AB-C04 — relecture SOUS VERROU de la catégorie et du statut', () => {
  const service = readFileSync(join(__dirname, '../../../../asset-details-write.service.ts'), 'utf8');
  const executors = readFileSync(join(__dirname, '../../executors.ts'), 'utf8');

  it('le service de la fiche exige la valeur présentée, dans la transaction d’écriture', () => {
    const mutate = service.slice(service.indexOf('mutate: ({ row, kc, results })'));
    expect(mutate).toMatch(/attenduIdentite/);
    expect(mutate).toMatch(/key: 'subCategory'/);
    expect(mutate).toMatch(/key: 'status'/);
    expect(mutate).toMatch(/AssetDetailsError\('CONFLICT'/);
    // La catégorie est comparée NORMALISÉE, comme la valeur écrite.
    expect(mutate).toMatch(/normalizeAssetCategory/);
    // Sans `expectedCurrent`, rien ne change (fiche du bien, back-office).
    expect(mutate).toMatch(/!p\.expectedCurrent \|\| !\(key in p\.expectedCurrent\)\) continue/);
  });

  it('l’Assistant transmet la valeur présentée au service', () => {
    const bloc = executors.slice(executors.indexOf('async function ecrireClassement('), executors.indexOf('async function ecrireChampDeBien('));
    expect(bloc).toMatch(/expectedCurrent: \{ \[p\.field\]: p\.attendu \}/);
    // La relecture de l'Assistant AVANT l'appel est conservée (double contrôle).
    expect(bloc).toMatch(/if \(texte\(p\.relire\(etat\)\) !== texte\(p\.attendu\)\) return ko\(action, change\)/);
    // Un conflit du service reste traduit en phrase claire.
    expect(bloc).toMatch(/if \(e\.code === 'CONFLICT'\) return ko\(action, change\)/);
  });

  it('aucune signature du service n’a changé : `expectedCurrent` existait déjà', () => {
    expect(service).toMatch(/expectedCurrent\?: Record<string, unknown>;/);
    expect(service).toMatch(/export async function updateAssetDetails\(p: UpdateAssetDetailsInput\)/);
  });
});
