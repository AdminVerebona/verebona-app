/**
 * BO IA — tickets T4 (déclencheurs) et T5 (ancien prompt ignoré).
 *
 * T4 : un déclencheur enregistré mais inapplicable (`schedule_hourly`) reste
 * bloquant, actif ou non, et le motif dit comment le corriger ; `source_analyzed`
 * est valide ; la nature doit correspondre au catalogue.
 * T5 : un texte hérité (préambule, master avec {{TASK}}/branches MODE, ancien
 * master incomplet) ne bloque plus ; les vrais contrôles restent bloquants.
 */
import { describe, expect, it } from 'vitest';
import {
  validateTreatment, T5_LEGACY_TEXT_MESSAGE, type ConfigCatalogs,
} from '../config-validation.service';
import { emptyTreatmentConfig, normalizeTreatmentConfig, type TreatmentConfig } from '../config-types';
import { triggerCodes, triggerIncompatibility, listTriggers } from '../catalogs';
import { changedConfigFields } from '../config-entry.audit';
import { activeTriggerCodes } from '../../queue/triggers';

const cat: ConfigCatalogs = {
  availableModels: new Set(['m']),
  pricedModels: new Set(['m']),
  guardrailCodes: new Set(),
  triggerCodes: triggerCodes(),
};

const conf = (over: Partial<TreatmentConfig>): TreatmentConfig => ({
  ...emptyTreatmentConfig(over.treatment ?? 'T4'),
  prompt: 'un prompt', primaryModel: 'm', reasoningPrimary: 'standard', maxOutputTokens: 1000,
  ...over,
});
const bloquants = (c: TreatmentConfig) => validateTreatment(c, cat).filter((i) => i.blocking);

describe('T4 — déclencheurs', () => {
  it('source_analyzed est proposé pour T4, avec son texte d’aide', () => {
    const t = listTriggers('T4').find((d) => d.code === 'source_analyzed');
    expect(t?.label).toBe('Analyse de source terminée');
    expect(t?.help?.T4).toMatch(/effet sur l’agenda/);
    expect(listTriggers('T4').some((d) => d.code === 'schedule_hourly')).toBe(false);
  });

  it('configuration cible : source_analyzed actif seul → aucun blocage déclencheur', () => {
    const c = conf({ triggers: [{ kind: 'event', code: 'source_analyzed', active: true }] });
    expect(bloquants(c).filter((i) => i.field === 'triggers')).toEqual([]);
  });

  it('schedule_hourly enregistré, même INACTIF, reste bloquant avec un motif corrigeable', () => {
    for (const active of [true, false]) {
      const c = conf({ triggers: [
        { kind: 'event', code: 'source_analyzed', active: true },
        { kind: 'schedule', code: 'schedule_hourly', active },
      ] });
      const t = bloquants(c).filter((i) => i.field === 'triggers');
      expect(t).toHaveLength(1);
      expect(t[0].message).toMatch(/ne s'applique pas à T4 : supprimez-le de la configuration/);
      expect(t[0].message).toMatch(/la désactivation ne suffit pas/);
    }
  });

  it('refuse une nature différente du catalogue et un doublon', () => {
    expect(bloquants(conf({ triggers: [{ kind: 'schedule', code: 'source_analyzed', active: true }] }))
      .some((i) => /nature « schedule » au lieu de « event »/.test(i.message))).toBe(true);
    expect(bloquants(conf({ triggers: [
      { kind: 'event', code: 'source_analyzed', active: true },
      { kind: 'event', code: 'source_analyzed', active: false },
    ] })).some((i) => /déclaré deux fois/.test(i.message))).toBe(true);
  });

  it('non-régression T1/T3 : la planification horaire reste applicable', () => {
    expect(triggerIncompatibility('schedule_hourly', 'T1', true)).toBeNull();
    expect(triggerIncompatibility('schedule_hourly', 'T3', true)).toBeNull();
    expect(triggerIncompatibility('schedule_hourly', 'T4', true)?.reason).toBe('not_applicable');
    expect(triggerIncompatibility('source_analyzed', 'T2', false)?.reason).toBe('synchronous');
  });

  it('effet runtime : actif → parcours T4 ; explicitement inactif → aucun ; liste vide → défaut', () => {
    expect(activeTriggerCodes('T4', [{ kind: 'event', code: 'source_analyzed', active: true }]).has('source_analyzed')).toBe(true);
    expect(activeTriggerCodes('T4', [{ kind: 'event', code: 'source_analyzed', active: false }]).has('source_analyzed')).toBe(false);
    expect(activeTriggerCodes('T4', []).has('source_analyzed')).toBe(true);
  });
});

describe('T5 — ancien prompt ignoré', () => {
  const t5 = (over: Partial<TreatmentConfig>) => conf({ treatment: 'T5', prompt: '', triggers: [], ...over });

  it('un ancien texte ordinaire ne bloque pas : information seulement', () => {
    const issues = validateTreatment(t5({ prompt: 'ancien préambule' }), cat);
    expect(issues.filter((i) => i.blocking)).toEqual([]);
    expect(issues.find((i) => i.field === 'prompt')?.message).toBe(T5_LEGACY_TEXT_MESSAGE);
  });

  it('un master collé dans le préambule ({{TASK}}, BRANCHE MODE =) ne bloque plus', () => {
    const issues = validateTreatment(t5({ prompt: 'BRANCHE MODE = A\n{{TASK}}\n{{MODE}}' }), cat);
    expect(issues.filter((i) => i.blocking)).toEqual([]);
    expect(issues.some((i) => /zone dédiée/.test(i.message))).toBe(false);
  });

  it('un ancien masterPrompt incomplet est ignoré', () => {
    const issues = validateTreatment(t5({ masterPrompt: 'master incomplet {{TASK}}' }), cat);
    expect(issues.filter((i) => i.blocking)).toEqual([]);
    expect(issues.some((i) => i.message === T5_LEGACY_TEXT_MESSAGE)).toBe(true);
  });

  it('une autre erreur réelle reste bloquante (modèle inconnu)', () => {
    expect(bloquants(t5({ prompt: 'ancien', primaryModel: 'inconnu' })).some((i) => i.field === 'primaryModel')).toBe(true);
  });

  it('normalisation à l’enregistrement : prompt "" et masterPrompt null, idempotente', () => {
    const n = normalizeTreatmentConfig(t5({ prompt: 'x', masterPrompt: 'y', maxOutputTokens: 777 }));
    expect(n).toMatchObject({ prompt: '', masterPrompt: null, maxOutputTokens: 777 });
    expect(normalizeTreatmentConfig(n)).toEqual(n);
    expect(validateTreatment(n, cat).some((i) => i.message === T5_LEGACY_TEXT_MESSAGE)).toBe(false);
  });

  it('traitement administrable : un ancien préambule (plus éditable ni appliqué) est signalé sans bloquer', () => {
    const issues = validateTreatment(conf({ treatment: 'T1', prompt: 'BRANCHE TASK = X {{TASK}}', triggers: [{ kind: 'event', code: 'source_uploaded', active: true }] }), cat);
    const p = issues.find((i) => /zone dédiée/.test(i.message));
    expect(p?.blocking).toBe(false);
  });

  it('non-régression : un texte master administrable incomplet reste bloquant', () => {
    const issues = bloquants(conf({ treatment: 'T1', masterPrompt: 'incomplet', triggers: [{ kind: 'event', code: 'source_uploaded', active: true }] }));
    expect(issues.some((i) => i.field === 'masterPrompt')).toBe(true);
  });
});

describe('trace d’enregistrement', () => {
  it('ne retient que les champs modifiés ; seconde sauvegarde = rien', () => {
    const avant = conf({ triggers: [{ kind: 'schedule', code: 'schedule_hourly', active: true }] });
    const apres = { ...avant, triggers: [{ kind: 'event' as const, code: 'source_analyzed', active: true }] };
    const d = changedConfigFields(avant, apres);
    expect(Object.keys(d.after)).toEqual(['triggers']);
    expect(Object.keys(changedConfigFields(apres, apres).after)).toEqual([]);
  });
});
