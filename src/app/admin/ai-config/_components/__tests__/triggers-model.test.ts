import { describe, expect, it } from 'vitest';
import {
  splitTriggers, selectTrigger, setTriggerActive, removeTrigger, emptyListExplanation, removalEmptiesWarning, type CatalogTrigger,
} from '../triggers-model';

const catalog: CatalogTrigger[] = [
  { code: 'schedule_hourly', label: 'Toutes les heures', kind: 'schedule', treatments: ['T1', 'T3'], retired: false },
  { code: 'source_analyzed', label: 'Analyse de source terminée', kind: 'event', treatments: ['T3', 'T4'], retired: false },
];
const applicable = [{ code: 'source_analyzed', label: 'Analyse de source terminée', kind: 'event' as const, help: 'aide' }];

describe('déclencheurs du BO — rien d’enregistré n’est invisible', () => {
  it('cas constaté : schedule_hourly listé comme incompatible avec son motif', () => {
    const r = splitTriggers({
      treatment: 'T4', batch: true, applicable, catalog,
      saved: [{ kind: 'schedule', code: 'schedule_hourly', active: false }],
    });
    expect(r.available.map((a) => [a.def.code, a.setting])).toEqual([['source_analyzed', null]]);
    expect(r.incompatible).toEqual([{
      setting: { kind: 'schedule', code: 'schedule_hourly', active: false },
      label: 'Toutes les heures',
      reason: 'Ce déclencheur est enregistré dans cette configuration mais ne s’applique pas à T4.',
    }]);
  });

  it('sélectionner, désactiver, supprimer : trois effets distincts', () => {
    let l = removeTrigger([{ kind: 'schedule', code: 'schedule_hourly', active: true }], 'schedule_hourly');
    l = selectTrigger(l, applicable[0]);
    expect(l).toEqual([{ kind: 'event', code: 'source_analyzed', active: true }]);
    expect(selectTrigger(l, applicable[0])).toBe(l);
    expect(setTriggerActive(l, 'source_analyzed', false)).toEqual([{ kind: 'event', code: 'source_analyzed', active: false }]);
    expect(removeTrigger(l, 'source_analyzed')).toEqual([]);
  });

  it('traitement synchrone : une entrée héritée reste visible et supprimable', () => {
    const r = splitTriggers({ treatment: 'T2', batch: false, applicable: [], catalog, saved: [{ kind: 'event', code: 'source_analyzed', active: true }] });
    expect(r.available).toEqual([]);
    expect(r.incompatible).toHaveLength(1);
  });

  it('liste vide : expliquée comme les défauts du code, pas comme « aucune exécution »', () => {
    expect(emptyListExplanation(['source_analyzed'], catalog)).toMatch(/par défaut du code s’appliquent \(Analyse de source terminée\)/);
    expect(emptyListExplanation(['source_analyzed'], catalog)).toMatch(/ne désactive pas/);
  });
});

describe('supprimer la dernière entrée : prévenu que les défauts s’appliqueront', () => {
  const hourly = { kind: 'schedule' as const, code: 'schedule_hourly', active: false };
  const src = { kind: 'event' as const, code: 'source_analyzed', active: true };
  it('dernière entrée (T4, schedule_hourly seul) : avertissement nommant source_analyzed', () => {
    const w = removalEmptiesWarning([hourly], 'schedule_hourly', ['source_analyzed'], catalog);
    expect(w).toMatch(/déclencheurs par défaut du code s’appliqueront \(Analyse de source terminée\)/);
  });
  it('liste non vidée, ou aucun défaut : rien', () => {
    expect(removalEmptiesWarning([hourly, src], 'schedule_hourly', ['source_analyzed'], catalog)).toBeNull();
    expect(removalEmptiesWarning([hourly], 'schedule_hourly', [], catalog)).toBeNull();
  });
  it('affiché dans l’éditeur, sur « Supprimer de la configuration » comme sur « Retirer »', async () => {
    const { readFileSync } = await import('node:fs');
    const ed = readFileSync('src/app/admin/ai-config/_components/TriggersEditor.tsx', 'utf8');
    expect(ed).toContain('removalEmptiesWarning(saved, code, defaults, catalog)');
    expect(ed.match(/videLaListe\((def|setting)\.code\)/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
