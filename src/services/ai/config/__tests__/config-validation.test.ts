/**
 * CDC BO IA VER-003, WF-02 — contrôles bloquants avant promotion.
 *
 * « Échec de validation : aucune transition d'état. » Ces contrôles décident
 * donc si une configuration peut atteindre la préproduction, puis la
 * production. Un contrôle trop laxiste laisse passer une version qui cassera au
 * démarrage ; un contrôle trop strict bloque un administrateur sans recours.
 */
import { describe, it, expect } from 'vitest';
import {
  validateTreatment, validateVersion, unavailableModels, type ConfigCatalogs,
} from '../config-validation.service';
import { TREATMENTS } from '../treatments';
import { emptyTreatmentConfig, type TreatmentConfig } from '../config-types';

const catalogues = (over: Partial<ConfigCatalogs> = {}): ConfigCatalogs => ({
  availableModels: new Set(['m-principal', 'm-repli', 'm-repli-2', 'm-pro']),
  pricedModels: new Set(['m-principal', 'm-repli', 'm-repli-2', 'm-pro']),
  guardrailCodes: new Set(['cout', 'echecs']),
  triggerCodes: new Set(['depot', 'quotidien']),
  ...over,
});

function valide(over: Partial<TreatmentConfig> = {}): TreatmentConfig {
  return {
    ...emptyTreatmentConfig('T1'),
    prompt: 'un prompt',
    primaryModel: 'm-principal',
    reasoningPrimary: 'standard',
    maxOutputTokens: 1000,
    triggers: [{ kind: 'event', code: 'depot', active: true }],
    ...over,
  };
}

const bloquants = (c: TreatmentConfig, cat = catalogues()) =>
  validateTreatment(c, cat).filter((i) => i.blocking);

describe('une configuration complète passe', () => {
  it('ne produit aucune issue bloquante', () => {
    expect(bloquants(valide())).toEqual([]);
  });
});

describe('champs obligatoires', () => {
  it('refuse un prompt vide ou blanc', () => {
    expect(bloquants(valide({ prompt: '' }))).toHaveLength(1);
    expect(bloquants(valide({ prompt: '   ' }))).toHaveLength(1);
  });

  it('refuse un modèle principal absent', () => {
    const issues = bloquants(valide({ primaryModel: null, reasoningPrimary: null }));
    expect(issues.some((i) => i.field === 'primaryModel')).toBe(true);
  });

  it('refuse un max output tokens absent ou invalide', () => {
    expect(bloquants(valide({ maxOutputTokens: null }))).toHaveLength(1);
    expect(bloquants(valide({ maxOutputTokens: 0 }))).toHaveLength(1);
    expect(bloquants(valide({ maxOutputTokens: 1.5 }))).toHaveLength(1);
  });
});

describe('T5 — pas de prompt administrable (T5-003, E-02)', () => {
  it("n'exige pas de prompt pour T5", () => {
    expect(bloquants(valide({ treatment: 'T5', prompt: '', triggers: [] }))).toEqual([]);
  });

  it('signale sans bloquer un prompt T5 hérité d’une ancienne version', () => {
    const issues = validateTreatment(valide({ treatment: 'T5', prompt: 'ancien texte', triggers: [] }), catalogues());
    const prompt = issues.find((i) => i.field === 'prompt');
    expect(prompt?.blocking).toBe(false);
    expect(prompt?.message).toMatch(/pas administrable/);
  });

  it('exige toujours le prompt de T1 à T4', () => {
    for (const t of ['T1', 'T2', 'T3', 'T4'] as const) {
      expect(bloquants(valide({ treatment: t, prompt: '', triggers: [] })).some((i) => i.field === 'prompt'), t).toBe(true);
    }
  });

  it('accepte une version complète dont T5 n’a pas de prompt', () => {
    const entries = TREATMENTS.map((t) => valide({
      treatment: t,
      prompt: t === 'T5' ? '' : 'un prompt',
      triggers: t === 'T2' || t === 'T5' ? [] : valide().triggers,
    }));
    expect(validateVersion(entries, catalogues()).valid).toBe(true);
  });
});

describe('modèles', () => {
  it('refuse un modèle absent du catalogue fournisseur', () => {
    // Le cas vécu : un modèle retiré du jour au lendemain par le fournisseur.
    const issues = bloquants(valide({ primaryModel: 'disparu' }));
    expect(issues[0].message).toContain('catalogue fournisseur');
  });

  it('refuse un modèle sans tarif connu', () => {
    // `assertPricingReady` refuserait le démarrage en production. Mieux vaut
    // bloquer la promotion que découvrir la panne après l'import.
    const cat = catalogues({ pricedModels: new Set(['m-repli']) });
    const issues = bloquants(valide(), cat);
    expect(issues.some((i) => i.message.includes('tarif'))).toBe(true);
  });

  it('distingue les deux causes, qui appellent deux gestes différents', () => {
    const cat = catalogues({ availableModels: new Set(['m-principal']), pricedModels: new Set() });
    const messages = bloquants(valide(), cat).map((i) => i.message);
    expect(messages.some((m) => m.includes('tarif'))).toBe(true);
    expect(messages.some((m) => m.includes('catalogue fournisseur'))).toBe(false);
  });

  it('refuse un repli identique au principal', () => {
    // Un repli identique ne protège de rien : si le principal échoue
    // techniquement, le même modèle échouera pareillement.
    const issues = bloquants(valide({ fallback1: 'm-principal', reasoningFallback1: 'standard' }));
    expect(issues.some((i) => i.field === 'fallback1')).toBe(true);
  });

  it('refuse deux replis identiques entre eux', () => {
    const issues = bloquants(valide({
      fallback1: 'm-repli', fallback2: 'm-repli',
      reasoningFallback1: 'standard', reasoningFallback2: 'standard',
    }));
    expect(issues.some((i) => i.field === 'fallback2')).toBe(true);
  });

  it("interdit un modèle Pro sur l'assistant, et lui seul", () => {
    const surT2 = bloquants({ ...valide({ treatment: 'T2', triggers: [] }), primaryModel: 'm-pro' });
    expect(surT2.some((i) => i.message.includes('Pro'))).toBe(true);

    const surT1 = bloquants(valide({ primaryModel: 'm-pro' }));
    expect(surT1.some((i) => i.message.includes('Pro'))).toBe(false);
  });
});

describe('niveaux de raisonnement', () => {
  it('exige celui du modèle principal', () => {
    expect(bloquants(valide({ reasoningPrimary: null }))).toHaveLength(1);
  });

  it('refuse un niveau inconnu', () => {
    const issues = bloquants(valide({ reasoningPrimary: 'turbo' as never }));
    expect(issues[0].message).toContain('inconnu');
  });

  it('signale sans bloquer un niveau orphelin', () => {
    // Reste d'édition : il ne s'appliquera jamais. Le signaler évite de croire
    // qu'il agit ; le bloquer serait disproportionné.
    const toutes = validateTreatment(valide({ reasoningFallback1: 'standard' }), catalogues());
    const orpheline = toutes.find((i) => i.field === 'reasoningFallback1');
    expect(orpheline?.blocking).toBe(false);
  });
});

describe('garde-fous', () => {
  it('refuse un code hors catalogue', () => {
    const issues = bloquants(valide({ guardrails: [{ code: 'invente', threshold: 1, reaction: 'alerte' }] }));
    expect(issues[0].message).toContain('inconnu du catalogue');
  });

  it('refuse un seuil manquant ou une réaction inconnue', () => {
    expect(bloquants(valide({
      guardrails: [{ code: 'cout', threshold: NaN, reaction: 'alerte' }],
    }))).toHaveLength(1);

    expect(bloquants(valide({
      guardrails: [{ code: 'cout', threshold: 1, reaction: 'ignorer' as never }],
    }))).toHaveLength(1);
  });

  it('refuse un doublon', () => {
    const g = { code: 'cout', threshold: 1, reaction: 'alerte' as const };
    expect(bloquants(valide({ guardrails: [g, g] }))).toHaveLength(1);
  });
});

describe('déclencheurs', () => {
  it("refuse un déclencheur sur un traitement synchrone", () => {
    // T2 et T5 sont hors file globale : un déclencheur y serait sans effet, et
    // le laisser donnerait à croire qu'il agit.
    const issues = bloquants(valide({
      treatment: 'T2', triggers: [{ kind: 'event', code: 'depot', active: true }],
    }));
    expect(issues[0].message).toContain('synchrone');
  });

  it('refuse un code hors catalogue', () => {
    const issues = bloquants(valide({ triggers: [{ kind: 'event', code: 'invente', active: true }] }));
    expect(issues[0].message).toContain('inconnu du catalogue');
  });

  it("signale l'absence de déclencheur actif, sans bloquer par défaut", () => {
    // Point resté ouvert : une version sans déclencheur décrit un traitement
    // qui ne part que manuellement — cohérent, mais souvent un oubli.
    const toutes = validateTreatment(valide({ triggers: [] }), catalogues());
    const issue = toutes.find((i) => i.field === 'triggers');
    expect(issue).toBeDefined();
    expect(issue?.blocking).toBe(false);
  });

  it('bloque quand l’arbitrage le demande', () => {
    const cat = catalogues({ requireActiveTrigger: true });
    expect(bloquants(valide({ triggers: [] }), cat)).toHaveLength(1);
  });
});

describe('version entière', () => {
  const cinq = () => TREATMENTS.map((t) => valide({ treatment: t, triggers: t === 'T2' || t === 'T5' ? [] : valide().triggers }));

  it('accepte une version complète et cohérente', () => {
    expect(validateVersion(cinq(), catalogues()).valid).toBe(true);
  });

  it('refuse une version à laquelle il manque un traitement', () => {
    // Le GEN-002 veut un instantané des cinq. Une version incomplète laisserait
    // deux traitements sur l'ancienne configuration sans que rien ne le dise.
    const r = validateVersion(cinq().filter((e) => e.treatment !== 'T4'), catalogues());
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.treatment === 'T4' && i.message.includes('absente'))).toBe(true);
  });

  it('rend les erreurs par traitement et par champ (WF-02)', () => {
    const entries = cinq().map((e) => (e.treatment === 'T3' ? { ...e, prompt: '' } : e));
    const r = validateVersion(entries, catalogues());
    const erreur = r.issues.find((i) => i.blocking)!;
    expect(erreur.treatment).toBe('T3');
    expect(erreur.field).toBe('prompt');
    expect(erreur.label).toBe('Prompt');
  });
});

describe('cascade coût/qualité (§11.2)', () => {
  const t2 = (cascade: TreatmentConfig['cascade']) =>
    valide({ treatment: 'T2', triggers: [], cascade });

  const seuils = (over: Partial<NonNullable<TreatmentConfig['cascade']>> = {}) => ({
    database: 0.8, text: 0.7, semantic: 0.6, semanticEnabled: true, ...over,
  });

  it('accepte une cascade bien formée', () => {
    expect(bloquants(t2(seuils()))).toEqual([]);
  });

  it('laisse le code décider quand rien n’est configuré', () => {
    // `null` n'est pas une erreur : c'est l'état d'une version antérieure à
    // l'ouverture de ce réglage.
    expect(bloquants(t2(null))).toEqual([]);
  });

  it('refuse un seuil hors de [0, 1]', () => {
    expect(bloquants(t2(seuils({ database: 1.5 })))).toHaveLength(1);
    expect(bloquants(t2(seuils({ text: -0.1 })))).toHaveLength(1);
  });

  it("refuse une cascade sur un traitement qui n'est pas l'assistant", () => {
    expect(bloquants(valide({ cascade: seuils() }))).toHaveLength(1);
  });

  it('accepte les deux extrêmes, qui sont des arbitrages légitimes', () => {
    // 0 = ce niveau suffit toujours ; 1 = il ne suffit jamais.
    expect(bloquants(t2(seuils({ database: 0, text: 0, semantic: 0 })))).toEqual([]);
    expect(bloquants(t2(seuils({ database: 1, text: 1, semantic: 1 })))).toEqual([]);
  });

  it('signale sans bloquer une cascade qui envoie tout au modèle', () => {
    // Le réglage qu'on pose en cherchant de la qualité sans voir ce qu'il coûte.
    const toutes = validateTreatment(t2(seuils({ database: 1, text: 1, semantic: 1 })), catalogues());
    const alerte = toutes.find((i) => i.field === 'cascade');
    expect(alerte).toBeDefined();
    expect(alerte?.blocking).toBe(false);
  });

  it('signale un seuil sémantique qui ne s’appliquera pas', () => {
    const toutes = validateTreatment(t2(seuils({ semanticEnabled: false })), catalogues());
    expect(toutes.some((i) => i.field === 'cascade' && !i.blocking)).toBe(true);
  });
});

describe('modèles retirés du catalogue (SCR-10)', () => {
  const dispo = new Set(['m-principal', 'm-repli']);

  it('nomme le traitement, le modèle et son rang', () => {
    // « Cette version a un problème » n'aiderait personne : il faut savoir
    // lequel remplacer, et si un repli peut encore prendre le relais.
    const trouves = unavailableModels([valide({ primaryModel: 'disparu' })], dispo);
    expect(trouves).toEqual([{ treatment: 'T1', model: 'disparu', rank: 'modèle principal' }]);
  });

  it('inspecte aussi les replis', () => {
    const trouves = unavailableModels(
      [valide({ fallback1: 'parti', fallback2: 'm-repli', reasoningFallback1: 'standard' })],
      dispo,
    );
    expect(trouves.map((t) => t.rank)).toEqual(['repli 1']);
  });

  it('ne signale rien quand tout est servi', () => {
    expect(unavailableModels([valide()], dispo)).toEqual([]);
  });

  it('parcourt les cinq traitements d’une version', () => {
    const entries = TREATMENTS.map((t) => valide({ treatment: t, primaryModel: 'disparu', triggers: [] }));
    expect(unavailableModels(entries, dispo)).toHaveLength(5);
  });

  it('ignore les replis non configurés', () => {
    // `null` n'est pas un modèle retiré : le signaler noierait les vrais cas.
    expect(unavailableModels([valide({ fallback1: null, fallback2: null })], dispo)).toEqual([]);
  });
});
