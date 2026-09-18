/**
 * CDC BO IA §15.1, SCR-02, T3-005 — catalogues fermés.
 *
 * Ces listes sont dans le code et l'administrateur y choisit sans pouvoir les
 * étendre. Ces tests portent donc moins sur leur contenu — qui reste à arrêter
 * avec le produit — que sur les propriétés qui les rendent utilisables :
 * pas de doublon, pas de code vide, et des déclencheurs cohérents avec les
 * traitements auxquels ils s'appliquent.
 */
import { describe, it, expect } from 'vitest';
import {
  GUARDRAIL_CATALOG, TRIGGER_CATALOG,
  listGuardrails, listTriggers, guardrailCodes, triggerCodes,
} from '../catalogs';
import { listBatchTreatments, isTreatment } from '../treatments';

describe('intégrité des catalogues', () => {
  it('ne contient aucun code en double', () => {
    expect(guardrailCodes().size).toBe(GUARDRAIL_CATALOG.length);
    expect(triggerCodes().size).toBe(TRIGGER_CATALOG.length);
  });

  it('ne contient aucun code ni libellé vide', () => {
    for (const g of GUARDRAIL_CATALOG) {
      expect(g.code.trim(), g.code).not.toBe('');
      expect(g.label.trim(), g.code).not.toBe('');
      expect(g.description.length, g.code).toBeGreaterThan(20);
    }
    for (const t of TRIGGER_CATALOG) {
      expect(t.code.trim(), t.code).not.toBe('');
      expect(t.label.trim(), t.code).not.toBe('');
    }
  });

  it('ne restreint un garde-fou qu’à des traitements existants', () => {
    for (const g of GUARDRAIL_CATALOG) {
      for (const t of g.treatments ?? []) {
        expect(isTreatment(t), `${g.code} → ${t}`).toBe(true);
      }
    }
  });
});

describe('déclencheurs', () => {
  it("ne vise que des traitements passant par la file globale", () => {
    // Un déclencheur sur T2 ou T5 serait sans effet : ils sont synchrones et
    // hors file (GEN-004). Le proposer dans un écran serait un piège.
    const batch = new Set<string>(listBatchTreatments());
    for (const t of TRIGGER_CATALOG) {
      for (const cible of t.treatments ?? []) {
        expect(batch.has(cible), `${t.code} → ${cible}`).toBe(true);
      }
    }
  });

  it('propose les planifications simples du §15.1, et aucun cron libre', () => {
    const schedules = TRIGGER_CATALOG.filter((t) => t.kind === 'schedule').map((t) => t.code);
    expect(schedules).toContain('schedule_daily');
    expect(schedules).toContain('schedule_weekly');
    expect(schedules).toContain('schedule_monthly');
    // Aucun champ d'expression libre : une expression mal formée ne se
    // découvrirait qu'au moment où le job ne part pas.
    for (const t of TRIGGER_CATALOG) {
      expect(t.code).not.toMatch(/cron|custom|expression/i);
    }
  });

  it('les planifications valent pour tous les traitements batch', () => {
    for (const t of TRIGGER_CATALOG.filter((x) => x.kind === 'schedule')) {
      expect(t.treatments, t.code).toBeUndefined();
    }
  });
});

describe('filtrage par traitement', () => {
  it('ne rend à T1 que ce qui le concerne', () => {
    const codes = listTriggers('T1').map((t) => t.code);
    expect(codes).toContain('source_uploaded');
    expect(codes).toContain('schedule_daily');
    expect(codes).not.toContain('agenda_item_due');
  });

  it("rend les garde-fous universels à tout traitement", () => {
    const pourT2 = listGuardrails('T2').map((g) => g.code);
    expect(pourT2).toContain('daily_cost');
    // La durée d'exécution ne vise que les traitements batch.
    expect(pourT2).not.toContain('execution_duration');
  });

  it('rend tout le catalogue sans filtre', () => {
    expect(listGuardrails()).toHaveLength(GUARDRAIL_CATALOG.length);
    expect(listTriggers()).toHaveLength(TRIGGER_CATALOG.length);
  });
});
