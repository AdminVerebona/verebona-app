/**
 * Lot 99B — NON-RÉGRESSION d'une révision de prompt (pur, sans base).
 *
 * Campagne CONFORMITY (lot 86A réutilisé) : l'ancienne version ACTIVE
 * (référence) et la candidate sont exécutées dans la MÊME campagne, sur les
 * MÊMES cas (corpus des prompts maîtres, rejeux de préproduction), avec les
 * MÊMES paramètres (même couple opération × modèle × rang, même profil), pour
 * TOUTES les opérations du prompt modifié — pas seulement la branche corrigée.
 *
 * Comparaison SÉMANTIQUE : chaque sortie est jugée par les contrôles serveur
 * déterministes de sa branche contre l'attendu VÉRIFIÉ du corpus (jamais par
 * une comparaison de texte, jamais en prenant la sortie du candidat pour
 * vérité). Une différence de formulation n'est pas une régression ; une
 * empreinte différente de la sortie historique n'est qu'une information.
 *
 * Critères ÉLIMINATOIRES (le premier qui s'applique refuse) :
 *   · un défaut métier du candidat (invention, valeur incorrecte, perte
 *     d'information, rattachement injustifié, schéma, contrôle serveur) ;
 *   · un cas RÉUSSI par l'ancienne version et non réussi par le candidat
 *     (dégradation d'un résultat précédemment correct) ;
 *   · verdict REFUSÉ du couple candidat (délai : plafond, P95 +20 % ;
 *     concurrence) ;
 *   · coût par résultat valide au-delà du seuil (même tolérance que le délai).
 * BLOQUANTS (non concluant — jamais transformés en réussite) :
 *   · verdict NON CONCLUANT d'une opération (cas obligatoire sans attendu
 *     vérifiable, cas non exécuté, erreur fournisseur…) — par exemple T3
 *     VALUE_CONFLICT ou T1 tant que leurs cas ne sont que des gardes ;
 *   · couverture insuffisante de la NOUVELLE branche (aucun cas de référence
 *     qui exerce le contrat) ;
 *   · opération non mesurée.
 * Seul « QUALIFIED » autorise une activation (préproduction seulement).
 */
import type { Observation } from './runner';
import { QUALIFICATION_THRESHOLDS, type QualificationThresholds } from './thresholds';
import type { Reason, Verdict } from './verdict';

export type NonRegressionDecision = 'QUALIFIED' | 'REFUSED' | 'INCONCLUSIVE';

export interface OperationRun {
  operationCode: string;
  reference: { verdict: Verdict; reasons: Reason[]; observations: Observation[]; evidenceId: number | null } | null;
  candidate: { verdict: Verdict; reasons: Reason[]; observations: Observation[]; evidenceId: number | null } | null;
}

export interface CaseComparison {
  caseId: string;
  source: string;
  mandatory: boolean;
  reference: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'NOT_RUN';
  candidate: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'NOT_RUN';
  /** Défauts du candidat (messages des contrôles serveur). */
  defects: string[];
  inconclusive: string | null;
}

export interface OperationAssessment {
  operationCode: string;
  referenceVerdict: Verdict | null;
  candidateVerdict: Verdict | null;
  cases: { total: number; mandatory: number; verifiableMandatory: number; candidatePassed: number; referencePassed: number };
  regressions: CaseComparison[];
  improvements: CaseComparison[];
  inconclusive: CaseComparison[];
  defects: CaseComparison[];
  cost: { referencePerValid: number | null; candidatePerValid: number | null; ratio: number | null };
  reasons: string[];
  decision: NonRegressionDecision;
}

export interface NonRegressionAssessment {
  decision: NonRegressionDecision;
  operations: OperationAssessment[];
  coverage: { required: string | null; matchingCases: string[]; passed: string[]; ok: boolean };
  refusalReasons: string[];
  blockingReasons: string[];
  /** Opérations hors périmètre : branche absente de l'ancienne version ET de la candidate (fonction inactive). */
  excluded?: Array<{ operationCode: string; reason: string }>;
  /** Cas retirés avant exécution : ils exercent un contrat absent des deux versions (ni réussis, ni bloquants). */
  excludedCases?: Array<{ caseId: string; reason: string }>;
  /** Lot 100B : verrou A1 (couverture du corpus #601) — jeton exigé pour l'activation automatique. */
  a1?: { allowed: boolean; blockers: string[]; token: import('../governance/master-corpus/certification/promotion').A1Token | null };
}

type Outcome = CaseComparison['reference'];

/** Issue d'un cas sur toutes ses observations décisives : réussi seulement si TOUTES réussies. */
function outcomeOf(obs: readonly Observation[]): Outcome {
  if (!obs.length) return 'NOT_RUN';
  if (obs.some((o) => o.outcome === 'FAILED')) return 'FAILED';
  if (obs.every((o) => o.outcome === 'PASSED')) return 'PASSED';
  return 'INCONCLUSIVE';
}

const parCas = (obs: readonly Observation[]) => {
  const m = new Map<string, Observation[]>();
  for (const o of obs.filter((x) => !x.advisory)) m.set(o.caseId, [...(m.get(o.caseId) ?? []), o]);
  return m;
};

const coutParValide = (obs: readonly Observation[]): number | null => {
  const conclus = obs.filter((o) => !o.advisory && o.durationMs != null);
  if (!conclus.length || conclus.some((o) => o.costMicros == null)) return null;
  const valides = obs.filter((o) => !o.advisory && o.outcome === 'PASSED').length;
  return valides ? conclus.reduce((s, o) => s + (o.costMicros ?? 0), 0) / valides : null;
};

export function assessNonRegression(p: {
  runs: readonly OperationRun[];
  /** Cas qui exercent la NOUVELLE branche (prédicat du contrat) ; null : aucune exigence propre. */
  coverage: { label: string; caseIds: readonly string[] } | null;
  thresholds?: QualificationThresholds;
}): NonRegressionAssessment {
  const th = p.thresholds ?? QUALIFICATION_THRESHOLDS;
  const operations: OperationAssessment[] = [];
  for (const r of p.runs) {
    const reasons: string[] = [];
    const ref = parCas(r.reference?.observations ?? []);
    const cand = parCas(r.candidate?.observations ?? []);
    const ids = [...new Set([...ref.keys(), ...cand.keys()])].sort();
    const cmp: CaseComparison[] = ids.map((id) => {
      const c = cand.get(id) ?? [];
      const any = c[0] ?? ref.get(id)?.[0];
      return {
        caseId: id, source: any?.source ?? 'CORPUS_FIXTURE', mandatory: Boolean(any?.mandatory),
        reference: outcomeOf(ref.get(id) ?? []), candidate: outcomeOf(c),
        defects: [...new Set(c.flatMap((o) => o.defects.map((d) => `${d.category} : ${d.message}`)))].slice(0, 5),
        inconclusive: c.find((o) => o.inconclusiveReason)?.inconclusiveReason ?? null,
      };
    });
    const regressions = cmp.filter((x) => x.reference === 'PASSED' && x.candidate !== 'PASSED');
    const defects = cmp.filter((x) => x.candidate === 'FAILED');
    const inconclusive = cmp.filter((x) => x.candidate === 'INCONCLUSIVE' || (x.mandatory && x.candidate === 'NOT_RUN'));
    const improvements = cmp.filter((x) => x.candidate === 'PASSED' && x.reference !== 'PASSED');
    const mandatory = cmp.filter((x) => x.mandatory);
    const verifiables = mandatory.filter((x) => (cand.get(x.caseId) ?? []).every((o) => o.expectedSource === 'REFERENCE') && (cand.get(x.caseId) ?? []).length > 0);
    const cRef = coutParValide(r.reference?.observations ?? []);
    const cCand = coutParValide(r.candidate?.observations ?? []);
    const ratio = cRef && cCand != null ? cCand / cRef : null;

    let decision = 'QUALIFIED' as NonRegressionDecision;
    const refuse = (m: string) => { reasons.push(m); decision = 'REFUSED'; };
    const bloque = (m: string) => { reasons.push(m); if (decision !== 'REFUSED') decision = 'INCONCLUSIVE'; };
    if (!r.candidate) bloque('candidate non mesurée');
    if (!r.reference) bloque('ancienne version non mesurée : aucune comparaison possible');
    for (const d of defects) refuse(`cas ${d.caseId} : erreur métier du candidat (${d.defects.join(' ; ') || 'défaut'})`);
    for (const g of regressions.filter((x) => x.candidate !== 'FAILED')) bloque(`cas ${g.caseId} réussi par l’ancienne version, non concluant avec le candidat (${g.inconclusive ?? 'motif non précisé'})`);
    for (const g of regressions.filter((x) => x.candidate === 'FAILED')) reasons.push(`régression : cas ${g.caseId} réussi par l’ancienne version, en échec avec le candidat`);
    if (r.candidate?.verdict === 'REFUSED') {
      for (const x of r.candidate.reasons.filter((y) => y.outcome === 'BLOCKING')) refuse(`${x.step} : ${x.message}`);
      if ((decision as NonRegressionDecision) !== 'REFUSED') refuse('verdict du couple candidat : refusé');
    } else if (r.candidate?.verdict === 'INCONCLUSIVE') {
      for (const x of r.candidate.reasons.filter((y) => y.outcome === 'INCONCLUSIVE')) bloque(`${x.step} : ${x.message}`);
      if ((decision as NonRegressionDecision) === 'QUALIFIED') bloque('verdict du couple candidat : non concluant');
    }
    for (const x of inconclusive.filter((y) => !regressions.includes(y)).slice(0, 5)) {
      if (x.mandatory) bloque(`cas obligatoire ${x.caseId} non concluant (${x.inconclusive ?? 'non exécuté'})`);
    }
    if (ratio != null && ratio > 1 + th.latency.maxP95Degradation) {
      refuse(`coût par résultat valide +${Math.round((ratio - 1) * 100)} % (seuil +${Math.round(th.latency.maxP95Degradation * 100)} %)`);
    }
    operations.push({
      operationCode: r.operationCode, referenceVerdict: r.reference?.verdict ?? null, candidateVerdict: r.candidate?.verdict ?? null,
      cases: {
        total: cmp.length, mandatory: mandatory.length, verifiableMandatory: verifiables.length,
        candidatePassed: cmp.filter((x) => x.candidate === 'PASSED').length, referencePassed: cmp.filter((x) => x.reference === 'PASSED').length,
      },
      regressions, improvements, inconclusive, defects,
      cost: { referencePerValid: cRef, candidatePerValid: cCand, ratio },
      reasons: [...new Set(reasons)], decision,
    });
  }
  // Couverture de la nouvelle branche : au moins un cas de référence qui l'exerce, réussi par le candidat.
  const cands = new Map<string, Outcome>();
  for (const r of p.runs) for (const [id, obs] of parCas(r.candidate?.observations ?? [])) {
    if (obs.every((o) => o.expectedSource === 'REFERENCE' && o.mandatory)) cands.set(id, outcomeOf(obs));
  }
  const matching = (p.coverage?.caseIds ?? []).filter((id) => cands.has(id));
  const passed = matching.filter((id) => cands.get(id) === 'PASSED');
  const coverage = { required: p.coverage?.label ?? null, matchingCases: matching, passed, ok: !p.coverage || passed.length > 0 };

  const refusalReasons = operations.filter((o) => o.decision === 'REFUSED').flatMap((o) => o.reasons.map((m) => `${o.operationCode} — ${m}`));
  const blockingReasons = operations.filter((o) => o.decision === 'INCONCLUSIVE').flatMap((o) => o.reasons.map((m) => `${o.operationCode} — ${m}`));
  if (!operations.length) blockingReasons.push('aucune opération mesurée : couverture insuffisante');
  if (!coverage.ok) {
    blockingReasons.push(matching.length
      ? `couverture de la nouvelle branche insuffisante : ${p.coverage!.label} présents (${matching.join(', ')}) mais aucun réussi`
      : `couverture de la nouvelle branche insuffisante : aucun ${p.coverage!.label} dans le corpus`);
  }
  const decision: NonRegressionDecision = refusalReasons.length ? 'REFUSED' : blockingReasons.length ? 'INCONCLUSIVE' : 'QUALIFIED';
  return { decision, operations, coverage, refusalReasons, blockingReasons };
}
