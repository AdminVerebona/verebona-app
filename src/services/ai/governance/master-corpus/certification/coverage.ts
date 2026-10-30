/**
 * Lot 100B — MATRICE DE COUVERTURE et VERROU A1 (arbitrage PO A1, ticket
 * #601 ; recettes 7 et 9) — PUR, sans base.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * VERROU A1 — AVANT TOUTE PROMOTION AUTOMATIQUE EN PRÉPRODUCTION
 *
 * Matrice par opération ACTIVE (recalculée depuis le registre) × famille de
 * risque métier × difficulté × type de test. La promotion automatique
 * (candidate de configuration 86A, révision de prompt 99B) est INTERDITE,
 * même avec un excellent score global, si :
 *   · une opération active du périmètre n'a aucune référence approuvée
 *     (OPERATION_NOT_COVERED) — une NOUVELLE opération entre automatiquement
 *     dans le périmètre ;
 *   · une famille de risque exigée du traitement n'est couverte par aucune
 *     référence approuvée (RISK_NOT_COVERED) ;
 *   · un cas CRITIQUE n'a pas d'oracle approuvé (CRITICAL_WITHOUT_APPROVED_ORACLE) ;
 *   · un cas critique approuvé n'est pas concluant ou pas exécuté sur la
 *     candidate (CRITICAL_NOT_CONCLUSIVE) ;
 *   · un cas critique échoue, en particulier par OMISSION (CRITICAL_OMISSION,
 *     CRITICAL_FAILED) ;
 *   · une paire adversariale est incomplète ou invalide (PAIR_INVALID) ;
 *   · un modèle plus rapide (gain établi) est erroné sur un risque critique
 *     (FASTER_BUT_WRONG — recette 9).
 * L'activation MANUELLE (#345) reste possible : elle affiche la matrice et
 * les manques (`a1Notices`), sans jamais être bloquée par ce verrou.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Defect } from '../../../qualification/defects';
import type { Treatment } from '../../../config/treatments';
import {
  activeQualificationOperations, CASE_STATUSES, CASE_STATUS_LABELS, RISK_FAMILY_LABELS, riskFamiliesOf,
  type ActiveOperation, type CaseStatus, type ManifestEntry,
} from './model';
import { assessPairs, type PairAssessment, type PairSideResult } from './pairs';

/** Version des règles du verrou : entre dans les rapports (une évolution est explicite). */
export const A1_RULES_VERSION = 'a1-v1';

/** Résultat d'un cas du manifeste pour le couple évalué (candidate). */
export interface CaseResult extends PairSideResult {
  defects: Defect[];
  criticalDefects: Defect[];
  inconclusiveReason?: string | null;
}

export type A1BlockerCode =
  | 'OPERATION_NOT_COVERED' | 'RISK_NOT_COVERED' | 'CRITICAL_WITHOUT_APPROVED_ORACLE' | 'CRITICAL_NOT_CONCLUSIVE'
  | 'CRITICAL_FAILED' | 'CRITICAL_OMISSION' | 'PAIR_INVALID' | 'FASTER_BUT_WRONG' | 'NO_RESULTS';

export interface A1Blocker { code: A1BlockerCode; operationCode: string | null; caseId: string | null; message: string }

export interface MatrixCell {
  treatment: Treatment;
  operationCode: string;
  riskFamily: string;
  difficulty: string;
  testType: string;
  total: number;
  byStatus: Record<CaseStatus, number>;
}

export interface OperationCoverage {
  treatment: Treatment;
  operationCode: string;
  label: string;
  total: number;
  approvedReferences: number;
  critical: number;
  criticalApproved: number;
  guards: number;
  e2e: number;
  toComplete: number;
  excluded: number;
  covered: boolean;
}

export interface CoverageMatrix {
  rulesVersion: string;
  operations: OperationCoverage[];
  cells: MatrixCell[];
  risks: Array<{ treatment: Treatment; riskFamily: string; label: string; approvedReferences: number; required: boolean }>;
}

export interface A1Assessment {
  rulesVersion: string;
  allowed: boolean;
  scope: Treatment[];
  blockers: A1Blocker[];
  matrix: CoverageMatrix;
  pairs: PairAssessment[];
  /** Résultats évalués (null : matrice seule, avant campagne). */
  measured: boolean;
}

export type StatusOf = (e: ManifestEntry) => CaseStatus;

const zero = (): Record<CaseStatus, number> => Object.fromEntries(CASE_STATUSES.map((s) => [s, 0])) as Record<CaseStatus, number>;
const isQualityReference = (e: ManifestEntry) => e.testType === 'QUALITE_MODELE' || e.testType === 'PAIRE_ADVERSARIALE' || e.testType === 'NON_REGRESSION';

/** Matrice de couverture (pure). */
export function buildCoverageMatrix(entries: readonly ManifestEntry[], statusOf: StatusOf, ops: ActiveOperation[] = activeQualificationOperations(), treatments?: readonly Treatment[]): CoverageMatrix {
  const scopeOps = ops.filter((o) => !treatments || treatments.includes(o.treatment));
  const cells = new Map<string, MatrixCell>();
  const operations: OperationCoverage[] = [];
  for (const op of scopeOps) {
    const mine = entries.filter((e) => e.operationCode === op.operationCode);
    const st = mine.map((e) => ({ e, s: statusOf(e) }));
    const approved = st.filter((x) => x.s === 'REFERENCE_APPROUVEE' && isQualityReference(x.e));
    operations.push({
      treatment: op.treatment, operationCode: op.operationCode, label: op.label, total: mine.length,
      approvedReferences: approved.length, critical: mine.filter((e) => e.critical).length,
      criticalApproved: st.filter((x) => x.e.critical && x.s === 'REFERENCE_APPROUVEE').length,
      guards: st.filter((x) => x.s === 'GARDE_SERVEUR').length, e2e: st.filter((x) => x.s === 'E2E_METIER').length,
      toComplete: st.filter((x) => x.s === 'A_COMPLETER').length, excluded: st.filter((x) => x.s === 'HISTORIQUE' || x.s === 'REJETEE').length,
      covered: approved.length > 0,
    });
    for (const { e, s } of st) {
      const k = [op.operationCode, e.riskFamily ?? '—', e.difficulty ?? '—', e.testType].join('|');
      const c = cells.get(k) ?? { treatment: op.treatment, operationCode: op.operationCode, riskFamily: e.riskFamily ?? '—', difficulty: e.difficulty ?? '—', testType: e.testType, total: 0, byStatus: zero() };
      c.total += 1;
      c.byStatus[s] += 1;
      cells.set(k, c);
    }
  }
  const ts = [...new Set(scopeOps.map((o) => o.treatment))];
  const risks = ts.flatMap((t) => {
    const exigees = riskFamiliesOf(t);
    const declarees = [...new Set(entries.filter((e) => e.treatment === t && e.riskFamily).map((e) => e.riskFamily!))];
    return [...new Set([...exigees, ...declarees])].map((r) => ({
      treatment: t, riskFamily: r, label: RISK_FAMILY_LABELS[r] ?? r, required: exigees.includes(r),
      approvedReferences: entries.filter((e) => e.treatment === t && e.riskFamily === r && statusOf(e) === 'REFERENCE_APPROUVEE' && isQualityReference(e)).length,
    }));
  });
  return { rulesVersion: A1_RULES_VERSION, operations, cells: [...cells.values()], risks };
}

/**
 * Verrou A1 (pur). `results` : résultats de la candidate par identifiant du
 * manifeste ; `null` : matrice seule (BO, activation manuelle) — les
 * exigences de résultat sont alors signalées « non mesurées ».
 * `gains` : gains établis par opération (86A) pour la règle « plus rapide
 * mais erroné » (recette 9).
 */
export function assessA1(p: {
  treatments: readonly Treatment[];
  entries: readonly ManifestEntry[];
  statusOf: StatusOf;
  results: ReadonlyMap<string, CaseResult> | null;
  gains?: ReadonlyArray<{ operationCode: string; outcome: string }>;
  operations?: ActiveOperation[];
}): A1Assessment {
  const ops = (p.operations ?? activeQualificationOperations()).filter((o) => p.treatments.includes(o.treatment));
  const matrix = buildCoverageMatrix(p.entries, p.statusOf, ops, p.treatments);
  const blockers: A1Blocker[] = [];
  const add = (code: A1BlockerCode, operationCode: string | null, caseId: string | null, message: string) => blockers.push({ code, operationCode, caseId, message });
  const opCodes = new Set(ops.map((o) => o.operationCode));
  const inScope = p.entries.filter((e) => e.operationCode && opCodes.has(e.operationCode));

  for (const o of matrix.operations.filter((x) => !x.covered)) {
    add('OPERATION_NOT_COVERED', o.operationCode, null, `${o.treatment} · ${o.operationCode} : aucune référence approuvée (opération active non couverte)`);
  }
  for (const r of matrix.risks.filter((x) => x.required && x.approvedReferences === 0)) {
    add('RISK_NOT_COVERED', null, null, `${r.treatment} · risque « ${r.label} » : aucune référence approuvée`);
  }
  const critiques = inScope.filter((e) => e.critical && !['GARDE_SERVEUR', 'E2E_METIER', 'REJETEE'].includes(p.statusOf(e)));
  for (const e of critiques.filter((x) => p.statusOf(x) !== 'REFERENCE_APPROUVEE')) {
    add('CRITICAL_WITHOUT_APPROVED_ORACLE', e.operationCode, e.id, `cas critique ${e.id} (${e.operationCode}) : oracle non approuvé (${CASE_STATUS_LABELS[p.statusOf(e)]} — ${e.reason})`);
  }
  if (p.results) {
    for (const e of critiques.filter((x) => p.statusOf(x) === 'REFERENCE_APPROUVEE')) {
      const r = p.results.get(e.id);
      if (!r || r.outcome === 'NOT_RUN') { add('CRITICAL_NOT_CONCLUSIVE', e.operationCode, e.id, `cas critique ${e.id} non exécuté sur la candidate`); continue; }
      if (r.outcome === 'INCONCLUSIVE') { add('CRITICAL_NOT_CONCLUSIVE', e.operationCode, e.id, `cas critique ${e.id} non concluant (${r.inconclusiveReason ?? 'motif non précisé'})`); continue; }
      if (r.outcome === 'FAILED') {
        const omission = r.defects.find((d) => d.category === 'OMISSION');
        if (omission) add('CRITICAL_OMISSION', e.operationCode, e.id, `omission critique sur ${e.id} : ${omission.message}`);
        else add('CRITICAL_FAILED', e.operationCode, e.id, `cas critique ${e.id} en échec : ${r.defects[0]?.message ?? 'défaut métier'}`);
      }
    }
    for (const g of (p.gains ?? []).filter((x) => x.outcome === 'GAIN')) {
      const fautifs = inScope.filter((e) => e.operationCode === g.operationCode && e.critical && p.results!.get(e.id)?.outcome === 'FAILED');
      if (fautifs.length) {
        add('FASTER_BUT_WRONG', g.operationCode, fautifs[0].id,
          `${g.operationCode} : modèle plus rapide / moins coûteux (gain établi) mais erroné sur un risque critique (${fautifs.map((e) => e.id).join(', ')}) : refus`);
      }
    }
  } else {
    add('NO_RESULTS', null, null, 'résultats de la candidate non mesurés : la promotion exige une campagne concluante');
  }
  const pairResults = new Map<string, PairSideResult>();
  if (p.results) for (const [k, v] of p.results) pairResults.set(k, v);
  const pairs = assessPairs(p.entries.filter((e) => p.statusOf(e) !== 'REJETEE'), pairResults, (e) => Boolean(e.operationCode && opCodes.has(e.operationCode)));
  for (const x of pairs.filter((y) => y.verdict !== 'VALID')) {
    if (!p.results && x.verdict === 'INVALID_SIDE_MISSING' && x.a && x.b) continue;
    add('PAIR_INVALID', null, x.pairId, `paire ${x.pairId} : ${x.reason}`);
  }
  return { rulesVersion: A1_RULES_VERSION, allowed: blockers.length === 0, scope: [...p.treatments], blockers, matrix, pairs, measured: Boolean(p.results) };
}

/** Messages courts pour l'activation manuelle (#345) : informatifs, jamais bloquants. */
export function a1Notices(a: A1Assessment, max = 6): string[] {
  if (a.allowed) return [];
  const parCode = new Map<string, number>();
  for (const b of a.blockers) parCode.set(b.code, (parCode.get(b.code) ?? 0) + 1);
  return [
    `Verrou A1 (information, l’activation manuelle reste possible) : couverture insuffisante pour une promotion automatique — ${[...parCode.entries()].map(([c, n]) => `${A1_CODE_LABELS[c as A1BlockerCode]} ×${n}`).join(', ')}.`,
    ...a.blockers.filter((b) => b.code !== 'NO_RESULTS').slice(0, max).map((b) => b.message),
  ];
}

export const A1_CODE_LABELS: Readonly<Record<A1BlockerCode, string>> = {
  OPERATION_NOT_COVERED: 'opération active non couverte',
  RISK_NOT_COVERED: 'risque métier non couvert',
  CRITICAL_WITHOUT_APPROVED_ORACLE: 'cas critique sans oracle approuvé',
  CRITICAL_NOT_CONCLUSIVE: 'cas critique non concluant',
  CRITICAL_FAILED: 'cas critique en échec',
  CRITICAL_OMISSION: 'omission critique',
  PAIR_INVALID: 'paire incomplète ou invalide',
  FASTER_BUT_WRONG: 'plus rapide mais erroné sur un risque critique',
  NO_RESULTS: 'résultats non mesurés',
};

// ══════════════════════════════════════════════════════════════════════════
// Vue T2 — recherche de l'assistant (CDC 4 §35 ; réponse PO C5)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Catégories du §35.1 qui relèvent de la PRÉCISION DE RECHERCHE de
 * l'assistant (retrieval + réponse sourcée). Les autres catégories du §35.1
 * (offre Standard / Premium / Duo, timeout, échec du modèle, aide produit,
 * injection, hors périmètre) sont des comportements déterministes déjà
 * mesurés sans modèle par le jeu d'évaluation (`jeu-evaluation.test.ts`).
 */
export const T2_SEARCH_CATEGORIES = [
  { code: 'recherche', label: 'recherche simple' },
  { code: 'dates', label: 'dates' },
  { code: 'homonymes', label: 'biens homonymes' },
  { code: 'documents_multiples', label: 'documents multiples' },
  { code: 'fautes', label: 'fautes de frappe' },
  { code: 'absent', label: 'informations absentes' },
  { code: 'contradiction', label: 'contradictions' },
  { code: 'analyse', label: 'documents en analyse' },
  { code: 'source_supprimee', label: 'source supprimée' },
] as const;

/** §35.3 : au moins 95 % de bonnes réponses ; minimum de cas par catégorie (même règle que le jeu du §35.1). */
export const T2_SEARCH_TARGET = 0.95;
export const T2_MIN_CASES_PER_CATEGORY = 8;

export interface T2SearchView {
  target: number;
  minPerCategory: number;
  categories: Array<{ code: string; label: string; total: number; approved: number; executed: number; passed: number; failed: number }>;
  unclassified: number;
  precision: { measured: number | null; passed: number; concluded: number; inconclusive: number };
  verdict: 'SUFFISANTE' | 'INSUFFISANTE' | 'NON_MESUREE';
  gaps: string[];
}

/** Cas T2 de recherche : traitement T2 et famille « recherche » ou catégorie §35.1 déclarée. */
export const isT2SearchCase = (e: ManifestEntry) => e.treatment === 'T2' && (e.riskFamily === 'T2_RECHERCHE' || Boolean(e.cdc35Category));

/**
 * Vue dédiée T2 (pure) : couverture par catégorie §35.1 et précision de
 * recherche MESURÉE sur les cas T2 approuvés (réussis / conclus). Dit, après
 * import, si la couverture T2 est suffisante : chaque catégorie compte au
 * moins `T2_MIN_CASES_PER_CATEGORY` références approuvées ET la précision
 * mesurée atteint `T2_SEARCH_TARGET`.
 */
export function t2SearchView(entries: readonly ManifestEntry[], statusOf: StatusOf, results: ReadonlyMap<string, CaseResult> | null): T2SearchView {
  const t2 = entries.filter(isT2SearchCase).filter((e) => statusOf(e) !== 'REJETEE');
  const approuves = t2.filter((e) => statusOf(e) === 'REFERENCE_APPROUVEE');
  const res = (e: ManifestEntry) => results?.get(e.id);
  const categories = T2_SEARCH_CATEGORIES.map((c) => {
    const l = t2.filter((e) => e.cdc35Category === c.code);
    const a = l.filter((e) => statusOf(e) === 'REFERENCE_APPROUVEE');
    return {
      code: c.code, label: c.label, total: l.length, approved: a.length,
      executed: a.filter((e) => res(e) && res(e)!.outcome !== 'NOT_RUN').length,
      passed: a.filter((e) => res(e)?.outcome === 'PASSED').length,
      failed: a.filter((e) => res(e)?.outcome === 'FAILED').length,
    };
  });
  const passed = approuves.filter((e) => res(e)?.outcome === 'PASSED').length;
  const failed = approuves.filter((e) => res(e)?.outcome === 'FAILED').length;
  const inconclusive = approuves.filter((e) => res(e)?.outcome === 'INCONCLUSIVE').length;
  const concluded = passed + failed;
  const measured = concluded ? passed / concluded : null;
  const gaps: string[] = [];
  for (const c of categories.filter((x) => x.approved < T2_MIN_CASES_PER_CATEGORY)) {
    gaps.push(`catégorie « ${c.label} » : ${c.approved} référence(s) approuvée(s) sur ${T2_MIN_CASES_PER_CATEGORY} exigées (${c.total} cas au corpus)`);
  }
  const sansCategorie = t2.filter((e) => !e.cdc35Category).length;
  if (sansCategorie) gaps.push(`${sansCategorie} cas T2 de recherche sans catégorie §35.1 : à classer`);
  if (measured == null) gaps.push('précision de recherche non mesurée : aucune référence T2 approuvée exécutée de façon concluante');
  else if (measured < T2_SEARCH_TARGET) gaps.push(`précision de recherche mesurée ${(measured * 100).toFixed(1)} % < ${T2_SEARCH_TARGET * 100} % (§35.3)`);
  if (approuves.length && inconclusive) gaps.push(`${inconclusive} référence(s) T2 non concluante(s) : jamais comptées réussies`);
  const coverageOk = categories.every((c) => c.approved >= T2_MIN_CASES_PER_CATEGORY) && !sansCategorie;
  const verdict: T2SearchView['verdict'] = measured == null ? (coverageOk ? 'NON_MESUREE' : 'INSUFFISANTE') : coverageOk && measured >= T2_SEARCH_TARGET ? 'SUFFISANTE' : 'INSUFFISANTE';
  return {
    target: T2_SEARCH_TARGET, minPerCategory: T2_MIN_CASES_PER_CATEGORY, categories, unclassified: sansCategorie,
    precision: { measured, passed, concluded, inconclusive }, verdict, gaps,
  };
}
