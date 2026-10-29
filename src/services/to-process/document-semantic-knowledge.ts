/**
 * Lot 85F — constats SÉMANTIQUES T3 (connaissance T1 persistée, validés par
 * le serveur) → entrées du moteur « À traiter » EXISTANT. Partie PURE.
 *
 * Une compréhension IA ne devient JAMAIS une écriture canonique directe
 * (ticket §8) :
 *   · valeur de la donnée → PROPOSITION du moteur de décision (`decide()`),
 *     confiance au plus `SEMANTIC_PROPOSAL_CONFIDENCE` — sous le seuil
 *     d'écriture automatique : la valeur est soumise, jamais écrite seule ;
 *   · contradiction → toutes les valeurs, confiance basse : arbitrage ;
 *   · constituants → faits du calcul EXISTANT, source distincte de `FACTS` :
 *     au plus un calcul PROBABLE (candidat de pertinence, jamais écrit), et
 *     le signal d'un échéancier (pertinence de la date de fin, lot 76 I).
 */
import type { ActionProposal } from './action-model';
import type { EvidenceFact } from './document-field-evidence';
import type { ExtraDerivationFacts } from './document-derivations';
import type { ScheduleFacts } from './document-derivations';
import type { SemanticResolution } from '@/services/ai/reconciliation/knowledge-query/service';
import type { ConstituentRole } from '@/services/ai/reconciliation/knowledge-query/contract';
import { contradictoryTargets, mergeFindings } from '@/services/ai/reconciliation/knowledge-query/validate';

/** Source des faits issus du traitement sémantique (diagnostic, pertinence). */
const SEMANTIC_SOURCE = 'T3_SEMANTIC';
/** Confiance d'une valeur comprise (modèle certain, preuve T1 fiable) : proposition, jamais écriture automatique. */
export const SEMANTIC_PROPOSAL_CONFIDENCE = 0.6;
/** Confiance d'une valeur comprise incertaine, ambiguë ou contradictoire. */
export const SEMANTIC_WEAK_CONFIDENCE = 0.3;

const SCHEDULE_ROLES = ['firstInstalment', 'lastInstalment', 'count', 'periodicity', 'disbursement', 'repayment'] as const;

/** Propositions de la DONNÉE (cible FIELD) issues des constats retenus. Pure. */
export function semanticFieldProposals(r: SemanticResolution | null, normalize: (v: unknown) => string | number | boolean | null): ActionProposal[] {
  if (!r || r.status !== 'ANSWERED') return [];
  const contradiction = r.contradictions.includes('FIELD');
  const out = new Map<string, ActionProposal>();
  for (const f of r.findings) {
    if (f.target !== 'FIELD' || f.normalized === null) continue;
    const v = normalize(f.normalized);
    if (v === null) continue;
    const sur = !contradiction && f.modelConfidence === 'certain' && f.evidenceConfidence === 'certain' && f.dateStatus !== 'ORDER_AMBIGUOUS';
    const conf = sur ? SEMANTIC_PROPOSAL_CONFIDENCE : SEMANTIC_WEAK_CONFIDENCE;
    const k = String(v);
    const prev = out.get(k);
    if (prev && prev.confidence >= conf) continue;
    out.set(k, {
      value: v, label: k, confidence: conf, evidenceIds: f.evidenceRefs.map((ref) => `t1:${ref}`),
      sourceContext: { label: f.excerpt.replace(/\s+/g, ' ').slice(0, 120) },
    });
  }
  return [...out.values()];
}

/** Faits de pertinence (date lue sémantiquement, extrait) — la pertinence situe la donnée dans le temps. Pure. */
export function semanticEvidenceFacts(r: SemanticResolution | null, normalize: (v: unknown) => string | number | boolean | null): EvidenceFact[] {
  return semanticFieldProposals(r, normalize).map((p) => ({
    value: p.value, confidence: 'probable', excerpt: p.sourceContext?.label ?? null, source: SEMANTIC_SOURCE, key: 'FIELD', label: null,
  }));
}

/** Constituants retenus → faits du calcul existant (jamais fiables). Pure. Null : aucun constituant. */
export function semanticConstituents(r: SemanticResolution | null): ExtraDerivationFacts | null {
  if (!r || r.status !== 'ANSWERED') return null;
  const fait = (f: SemanticResolution['findings'][number], valeur: string): EvidenceFact => ({
    value: valeur, confidence: 'probable', excerpt: f.excerpt, source: `${SEMANTIC_SOURCE}:${f.evidenceRefs[0]}`, key: `t3:${f.target}`, label: null,
  });
  const out: ExtraDerivationFacts = { start: [], duration: [], schedule: {} };
  let n = 0;
  for (const f of r.findings) {
    // Constituant en contradiction : présenté tel quel — le calcul existant refuse plusieurs valeurs (AMBIGUOUS).
    if (f.target === 'start' && f.normalized) { out.start!.push(fait(f, f.normalized)); n += 1; continue; }
    if (f.target === 'duration') { out.duration!.push(fait(f, f.rawValue)); n += 1; continue; }
    const role = SCHEDULE_ROLES.find((x) => x === f.target);
    if (!role) continue;
    const date = role === 'firstInstalment' || role === 'lastInstalment' || role === 'disbursement';
    if (date && !f.normalized) continue;
    ((out.schedule as Partial<ScheduleFacts>)[role] ??= []).push(fait(f, date ? f.normalized! : f.rawValue));
    n += 1;
  }
  return n ? out : null;
}

// ══════════════════════════════════════════════════════════════════════════
// LOT 98B (P0-D) — RÉPONSE T3 VALIDE MAIS INCOMPLÈTE
//
// Le code ne reconstruit AUCUNE compréhension (ni regex, ni règle métier) :
// il confronte ce que la DÉCISION déclare lui avoir manqué aux constituants
// que T3 a rendus. Seul besoin déclaré aujourd'hui par le moteur : la règle
// « date de fin nécessaire ? » (`endDateNeed`, lot 76 I) conclut sans IA
// qu'une date de fin inconnue est inutile quand un REMBOURSEMENT par
// échéances est établi et qu'aucune démarche n'est attachée à la fin ; sans
// cet élément, elle ne peut pas statuer (T4, ou maintien prudent). Une autre
// règle qui déclare un besoin s'ajoute ici, jamais un vocabulaire.
// ══════════════════════════════════════════════════════════════════════════

/** Préfixe des besoins déclarés par la décision (`missing_sources` de la trace). */
export const DECISION_GAP_PREFIX = 'DECISION_GAP:';

/**
 * Constituants dont la décision a besoin et qu'elle n'a pas (pure) :
 * aucune valeur lue de la donnée, date de fin dont la nécessité n'a pas pu
 * être tranchée faute de remboursement établi, aucune démarche de fin lue.
 */
export function knowledgeGaps(p: {
  endDateNeed: { repaymentSchedule: boolean; endActions: readonly string[] } | null | undefined;
  /** Une valeur de la donnée a été lue (faits, documents liés, T3) : la décision ne dépend plus des constituants. */
  readValue: boolean;
}): ConstituentRole[] {
  if (p.readValue || !p.endDateNeed) return [];
  return !p.endDateNeed.repaymentSchedule && p.endDateNeed.endActions.length === 0 ? ['repayment'] : [];
}

/** Rôles de constituants rendus par une interprétation (constats retenus). Pure. */
export const renderedRoles = (r: Pick<SemanticResolution, 'findings'> | null | undefined): string[] =>
  [...new Set((r?.findings ?? []).map((f) => f.target))].sort();

/**
 * La réponse T3 est-elle valide mais INCOMPLÈTE pour la décision ? (pure) —
 * T3 a rendu des constituants (issue CONSTITUENTS) sans ceux que la décision
 * déclare manquants. Rend les rôles à redemander (sous-ensemble des
 * constituants offerts), vide sinon.
 */
export function incompleteAnswerGaps(r: SemanticResolution | null | undefined, gaps: readonly ConstituentRole[], offered: readonly string[]): ConstituentRole[] {
  if (!r || r.status !== 'ANSWERED' || r.outcome !== 'CONSTITUENTS' || !gaps.length) return [];
  const rendus = new Set(renderedRoles(r));
  return gaps.filter((g) => offered.includes(g) && !rendus.has(g));
}

/**
 * POINT DE RACCORD UNIQUE (lot 98B, P0-D) — constituants à redemander à T3
 * pour CETTE carte : besoin déclaré par la décision (`endDateNeed` tracé ou
 * courant → `knowledgeGaps`) confronté à la réponse rendue. Utilisé par la
 * décision centrale (demande complémentaire) ET par le contrôle
 * COH-T1-KNOWLEDGE-CONSUMPTION. À l'intégration, c'est ici que se branche le
 * classement de complétude du chantier 98A (`knowledgeCompleteness`) si l'on
 * veut une seule source ; aucune regex, aucune règle métier.
 */
export function isKnowledgeAnswerIncompleteForCard(p: {
  answer: SemanticResolution | null | undefined;
  /** Besoins déclarés par la décision de la carte (rôles). */
  needs: readonly ConstituentRole[];
  /** Constituants offerts à T3 par la question. */
  offered: readonly string[];
}): { incomplete: boolean; missing: ConstituentRole[] } {
  const missing = incompleteAnswerGaps(p.answer, p.needs, p.offered);
  return { incomplete: missing.length > 0, missing };
}

/** Fusion de la demande complémentaire dans l'interprétation principale (pure). */
export function withFollowUp(main: SemanticResolution, focus: readonly ConstituentRole[], suite: SemanticResolution): SemanticResolution {
  const findings = suite.status === 'ANSWERED' ? mergeFindings([main.findings, suite.findings]) : main.findings;
  return {
    ...main,
    findings,
    contradictions: contradictoryTargets(findings),
    aiCalled: main.aiCalled || suite.aiCalled,
    calls: main.calls + suite.calls,
    traceIds: [...main.traceIds, ...suite.traceIds],
    citedCoveredUnits: [...(main.citedCoveredUnits ?? []), ...(suite.citedCoveredUnits ?? [])],
    followUp: {
      focus: [...focus], status: suite.status, outcome: suite.outcome ?? null, pendingReason: suite.pendingReason ?? null,
      queryId: suite.queryId, cached: suite.cached, calls: suite.calls,
    },
  };
}
