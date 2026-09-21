/**
 * CDC BO IA SCR-02 à SCR-06 — indicateurs de supervision.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA PROPRIÉTÉ QUI COMPTE : UN CHIFFRE AFFICHÉ EST UN CHIFFRE MESURÉ
 *
 * Certains indicateurs demandés par le CDC supposent une instrumentation qui
 * n'existe pas — les rechecks de l'assistant imputables à une lacune
 * d'extraction, par exemple. Les rendre à zéro les ferait lire comme « aucun
 * problème », ce qui est exactement le contraire de ce qu'on sait.
 *
 * Ces tests vérifient donc la forme et l'honnêteté du rendu, pas les valeurs :
 * celles-ci viennent de la base, qu'un test unitaire n'a pas.
 */
import { describe, it, expect } from 'vitest';
import { getTreatmentMetrics } from '../treatment-metrics.repository';
import { TREATMENTS } from '../treatments';

describe('forme des indicateurs', () => {
  it('rend une réponse pour chacun des cinq traitements', async () => {
    // Sans base, chaque requête échoue : l'écran doit rester utilisable, et la
    // configuration modifiable même quand la supervision est muette.
    for (const t of TREATMENTS) {
      const r = await getTreatmentMetrics(t);
      expect(r.treatment, t).toBe(t);
      expect(Array.isArray(r.metrics), t).toBe(true);
      expect(r.metrics.length, t).toBeGreaterThan(0);
    }
  });

  it('accompagne tout indicateur non mesuré d’une raison', async () => {
    // Une case vide sans explication se redécouvre à chaque fois. La raison dit
    // ce qu'il faudrait instrumenter.
    for (const t of TREATMENTS) {
      const r = await getTreatmentMetrics(t);
      for (const m of r.metrics.filter((x) => x.value === null)) {
        expect(m.missingReason, `${t}/${m.key}`).toBeTruthy();
      }
    }
  });

  it('donne un libellé lisible à chaque indicateur', async () => {
    for (const t of TREATMENTS) {
      const r = await getTreatmentMetrics(t);
      for (const m of r.metrics) {
        expect(m.label.trim(), `${t}/${m.key}`).not.toBe('');
        expect(m.key.trim(), t).not.toBe('');
      }
    }
  });
});

describe('fenêtre d’observation', () => {
  it('vaut trente jours par défaut', async () => {
    expect((await getTreatmentMetrics('T1')).windowDays).toBe(30);
  });

  it('reste bornée', async () => {
    // Le NFR-002 interdit de charger l'historique entier : ces requêtes tournent
    // à chaque ouverture d'onglet.
    expect((await getTreatmentMetrics('T1', 5000)).windowDays).toBe(365);
    expect((await getTreatmentMetrics('T1', 0)).windowDays).toBe(1);
    expect((await getTreatmentMetrics('T1', -12)).windowDays).toBe(1);
  });
});
