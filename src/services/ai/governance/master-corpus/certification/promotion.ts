/**
 * Lot 100B — application du VERROU A1 aux promotions AUTOMATIQUES de
 * préproduction (arbitrage PO A1) :
 *   · candidate de configuration de la campagne automatique (86A) ;
 *   · révision de prompt de la mise en conformité automatique (99B, #599).
 * Le verrou est évalué sur les résultats de la candidate dans la campagne
 * même (mêmes cas, mêmes appels), journalisé (`ai_corpus_a1_assessments`),
 * et matérialisé par un JETON exigé par `activateQualifiedCandidate` : aucune
 * activation automatique sans verrou levé. L'activation MANUELLE (#345) ne
 * passe jamais par ici.
 */
import type { Treatment } from '../../../config/treatments';
import type { CaseObservation } from '../../../qualification/verdict';
import type { Defect } from '../../../qualification/defects';
import { assessA1, type A1Assessment } from './coverage';
import { caseResultsFrom, loadCertificationState } from './state';

export interface A1Token { allowed: true; rulesVersion: string; assessmentId: number | null; at: string }

type Obs = CaseObservation & { manifestCaseId?: string | null; criticalDefects?: Defect[]; decisions?: string[] };
type Lock = (p: { treatments: Treatment[]; observations: readonly Obs[]; gains: ReadonlyArray<{ operationCode: string; outcome: string }> }) => A1Assessment | Promise<A1Assessment>;
let override: Lock | null = null;

/** Tests : verrou substitué (null : verrou réel, manifeste + approbations). */
export function __setPromotionLockForTests(fn: Lock | null): void { override = fn; }

/** Verrou levé (tests d'autres sujets que la couverture) : aucun manque. */
export const OPEN_LOCK_FOR_TESTS: Lock = (p) => ({
  rulesVersion: 'test', allowed: true, scope: p.treatments, blockers: [], matrix: { rulesVersion: 'test', operations: [], cells: [], risks: [] }, pairs: [], measured: true,
});

export async function assessPromotion(p: {
  context: 'AUTO_CANDIDATE' | 'PROMPT_CONFORMITY';
  environment: string;
  treatments: Treatment[];
  observations: readonly Obs[];
  gains?: ReadonlyArray<{ operationCode: string; outcome: string }>;
  campaignId: number | null;
  candidateVersionId: number | null;
}): Promise<{ assessment: A1Assessment; token: A1Token | null }> {
  const gains = p.gains ?? [];
  let assessment: A1Assessment;
  let manifestVersion = 0;
  if (override) assessment = await override({ treatments: p.treatments, observations: p.observations, gains });
  else {
    const etat = await loadCertificationState();
    manifestVersion = etat.manifest.version;
    assessment = assessA1({ treatments: p.treatments, entries: etat.manifest.entries, statusOf: etat.statusOf, results: caseResultsFrom(p.observations), gains });
  }
  const { recordA1Assessment } = await import('./repository');
  const id = await recordA1Assessment({
    environment: p.environment, context: p.context, campaignId: p.campaignId, candidateVersionId: p.candidateVersionId, treatments: p.treatments,
    allowed: assessment.allowed, rulesVersion: assessment.rulesVersion, manifestVersion, blockers: assessment.blockers,
    summary: { operations: assessment.matrix.operations.map((o) => ({ op: o.operationCode, approved: o.approvedReferences, covered: o.covered })), pairs: assessment.pairs.length },
  });
  return { assessment, token: assessment.allowed ? { allowed: true, rulesVersion: assessment.rulesVersion, assessmentId: id, at: new Date().toISOString() } : null };
}

/** Motif lisible d'un verrou fermé (premiers manques). */
export function a1RefusalMessage(a: A1Assessment, max = 5): string {
  return `Verrou A1 : promotion automatique interdite — ${a.blockers.slice(0, max).map((b) => b.message).join(' ; ')}${a.blockers.length > max ? ` ; … (${a.blockers.length - max} autre(s))` : ''}`;
}
