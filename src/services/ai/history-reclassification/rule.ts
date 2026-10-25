/**
 * Reclassement PROUVABLE de l'historique des appels IA — lot 89A (CDC
 * Pilotage IA V2, phase P8 : MIG-03, BO-05, LOG-08, R23, R59). PUR : aucun
 * import serveur, partagé par le service, l'écran et les tests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST RECLASSÉ
 *
 * Les appels (`ai_usage_event`) ANTÉRIEURS à la corrélation du lot 83C
 * (migration 0668) n'ont pas d'identifiant d'exécution métier. Le nouveau
 * chemin (83C) écrit cet identifiant à la source ; il n'est JAMAIS modifié
 * ici. Pour chaque appel historique, la règle versionnée ci-dessous établit,
 * à partir des seuls liens PERSISTANTS existants :
 *   · la NATURE : métier, technique (sonde, qualification, test, balayage
 *     planifié, compte technique du corpus) ou non déterminable ;
 *   · le TRAITEMENT quand il est établi (code d'usage, opération du registre) ;
 *   · l'EXÉCUTION métier quand un lien la prouve (travail de file existant,
 *     rapport d'exécution T1 portant la trace, génération T6 FORMULATE ou
 *     évaluation T6 EVALUATE portant la trace) ;
 *   · l'ISSUE de cette exécution (Réussie / Incomplète / Échouée / …), lue par
 *     la projection P2 au moment du reclassement (instantané tracé — la
 *     projection reste la seule autorité à l'affichage de l'exécution).
 * Le résultat est écrit À CÔTÉ de la trace d'origine (colonnes
 * `history_execution_id`, `history_class`, migration 0776) : rien n'est
 * effacé ni remplacé, la règle et ses preuves sont portées par chaque ligne.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI N'EST JAMAIS FAIT
 *
 *   · aucun rapprochement par proximité temporelle (le lien T2 historique
 *     « même compte, ±2 min » de l'écran reste une aide, jamais une preuve) ;
 *   · aucun appel IA, aucune reconstitution de prompt, de contenu ou de cause ;
 *   · aucune écriture sur un appel du nouveau chemin (`business_execution_id`
 *     renseigné, ou liste `metadata.businessExecutionIds` d'un appel T6
 *     EVALUATE groupé : non-attribution volontaire) ;
 *   · une preuve absente donne « non déterminable », avec son motif.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Version de la règle (toute évolution de la règle change ce code). */
export const HISTORY_RULE_VERSION = 'p8-historique-v1' as const;

/**
 * Identifiant d'exécution de la règle (constant pour une version) : toutes
 * les passes de la même règle — bouton du BO ou tâche planifiée — partagent
 * cet identifiant, ce qui permet d'annuler le reclassement d'un seul geste
 * (« Restaurer » du rattrapage).
 */
export const HISTORY_RULE_RUN_ID = '8a9e0c1d-5b7f-4e2a-9c3d-890000000001' as const;

/** Migration à partir de laquelle le nouveau chemin écrit l'exécution à la source. */
export const CORRELATION_MIGRATION = '0668_l83c_execution_metier.sql' as const;

export const HISTORY_NATURES = ['BUSINESS', 'TECHNICAL', 'UNDETERMINED'] as const;
export type HistoryNature = (typeof HISTORY_NATURES)[number];

export const HISTORY_NATURE_LABELS: Readonly<Record<HistoryNature, string>> = {
  BUSINESS: 'Métier',
  TECHNICAL: 'Technique',
  UNDETERMINED: 'Non déterminable',
};

/** Issues possibles (mêmes codes que la projection P2). */
export type HistoryOutcome = 'SUCCEEDED' | 'INCOMPLETE' | 'FAILED' | 'NOT_FINAL' | 'VOID' | 'UNDETERMINED';

export const HISTORY_OUTCOME_LABELS: Readonly<Record<HistoryOutcome, string>> = {
  SUCCEEDED: 'Réussie', INCOMPLETE: 'Incomplète', FAILED: 'Échouée', NOT_FINAL: 'Non finale', VOID: 'Sans objet', UNDETERMINED: 'Non déterminable',
};

/** Preuve citée par la règle (table et identifiant, jamais une valeur métier). */
export interface HistoryEvidence {
  source: 'ai_usage_event' | 'ai_job_queue' | 'ai_execution_reports' | 'home_mascot_generations' | 't6_evaluation_runs' | 'operations_registry' | 'environment';
  ref: string;
  /** Ce que la preuve établit. */
  proves: 'nature' | 'treatment' | 'execution';
}

/** Classement d'un appel historique (écrit dans `history_class`). */
export interface HistoryClass {
  rule: typeof HISTORY_RULE_VERSION | string;
  runId: string;
  nature: HistoryNature;
  /** T1…T6 ; `T5` pour les anciens appels de l'outil retiré ; null : non établi. */
  treatment: string | null;
  executionId: string | null;
  outcome: HistoryOutcome;
  evidence: HistoryEvidence[];
  /** Motif d'un « non déterminable » (nature ou exécution), sinon null. */
  reason: string | null;
  classifiedAt: string;
  /** Classement d'une règle antérieure remplacé par celui-ci (une seule génération gardée). */
  previous?: Omit<HistoryClass, 'previous'> | null;
}

/** Appel historique lu en base (sous-ensemble de `ai_usage_event`). */
export interface HistoricalCall {
  id: number;
  accountId: number | null;
  useCaseCode: string | null;
  operationCode: string | null;
  jobId: number | null;
  traceId: string | null;
  /** Déclencheur figé dans la trace (`metadata.trigger`). */
  trigger: string | null;
}

/** Liens persistants trouvés par le service (chacun vérifié en base). */
export interface HistoricalLinks {
  job: { id: number; treatment: string; accountId: number | null; targetType: string | null; businessExecutionId: string | null } | null;
  /** Rapport T1 dont `trace_ids` contient la trace de l'appel, et son exécution. */
  t1Report: { id: number; executionId: string } | null;
  /** Génération T6 FORMULATE de même trace. */
  t6Generation: { traceId: string } | null;
  /** Évaluation T6 EVALUATE de même trace (dernière demande de l'échéance). */
  t6Evaluation: { agendaItemId: number; executionId: string } | null;
  /** Compte technique des campagnes (`CORPUS_ACCOUNT_ID`), s'il est connu. */
  corpusAccountId: number | null;
}

/** Usage → traitement (référentiel, sans import serveur). */
const USE_CASE_TREATMENT: Readonly<Record<string, string>> = {
  SOURCE_ANALYSIS: 'T1', INTELLIGENT_ASSISTANT: 'T2', DATA_RECONCILIATION: 'T3', AGENDA_INTELLIGENCE: 'T4', HOME_MASCOT: 'T6',
};
/** Préfixes d'opération → traitement (registre `AI_OPERATIONS`, opérations retirées comprises). */
const OPERATION_PREFIX_TREATMENT: ReadonlyArray<[RegExp, string]> = [
  [/^t1_/, 'T1'], [/^t2_/, 'T2'], [/^t3_/, 'T3'], [/^t4_/, 'T4'], [/^t5_/, 'T5'], [/^t6_/, 'T6'],
];
/** Déclencheurs d'appels techniques (qualification, sondes, tests, corpus). */
const TECHNICAL_TRIGGERS = new Set(['qualification', 'probe', 'provider_test', 'model_probe', 'corpus', 'campaign', 'evaluate_prompt']);
/** Opérations techniques (registre : `AI_GOVERNANCE`). */
const TECHNICAL_OPERATIONS = new Set(['evaluate_prompt']);

/** Traitement établi par le code d'usage, sinon par l'opération ; null sinon. Pur. */
export function treatmentOfCall(c: Pick<HistoricalCall, 'useCaseCode' | 'operationCode'>): { treatment: string | null; evidence: HistoryEvidence | null } {
  if (c.useCaseCode && USE_CASE_TREATMENT[c.useCaseCode]) {
    return { treatment: USE_CASE_TREATMENT[c.useCaseCode], evidence: { source: 'ai_usage_event', ref: `use_case_code=${c.useCaseCode}`, proves: 'treatment' } };
  }
  const op = c.operationCode ?? '';
  for (const [re, t] of OPERATION_PREFIX_TREATMENT) {
    if (re.test(op)) return { treatment: t, evidence: { source: 'operations_registry', ref: `operation_code=${op}`, proves: 'treatment' } };
  }
  return { treatment: null, evidence: null };
}

/**
 * Règle `p8-historique-v1`, appliquée à UN appel historique. Pure.
 * L'issue n'est pas calculée ici (elle vient de la projection P2, par le
 * service) : `outcome` vaut `UNDETERMINED` tant qu'aucune exécution n'est
 * prouvée.
 *
 * Ordre (la première preuve décisive l'emporte) :
 *   1. technique : usage `AI_GOVERNANCE`, opération technique, déclencheur
 *      technique, compte technique du corpus, anciens appels T5 (outil
 *      d'administration retiré au lot 49) ;
 *   2. travail de file EXISTANT (`job_id`) : son exécution (T1 avec fichier :
 *      référence portée ou `T1:job:<id>` ; T3 / T4 : `T3:<id>`) — un travail
 *      T1 sans fichier (passage planifié) ou T3 sans compte (balayage) est
 *      technique ;
 *   3. rapport T1 portant la trace : son exécution ;
 *   4. génération T6 FORMULATE de même trace : `T6F:<trace>` ;
 *   5. évaluation T6 EVALUATE de même trace : son exécution ;
 *   6. sinon : non déterminable (traitement indiqué s'il est établi).
 */
export function classifyHistoricalCall(c: HistoricalCall, l: HistoricalLinks, at: Date = new Date()): HistoryClass {
  const base = { rule: HISTORY_RULE_VERSION, runId: HISTORY_RULE_RUN_ID, classifiedAt: at.toISOString() };
  const tr = treatmentOfCall(c);
  const ev: HistoryEvidence[] = tr.evidence ? [tr.evidence] : [];
  const technique = (ref: string, source: HistoryEvidence['source'] = 'ai_usage_event', treatment: string | null = null): HistoryClass => ({
    ...base, nature: 'TECHNICAL', treatment, executionId: null, outcome: 'UNDETERMINED',
    evidence: [...(treatment !== null && tr.evidence ? [tr.evidence] : []), { source, ref, proves: 'nature' }], reason: null,
  });

  // 1. Technique.
  if (c.useCaseCode === 'AI_GOVERNANCE') return technique('use_case_code=AI_GOVERNANCE');
  if (c.operationCode && TECHNICAL_OPERATIONS.has(c.operationCode)) return technique(`operation_code=${c.operationCode}`, 'operations_registry');
  if (c.trigger && TECHNICAL_TRIGGERS.has(c.trigger)) return technique(`metadata.trigger=${c.trigger}`, 'ai_usage_event', tr.treatment);
  if (l.corpusAccountId !== null && c.accountId === l.corpusAccountId) return technique('account_id=CORPUS_ACCOUNT_ID', 'environment', tr.treatment);
  if (tr.treatment === 'T5') return technique(`operation_code=${c.operationCode} (outil retiré au lot 49)`, 'operations_registry', 'T5');

  // 2. Travail de file existant.
  if (l.job) {
    const j = l.job;
    const jobEv: HistoryEvidence = { source: 'ai_job_queue', ref: `id=${j.id} (${j.treatment})`, proves: 'execution' };
    if (j.treatment === 'T1') {
      if (j.targetType !== 'asset_file') return technique(`ai_job_queue id=${j.id} : passage T1 sans document`, 'ai_job_queue', 'T1');
      return business(base, 'T1', j.businessExecutionId ?? `T1:job:${j.id}`, [...ev, jobEv]);
    }
    if (j.treatment === 'T3' || j.treatment === 'T4') {
      if (j.accountId === null) return technique(`ai_job_queue id=${j.id} : balayage planifié sans compte`, 'ai_job_queue', j.treatment);
      return business(base, j.treatment, `${j.treatment}:${j.id}`, [...ev, jobEv]);
    }
  }
  // 3. Rapport T1 portant la trace.
  if (l.t1Report) {
    return business(base, 'T1', l.t1Report.executionId, [...ev, { source: 'ai_execution_reports', ref: `id=${l.t1Report.id} (trace ${c.traceId})`, proves: 'execution' }]);
  }
  // 4. Génération T6 FORMULATE.
  if (l.t6Generation) {
    return business(base, 'T6', `T6F:${l.t6Generation.traceId}`, [...ev, { source: 'home_mascot_generations', ref: `trace_id=${l.t6Generation.traceId}`, proves: 'execution' }]);
  }
  // 5. Évaluation T6 EVALUATE.
  if (l.t6Evaluation) {
    return business(base, 'T6', l.t6Evaluation.executionId, [...ev, { source: 't6_evaluation_runs', ref: `agenda_item_id=${l.t6Evaluation.agendaItemId} (trace ${c.traceId})`, proves: 'execution' }]);
  }
  // 6. Non déterminable.
  const motif = tr.treatment === 'T2'
    ? 'demande de l’assistant non déterminable : aucune référence persistante de la demande dans l’appel (un rapprochement par l’heure ne prouve rien)'
    : c.jobId !== null
      ? `travail de file ${c.jobId} introuvable (supprimé) : exécution non déterminable`
      : 'aucun lien persistant (travail, rapport, génération, évaluation) : exécution non déterminable';
  return { ...base, nature: 'UNDETERMINED', treatment: tr.treatment, executionId: null, outcome: 'UNDETERMINED', evidence: ev, reason: motif };
}

function business(base: Pick<HistoryClass, 'rule' | 'runId' | 'classifiedAt'>, treatment: string, executionId: string, evidence: HistoryEvidence[]): HistoryClass {
  return { ...base, nature: 'BUSINESS', treatment, executionId, outcome: 'UNDETERMINED', evidence, reason: null };
}

/**
 * Issue de l'exécution prouvée, lue par la projection P2 (le service la
 * fournit). Exécution introuvable dans les états natifs → l'exécution n'est
 * PAS retenue (jamais un identifiant qui ne pointe sur rien) : non
 * déterminable, motif tracé. Exécution technique (balayage) → technique. Pur.
 */
export function withExecutionOutcome(
  k: HistoryClass,
  x: { outcome: HistoryOutcome; nature: 'BUSINESS' | 'TECHNICAL' } | null,
): HistoryClass {
  if (!k.executionId) return k;
  if (!x) {
    return {
      ...k, nature: 'UNDETERMINED', executionId: null, outcome: 'UNDETERMINED',
      reason: `exécution ${k.executionId} introuvable dans les états natifs (données disparues ou remplacées) : non déterminable`,
    };
  }
  if (x.nature === 'TECHNICAL') return { ...k, nature: 'TECHNICAL', outcome: x.outcome };
  return { ...k, outcome: x.outcome };
}

/** Lecture tolérante d'un classement stocké (null si illisible). Pur. */
export function readHistoryClass(raw: unknown): HistoryClass | null {
  const v = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })() : raw;
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.rule !== 'string' || !(HISTORY_NATURES as readonly string[]).includes(String(o.nature))) return null;
  return o as unknown as HistoryClass;
}

/**
 * Libellé de la colonne « traitement » d'un appel sans traitement établi par
 * son code d'usage, après reclassement (complète `executionScopeLabel`). Pur.
 */
export function historyScopeLabel(k: HistoryClass | null): string | null {
  if (!k) return null;
  if (k.nature === 'TECHNICAL') return 'Technique';
  if (k.treatment && k.treatment !== 'T5') return `${k.treatment} (historique)`;
  return 'Non déterminable (historique)';
}

/** Résumé lisible d'un classement (détail d'appel, export). Pur. */
export function historyClassSummary(k: HistoryClass): string {
  const nature = HISTORY_NATURE_LABELS[k.nature];
  const exec = k.executionId ? ` · exécution ${k.executionId} (${HISTORY_OUTCOME_LABELS[k.outcome]})` : '';
  const motif = k.reason ? ` · ${k.reason}` : '';
  return `Reclassement historique (${k.rule}) : ${nature}${k.treatment ? ` ${k.treatment}` : ''}${exec}${motif}`;
}
