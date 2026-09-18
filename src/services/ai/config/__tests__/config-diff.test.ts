/**
 * CDC BO IA VER-003, WF-02 — diff complet avant promotion.
 *
 * Le diff conditionne la promotion : c'est sur lui que l'administrateur décide.
 * Un diff qui tait une modification, ou qui en signale une qui n'a pas eu lieu,
 * fait prendre la décision sur une image fausse.
 */
import { describe, it, expect } from 'vitest';
import { diffVersions, diffTreatment, renderDiff } from '../config-diff.service';
import { emptyTreatmentConfig, type TreatmentConfig } from '../config-types';

function config(over: Partial<TreatmentConfig> = {}): TreatmentConfig {
  return { ...emptyTreatmentConfig('T1'), prompt: 'base', primaryModel: 'm1', ...over };
}

describe('champs scalaires', () => {
  it('ne signale rien quand rien ne bouge', () => {
    const d = diffTreatment(config(), config());
    expect(d.changes).toEqual([]);
  });

  it('distingue ajout, retrait et modification', () => {
    const avant = config({ fallback1: 'm2', maxOutputTokens: 500 });
    const apres = config({ fallback1: null, fallback2: 'm3', maxOutputTokens: 800 });
    const kinds = Object.fromEntries(diffTreatment(avant, apres).changes.map((c) => [c.field, c.kind]));

    expect(kinds.fallback1).toBe('removed');
    expect(kinds.fallback2).toBe('added');
    expect(kinds.maxOutputTokens).toBe('modified');
  });

  it('traite la chaîne vide comme une absence', () => {
    // Un prompt vidé est un retrait, pas une modification vers « rien » :
    // l'administrateur doit voir qu'il ne reste plus de prompt.
    const d = diffTreatment(config({ prompt: 'texte' }), config({ prompt: '' }));
    expect(d.changes[0].kind).toBe('removed');
    expect(d.changes[0].after).toBeNull();
  });
});

describe('listes comparées par code, pas par position', () => {
  const g = (code: string, threshold = 10) => ({ code, threshold, reaction: 'alerte' as const });

  it('ignore un simple réordonnancement', () => {
    // Le piège : comparer par sérialisation signalerait une modification à
    // chaque fois qu'un écran réordonne l'affichage, et noierait le vrai
    // changement dans le bruit.
    const avant = config({ guardrails: [g('a'), g('b')] });
    const apres = config({ guardrails: [g('b'), g('a')] });
    expect(diffTreatment(avant, apres).changes).toEqual([]);
  });

  it('nomme le garde-fou concerné dans le libellé', () => {
    const d = diffTreatment(config({ guardrails: [g('cout', 10)] }), config({ guardrails: [g('cout', 20)] }));
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0].label).toContain('cout');
    expect(d.changes[0].kind).toBe('modified');
  });

  it('repère un ajout et un retrait dans la même liste', () => {
    const d = diffTreatment(config({ guardrails: [g('a')] }), config({ guardrails: [g('b')] }));
    const kinds = d.changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(['added', 'removed']);
  });

  it("voit qu'un déclencheur a été désactivé", () => {
    const actif = { kind: 'event' as const, code: 'depot', active: true };
    const d = diffTreatment(
      config({ triggers: [actif] }),
      config({ triggers: [{ ...actif, active: false }] }),
    );
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0].after).toContain('inactif');
  });
});

describe('diff de version entière', () => {
  const cinq = (): TreatmentConfig[] =>
    (['T1', 'T2', 'T3', 'T4', 'T5'] as const).map((t) => ({ ...emptyTreatmentConfig(t), prompt: 'p' }));

  it('conclut à l’identité quand rien n’a changé', () => {
    const d = diffVersions(cinq(), cinq());
    expect(d.identical).toBe(true);
    expect(d.changeCount).toBe(0);
    expect(d.treatments).toEqual([]);
  });

  it('ne retient que les traitements modifiés', () => {
    const apres = cinq().map((e) => (e.treatment === 'T3' ? { ...e, prompt: 'neuf' } : e));
    const d = diffVersions(cinq(), apres);
    expect(d.treatments.map((t) => t.treatment)).toEqual(['T3']);
    expect(d.identical).toBe(false);
  });

  it('rend visible un traitement absent au lieu de le taire', () => {
    // Une version à laquelle il manque un traitement est un défaut : le GEN-002
    // veut un instantané des cinq. Le diff doit le montrer.
    const apres = cinq().filter((e) => e.treatment !== 'T4');
    const d = diffVersions(cinq(), apres);
    expect(d.treatments.map((t) => t.treatment)).toContain('T4');
  });
});

describe('rendu texte', () => {
  it('annonce clairement une absence de modification', () => {
    expect(renderDiff(diffVersions([], []))).toBe('Aucune modification.');
  });

  it('marque chaque changement de son signe', () => {
    const texte = renderDiff(diffVersions(
      [{ ...emptyTreatmentConfig('T1'), prompt: 'a' }],
      [{ ...emptyTreatmentConfig('T1'), prompt: 'b' }],
    ));
    expect(texte).toContain('── T1 ──');
    expect(texte).toContain('~');
  });
});
