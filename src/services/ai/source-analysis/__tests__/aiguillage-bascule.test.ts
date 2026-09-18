/**
 * CDC §10.4 — interdiction du double fonctionnement.
 *
 * « Une feature flag active le nouveau moteur À LA PLACE de l'ancien. Elle ne
 *   doit pas déclencher les deux chaînes sur les mêmes objets, sauf mode shadow
 *   sans écriture. »
 *
 * L'émetteur déclenchait tous les abonnés dès que l'UN des deux drapeaux était
 * actif. Ces tests verrouillent la propriété inverse : chaque abonné n'est
 * exécuté que si SON drapeau l'autorise. C'est la seule forme qui tienne quand
 * les cinq drapeaux basculent indépendamment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  emitSourceAnalyzed, onSourceAnalyzed, clearSourceAnalyzedHandlers,
  type SourceAnalyzedEvent,
} from '../events';

const evenement = {
  accountId: 1, userId: 2, assetId: 7, leadSourceId: 42,
  result: { agendaCandidates: [] },
} as unknown as SourceAnalyzedEvent;

function modes(reconciliation: string, agenda: string) {
  process.env.AI_RECONCILIATION_ENGINE = reconciliation;
  process.env.AI_AGENDA_ENGINE = agenda;
}

beforeEach(() => {
  clearSourceAnalyzedHandlers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSourceAnalyzedHandlers();
});

describe("un abonné n'est exécuté que si son propre drapeau l'autorise", () => {
  it("n'exécute pas la réconciliation quand seul l'agenda est basculé", async () => {
    // Le cas qui échouait : `AI_AGENDA_ENGINE=enabled` suffisait à déclencher
    // TOUS les abonnés, donc des appels modèle de réconciliation que personne
    // n'avait demandés — pendant que le pont vers l'ancien moteur tournait.
    modes('legacy', 'enabled');
    const reconciliation = vi.fn(async () => {});
    const agenda = vi.fn(async () => {});
    onSourceAnalyzed('AI_RECONCILIATION_ENGINE', reconciliation);
    onSourceAnalyzed('AI_AGENDA_ENGINE', agenda);

    await emitSourceAnalyzed(evenement);

    expect(reconciliation).not.toHaveBeenCalled();
    expect(agenda).toHaveBeenCalledTimes(1);
  });

  it("n'exécute pas l'agenda quand seule la réconciliation est basculée", async () => {
    // Cas symétrique, plus grave : l'abonné agenda écrivait ses décisions.
    modes('enabled', 'legacy');
    const reconciliation = vi.fn(async () => {});
    const agenda = vi.fn(async () => {});
    onSourceAnalyzed('AI_RECONCILIATION_ENGINE', reconciliation);
    onSourceAnalyzed('AI_AGENDA_ENGINE', agenda);

    await emitSourceAnalyzed(evenement);

    expect(reconciliation).toHaveBeenCalledTimes(1);
    expect(agenda).not.toHaveBeenCalled();
  });

  it("n'exécute rien quand les deux drapeaux valent legacy", async () => {
    modes('legacy', 'legacy');
    const abonne = vi.fn(async () => {});
    onSourceAnalyzed('AI_RECONCILIATION_ENGINE', abonne);
    onSourceAnalyzed('AI_AGENDA_ENGINE', abonne);

    await emitSourceAnalyzed(evenement);

    expect(abonne).not.toHaveBeenCalled();
  });

  it('exécute les deux quand les deux sont basculés', async () => {
    modes('enabled', 'enabled');
    const reconciliation = vi.fn(async () => {});
    const agenda = vi.fn(async () => {});
    onSourceAnalyzed('AI_RECONCILIATION_ENGINE', reconciliation);
    onSourceAnalyzed('AI_AGENDA_ENGINE', agenda);

    await emitSourceAnalyzed(evenement);

    expect(reconciliation).toHaveBeenCalledTimes(1);
    expect(agenda).toHaveBeenCalledTimes(1);
  });

  it('exécute un abonné en mode observation — il décide sans écrire (§10.2)', async () => {
    modes('shadow', 'legacy');
    const reconciliation = vi.fn(async () => {});
    onSourceAnalyzed('AI_RECONCILIATION_ENGINE', reconciliation);

    await emitSourceAnalyzed(evenement);

    expect(reconciliation).toHaveBeenCalledTimes(1);
  });
});

describe("robustesse de l'émission (§11.4)", () => {
  it("un abonné en échec n'empêche pas les autres ni ne fait échouer l'analyse", async () => {
    modes('enabled', 'enabled');
    const suivant = vi.fn(async () => {});
    onSourceAnalyzed('AI_RECONCILIATION_ENGINE', async () => { throw new Error('boum'); });
    onSourceAnalyzed('AI_AGENDA_ENGINE', suivant);

    await expect(emitSourceAnalyzed(evenement)).resolves.toBeUndefined();
    expect(suivant).toHaveBeenCalledTimes(1);
  });
});
