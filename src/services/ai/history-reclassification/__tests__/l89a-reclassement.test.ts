/**
 * Lot 89A — CDC Pilotage IA V2, phase P8 (MIG-02, MIG-03, LOG-08, R23, R59, R70,
 * LIV-01/02) : tests unitaires (purs).
 *
 *   L89A-U01  règle p8-historique-v1 : technique, métier prouvé, non déterminable
 *   L89A-U02  issue lue par la projection ; exécution introuvable → non déterminable
 *   L89A-U03  libellés (colonne « traitement » des appels, résumé du détail)
 *   L89A-U04  AI_PILOTAGE_V2 : seul le reclassement automatique en dépend
 *   L89A-U05  rattrapage du BO : définition, validation, rapports
 *   L89A-U06  tâche planifiée : présente, sans effet tant que le jour J n'est pas passé
 *   L89A-U07  grille de recette unique R01-R70 : complète, sans commande ni SQL
 *   L89A-U08  aucun interrupteur de chemin : un seul chemin par fonction
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  HISTORY_RULE_RUN_ID, HISTORY_RULE_VERSION, classifyHistoricalCall, historyClassSummary, historyScopeLabel, readHistoryClass,
  withExecutionOutcome, type HistoricalCall, type HistoricalLinks,
} from '../rule';
import { automaticHistoryReclassificationEnabled, pilotageV2State } from '../../pilotage-v2/activation';
import { executionScopeLabel } from '../../telemetry/execution-filters';
import { backfillDefinition, validateBackfillRequest } from '@/services/admin/ops/backfill/definitions';
import { summarizeBackfill } from '@/services/admin/ops/backfill/report-format';
import { SCHEDULED_TASKS } from '@/services/scheduling/scheduled-tasks.catalog';
import { readProvenanceMark } from '../service';

const AT = new Date('2026-10-25T10:00:00.000Z');
const call = (o: Partial<HistoricalCall> = {}): HistoricalCall => ({
  id: 1, accountId: 7, useCaseCode: null, operationCode: null, jobId: null, traceId: null, trigger: null, ...o,
});
const links = (o: Partial<HistoricalLinks> = {}): HistoricalLinks => ({
  job: null, t1Report: null, t6Generation: null, t6Evaluation: null, corpusAccountId: null, ...o,
});

describe('L89A-U01 — règle p8-historique-v1 (preuve ou « non déterminable »)', () => {
  it('sonde / qualification / corpus / T5 retiré → technique, jamais rattachés', () => {
    const sonde = classifyHistoricalCall(call({ useCaseCode: 'AI_GOVERNANCE', operationCode: 'model_probe' }), links(), AT);
    expect(sonde).toMatchObject({ rule: HISTORY_RULE_VERSION, runId: HISTORY_RULE_RUN_ID, nature: 'TECHNICAL', treatment: null, executionId: null, reason: null });
    expect(sonde.evidence).toEqual([{ source: 'ai_usage_event', ref: 'use_case_code=AI_GOVERNANCE', proves: 'nature' }]);
    expect(classifyHistoricalCall(call({ useCaseCode: 'SOURCE_ANALYSIS', trigger: 'qualification', jobId: 5 }), links({ job: { id: 5, treatment: 'T1', accountId: 7, targetType: 'asset_file', businessExecutionId: null } }), AT))
      .toMatchObject({ nature: 'TECHNICAL', treatment: 'T1', executionId: null });
    expect(classifyHistoricalCall(call({ accountId: 99, useCaseCode: 'SOURCE_ANALYSIS' }), links({ corpusAccountId: 99 }), AT)).toMatchObject({ nature: 'TECHNICAL', treatment: 'T1' });
    expect(classifyHistoricalCall(call({ operationCode: 't5_analyze' }), links(), AT)).toMatchObject({ nature: 'TECHNICAL', treatment: 'T5' });
    expect(classifyHistoricalCall(call({ operationCode: 'evaluate_prompt' }), links(), AT)).toMatchObject({ nature: 'TECHNICAL' });
  });

  it('travail de file existant → exécution prouvée (T1 avec document, T3 / T4) ; balayage sans compte → technique', () => {
    const t1 = classifyHistoricalCall(call({ useCaseCode: 'SOURCE_ANALYSIS', jobId: 11 }), links({ job: { id: 11, treatment: 'T1', accountId: 7, targetType: 'asset_file', businessExecutionId: null } }), AT);
    expect(t1).toMatchObject({ nature: 'BUSINESS', treatment: 'T1', executionId: 'T1:job:11', outcome: 'UNDETERMINED' });
    expect(t1.evidence.map((e) => e.source)).toEqual(['ai_usage_event', 'ai_job_queue']);
    const porte = classifyHistoricalCall(call({ useCaseCode: 'SOURCE_ANALYSIS', jobId: 12 }),
      links({ job: { id: 12, treatment: 'T1', accountId: 7, targetType: 'asset_file', businessExecutionId: 'T1:0b3f6a1e-1c2d-4e5f-8a9b-0c1d2e3f4a5b' } }), AT);
    expect(porte.executionId).toBe('T1:0b3f6a1e-1c2d-4e5f-8a9b-0c1d2e3f4a5b');
    expect(classifyHistoricalCall(call({ useCaseCode: 'DATA_RECONCILIATION', jobId: 13 }), links({ job: { id: 13, treatment: 'T3', accountId: 7, targetType: 'asset', businessExecutionId: null } }), AT))
      .toMatchObject({ nature: 'BUSINESS', executionId: 'T3:13' });
    expect(classifyHistoricalCall(call({ useCaseCode: 'DATA_RECONCILIATION', jobId: 14, accountId: null }), links({ job: { id: 14, treatment: 'T3', accountId: null, targetType: null, businessExecutionId: null } }), AT))
      .toMatchObject({ nature: 'TECHNICAL', treatment: 'T3', executionId: null });
    expect(classifyHistoricalCall(call({ useCaseCode: 'SOURCE_ANALYSIS', jobId: 15 }), links({ job: { id: 15, treatment: 'T1', accountId: null, targetType: null, businessExecutionId: null } }), AT))
      .toMatchObject({ nature: 'TECHNICAL', treatment: 'T1' });
  });

  it('rapport T1, génération T6 FORMULATE, évaluation T6 EVALUATE portant la trace → exécution prouvée', () => {
    expect(classifyHistoricalCall(call({ useCaseCode: 'SOURCE_ANALYSIS', traceId: 'tr1' }), links({ t1Report: { id: 3, executionId: 'T1:report:3' } }), AT))
      .toMatchObject({ nature: 'BUSINESS', treatment: 'T1', executionId: 'T1:report:3' });
    expect(classifyHistoricalCall(call({ useCaseCode: 'HOME_MASCOT', traceId: 'g1' }), links({ t6Generation: { traceId: 'g1' } }), AT))
      .toMatchObject({ nature: 'BUSINESS', treatment: 'T6', executionId: 'T6F:g1' });
    expect(classifyHistoricalCall(call({ useCaseCode: 'HOME_MASCOT', traceId: 'e1' }), links({ t6Evaluation: { agendaItemId: 4, executionId: 'T6E:4:1700000000000' } }), AT))
      .toMatchObject({ nature: 'BUSINESS', executionId: 'T6E:4:1700000000000' });
  });

  it('sans lien persistant → non déterminable avec motif ; T2 jamais rapproché à l’heure', () => {
    const t2 = classifyHistoricalCall(call({ useCaseCode: 'INTELLIGENT_ASSISTANT', operationCode: 't2_answer', traceId: 'x' }), links(), AT);
    expect(t2).toMatchObject({ nature: 'UNDETERMINED', treatment: 'T2', executionId: null, outcome: 'UNDETERMINED' });
    expect(t2.reason).toMatch(/aucune référence persistante.*rapprochement par l’heure ne prouve rien/);
    const disparu = classifyHistoricalCall(call({ operationCode: 't4_classify_event', jobId: 77 }), links(), AT);
    expect(disparu).toMatchObject({ nature: 'UNDETERMINED', treatment: 'T4' });
    expect(disparu.reason).toContain('introuvable');
    const rien = classifyHistoricalCall(call(), links(), AT);
    expect(rien).toMatchObject({ nature: 'UNDETERMINED', treatment: null, evidence: [] });
  });

  it('déterministe (même entrée, même classement) et lisible après stockage', () => {
    const k = classifyHistoricalCall(call({ useCaseCode: 'SOURCE_ANALYSIS', jobId: 11 }), links({ job: { id: 11, treatment: 'T1', accountId: 7, targetType: 'asset_file', businessExecutionId: null } }), AT);
    expect(classifyHistoricalCall(call({ useCaseCode: 'SOURCE_ANALYSIS', jobId: 11 }), links({ job: { id: 11, treatment: 'T1', accountId: 7, targetType: 'asset_file', businessExecutionId: null } }), AT)).toEqual(k);
    expect(readHistoryClass(JSON.stringify(k))).toEqual(k);
    expect(readHistoryClass({ rule: 'x', nature: 'AUTRE' })).toBeNull();
    expect(readHistoryClass(null)).toBeNull();
  });
});

describe('L89A-U02 — issue de l’exécution (projection P2)', () => {
  const k = classifyHistoricalCall(call({ useCaseCode: 'DATA_RECONCILIATION', jobId: 13 }), links({ job: { id: 13, treatment: 'T3', accountId: 7, targetType: 'asset', businessExecutionId: null } }), AT);
  it('Réussie / Incomplète / Échouée reprises telles quelles', () => {
    for (const o of ['SUCCEEDED', 'INCOMPLETE', 'FAILED'] as const) expect(withExecutionOutcome(k, { outcome: o, nature: 'BUSINESS' })).toMatchObject({ nature: 'BUSINESS', outcome: o, executionId: 'T3:13' });
  });
  it('exécution introuvable → identifiant NON retenu, non déterminable motivé ; exécution technique → technique', () => {
    const x = withExecutionOutcome(k, null);
    expect(x).toMatchObject({ nature: 'UNDETERMINED', executionId: null, outcome: 'UNDETERMINED' });
    expect(x.reason).toContain('T3:13');
    expect(withExecutionOutcome(k, { outcome: 'SUCCEEDED', nature: 'TECHNICAL' }).nature).toBe('TECHNICAL');
  });
});

describe('L89A-U03 — libellés', () => {
  it('colonne « traitement » : le code d’usage prime, puis T5, sonde, puis le reclassement', () => {
    const nd = classifyHistoricalCall(call({ operationCode: 't2_answer' }), links(), AT);
    expect(historyScopeLabel(nd)).toBe('T2 (historique)');
    expect(historyScopeLabel(classifyHistoricalCall(call(), links(), AT))).toBe('Non déterminable (historique)');
    expect(executionScopeLabel({ treatment: null, useCaseCode: null, operationCode: 't2_answer', history: nd })).toBe('T2 (historique)');
    expect(executionScopeLabel({ treatment: null, useCaseCode: null, operationCode: null })).toBe('Non rattaché (historique)');
    expect(executionScopeLabel({ treatment: 'T1', history: nd })).toBe('T1');
    expect(executionScopeLabel({ treatment: null, useCaseCode: 'AI_GOVERNANCE', history: nd })).toBe('Technique');
  });
  it('résumé du détail : règle, nature, exécution et issue, motif', () => {
    const k = withExecutionOutcome(classifyHistoricalCall(call({ useCaseCode: 'DATA_RECONCILIATION', jobId: 13 }),
      links({ job: { id: 13, treatment: 'T3', accountId: 7, targetType: 'asset', businessExecutionId: null } }), AT), { outcome: 'INCOMPLETE', nature: 'BUSINESS' });
    expect(historyClassSummary(k)).toBe('Reclassement historique (p8-historique-v1) : Métier T3 · exécution T3:13 (Incomplète)');
  });
  it('marque de provenance lue de façon tolérante', () => {
    expect(readProvenanceMark({ provenance: 'manual', proof: 'not_qualified', label: 'manuel, non qualifié', rule: HISTORY_RULE_VERSION, runId: HISTORY_RULE_RUN_ID, markedAt: AT.toISOString() })?.label).toBe('manuel, non qualifié');
    expect(readProvenanceMark('{"provenance":"auto"}')).toBeNull();
    expect(readProvenanceMark(null)).toBeNull();
  });
});

describe('L89A-U04 — AI_PILOTAGE_V2', () => {
  it('on / off / absente / valeur inconnue', () => {
    expect(pilotageV2State({ AI_PILOTAGE_V2: 'on' })).toBe('on');
    expect(pilotageV2State({ AI_PILOTAGE_V2: ' ON ' })).toBe('on');
    expect(pilotageV2State({ AI_PILOTAGE_V2: 'off' })).toBe('off');
    expect(pilotageV2State({})).toBe('absent');
    expect(pilotageV2State({ AI_PILOTAGE_V2: 'peut-être' })).toBe('invalid');
    expect(automaticHistoryReclassificationEnabled({ AI_PILOTAGE_V2: 'on' })).toBe(true);
    for (const v of ['off', '', 'x']) expect(automaticHistoryReclassificationEnabled({ AI_PILOTAGE_V2: v })).toBe(false);
  });
});

describe('L89A-U05 — rattrapage du BO « IA : reclassement de l’historique »', () => {
  it('Simuler / Appliquer / Restaurer ; jamais limité à un compte ; motif pour écrire', () => {
    const d = backfillDefinition('ai-history-reclassification')!;
    expect(d.actions).toEqual(['simulate', 'apply', 'restore']);
    expect(d.accountFilter).toBe(false);
    expect(validateBackfillRequest({ script: 'ai-history-reclassification', action: 'simulate' })).toMatchObject({ ok: true });
    expect(validateBackfillRequest({ script: 'ai-history-reclassification', action: 'apply' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(validateBackfillRequest({ script: 'ai-history-reclassification', action: 'simulate', accountId: 3 })).toMatchObject({ ok: false, code: 'ACCOUNT_FILTER_NOT_SUPPORTED' });
    expect(validateBackfillRequest({ script: 'ai-history-reclassification', action: 'restore', reason: 'retour arrière', runId: HISTORY_RULE_RUN_ID })).toMatchObject({ ok: true });
  });
  const rapport = (o: Record<string, unknown> = {}) => ({
    rule: HISTORY_RULE_VERSION, runId: HISTORY_RULE_RUN_ID, applied: true, pilotageV2: 'on', disabled: null, correlationStartedAt: '2026-10-21T08:00:00.000Z',
    calls: { examined: 4, classified: 4, skippedConcurrent: 0, byNature: { BUSINESS: 2, TECHNICAL: 1, UNDETERMINED: 1 }, byTreatment: { T1: 2, T2: 1, 'non établi': 1 },
      byOutcome: { SUCCEEDED: 1, FAILED: 1, UNDETERMINED: 2 }, undeterminedReasons: { 'demande non déterminable': 1 }, samples: [], alreadyClassified: 0, more: false },
    configurations: { examined: 3, marked: 2, alreadyMarked: 0, automaticSkipped: 1, versionIds: [1, 2] },
    ...o,
  });
  it('rapport d’application : restaurable avec l’identifiant de la règle, comptes par nature et par issue', () => {
    const s = summarizeBackfill('ai-history-reclassification', 'apply', null, { result: rapport() });
    expect(s.headline).toContain('4 classé(s)');
    expect(s.headline).toContain('2 version(s) de configuration marquée(s) « manuel, non qualifié »');
    expect(s).toMatchObject({ scriptRunId: HISTORY_RULE_RUN_ID, restorable: true });
    expect(s.counters).toEqual(expect.arrayContaining([{ label: 'Appels non déterminable', value: 1 }, { label: 'Issue de l’exécution : Échouée', value: 1 }]));
    expect(s.ambiguous.samples).toEqual(['1 × demande non déterminable']);
  });
  it('simulation : rien d’écrit, non restaurable ; restauration ; migrations absentes', () => {
    const sim = summarizeBackfill('ai-history-reclassification', 'simulate', null, { result: rapport({ applied: false }) });
    expect(sim.restorable).toBe(false);
    expect(sim.headline).toMatch(/^Simulation/);
    const res = summarizeBackfill('ai-history-reclassification', 'restore', null, { result: { runId: HISTORY_RULE_RUN_ID, callsRestored: 4, configurationsRestored: 2 } });
    expect(res.headline).toContain('4 appel(s)');
    expect(summarizeBackfill('ai-history-reclassification', 'apply', null, { result: rapport({ disabled: 'migrations 0776 / 0777 absentes : rien à reclasser' }) }).headline).toContain('Rien à reclasser');
  });
});

describe('L89A-U06 — tâche planifiée ai-history-reclassification', () => {
  it('au démarrage puis toutes les heures tant qu’il reste ; sans effet sans AI_PILOTAGE_V2=on', async () => {
    const t = SCHEDULED_TASKS.find((x) => x.code === 'ai-history-reclassification')!;
    expect(t.schedule).toMatchObject({ kind: 'startup' });
    const avant = process.env.AI_PILOTAGE_V2;
    delete process.env.AI_PILOTAGE_V2;
    try {
      const r = await t.run({ deadline: Date.now() + 1000, trigger: 'startup' });
      expect(r && 'note' in r ? r.note : '').toContain('en attente du jour J');
      expect(r && 'again' in r ? r.again : undefined).toBeUndefined();
    } finally {
      if (avant !== undefined) process.env.AI_PILOTAGE_V2 = avant;
    }
  });
});

describe('L89A-U07 — grille de recette unique R01-R70 (docs/exploitation/pilotage-ia-v2-recette.md)', () => {
  const doc = readFileSync(join(process.cwd(), 'docs/exploitation/pilotage-ia-v2-recette.md'), 'utf8');
  it('chaque cas R01 à R70 a exactement une ligne avec quoi faire, résultat attendu et où regarder', () => {
    for (let i = 1; i <= 70; i++) {
      const id = `R${String(i).padStart(2, '0')}`;
      const lignes = doc.split('\n').filter((l) => l.startsWith(`| ${id} |`));
      expect(lignes, id).toHaveLength(1);
      // Colonnes : cas | traitement | quoi faire | résultat attendu | où regarder | statut
      expect(lignes[0].split('|').filter((c) => c.trim() !== '').length, id).toBeGreaterThanOrEqual(5);
    }
    expect(doc).toMatch(/## .*Jour J/);
    expect(doc).toMatch(/## .*Retour arrière/);
  });
  it('mots simples : aucune commande, aucun SQL, aucun secret', () => {
    expect(doc).not.toMatch(/\bnpm\b|\bnpx\b|\bpsql\b|\bcurl\b|\bSELECT\b|\bUPDATE\b|\bINSERT\b|\bDELETE FROM\b|scalingo run|```/);
    expect(doc).not.toMatch(/API_KEY=|SECRET=|password/i);
  });
});

describe('L89A-U08 — un seul chemin par fonction (MIG-04)', () => {
  const lire = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return ['__tests__', 'node_modules', 'test'].includes(e.name) ? [] : lire(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
  it('aucun aiguillage AI_V2_* ; AI_PILOTAGE_V2 lue seulement par son module (reclassement automatique)', () => {
    const fichiers = lire(join(process.cwd(), 'src'));
    const v2 = fichiers.filter((f) => /AI_V2_[A-Z]/.test(readFileSync(f, 'utf8')));
    expect(v2).toEqual([]);
    const lecteurs = fichiers.filter((f) => /process\.env\.AI_PILOTAGE_V2|env\[['"]AI_PILOTAGE_V2/.test(readFileSync(f, 'utf8')));
    expect(lecteurs).toEqual([]);
    expect(readFileSync(join(process.cwd(), 'src/services/ai/pilotage-v2/activation.ts'), 'utf8')).toContain("PILOTAGE_V2_VARIABLE = 'AI_PILOTAGE_V2'");
  });
  it('preuves du fichier global : plus de règle transitoire « qualification technique » (source unique : preuves par couple)', () => {
    const a = readFileSync(join(process.cwd(), 'src/services/ai/config/qualification-evidence.adapter.ts'), 'utf8');
    expect(a).not.toMatch(/evidenceFromTechnicalQualification|loadQualifications|loadTechnical/);
  });
});
