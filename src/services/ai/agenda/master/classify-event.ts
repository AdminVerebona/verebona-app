/**
 * T4 master — branche CLASSIFY_EVENT (CDC 15 §26, T4-10, T4-11, C1 à C5).
 *
 * Le catalogue d'événements est transmis en DONNÉES (EVENT_CATALOG du
 * registre, U6) ; aucune règle par type de contrat dans le code (C4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 54 — T4 DÉCISIONNAIRE (ticket « rendre l'IA décisionnaire de
 * l'existence et de la récurrence d'un événement Agenda »)
 *
 *   · `decideAgendaEvent` (flux documentaire AUTOMATIQUE) : T4 est le gate
 *     sémantique AVANT toute création. Le serveur fournit le contexte (dont
 *     le candidat de récurrence et, à titre d'indice, la classification
 *     déterministe existante) ; T4 répond `agendaDecision` et
 *     `recurrenceDecision` (`t4_output_v2`). Le code VÉRIFIE la cohérence
 *     avec l'entrée réelle puis respecte strictement la décision. Échec
 *     complet de la cascade : abstention (aucune création), jamais le repli
 *     historique `action`.
 *   · `classifyEventMaster` (parcours MANUEL) : inchangé dans son principe —
 *     catégorie, repli `action` ambigu en cas d'échec.
 *
 * Une version de prompt restée en `t4_output_v1` (Legacy réactivée, ou
 * structurée v1) répond sans décision d'existence ni de récurrence. Lot 71E
 * (ticket T4 fiabilisation, §D) : cette absence n'est PLUS lue comme une
 * acceptation dans le flux automatique — la décision appliquée est une
 * ABSTENTION (`T4_OUTPUT_V1_NO_AGENDA_DECISION`) : aucune création, aucune
 * série, aucun retrait. La catégorie lue reste tracée ; le parcours manuel
 * (`classifyEventMaster`) et les données historiques sont inchangés.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { AiGateway } from '../../gateway/ai-gateway';
import { isExecutionCancelled } from '../../queue/execution-control';
import { EVENT_CATALOG, resolveDocumentType } from '@/services/canonical/registry';
import type { AgendaClassification, AgendaClassificationInput } from '../types';
import type { RecurrenceSpec } from '../rules/recurrence';
import {
  T4ClassifyEventOutput, T4ClassifyEventV2Output, T4ClassifyEventV3Output, closedWorldBusinessType, closedWorldBusinessTypeV2,
  type T4ClassifyEventOutput as Out, type T4ClassifyEventV2Output as OutV2, type T4ClassifyEventV3Output as OutV3,
  type T4AgendaDecisionValue, type T4InterventionAssessment, type T4RecurrenceDecisionValue,
} from './t4-contract';

/** Récurrence ENVISAGÉE par le serveur, soumise à T4 (ticket §1, §5). */
export interface T4RecurrenceCandidate {
  mode: 'EXPLICIT_SOURCE' | 'HISTORICAL_PATTERN';
  frequency: string;
  interval: number;
  startDate: string | null;
  endDate: string | null;
  occurrenceCount: number | null;
  /** Passage de la source qui énonce la récurrence (≤ 300 caractères). */
  excerpt: string | null;
  /** Dates historiques comparables (HISTORICAL_PATTERN). */
  history: string[];
}

export interface ClassifyEventContext {
  accountId: number;
  userId?: number;
  sourceFileId?: number | null;
  excerpt?: string;
  date?: string | null;
  /** Lot 54 : type documentaire de la source (code du DOCUMENT_CATALOG), s'il est connu. */
  documentType?: string | null;
  /** Lot 54 : récurrence envisagée par le serveur, ou null. */
  recurrenceCandidate?: T4RecurrenceCandidate | null;
  /** Lot 54 : classification déterministe existante, transmise comme INDICE (jamais décisive). */
  ruleHint?: { category: string; source: string; ruleCode: string } | null;
  /**
   * Lot 61 : demande d'évaluation d'une intervention « À traiter » (contrat
   * de sortie `t4_output_v3`, bloc `intervention`). Absente : T4 ne remplit
   * pas le bloc (null). Une version active v1 / v2 l'ignore.
   */
  toProcessAssessment?: ToProcessAssessmentRequest | null;
}

/** Lot 61 — ce que le serveur demande à T4 pour une carte « À traiter » (données, jamais de texte intégral). */
export interface ToProcessAssessmentRequest {
  /** Version du contrat de décision interne (`atr-decision-v1`). */
  contractVersion: string;
  /** PAST_DEADLINE · UNDATED (date inconnue) · TITLE_ONLY (date suggérée par le titre seulement). */
  situation: string;
  /** Donnée documentaire concernée (clé du registre) et question qui serait posée. */
  dataKey: string;
  question: string;
  /** Date du jour (Europe/Paris). */
  today: string;
  /** Dates candidates et leur source (FACTS, SOURCE_UNITS, CALCULATED…). */
  candidates: Array<{ date: string; source: string }>;
  /** Autres dates fiables du document (début, date du document…), pour situer le contrat dans le temps. */
  documentDates: Array<{ key: string; date: string }>;
  /** Titre lu (indice, ≤ 200). */
  documentTitle: string | null;
}

/** Catalogue fermé transmis au modèle (U6). */
export function eventCatalogForPrompt(): Array<{ businessType: string; label: string; natures: string[] }> {
  return EVENT_CATALOG.map((e) => ({ businessType: e.businessType, label: e.label, natures: [...e.natures] }));
}

/** Candidat de récurrence à partir d'une spécification (sans dates listées ni texte long). */
export function recurrenceCandidateOf(spec: RecurrenceSpec, history?: string[]): T4RecurrenceCandidate {
  return {
    mode: spec.mode,
    frequency: spec.frequency,
    interval: spec.interval,
    startDate: spec.startDate ?? null,
    endDate: spec.endDate ?? null,
    occurrenceCount: spec.occurrenceCount ?? null,
    excerpt: spec.excerpt ? spec.excerpt.slice(0, 300) : null,
    history: history ? [...history] : [],
  };
}

export function classifyEventVariables(input: AgendaClassificationInput, ctx: ClassifyEventContext): Record<string, unknown> {
  const doc = ctx.documentType ? resolveDocumentType(ctx.documentType) : null;
  return {
    EVENT_CONTEXT: {
      title: input.title,
      date: ctx.date ?? null,
      description: input.description ?? null,
      originFieldKey: input.originFieldKey ?? null,
      nature: input.nature ?? null,
      businessType: input.businessType ?? null,
      documentType: ctx.documentType ?? null,
      // Le modèle sait POURQUOI le moteur envisage une récurrence (ou qu'il
      // n'en envisage aucune : null).
      recurrenceCandidate: ctx.recurrenceCandidate ?? null,
      ...(ctx.ruleHint ? { ruleHint: ctx.ruleHint } : {}),
      // Lot 61 : présent seulement pour une évaluation « À traiter ».
      ...(ctx.toProcessAssessment ? { toProcessAssessment: ctx.toProcessAssessment } : {}),
    },
    EVENT_CATALOG: eventCatalogForPrompt(),
    EVIDENCE: (ctx.excerpt ?? input.description ?? '').slice(0, 500) || null,
    // Type documentaire (contexte optionnel de CLASSIFY_EVENT en t4_input_v2 ;
    // ignoré par t4_input_v1).
    DOCUMENT_TYPE: ctx.documentType ? { code: ctx.documentType, label: doc?.label ?? null } : null,
    AGENDA_ITEM: null, TEMPORAL_CONTEXT: null, TEMPORAL_CANDIDATES: null,
  };
}

/** Traduction pure d'une sortie v1 (monde fermé U6). */
export function translateClassifyEvent(out: Out | OutV2 | OutV3): { classification: AgendaClassification; warning: string | null } {
  const allowed = new Set(EVENT_CATALOG.map((e) => e.businessType as string));
  if ('agendaDecision' in out) {
    const { output, warning } = closedWorldBusinessTypeV2(out, allowed);
    return {
      classification: {
        category: output.agendaDecision === 'accept' ? output.homeCategory : 'unknown',
        confidence: output.agendaDecision === 'accept' ? output.confidence : 'ambiguous',
        source: 'model', businessType: output.businessType ?? null, reason: output.reason,
      },
      warning,
    };
  }
  const { output, warning } = closedWorldBusinessType(out, allowed);
  return {
    classification: {
      category: output.homeCategory, confidence: output.confidence, source: 'model',
      businessType: output.businessType ?? null, reason: output.reason,
    },
    warning,
  };
}

// ── Décision T4 (flux documentaire automatique) ─────────────────────────────

/** Issue de l'appel T4 : sortie v2, sortie v1 (version historique), ou échec technique. */
export type T4DecisionOutcome = 'model_v2' | 'model_v1' | 'technical_failure';

export interface T4EventDecision {
  agendaDecision: T4AgendaDecisionValue;
  recurrenceDecision: T4RecurrenceDecisionValue;
  /** Catégorie retenue (`unknown` hors `accept`) et confiance. */
  classification: AgendaClassification;
  reason: string;
  recurrenceReason: string | null;
  outcome: T4DecisionOutcome;
  /** Avertissements serveur (cohérence, monde fermé, contrat v1). */
  warnings: string[];
  /** Échec technique : code et message (sans contenu documentaire). */
  error?: { code: string; message: string };
  /** Trace de l'appel (BO › Exécutions IA). */
  traceId?: string;
  /**
   * Lot 61 — évaluation de l'intervention « À traiter » (`t4_output_v3`),
   * telle que rendue par le modèle ; `undefined` : contrat v1 / v2 (aucune
   * évaluation structurée possible) ; `null` : non remplie.
   */
  intervention?: T4InterventionAssessment | null;
  /** Lot 61 — version du contrat de sortie lue (1, 2 ou 3), absente en échec technique. */
  contractVersion?: 1 | 2 | 3;
}

/**
 * Cohérence de la sortie v2 avec l'ENTRÉE réelle (ticket §2) :
 *   · sans candidat de récurrence → `not_applicable` (toute autre valeur
 *     est ramenée à `not_applicable`, avertissement) ;
 *   · avec candidat → `accept | reject | abstain` (`not_applicable` → abstain) ;
 *   · événement refusé ou abstenu → aucune récurrence acceptée (abstain si
 *     le modèle l'acceptait).
 */
export function checkDecisionCoherence(
  out: OutV2, hasRecurrenceCandidate: boolean,
): { recurrenceDecision: T4RecurrenceDecisionValue; warnings: string[] } {
  const warnings: string[] = [];
  let r = out.recurrenceDecision;
  if (!hasRecurrenceCandidate && r !== 'not_applicable') {
    warnings.push(`RECURRENCE_DECISION_WITHOUT_CANDIDATE:${r}`);
    r = 'not_applicable';
  }
  if (hasRecurrenceCandidate && r === 'not_applicable') {
    warnings.push('RECURRENCE_CANDIDATE_NOT_DECIDED');
    r = 'abstain';
  }
  if (out.agendaDecision !== 'accept' && r === 'accept') {
    warnings.push(`RECURRENCE_ACCEPTED_ON_${out.agendaDecision.toUpperCase()}`);
    r = 'abstain';
  }
  return { recurrenceDecision: r, warnings };
}

/** Traduction pure d'une sortie (v2 ou v1) en décision appliquée par le moteur. */
export function translateEventDecision(out: Out | OutV2 | OutV3, hasRecurrenceCandidate: boolean): T4EventDecision {
  const { classification, warning } = translateClassifyEvent(out);
  const warnings = warning ? [warning] : [];
  if ('agendaDecision' in out) {
    const c = checkDecisionCoherence(out, hasRecurrenceCandidate);
    // Lot 61 : v3 = v2 + bloc `intervention` (même décision Agenda).
    const v3 = 'intervention' in out;
    return {
      agendaDecision: out.agendaDecision, recurrenceDecision: c.recurrenceDecision, classification,
      reason: out.reason, recurrenceReason: out.recurrenceReason ?? null, outcome: 'model_v2', warnings: [...warnings, ...c.warnings],
      contractVersion: v3 ? 3 : 2,
      ...(v3 ? { intervention: (out as OutV3).intervention ?? null } : {}),
    };
  }
  // Version de prompt historique (t4_output_v1) : aucune décision d'existence
  // ni de récurrence. Lot 71E (§D) : jamais d'acceptation IMPLICITE dans le
  // flux automatique — abstention conservatrice (aucune création, aucune
  // série, aucun retrait fondé sur cette sortie). La catégorie lue est
  // conservée pour la trace BO ; le parcours manuel ne passe pas par ici.
  return {
    agendaDecision: 'abstain',
    recurrenceDecision: hasRecurrenceCandidate ? 'abstain' : 'not_applicable',
    classification, reason: `contrat de sortie t4_output_v1 : existence non évaluée par le modèle (${out.reason})`.slice(0, 500),
    recurrenceReason: hasRecurrenceCandidate ? 'contrat de sortie t4_output_v1 : récurrence non évaluée' : null,
    outcome: 'model_v1',
    warnings: [...warnings, 'T4_OUTPUT_V1_NO_AGENDA_DECISION', ...(hasRecurrenceCandidate ? ['T4_OUTPUT_V1_NO_RECURRENCE_DECISION'] : [])],
    contractVersion: 1,
  };
}

/** Décision d'abstention sur échec technique (ticket §9). */
export function failedEventDecision(
  hasRecurrenceCandidate: boolean, error: { code: string; message: string }, traceId?: string | null,
): T4EventDecision {
  return {
    agendaDecision: 'abstain',
    recurrenceDecision: hasRecurrenceCandidate ? 'abstain' : 'not_applicable',
    classification: { category: 'unknown', confidence: 'ambiguous', source: 'fallback', reason: 'échec technique T4' },
    reason: 'échec technique T4 : aucune décision du modèle', recurrenceReason: null,
    outcome: 'technical_failure', warnings: [], error,
    // Lot 71E (§E) : trace de l'exécution en échec (passerelle), pour y rattacher la décision.
    ...(traceId ? { traceId } : {}),
  };
}

async function callClassify(input: AgendaClassificationInput, ctx: ClassifyEventContext) {
  return AiGateway.execute<Out | OutV2 | OutV3>({
    useCaseCode: 'AGENDA_INTELLIGENCE',
    operationCode: 't4_classify_event',
    accountId: ctx.accountId,
    userId: ctx.userId,
    sourceIds: ctx.sourceFileId ? [ctx.sourceFileId] : undefined,
    promptVariables: classifyEventVariables(input, ctx),
    // Contrat de sortie choisi par la version de prompt : v1 (historique) ou
    // v2 (`t4_output_v2`). La passerelle retient le schéma de CE contrat.
    outputSchema: T4ClassifyEventOutput,
    // Lot 61 : `t4_output_v3` (v2 + intervention « À traiter »).
    acceptedOutputSchemas: [T4ClassifyEventV2Output, T4ClassifyEventV3Output],
  });
}

/**
 * Décision T4 d'un candidat Agenda AUTOMATIQUE (ticket §3, §7, §9). Jamais
 * d'exception hors annulation : un échec complet de la cascade rend une
 * abstention marquée `technical_failure`.
 */
export async function decideAgendaEvent(
  input: AgendaClassificationInput, ctx: ClassifyEventContext,
  deps: { call?: typeof callClassify } = {},
): Promise<T4EventDecision> {
  const hasCandidate = Boolean(ctx.recurrenceCandidate);
  let d: T4EventDecision;
  try {
    const res = await (deps.call ?? callClassify)(input, ctx);
    d = { ...translateEventDecision(res.data, hasCandidate), traceId: res.traceId };
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    const err = e as { code?: string; message?: string; traceId?: string };
    d = failedEventDecision(
      hasCandidate,
      { code: typeof err.code === 'string' ? err.code : 'T4_CALL_FAILED', message: String(err.message ?? e).slice(0, 300) },
      typeof err.traceId === 'string' ? err.traceId : null,
    );
  }
  if (d.warnings.length) console.warn(`[t4_classify_event] ${d.warnings.join(', ')}`);
  return d;
}

/** Classification par le master (parcours manuel). Échec : repli historique `action`, ambigu. */
export async function classifyEventMaster(
  input: AgendaClassificationInput, ctx: ClassifyEventContext,
): Promise<AgendaClassification> {
  try {
    const res = await callClassify(input, ctx);
    const { classification, warning } = translateClassifyEvent(res.data);
    if (warning) console.warn(`[t4_classify_event] ${warning} — type métier ignoré (U6)`);
    return classification;
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    console.warn('[t4_classify_event] classification modèle indisponible :', (e as Error).message);
    return { category: 'action', confidence: 'ambiguous', source: 'fallback', reason: 'modèle indisponible' };
  }
}
