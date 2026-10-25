/**
 * Lot 86B — CDC Pilotage IA V2 P6 : fichier global 2.0.0, contrôles d'import,
 * prévisualisation, surcouche de routage, adaptateur des preuves (purs).
 *
 *   L86B-U01  formats retirés / inconnus refusés avec un message explicite
 *   L86B-U02  signature d'intégrité : toute altération refusée ; aller-retour JSON stable
 *   L86B-U03  contrôles : Preview, accès de la clé cible, contrat inconnu,
 *             prompt maître incompatible, seuils (information seulement)
 *   L86B-U04  prévisualisation : modifications locales, exclusions perdues,
 *             modèles réautorisés, déjà appliqué
 *   L86B-U05  surcouche de routage : exclusion, promotion, jamais de chaîne vide
 *   L86B-U06  résolveur : chaîne exécutée réordonnée, raisonnement et profil suivent leur modèle
 *   L86B-U07  adaptateur des preuves (contrat de rebranchement 86A) : jamais
 *             `admissible` depuis la qualification technique ; empreintes exactes
 *   L86B-U08  empreinte de base indépendante de l'ordre ; chaîne vidée détectée
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildExportDocument, validateExportDocument, documentSignature, configurationSha256, compatibilityOperations, operationPolicies, promptSha256,
  type ExportInputs, type ConfigExportDocument,
} from '../config-export.service';
import {
  detectImportFormat, checkImportDocument, computePreview, baseFingerprint, incomingEntries, type ImportTargetContext,
} from '../config-import.service';
import { applyRoutingOverlay, type RoutingOverlay } from '../routing-overlay';
import { chainsEmptiedBy } from '../config-interventions.service';
import {
  evidenceNeverTested, evidenceSupportsAutomaticPromotion, qualificationThresholds, thresholdsSha256, EVIDENCE_STATUSES,
  evidenceFromPairRecord, readPairEvidence,
} from '../qualification-evidence.adapter';
import { QUALIFICATION_THRESHOLDS } from '../../qualification/thresholds';
import { masterPromptForTreatment } from '../prompt-architecture';
import { TREATMENTS, type Treatment } from '../treatments';
import { emptyTreatmentConfig, type TreatmentConfig } from '../config-types';
import { buildSnapshot } from '../config-snapshot';
import { __setConfigForTests, resolveOperationConfig } from '../config-resolver';

const MODELS: Record<Treatment, [string, string | null, string | null]> = {
  T1: ['gemini-2.5-pro', 'gemini-2.5-flash', null],
  T2: ['gemini-2.5-flash', 'gemini-2.5-pro', null],
  T3: ['gemini-2.5-flash', null, null],
  T4: ['gemini-2.5-flash', null, null],
  T6: ['gemini-2.5-flash', 'gemini-2.5-pro', null],
};

function entries(over: Partial<Record<Treatment, Partial<TreatmentConfig>>> = {}): TreatmentConfig[] {
  return TREATMENTS.map((t) => ({
    ...emptyTreatmentConfig(t), primaryModel: MODELS[t][0], fallback1: MODELS[t][1], fallback2: MODELS[t][2],
    reasoningPrimary: 'standard', reasoningFallback1: MODELS[t][1] ? 'minimal' : null, maxOutputTokens: 4096, ...(over[t] ?? {}),
  } as TreatmentConfig));
}

function inputs(es: TreatmentConfig[] = entries()): ExportInputs {
  const masterPrompts: ExportInputs['snapshot']['masterPrompts'] = {};
  TREATMENTS.forEach((t, i) => {
    const code = masterPromptForTreatment(t)?.masterPromptCode ?? `${t.toLowerCase()}_master`;
    const content = `Prompt maître ${t}\nTexte de test.`;
    masterPrompts[t] = { versionId: 100 + i, versionNumber: 3, masterPromptCode: code, contentSha256: promptSha256(content), content, execution: null };
  });
  return {
    environment: 'preprod', appVersion: 'abc1234',
    version: { id: 7, uid: '11111111-2222-4333-8444-555555555555', number: 5, label: 'Préprod v5', description: null, activatedAt: new Date('2026-10-20T08:00:00Z') },
    revision: { id: 70, number: 8, savedAt: new Date('2026-10-20T08:00:00Z'), savedBy: 'admin@e2e.test', comment: null, kind: 'save' },
    snapshot: buildSnapshot(es, masterPrompts), activeMasterPrompts: masterPrompts,
    repositoryText: () => null, masterPromptCodeOf: (t) => masterPromptForTreatment(t)?.masterPromptCode ?? null,
    codeDefaults: () => [], assistant: [], costBudgets: null,
  };
}

const META = { exportId: '0d9b2c1e-5f4a-4b3c-9d8e-7f6a5b4c3d2e', exportedAt: new Date('2026-10-20T09:15:00Z'), userId: 1, email: 'admin@e2e.test' };
const docOf = (es?: TreatmentConfig[]) => JSON.parse(JSON.stringify(buildExportDocument(inputs(es), META))) as ConfigExportDocument;

function ctx(over: Partial<ImportTargetContext> = {}): ImportTargetContext {
  return {
    environment: 'production', operations: compatibilityOperations(), contractKnown: () => true,
    masterPromptCodeOf: (t) => masterPromptForTreatment(t)?.masterPromptCode ?? null, executionIssues: () => [],
    modelEligibility: () => ({ reasons: [], reasonText: '' }), pairIssues: () => [], registryErrors: () => [],
    thresholdsSha256: thresholdsSha256(qualificationThresholds()), policies: operationPolicies(), ...over,
  };
}

afterEach(() => __setConfigForTests(null));

describe('L86B-U01 — formats retirés ou inconnus : refus explicite, rien n’est modifié', () => {
  it('ancien export 1.0.0, ancien package v1, version inconnue, JSON illisible, autre fichier', () => {
    const v1 = detectImportFormat(JSON.stringify({ format: 'verebona-ia-config-export', formatVersion: '1.0.0' }));
    expect(v1).toMatchObject({ ok: false, code: 'LEGACY_EXPORT_FORMAT' });
    expect((v1 as { message: string }).message).toMatch(/ancien format 1\.0\.0[\s\S]*Réexportez[\s\S]*2\.0\.0/);
    const pkg = detectImportFormat(JSON.stringify({ schemaVersion: 'ai-config-package-v1', entries: [] }));
    expect(pkg).toMatchObject({ ok: false, code: 'LEGACY_PACKAGE_FORMAT' });
    expect((pkg as { message: string }).message).toMatch(/retiré[\s\S]*Exporter la configuration/);
    expect(detectImportFormat(JSON.stringify({ format: 'verebona-ia-config-export', formatVersion: '3.0.0' }))).toMatchObject({ ok: false, code: 'UNKNOWN_FORMAT_VERSION' });
    expect(detectImportFormat('{ pas du json')).toMatchObject({ ok: false, code: 'IMPORT_UNREADABLE' });
    expect(detectImportFormat('')).toMatchObject({ ok: false, code: 'IMPORT_UNREADABLE' });
    expect(detectImportFormat(JSON.stringify({ hello: 1 }))).toMatchObject({ ok: false, code: 'UNKNOWN_FORMAT' });
    expect(detectImportFormat(JSON.stringify(docOf()))).toMatchObject({ ok: true });
  });
});

describe('L86B-U02 — signature d’intégrité', () => {
  it('fichier intact : aucun contrôle bloquant, signature stable après aller-retour JSON', () => {
    const doc = docOf();
    expect(doc.formatVersion).toBe('2.0.0');
    expect(doc.integrity.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(documentSignature(doc)).toBe(doc.integrity.signature);
    expect(validateExportDocument(doc).filter((i) => i.blocking)).toEqual([]);
    // Sections 2.0.0 présentes et cohérentes.
    expect(doc.allowedPairs.length).toBeGreaterThan(0);
    expect(doc.qualification.evidence).toHaveLength(doc.allowedPairs.length);
    expect(doc.thresholds).toMatchObject({ readOnly: true, mandatoryChecksPassedPct: 100 });
    expect(doc.compatibility.operations.map((o) => o.operationCode)).toEqual(compatibilityOperations().map((o) => o.operationCode));
    // Chaque couple suit la chaîne configurée : T1 principal + repli 1 pour chaque opération T1.
    const t1 = doc.allowedPairs.filter((p) => p.treatment === 'T1');
    expect(new Set(t1.map((p) => p.model))).toEqual(new Set(['gemini-2.5-pro', 'gemini-2.5-flash']));
  });

  it('altération d’une valeur, d’une preuve ou recalcul partiel des empreintes : refus « integrity »', () => {
    const a = docOf();
    a.configuration.treatments[0].models.maxOutputTokens = 99999;
    const ia = checkImportDocument(a, ctx());
    expect(ia.filter((i) => i.blocking).map((i) => i.category)).toContain('integrity');
    expect(ia.some((i) => i.path === 'integrity.signature' && i.blocking)).toBe(true);

    const b = docOf();
    b.qualification.evidence[0] = { ...b.qualification.evidence[0], status: 'admissible' };
    expect(checkImportDocument(b, ctx()).some((i) => i.path === 'integrity.signature' && i.blocking)).toBe(true);

    // Un faussaire qui recalcule l'empreinte de configuration sans la signature est refusé ;
    // les contrôles suivants ne sont même pas évalués (fichier altéré).
    const c = docOf();
    c.configuration.treatments[1].preamble = 'ajout';
    c.integrity.configurationSha256 = configurationSha256(c);
    const ic = checkImportDocument(c, ctx({ modelEligibility: () => ({ reasons: ['PREVIEW'], reasonText: 'Preview' }) }));
    expect(ic.some((i) => i.path === 'integrity.signature')).toBe(true);
    expect(ic.some((i) => i.category === 'preview')).toBe(false);
  });
});

describe('L86B-U03 — contrôles de l’environnement cible', () => {
  it('Preview refusé, modèle absent de la clé cible refusé (R52), couple incompatible refusé', () => {
    const doc = docOf(entries({ T2: { fallback1: 'gemini-9-pro-preview' } }));
    const issues = checkImportDocument(doc, ctx({
      modelEligibility: (_t, m) => (m === 'gemini-9-pro-preview' ? { reasons: ['PREVIEW'], reasonText: 'modèle Preview' }
        : m === 'gemini-2.5-pro' ? { reasons: ['NOT_LISTED'], reasonText: 'absent du catalogue du fournisseur' } : { reasons: [], reasonText: '' }),
      pairIssues: (e) => (e.treatment === 'T3' ? [{ message: 't3_value_conflict : paramètre refusé', blocking: true }] : []),
    }));
    const bloquants = issues.filter((i) => i.blocking);
    expect(bloquants.find((i) => i.category === 'preview')).toMatchObject({ treatment: 'T2', model: 'gemini-9-pro-preview' });
    expect(bloquants.filter((i) => i.category === 'access').map((i) => i.treatment).sort()).toEqual(['T1', 'T6']);
    expect(bloquants.find((i) => i.category === 'pair')?.message).toMatch(/T3 · t3_value_conflict/);
  });

  it('contrat de sortie inconnu du code cible et prompt maître incompatible : bloquants ; seuils différents : information', () => {
    const doc = docOf();
    const op = doc.compatibility.operations[0];
    const issues = checkImportDocument(doc, ctx({
      contractKnown: (name) => name !== op.outputSchema,
      masterPromptCodeOf: (t) => (t === 'T4' ? 'autre_prompt' : masterPromptForTreatment(t)?.masterPromptCode ?? null),
      thresholdsSha256: 'autre',
    }));
    expect(issues.find((i) => i.path.endsWith(`${op.operationCode}.contractVersion`))).toMatchObject({ blocking: true, category: 'compatibility' });
    expect(issues.find((i) => i.path === 'configuration.treatments.T4.masterPrompt.code')).toMatchObject({ blocking: true });
    expect(issues.find((i) => i.path === 'thresholds')).toMatchObject({ blocking: false, category: 'information' });
  });

  it('fichier conforme : aucun contrôle bloquant ; lignes reconstruites à l’identique', () => {
    const doc = docOf();
    expect(checkImportDocument(doc, ctx()).filter((i) => i.blocking)).toEqual([]);
    const lignes = incomingEntries(doc);
    expect(lignes.map((e) => [e.treatment, e.primaryModel, e.fallback1, e.maxOutputTokens])).toEqual(
      entries().map((e) => [e.treatment, e.primaryModel, e.fallback1, e.maxOutputTokens]));
  });
});

describe('L86B-U04 — prévisualisation exacte', () => {
  const active = (es: TreatmentConfig[]) => ({ id: 3, environment: 'production', visibleNumber: 2, label: 'Prod v2', currentRevisionId: 31, currentRevisionNumber: 4, entries: es, masterPrompts: {} }) as never;
  it('écarts, modifications locales depuis le dernier import, exclusions perdues, modèles réautorisés, déjà appliqué', () => {
    const doc = docOf();
    const importees = entries({ T3: { maxOutputTokens: 4096 } });
    const locales = entries({ T3: { maxOutputTokens: 1234 } });
    const exclusion = { id: 9, environment: 'production', kind: 'EXCLUSION' as const, model: 'gemini-2.5-pro', treatment: null, reason: 'incident', createdBy: 1, createdByEmail: null, createdAt: '2026-10-21T10:00:00.000Z', liftedAt: null, liftedBy: null, liftReason: null, importId: null };
    const gel = { ...exclusion, id: 10, kind: 'FREEZE' as const, model: null, treatment: 'T1' as const };
    const state = {
      active: active(locales), interventions: [exclusion, gel], promotions: [],
      lastImport: { id: 5, newVersionId: 3, newRevisionId: 30, fileSignature: 'x', createdAt: '2026-10-20T10:00:00.000Z' } as never, base: 'b',
    };
    const p = computePreview(doc, state as never, [], buildSnapshot(importees));
    expect(p.diff.treatments.find((t) => t.treatment === 'T3')?.changes.map((c) => c.field)).toContain('maxOutputTokens');
    expect(p.localChanges.note).toMatch(/depuis le dernier import/);
    expect(p.localChanges.diff?.treatments.find((t) => t.treatment === 'T3')?.changes[0]).toMatchObject({ before: '4096', after: '1234' });
    expect(p.lostExclusions.map((x) => x.id)).toEqual([9]);
    expect(p.liftedFreezes.map((x) => x.id)).toEqual([10]);
    expect(p.reauthorizedModels).toEqual([{ model: 'gemini-2.5-pro', treatment: null, exclusionId: 9 }]);
    expect(p.alreadyApplied).toBe(false);
    expect(p.settingsNotImported.some((s) => /Clé API/.test(s))).toBe(true);

    // Même fichier, configuration produite par lui, sans intervention : déjà appliqué.
    const st2 = { ...state, interventions: [], lastImport: { id: 5, newVersionId: 3, newRevisionId: 31, fileSignature: doc.integrity.signature } as never };
    expect(computePreview(doc, st2 as never, [], buildSnapshot(entries())).alreadyApplied).toBe(true);
  });

  it('aucun import précédent : toute la configuration active est locale', () => {
    const p = computePreview(docOf(), { active: active(entries()), interventions: [], promotions: [], lastImport: null, base: 'b' } as never, [], null);
    expect(p.localChanges.note).toMatch(/Aucun import précédent.*entièrement remplacée/);
  });
});

describe('L86B-U05 — surcouche de routage', () => {
  const chaine = [{ model: 'a', slot: 0 }, { model: 'b', slot: 1 }, { model: 'c', slot: 2 }];
  const ov = (o: Partial<RoutingOverlay>): RoutingOverlay => ({ exclusions: [], promotions: new Map(), ...o });
  it('exclusion retirée de la chaîne (globale ou du traitement), promotion en tête, modèle hors chaîne ignoré', () => {
    expect(applyRoutingOverlay(chaine, 'T1', 'op', ov({ exclusions: [{ kind: 'EXCLUSION', model: 'a', treatment: null }] })).chain.map((c) => c.model)).toEqual(['b', 'c']);
    expect(applyRoutingOverlay(chaine, 'T1', 'op', ov({ exclusions: [{ kind: 'EXCLUSION', model: 'a', treatment: 'T2' }] })).chain.map((c) => c.model)).toEqual(['a', 'b', 'c']);
    const p = applyRoutingOverlay(chaine, 'T1', 'op', ov({ promotions: new Map([['op', { model: 'c', promotionId: 4 }]]) }));
    expect([p.chain.map((c) => c.model), p.promotedModel, p.promotionId]).toEqual([['c', 'a', 'b'], 'c', 4]);
    expect(applyRoutingOverlay(chaine, 'T1', 'op', ov({ promotions: new Map([['op', { model: 'z', promotionId: 4 }]]) })).chain.map((c) => c.model)).toEqual(['a', 'b', 'c']);
    // Exclusion prioritaire sur la promotion du même modèle (ACT-03).
    const x = applyRoutingOverlay(chaine, 'T1', 'op', ov({ exclusions: [{ kind: 'EXCLUSION', model: 'c', treatment: null }], promotions: new Map([['op', { model: 'c', promotionId: 4 }]]) }));
    expect([x.chain.map((c) => c.model), x.promotedModel]).toEqual([['a', 'b'], null]);
  });
  it('jamais de chaîne vidée : exclusions inopérantes signalées', () => {
    const r = applyRoutingOverlay([{ model: 'a', slot: 0 }], 'T3', 'op', ov({ exclusions: [{ kind: 'EXCLUSION', model: 'a', treatment: null }] }));
    expect([r.chain.map((c) => c.model), r.exclusionIgnored, r.excluded]).toEqual([['a'], true, []]);
  });
});

describe('L86B-U06 — résolveur : surcouche appliquée à la configuration active', () => {
  it('promotion du repli : principal exécuté = repli, raisonnement et profil suivent leur modèle ; exclusion : modèle absent', async () => {
    const es = entries({ T1: { operationProfiles: { t1_analyze_document: { maxOutputTokensByRank: [30000, 12000] } } } });
    __setConfigForTests({ versionId: 42, entries: es, overlay: { exclusions: [], promotions: new Map([['t1_analyze_document', { model: 'gemini-2.5-flash', promotionId: 8 }]]) } });
    const r = await resolveOperationConfig('t1_analyze_document');
    expect([r.primaryModel, r.fallbackModels]).toEqual(['gemini-2.5-flash', ['gemini-2.5-pro']]);
    expect(r.reasoningByRank).toEqual(['minimal', 'standard']);
    expect(r.operationProfile?.maxOutputTokensByRank).toEqual([12000, 30000]);
    expect(r.routing).toMatchObject({ promotedModel: 'gemini-2.5-flash', promotionId: 8 });
    // Autre opération du même traitement : ordre configuré.
    const autre = await resolveOperationConfig('t1_group_upload');
    expect([autre.primaryModel, autre.routing]).toEqual(['gemini-2.5-pro', undefined]);

    __setConfigForTests({ versionId: 42, entries: es, overlay: { exclusions: [{ kind: 'EXCLUSION', model: 'gemini-2.5-pro', treatment: 'T1' }], promotions: new Map() } });
    const x = await resolveOperationConfig('t1_group_upload');
    expect([x.primaryModel, x.fallbackModels, x.routing?.excludedModels]).toEqual(['gemini-2.5-flash', [], ['gemini-2.5-pro']]);

    // Sans surcouche : chemin historique strictement inchangé.
    __setConfigForTests({ versionId: 42, entries: es });
    const h = await resolveOperationConfig('t1_analyze_document');
    expect([h.primaryModel, h.fallbackModels, h.reasoningByRank, h.operationProfile?.maxOutputTokensByRank, h.routing]).toEqual(['gemini-2.5-pro', ['gemini-2.5-flash'], ['standard', 'minimal'], [30000, 12000], undefined]);
  });
});

describe('L86B-U07 — adaptateur des preuves (contrat de rebranchement 86A)', () => {
  const pair = { operationCode: 't1_analyze_document', model: 'm', profileSha256: 'p', promptSha256: 's', contractRef: 'C@v1' };
  it('couple sans preuve par couple → jamais testé, jamais admissible (MIG-02 ; règle technique transitoire retirée au lot 89A)', () => {
    expect(evidenceNeverTested(pair, { environment: 'preprod' })).toMatchObject({ status: 'never_tested', source: 'pair_evidence', testedAt: null });
    // `technical_only` reste LISIBLE (anciens fichiers 2.0.0), plus produit.
    expect(EVIDENCE_STATUSES).toEqual(['never_tested', 'in_test', 'admissible', 'refused', 'inconclusive', 'obsolete', 'technical_only']);
  });
  it('promotion automatique : preuve admissible aux MÊMES empreintes seulement', () => {
    const t = thresholdsSha256(qualificationThresholds());
    const e = { status: 'admissible' as const, profileSha256: 'p', promptSha256: 's', contractRef: 'C@v1', thresholdsSha256: t };
    const cur = { profileSha256: 'p', promptSha256: 's', contractRef: 'C@v1', thresholdsSha256: t };
    expect(evidenceSupportsAutomaticPromotion(e, cur)).toBe(true);
    expect(evidenceSupportsAutomaticPromotion({ ...e, promptSha256: 'autre' }, cur)).toBe(false);
    expect(evidenceSupportsAutomaticPromotion({ ...e, contractRef: 'C@v2' }, cur)).toBe(false);
    expect(evidenceSupportsAutomaticPromotion({ ...e, thresholdsSha256: 'x' }, cur)).toBe(false);
    expect(evidenceSupportsAutomaticPromotion({ ...e, status: 'technical_only' }, cur)).toBe(false);
    expect(evidenceSupportsAutomaticPromotion(null, cur)).toBe(false);
  });
});

describe('L86B-U08 — base et chaînes', () => {
  it('empreinte de base indépendante de l’ordre des identifiants', () => {
    const a = baseFingerprint({ activeVersionId: 1, activeRevisionId: 2, interventionIds: [3, 1], promotionIds: [9, 4], lastImportId: null });
    const b = baseFingerprint({ activeVersionId: 1, activeRevisionId: 2, interventionIds: [1, 3], promotionIds: [4, 9], lastImportId: null });
    expect(a).toBe(b);
    expect(baseFingerprint({ activeVersionId: 1, activeRevisionId: 3, interventionIds: [1, 3], promotionIds: [4, 9], lastImportId: null })).not.toBe(a);
  });
  it('exclusion qui viderait une chaîne détectée', () => {
    expect(chainsEmptiedBy(entries(), [{ kind: 'EXCLUSION', model: 'gemini-2.5-flash', treatment: null }])).toEqual(['T3', 'T4']);
    expect(chainsEmptiedBy(entries(), [{ kind: 'EXCLUSION', model: 'gemini-2.5-flash', treatment: 'T1' }])).toEqual([]);
  });
});

describe('L86-INT-01 — intégration 86A × 86B : preuves par couple et seuils versionnés', () => {
  const pair = { operationCode: 't1_analyze_document', model: 'm', profileSha256: 'p', promptSha256: 's', contractRef: 'C@v1' };
  const rec = (currentState: 'ADMISSIBLE' | 'REFUSED' | 'OBSOLETE') => ({
    operationCode: pair.operationCode, model: 'm', environment: 'preprod', createdAt: '2026-10-24T08:00:00Z', thresholdsVersion: 'qualif-seuils-v1',
    currentState, currentStateChanged: currentState === 'OBSOLETE' ? ['prompt'] : [],
  });
  it('preuve admissible à signature courante → admissible et promotion automatique possible', () => {
    const t = thresholdsSha256(qualificationThresholds());
    const e = evidenceFromPairRecord(pair, rec('ADMISSIBLE'), { thresholdsSha256: t });
    expect(e).toMatchObject({ status: 'admissible', source: 'pair_evidence' });
    expect(evidenceSupportsAutomaticPromotion(e, { profileSha256: 'p', promptSha256: 's', contractRef: 'C@v1', thresholdsSha256: t })).toBe(true);
  });
  it('preuve obsolète ou refusée → jamais de promotion ; couple sans preuve → jamais testé (source unique : preuves par couple)', async () => {
    const t = thresholdsSha256(qualificationThresholds());
    const o = evidenceFromPairRecord(pair, rec('OBSOLETE'), { thresholdsSha256: t });
    expect(o.status).toBe('obsolete');
    expect(evidenceSupportsAutomaticPromotion(o, { profileSha256: 'p', promptSha256: 's', contractRef: 'C@v1', thresholdsSha256: t })).toBe(false);
    expect(evidenceFromPairRecord(pair, rec('REFUSED'), { thresholdsSha256: t }).status).toBe('refused');
    const [x, y] = await readPairEvidence([pair, { ...pair, model: 'autre' }], {
      environment: 'preprod', loadPairEvidence: async () => [rec('ADMISSIBLE')],
    });
    expect(x.source).toBe('pair_evidence');
    expect(y).toMatchObject({ source: 'pair_evidence', status: 'never_tested' });
  });
  it('seuils = constante versionnée de la qualification (décision 14)', () => {
    const t = qualificationThresholds();
    expect(t.source).toContain(QUALIFICATION_THRESHOLDS.version);
    expect(t.latency.maxP95DegradationPct).toBe(20);
    expect(t.concurrency).toMatchObject({ queuePerWorkerInstance: 3, queuePerTreatment: 2, synchronousSimultaneousT2: 3, synchronousSimultaneousT6: 3 });
  });
});
