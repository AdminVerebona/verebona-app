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
 *
 * Lot 105B : le jeton n'est plus qu'une RÉCLAMATION — il désigne l'évaluation
 * journalisée (identifiant), la campagne, la candidate, le périmètre et
 * l'EMPREINTE DE CONTEXTE A1 (règles, référentiel d'inventaire, manifeste,
 * certification des opérations du périmètre). `activateQualifiedCandidate`
 * revalide TOUT depuis la base (`qualification/promotion-gate.ts`) : un objet
 * `allowed: true` fourni, forgé ou obsolète n'est jamais suffisant.
 */
import type { Treatment } from '../../../config/treatments';
import type { CaseObservation } from '../../../qualification/verdict';
import type { Defect } from '../../../qualification/defects';
import { canonicalJson, sha256 } from '../../../qualification/signature';
import { activeQualificationOperations } from './model';
import { assessA1, structuralBlockers, A1_RULES_VERSION, type A1Assessment, type A1Blocker } from './coverage';
import { currentExpectedInventory } from './expected-inventory';
import { certificationFingerprint } from './manifest';
import { caseResultsFrom, loadCertificationState, type CertificationState } from './state';

export type PromotionContext = 'AUTO_CANDIDATE' | 'PROMPT_CONFORMITY';

/**
 * Réclamation de verrou levé (lot 105B : jamais une preuve en soi). Revalidée depuis la base à la frontière
 * d'activation et dans la transaction finale.
 */
export interface A1Token {
  allowed: true; rulesVersion: string; assessmentId: number | null; at: string;
  campaignId?: number | null; candidateVersionId?: number | null; treatments?: Treatment[]; context?: PromotionContext; contextFingerprint?: string;
}

/**
 * Lot 105B — EMPREINTE DE CONTEXTE A1 d'un périmètre : version des règles, référentiel d'inventaire (version et
 * contenu), version du manifeste, opérations ACTIVES du périmètre (registre courant) et empreinte de certification
 * de chacune (oracles, approbations, rejets). Toute évolution pertinente change l'empreinte : une décision A1
 * antérieure n'est plus courante, une candidate bloquée A1 peut être réévaluée.
 */
export async function a1ContextFingerprint(treatments: readonly Treatment[], state?: CertificationState): Promise<{ fingerprint: string; parts: Record<string, unknown> }> {
  const etat = state ?? await loadCertificationState();
  const inv = currentExpectedInventory();
  const ops = activeQualificationOperations().filter((o) => treatments.includes(o.treatment)).map((o) => o.operationCode).sort();
  const parts = {
    rulesVersion: A1_RULES_VERSION, inventoryVersion: inv.version, inventory: sha256(canonicalJson(inv)), manifestVersion: etat.manifest.version,
    treatments: [...treatments].sort(), operations: ops,
    certification: Object.fromEntries(ops.map((op) => [op, certificationFingerprint(etat.manifest, op, etat.approvals, etat.decisions)])),
    // Totaux rapprochés (inventaire global) : un import de cas hors périmètre peut lever un manque de total.
    entries: etat.manifest.entries.length,
  };
  return { fingerprint: sha256(canonicalJson(parts)), parts };
}

/**
 * Lot 105B — manques STRUCTURELS actuels d'un périmètre (matrice seule, sans résultats) : tant qu'il en reste, une
 * candidate bloquée A1 n'est pas relancée (aucun appel ne peut les combler).
 */
export async function structuralA1(treatments: Treatment[]): Promise<A1Blocker[]> {
  if (override) {
    const a = await override({ treatments, observations: [], gains: [] });
    return a.allowed ? [] : structuralBlockers(a);
  }
  const etat = await loadCertificationState();
  return structuralBlockers(assessA1({ treatments, entries: etat.manifest.entries, statusOf: etat.statusOf, results: null }));
}

type Obs = CaseObservation & { manifestCaseId?: string | null; criticalDefects?: Defect[]; decisions?: string[] };
type Lock = (p: { treatments: Treatment[]; observations: readonly Obs[]; gains: ReadonlyArray<{ operationCode: string; outcome: string }> }) => A1Assessment | Promise<A1Assessment>;
let override: Lock | null = null;

/** Tests : verrou substitué (null : verrou réel, manifeste + approbations). */
export function __setPromotionLockForTests(fn: Lock | null): void { override = fn; }

/** Verrou levé (tests d'autres sujets que la couverture) : aucun manque. */
export const OPEN_LOCK_FOR_TESTS: Lock = (p) => ({
  rulesVersion: 'test', allowed: true, scope: p.treatments, blockers: [], matrix: { rulesVersion: 'test', operations: [], cells: [], risks: [] }, pairs: [], measured: true, inventory: null,
});

/** Tests : verrou substitué en vigueur ? (la revalidation d'activation l'applique aussi). */
export function promotionLockOverride(): Lock | null { return override; }

export async function assessPromotion(p: {
  context: PromotionContext;
  environment: string;
  treatments: Treatment[];
  observations: readonly Obs[];
  gains?: ReadonlyArray<{ operationCode: string; outcome: string }>;
  campaignId: number | null;
  candidateVersionId: number | null;
}): Promise<{ assessment: A1Assessment; token: A1Token | null; contextFingerprint: string; assessmentId: number | null }> {
  const gains = p.gains ?? [];
  let assessment: A1Assessment;
  const etat = await loadCertificationState();
  const manifestVersion = etat.manifest.version;
  if (override) assessment = await override({ treatments: p.treatments, observations: p.observations, gains });
  else assessment = assessA1({ treatments: p.treatments, entries: etat.manifest.entries, statusOf: etat.statusOf, results: caseResultsFrom(p.observations), gains });
  const ctx = await a1ContextFingerprint(p.treatments, etat);
  const { recordA1Assessment } = await import('./repository');
  const id = await recordA1Assessment({
    environment: p.environment, context: p.context, campaignId: p.campaignId, candidateVersionId: p.candidateVersionId, treatments: p.treatments,
    allowed: assessment.allowed, rulesVersion: assessment.rulesVersion, manifestVersion, blockers: assessment.blockers,
    summary: {
      operations: assessment.matrix.operations.map((o) => ({ op: o.operationCode, approved: o.approvedReferences, covered: o.covered })), pairs: assessment.pairs.length,
      // Lot 105B : version de référence de la décision (revalidée à l'activation).
      contextFingerprint: ctx.fingerprint, inventoryVersion: ctx.parts.inventoryVersion, structural: structuralBlockers(assessment).length,
    },
  });
  return {
    assessment,
    token: assessment.allowed ? {
      allowed: true, rulesVersion: assessment.rulesVersion, assessmentId: id, at: new Date().toISOString(),
      campaignId: p.campaignId, candidateVersionId: p.candidateVersionId, treatments: [...p.treatments], context: p.context, contextFingerprint: ctx.fingerprint,
    } : null,
    contextFingerprint: ctx.fingerprint,
    assessmentId: id,
  };
}

/** Motif lisible d'un verrou fermé (premiers manques). */
export function a1RefusalMessage(a: A1Assessment, max = 5): string {
  return `Verrou A1 : promotion automatique interdite — ${a.blockers.slice(0, max).map((b) => b.message).join(' ; ')}${a.blockers.length > max ? ` ; … (${a.blockers.length - max} autre(s))` : ''}`;
}
