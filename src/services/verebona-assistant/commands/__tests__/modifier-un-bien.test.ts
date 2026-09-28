/**
 * « Mets date d'achat le 25/05/2021 pour la polo » — commande UPDATE_ASSET_FIELD.
 *
 * Reconnaissance déterministe, bien et ancienne valeur résolus dans le
 * compte, mêmes contrôles que la fiche, rien d'écrit avant confirmation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseCommand } from '../parser';
import { resolveDraft, type CommandLookup, type AssetState } from '../plan.service';
import { actionKind } from '../catalog';
import { validateDetailChanges, acceptDetailDate } from '@/lib/asset-detail-rules';

const TODAY = '2026-09-25';
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const polo: AssetState = {
  id: 12, name: 'Polo', city: null, category: 'VEHICULE', status: 'EN_SERVICE', lockState: 'NONE',
  characteristics: { acquisitionDate: '2019-03-12', nextInspection: '2027-01-10', mileage: 80000 },
};
const maison: AssetState = {
  id: 42, name: 'Maison', city: 'Lyon', category: 'IMMOBILIER', status: 'EN_SERVICE', lockState: 'NONE', characteristics: {},
};
const lookup: CommandLookup = {
  today: () => TODAY,
  async findAssets(_a, w) { return [polo, maison].filter((a) => w.some((x) => a.name.toLowerCase().includes(x))); },
  async getAsset() { return null; },
  async findAgendaItems() { return []; },
  async getAgendaItem() { return null; },
  async listOpenAgendaItems() { return []; },
  async getAssetState(_a, id) { return [polo, maison].find((a) => a.id === id) ?? null; },
};
const input = { accountId: 1, userId: 2, planType: 'PREMIUM', message: '', clientRequestId: 'x', locale: 'fr-FR' };

describe('reconnaissance', () => {
  it('la demande de la capture', () => {
    expect(parseCommand('mets date d\'achat le 25/05/2021 pour la polo', TODAY)).toEqual({
      command: 'UPDATE_ASSET_FIELD', field: 'acquisitionDate', value: '2021-05-25', assetWords: ['polo'], assetFromContext: false,
    });
  });

  it('formes variées : bien avant la valeur, nombre, texte', () => {
    expect(parseCommand('Change la date d’achat de la Polo au 25 mai 2021', TODAY))
      .toMatchObject({ field: 'acquisitionDate', value: '2021-05-25', assetWords: ['polo'] });
    expect(parseCommand('Renseigne le kilométrage à 85 400 km pour la polo', TODAY))
      .toMatchObject({ field: 'mileage', value: 85400, assetWords: ['polo'] });
    expect(parseCommand('Modifie l’assureur à MAIF pour la polo', TODAY))
      .toMatchObject({ field: 'insurer', value: 'MAIF', assetWords: ['polo'] });
    expect(parseCommand('mets le prochain contrôle technique au 12/03/2027 pour cette voiture', TODAY))
      .toMatchObject({ field: 'nextInspection', value: '2027-03-12', assetFromContext: true });
  });

  it('une date d’achat sans année n’est pas devinée', () => {
    expect(parseCommand('mets la date d’achat le 25 mai pour la polo', TODAY)).toMatchObject({ value: null });
  });

  it('le nombre du nom du bien n’est pas la valeur ; le bien peut précéder la valeur', () => {
    expect(parseCommand('mets le kilométrage de la Polo 2019 à 85 000 km', TODAY))
      .toMatchObject({ field: 'mileage', value: 85000, assetWords: ['polo'] });
    expect(parseCommand("change l'assureur de la polo en MAIF", TODAY))
      .toMatchObject({ field: 'insurer', value: 'MAIF', assetWords: ['polo'] });
    expect(parseCommand("mets l'immatriculation de la polo à AB-123-CD", TODAY))
      .toMatchObject({ field: 'registrationNumber', value: 'AB-123-CD', assetWords: ['polo'] });
  });

  it('les commandes d’agenda restent des commandes d’agenda', () => {
    expect(parseCommand('enregistre le contrôle technique le 12/05/2027 pour la polo', TODAY)).toMatchObject({ command: 'CREATE_AGENDA_ITEM' });
    expect(parseCommand('Ajoute un rappel contrôle technique le 12 mars pour ma Polo', TODAY)).toMatchObject({ command: 'CREATE_AGENDA_ITEM' });
    expect(parseCommand('Marque le contrôle technique comme fait', TODAY)).toMatchObject({ command: 'MARK_AGENDA_DONE' });
    expect(parseCommand('Quelle est la date d’achat de la polo ?', TODAY)).toBeNull();
  });

  it('est une commande d’écriture', () => {
    expect(actionKind('UPDATE_ASSET_FIELD')).toBe('write_command');
  });
});

describe('préparation : ancienne → nouvelle valeur, rien d’écrit', () => {
  it('présente le bien, le champ, l’ancienne et la nouvelle valeur', async () => {
    const a = await resolveDraft(parseCommand('mets date d\'achat le 25/05/2021 pour la polo', TODAY)!, input, lookup);
    expect(a).toMatchObject({
      command: 'UPDATE_ASSET_FIELD',
      targets: [{ type: 'asset', id: 12, label: 'Polo' }],
      params: { assetId: 12, section: 'common', field: 'acquisitionDate', value: '2021-05-25', previous: '2019-03-12' },
      preview: 'Modifier « Date d’achat » de Polo : 12 mars 2019 → 25 mai 2021.',
    });
  });

  it('mêmes contrôles que la fiche : contrôle technique dans le passé refusé', async () => {
    const r = await resolveDraft(parseCommand('mets le prochain contrôle technique au 12/03/2024 pour la polo', TODAY)!, input, lookup);
    expect(r).toEqual({ needInfo: 'Le prochain contrôle technique ne peut pas être dans le passé.' });
  });

  it('champ non applicable, valeur manquante, bien inconnu, valeur identique', async () => {
    expect(await resolveDraft(parseCommand('mets le kilométrage à 1000 pour la maison', TODAY)!, input, lookup))
      .toEqual({ needInfo: '« Kilométrage » ne s’applique pas à Maison (Lyon).' });
    expect(await resolveDraft(parseCommand('mets la date d’achat le 25 mai pour la polo', TODAY)!, input, lookup))
      .toMatchObject({ needInfo: expect.stringContaining('Quelle valeur') });
    expect(await resolveDraft(parseCommand('mets la date d’achat le 25/05/2021 pour la clio', TODAY)!, input, lookup))
      .toMatchObject({ needInfo: expect.stringContaining('pas trouvé') });
    expect(await resolveDraft(parseCommand('mets le kilométrage à 80 000 pour la polo', TODAY)!, input, lookup))
      .toMatchObject({ needInfo: expect.stringContaining('vaut déjà') });
  });
});

describe('exécution : par le service de la fiche bien', () => {
  it('l’exécuteur passe par updateAssetDetails et refuse si la valeur a changé depuis', () => {
    const src = read('src/services/verebona-assistant/commands/executors.ts');
    expect(src).toMatch(/UPDATE_ASSET_FIELD[\s\S]*updateAssetDetails/);
    expect(src).toMatch(/modifié entre-temps/);
  });

  it('la route PATCH de la fiche utilise le même service', () => {
    expect(read('src/app/api/assets/[id]/details/[section]/route.ts')).toMatch(/updateAssetDetails/);
  });
});

describe('prochain contrôle technique jamais dans le passé', () => {
  it('refusé s’il change vers une date passée, accepté s’il était déjà enregistré', () => {
    expect(validateDetailChanges({ nextInspection: '2024-01-01' }, {}, TODAY)).toHaveLength(1);
    expect(validateDetailChanges({ nextInspection: TODAY }, {}, TODAY)).toEqual([]);
    expect(validateDetailChanges({ nextInspection: '2024-01-01', insurer: 'X' }, { nextInspection: '2024-01-01' }, TODAY)).toEqual([]);
    expect(validateDetailChanges({ acquisitionDate: '2021-02-30' }, {}, TODAY)).toEqual([{ field: 'acquisitionDate', message: 'Date invalide.' }]);
  });

  it('les écritures automatiques écartent une date passée', () => {
    expect(acceptDetailDate('nextInspection', '2021-04-18', TODAY)).toBeNull();
    expect(acceptDetailDate('nextInspection', '2028-04-18', TODAY)).toBe('2028-04-18');
    expect(acceptDetailDate('acquisitionDate', '2021-04-18', TODAY)).toBe('2021-04-18');
  });
});
