/**
 * Lot 111K — bloc `pertinence` de la trace T2 EXISTANTE
 * (`verebona_request_runs.retrieval_methods_json.pertinence`), aucun journal
 * concurrent. Module PUR.
 *
 * Pour chaque demande sur les données du compte : intention et propriétés
 * recherchées (clés du registre ; tête hors registre EXPURGÉE), nature et
 * qualification attendues, période, périmètre, candidats évalués (acceptés,
 * incertains, rejetés par motif), décision de suffisance et pluralité,
 * conflits RÉELLEMENT établis (identifiants de faits), chemin de production,
 * résultat du contrôle final, issue et motif.
 *
 * Le MOTIF reprend le vocabulaire du journal BO « Questions sans réponse »
 * (lot 110E, `unanswered-journal`) ; la CAUSE distingue ce que le motif
 * « données insuffisantes » regroupait (CA-12) : absence de donnée, preuve
 * rejetée, correspondance incertaine, conflit réel, défaut de production.
 *
 * Confidentialité : aucun texte de document ni valeur ; la tête de la
 * propriété demandée (un mot de la question) passe par la même expurgation
 * que le journal (`redact`), et la trace suit la conservation existante.
 */
import type { CandidateVerdict } from './candidate-validation';
import type { FinalControlResult } from './final-answer-control';
import type { QuestionFocus } from './question-focus';
import type { UnansweredMotive } from './resources-answer';
import { redact } from './redaction.service';

export type PertinenceOutcome = 'ANSWERED' | 'PARTIAL' | 'CONFLICT' | 'INSUFFICIENT';
export type PertinenceCause = 'NO_DATA' | 'EVIDENCE_REJECTED' | 'EVIDENCE_UNCERTAIN' | 'REAL_CONFLICT' | 'PRODUCTION_REJECTED';

export interface PertinenceTrace {
  version: 1;
  intent: string;
  focus: {
    registryKeys: string[];
    /** Tête de la propriété hors registre, expurgée (≤ 40 caractères). */
    headTerm: string | null;
    propertyTermCount: number;
    topicCount: number;
    valueNature: string | null;
    qualification: string | null;
    asksSettlement: boolean;
    yesNo: boolean;
    period: string | null;
    composite: boolean;
  };
  scope: { kind: string; objectType: string | null; objectId: number | null } | null;
  candidates: { evaluated: number; admissible: number; uncertain: number; rejected: number; byReason: Record<string, number> };
  sufficiency: { status: string | null; reason: string | null; plurality: string | null } | null;
  /** Conflits réels établis : faits en désaccord (identifiants seulement). */
  conflicts: Array<{ factIds: number[] }>;
  production: { strategy: string; answeredBy: string } | null;
  finalControl: { verdict: string; path: string; reasons: string[]; rejectedClaims: number; missing: number } | null;
  outcome: PertinenceOutcome | null;
  cause: PertinenceCause | null;
  motive: UnansweredMotive | null;
}

/** Résumé du focus pour la trace (pure). */
export function focusTrace(f: QuestionFocus): PertinenceTrace['focus'] {
  return {
    registryKeys: [...f.registryKeys],
    headTerm: f.headTerm ? redact(f.headTerm).slice(0, 40) : null,
    propertyTermCount: f.propertyTerms.length,
    topicCount: f.topics.length,
    valueNature: f.valueNature,
    qualification: f.qualification,
    asksSettlement: f.asksSettlement,
    yesNo: f.yesNo,
    period: f.period ? `${f.period.from}/${f.period.to}` : null,
    composite: f.composite,
  };
}

/** Bloc initial, posé à l'issue de la lecture des données (pure). */
export function startPertinenceTrace(p: {
  intent: string;
  focus: QuestionFocus;
  scope: PertinenceTrace['scope'];
  candidates: readonly CandidateVerdict[];
  conflicts: Array<{ factIds: number[] }>;
  sufficiency: PertinenceTrace['sufficiency'];
}): PertinenceTrace {
  const byReason: Record<string, number> = {};
  for (const c of p.candidates) if (c.decision !== 'KEPT') byReason[c.reason] = (byReason[c.reason] ?? 0) + 1;
  return {
    version: 1, intent: p.intent, focus: focusTrace(p.focus), scope: p.scope,
    candidates: {
      evaluated: p.candidates.length,
      admissible: p.candidates.filter((c) => c.decision === 'KEPT').length,
      uncertain: p.candidates.filter((c) => c.decision === 'UNCERTAIN').length,
      rejected: p.candidates.filter((c) => c.decision === 'REJECTED').length,
      byReason,
    },
    sufficiency: p.sufficiency, conflicts: p.conflicts.map((c) => ({ factIds: c.factIds.slice(0, 6) })),
    production: null, finalControl: null, outcome: null, cause: null, motive: null,
  };
}

/** Résultat du contrôle final, pour la trace (pure). */
export function finalControlTrace(r: FinalControlResult): NonNullable<PertinenceTrace['finalControl']> {
  return { verdict: r.verdict, path: r.path, reasons: [...r.reasons], rejectedClaims: r.rejected.length, missing: r.missing.length };
}

/**
 * Issue, cause et motif d'une demande (pure, testée) — calculés sur le
 * résultat FINAL. Motifs alignés sur le journal « Questions sans réponse ».
 */
export function concludePertinence(t: PertinenceTrace, r: { supportLevel: string | null; sourceCount: number; strategy: string; answeredBy: string; clarification: boolean; claimCount?: number }): PertinenceTrace {
  const fc = t.finalControl;
  let outcome: PertinenceOutcome;
  if (r.clarification) outcome = 'PARTIAL';
  else if (fc?.verdict === 'REJECTED' || r.supportLevel === 'insufficient') outcome = 'INSUFFICIENT';
  else if (r.supportLevel === 'conflicting' || t.sufficiency?.status === 'CONFLICTING' && r.strategy === 'retrieval.t1_fact') outcome = 'CONFLICT';
  else if (r.supportLevel === 'partial' || fc?.verdict === 'PARTIAL') outcome = 'PARTIAL';
  else if (r.sourceCount === 0 && (r.answeredBy === 'fallback' || r.strategy.startsWith('fallback.') || r.claimCount === 0)) outcome = 'INSUFFICIENT';
  else outcome = 'ANSWERED';
  let cause: PertinenceCause | null = null;
  if (outcome === 'CONFLICT') cause = 'REAL_CONFLICT';
  else if (outcome === 'INSUFFICIENT') {
    cause = fc?.verdict === 'REJECTED' ? 'PRODUCTION_REJECTED'
      : t.candidates.uncertain > 0 ? 'EVIDENCE_UNCERTAIN'
        : t.candidates.rejected > 0 ? 'EVIDENCE_REJECTED' : 'NO_DATA';
  }
  const motive: UnansweredMotive | null = outcome === 'CONFLICT' ? 'CONTRADICTION_AMBIGUITY'
    : cause === 'PRODUCTION_REJECTED' ? 'QUALITY_ALERT'
      : outcome === 'INSUFFICIENT' ? 'ACCOUNT_DATA_INSUFFICIENT'
        : outcome === 'PARTIAL' && (fc?.missing ?? 0) > 0 ? 'PARTIAL_COVERAGE' : null;
  return { ...t, production: { strategy: r.strategy, answeredBy: r.answeredBy }, outcome, cause, motive };
}
