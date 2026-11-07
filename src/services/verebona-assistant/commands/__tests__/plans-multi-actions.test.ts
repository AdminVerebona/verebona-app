/**
 * Plans multi-actions et actions en masse.
 *
 * demande → construction du plan → prévisualisation → confirmation unique →
 * exécution ordonnée → résultats détaillés (SUCCESS / FAILED /
 * SKIPPED_DEPENDENCY / REFUSED), sans retour arrière automatique.
 *
 * #715 (lot 113P) : MARK_AGENDA_DONE / CANCEL_AGENDA_ITEM retirées (plus de
 * statut d'événement) — les actions de test sont des créations ; la
 * résolution « en masse » (« marque toutes les échéances… comme réalisées »)
 * n'existe plus et n'est plus reconnue comme commande.
 */
import { describe, it, expect } from 'vitest';
import { parseCommands } from '../parser';
import { executeActions, planStatusFrom, summarizeResults } from '../plan.service';
import type { PlannedAction } from '../catalog';
import type { Executor } from '../executors';

const TODAY = '2026-09-25';
const act = (id: string, dependsOn: string[] = []): PlannedAction => ({
  actionId: id, command: 'CREATE_AGENDA_ITEM', dependsOn, targets: [], params: { title: `E${id}`, startDate: '2026-11-01', assetIds: [] },
  preview: `Action ${id}.`, effects: [],
});

const executors = (echecs: string[], refus: string[] = []) => {
  const run: Executor = async (a) => {
    if (echecs.includes(a.actionId)) return { actionId: a.actionId, status: 'FAILED', message: 'Validation' };
    if (refus.includes(a.actionId)) return { actionId: a.actionId, status: 'REFUSED', message: 'Droits' };
    return { actionId: a.actionId, status: 'SUCCESS', message: 'ok' };
  };
  return { CREATE_AGENDA_ITEM: run, UPDATE_ASSET_FIELD: run };
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
    // Lot 75J (#419 R08) : l'échec partiel est restitué action par action (ce qui n'a pas été fait).
    expect(summarizeResults(r)).toMatch(/^Plan exécuté : 10 réussie\(s\), 1 en échec, 1 refusée\(s\)\. — /);
    expect(summarizeResults(r).match(/ — /g)).toHaveLength(2);
  });

  it('#715 : « marque toutes les échéances passées … comme réalisées » n’est plus une commande', () => {
    expect(parseCommands('Marque toutes les échéances passées de ma Clio comme réalisées', TODAY)).toBeNull();
    expect(parseCommands('Annule tous les rappels de ma Clio', TODAY)).toBeNull();
  });
});

describe('construction du plan depuis un message', () => {
  it('« et » : indépendantes ; « puis » : dépendante de la précédente', () => {
    const s = parseCommands('Crée un rappel contrôle le 3 novembre pour ma Clio puis ajoute un rappel vidange le 10/12 et mets date d\'achat le 25/05/2021 pour la polo', TODAY)!;
    expect(s.map((x) => [x.draft.command, x.dependsOnPrevious])).toEqual([
      ['CREATE_AGENDA_ITEM', false], ['CREATE_AGENDA_ITEM', true], ['UPDATE_ASSET_FIELD', false],
    ]);
  });

  it('un segment incompris : aucun plan (jamais partiellement proposé)', () => {
    expect(parseCommands('Ajoute un rappel vidange le 10/12 et dis-moi quelque chose', TODAY)?.length).toBe(1);
    // #715 : « marque le ramonage comme fait » n'est plus une commande.
    expect(parseCommands('Ajoute un rappel vidange le 10/12 et marque le ramonage comme fait', TODAY)).toBeNull();
  });
});
