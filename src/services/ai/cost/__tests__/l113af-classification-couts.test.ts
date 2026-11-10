/**
 * Lot 113AF (Trello #730) — classification UNIQUE de l'origine du coût IA.
 *
 * Critères couverts ici (sans base) : 1, 2 (classement), 3, 4 (refus avant
 * contact), 5 (coût inconnu jamais zéro dans la synthèse), 6 (segments
 * réconciliables), 7 (exemptions du plafond identiques), 8 (`billable` du
 * registre, donc quotas, inchangé). Le SQL généré est vérifié sur base réelle
 * par l'E2E `l113af-couts-ia-metier`.
 */
import { describe, it, expect } from 'vitest';
import {
  COST_CLASSIFICATION_VERSION, TECHNICAL_OPERATIONS, businessCostSql, classifyCallCost, costCapExemption, costOriginSql,
  costReasonSql, legacyCostOriginSql, originOfReason, registryModelOperations, COST_ORIGIN_LABELS, COST_REASON_LABELS, COST_SEGMENT_HELP,
  type CostClassificationInput,
} from '../cost-classification';
import { AI_OPERATIONS } from '../../registry/operations';
import { summarizeState, type SnapshotGroup } from '../cost-classification-backfill';
import { isCostCapped, costCapSpentSql } from '../../gateway/account-cost-cap';
import { backfillDefinition, BACKFILL_DEFINITIONS, validateBackfillRequest } from '@/services/admin/ops/backfill/definitions';
import { summarizeBackfill } from '@/services/admin/ops/backfill/report-format';

const compte = (op: string, over: Partial<CostClassificationInput> = {}): CostClassificationInput => ({
  accountId: 42, useCaseCode: AI_OPERATIONS[op]?.useCaseCode ?? 'SOURCE_ANALYSIS', operationCode: op, shadow: false,
  legacyBillable: AI_OPERATIONS[op]?.billable ?? false, ...over,
});

describe('113AF — critère 1 : étapes hors quota exécutées pour un compte = dépense MÉTIER imputable', () => {
  for (const op of ['t1_group_upload', 't2_understand', 't3_link_ambiguity', 't3_period_relation', 't4_classify_event', 't6_formulate']) {
    it(`${op} (billable:false au registre) → service du compte, imputable`, () => {
      expect(AI_OPERATIONS[op].billable).toBe(false);
      expect(classifyCallCost(compte(op))).toEqual({ origin: 'ACCOUNT_SERVICE', reason: 'REGISTRY_OPERATION', imputable: true, rule: COST_CLASSIFICATION_VERSION });
    });
  }
  it('toutes les étapes du registre qui appellent un modèle (sauf l’évaluation de prompt) sont métier sur un compte client', () => {
    for (const op of registryModelOperations()) {
      const c = classifyCallCost(compte(op));
      if (op === 'evaluate_prompt') expect(c.origin).toBe('TECHNICAL');
      else expect(c, op).toMatchObject({ origin: 'ACCOUNT_SERVICE', imputable: true });
    }
  });
  it('les étapes déterministes (sans modèle) ne sont pas des étapes modèle du registre', () => {
    const ops = registryModelOperations();
    for (const op of ['collect_evidence', 'compare_values', 'retrieve_data', 'detect_dates', 'deduplicate_event']) expect(ops).not.toContain(op);
  });
});

describe('113AF — critère 2 : t1_analyze_document et t2_answer restent métier, un appel = une trace', () => {
  it('même classement qu’avant pour les étapes déjà facturées au quota', () => {
    expect(classifyCallCost(compte('t1_analyze_document'))).toMatchObject({ origin: 'ACCOUNT_SERVICE', imputable: true });
    expect(classifyCallCost(compte('t2_answer'))).toMatchObject({ origin: 'ACCOUNT_SERVICE', imputable: true });
  });
  it('le classement ne dépend que de l’appel : regroupement puis analyse = deux appels, chacun compté une fois', () => {
    const groups: SnapshotGroup[] = [
      { kind: 'event', origin: 'ACCOUNT_SERVICE', reason: 'REGISTRY_OPERATION', legacyBillable: false, pending: false, rows: 1, calls: 1, micros: 300, unknownCalls: 0 },
      { kind: 'event', origin: 'ACCOUNT_SERVICE', reason: 'REGISTRY_OPERATION', legacyBillable: true, pending: false, rows: 1, calls: 1, micros: 2_000, unknownCalls: 0 },
    ];
    const s = summarizeState(groups);
    expect(s.after.ACCOUNT_SERVICE).toEqual({ rows: 2, calls: 2, micros: 2_300 });
    expect(s.before.business).toEqual({ rows: 1, calls: 1, micros: 2_000 });
    expect(s.reclassifiedToBusiness).toEqual({ rows: 1, calls: 1, micros: 300 });
  });
});

describe('113AF — critère 3 : sonde, qualification, corpus, shadow = TECHNIQUE, jamais imputés', () => {
  const cas: Array<[string, CostClassificationInput, string, string]> = [
    ['sonde sans compte', { accountId: null, useCaseCode: 'SOURCE_ANALYSIS', operationCode: 'circuit_breaker_probe' }, 'TECHNICAL', 'NO_ACCOUNT'],
    ['sonde de modèle', { accountId: null, useCaseCode: 'AI_GOVERNANCE', operationCode: 'model_operational_probe' }, 'TECHNICAL', 'NO_ACCOUNT'],
    ['test fournisseur (compte de l’admin)', { accountId: 7, useCaseCode: 'AI_GOVERNANCE', operationCode: 'provider_test' }, 'TECHNICAL', 'AI_GOVERNANCE'],
    ['évaluation de prompt', { accountId: 7, useCaseCode: 'SOURCE_ANALYSIS', operationCode: 'evaluate_prompt' }, 'TECHNICAL', 'TECHNICAL_OPERATION'],
    ['ancien T5', { accountId: 7, useCaseCode: null, operationCode: 't5_analyze', legacyBillable: true }, 'TECHNICAL', 'TECHNICAL_OPERATION'],
    ['campagne de qualification', compte('t2_answer', { triggerCode: 'qualification' }), 'TECHNICAL', 'TECHNICAL_TRIGGER'],
    ['essai d’amélioration', compte('t6_formulate', { improvementAttempt: true }), 'TECHNICAL', 'IMPROVEMENT_ATTEMPT'],
    ['compte technique (corpus)', compte('t1_analyze_document', { technicalAccount: true }), 'TECHNICAL', 'TECHNICAL_ACCOUNT'],
    ['campagne de mesure exemptée', compte('t3_value_conflict', { costCapExempt: true }), 'TECHNICAL', 'COST_CAP_EXEMPT'],
    ['observation (shadow) sur un compte', compte('t1_analyze_document', { shadow: true }), 'SHADOW', 'SHADOW'],
  ];
  for (const [nom, input, origin, reason] of cas) {
    it(nom, () => {
      const c = classifyCallCost(input);
      expect(c).toMatchObject({ origin, reason, imputable: false });
      expect(originOfReason(c.reason)).toBe(origin);
    });
  }
});

describe('113AF — historique : ancien booléen seulement pour une étape hors registre ; sinon non classable', () => {
  it('étape retirée comptée métier à l’époque → métier (raison LEGACY_BILLABLE)', () => {
    expect(classifyCallCost({ accountId: 9, useCaseCode: 'SOURCE_ANALYSIS', operationCode: 'classify_document', legacyBillable: true }))
      .toMatchObject({ origin: 'ACCOUNT_SERVICE', reason: 'LEGACY_BILLABLE', imputable: true });
  });
  it('étape retirée non facturée, compte présent → non déterminable (jamais devinée)', () => {
    expect(classifyCallCost({ accountId: 9, useCaseCode: 'DATA_RECONCILIATION', operationCode: 'resolve_ambiguity', legacyBillable: false }))
      .toMatchObject({ origin: 'UNDETERMINED', reason: 'NOT_CLASSIFIABLE', imputable: false });
  });
  it('une étape connue du registre ignore l’ancien booléen (billable:false n’est plus « technique »)', () => {
    expect(classifyCallCost(compte('t4_verify_completion', { legacyBillable: false })).origin).toBe('ACCOUNT_SERVICE');
  });
});

describe('113AF — critère 7 : exemptions du plafond = exemptions techniques de la classification (inchangées)', () => {
  it('exempté ⇒ jamais métier imputable ; soumis ⇒ compte réel', () => {
    expect(costCapExemption({ accountId: 5, useCaseCode: 'SOURCE_ANALYSIS', exempt: true, technicalAccountInContext: false })).toBe('COST_CAP_EXEMPT');
    expect(costCapExemption({ accountId: null, useCaseCode: 'SOURCE_ANALYSIS', technicalAccountInContext: false })).toBe('NO_ACCOUNT');
    expect(costCapExemption({ accountId: 5, useCaseCode: 'SOURCE_ANALYSIS', technicalAccountInContext: true })).toBe('TECHNICAL_ACCOUNT');
    expect(costCapExemption({ accountId: 5, useCaseCode: 'AI_GOVERNANCE', technicalAccountInContext: false })).toBe('AI_GOVERNANCE');
    expect(costCapExemption({ accountId: 5, useCaseCode: 'DATA_RECONCILIATION', technicalAccountInContext: false })).toBeNull();
    for (const r of ['COST_CAP_EXEMPT', 'NO_ACCOUNT', 'TECHNICAL_ACCOUNT', 'AI_GOVERNANCE'] as const) expect(originOfReason(r)).toBe('TECHNICAL');
  });
  it('isCostCapped : mêmes réponses qu’avant (lots 22 / 103G)', () => {
    expect(isCostCapped({ accountId: 5, useCaseCode: 'DATA_RECONCILIATION' })).toBe(true);
    expect(isCostCapped({ accountId: 5, useCaseCode: 'AGENDA_INTELLIGENCE' })).toBe(true);
    expect(isCostCapped({ accountId: 5, useCaseCode: 'SOURCE_ANALYSIS', exempt: true })).toBe(false);
    expect(isCostCapped({ accountId: null, useCaseCode: 'SOURCE_ANALYSIS' })).toBe(false);
    expect(isCostCapped({ accountId: 5, useCaseCode: 'AI_GOVERNANCE' })).toBe(false);
  });
  it('le cumul du plafond lit la dépense MÉTIER (toutes étapes du registre), coût effectif, sans exiger is_billable', () => {
    const sql = costCapSpentSql({ persisted: true, corrections: true });
    expect(sql).toMatch(/COALESCE\(c\.corrected_cost_micros, u\.cost_micros\)/);
    expect(sql).toMatch(/= 'ACCOUNT_SERVICE'\)/);
    expect(sql).toContain("'t3_link_ambiguity'");
    expect(sql).toContain("'t4_classify_event'");
    expect(sql).not.toMatch(/AND u\.is_billable\s*$/m);
    expect(sql).toMatch(/u\.created_at >= \$2 AND u\.created_at < \$3/);
    expect(costCapSpentSql({ persisted: false, corrections: false })).not.toMatch(/cost_origin|ai_cost_corrections/);
  });
});

describe('113AF — critère 8 : la politique commerciale du registre (quota) est INCHANGÉE', () => {
  it('seules les étapes facturées au quota avant le lot le restent', () => {
    expect(Object.values(AI_OPERATIONS).filter((o) => o.billable).map((o) => o.operationCode).sort())
      .toEqual(['t1_analyze_document', 't2_answer', 't2_revalidate', 't3_value_conflict']);
  });
});

describe('113AF — SQL généré depuis la même table de règles', () => {
  it('trace : origine persistée d’abord, puis les règles dans l’ordre', () => {
    const s = costOriginSql('u');
    expect(s.startsWith('COALESCE(u.cost_origin, (CASE WHEN')).toBe(true);
    const ordre = ["metadata->>'shadow'", 'u.account_id IS NULL', "'AI_GOVERNANCE'", "'provider_test'", "metadata->>'trigger'", 'improvementAttemptKey', 'technical_kind', "'t1_group_upload'", 'u.is_billable'];
    let pos = -1;
    for (const m of ordre) { const p = s.indexOf(m); expect(p, m).toBeGreaterThan(pos); pos = p; }
    expect(s).toContain("ELSE 'UNDETERMINED' END");
    for (const op of TECHNICAL_OPERATIONS) expect(s).toContain(`'${op}'`);
  });
  it('agrégat journalier : ni étape ni métadonnée (règles non applicables ignorées)', () => {
    const s = costOriginSql('r', { kind: 'rollup' });
    expect(s).not.toMatch(/metadata|operation_code|operation_type/);
    expect(s).toMatch(/r\.account_id IS NULL/);
    expect(s).toMatch(/r\.is_billable THEN 'ACCOUNT_SERVICE'/);
  });
  it('déduction seule (schéma sans 1610), raison et prédicat métier', () => {
    expect(costOriginSql('u', { persisted: false })).not.toContain('cost_origin');
    expect(costReasonSql('u')).toMatch(/^COALESCE\(u\.cost_class->>'reason', \(CASE/);
    expect(costReasonSql('u', { persisted: false })).toContain("THEN 'REGISTRY_OPERATION'");
    expect(businessCostSql('e')).toMatch(/= 'ACCOUNT_SERVICE'\)$/);
    expect(legacyCostOriginSql('r')).toBe("(CASE WHEN r.is_billable THEN 'ACCOUNT_SERVICE' ELSE 'TECHNICAL' END)");
  });
});

describe('113AF — critères 5 et 6 : synthèse avant / après réconciliable, coût inconnu jamais zéro', () => {
  const g = (o: Partial<SnapshotGroup>): SnapshotGroup => ({ kind: 'event', origin: 'ACCOUNT_SERVICE', reason: 'REGISTRY_OPERATION', legacyBillable: true, pending: true, rows: 1, calls: 1, micros: 100, unknownCalls: 0, ...o });
  it('totaux avant = après ; reclassé, technique réel, inconnu et en attente distincts', () => {
    const s = summarizeState([
      g({ legacyBillable: false, micros: 500, rows: 2, calls: 2 }),
      g({ origin: 'TECHNICAL', reason: 'TECHNICAL_ACCOUNT', legacyBillable: true, micros: 70 }),
      g({ origin: 'SHADOW', reason: 'SHADOW', legacyBillable: false, micros: 30, pending: false }),
      g({ origin: 'UNDETERMINED', reason: 'NOT_CLASSIFIABLE', legacyBillable: false, micros: 9, kind: 'rollup', calls: 4 }),
      g({ micros: 0, unknownCalls: 1 }),
    ]);
    expect(s.before.total).toEqual(s.after.total);
    expect(s.after.total).toEqual({ rows: 6, calls: 9, micros: 609 });
    expect(s.reclassifiedToBusiness.micros).toBe(500);
    expect(s.movedToTechnical.micros).toBe(70);
    expect(s.unknownCalls.ACCOUNT_SERVICE).toBe(1);
    expect(s.pending).toMatchObject({ events: 4, rollups: 1 });
    expect(s.after.ACCOUNT_SERVICE.micros + s.after.TECHNICAL.micros + s.after.SHADOW.micros + s.after.UNDETERMINED.micros).toBe(s.after.total.micros);
  });
});

describe('113AF — rattrapage BO « IA : origine des coûts »', () => {
  it('déclaré en fin de catalogue, simuler / appliquer / restaurer, motif obligatoire pour écrire', () => {
    expect(backfillDefinition('ai-cost-classification')).toMatchObject({ order: 20, actions: ['simulate', 'apply', 'restore'], accountFilter: false });
    expect(BACKFILL_DEFINITIONS.at(-1)?.script).toBe('ai-cost-classification');
    expect(validateBackfillRequest({ script: 'ai-cost-classification', action: 'apply' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(validateBackfillRequest({ script: 'ai-cost-classification', action: 'simulate' })).toMatchObject({ ok: true });
    expect(validateBackfillRequest({ script: 'ai-cost-classification', action: 'restore', runId: 'x', reason: 'retour arrière' })).toMatchObject({ ok: false, code: 'INVALID_RUN_ID' });
  });
  const etat = summarizeState([
    { kind: 'event', origin: 'ACCOUNT_SERVICE', reason: 'REGISTRY_OPERATION', legacyBillable: false, pending: true, rows: 3, calls: 3, micros: 1_500, unknownCalls: 1 },
    { kind: 'rollup', origin: 'UNDETERMINED', reason: 'NOT_CLASSIFIABLE', legacyBillable: false, pending: true, rows: 1, calls: 5, micros: 40, unknownCalls: 0 },
  ]);
  const rapport = (mode: 'simulate' | 'apply') => ({
    rule: COST_CLASSIFICATION_VERSION, mode, runId: mode === 'apply' ? '0b8f6f0e-6a6e-4d0b-9a0e-3d1f8f1c2b3a' : null, disabled: null,
    before: etat, after: etat, written: { events: mode === 'apply' ? 3 : 0, rollups: mode === 'apply' ? 1 : 0, byOrigin: {} }, more: false,
    nonClassifiable: { rows: 1, calls: 5, micros: 40, samples: ['agrégat 1 · 2025-01-02 · DATA_RECONCILIATION · compte 9 · 5 appel(s)'] },
    reconciliation: { totalsMatch: true, before: etat.before.total, after: etat.after.total, overlap: { calls: 0, micros: 0, days: [] }, costReport: { providerMicros: 1_540, calls: 8, matches: true } },
  });
  it('simulation : avant / après, métier reclassé, inconnu, non classables, réconciliation', () => {
    const s = summarizeBackfill('ai-cost-classification', 'simulate', null, { result: rapport('simulate') });
    expect(s.headline).toMatch(/^Simulation \(couts-ia-v1\) : 4 ligne\(s\) sans origine figée — métier reclassé/);
    const lab = s.counters.map((c) => c.label);
    expect(lab).toEqual(expect.arrayContaining([
      'Avant : « métier » selon l’ancien indicateur', 'Après : métier (service du compte)', 'Métier reclassé (rangé en technique par l’ancien indicateur)',
      'Appels au coût inconnu : métier (service du compte)', 'Réconciliation : total avant = total après', 'Réconciliation : total de l’écran Coûts IA',
    ]));
    expect(s.restorable).toBe(false);
    expect(s.ambiguous.count).toBe(1);
    expect(JSON.stringify(s)).not.toMatch(/Opération/);
  });
  it('application restaurable par son identifiant ; restauration lisible', () => {
    const a = summarizeBackfill('ai-cost-classification', 'apply', null, { result: rapport('apply') });
    expect(a).toMatchObject({ restorable: true, scriptRunId: '0b8f6f0e-6a6e-4d0b-9a0e-3d1f8f1c2b3a' });
    const r = summarizeBackfill('ai-cost-classification', 'restore', null, { result: { runId: 'x', events: 3, rollups: 1 } });
    expect(r.headline).toMatch(/3 appel\(s\) et 1 agrégat/);
  });
  it('migration absente : rien à classer, sans erreur', () => {
    const s = summarizeBackfill('ai-cost-classification', 'simulate', null, { result: { ...rapport('simulate'), disabled: 'migration 1610 non appliquée', before: null, after: null } });
    expect(s.headline).toMatch(/^Rien à classer : migration 1610/);
  });
});

describe('113AF — textes BO', () => {
  it('chaque origine et chaque raison ont un libellé ; jamais « Opération »', () => {
    for (const v of [...Object.values(COST_ORIGIN_LABELS), ...Object.values(COST_REASON_LABELS), ...Object.values(COST_SEGMENT_HELP)]) {
      expect(v.length).toBeGreaterThan(5);
      expect(v).not.toMatch(/Opération/);
    }
  });
});
