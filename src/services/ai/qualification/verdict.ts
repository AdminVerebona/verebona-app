/**
 * Verdict de qualification d'un couple et choix d'une candidate — lot 86A
 * (CDC Pilotage IA V2 P5 : QUAL-01, QUAL-02, QUAL-05, OPT-01, OPT-02, DEC-01,
 * DEC-02, R04, R06, R07, R32, R47, R50 ; décision PO n° 14). PUR, sans base.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ORDRE DES GARDE-FOUS (DEC-01)
 *
 *   1. intégrité / environnement (point de restauration, compte technique,
 *      préproduction…) — manquant : NON CONCLUANT, rien n'est mesuré ;
 *   2. admissibilité technique (constructeur de requête unique : combinaison
 *      connue comme incompatible) — REFUSÉE ;
 *   3. qualité métier : un seul défaut (seuils 0) → REFUSÉE ; cas obligatoire
 *      non vérifiable ou non exécuté → NON CONCLUANTE ;
 *   4. délai : un appel conclu au-delà du plafond → REFUSÉE ; P95 dégradé de
 *      plus de 20 % par rapport à la référence mesurée sur les mêmes cas →
 *      REFUSÉE ; référence non mesurée → NON CONCLUANTE ;
 *   5. concurrence : perte, doublon ou attribution incorrecte → REFUSÉE ;
 *      charge de test non atteinte → NON CONCLUANTE.
 * Une cause CONFIRMÉE à n'importe quelle étape refuse ; sinon un doute à
 * n'importe quelle étape laisse non concluant ; un bon résultat d'une étape
 * ne compense jamais une autre. Une erreur fournisseur transitoire n'est
 * jamais une réussite ni, seule, une faute du modèle (NON CONCLUANT).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * GAIN DÉMONTRÉ (OPT-01, DEC-02, R07, R50)
 *
 * Une candidate admissible ne remplace la référence que sur un gain ÉTABLI,
 * mesuré sur les MÊMES cas (cas comparables) : pour chaque cas, TOUTES les
 * observations de la candidate sont meilleures que TOUTES celles de la
 * référence (délai pour l'interactif, coût par résultat valide pour
 * l'arrière-plan — OPT-02). Aucun pourcentage magique : un gain faible mais
 * reproductible suffit ; une seule observation (appel isolé) ne suffit
 * jamais. Égalité ou doute : le choix courant est conservé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { countDefects, type Defect } from './defects';
import { DEFECT_CATEGORIES, QUALIFICATION_THRESHOLDS, type DefectCategory, type QualificationThresholds } from './thresholds';

export type CaseOutcome = 'PASSED' | 'FAILED' | 'INCONCLUSIVE';
export type CaseSource = 'CORPUS_FIXTURE' | 'T1_REFERENCE' | 'PREPROD_REPLAY';
/**
 * Source de la vérité attendue (QUAL-09) : `REFERENCE` — attendu vérifié
 * (référence documentée du corpus, contrôle déterministe) ; `INVARIANTS` —
 * seuls les contrôles serveur sans attendu s'appliquent (régression
 * démontrée détectable, exactitude non démontrable) ; `NONE` — aucun.
 */
export type ExpectedSource = 'REFERENCE' | 'INVARIANTS' | 'NONE';
export type Verdict = 'ADMISSIBLE' | 'REFUSED' | 'INCONCLUSIVE';
export type VerdictStep = 'INTEGRITY' | 'TECHNICAL' | 'QUALITY' | 'LATENCY' | 'CONCURRENCY';

export interface CaseObservation {
  caseId: string;
  source: CaseSource;
  expectedSource: ExpectedSource;
  /** Cas obligatoire : compte dans le « 100 % des cas obligatoires exécutés et validés ». */
  mandatory: boolean;
  observation: number;
  outcome: CaseOutcome;
  defects: Defect[];
  inconclusiveReason: string | null;
  /** Durée propre de l'appel conclu (ms) ; null : aucun appel conclu. */
  durationMs: number | null;
  /** Plafond de l'opération pour cet appel (ms). */
  timeoutMs: number | null;
  /** Coût imputé (micro-unités) ; null : inconnu (jamais 0 par défaut). */
  costMicros: number | null;
  servedModel: string | null;
  traceId: string | null;
  accountId?: number | null;
  captureId?: number | null;
  historicalSha256?: string | null;
  observedSha256?: string | null;
  matchesHistorical?: boolean | null;
}

export interface ConcurrencyReport {
  mode: 'QUEUED' | 'SYNCHRONOUS';
  /** Simultanéité visée (2 par traitement en file, 3 pour T2 / T6). */
  target: number;
  /** Simultanéité maximale admise (borne du worker). */
  limit: number;
  maxObserved: number;
  submitted: number;
  completed: number;
  duplicates: number;
  lost: number;
  misattributed: number;
}

export interface Reason { step: VerdictStep; outcome: 'BLOCKING' | 'INCONCLUSIVE' | 'OK'; code: string; message: string }

interface CoupleVerdictInput {
  observations: CaseObservation[];
  /** Préalables manquants (étape 1) : environnement, point de restauration, compte… */
  preconditions?: string[];
  /** Refus du constructeur de requête unique (étape 2). */
  technicalRefusal?: { parameter: string | null; message: string } | null;
  /** P95 de la référence sur les mêmes cas ; `isSelf` : le couple EST la référence. */
  reference: { p95Ms: number | null; isSelf: boolean };
  concurrency: ConcurrencyReport | null;
  thresholds?: QualificationThresholds;
}

export interface CoupleMetrics {
  cases: { total: number; mandatory: number; verifiableMandatory: number; validatedMandatory: number; passed: number; failed: number; inconclusive: number; observations: number };
  defects: Record<DefectCategory, number>;
  latency: { concluded: number; withinCap: number; overCap: number; p95Ms: number | null; referenceP95Ms: number | null; degradation: number | null };
  cost: { totalMicros: number | null; validResults: number; perValidResultMicros: number | null };
  concurrency: ConcurrencyReport | null;
  historical: { compared: number; identical: number; divergent: number };
}

interface CoupleVerdict { verdict: Verdict; reasons: Reason[]; metrics: CoupleMetrics }

/** Percentile au rang le plus proche (pur) ; null sur une série vide. */
export function percentile(values: readonly number[], p: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.ceil((p / 100) * v.length);
  return v[Math.min(v.length, Math.max(1, rank)) - 1];
}

export function decideCoupleVerdict(input: CoupleVerdictInput): CoupleVerdict {
  const th = input.thresholds ?? QUALIFICATION_THRESHOLDS;
  const obs = input.observations;
  const reasons: Reason[] = [];
  const add = (step: VerdictStep, outcome: Reason['outcome'], code: string, message: string) => reasons.push({ step, outcome, code, message });

  // ── Métriques ────────────────────────────────────────────────────────────
  const caseIds = [...new Set(obs.map((o) => o.caseId))];
  const parCas = new Map<string, CaseObservation[]>();
  for (const o of obs) parCas.set(o.caseId, [...(parCas.get(o.caseId) ?? []), o]);
  const mandatory = caseIds.filter((id) => parCas.get(id)!.some((o) => o.mandatory));
  const verifiables = mandatory.filter((id) => parCas.get(id)!.every((o) => o.expectedSource === 'REFERENCE'));
  // Un cas est VALIDÉ si toutes ses observations sont réussies.
  const validated = verifiables.filter((id) => parCas.get(id)!.every((o) => o.outcome === 'PASSED'));
  const defects = obs.flatMap((o) => o.defects);
  const counts = countDefects(defects);
  const conclus = obs.filter((o) => o.durationMs != null);
  const overCap = conclus.filter((o) => o.timeoutMs != null && o.durationMs! > o.timeoutMs);
  const p95 = percentile(conclus.map((o) => o.durationMs!), th.latency.percentile);
  const ref = input.reference.isSelf ? p95 : input.reference.p95Ms;
  const degradation = p95 != null && ref != null && ref > 0 ? (p95 - ref) / ref : null;
  const valides = obs.filter((o) => o.outcome === 'PASSED');
  const coutConnu = obs.every((o) => o.durationMs == null || o.costMicros != null);
  const totalCost = coutConnu ? obs.reduce((s, o) => s + (o.costMicros ?? 0), 0) : null;
  const historiques = obs.filter((o) => o.matchesHistorical != null);
  const metrics: CoupleMetrics = {
    cases: {
      total: caseIds.length, mandatory: mandatory.length, verifiableMandatory: verifiables.length, validatedMandatory: validated.length,
      passed: obs.filter((o) => o.outcome === 'PASSED').length, failed: obs.filter((o) => o.outcome === 'FAILED').length,
      inconclusive: obs.filter((o) => o.outcome === 'INCONCLUSIVE').length, observations: obs.length,
    },
    defects: counts,
    latency: { concluded: conclus.length, withinCap: conclus.length - overCap.length, overCap: overCap.length, p95Ms: p95, referenceP95Ms: ref, degradation },
    cost: { totalMicros: totalCost, validResults: valides.length, perValidResultMicros: totalCost != null && valides.length ? Math.round(totalCost / valides.length) : null },
    concurrency: input.concurrency,
    historical: { compared: historiques.length, identical: historiques.filter((o) => o.matchesHistorical).length, divergent: historiques.filter((o) => !o.matchesHistorical).length },
  };

  // ── 1. Intégrité / environnement ─────────────────────────────────────────
  if (input.preconditions?.length) {
    for (const p of input.preconditions) add('INTEGRITY', 'INCONCLUSIVE', 'PRECONDITION', p);
    return { verdict: 'INCONCLUSIVE', reasons, metrics };
  }
  add('INTEGRITY', 'OK', 'PRECONDITIONS_MET', 'Préalables vérifiés (environnement, droits, point de restauration).');

  // ── 2. Admissibilité technique ───────────────────────────────────────────
  if (input.technicalRefusal) {
    add('TECHNICAL', 'BLOCKING', 'TECHNICAL_INCOMPATIBILITY',
      `Combinaison refusée avant appel par le constructeur de requête${input.technicalRefusal.parameter ? ` (${input.technicalRefusal.parameter})` : ''} : ${input.technicalRefusal.message}`);
  } else add('TECHNICAL', 'OK', 'REQUEST_BUILT', 'Requête construite par le constructeur unique (mêmes paramètres qu’en exécution).');

  // ── 3. Qualité métier ────────────────────────────────────────────────────
  const depasses = DEFECT_CATEGORIES.filter((c) => counts[c] > th.quality.maxDefects[c]);
  if (depasses.length) {
    add('QUALITY', 'BLOCKING', 'BUSINESS_DEFECTS',
      `Erreur(s) métier confirmée(s) : ${depasses.map((c) => `${c} ${counts[c]}`).join(', ')} (seuil ${th.version} : 0).`);
  }
  if (verifiables.length === 0) {
    add('QUALITY', 'INCONCLUSIVE', 'NO_VERIFIABLE_CASE', 'Aucun cas obligatoire doté d’un résultat attendu vérifiable : la qualité n’est pas démontrée (non vérifiable = non concluant).');
  } else if (verifiables.length < mandatory.length) {
    add('QUALITY', 'INCONCLUSIVE', 'UNVERIFIABLE_MANDATORY_CASES',
      `${mandatory.length - verifiables.length} cas obligatoire(s) sans attendu vérifiable : non concluant.`);
  }
  const nonValides = verifiables.filter((id) => !validated.includes(id) && parCas.get(id)!.every((o) => o.outcome !== 'FAILED'));
  if (nonValides.length) {
    add('QUALITY', 'INCONCLUSIVE', 'MANDATORY_CASES_NOT_VALIDATED',
      `${nonValides.length} cas obligatoire(s) non exécuté(s) ou non concluant(s) (${[...new Set(nonValides.flatMap((id) => parCas.get(id)!.map((o) => o.inconclusiveReason).filter(Boolean)))].slice(0, 3).join(' ; ') || 'motif non précisé'}).`);
  }
  if (!depasses.length && verifiables.length && validated.length / Math.max(1, mandatory.length) >= th.quality.mandatoryValidatedRatio) {
    add('QUALITY', 'OK', 'QUALITY_MET', `${validated.length}/${mandatory.length} cas obligatoires validés, aucun défaut métier.`);
  }

  // ── 4. Délai ─────────────────────────────────────────────────────────────
  if (conclus.length === 0) {
    add('LATENCY', 'INCONCLUSIVE', 'NO_CONCLUDED_CALL', 'Aucun appel conclu : délai non mesuré.');
  } else {
    if (overCap.length / conclus.length > 1 - th.latency.withinCapRatio) {
      add('LATENCY', 'BLOCKING', 'OVER_OPERATION_CAP', `${overCap.length} appel(s) conclu(s) au-delà du plafond de l’opération (exigé : ${Math.round(th.latency.withinCapRatio * 100)} % sous le plafond).`);
    }
    if (ref == null) {
      add('LATENCY', 'INCONCLUSIVE', 'REFERENCE_NOT_MEASURED', 'P95 de la référence non mesuré sur les mêmes cas : comparaison impossible.');
    } else if (degradation != null && degradation > th.latency.maxP95Degradation) {
      add('LATENCY', 'BLOCKING', 'P95_DEGRADED', `P95 ${p95} ms contre ${ref} ms pour la référence (+${Math.round(degradation * 100)} %, maximum +${Math.round(th.latency.maxP95Degradation * 100)} %).`);
    } else if (!overCap.length) {
      add('LATENCY', 'OK', 'LATENCY_MET', `P95 ${p95} ms${input.reference.isSelf ? ' (référence)' : ` contre ${ref} ms pour la référence`} ; tous les appels sous le plafond.`);
    }
  }

  // ── 5. Concurrence ───────────────────────────────────────────────────────
  const c = input.concurrency;
  if (!c) {
    add('CONCURRENCY', 'INCONCLUSIVE', 'CONCURRENCY_NOT_TESTED', 'Essai de concurrence non réalisé.');
  } else if (c.lost > 0 || c.duplicates > 0 || c.misattributed > 0) {
    add('CONCURRENCY', 'BLOCKING', 'CONCURRENCY_LOSS', `Sous concurrence : ${c.lost} perte(s), ${c.duplicates} doublon(s), ${c.misattributed} attribution(s) incorrecte(s).`);
  } else if (c.maxObserved > c.limit) {
    add('CONCURRENCY', 'INCONCLUSIVE', 'CONCURRENCY_LIMIT_EXCEEDED', `Simultanéité observée ${c.maxObserved} > borne ${c.limit} : essai non représentatif.`);
  } else if (c.maxObserved < c.target) {
    add('CONCURRENCY', 'INCONCLUSIVE', 'CONCURRENCY_TARGET_NOT_REACHED', `Simultanéité visée ${c.target} non atteinte (${c.maxObserved}).`);
  } else {
    add('CONCURRENCY', 'OK', 'CONCURRENCY_MET', `${c.completed}/${c.submitted} travaux conclus à ${c.maxObserved} simultanés (${c.mode === 'QUEUED' ? 'file' : 'synchrone'}), sans perte ni attribution incorrecte.`);
  }

  const verdict: Verdict = reasons.some((r) => r.outcome === 'BLOCKING') ? 'REFUSED'
    : reasons.some((r) => r.outcome === 'INCONCLUSIVE') ? 'INCONCLUSIVE' : 'ADMISSIBLE';
  return { verdict, reasons, metrics };
}

// ══════════════════════════════════════════════════════════════════════════
// Gain établi (OPT-01, OPT-02, DEC-02, R07, R50)
// ══════════════════════════════════════════════════════════════════════════

type Priority = 'LATENCY' | 'COST';

interface Measure { caseId: string; durationMs: number | null; costMicros: number | null; outcome: CaseOutcome }

export type GainOutcome = 'GAIN' | 'LOSS' | 'NONE' | 'NOT_COMPARABLE';

/**
 * Compare candidate et référence pour une opération, sur les cas réussis des
 * DEUX côtés (cas comparables). `GAIN` / `LOSS` seulement si établi sur chaque
 * cas comparable avec au moins `minObservations` observations de chaque côté.
 */
export function establishedGain(
  reference: readonly Measure[], candidate: readonly Measure[], priority: Priority, minObservations = 2,
): { outcome: GainOutcome; comparableCases: number; detail: string } {
  const val = (m: Measure) => (priority === 'LATENCY' ? m.durationMs : m.costMicros);
  const groupe = (l: readonly Measure[]) => {
    const g = new Map<string, Measure[]>();
    for (const m of l) g.set(m.caseId, [...(g.get(m.caseId) ?? []), m]);
    return g;
  };
  const r = groupe(reference);
  const c = groupe(candidate);
  const okR = [...r.keys()].filter((id) => r.get(id)!.every((m) => m.outcome === 'PASSED' && val(m) != null));
  const okC = new Set([...c.keys()].filter((id) => c.get(id)!.every((m) => m.outcome === 'PASSED' && val(m) != null)));
  // R50 : même périmètre — la candidate doit réussir exactement les cas que réussit la référence.
  if (!okR.length || okR.some((id) => !okC.has(id))) {
    return { outcome: 'NOT_COMPARABLE', comparableCases: 0, detail: 'cas comparables absents ou périmètre différent (R50)' };
  }
  let gain = true;
  let perte = true;
  for (const id of okR) {
    const vr = r.get(id)!.map((m) => val(m)!);
    const vc = c.get(id)!.map((m) => val(m)!);
    if (vr.length < minObservations || vc.length < minObservations) {
      return { outcome: 'NONE', comparableCases: okR.length, detail: `observations insuffisantes (${Math.min(vr.length, vc.length)} < ${minObservations}) : une mesure isolée ne suffit pas` };
    }
    if (!(Math.max(...vc) < Math.min(...vr))) gain = false;
    if (!(Math.min(...vc) > Math.max(...vr))) perte = false;
  }
  if (gain) return { outcome: 'GAIN', comparableCases: okR.length, detail: `${priority === 'LATENCY' ? 'délai' : 'coût'} meilleur sur chaque observation de ${okR.length} cas` };
  if (perte) return { outcome: 'LOSS', comparableCases: okR.length, detail: `${priority === 'LATENCY' ? 'délai' : 'coût'} moins bon sur chaque observation de ${okR.length} cas` };
  return { outcome: 'NONE', comparableCases: okR.length, detail: 'écart non établi (fluctuation)' };
}

export interface CandidateAssessment {
  key: string;
  /** Verdict de chaque couple de la candidate (toutes ses opérations). */
  verdicts: Verdict[];
  /** Comparaison à la référence, par opération. */
  gains: Array<{ operationCode: string; outcome: GainOutcome }>;
  /** Mesure agrégée de départage (plus petit = meilleur). */
  score: number | null;
}

/**
 * Choisit la candidate à activer (pur) : admissible sur TOUS ses couples, gain
 * établi sur au moins une opération, aucune perte établie ni opération non
 * comparable. Plusieurs : la meilleure mesure, puis la première proposée
 * (R07). Aucune : `null` — le choix courant est conservé.
 */
export function chooseCandidate(cands: readonly CandidateAssessment[]): { chosen: string | null; reasons: Record<string, string> } {
  const reasons: Record<string, string> = {};
  const eligibles: CandidateAssessment[] = [];
  for (const c of cands) {
    if (!c.verdicts.length || c.verdicts.some((v) => v !== 'ADMISSIBLE')) {
      reasons[c.key] = c.verdicts.includes('REFUSED') ? 'refusée : au moins un couple refusé' : 'non concluante : au moins un couple non qualifié';
      continue;
    }
    if (c.gains.some((g) => g.outcome === 'LOSS')) { reasons[c.key] = 'perte établie sur une opération : choix courant conservé'; continue; }
    if (c.gains.some((g) => g.outcome === 'NOT_COMPARABLE')) { reasons[c.key] = 'comparaison non fiable (cas non comparables) : choix courant conservé'; continue; }
    if (!c.gains.some((g) => g.outcome === 'GAIN')) { reasons[c.key] = 'aucun gain établi (égalité ou fluctuation) : choix courant conservé'; continue; }
    eligibles.push(c);
    reasons[c.key] = 'gain établi';
  }
  if (!eligibles.length) return { chosen: null, reasons };
  const best = [...eligibles].sort((a, b) => (a.score ?? Number.POSITIVE_INFINITY) - (b.score ?? Number.POSITIVE_INFINITY))[0];
  for (const c of eligibles) if (c.key !== best.key) reasons[c.key] = 'gain établi, mais une autre candidate fait mieux';
  return { chosen: best.key, reasons };
}
