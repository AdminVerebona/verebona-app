/**
 * Lot 100B — service BO du corpus de qualification certifié (Configuration
 * IA › Corpus de qualification) : manifeste et statuts, matrice de couverture
 * et verrou A1, vue T2 (CDC 4 §35), approbation INDIVIDUELLE des oracles,
 * rejets motivés, exclusions, coûts mesurés, rapports de mutation, rapports
 * exportables. Préproduction et production : lecture ; les approbations
 * sont des décisions humaines tracées (qui, quand, sur quelles sources).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pgClient } from '@/db';
import type { Treatment } from '../../../config/treatments';
import { TREATMENTS } from '../../../config/treatments';
import { activeQualificationOperations, CASE_STATUS_LABELS, HISTORICAL_CLASS_LABELS, RISK_FAMILY_LABELS, type ManifestEntry } from './model';
import { MANIFEST_PATH, effectiveStatus } from './manifest';
import { oracleApprovalProblems, oracleFingerprint } from './oracle';
import { assessA1, a1Notices, buildCoverageMatrix, t2SearchView, A1_CODE_LABELS, type CaseResult } from './coverage';
import { runMutationSuite, MUTATION_LABELS, type MutationReport } from './mutations';
import { loadCertificationState, type CertificationState } from './state';
import * as repo from './repository';

export class CorpusActionRefused extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'CorpusActionRefused'; }
}

// ── Résultats mesurés (dernières preuves des couples actifs de rang 0) ─────

/** Résultats par cas du manifeste, d'après la dernière preuve COURANTE (signature identique) de chaque opération. */
export async function latestResults(state: CertificationState): Promise<{ results: Map<string, CaseResult>; evidence: Array<{ operationCode: string; evidenceId: number; model: string; verdict: string; at: string }> }> {
  const results = new Map<string, CaseResult>();
  const evidence: Array<{ operationCode: string; evidenceId: number; model: string; verdict: string; at: string }> = [];
  let rows: Array<{ id: number; operationCode: string; rank: number; model: string; verdict: string; createdAt: string; currentState?: string }> = [];
  try {
    const { listQualificationEvidence } = await import('../../../qualification/service');
    rows = (await listQualificationEvidence({ latestPerCouple: true })) as never;
  } catch { rows = []; }
  const parOp = new Map<string, (typeof rows)[number]>();
  for (const r of rows.filter((x) => x.rank === 0 && x.currentState !== 'OBSOLETE')) if (!parOp.has(r.operationCode)) parOp.set(r.operationCode, r);
  for (const r of parOp.values()) evidence.push({ operationCode: r.operationCode, evidenceId: r.id, model: r.model, verdict: r.verdict, at: String(r.createdAt) });
  const cases = await repo.latestCaseOutcomes([...parOp.values()].map((r) => r.id));
  const bySource = new Map<string, ManifestEntry[]>();
  for (const e of state.manifest.entries) if (e.sourceCaseId) bySource.set(e.sourceCaseId, [...(bySource.get(e.sourceCaseId) ?? []), e]);
  const groupes = new Map<string, typeof cases>();
  for (const c of cases) {
    const id = c.manifestCaseId ?? (() => {
      const brut = c.caseId.replace(/^corpus:/, '');
      const l = (bySource.get(brut) ?? []).filter((e) => e.operationCode === c.operationCode);
      return l.length === 1 ? l[0].id : null;
    })();
    if (id) groupes.set(id, [...(groupes.get(id) ?? []), c]);
  }
  for (const [id, l] of groupes) {
    const outcome = l.some((o) => o.outcome === 'FAILED') ? 'FAILED' : l.every((o) => o.outcome === 'PASSED') ? 'PASSED' : 'INCONCLUSIVE';
    const defects = l.flatMap((o) => o.defects as CaseResult['defects']);
    results.set(id, { caseId: id, outcome, decisions: [], defects, criticalDefects: state.byId.get(id)?.critical ? defects : [], inconclusiveReason: l.find((o) => o.inconclusiveReason)?.inconclusiveReason ?? null });
  }
  return { results, evidence };
}

// ── Vue d'ensemble ─────────────────────────────────────────────────────────

async function adminEmails(ids: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  if (!ids.length) return m;
  try {
    const rows = (await pgClient.unsafe(`SELECT id, email FROM users WHERE id = ANY($1::int[])`, [ids] as never[])) as unknown as Array<{ id: number; email: string }>;
    for (const r of rows) m.set(Number(r.id), String(r.email));
  } catch { /* lecture facultative */ }
  return m;
}

/** Rapports d'import (fichiers `imports/*.json` du dépôt). */
export function importReports(): Array<{ file: string; at: string; source: string; totals: Record<string, number> }> {
  const dir = join(dirname(MANIFEST_PATH), 'imports');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse().map((f) => {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { at: string; source: { name: string }; totals: Record<string, number> };
      return { file: f, at: r.at, source: r.source.name, totals: r.totals };
    } catch { return { file: f, at: '', source: '?', totals: {} }; }
  });
}

/** Suites de mutation des oracles disposant d'une sortie de référence (sortie enregistrée d'un cas « réponse »). */
export async function mutationReports(state: CertificationState): Promise<MutationReport[]> {
  const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('../cases');
  const cases = loadMasterCorpusCases(readMasterFileFromRepo);
  const out: MutationReport[] = [];
  for (const e of state.manifest.entries) {
    if (!e.oracle || !e.file || e.evaluationType !== 'ORACLE') continue;
    const c = cases.find((x) => x.file.replace(/\\/g, '/') === e.file);
    if (!c || c.output === undefined || c.qualificationRole === 'guard') continue;
    if (!e.oracle.requiredFacts.length && !e.oracle.entities.expected.length && !e.oracle.decisions.allowed.length) continue;
    out.push(runMutationSuite(e.id, e.oracle, c.output));
  }
  return out;
}

export async function corpusOverview(opts: { treatment?: Treatment | null } = {}) {
  const state = await loadCertificationState();
  const { getAiEnvironment } = await import('../../../config/environment');
  const environment = getAiEnvironment();
  const { results, evidence } = await latestResults(state);
  const approvals = await repo.listApprovals();
  const emails = await adminEmails([...new Set(approvals.map((a) => a.adminUserId).filter((x): x is number => x != null))]);
  const who = (a: { adminUserId: number | null; by: string }) => (a.adminUserId != null ? emails.get(a.adminUserId) ?? a.by : a.by);
  const entries = state.manifest.entries.filter((e) => !opts.treatment || e.treatment === opts.treatment).map((e) => {
    const eff = effectiveStatus(e, state.approvals, state.decisions);
    const mine = approvals.filter((a) => a.caseId === e.id);
    const sources = sourceChoices(e);
    return {
      id: e.id, sourceCaseId: e.sourceCaseId, file: e.file, operationCode: e.operationCode, treatment: e.treatment, contract: e.contract,
      riskFamily: e.riskFamily, riskLabel: e.riskFamily ? RISK_FAMILY_LABELS[e.riskFamily] ?? e.riskFamily : null, difficulty: e.difficulty, critical: e.critical,
      pair: e.pair, provenance: e.provenance, inputMode: e.inputMode, testType: e.testType, evaluationType: e.evaluationType,
      declaredStatus: e.status, status: eff.status, statusLabel: CASE_STATUS_LABELS[eff.status], reason: eff.reason,
      historicalClass: e.historicalClass, historicalClassLabel: e.historicalClass ? HISTORICAL_CLASS_LABELS[e.historicalClass] : null, cdc35Category: e.cdc35Category ?? null,
      oracle: e.oracle, oracleFingerprint: oracleFingerprint(e.oracle), approvalProblems: e.evaluationType === 'ORACLE' && e.status === 'A_COMPLETER' ? oracleApprovalProblems(e.oracle) : [],
      approvable: e.evaluationType === 'ORACLE' && e.status === 'A_COMPLETER' && eff.status !== 'REJETEE' && !oracleApprovalProblems(e.oracle).length,
      sourceChoices: sources, requiredSources: requiredSources(e),
      approval: eff.approval ? { by: who(mine.find((a) => a.at === eff.approval!.at) ?? { adminUserId: null, by: eff.approval.by }), at: eff.approval.at, sources: mine.find((a) => a.at === eff.approval!.at)?.sources ?? [] } : null,
      staleApproval: eff.staleApproval ? { by: eff.staleApproval.by, at: eff.staleApproval.at } : null,
      history: mine.slice(0, 10).map((a) => ({ decision: a.decision, at: a.at, by: who(a), sources: a.sources, comment: a.comment, channel: a.channel, oracleFingerprint: a.oracleFingerprint.slice(0, 12) })),
      revisions: e.revisions.slice(-5),
      expectedSummary: e.expectedSummary, sourcePieces: e.sourcePieces,
      result: results.get(e.id) ?? null,
    };
  });
  const scope = opts.treatment ? [opts.treatment] : [...TREATMENTS];
  const a1 = scope.map((t) => {
    const a = assessA1({ treatments: [t], entries: state.manifest.entries, statusOf: state.statusOf, results: results.size ? results : null });
    return { treatment: t, allowed: a.allowed, blockers: a.blockers, byCode: Object.entries(a.blockers.reduce<Record<string, number>>((m, b) => ({ ...m, [b.code]: (m[b.code] ?? 0) + 1 }), {})).map(([code, n]) => ({ code, label: A1_CODE_LABELS[code as keyof typeof A1_CODE_LABELS], n })), pairs: a.pairs };
  });
  const mutations = await mutationReports(state);
  return {
    readAt: new Date().toISOString(),
    environment,
    manifest: { version: state.manifest.version, generatedAt: state.manifest.generatedAt, reference: state.manifest.reference, entries: state.manifest.entries.length },
    activeOperations: activeQualificationOperations(),
    counts: countBy(state, (e) => state.statusOf(e)),
    countsByClass: countBy(state, (e) => e.historicalClass ?? '—', (e) => e.provenance === 'HISTORIQUE_86'),
    matrix: buildCoverageMatrix(state.manifest.entries, state.statusOf, undefined, opts.treatment ? [opts.treatment] : undefined),
    a1,
    t2: t2SearchView(state.manifest.entries, state.statusOf, results.size ? results : null),
    exclusions: state.manifest.entries.filter((e) => ['HISTORIQUE', 'REJETEE'].includes(state.statusOf(e)) || (state.statusOf(e) === 'A_COMPLETER' && !e.file))
      .map((e) => ({ id: e.id, operationCode: e.operationCode, status: CASE_STATUS_LABELS[state.statusOf(e)], reason: effectiveStatus(e, state.approvals, state.decisions).reason })),
    evidence,
    costs: await repo.costRows(),
    mutations: {
      reports: mutations.length,
      applicable: mutations.reduce((n, r) => n + r.summary.applicable, 0),
      ok: mutations.reduce((n, r) => n + r.summary.ok, 0),
      failures: mutations.flatMap((r) => r.rows.filter((x) => x.outcome !== 'NOT_APPLICABLE' && !x.ok)).slice(0, 50).map((x) => ({ ...x, label: MUTATION_LABELS[x.mutation] })),
    },
    imports: importReports(),
    a1Journal: await repo.listA1Assessments(10),
    entries,
  };
}

function countBy(state: CertificationState, f: (e: ManifestEntry) => string, only: (e: ManifestEntry) => boolean = () => true): Record<string, number> {
  const m: Record<string, number> = {};
  for (const e of state.manifest.entries.filter(only)) { const k = f(e); m[k] = (m[k] ?? 0) + 1; }
  return m;
}

/** Sources proposées à la vérification (preuves de l'oracle, pièces, contexte). */
export function sourceChoices(e: ManifestEntry): string[] {
  return [...new Set([
    ...(e.oracle?.requiredFacts.flatMap((f) => f.evidence.map((x) => x.source)) ?? []),
    ...e.sourcePieces.map((p) => p.path),
    ...(e.file ? [`contexte du cas (${e.file.split('/').pop()})`] : []),
  ])];
}

/** Sources qu'il FAUT avoir vérifiées pour approuver : preuves des faits critiques et pièces. */
export function requiredSources(e: ManifestEntry): string[] {
  return [...new Set([
    ...(e.oracle?.requiredFacts.filter((f) => f.critical).flatMap((f) => f.evidence.map((x) => x.source)) ?? []),
    ...e.sourcePieces.map((p) => p.path),
  ])];
}

// ── Gestes BO (un cas à la fois, jamais en masse) ──────────────────────────

export async function approveOracle(p: {
  caseId: string; oracleFingerprint: string; sources: string[]; comment?: string | null; adminUserId: number; channel: 'desktop' | 'mobile';
}): Promise<{ approvalId: number }> {
  const state = await loadCertificationState();
  const e = state.byId.get(p.caseId);
  if (!e) throw new CorpusActionRefused('UNKNOWN_CASE', `Cas ${p.caseId} absent du manifeste.`, 404);
  const eff = effectiveStatus(e, state.approvals, state.decisions);
  if (eff.status === 'REJETEE') throw new CorpusActionRefused('CASE_REJECTED', 'Cas rejeté : rétablissez-le avant toute approbation.');
  if (e.evaluationType !== 'ORACLE' || e.status !== 'A_COMPLETER') {
    throw new CorpusActionRefused('NOT_APPROVABLE', `Ce cas (${CASE_STATUS_LABELS[e.status]}) ne s’approuve pas comme référence : ${e.status === 'GARDE_SERVEUR' ? 'une garde serveur n’est jamais une référence de promotion' : e.status === 'E2E_METIER' ? 'scénario E2E, jugé par son harnais' : e.reason}.`);
  }
  const fp = oracleFingerprint(e.oracle);
  if (!fp || fp !== p.oracleFingerprint) throw new CorpusActionRefused('ORACLE_CHANGED', 'L’oracle a changé depuis l’affichage : rechargez et relisez la nouvelle version avant d’approuver.', 409);
  if (eff.status === 'REFERENCE_APPROUVEE') throw new CorpusActionRefused('ALREADY_APPROVED', 'Cet oracle est déjà approuvé.', 409);
  const problems = oracleApprovalProblems(e.oracle);
  if (problems.length) throw new CorpusActionRefused('ORACLE_INCOMPLETE', `Oracle non approuvable : ${problems.join(' ; ')}.`);
  const sources = [...new Set(p.sources.map((s) => s.trim()).filter(Boolean))];
  if (!sources.length) throw new CorpusActionRefused('SOURCES_REQUIRED', 'Indiquez les sources vérifiées (pièces, contexte) : une approbation se fait sur les sources, jamais sur une sortie de modèle.');
  const manquantes = requiredSources(e).filter((s) => !sources.includes(s));
  if (manquantes.length) throw new CorpusActionRefused('SOURCES_INCOMPLETE', `Sources à vérifier avant d’approuver : ${manquantes.join(', ')}.`);
  if (sources.some((s) => /^(recording|sortie|output|mod[eè]le)\b/i.test(s))) throw new CorpusActionRefused('MODEL_OUTPUT_SOURCE', 'Une sortie de modèle n’est jamais une source d’approbation.');
  const id = await repo.insertApproval({
    caseId: e.id, manifestVersion: state.manifest.version, oracleVersion: e.oracle!.version, oracleFingerprint: fp, decision: 'APPROVED', sources,
    comment: p.comment?.slice(0, 2000) ?? null, adminUserId: p.adminUserId, adminLabel: `administrateur n° ${p.adminUserId}`, channel: p.channel,
  });
  return { approvalId: id };
}

export async function revokeApproval(p: { caseId: string; reason: string; adminUserId: number; channel: 'desktop' | 'mobile' }): Promise<{ approvalId: number }> {
  const state = await loadCertificationState();
  const e = state.byId.get(p.caseId);
  if (!e) throw new CorpusActionRefused('UNKNOWN_CASE', `Cas ${p.caseId} absent du manifeste.`, 404);
  const eff = effectiveStatus(e, state.approvals, state.decisions);
  if (eff.status !== 'REFERENCE_APPROUVEE') throw new CorpusActionRefused('NOT_APPROVED', 'Aucune approbation courante à révoquer.', 409);
  if (p.reason.trim().length < 5) throw new CorpusActionRefused('REASON_REQUIRED', 'Motif de révocation obligatoire.');
  const id = await repo.insertApproval({
    caseId: e.id, manifestVersion: state.manifest.version, oracleVersion: e.oracle?.version ?? null, oracleFingerprint: oracleFingerprint(e.oracle)!, decision: 'REVOKED', sources: [],
    comment: p.reason.slice(0, 2000), adminUserId: p.adminUserId, adminLabel: `administrateur n° ${p.adminUserId}`, channel: p.channel,
  });
  return { approvalId: id };
}

export async function setCaseRejected(p: { caseId: string; rejected: boolean; reason: string; adminUserId: number }): Promise<{ decisionId: number }> {
  const state = await loadCertificationState();
  const e = state.byId.get(p.caseId);
  if (!e) throw new CorpusActionRefused('UNKNOWN_CASE', `Cas ${p.caseId} absent du manifeste.`, 404);
  if (p.reason.trim().length < 5) throw new CorpusActionRefused('REASON_REQUIRED', 'Motif obligatoire (5 caractères au moins) : aucun rejet silencieux.');
  const courant = effectiveStatus(e, state.approvals, state.decisions).status;
  if (p.rejected && courant === 'REJETEE') throw new CorpusActionRefused('ALREADY_REJECTED', 'Cas déjà rejeté.', 409);
  if (!p.rejected && courant !== 'REJETEE') throw new CorpusActionRefused('NOT_REJECTED', 'Cas non rejeté.', 409);
  const id = await repo.insertDecision({ caseId: e.id, status: p.rejected ? 'REJETEE' : 'RETABLIE', reason: p.reason.slice(0, 1000), adminUserId: p.adminUserId, adminLabel: `administrateur n° ${p.adminUserId}` });
  return { decisionId: id };
}

// ── Activation manuelle (#345) : matrice et manques, jamais bloquants ─────

export async function a1NoticesFor(treatment: Treatment): Promise<{ allowed: boolean; notices: string[]; blockers: number }> {
  try {
    const state = await loadCertificationState();
    const { results } = await latestResults(state);
    const a = assessA1({ treatments: [treatment], entries: state.manifest.entries, statusOf: state.statusOf, results: results.size ? results : null });
    return { allowed: a.allowed, notices: a1Notices(a), blockers: a.blockers.length };
  } catch (e) {
    return { allowed: false, notices: [`Verrou A1 : matrice de couverture illisible (${(e as Error).message.slice(0, 120)}).`], blockers: 1 };
  }
}

// ── Rapport exportable ─────────────────────────────────────────────────────

export async function corpusReport(format: 'json' | 'csv'): Promise<{ body: string; contentType: string; filename: string }> {
  const o = await corpusOverview();
  const d = o.readAt.slice(0, 10);
  if (format === 'json') {
    const { entries, ...reste } = o;
    const body = JSON.stringify({ ...reste, entries: entries.map(({ oracle, history, revisions, ...x }) => ({ ...x, oracleVersion: oracle?.version ?? null, approvals: history.length, lastRevision: revisions.at(-1) ?? null })) }, null, 2);
    return { body, contentType: 'application/json; charset=utf-8', filename: `corpus-qualification-${d}.json` };
  }
  const cols = ['id', 'cas_origine', 'operation', 'traitement', 'contrat', 'famille_risque', 'niveau', 'critique', 'paire', 'cote', 'provenance', 'mode_entree', 'type_test', 'type_evaluation', 'statut', 'motif', 'classement_historique', 'version_oracle', 'approuve_par', 'approuve_le', 'resultat'];
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lignes = o.entries.map((e) => [e.id, e.sourceCaseId, e.operationCode, e.treatment, e.contract, e.riskFamily, e.difficulty, e.critical ? 'oui' : 'non', e.pair?.id, e.pair?.side, e.provenance, e.inputMode, e.testType, e.evaluationType,
    e.statusLabel, e.reason, e.historicalClassLabel, e.oracle?.version, e.approval?.by, e.approval?.at, e.result?.outcome].map(esc).join(';'));
  return { body: `﻿${cols.join(';')}\n${lignes.join('\n')}\n`, contentType: 'text/csv; charset=utf-8', filename: `corpus-qualification-${d}.csv` };
}
