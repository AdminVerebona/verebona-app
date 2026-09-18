/**
 * CDC BO IA MOD-007 à MOD-014, WF-09 — disjoncteur et reprise.
 *
 * Ces règles décident quand un traitement s'arrête et quand il repart seul. Une
 * erreur dans un sens laisse tourner un traitement en panne ; dans l'autre, elle
 * garde un service éteint alors que le fournisseur est revenu.
 */
import { describe, it, expect } from 'vitest';
import {
  recordModelOutcome, alertingModels, shouldOpen, nextProbeDelay,
  probeOrder, applyProbeResults, forceReactivation, FAILURE_ALERT_THRESHOLD,
} from '../circuit-breaker';

describe('compteurs par modèle (MOD-007, MOD-008)', () => {
  it('incrémente à chaque échec', () => {
    let f = {};
    f = recordModelOutcome(f, 'm1', false);
    f = recordModelOutcome(f, 'm1', false);
    expect(f).toEqual({ m1: 2 });
  });

  it('remet à zéro sur un succès', () => {
    const f = recordModelOutcome({ m1: 7 }, 'm1', true);
    expect(f).toEqual({});
  });

  it("ne remet à zéro que le modèle concerné (MOD-014)", () => {
    // Remettre les autres à zéro masquerait une panne partielle : le repli
    // fonctionne, on croirait le principal rétabli.
    const f = recordModelOutcome({ m1: 9, m2: 3 }, 'm2', true);
    expect(f).toEqual({ m1: 9 });
  });

  it('alerte au seuil, pas avant', () => {
    expect(alertingModels({ m1: FAILURE_ALERT_THRESHOLD - 1 })).toEqual([]);
    expect(alertingModels({ m1: FAILURE_ALERT_THRESHOLD })).toEqual(['m1']);
  });

  it('alerte sur plusieurs modèles indépendamment', () => {
    expect(alertingModels({ m2: 12, m1: 10, m3: 2 })).toEqual(['m1', 'm2']);
  });
});

describe("ouverture du disjoncteur (MOD-003, WF-09)", () => {
  it("n'ouvre pas quand un repli a sauvé la demande", () => {
    // Ouvrir sur un échec du principal suspendrait un traitement qui
    // fonctionne, simplement moins bien.
    expect(shouldOpen(false)).toBe(false);
  });

  it("ouvre sur un échec complet de la chaîne", () => {
    expect(shouldOpen(true)).toBe(true);
  });
});

describe('planning des sondes (WF-09)', () => {
  it('commence rapproché', () => {
    // Une panne fournisseur dure souvent quelques minutes : attendre un quart
    // d'heure pour la première sonde laisserait le service éteint pour rien.
    expect(nextProbeDelay(0)).toBeLessThanOrEqual(60);
  });

  it("s'espace ensuite", () => {
    expect(nextProbeDelay(3)).toBeGreaterThan(nextProbeDelay(1));
  });

  it('reste plafonné', () => {
    // Sans plafond, un incident long repousserait la reprise bien après le
    // retour à la normale.
    expect(nextProbeDelay(50)).toBe(nextProbeDelay(10));
    expect(nextProbeDelay(50)).toBeLessThanOrEqual(900);
  });
});

describe('ordre de sondage (MOD-002)', () => {
  it('commence toujours par le principal', () => {
    // Sonder d'abord le repli qui marchait rendrait le repli collant par la
    // porte de derrière, alors que MOD-002 l'interdit.
    expect(probeOrder('p', 'f1', 'f2')).toEqual(['p', 'f1', 'f2']);
  });

  it('ignore les replis non configurés', () => {
    expect(probeOrder('p', null, null)).toEqual(['p']);
    expect(probeOrder('p', null, 'f2')).toEqual(['p', 'f2']);
  });
});

describe('résultat d’une campagne de sondes', () => {
  it('réactive au premier succès et s’arrête là', () => {
    const r = applyProbeResults({ p: 12, f1: 4 }, [
      { model: 'p', succeeded: false },
      { model: 'f1', succeeded: true },
      { model: 'f2', succeeded: false },
    ]);
    expect(r.reactivate).toBe(true);
    expect(r.recoveredWith).toBe('f1');
    // f2 n'a pas été sondé : son compteur est intact.
    expect(r.failures.f2).toBeUndefined();
  });

  it("n'efface que le compteur du modèle qui a réussi", () => {
    const r = applyProbeResults({ p: 12 }, [
      { model: 'p', succeeded: false },
      { model: 'f1', succeeded: true },
    ]);
    expect(r.failures.p).toBe(13);
    expect(r.failures.f1).toBeUndefined();
  });

  it('ne réactive pas quand tous échouent', () => {
    const r = applyProbeResults({}, [
      { model: 'p', succeeded: false },
      { model: 'f1', succeeded: false },
    ]);
    expect(r.reactivate).toBe(false);
    expect(r.recoveredWith).toBeNull();
    expect(r.failures).toEqual({ p: 1, f1: 1 });
  });
});

describe('réactivation forcée (WF-09, exceptions)', () => {
  it('conserve les alertes modèles', () => {
    // Un administrateur peut décider de rouvrir le service ; il ne peut pas
    // décider qu'un modèle va bien. Effacer les compteurs ferait disparaître
    // l'alerte sans que rien n'ait été vérifié.
    expect(forceReactivation({ p: 14, f1: 10 })).toEqual({ p: 14, f1: 10 });
  });
});
