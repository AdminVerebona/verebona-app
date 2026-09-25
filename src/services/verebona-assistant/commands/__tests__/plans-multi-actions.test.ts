/**
 * Plans multi-actions et actions en masse.
 *
 * demande → construction du plan → prévisualisation → confirmation unique →
 * exécution ordonnée → résultats détaillés (SUCCESS / FAILED /
 * SKIPPED_DEPENDENCY / REFUSED), sans retour arrière automatique.
 */
import { describe, it, expect } from 'vitest';
import { parseCommands } from '../parser';
import { executeActions, planStatusFrom, summarizeResults, resolveDraft, MAX_BULK_TARGETS, type CommandLookup } from '../plan.service';
import type { PlannedAction } from '../catalog';
import type { Executor } from '../executors';

const TODAY = '2026-09-25';
const act = (id: string, dependsOn: string[] = []): PlannedAction => ({
  actionId: id, command: 'MARK_AGENDA_DONE', dependsOn, targets: [], params: { agendaItemId: Number(id.replace(/\D/g, '')) || 1 },
  preview: `Action ${id}.`, effects: [],
});

const executors = (echecs: string[], refus: string[] = []) => {
  const run: Executor = async (a) => {
    if (echecs.includes(a.actionId)) return { actionId: a.actionId, status: 'FAILED', message: 'Validation' };
    if (refus.includes(a.actionId)) return { actionId: a.actionId, status: 'REFUSED', message: 'Droits' };
    return { actionId: a.actionId, status: 'SUCCESS', message: 'ok' };
  };
  return { CREATE_AGENDA_ITEM: run, MARK_AGENDA_DONE: run, CANCEL_AGENDA_ITEM: run, UPDATE_ASSET_FIELD: run };
};
const ctx = { accountId: 1, userId: 2 };

describe('dépendances', () => {
  it('A → B → C : B échoue, C n’est pas exécutée ; D indépendante continue', async () => {
    const r = await executeActions([act('A'), act('B', ['A']), act('C', ['B']), act('D')], ctx, executors(['B']));
    expect(r.map((x) => [x.actionId, x.status])).toEqual([
      ['A', 'SUCCESS'], ['B', 'FAILED'], ['C', 'SKIPPED_DEPENDENCY'], ['D', 'SUCCESS'],
    ]);
    expect(planStatusFrom(r)).toBe('PARTIAL');
  });

  it('A réussit : B exécutée', async () => {
    const r = await executeActions([act('A'), act('B', ['A'])], ctx, executors([]));
    expect(r.every((x) => x.status === 'SUCCESS')).toBe(true);
    expect(planStatusFrom(r)).toBe('EXECUTED');
  });

  it('une dépendance sautée propage le saut', async () => {
    const r = await executeActions([act('A'), act('B', ['A']), act('C', ['B'])], ctx, executors(['A']));
    expect(r.map((x) => x.status)).toEqual(['FAILED', 'SKIPPED_DEPENDENCY', 'SKIPPED_DEPENDENCY']);
    expect(planStatusFrom(r)).toBe('FAILED');
  });
});

describe('actions en masse : un résultat par objet', () => {
  it('10 réussies, 1 refusée, 1 en erreur', async () => {
    const lot = Array.from({ length: 12 }, (_, i) => act(`a1.${i + 1}`));
    const r = await executeActions(lot, ctx, executors(['a1.8'], ['a1.4']));
    expect(r.filter((x) => x.status === 'SUCCESS')).toHaveLength(10);
    expect(r.filter((x) => x.status === 'REFUSED')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'FAILED')).toHaveLength(1);
    expect(summarizeResults(r)).toBe('Plan exécuté : 10 réussie(s), 1 en échec, 1 refusée(s).');
  });

  it('résolution : une action par échéance, plafonnée', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, title: `E${i + 1}`, date: '2026-05-01' }));
    const lookup = {
      today: () => TODAY,
      findAssets: async () => [{ id: 890, name: 'Clio', city: null }],
      getAsset: async () => null, findAgendaItems: async () => [], getAgendaItem: async () => null,
      listOpenAgendaItems: async (_a: number, o: { pastOnly: boolean; assetIds: number[] }) => (o.pastOnly && o.assetIds[0] === 890 ? items : []),
    } as CommandLookup;
    const segs = parseCommands('Marque toutes les échéances passées de ma Clio comme réalisées', TODAY)!;
    const r = await resolveDraft(segs[0].draft, { accountId: 1, userId: 2, planType: 'P', message: '', clientRequestId: 'x', locale: 'fr-FR' }, lookup, 'a1');
    expect(Array.isArray(r) && r.map((a) => [a.actionId, (a.params as { agendaItemId: number }).agendaItemId])).toEqual([['a1.1', 1], ['a1.2', 2], ['a1.3', 3]]);
    expect(MAX_BULK_TARGETS).toBe(50);
  });
});

describe('construction du plan depuis un message', () => {
  it('« et » : indépendantes ; « puis » : dépendante de la précédente', () => {
    const s = parseCommands('Crée un rappel contrôle le 3 novembre pour ma Clio puis marque le ramonage comme fait et annule le rappel vidange', TODAY)!;
    expect(s.map((x) => [x.draft.command, x.dependsOnPrevious])).toEqual([
      ['CREATE_AGENDA_ITEM', false], ['MARK_AGENDA_DONE', true], ['CANCEL_AGENDA_ITEM', false],
    ]);
  });

  it('un segment incompris : aucun plan (jamais partiellement proposé)', () => {
    expect(parseCommands('Ajoute un rappel vidange le 10/12 et dis-moi quelque chose', TODAY)?.length).toBe(1);
    expect(parseCommands('Bonjour, et marque le ramonage comme fait', TODAY)).toBeNull();
  });

  it('action en masse reconnue', () => {
    expect(parseCommands('Annule tous les rappels de ma Clio', TODAY)![0].draft).toMatchObject({
      command: 'CANCEL_AGENDA_ITEM', bulk: { scope: 'open', assetWords: ['clio'] },
    });
  });
});
