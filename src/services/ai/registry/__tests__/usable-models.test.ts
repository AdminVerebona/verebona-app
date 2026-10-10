/**
 * Lot 32B — `usableModelsForTreatment`, source unique des modèles
 * sélectionnables par traitement (ticket « BO IA : ne proposer que les
 * modèles réellement utilisables par traitement », tests MOD-xx) et
 * suppression de l'interdiction générale des Pro sur T2 (ticket « T2 —
 * supprimer l'interdiction générale des modèles Pro », tests PRO-xx).
 * Lot 35B (ticket « Catalogue IA dynamique Google ») : registre d'exceptions,
 * qualification automatique, preview autorisé, tarif informatif — les tests
 * MOD-04, 05, 08 à 10, 12, 21, 23, PRO-09, 11, 12 sont réécrits en conséquence.
 *
 * Contexte injecté : aucun accès base, aucun appel fournisseur.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateModelForTreatment, usableModelsForTreatment, usableModelsByTreatment, excludedModelsByTreatment,
  treatmentRequirements, type UsableModelsContext,
} from '../usable-models';
import { chainOptions, unusableRanks } from '../model-chain';
import { DECLARED_MODELS, type DeclaredModel } from '../models';
import { validateTreatment, validateVersion, type ConfigCatalogs } from '../../config/config-validation.service';
import { emptyTreatmentConfig, type TreatmentConfig } from '../../config/config-types';
import { TREATMENTS, type Treatment } from '../../config/treatments';

const SANS_T2 = { prompts: ['t2_master_v1'], reason: 'exception de test' } as const;
const decl = (model: string, over: Partial<DeclaredModel> = {}): DeclaredModel => ({
  provider: 'gemini', model, status: 'stable', activatedOn: null, retiresOn: null,
  capabilities: ['structured_output', 'multimodal'], contextWindowTokens: null, maxOutputTokens: null,
  rateLimits: { requestsPerMinute: null, tokensPerMinute: null }, rollbackModel: 'gemini-a', ...over,
});

/** Registre de test : chaque modèle illustre une règle. */
const REGISTRE: DeclaredModel[] = [
  decl('gemini-a'),
  decl('gemini-b'),
  decl('gemini-c'),
  decl('gemini-sans-t2', { excludedPrompts: SANS_T2 }),
  decl('gemini-texte-seul', { capabilities: ['structured_output'] }),
  decl('gemini-preview', { status: 'preview' }),
  decl('gemini-deprecie', { status: 'deprecated' }),
  decl('gemini-retire', { retiresOn: '2026-10-01' }),
  decl('gemini-sans-tarif'),
  decl('gemini-en-panne'),
  decl('gemini-absent'),
  decl('gemini-indispo'),
  decl('gemini-sans-generation'),
  // Ticket Pro : catégories commerciales sans effet.
  decl('gemini-9-pro'),
  decl('gemini-9-pro-incompatible', { excludedPrompts: SANS_T2 }),
  decl('gemini-9-pro-old', { status: 'deprecated' }),
  decl('gemini-9-pro-preview', { status: 'preview' }),
  decl('gemini-9-flash-incompatible', { excludedPrompts: SANS_T2 }),
];
const LISTES = REGISTRE.map((m) => m.model).filter((m) => m !== 'gemini-absent').concat('gemini-inconnu-du-registre');

function ctx(over: Partial<UsableModelsContext> = {}): UsableModelsContext {
  return {
    environment: 'preprod',
    catalog: {
      refreshedAt: '2026-10-07T08:00:00.000Z',
      models: LISTES.map((model) => ({
        model,
        available: model !== 'gemini-indispo',
        supportsGeneration: model !== 'gemini-sans-generation',
      })),
    },
    codeCatalog: ['gemini-a', 'gemini-b', 'gemini-absent'],
    price: (m) => (m === 'gemini-sans-tarif' ? null : { verified: m === 'gemini-a' }),
    operational: new Map([['gemini-en-panne', { ok: false, error: '404 no longer available' }], ['gemini-a', { ok: true }]]),
    today: '2026-10-07',
    declared: REGISTRE,
    ...over,
  };
}
const noms = (t: Treatment, c = ctx()) => usableModelsForTreatment(t, c).map((m) => m.model);
const motifs = (t: Treatment, m: string, c = ctx()) => evaluateModelForTreatment(t, m, c).reasons;

describe('MOD — disponibilité fournisseur (§1.A)', () => {
  it('MOD-01 — modèle absent du catalogue Gemini rafraîchi : absent de TOUS les sélecteurs (jamais réintroduit par le catalogue du code)', () => {
    for (const t of TREATMENTS) expect(noms(t)).not.toContain('gemini-absent');
    expect(motifs('T1', 'gemini-absent')).toEqual(['NOT_LISTED']);
  });
  it('MOD-02 — available = false : absent', () => {
    for (const t of TREATMENTS) expect(noms(t)).not.toContain('gemini-indispo');
    expect(motifs('T1', 'gemini-indispo')).toEqual(['PROVIDER_UNAVAILABLE']);
  });
  it('MOD-03 — generateContent non pris en charge : absent', () => {
    expect(noms('T3')).not.toContain('gemini-sans-generation');
    expect(motifs('T3', 'gemini-sans-generation')).toEqual(['NO_GENERATE_CONTENT']);
  });
  it('MOD-04 (lot 35B) — modèle hors registre : en attente de qualification tant qu’elle n’a pas réussi, puis sélectionnable', () => {
    for (const t of TREATMENTS) expect(noms(t)).not.toContain('gemini-inconnu-du-registre');
    expect(motifs('T1', 'gemini-inconnu-du-registre')).toEqual(['QUALIFICATION_PENDING']);
    const q = ctx({ qualifications: new Map([['gemini-inconnu-du-registre', { generate: true, structured: true, multimodal: true, thinking: null }]]) });
    for (const t of TREATMENTS) expect(noms(t, q)).toContain('gemini-inconnu-du-registre');
  });
});

describe('MOD — exceptions documentées et capacités (§1.C)', () => {
  it('MOD-05 (lot 35B) — exception documentée pour T2 : présent pour T1, absent pour T2', () => {
    expect(noms('T1')).toContain('gemini-sans-t2');
    expect(noms('T2')).not.toContain('gemini-sans-t2');
    expect(motifs('T2', 'gemini-sans-t2')).toEqual(['EXCLUDED']);
  });
  it('MOD-06 — capacité requise absente (multimodal pour T1 et T2, pas pour T3/T4) : absent là où elle est requise', () => {
    expect(treatmentRequirements('T1').capabilities).toEqual(['multimodal', 'structured_output']);
    expect(treatmentRequirements('T2').capabilities).toEqual(['multimodal', 'structured_output']);
    expect(treatmentRequirements('T3').capabilities).toEqual(['structured_output']);
    expect(treatmentRequirements('T5')).toEqual({ masterPromptCode: 't5_master_v1', capabilities: ['structured_output'] });
    expect(noms('T1')).not.toContain('gemini-texte-seul');
    expect(motifs('T1', 'gemini-texte-seul')).toEqual(['CAPABILITY_MISSING']);
    expect(noms('T3')).toContain('gemini-texte-seul');
  });
  it('MOD-07 — chaque traitement a SA liste, prompt maître propre (T1 → t1_master_v1 … T6 → t6_master_v1)', () => {
    for (const t of TREATMENTS) expect(treatmentRequirements(t).masterPromptCode).toBe(`${t.toLowerCase()}_master_v1`);
    const parT = usableModelsByTreatment(ctx());
    expect(Object.keys(parT)).toEqual([...TREATMENTS]);
    expect(parT.T1.map((m) => m.model)).not.toEqual(parT.T2.map((m) => m.model));
  });
});

describe('MOD — règles Verebona, preview, dépréciation, tarif, état opérationnel (§1.D à §1.H)', () => {
  it('MOD-08 (lot 35B) — preview : proposé dans les mêmes conditions qu’un stable, statut visible', () => {
    for (const t of TREATMENTS) expect(noms(t)).toContain('gemini-preview');
    expect(motifs('T4', 'gemini-preview')).toEqual([]);
    expect(usableModelsForTreatment('T4', ctx()).find((m) => m.model === 'gemini-preview')?.status).toBe('preview');
  });
  it('MOD-09 (lot 35B) — preview : écarté seulement par les autres règles (exception documentée, catalogue)', () => {
    const c = ctx({ declared: [...REGISTRE, decl('gemini-preview-sans-t2', { status: 'preview', excludedPrompts: SANS_T2 })] });
    expect(motifs('T2', 'gemini-preview-sans-t2', c)).toEqual(['NOT_LISTED', 'EXCLUDED']);
  });
  it('MOD-10 (lot 35B) — plus aucune politique preview : même verdict en production, en préproduction, pour T2 comme pour T1', () => {
    for (const environment of ['production', 'preprod', 'local'] as const) {
      expect(noms('T2', ctx({ environment }))).toContain('gemini-preview');
      expect(noms('T1', ctx({ environment }))).toContain('gemini-preview');
    }
  });
  it('MOD-11 — déprécié ou arrivé à sa date de retrait : absent pour une nouvelle sélection', () => {
    expect(noms('T1')).not.toContain('gemini-deprecie');
    expect(motifs('T1', 'gemini-deprecie')).toEqual(['DEPRECATED']);
    expect(motifs('T1', 'gemini-retire')).toEqual(['RETIRED']);
    // Avant la date : sélectionnable.
    expect(noms('T1', ctx({ today: '2026-09-30' }))).toContain('gemini-retire');
  });
  it('MOD-12 (lot 35B) — sans tarif : PROPOSÉ (priced: false), la validation le signale sans bloquer', () => {
    expect(noms('T1')).toContain('gemini-sans-tarif');
    expect(usableModelsForTreatment('T1', ctx()).find((m) => m.model === 'gemini-sans-tarif')).toMatchObject({ priced: false });
    const issues = validateTreatment(config('T1', { primaryModel: 'gemini-sans-tarif' }), catalogues(ctx())).filter((i) => i.field === 'primaryModel');
    expect(issues.filter((i) => i.blocking)).toEqual([]);
    expect(issues.find((i) => !i.blocking)?.message).toMatch(/Tarif inconnu pour « gemini-sans-tarif » : appels autorisés, coûts marqués non calculables/);
  });
  it('MOD-13 — explicitement non opérationnel avec la clé active : absent ; opérationnel connu : signalé', () => {
    expect(noms('T1')).not.toContain('gemini-en-panne');
    expect(motifs('T1', 'gemini-en-panne')).toEqual(['NOT_OPERATIONAL']);
    expect(usableModelsForTreatment('T1', ctx()).find((m) => m.model === 'gemini-a')).toMatchObject({ operational: true, verified: true, providerVerified: true });
    expect(usableModelsForTreatment('T1', ctx()).find((m) => m.model === 'gemini-b')).toMatchObject({ operational: null, verified: false });
  });
  it('MOD-14 — catalogue jamais vérifié : hors production, catalogue du code « non vérifié » ; en production, seul un modèle dont une génération a réussi', () => {
    const jamais = { refreshedAt: null, models: [] };
    const preprod = ctx({ catalog: jamais });
    expect(noms('T3', preprod)).toEqual(['gemini-a', 'gemini-b', 'gemini-absent']);
    expect(usableModelsForTreatment('T3', preprod).every((m) => m.providerVerified === false)).toBe(true);
    expect(motifs('T3', 'gemini-c', preprod)).toEqual(['NOT_LISTED']);
    const prod = ctx({ catalog: jamais, environment: 'production' });
    expect(noms('T3', prod)).toEqual(['gemini-a']);
    expect(motifs('T3', 'gemini-b', prod)).toEqual(['NOT_VERIFIED']);
  });
});

describe('MOD — principal et replis (§3)', () => {
  const usable = ['gemini-a', 'gemini-b', 'gemini-c'];
  it('MOD-15 — principal sélectionné : absent des replis 1 et 2', () => {
    const chaine = { primaryModel: 'gemini-a', fallback1: null, fallback2: null };
    expect(chainOptions(usable, chaine, 'fallback1').map((o) => o.model)).toEqual(['gemini-b', 'gemini-c']);
    expect(chainOptions(usable, chaine, 'fallback2').map((o) => o.model)).toEqual(['gemini-b', 'gemini-c']);
    expect(chainOptions(usable, chaine, 'primaryModel').map((o) => o.model)).toEqual(usable);
  });
  it('MOD-16 — repli 1 sélectionné : absent du repli 2 (principal aussi)', () => {
    const chaine = { primaryModel: 'gemini-a', fallback1: 'gemini-b', fallback2: null };
    expect(chainOptions(usable, chaine, 'fallback2').map((o) => o.model)).toEqual(['gemini-c']);
  });
  it('MOD-17 — les trois rangs partagent la même base d’éligibilité (aucun modèle hors liste proposé)', () => {
    const chaine = { primaryModel: null, fallback1: null, fallback2: null };
    for (const r of ['primaryModel', 'fallback1', 'fallback2'] as const) {
      expect(chainOptions(usable, chaine, r).map((o) => o.model)).toEqual(usable);
    }
  });
  it('MOD-18 — doublon dans la chaîne : la validation serveur le refuse toujours', () => {
    const issues = validateTreatment(config('T3', { primaryModel: 'gemini-a', fallback1: 'gemini-a', reasoningFallback1: 'standard' }), catalogues(ctx()));
    expect(issues.some((i) => i.blocking && i.field === 'fallback1' && /déjà déclaré/.test(i.message))).toBe(true);
  });
});

describe('MOD — anciennes versions (§4)', () => {
  it('MOD-19 — version historique : valeur toujours affichée, marquée « indisponible » avec son motif, absente des nouveaux choix', () => {
    const usable = noms('T1');
    const chaine = { primaryModel: 'gemini-deprecie', fallback1: 'gemini-a', fallback2: null };
    const options = chainOptions(usable, chaine, 'primaryModel', { readOnly: true, reasonOf: () => 'déprécié' });
    expect(options[0]).toEqual({ model: 'gemini-deprecie', unusable: true, label: 'gemini-deprecie — indisponible (déprécié)' });
    expect(chainOptions(usable, { ...chaine, primaryModel: 'gemini-b' }, 'primaryModel').map((o) => o.model)).not.toContain('gemini-deprecie');
    expect(excludedModelsByTreatment(ctx()).T1.find((x) => x.model === 'gemini-deprecie')?.reasonText).toBe('déprécié');
  });
  it('MOD-20 — brouillon : valeur héritée signalée « invalide, à remplacer », rangs invalides listés, promotion bloquée', () => {
    const usable = noms('T1');
    const chaine = { primaryModel: 'gemini-deprecie', fallback1: 'gemini-a', fallback2: null };
    expect(chainOptions(usable, chaine, 'primaryModel', { readOnly: false })[0].label).toBe('gemini-deprecie — invalide, à remplacer');
    expect(unusableRanks(usable, chaine)).toEqual(['primaryModel']);
    const r = validateVersion(TREATMENTS.map((t) => config(t, t === 'T1' ? { primaryModel: 'gemini-deprecie' } : {})), catalogues(ctx()));
    expect(r.valid).toBe(false);
    expect(r.issues.filter((i) => i.blocking).map((i) => `${i.treatment}:${i.field}`)).toEqual(['T1:primaryModel']);
  });
});

describe('MOD — validation serveur (§5, §6)', () => {
  it('MOD-21 — modèle utilisable pour T1 envoyé sur T2 alors qu’il en est exclu : rejet', () => {
    expect(noms('T1')).toContain('gemini-sans-t2');
    const issues = validateTreatment(config('T2', { primaryModel: 'gemini-sans-t2' }), catalogues(ctx())).filter((i) => i.blocking);
    expect(issues.map((i) => i.message)).toContain('Le modèle « gemini-sans-t2 » n’est pas utilisable pour T2 : exclu pour ce traitement (exception documentée).');
  });
  it('MOD-22 — changement de disponibilité fournisseur entre l’édition et la promotion : promotion refusée', () => {
    const version = TREATMENTS.map((t) => config(t, { primaryModel: 'gemini-b' }));
    expect(validateVersion(version, catalogues(ctx())).valid).toBe(true);
    const apres = ctx({ catalog: { ...ctx().catalog, models: ctx().catalog.models.map((m) => (m.model === 'gemini-b' ? { ...m, available: false } : m)) } });
    const r = validateVersion(version, catalogues(apres));
    expect(r.valid).toBe(false);
    expect(r.issues.filter((i) => i.blocking).every((i) => /gemini-b.*non servi par la clé active/.test(i.message))).toBe(true);
  });
  it('MOD-23 — une seule définition : les listes du BO et la validation serveur rendent le même verdict pour chaque modèle et traitement', () => {
    const c = ctx();
    for (const t of TREATMENTS) {
      const liste = new Set(noms(t, c));
      for (const m of [...REGISTRE.map((x) => x.model), 'gemini-inconnu-du-registre']) {
        const bloque = validateTreatment(config(t, { primaryModel: m }), catalogues(c)).some((i) => i.blocking && i.field === 'primaryModel');
        expect(bloque, `${t} / ${m}`).toBe(!liste.has(m));
      }
    }
  });
});

describe('PRO — T2 : éligibilité par les caractéristiques réelles, jamais par le nom', () => {
  it('PRO-02 — Pro stable, compatible t2_master_v1, servi, tarifé, opérationnel : accepté pour T2 (principal compris)', () => {
    expect(noms('T2')).toContain('gemini-9-pro');
    expect(validateTreatment(config('T2', { primaryModel: 'gemini-9-pro' }), catalogues(ctx())).filter((i) => i.blocking)).toEqual([]);
  });
  it('PRO-09 (lot 35B) — Pro exclu de T2 par une exception documentée : refusé', () => {
    expect(motifs('T2', 'gemini-9-pro-incompatible')).toEqual(['EXCLUDED']);
  });
  it('PRO-10 — Pro déprécié : refusé pour une nouvelle configuration T2 parce que déprécié ; gemini-2.5-pro du registre réel : refusé pour DÉPRÉCIÉ seulement', () => {
    expect(motifs('T2', 'gemini-9-pro-old')).toEqual(['DEPRECATED']);
    const reel = ctx({ declared: DECLARED_MODELS, catalog: { refreshedAt: '2026-10-07', models: [{ model: 'gemini-2.5-pro', available: true, supportsGeneration: true }] }, operational: new Map() });
    expect(motifs('T2', 'gemini-2.5-pro', reel)).toEqual(['DEPRECATED']);
    expect(motifs('T5', 'gemini-2.5-pro', reel)).toEqual(['DEPRECATED']);
  });
  it('PRO-11 (lot 35B) — Pro preview : éligible dès que le reste est satisfait (plus d’autorisation preview)', () => {
    expect(motifs('T2', 'gemini-9-pro-preview')).toEqual([]);
    expect(noms('T2')).toContain('gemini-9-pro-preview');
  });
  it('PRO-12 — Flash incompatible : refusé au même titre qu’un Pro incompatible', () => {
    expect(motifs('T2', 'gemini-9-flash-incompatible')).toEqual(motifs('T2', 'gemini-9-pro-incompatible'));
    expect(noms('T2')).not.toContain('gemini-9-flash-incompatible');
  });
});

// ── Outils ──────────────────────────────────────────────────────────────────

function config(t: Treatment, over: Partial<TreatmentConfig> = {}): TreatmentConfig {
  return {
    ...emptyTreatmentConfig(t),
    primaryModel: 'gemini-a', reasoningPrimary: 'standard', maxOutputTokens: 400,
    triggers: t === 'T1' ? [{ kind: 'event', code: 'source_uploaded', active: true }]
      : t === 'T3' ? [{ kind: 'event', code: 'asset_updated', active: true }]
        : t === 'T4' ? [{ kind: 'event', code: 'source_analyzed', active: true }] : [],
    ...over,
  };
}

function catalogues(c: UsableModelsContext): ConfigCatalogs {
  return {
    modelEligibility: (t, m) => evaluateModelForTreatment(t, m, c),
    availableModels: new Set(),
    pricedModels: new Set(),
    guardrailCodes: new Set(),
    triggerCodes: new Set(['source_uploaded', 'asset_updated', 'source_analyzed']),
  };
}

describe('PRO — aucune règle sur le suffixe du nom dans le code', () => {
  it('PRO-14 — validation, startup check, configuration de l’assistant, registre et résolveur ne testent plus « -pro »', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const f of [
      'src/services/ai/config/config-validation.service.ts',
      'src/services/verebona-assistant/config/assistant-config.ts',
      'src/services/verebona-assistant/core/model-startup-check.ts',
      'src/services/ai/registry/models.ts',
      'src/services/ai/registry/usable-models.ts',
    ]) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      expect(src, f).not.toMatch(/\/-pro|includes\(['"]-pro|SANS_ASSISTANT/);
    }
  });
});
