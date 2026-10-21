/**
 * Pont générique analyse / état d'un document → « À traiter », piloté par le
 * catalogue `PROCESSING_RULES` (lot 28, ticket P0).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ
 *
 * LINK-ASSET, DATA-CONTRACT-END, DATA-WARRANTY-END et DATA-SUPPLIER étaient
 * déclarées au catalogue sans qu'aucun traitement ne les produise : un
 * document sans bien, un contrat sans date de fin n'apparaissaient jamais
 * dans « À traiter ».
 *
 * La correction n'ajoute PAS un traitement par règle. Ce module parcourt les
 * règles `producer: 'DOCUMENT_BRIDGE'` du catalogue et applique à chacune la
 * même mécanique :
 *
 *   analyse / état ─► décision sur la donnée ─► règle du catalogue
 *     aucune règle                         → aucune action
 *     décision automatique possible        → écriture + fermeture de l'action
 *     proposition(s) sans décision         → ARBITRATE
 *     aucune proposition + complétion      → COMPLETE
 *     aucune proposition + completePriority null → aucune action
 *
 * Champs et relations suivent le même chemin : seul l'emplacement de la
 * donnée diffère (`document-slots.ts`). Ajouter une donnée documentaire =
 * ajouter une ligne au catalogue.
 *
 * ── TROIS DÉCLENCHEURS, UNE SEULE DÉCISION ────────────────────────────────
 *
 *   · analyse (`syncDocumentRulesFromAnalysis`, pipeline T1, étape 12 ter) :
 *     propositions de l'analyse, matrice complète de `decide()` ;
 *   · état (`syncDocumentRulesFromState`) : après une correction de
 *     l'utilisateur sur un écran métier, et à chaque balayage horaire. Ferme
 *     ce qui est résolu ; ouvre une complétion pour une donnée requise
 *     absente ; n'écrit jamais rien automatiquement ;
 *   · base : le déclencheur 0257 ferme LINK-ASSET à la seconde où un lien
 *     vers un bien est posé, par n'importe quel chemin.
 *
 * ── CE QUI EST PROTÉGÉ ────────────────────────────────────────────────────
 *
 *   · une valeur saisie ou validée par l'utilisateur n'est jamais écrasée :
 *     une valeur contradictoire ouvre un arbitrage (`decide()`, P-05) ;
 *   · une valeur que l'utilisateur a RETIRÉE (rattachement défait, champ
 *     vidé) n'est pas réécrite automatiquement : la proposition est soumise ;
 *   · une donnée non pertinente pour le Type du document
 *     (`relevantDocumentTypes`) n'ouvre aucune action ;
 *   · une action déclarée « Non applicable » ne revient pas sans élément
 *     nouveau (§7.4, empreinte de `upsertAction`).
 *
 * Aucune exception ne remonte : une carte manquée se rattrape au balayage
 * suivant ; une analyse perdue, non. Lot 61 : chaque erreur est néanmoins
 * RAPPORTÉE (compte, document, règle, étape, cause) jusqu'au bilan du
 * balayage et au diagnostic BO, et n'entraîne jamais de fermeture.
 *
 * ── LOT 61 — UNE DÉCISION CENTRALE AVANT TOUTE CARTE ──────────────────────
 *
 *   A. résolution automatique : connaissance T1, documents du même contrat,
 *      calcul déterministe (échéance THÉORIQUE, marquée calculée) ;
 *   B. pertinence (importance, actionnabilité, nécessité, temporalité,
 *      fiabilité) : `assessDeadlinePertinence` — code + T4 `t4_output_v3` ;
 *   C. décision AUTO_RESOLVED / NO_ACTION / DEFER / CREATE_ACTION, tracée
 *      (0418 + 0444) même sans carte ; CREATE_ACTION = question sur la donnée
 *      OU carte d'intervention réelle (`document-intervention.ts`).
 * Écriture, vérification et fermeture : une seule transaction (écart 1).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'crypto';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { assets, toProcessActionEvents, toProcessActions } from '@/db/schema';
import { AI_CONFIDENCE_THRESHOLD } from '@/lib/referential/v2';
import type { ActionKind, ActionProposal, ResolutionReason } from './action-model';
import {
  assessDeadlinePertinence, assessKnownDeadlineObligation, currentKnowledgeRev, deterministicConfigRef, documentBridgeFieldKey, gatherFieldEvidence,
  gatherRelatedDocumentValues, isDeadlineRule, knowledgeRevSql, parseDocumentDate, recordRuleEvaluation, relevanceColumnsReady, rememberedPertinence,
  ruleEvaluationsReady, t1KeyDesignates, t4AssessmentConfig, todayParis, withRelatedEvidence, DOCUMENT_RULE_ENGINE_VERSION,
  type FieldEvidence, type PertinenceCandidate, type PertinenceResult, type RuleDecision, type RuleEvaluationRecord, type RuleOutcome, type RuleTrigger,
  type T4AssessmentConfig,
} from './document-field-evidence';
import { decide } from './decision-engine';
import { derivationFor, endDateNeed, gatherDerivation, type DerivationResult } from './document-derivations';
import { closeDocumentIntervention, interventionKey, upsertDocumentIntervention } from './document-intervention';
import {
  documentSlotFor, formatIsoDate, readValueKind, toIsoDate, withdrawCalculatedValue, type DocumentSlot, type DocumentSlotState,
} from './document-slots';
import {
  documentBridgeRules,
  isRuleRelevantForDocument,
  ruleDataKey,
  type ProcessingRule,
} from './rules-catalog';
import { upsertAction } from './to-process-action.service';
import { unnamedLabel } from './card-labels';
import { ASSET_LINK_QUESTION_ALLOWED_SQL, assetLinkQuestionAllowed } from '@/services/ai/reconciliation/document-asset/question-gate';

// ══════════════════════════════════════════════════════════════════════════
// PLANIFICATION — fonction pure, testée sans base (TEST-ATP-01 à 11)
// ══════════════════════════════════════════════════════════════════════════

export type RulePlan =
  | { kind: 'WRITE'; value: string | number | boolean | null; confidence: number; evidenceIds: string[]; reason: string }
  | { kind: 'RESOLVE'; reason: string }
  | { kind: 'UPSERT'; actionKind: ActionKind; proposals: ActionProposal[]; reason: string }
  | { kind: 'NONE'; reason: string };

export interface PlanInput {
  rule: ProcessingRule;
  state: Pick<DocumentSlotState, 'value' | 'values' | 'userValidated'>;
  proposals: ActionProposal[];
  /** Donnée attendue pour ce document (`isRuleRelevantForDocument`). */
  relevant: boolean;
  /** `analysis` : propositions fraîches ; `state` : réévaluation sans analyse. */
  mode: 'analysis' | 'state';
  /** Action active de la donnée, s'il y en a une. */
  active?: { actionKind: ActionKind; snapshot: string | null } | null;
  /** Création autorisée (document éligible, pas de « Non applicable » antérieur). */
  mayCreate?: boolean;
  /**
   * Lot 31B (ticket T3, §9) : la donnée est confiée à T3 DOCUMENT_ASSET — pas
   * de question à l'utilisateur tant que T3 n'a pas échoué ou ne s'est pas
   * abstenu (une donnée déjà présente reste close normalement).
   */
  deferredToT3?: boolean;
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === '';
const asString = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** Décision pour UNE règle sur UN document. Voir l'en-tête du module. */
export function planDocumentRule(p: PlanInput): RulePlan {
  const { rule, state } = p;
  const mayCreate = p.mayCreate ?? true;
  const present = rule.cardinality === 'atLeastOne' ? state.values.length > 0 || !isEmpty(state.value) : !isEmpty(state.value);

  // Relation « au moins un » : un bien rattaché, quel qu'il soit, clôt la question.
  if (rule.cardinality === 'atLeastOne' && present) {
    return { kind: 'RESOLVE', reason: 'ALREADY_SATISFIED' };
  }
  // Confiée à T3 DOCUMENT_ASSET : ni écriture, ni question (lot 31B). Une
  // action déjà ouverte reste en l'état — T3 la mettra à jour ou la fermera.
  if (p.deferredToT3 && !present) {
    return { kind: 'NONE', reason: 'DEFERRED_TO_T3' };
  }

  // Valeur utilisateur en place : la donnée devient pertinente quoi qu'en dise le Type.
  const relevant = p.relevant || (present && state.userValidated);

  // ── Réévaluation sans analyse (balayage, correction ailleurs) ──────────
  if (p.mode === 'state') {
    if (p.active) {
      if (!relevant) return { kind: 'RESOLVE', reason: 'NOT_RELEVANT_ANYMORE' };
      if (p.active.actionKind === 'COMPLETE' && present) return { kind: 'RESOLVE', reason: 'COMPLETED_ELSEWHERE' };
      // Arbitrage : la donnée a changé depuis l'ouverture — quelqu'un a tranché.
      if (p.active.actionKind === 'ARBITRATE' && p.active.snapshot !== null && p.active.snapshot !== asString(state.value)) {
        return { kind: 'RESOLVE', reason: 'VALUE_CHANGED_SINCE_ARBITRATION' };
      }
      return { kind: 'NONE', reason: 'STILL_OPEN' };
    }
    if (present || !relevant || !mayCreate || rule.completePriority === null) {
      return { kind: 'NONE', reason: present ? 'ALREADY_SATISFIED' : 'NO_ACTION_EXPECTED' };
    }
    // Propositions conservées : soumises, jamais écrites sans analyse.
    const candidates = p.proposals.filter((x) => !x.isCurrentValue);
    return candidates.length > 0
      ? { kind: 'UPSERT', actionKind: 'ARBITRATE', proposals: candidates, reason: 'STORED_PROPOSALS' }
      : { kind: 'UPSERT', actionKind: 'COMPLETE', proposals: [], reason: 'REQUIRED_DATA_MISSING' };
  }

  // ── Analyse : matrice §11.3 (`decide`) ─────────────────────────────────
  const decision = decide({
    targetType: rule.targetType,
    key: ruleDataKey(rule),
    currentValue: state.value,
    userValidated: state.userValidated && present,
    proposals: p.proposals,
  });

  // Donnée RETIRÉE par l'utilisateur : pas de réécriture automatique.
  const userCleared = !present && state.userValidated;
  let verdict = decision.decision;
  if (userCleared && (verdict === 'APPLY' || verdict === 'UPDATE')) verdict = 'ARBITRATE';

  if (!relevant) {
    // Hors de la pertinence métier : une valeur fiable est écrite en silence,
    // tout le reste n'est pas un problème (P-06, ticket : « ne surtout pas
    // créer systématiquement une action pour tous les documents »).
    if (verdict === 'APPLY' || verdict === 'UPDATE') {
      return writePlan(decision.valueToWrite ?? null, p.proposals, `${decision.reasonCode}_SILENT`);
    }
    return { kind: 'RESOLVE', reason: 'NOT_RELEVANT' };
  }

  switch (verdict) {
    case 'APPLY':
    case 'UPDATE':
      return writePlan(decision.valueToWrite ?? null, p.proposals, decision.reasonCode);
    case 'KEEP':
    case 'IGNORE':
      return { kind: 'RESOLVE', reason: decision.reasonCode };
    case 'ARBITRATE':
      if (!mayCreate) return { kind: 'NONE', reason: 'NOT_ELIGIBLE' };
      return {
        kind: 'UPSERT',
        actionKind: 'ARBITRATE',
        proposals: decision.proposals ?? p.proposals.filter((x) => !x.isCurrentValue),
        reason: userCleared ? 'USER_CLEARED_VALUE' : decision.reasonCode,
      };
    case 'COMPLETE':
      if (!mayCreate) return { kind: 'NONE', reason: 'NOT_ELIGIBLE' };
      return { kind: 'UPSERT', actionKind: 'COMPLETE', proposals: [], reason: decision.reasonCode };
  }
}

function writePlan(value: string | number | boolean | null, proposals: ActionProposal[], reason: string): RulePlan {
  const source = proposals.filter((x) => !x.isCurrentValue && String(x.value) === String(value))
    .sort((a, b) => b.confidence - a.confidence)[0];
  return {
    kind: 'WRITE',
    value,
    confidence: source?.confidence ?? 1,
    evidenceIds: source?.evidenceIds ?? [],
    reason,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// OBSERVATIONS — résultats d'analyse → propositions, par donnée (générique)
// ══════════════════════════════════════════════════════════════════════════

type T1Confidence = 'certain' | 'probable' | 'conflictual';
const SCORE: Record<string, number> = { certain: 1, probable: 0.6, conflictual: 0.3 };
const score = (c: string | null | undefined) => SCORE[c ?? ''] ?? 0.3;

/** Fait lu par l'analyse, réduit à ce que le pont consomme. */
export interface ObservedFact {
  canonicalKey: string | null;
  /**
   * Lot 58B : clé LUE par T1 quand le fait n'a pas de clé canonique (fait
   * requalifié générique faute de normalisation, alias du registre). Elle
   * désigne la donnée par le registre (`t1KeyDesignates`), jamais par
   * ressemblance.
   */
  rawKey?: string | null;
  value: string | number | boolean | null;
  confidence: T1Confidence | string;
  excerpt?: string | null;
}

export interface ObservedAssetCandidate {
  entityId: number | null;
  verified: boolean;
  score: number;
  confidence: T1Confidence | string;
  label?: string | null;
}

export interface AnalysisObservations {
  facts: ObservedFact[];
  /** Candidats « bien » vérifiés en base par l'analyse. */
  assetCandidates: ObservedAssetCandidate[];
  /** Bien retenu par l'analyse (connu au dépôt, ou unique candidat certain). */
  documentAssetId: number | null;
  /** Métadonnées documentaires portées hors des faits (`document.supplier`…). */
  metadata?: Record<string, { value: string | number | null; confidence: T1Confidence | string; excerpt?: string | null } | undefined>;
  /**
   * Lot 31B : aucun bien certain — le rattachement (relation `assetIds`) est
   * confié à T3 DOCUMENT_ASSET, mis en file immédiatement par l'abonné
   * `source_analyzed`. La question n'est posée qu'après son échec.
   */
  deferAssetLinkToT3?: boolean;
}

/**
 * Propositions d'une donnée documentaire depuis l'analyse.
 *
 *   · relation `assetIds` : le bien retenu par l'analyse est une proposition
 *     certaine ; à défaut, les candidats vérifiés sont proposés SOUS le seuil
 *     d'automatisation — l'analyse a précisément refusé de trancher
 *     (`resolveAssetId` : « l'analyse ne tranche pas un rattachement
 *     ambigu ») ;
 *   · champ : les faits de même clé canonique, regroupés par valeur (la
 *     meilleure confiance l'emporte), puis la métadonnée de même nom.
 */
export function proposalsFromAnalysis(
  key: string,
  slot: Pick<DocumentSlot, 'kind' | 'normalize'>,
  obs: AnalysisObservations,
  assetNames: Map<number, string> = new Map(),
): ActionProposal[] {
  if (key === 'assetIds') {
    const label = (id: number) => assetNames.get(id) ?? unnamedLabel('ASSET');
    if (obs.documentAssetId !== null) {
      return [{ value: obs.documentAssetId, label: label(obs.documentAssetId), confidence: 1 }];
    }
    const vus = new Map<number, ActionProposal>();
    for (const c of obs.assetCandidates) {
      if (!c.verified || c.entityId === null) continue;
      const conf = Math.min(AI_CONFIDENCE_THRESHOLD - 0.01, Math.max(0, Number.isFinite(c.score) ? c.score : score(c.confidence)));
      const prev = vus.get(c.entityId);
      if (!prev || prev.confidence < conf) vus.set(c.entityId, { value: c.entityId, label: c.label ?? label(c.entityId), confidence: conf });
    }
    return [...vus.values()].sort(byConfidenceThenValue);
  }

  const parValeur = new Map<string, ActionProposal>();
  const ajouter = (raw: unknown, conf: number, excerpt?: string | null) => {
    const v = slot.normalize(raw);
    if (v === null) return;
    const k = String(v);
    const prev = parValeur.get(k);
    if (prev && prev.confidence >= conf) return;
    const iso = toIsoDate(k);
    parValeur.set(k, {
      value: v,
      label: iso && iso === k ? formatIsoDate(iso) : k,
      confidence: conf,
      ...(excerpt ? { sourceContext: { label: excerpt.slice(0, 120) } } : {}),
    });
  };
  for (const f of obs.facts) {
    // Lot 58B : clé canonique, ou — fait sans clé canonique — clé lue qui
    // désigne la donnée par le registre (alias canoniques).
    if (f.canonicalKey === key || (!f.canonicalKey && t1KeyDesignates(f.rawKey, key))) {
      // Une date dont l'ordre jour / mois reste ambigu n'est jamais certaine.
      const ambigu = typeof f.value === 'string' && parseDocumentDate(f.value).status === 'ORDER_AMBIGUOUS';
      ajouter(f.value, ambigu ? Math.min(score(f.confidence), SCORE.probable) : score(f.confidence), f.excerpt);
    }
  }
  const meta = obs.metadata?.[key];
  if (meta && parValeur.size === 0) ajouter(meta.value, score(meta.confidence), meta.excerpt);
  return [...parValeur.values()].sort(byConfidenceThenValue);
}

/** Ordre stable : une réanalyse identique produit la même carte. */
function byConfidenceThenValue(a: ActionProposal, b: ActionProposal): number {
  return b.confidence - a.confidence || String(a.value).localeCompare(String(b.value), 'fr', { numeric: true });
}

// ══════════════════════════════════════════════════════════════════════════
// EXÉCUTION
// ══════════════════════════════════════════════════════════════════════════

export interface DocumentRulesReport {
  created: number;
  updated: number;
  closed: number;
  written: number;
  /** Décision par règle, pour le journal et les tests. */
  plans: Record<string, RulePlan['kind']>;
  /** Lot 58B : motif de la décision par règle (NO_ACTION_NEEDED, REQUIRED_DATA_MISSING…). */
  reasons: Record<string, string>;
  /** Lot 58B : règles en erreur (aussi journalisées en base, diagnostic 0418). */
  errors: Record<string, string>;
  /**
   * Lot 61 (écart 5) : erreurs détaillées — compte, document, règle, étape, cause.
   * Lot 75I (B) : + nature (`kind`) — écriture NON CONFIRMÉE (PERSISTENCE_FAILED),
   * lecture, IA, calcul, journalisation (TRACE_FAILED)…
   */
  errorDetails: Array<{ accountId: number; fileId: number; ruleCode: string; step: string; cause: string; kind?: string; retryId?: number | null }>;
  /** Lot 61 : issue centrale par règle (AUTO_RESOLVED, NO_ACTION, DEFER, CREATE_ACTION, KEEP, ERROR). */
  outcomes: Record<string, string>;
  /** Lot 75I (B) : refus NORMAUX — écriture automatique refusée, valeur de l'utilisateur protégée (jamais une erreur). */
  protectedRefusals: number;
  /** Lot 76 (C8) : décisions APPLIQUÉES dont la trace a échoué (règle, n° de reprise ; null : reprise impossible). */
  untraced: Array<{ ruleCode: string; retryId: number | null }>;
}

const emptyReport = (): DocumentRulesReport => ({
  created: 0, updated: 0, closed: 0, written: 0, plans: {}, reasons: {}, errors: {}, errorDetails: [], outcomes: {}, protectedRefusals: 0, untraced: [],
});

/** Lot 75I (B) : erreur détaillée d'une règle (remonte au bilan du balayage et au BO). */
function pushError(report: DocumentRulesReport, e: { accountId: number; fileId: number; ruleCode: string; step: string; kind: string; cause: string; retryId?: number | null }): void {
  report.errorDetails.push({ ...e, cause: String(e.cause).slice(0, 300) });
}

/**
 * Lot 75I (E) : journalise une décision ; un ÉCHEC de journalisation remonte
 * au diagnostic technique (bilan du balayage, BO), jamais en console seule.
 */
async function tracer(report: DocumentRulesReport, rec: RuleEvaluationRecord): Promise<void> {
  const echec = await recordRuleEvaluation(rec);
  if (echec) {
    // Lot 76 (C8) : décision appliquée mais NON tracée — signalée (reprise identifiable), jamais un faux succès.
    pushError(report, { accountId: rec.accountId, fileId: rec.fileId, ruleCode: rec.ruleCode, step: 'TRACE', kind: 'TRACE_FAILED', cause: echec.cause, retryId: echec.retryId });
    report.untraced.push({ ruleCode: rec.ruleCode, retryId: echec.retryId });
  }
}

/** Contexte du document : Type, éligibilité à une nouvelle action. */
interface DocumentContext {
  exists: boolean;
  documentTypeCode: string | null;
  /** Document visible, ni brouillon ni écarté par l'utilisateur : une action peut naître. */
  open: boolean;
  /** `open` ET analyse terminée (ou jamais lancée) : le balayage peut créer. */
  eligible: boolean;
}

/** États d'analyse terminés — l'analyse ne viendra plus compléter la décision. */
const SETTLED_STATES = ['ANALYZED', 'VALIDATION_REQUIRED', 'CONFLICT_DETECTED', 'FUSION_SUGGESTED', 'ANALYSIS_FAILED'];

/** Document ouvert aux actions (visible, ni brouillon, ni écarté par l'utilisateur). */
const OPEN_SQL = `
      f.deleted_at IS NULL
  AND f.grouped_into_file_id IS NULL
  AND COALESCE(f.is_draft, false) = false
  AND COALESCE(f.is_ignored, false) = false
  AND COALESCE(f.upload_status, 'COMPLETED') = 'COMPLETED'`;

/**
 * Condition SQL d'éligibilité au balayage : document ouvert ET analyse
 * terminée — une analyse en cours ou en file décidera elle-même (un dépôt
 * jamais analysé est repris au bout d'un jour).
 */
const ELIGIBLE_SQL = `${OPEN_SQL}
  AND (f.analysis_state IS NULL
       OR f.analysis_state IN ('${SETTLED_STATES.join("', '")}')
       OR (f.analysis_state = 'UPLOADED' AND f.created_at < now() - interval '1 day'))`;

async function loadContext(accountId: number, fileId: number): Promise<DocumentContext> {
  const rows = (await pgClient.unsafe(
    `SELECT f.document_type_code AS type, f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL AS visible,
            (${OPEN_SQL}) AS open, (${ELIGIBLE_SQL}) AS eligible
       FROM asset_files f WHERE f.id = $1 AND f.account_id = $2`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ type: string | null; visible: boolean; open: boolean; eligible: boolean }>;
  const r = rows[0];
  if (!r || !r.visible) return { exists: false, documentTypeCode: null, open: false, eligible: false };
  return { exists: true, documentTypeCode: r.type, open: r.open, eligible: r.eligible };
}

type ActiveCard = { id: number; actionKind: ActionKind; snapshot: string | null };

/** Actions actives du document, par donnée (lot 61 : cartes d'intervention `intervention:<donnée>` comprises). */
async function activeActions(accountId: number, fileId: number): Promise<Map<string, ActiveCard>> {
  const rows = await db
    .select({
      id: toProcessActions.id,
      key: sql<string>`COALESCE(${toProcessActions.fieldKey}, ${toProcessActions.relationKey})`,
      actionKind: toProcessActions.actionKind,
      triggerContext: toProcessActions.triggerContext,
    })
    .from(toProcessActions)
    .where(and(
      eq(toProcessActions.accountId, accountId), eq(toProcessActions.targetType, 'DOCUMENT'),
      eq(toProcessActions.targetId, fileId), isNull(toProcessActions.resolvedAt),
    ));
  return new Map(rows.map((r) => {
    const ctx = r.triggerContext as { current?: unknown } | null;
    return [r.key, {
      id: r.id,
      actionKind: r.actionKind as ActionKind,
      snapshot: ctx && 'current' in ctx ? asString(ctx.current) : null,
    }];
  }));
}

/**
 * Lot 72 (C5) — décision « Non applicable » de l'utilisateur sur une donnée,
 * avec son CONTEXTE : valeurs que la carte proposait et révision de la
 * connaissance au moment du choix (`markNotApplicable`, ou base posée au
 * premier passage pour une décision antérieure au lot 72). Null : la
 * dernière décision n'est pas « Non applicable ».
 */
export interface UserNotApplicable {
  actionId: number; values: string[]; knowledgeRev: string | null;
  /** Lot 76 (C6) : problème métier de la carte refusée (nature, situation, clé de preuve). */
  problem?: ProblemDescriptor | null;
}

/**
 * Lot 76 (C6) — problème métier d'une carte : nature (donnée manquante,
 * incertaine, intervention…), situation temporelle et CLÉ DE PREUVE (clauses
 * du document citées par la décision, `problemProofKey`). Jamais le modèle,
 * la formulation ni la confiance.
 */
export interface ProblemDescriptor { problem: string | null; situation: string | null; proof: string | null }

const normProbleme = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Lot 76 (C6) — clé de preuve d'une décision (pure) : empreinte des TEXTES
 * DU DOCUMENT (clauses, extraits) qui contiennent la preuve citée par T4 —
 * jamais la formulation du modèle : la même clause citée autrement donne la
 * même clé ; une preuve introuvable dans les textes lus → null (aucun
 * problème démontré).
 */
export function problemProofKey(p: { evidence: string | null | undefined; clauses: ReadonlyArray<string | null | undefined> }): string | null {
  const evComplet = p.evidence ? normProbleme(p.evidence) : '';
  const ev = evComplet.slice(0, 120);
  if (ev.length < 8) return null;
  // Texte lu qui CONTIENT la preuve citée, ou contenu lu (≥ 15 caractères) que la preuve cite en entier.
  const sources = [...new Set(p.clauses.filter((c): c is string => !!c).map(normProbleme)
    .filter((c) => c.includes(ev) || (c.length >= 15 && evComplet.includes(c))))].sort();
  if (sources.length === 0) return null;
  return createHash('sha1').update(JSON.stringify(sources)).digest('hex').slice(0, 16);
}

export async function userNotApplicableDecision(accountId: number, fileId: number, key: string): Promise<UserNotApplicable | null> {
  const [last] = await db
    .select({ id: toProcessActions.id, reason: toProcessActions.resolutionReason, proposals: toProcessActions.proposalsJson, ctx: toProcessActions.triggerContext })
    .from(toProcessActions)
    .where(and(
      eq(toProcessActions.accountId, accountId), eq(toProcessActions.targetType, 'DOCUMENT'),
      eq(toProcessActions.targetId, fileId),
      sql`COALESCE(${toProcessActions.fieldKey}, ${toProcessActions.relationKey}) = ${key}`,
      isNotNull(toProcessActions.resolvedAt),
    ))
    .orderBy(desc(toProcessActions.resolvedAt))
    .limit(1);
  if (last?.reason !== 'NOT_APPLICABLE') return null;
  const [ev] = (await pgClient.unsafe(
    `SELECT details ->> 'knowledgeRev' AS rev FROM to_process_action_events
      WHERE action_id = $1 AND account_id = $2 AND details ? 'knowledgeRev' ORDER BY id DESC LIMIT 1`,
    [last.id, accountId] as never[],
  )) as unknown as Array<{ rev: string | null }>;
  const values = ((last.proposals as ActionProposal[] | null) ?? []).filter((p) => !p.isCurrentValue).map((p) => String(p.value));
  const j = (last.ctx as { justification?: { problem?: string | null; situation?: string | null; proof?: string | null } | null } | null)?.justification ?? null;
  return { actionId: last.id, values, knowledgeRev: ev?.rev ?? null,
    problem: j ? { problem: j.problem ?? null, situation: j.situation ?? null, proof: j.proof ?? null } : null };
}

/**
 * Lot 72 (C5) — contexte d'une décision « Non applicable » antérieure au
 * lot 72 (aucune révision mémorisée) : la révision ACTUELLE devient la base —
 * la décision reste respectée jusqu'au prochain changement réel. Tracé.
 */
async function recordNotApplicableBaseline(accountId: number, fileId: number, key: string, na: UserNotApplicable, rev: string | null): Promise<void> {
  await db.insert(toProcessActionEvents).values({
    actionId: na.actionId, accountId, event: 'USER_DECISION_CONTEXT', actorUserId: null, targetType: 'DOCUMENT', targetId: fileId,
    fieldKey: key, details: { reason: 'NOT_APPLICABLE_BASELINE', knowledgeRev: rev, engineVersion: DOCUMENT_RULE_ENGINE_VERSION }, createdAt: new Date(),
  });
}

/**
 * Lot 72 (C5) — une carte déclarée « Non applicable » ne revient que pour un
 * NOUVEAU problème démontré : une valeur candidate que la carte refusée ne
 * proposait pas. Lot 76 (C6) : ou, même SANS proposition de valeur, une
 * obligation nouvelle PROUVÉE — la décision courante cite une preuve
 * retrouvée dans le document (clé de preuve) que la situation refusée
 * n'avait pas. Les mêmes valeurs, une reformulation, un autre modèle ou une
 * autre confiance restent la même situation. Pure.
 */
export function newProblemSinceNotApplicable(
  plan: RulePlan, na: Pick<UserNotApplicable, 'values' | 'problem'> | null, current: ProblemDescriptor | null = null,
): boolean {
  if (!na || plan.kind !== 'UPSERT') return true;
  if (plan.proposals.some((p) => !p.isCurrentValue && !na.values.includes(String(p.value)))) return true;
  return !!current?.proof && current.proof !== (na.problem?.proof ?? null);
}

type TxClient = Pick<typeof db, 'select' | 'update' | 'insert'>;

/**
 * Ferme les cartes actives d'une donnée et TRACE chaque fermeture
 * (`to_process_action_events`) — lot 61, écart 6 : plus aucune fermeture
 * sans trace. Rend les identifiants fermés.
 */
async function closeDataActions(
  client: TxClient, accountId: number, fileId: number, key: string, reason: ResolutionReason, details: Record<string, unknown>,
): Promise<number[]> {
  // Lot 75I (E) : hors transaction appelante, fermeture et événement d'audit dans UNE transaction.
  if (client === db) return db.transaction((tx) => closeDataActions(tx, accountId, fileId, key, reason, details));
  const now = new Date();
  const closed = await client.update(toProcessActions)
    .set({ resolvedAt: now, resolutionReason: reason, updatedAt: now })
    .where(and(
      eq(toProcessActions.accountId, accountId), eq(toProcessActions.targetType, 'DOCUMENT'), eq(toProcessActions.targetId, fileId),
      sql`COALESCE(${toProcessActions.fieldKey}, ${toProcessActions.relationKey}) = ${key}`, isNull(toProcessActions.resolvedAt),
    ))
    .returning({ id: toProcessActions.id });
  if (closed.length) {
    await client.insert(toProcessActionEvents).values(closed.map((a) => ({
      actionId: a.id, accountId, event: reason, actorUserId: null, targetType: 'DOCUMENT', targetId: fileId,
      fieldKey: key, details, createdAt: now,
    })));
  }
  return closed.map((a) => a.id);
}

/** Écriture refusée (valeur protégée) ou non confirmée en base : la transaction est annulée, la carte reste. */
class WriteNotConfirmed extends Error {
  constructor(readonly status: 'REFUSED_PROTECTED_VALUE' | 'NOT_CONFIRMED', message: string) { super(message); }
}

/** Lecture de la connaissance impossible (panne) : jamais une « donnée absente ». */
class KnowledgeReadError extends Error {}

/** Résultat d'exécution d'un plan (cartes, écriture), pour la trace. */
interface ExecOutcome {
  actionId: number | null;
  closed: number[];
  created: number[];
  kept: number[];
  write: { attempted: boolean; confirmed: boolean | null; status: string; value?: unknown; valueKind?: string | null } | null;
}

/** Méta d'une écriture automatique (lot 61 : nature et provenance). */
interface WriteExtra { valueKind?: 'EXPLICIT' | 'CALCULATED'; derivation?: unknown }

/**
 * Lot 61 (écart 1) — écriture, VÉRIFICATION et fermeture dans UNE
 * transaction :
 *   1. cartes actives de la donnée verrouillées (FOR UPDATE) : une
 *      résolution concurrente attend ;
 *   2. fermeture (avant l'écriture : l'écriture d'un rattachement déclenche
 *      la 0257, qui fermerait sinon la carte avec un motif « utilisateur ») ;
 *   3. écriture conditionnelle (jamais par-dessus une valeur de
 *      l'utilisateur) ;
 *   4. relecture dans la transaction : la valeur DOIT être celle écrite.
 * Écriture refusée, non confirmée ou en erreur : tout est annulé — la carte
 * reste ouverte, l'échec est tracé.
 */
async function writeConfirmedAndClose(
  accountId: number, fileId: number, rule: ProcessingRule, slot: DocumentSlot, plan: Extract<RulePlan, { kind: 'WRITE' }>,
  extra: WriteExtra, details: Record<string, unknown>,
): Promise<number[]> {
  const key = ruleDataKey(rule);
  return db.transaction(async (tx) => {
    await tx.select({ id: toProcessActions.id }).from(toProcessActions)
      .where(and(
        eq(toProcessActions.accountId, accountId), eq(toProcessActions.targetType, 'DOCUMENT'), eq(toProcessActions.targetId, fileId),
        sql`COALESCE(${toProcessActions.fieldKey}, ${toProcessActions.relationKey}) = ${key}`, isNull(toProcessActions.resolvedAt),
      ))
      .for('update');
    const closed = await closeDataActions(tx, accountId, fileId, key, 'OBSOLETE', { ...details, reason: 'AUTO_RESOLVED', valueKind: extra.valueKind ?? 'EXPLICIT' });
    const ok = await slot.writeAuto(tx, accountId, fileId, plan.value, {
      origin: extra.valueKind === 'CALCULATED' ? 'SYSTEM_RULE' : 'RECONCILIATION', confidence: plan.confidence, evidenceIds: plan.evidenceIds,
      valueKind: extra.valueKind ?? 'EXPLICIT', derivation: extra.derivation ?? null,
    });
    if (!ok) throw new WriteNotConfirmed('REFUSED_PROTECTED_VALUE', 'écriture refusée : valeur de l’utilisateur en place ou cible indisponible');
    const apres = await slot.read(tx, accountId, fileId);
    const attendu = slot.normalize(plan.value);
    const confirme = slot.kind === 'relation'
      ? apres.values.some((v) => String(v) === String(attendu))
      : apres.value !== null && String(apres.value) === String(attendu);
    if (!confirme) throw new WriteNotConfirmed('NOT_CONFIRMED', `valeur relue ${String(apres.value)} ≠ ${String(attendu)}`);
    return closed;
  });
}

async function executePlan(
  accountId: number,
  fileId: number,
  rule: ProcessingRule,
  slot: DocumentSlot,
  plan: RulePlan,
  state: DocumentSlotState,
  report: DocumentRulesReport,
  closeReason: ResolutionReason,
  closeMotive: Record<string, unknown> = {},
  extra: WriteExtra & { triggerContext?: Record<string, unknown> } = {},
): Promise<ExecOutcome> {
  const key = ruleDataKey(rule);
  report.plans[rule.code] = plan.kind;
  report.reasons[rule.code] = plan.reason;
  const out: ExecOutcome = { actionId: null, closed: [], created: [], kept: [], write: null };
  switch (plan.kind) {
    case 'NONE':
      return out;
    case 'RESOLVE': {
      const sansObjet = plan.reason === 'NO_ACTION_NEEDED' || plan.reason === 'DEFERRED' || plan.reason === 'REPLACED_BY_INTERVENTION'
        || plan.reason === 'USER_DECISION_RESPECTED';
      out.closed = sansObjet
        ? await closeWithoutPurpose(accountId, fileId, rule, { ...closeMotive, reason: plan.reason })
        : await closeDataActions(db, accountId, fileId, key, closeReason, { ruleCode: rule.code, reason: plan.reason, ...closeMotive });
      report.closed += out.closed.length;
      return out;
    }
    case 'WRITE': {
      try {
        out.closed = await writeConfirmedAndClose(accountId, fileId, rule, slot, plan, extra, { ruleCode: rule.code, ...closeMotive });
        report.closed += out.closed.length;
        report.written += 1;
        out.write = { attempted: true, confirmed: true, status: 'CONFIRMED', value: plan.value, valueKind: extra.valueKind ?? 'EXPLICIT' };
      } catch (e) {
        if (!(e instanceof WriteNotConfirmed)) throw e;
        out.write = { attempted: true, confirmed: false, status: e.status, value: plan.value, valueKind: extra.valueKind ?? 'EXPLICIT' };
      }
      return out;
    }
    case 'UPSERT': {
      const res = await upsertAction({
        accountId,
        targetType: 'DOCUMENT',
        targetId: fileId,
        fieldKey: rule.fieldKey ?? null,
        relationKey: rule.relationKey ?? null,
        actionKind: plan.actionKind,
        ruleCode: rule.code,
        proposals: plan.proposals,
        // Valeur en place à l'ouverture : une modification ultérieure, d'où
        // qu'elle vienne, rend l'arbitrage sans objet (réévaluation d'état).
        // Lot 61 : justification de la carte (contrat de décision interne).
        triggerContext: { current: asString(state.value), ...(extra.triggerContext ?? {}) },
      });
      if (res.status === 'CREATED') { report.created += 1; if (res.actionId) out.created.push(res.actionId); }
      else if (res.status === 'UPDATED') { report.updated += 1; if (res.actionId) out.kept.push(res.actionId); }
      out.actionId = res.actionId ?? null;
      return out;
    }
  }
}

/**
 * Lot 58B / 61 : fermeture d'une carte devenue SANS OBJET (échéance
 * historique, interpellation différée, remplacée par l'action réelle,
 * décision de l'utilisateur respectée). Motif `OBSOLETE` (« le problème a
 * disparu ») et trace explicable dans `to_process_action_events`
 * (`details.reason`, pertinence, trace IA). Une carte que l'utilisateur a
 * déjà tranchée n'est plus active : jamais touchée.
 */
async function closeWithoutPurpose(accountId: number, fileId: number, rule: ProcessingRule, motive: Record<string, unknown>): Promise<number[]> {
  return closeDataActions(db, accountId, fileId, ruleDataKey(rule), 'OBSOLETE', { ruleCode: rule.code, reason: 'NO_ACTION_NEEDED', ...motive });
}

/** Noms des biens du compte, pour les libellés des propositions. */
async function assetNamesOf(accountId: number, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: assets.id, name: assets.name })
    .from(assets)
    .where(and(inArray(assets.id, [...new Set(ids)]), eq(assets.accountId, accountId), isNull(assets.deletedAt)));
  return new Map(rows.map((r) => [r.id, r.name ?? unnamedLabel('ASSET')]));
}


// ══════════════════════════════════════════════════════════════════════════
// LOTS 58B / 61 — DONNÉE DOCUMENTAIRE : CONNAISSANCE, CALCUL, PERTINENCE,
// DÉCISION, TRACE
// ══════════════════════════════════════════════════════════════════════════

/** Dépendances injectables (tests) : décision T4, date du jour, configuration T4. */
export interface FieldRuleDeps {
  decide?: Parameters<typeof assessDeadlinePertinence>[0]['decide'];
  today?: string;
  config?: T4AssessmentConfig;
}

interface FieldRuleInput {
  accountId: number;
  fileId: number;
  rule: ProcessingRule;
  slot: DocumentSlot;
  ctx: DocumentContext;
  state: DocumentSlotState;
  active: ActiveCard | null;
  /** Lot 61 : carte d'intervention active de la donnée. */
  activeIntervention?: ActiveCard | null;
  relevant: boolean;
  trigger: RuleTrigger;
  mayCreate: boolean;
  closeReason: ResolutionReason;
  /** Analyse T1 : propositions de la sortie fraîche. */
  obsProposals?: ActionProposal[];
  runRef?: string | null;
  deps?: FieldRuleDeps;
  report: DocumentRulesReport;
  /** Lot 72 (C5) : dernière décision « Non applicable » de l'utilisateur sur la donnée, avec son contexte. */
  userNotApplicable?: UserNotApplicable | null;
}

export interface FieldRuleOutcome {
  plan: RulePlan;
  /** KNOWLEDGE : connaissance persistée consultée ; CLASSIC : chemin antérieur (donnée présente, retirée, hors pertinence). */
  path: 'KNOWLEDGE' | 'CLASSIC';
  evidence: FieldEvidence | null;
  proposals: ActionProposal[];
  pertinence: PertinenceResult | null;
  writeAttempted: boolean;
  /** Écriture relue en base (WRITE), sinon null. */
  verified: boolean | null;
  actionId: number | null;
  decision: RuleDecision;
  /** Lot 61 : issue centrale. */
  outcome: RuleOutcome;
  /** Lot 61 : calcul déterministe tenté. */
  derivation: DerivationResult | null;
  /** Lot 61 : cartes d'intervention créées / fermées. */
  interventionIds: number[];
}

/** Propositions fusionnées par valeur (la meilleure confiance l'emporte), ordre stable. */
function mergeProposals(...lots: ActionProposal[][]): ActionProposal[] {
  const m = new Map<string, ActionProposal>();
  for (const p of lots.flat()) {
    const k = String(p.value);
    const prev = m.get(k);
    if (!prev || prev.confidence < p.confidence) m.set(k, prev?.sourceContext && !p.sourceContext ? { ...p, sourceContext: prev.sourceContext } : p);
  }
  return [...m.values()].sort(byConfidenceThenValue);
}

/** Dates candidates d'une échéance (propositions + indice du titre non confirmé), pour la pertinence. Pure. */
export function pertinenceCandidates(proposals: ActionProposal[], evidence: FieldEvidence | null): PertinenceCandidate[] {
  const source = (v: string) => evidence?.facts.find((f) => String(f.value) === v)?.source ?? 'T1_OUTPUT';
  const out: PertinenceCandidate[] = [];
  for (const p of proposals) {
    const v = String(p.value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) continue;
    out.push({ iso: v, source: source(v), excerpt: evidence?.facts.find((f) => String(f.value) === v)?.excerpt ?? p.sourceContext?.label ?? null });
  }
  const hint = evidence?.titleHint;
  if (hint) {
    for (const d of hint.dates) {
      if (!out.some((c) => c.iso === d)) out.push({ iso: d, source: hint.confirmed.includes(d) ? 'TITLE_CONFIRMED' : 'TITLE_ONLY', excerpt: hint.excerpt });
    }
  }
  return out;
}

const diagDecision = (plan: RulePlan, report: DocumentRulesReport, before: DocumentRulesReport, hadActive: boolean): RuleDecision => {
  if (plan.kind === 'WRITE') return 'WRITE';
  if (plan.kind === 'RESOLVE') return report.closed > before.closed ? 'CLOSE' : 'NONE';
  if (plan.kind === 'UPSERT') return report.created > before.created ? 'CREATE' : hadActive ? 'UPDATE' : 'NONE';
  return hadActive ? 'KEEP' : 'NONE';
};

/** Issue centrale d'un plan du chemin antérieur (donnée présente, retirée, hors pertinence). Pure. */
const classicOutcome = (plan: RulePlan, hadActive: boolean): RuleOutcome =>
  plan.kind === 'WRITE' ? 'AUTO_RESOLVED' : plan.kind === 'UPSERT' ? 'CREATE_ACTION' : plan.kind === 'RESOLVE' ? 'NO_ACTION' : hadActive ? 'KEEP' : 'NO_ACTION';

/** Type d'erreur tracé selon l'étape (écart 5). */
const errorKindOf = (e: unknown, step: string): string => e instanceof KnowledgeReadError ? 'READ_FAILED'
  : step === 'PERTINENCE' ? 'AI_OR_MEMORY_FAILED' : step === 'DERIVATION' ? 'DERIVATION_FAILED'
    : step === 'WRITE' || step === 'VERIFY' ? 'PERSISTENCE_FAILED' : step === 'KNOWLEDGE' ? 'READ_FAILED' : 'EVALUATION_FAILED';

/**
 * Une donnée documentaire (champ) d'une règle du pont, pour UN document —
 * même décision quel que soit le déclencheur (analyse T1, balayage, passage
 * T3, correction utilisateur, réévaluation rétroactive) :
 *
 *   1. donnée présente (lue ou saisie), retirée par l'utilisateur ou hors
 *      pertinence du Type → chemin antérieur (`planDocumentRule`) ;
 *   2. sinon (ou valeur CALCULÉE, reconsidérée à chaque fois), étape A —
 *      RÉSOLUTION AUTOMATIQUE avant toute question : connaissance T1
 *      persistée (faits, alias, faits non intégrés, unités, titre vérifié),
 *      documents du MÊME contrat (référence exacte), sortie fraîche de
 *      l'analyse → `decide()` ; puis calcul déterministe (début effectif +
 *      durée → échéance THÉORIQUE marquée calculée) ;
 *   3. étapes B / C — pertinence d'une question sur une ÉCHÉANCE
 *      (`assessDeadlinePertinence`) : NO_ACTION, DEFER (sans carte active),
 *      CREATE_ACTION (question sur la donnée, ou carte d'INTERVENTION
 *      réelle) ; jamais de fermeture sur un échec technique ;
 *   4. écriture transactionnelle vérifiée (écart 1) ; diagnostic complet
 *      (0418 + 0444), y compris en erreur.
 */
async function evaluateFieldRule(i: FieldRuleInput): Promise<FieldRuleOutcome> {
  const { accountId, fileId, rule, slot, state, active, relevant, report } = i;
  const key = ruleDataKey(rule);
  const present = !isEmpty(state.value);
  const avant = { ...report };
  const userCleared = state.userValidated && !present;
  let evidence: FieldEvidence | null = null;
  let pertinence: PertinenceResult | null = null;
  let proposals: ActionProposal[] = i.obsProposals ?? [];
  let plan: RulePlan;
  let path: FieldRuleOutcome['path'] = 'CLASSIC';
  let failedStep = 'PLAN';
  let derivation: DerivationResult | null = null;
  let extra: WriteExtra & { triggerContext?: Record<string, unknown> } = {};
  let outcome: RuleOutcome;
  let knowledgeRev: string | null = null;
  let configRef: string | null = null;
  let reasonOverride: string | null = null;
  const interventionIds: number[] = [];
  const ivClosed: number[] = [];
  const ivKept: number[] = [];
  let exec: ExecOutcome | null = null;
  let obligation: PertinenceResult | null = null;
  // Lot 76 (C6) : problème métier de la décision courante (nature, situation, clé de preuve).
  let probleme: ProblemDescriptor | null = null;
  let liesIntegres = false;
  /** Textes du document où une preuve citée par T4 doit se retrouver (clauses, extraits, titre). */
  // Lot 76 (C6) : CONTENUS lus (sans libellé ni clé) — un libellé renommé ne crée pas un « nouveau problème ».
  const textesPreuve = () => {
    const corps = evidence?.lifecycle?.clauseBodies ?? [];
    return [...(corps.length ? corps : evidence?.lifecycle?.clauses ?? []), ...(evidence?.facts ?? []).map((f) => f.excerpt ?? null), evidence?.documentTitle ?? null];
  };
  const preuveDe = (r: PertinenceResult | null) => (r && (r.aiCalled || r.cached) && r.outcome === 'CREATE_ACTION' && r.intervention?.evidence
    ? problemProofKey({ evidence: r.intervention.evidence, clauses: textesPreuve() }) : null);

  try {
    // Lot 61 : une valeur CALCULÉE automatiquement est reconsidérée (sources
    // changées, valeur lue apparue) — jamais une valeur lue ni saisie.
    let calculee = false;
    if (present && !state.userValidated && slot.kind === 'field' && derivationFor(key)) {
      failedStep = 'KNOWLEDGE';
      calculee = (await readValueKind(accountId, fileId, key)).kind === 'CALCULATED';
    }
    const planState = calculee ? { ...state, value: null } : state;

    if ((present && !calculee) || userCleared || !relevant) {
      failedStep = 'PLAN';
      plan = i.trigger === 'ANALYSIS'
        ? planDocumentRule({ rule, state, proposals, mode: 'analysis', relevant, mayCreate: i.mayCreate })
        : planDocumentRule({ rule, state, proposals: [], mode: 'state', relevant, active, mayCreate: i.mayCreate });
      outcome = classicOutcome(plan, !!active);
    } else {
      path = 'KNOWLEDGE';
      failedStep = 'KNOWLEDGE';
      const cfg = i.deps?.config ?? await t4AssessmentConfig();
      configRef = cfg.ref;
      evidence = await gatherFieldEvidence(accountId, fileId, key);
      // Écart 5 : une lecture impossible n'est jamais une donnée absente.
      if (evidence.errors.length) throw new KnowledgeReadError(`lecture de la connaissance impossible : ${evidence.errors.join(' ; ')}`.slice(0, 300));
      const lies = await gatherRelatedDocumentValues(accountId, fileId, key);
      // Lot 76 (C4) : preuves des documents du MÊME contrat (clauses, résiliation, obligations) intégrées.
      evidence = withRelatedEvidence(evidence, lies, i.deps?.today);
      liesIntegres = true;
      knowledgeRev = await currentKnowledgeRev(accountId, fileId);
      const connus = proposalsFromAnalysis(key, slot, {
        facts: [...evidence.facts, ...lies.facts].map((f) => ({ canonicalKey: key, value: f.value, confidence: f.confidence, excerpt: f.excerpt ?? null })),
        assetCandidates: [], documentAssetId: null,
      });
      if (lies.facts.length) {
        evidence.sources.RELATED_DOCUMENTS = lies.facts.length;
        evidence.facts.push(...lies.facts);
      }
      proposals = mergeProposals(i.obsProposals ?? [], connus);
      failedStep = 'PLAN';
      plan = planDocumentRule({ rule, state: planState, proposals, mode: 'analysis', relevant, active, mayCreate: i.mayCreate });
      outcome = plan.kind === 'WRITE' ? 'AUTO_RESOLVED' : classicOutcome(plan, !!active);
      if (plan.kind === 'WRITE') {
        extra = { valueKind: 'EXPLICIT', derivation: lies.facts.some((f) => String(f.value) === String(plan.kind === 'WRITE' ? plan.value : '') && f.confidence === 'certain')
          ? { method: 'RELATED_DOCUMENT', documents: lies.related.map((r) => r.fileId) } : null };
      }

      // ── Étape A (suite) : calcul déterministe ─────────────────────────────
      if (plan.kind !== 'WRITE' && plan.kind !== 'RESOLVE' && derivationFor(key)) {
        failedStep = 'DERIVATION';
        // Lot 76 (I) : échéancier du document ET des documents du MÊME contrat (tableau d'amortissement…).
        derivation = (await gatherDerivation(accountId, fileId, key, { relatedFiles: lies.relatedFiles ?? [] }))?.result ?? null;
        if (derivation?.schedule) {
          // Lot 76 (I) : la date de fin conditionne-t-elle une démarche ? (tracé avec le calcul)
          derivation = { ...derivation, endDateNeed: endDateNeed({ repaymentSchedule: derivation.schedule.evidenced, textes: (evidence.lifecycleTexts ?? []).map((t) => t.text) }) };
        }
        if (derivation?.status === 'CALCULATED_RELIABLE' && derivation.value) {
          outcome = 'AUTO_RESOLVED';
          if (calculee && String(state.value) === derivation.value) {
            plan = active ? { kind: 'RESOLVE', reason: 'CALCULATED_UNCHANGED' } : { kind: 'NONE', reason: 'CALCULATED_UNCHANGED' };
          } else {
            plan = { kind: 'WRITE', value: derivation.value, confidence: 1, evidenceIds: [],
              reason: derivation.method === 'START_PLUS_DURATION' ? 'CALCULATED_FROM_START_AND_DURATION' : 'CALCULATED_FROM_SCHEDULE' };
            extra = { valueKind: 'CALCULATED', derivation };
          }
        } else if (calculee) {
          // Sources du calcul disparues ou devenues incertaines : la valeur
          // théorique est retirée (jamais conservée comme une certitude).
          await withdrawCalculatedValue(db, accountId, fileId, key);
          reasonOverride = 'CALCULATED_VALUE_WITHDRAWN';
        }
      } else if (calculee && plan.kind !== 'WRITE') {
        await withdrawCalculatedValue(db, accountId, fileId, key);
        reasonOverride = 'CALCULATED_VALUE_WITHDRAWN';
      }

      // ── Étapes B / C : pertinence d'une question sur une échéance ──────────
      const question = plan.kind === 'UPSERT' || (plan.kind === 'NONE' && plan.reason !== 'CALCULATED_UNCHANGED' && (!!active || !!i.activeIntervention));
      if (outcome !== 'AUTO_RESOLVED' && isDeadlineRule(rule) && question) {
        failedStep = 'PERTINENCE';
        const cands = pertinenceCandidates(proposals, evidence);
        if (derivation?.status === 'CALCULATED_PROBABLE' && derivation.value && !cands.some((c) => c.iso === derivation!.value)) {
          cands.push({ iso: derivation.value, source: 'CALCULATED_PROBABLE', excerpt: null });
        }
        pertinence = await assessDeadlinePertinence({
          accountId, fileId, rule, documentType: i.ctx.documentTypeCode, candidates: cands,
          today: i.deps?.today ?? todayParis(), decide: i.deps?.decide, documentTitle: evidence.documentTitle ?? null,
          contextDates: evidence.contextDates, evidenceFingerprint: evidence.fingerprint ?? null, config: cfg,
          contradictory: new Set(proposals.filter((x) => x.confidence >= AI_CONFIDENCE_THRESHOLD).map((x) => String(x.value))).size >= 2,
          remembered: await rememberedPertinence(accountId, fileId, rule.code),
          // Lot 72 (C2) : cycle de vie lu (reconduction, fin effective, obligation résiduelle) — jamais l'âge seul.
          lifecycle: evidence.lifecycle ?? null,
          // Lot 76 (I) : date de fin nécessaire à une démarche ? (remboursement par échéances sans démarche de fin : non)
          endDateNeed: derivation?.endDateNeed ?? null,
        });
        // Lot 72 (C3) : une décision prise SANS l'IA ne dépend pas du texte ni du modèle T4.
        if (!pertinence.aiCalled && !pertinence.cached) configRef = deterministicConfigRef(cfg);
        const motive = { pertinence: pertinence.pertinence, pertinenceReason: pertinence.reason, aiTraceId: pertinence.aiTraceId, trigger: i.trigger, situation: pertinence.situation };
        probleme = { problem: pertinence.contract?.problem ?? null, situation: pertinence.situation, proof: preuveDe(pertinence) };
        // Justification STABLE (jamais la date du jour ni un texte libre) :
        // elle entre dans l'empreinte « Non applicable » (§7.4) sans la faire varier.
        // Lot 76 (C6) : + clé de preuve (clauses citées) — base de comparaison d'un « Non applicable ».
        extra = { triggerContext: { justification: pertinence.contract ? {
          version: pertinence.contract.version, problem: pertinence.contract.problem, situation: pertinence.situation,
          decision: pertinence.outcome, reliability: pertinence.contract.reliability.level,
          // Clé absente sans preuve : l'empreinte « Non applicable » (§7.4) des cartes existantes est inchangée.
          ...(probleme.proof ? { proof: probleme.proof } : {}),
        } : null } };
        outcome = pertinence.outcome ?? outcome;
        const fermerIntervention = async (reason: string) => {
          if (i.activeIntervention) ivClosed.push(...await closeDocumentIntervention(accountId, fileId, key, { ...motive, reason }));
        };
        switch (pertinence.outcome) {
          case 'NO_ACTION':
            plan = active ? { kind: 'RESOLVE', reason: 'NO_ACTION_NEEDED' } : { kind: 'NONE', reason: 'NO_ACTION_NEEDED' };
            await fermerIntervention('NO_ACTION_NEEDED');
            break;
          case 'DEFER':
            if (pertinence.technicalFailure) {
              // Écart 5 : panne → aucune fermeture, reprise planifiée.
              plan = { kind: 'NONE', reason: active ? 'KEPT_ON_TECHNICAL_FAILURE' : 'DEFERRED_TECHNICAL_FAILURE' };
              if (active) outcome = 'KEEP';
            } else if (pertinence.incompatible) {
              // Lot 75I (D) : contrat T4 incompatible — état prudent : ni carte créée, ni carte fermée, ni question par défaut.
              plan = { kind: 'NONE', reason: active ? 'KEPT_T4_INCOMPATIBLE' : 'DEFERRED_T4_INCOMPATIBLE' };
              if (active) outcome = 'KEEP';
            } else {
              plan = active ? { kind: 'RESOLVE', reason: 'DEFERRED' } : { kind: 'NONE', reason: 'DEFERRED' };
              await fermerIntervention('DEFERRED');
            }
            break;
          case 'CREATE_ACTION':
            if (pertinence.card === 'INTERVENTION' && pertinence.intervention) {
              // Écart 2 : l'action RÉELLE, jamais une question de date.
              const peut = i.ctx.open && (i.mayCreate || !!i.activeIntervention || !!active);
              const r = peut
                ? await upsertDocumentIntervention({ accountId, fileId, rule, intervention: pertinence.intervention, signature: pertinence.signature, proof: probleme.proof })
                : { status: 'SKIPPED' as const, actionId: null };
              if (r.actionId && (r.status === 'CREATED' || r.status === 'UPDATED')) {
                interventionIds.push(r.actionId);
                if (r.status === 'CREATED') report.created += 1; else { report.updated += 1; ivKept.push(r.actionId); }
              }
              if (r.status === 'USER_DECIDED') {
                outcome = 'NO_ACTION';
                plan = active ? { kind: 'RESOLVE', reason: 'USER_DECISION_RESPECTED' } : { kind: 'NONE', reason: 'USER_DECISION_RESPECTED' };
              } else {
                plan = active ? { kind: 'RESOLVE', reason: 'REPLACED_BY_INTERVENTION' } : { kind: 'NONE', reason: r.status === 'SKIPPED' ? 'NOT_ELIGIBLE' : 'REPLACED_BY_INTERVENTION' };
              }
            } else {
              await fermerIntervention('DATA_QUESTION');
            }
            break;
          default:
            break;
        }
        Object.assign(extra, { motive });
      }
      // Réévaluation sans élément nouveau : la même question reste en l'état.
      if (i.trigger !== 'ANALYSIS' && plan.kind === 'UPSERT' && plan.actionKind === 'COMPLETE' && active?.actionKind === 'COMPLETE') {
        plan = { kind: 'NONE', reason: 'STILL_OPEN' };
        if (outcome === 'CREATE_ACTION') outcome = 'KEEP';
      }
      if (configRef === cfg.ref && !pertinence && outcome !== 'CREATE_ACTION') configRef = deterministicConfigRef(cfg);
    }
    // Lot 72 (C5) : « Non applicable » respecté tant qu'aucun NOUVEAU problème n'est démontré.
    if (!active && plan.kind === 'UPSERT' && !newProblemSinceNotApplicable(plan, i.userNotApplicable ?? null, probleme)) {
      plan = { kind: 'NONE', reason: 'USER_NOT_APPLICABLE_UNCHANGED' };
      outcome = 'NO_ACTION';
    }
    failedStep = plan.kind === 'WRITE' ? 'WRITE' : 'EXECUTE';
    const motive = (extra as { motive?: Record<string, unknown> }).motive ?? {};
    exec = await executePlan(accountId, fileId, rule, slot, plan, state, report, i.closeReason, motive, extra);
    const verified: boolean | null = plan.kind === 'WRITE' ? exec.write?.confirmed === true : null;
    // Lot 72 (C3) : la décision est tracée avec la révision APRÈS sa propre écriture (sinon
    // la valeur écrite rendrait la décision « périmée » au balayage suivant).
    if (verified && knowledgeRev !== null) knowledgeRev = await currentKnowledgeRev(accountId, fileId);
    if (plan.kind === 'WRITE' && exec.write?.status === 'REFUSED_PROTECTED_VALUE') {
      outcome = 'KEEP';
      // Lot 75I (B) : refus NORMAL (valeur de l'utilisateur protégée) — compté, jamais une erreur.
      report.protectedRefusals += 1;
    }
    const refusEcriture = plan.kind === 'WRITE' && exec.write?.status === 'NOT_CONFIRMED';
    if (refusEcriture) {
      outcome = 'ERROR';
      // Lot 75I (B) : une écriture NON CONFIRMÉE est une erreur de persistance — remontée au bilan ; la carte reste.
      report.errors[rule.code] = 'écriture non confirmée';
      pushError(report, { accountId, fileId, ruleCode: rule.code, step: 'VERIFY', kind: 'PERSISTENCE_FAILED', cause: `écriture non confirmée (${String(plan.kind === 'WRITE' ? plan.value : '')})` });
    }

    // ── Lot 75I (A) : OBLIGATION d'une échéance CONNUE, découplée de la complétion ──
    // Une date connue (lue, saisie, écrite et relue, calculée) ferme la seule
    // question de complétion ; l'existence d'une obligation (restituer,
    // résilier…) est examinée indépendamment, jamais par une question de date.
    const connue = knownDeadline({ rule, plan, verified, state, present, userCleared, relevant, pertinenceEvaluated: pertinence !== null, extra, reasonOverride,
      arbitrationOpen: active?.actionKind === 'ARBITRATE' && !(exec.closed.includes(active.id)) });
    if (connue && i.ctx.open) {
      failedStep = 'OBLIGATION';
      const cfg = i.deps?.config ?? await t4AssessmentConfig();
      if (!evidence) evidence = await gatherFieldEvidence(accountId, fileId, key);
      if (evidence.errors.length) throw new KnowledgeReadError(`lecture de la connaissance impossible : ${evidence.errors.join(' ; ')}`.slice(0, 300));
      // Lot 76 (C4) : l'obligation tient compte des preuves des documents du même contrat.
      if (!liesIntegres) { evidence = withRelatedEvidence(evidence, await gatherRelatedDocumentValues(accountId, fileId, key), i.deps?.today); liesIntegres = true; }
      knowledgeRev = await currentKnowledgeRev(accountId, fileId);
      obligation = await assessKnownDeadlineObligation({
        accountId, fileId, rule, documentType: i.ctx.documentTypeCode, known: connue, clauses: evidence.lifecycle?.clauses ?? [],
        dateExcerpt: evidence.facts.find((f) => String(f.value) === connue.iso)?.excerpt ?? null,
        today: i.deps?.today ?? todayParis(), decide: i.deps?.decide, documentTitle: evidence.documentTitle ?? null, contextDates: evidence.contextDates,
        evidenceFingerprint: evidence.fingerprint ?? null, config: cfg, remembered: await rememberedPertinence(accountId, fileId, rule.code),
        lifecycle: evidence.lifecycle ?? null,
      });
      pertinence = obligation;
      configRef = obligation.aiCalled || obligation.cached ? cfg.ref : deterministicConfigRef(cfg);
      const motif = { pertinence: obligation.pertinence, pertinenceReason: obligation.reason, aiTraceId: obligation.aiTraceId, trigger: i.trigger, situation: obligation.situation };
      if (obligation.outcome === 'CREATE_ACTION' && obligation.card === 'INTERVENTION' && obligation.intervention) {
        const r = await upsertDocumentIntervention({ accountId, fileId, rule, intervention: obligation.intervention, signature: obligation.signature, proof: preuveDe(obligation) });
        if (r.actionId && (r.status === 'CREATED' || r.status === 'UPDATED')) {
          interventionIds.push(r.actionId);
          if (r.status === 'CREATED') report.created += 1; else { report.updated += 1; ivKept.push(r.actionId); }
          outcome = 'CREATE_ACTION';
        } else if (r.status === 'USER_DECIDED') {
          // Décision antérieure de l'utilisateur (« C'est fait », « Pas nécessaire ») : respectée.
          reasonOverride = 'USER_DECISION_RESPECTED';
          if (outcome !== 'AUTO_RESOLVED') outcome = 'NO_ACTION';
        }
      } else if (obligation.outcome === 'NO_ACTION') {
        // Absence d'obligation DÉMONTRÉE (T4, fin effective lue) : la carte d'intervention n'a plus d'objet.
        if (i.activeIntervention) ivClosed.push(...await closeDocumentIntervention(accountId, fileId, key, { ...motif, reason: 'NO_ACTION_NEEDED' }));
      } else if (obligation.outcome === 'DEFER') {
        // Report, incertitude, panne, contrat incompatible : rien n'est fermé ni créé ; réévaluation
        // programmée (`reevaluate_at`). L'issue de la COMPLÉTION reste celle tracée (découplage).
        if (i.activeIntervention) ivKept.push(i.activeIntervention.id);
      }
      if (obligation.technicalFailure) {
        pushError(report, { accountId, fileId, ruleCode: rule.code, step: 'OBLIGATION', kind: 'AI_OR_MEMORY_FAILED', cause: obligation.reason });
      }
    } else if (pertinence?.technicalFailure) {
      // Lot 75I (B) : panne T4 sur une question de donnée — décision différée ET erreur visible.
      pushError(report, { accountId, fileId, ruleCode: rule.code, step: 'PERTINENCE', kind: 'AI_OR_MEMORY_FAILED', cause: pertinence.reason });
    }
    report.outcomes[rule.code] = outcome;
    const decisionBase: RuleDecision = refusEcriture ? 'ERROR' : plan.kind === 'WRITE' && !verified ? 'NONE' : diagDecision(plan, report, avant, !!active);
    const result: FieldRuleOutcome = {
      plan, path, evidence, proposals, pertinence, writeAttempted: plan.kind === 'WRITE', verified,
      actionId: exec.actionId ?? interventionIds[0] ?? null,
      decision: obligation && interventionIds.length && decisionBase !== 'WRITE' && decisionBase !== 'ERROR'
        ? (ivKept.includes(interventionIds[0]) ? 'UPDATE' : 'CREATE') : decisionBase,
      outcome, derivation, interventionIds,
    };
    await tracer(report, {
      accountId, fileId, ruleCode: rule.code, fieldKey: key, trigger: i.trigger, runRef: i.runRef ?? null,
      targetPresent: present, userValidated: state.userValidated, sources: evidence?.sources ?? {}, missingSources: evidence?.missing ?? [],
      observations: evidence?.observations ?? [], proposals: proposals.map((p) => ({ value: p.value, confidence: p.confidence })),
      titleHint: evidence?.titleHint ?? null, pertinence, decision: result.decision,
      reasonCode: refusEcriture ? 'PERSISTENCE_FAILED' : plan.kind === 'WRITE' && !verified ? 'WRITE_REFUSED_PROTECTED_VALUE'
        : reasonOverride && (plan.kind === 'NONE' || reasonOverride === 'USER_DECISION_RESPECTED') ? reasonOverride : plan.reason,
      actionId: result.actionId, writeVerified: verified, failedStep: refusEcriture ? 'VERIFY' : null,
      outcome, reevaluateAt: pertinence?.reevaluateAt ?? null, evidenceFingerprint: evidence?.fingerprint ?? null, knowledgeRev, configRef,
      derivation, writeResult: exec.write, errorKind: refusEcriture ? 'PERSISTENCE_FAILED' : pertinence?.technicalFailure ? 'AI_OR_MEMORY_FAILED' : null,
      actionIds: { created: [...exec.created, ...interventionIds.filter((x) => !ivKept.includes(x))], kept: [...exec.kept, ...ivKept, ...(plan.kind === 'NONE' && active ? [active.id] : [])],
        closed: [...exec.closed, ...ivClosed], intervention: interventionIds },
    });
    return result;
  } catch (e) {
    const cause = (e as Error).message;
    report.errors[rule.code] = cause;
    report.outcomes[rule.code] = 'ERROR';
    pushError(report, { accountId, fileId, ruleCode: rule.code, step: failedStep, kind: errorKindOf(e, failedStep), cause });
    await tracer(report, {
      accountId, fileId, ruleCode: rule.code, fieldKey: key, trigger: i.trigger, runRef: i.runRef ?? null,
      targetPresent: present, userValidated: state.userValidated, sources: evidence?.sources ?? {}, missingSources: evidence?.missing ?? [],
      observations: evidence?.observations ?? [], titleHint: evidence?.titleHint ?? null, pertinence,
      decision: 'ERROR', reasonCode: 'RULE_EVALUATION_FAILED', error: cause, failedStep,
      outcome: 'ERROR', errorKind: errorKindOf(e, failedStep), knowledgeRev, configRef, derivation, writeResult: exec?.write ?? null,
      actionIds: active || exec || i.activeIntervention
        ? { created: exec?.created ?? [], closed: [...(exec?.closed ?? []), ...ivClosed],
          kept: [...(active && !exec?.closed.includes(active.id) ? [active.id] : []), ...(i.activeIntervention ? [i.activeIntervention.id] : [])] }
        : null,
    });
    throw e;
  }
}

/**
 * Lot 75I (A) — date d'ÉCHÉANCE connue après l'exécution du plan de
 * complétion (pure) : valeur présente (lue, saisie), écrite ET relue, ou
 * calculée inchangée / écrite. Null : donnée inconnue, retirée par
 * l'utilisateur, hors pertinence, non datée, ou déjà évaluée par la
 * pertinence d'une question (date incertaine). Provenance STABLE d'un passage
 * à l'autre (USER_VALUE, CALCULATED, KNOWN_VALUE) : la mémoire de décision
 * n'est pas invalidée par la seule écriture.
 */
export function knownDeadline(p: {
  rule: ProcessingRule; plan: RulePlan; verified: boolean | null; state: Pick<DocumentSlotState, 'value' | 'userValidated'>; present: boolean;
  userCleared: boolean; relevant: boolean; pertinenceEvaluated: boolean; extra?: WriteExtra; reasonOverride?: string | null;
  /** Arbitrage ouvert sur la date : valeur contestée, l'obligation attend la réponse. */
  arbitrationOpen?: boolean;
}): { iso: string; source: string } | null {
  if (!isDeadlineRule(p.rule) || p.userCleared || p.pertinenceEvaluated || p.arbitrationOpen) return null;
  // Valeur contestée (arbitrage proposé) ou question de complétion : la date n'est pas « connue ».
  if (p.plan.kind === 'UPSERT') return null;
  if (!p.relevant && !(p.present && p.state.userValidated)) return null;
  if (p.reasonOverride === 'CALCULATED_VALUE_WITHDRAWN') return null;
  let brut: unknown = null;
  let source = 'KNOWN_VALUE';
  if (p.plan.kind === 'WRITE') {
    if (p.verified !== true) return null;
    brut = p.plan.value;
    source = p.extra?.valueKind === 'CALCULATED' ? 'CALCULATED' : 'KNOWN_VALUE';
  } else if (p.present) {
    brut = p.state.value;
    source = p.state.userValidated ? 'USER_VALUE' : p.plan.reason === 'CALCULATED_UNCHANGED' ? 'CALCULATED' : 'KNOWN_VALUE';
  } else return null;
  const iso = parseDocumentDate(typeof brut === 'string' ? brut : brut === null || brut === undefined ? null : String(brut)).iso;
  return iso ? { iso, source } : null;
}

/** Erreur d'évaluation d'une RELATION ou hors champ : tracée en base (0418), pas seulement en console. */
async function recordRuleError(accountId: number, fileId: number, rule: ProcessingRule, trigger: RuleTrigger, e: unknown, report: DocumentRulesReport, runRef?: string | null): Promise<void> {
  report.errors[rule.code] = (e as Error).message;
  report.outcomes[rule.code] = 'ERROR';
  pushError(report, { accountId, fileId, ruleCode: rule.code, step: 'PLAN', kind: 'EVALUATION_FAILED', cause: String((e as Error).message) });
  await tracer(report, {
    accountId, fileId, ruleCode: rule.code, fieldKey: rule.fieldKey ?? rule.relationKey ?? null, trigger, runRef: runRef ?? null,
    targetPresent: null, userValidated: null,
    decision: 'ERROR', reasonCode: 'RULE_EVALUATION_FAILED', error: (e as Error).message, failedStep: 'PLAN', outcome: 'ERROR', errorKind: 'EVALUATION_FAILED',
  });
}

/**
 * Lot 61 (écart 6) : trace d'une décision du CHEMIN ANTÉRIEUR (relations,
 * réévaluation d'état, fermeture d'une donnée renseignée ailleurs) — toute
 * création, maintien, modification et fermeture est tracée, comme une
 * décision sur un champ. Lot 72 (C7) : une évaluation SANS carte (`NONE`)
 * est tracée elle aussi — donnée déjà connue, hors pertinence, document non
 * éligible, confiée à T3, décision utilisateur respectée — pour que le
 * diagnostic explique chaque non-création (déduplication par signature :
 * une ligne tant que rien ne change).
 */
async function traceClassic(p: {
  accountId: number; fileId: number; rule: ProcessingRule; trigger: RuleTrigger; runRef?: string | null; plan: RulePlan; exec: ExecOutcome;
  active: ActiveCard | null; state: DocumentSlotState; report: DocumentRulesReport; before: DocumentRulesReport;
}): Promise<void> {
  const verified = p.plan.kind === 'WRITE' ? p.exec.write?.confirmed === true : null;
  const outcome: RuleOutcome = p.plan.kind === 'WRITE' && p.exec.write?.status === 'NOT_CONFIRMED' ? 'ERROR' : classicOutcome(p.plan, !!p.active);
  p.report.outcomes[p.rule.code] = outcome;
  // Lot 75I (B) : écriture non confirmée = erreur de persistance remontée ; valeur protégée = refus normal.
  if (outcome === 'ERROR') {
    p.report.errors[p.rule.code] = 'écriture non confirmée';
    pushError(p.report, { accountId: p.accountId, fileId: p.fileId, ruleCode: p.rule.code, step: 'VERIFY', kind: 'PERSISTENCE_FAILED', cause: 'écriture non confirmée' });
  } else if (p.plan.kind === 'WRITE' && p.exec.write?.status === 'REFUSED_PROTECTED_VALUE') p.report.protectedRefusals += 1;
  await tracer(p.report, {
    accountId: p.accountId, fileId: p.fileId, ruleCode: p.rule.code, fieldKey: ruleDataKey(p.rule), trigger: p.trigger, runRef: p.runRef ?? null,
    targetPresent: !isEmpty(p.state.value) || p.state.values.length > 0, userValidated: p.state.userValidated,
    decision: outcome === 'ERROR' ? 'ERROR' : diagDecision(p.plan, p.report, p.before, !!p.active), reasonCode: outcome === 'ERROR' ? 'PERSISTENCE_FAILED' : p.plan.reason,
    actionId: p.exec.actionId ?? p.active?.id ?? null, writeVerified: verified, outcome, writeResult: p.exec.write,
    actionIds: { created: p.exec.created, kept: [...p.exec.kept, ...(p.plan.kind === 'NONE' && p.active ? [p.active.id] : [])], closed: p.exec.closed },
    errorKind: outcome === 'ERROR' ? 'PERSISTENCE_FAILED' : null,
  });
}

/**
 * Après l'analyse d'un document (pipeline T1, une fois le classement V2 et
 * les liens N-N écrits). Ne lève jamais.
 */
export async function syncDocumentRulesFromAnalysis(input: {
  accountId: number;
  fileId: number;
  observations: AnalysisObservations;
  /** Lot 58B : référence d'exécution (diagnostic). */
  runRef?: string | null;
  deps?: FieldRuleDeps;
}): Promise<DocumentRulesReport> {
  const report = emptyReport();
  try {
    const ctx = await loadContext(input.accountId, input.fileId);
    if (!ctx.exists) return report;
    const names = await assetNamesOf(input.accountId, [
      ...input.observations.assetCandidates.map((c) => c.entityId).filter((x): x is number => x !== null),
      ...(input.observations.documentAssetId !== null ? [input.observations.documentAssetId] : []),
    ]);
    // Un candidat que le compte ne possède plus n'est pas proposable.
    const obs: AnalysisObservations = {
      ...input.observations,
      assetCandidates: input.observations.assetCandidates.filter((c) => c.entityId !== null && names.has(c.entityId)),
      documentAssetId: input.observations.documentAssetId !== null && names.has(input.observations.documentAssetId)
        ? input.observations.documentAssetId : null,
    };

    const actives = await activeActions(input.accountId, input.fileId);
    for (const rule of documentBridgeRules()) {
      const key = ruleDataKey(rule);
      try {
        const slot = documentSlotFor(key);
        const state = await slot.read(db, input.accountId, input.fileId);
        const proposals = proposalsFromAnalysis(key, slot, obs, names);
        if (slot.kind === 'field') {
          // Lot 58B / 61 : connaissance persistée, calcul, pertinence, diagnostic.
          await evaluateFieldRule({
            accountId: input.accountId, fileId: input.fileId, rule, slot, ctx, state, active: actives.get(key) ?? null,
            activeIntervention: actives.get(interventionKey(key)) ?? null,
            relevant: isRuleRelevantForDocument(rule, ctx.documentTypeCode), trigger: 'ANALYSIS', mayCreate: ctx.open,
            closeReason: 'OBSOLETE', obsProposals: proposals, runRef: input.runRef ?? null, deps: input.deps, report,
            // Lot 72 (C5) : une réanalyse ne rouvre pas une carte « Non applicable » sans nouveau problème.
            userNotApplicable: actives.has(key) ? null : await userNotApplicableDecision(input.accountId, input.fileId, key),
          });
          continue;
        }
        const plan = planDocumentRule({
          rule, state, proposals, mode: 'analysis',
          relevant: isRuleRelevantForDocument(rule, ctx.documentTypeCode),
          // Juste analysé : l'état d'analyse n'est pas encore final, seule
          // compte l'ouverture du document (ni brouillon, ni écarté).
          mayCreate: ctx.open,
          deferredToT3: key === 'assetIds' && obs.deferAssetLinkToT3 === true,
        });
        const before = { ...report };
        const exec = await executePlan(input.accountId, input.fileId, rule, slot, plan, state, report, 'OBSOLETE');
        await traceClassic({ accountId: input.accountId, fileId: input.fileId, rule, trigger: 'ANALYSIS', runRef: input.runRef, plan, exec, active: actives.get(key) ?? null, state, report, before });
      } catch (e) {
        console.error(`[to-process] règle ${rule.code} du document ${input.fileId} non évaluée :`, (e as Error).message);
        if (!(rule.code in report.errors)) await recordRuleError(input.accountId, input.fileId, rule, 'ANALYSIS', e, report, input.runRef);
      }
    }
  } catch (e) {
    console.error(`[to-process] pont documentaire du document ${input.fileId} impossible :`, (e as Error).message);
    pushError(report, { accountId: input.accountId, fileId: input.fileId, ruleCode: '*', step: 'CONTEXT', kind: 'READ_FAILED', cause: String((e as Error).message) });
  }
  return report;
}

/**
 * Réévaluation SANS analyse : après une correction faite ailleurs (tiroir,
 * fiche, validation des propositions), par le balayage horaire ou par la
 * réévaluation rétroactive (lot 61).
 *
 * `reason` : motif de fermeture (USER_COMPLETED après une correction,
 * OBSOLETE au balayage). Ne lève jamais.
 */
export async function syncDocumentRulesFromState(
  accountId: number,
  fileId: number,
  opts: { reason?: ResolutionReason; create?: boolean; trigger?: RuleTrigger; runRef?: string | null; deps?: FieldRuleDeps } = {},
): Promise<DocumentRulesReport> {
  const report = emptyReport();
  const reason = opts.reason ?? 'OBSOLETE';
  const trigger: RuleTrigger = opts.trigger ?? (reason === 'USER_COMPLETED' ? 'USER' : 'SWEEP');
  try {
    const ctx = await loadContext(accountId, fileId);
    if (!ctx.exists) {
      // Document supprimé (ou source secondaire regroupée) : plus rien à traiter.
      const now = new Date();
      // Lot 75I (E) : fermeture et événement d'audit dans UNE transaction (plus de trace perdue en console).
      const closed = await db.transaction(async (tx) => {
        const fermees = await tx
          .update(toProcessActions)
          .set({ resolvedAt: now, resolutionReason: 'TARGET_DELETED', updatedAt: now })
          .where(and(
            eq(toProcessActions.accountId, accountId), eq(toProcessActions.targetType, 'DOCUMENT'),
            eq(toProcessActions.targetId, fileId), isNull(toProcessActions.resolvedAt),
          ))
          .returning({ id: toProcessActions.id, ruleCode: toProcessActions.ruleCode, key: sql<string>`COALESCE(${toProcessActions.fieldKey}, ${toProcessActions.relationKey})` });
        if (fermees.length) {
          await tx.insert(toProcessActionEvents).values(fermees.map((a) => ({
            actionId: a.id, accountId, event: 'TARGET_DELETED', actorUserId: null, targetType: 'DOCUMENT', targetId: fileId,
            fieldKey: a.key, details: { ruleCode: a.ruleCode, reason: 'TARGET_DELETED', trigger }, createdAt: now,
          })));
        }
        return fermees;
      });
      report.closed += closed.length;
      // Lot 61 (écart 6) : fermeture tracée (événement et diagnostic par règle).
      if (closed.length) {
        for (const code of [...new Set(closed.map((a) => a.ruleCode))]) {
          await tracer(report, {
            accountId, fileId, ruleCode: code, fieldKey: closed.find((a) => a.ruleCode === code)?.key ?? null, trigger, runRef: opts.runRef ?? null,
            targetPresent: null, userValidated: null, decision: 'CLOSE', reasonCode: 'TARGET_DELETED', outcome: 'NO_ACTION',
            actionIds: { closed: closed.filter((a) => a.ruleCode === code).map((a) => a.id) },
          });
        }
      }
      return report;
    }
    const actives = await activeActions(accountId, fileId);

    for (const rule of documentBridgeRules()) {
      const key = ruleDataKey(rule);
      try {
        const slot = documentSlotFor(key);
        const state = await slot.read(db, accountId, fileId);
        const active = actives.get(key) ?? null;
        const activeIntervention = actives.get(interventionKey(key)) ?? null;
        const relevant = isRuleRelevantForDocument(rule, ctx.documentTypeCode);
        const wantsCreation = !active && opts.create !== false && ctx.eligible && relevant && rule.completePriority !== null;
        // Lot 72 (C5) : « Non applicable » — décision MÉMORISÉE avec son contexte ;
        // réévaluée seulement si la connaissance a réellement changé depuis
        // (jamais d'appel IA ni de carte sur la même situation).
        // Lot 75I (A) : une date CONNUE n'est plus une question — le « Non applicable » de la complétion ne masque pas l'obligation.
        const na = wantsCreation && slot.kind === 'field' && isEmpty(state.value) ? await userNotApplicableDecision(accountId, fileId, key) : null;
        let naInchange = false;
        if (na) {
          const rev = await currentKnowledgeRev(accountId, fileId);
          if (na.knowledgeRev === null) {
            await recordNotApplicableBaseline(accountId, fileId, key, na, rev);
            naInchange = true;
          } else naInchange = na.knowledgeRev === rev;
          if (naInchange) {
            report.plans[rule.code] = 'NONE';
            report.reasons[rule.code] = 'USER_NOT_APPLICABLE_UNCHANGED';
            report.outcomes[rule.code] = 'NO_ACTION';
            await tracer(report, {
              accountId, fileId, ruleCode: rule.code, fieldKey: key, trigger, runRef: opts.runRef ?? null, targetPresent: !isEmpty(state.value),
              userValidated: state.userValidated, decision: 'NONE', reasonCode: 'USER_NOT_APPLICABLE_UNCHANGED', outcome: 'NO_ACTION',
              knowledgeRev: rev, actionIds: { closed: [na.actionId] }, decisionKind: 'USER_REFUSED',
            });
            continue;
          }
        }
        // Relation déclarée « Non applicable » (aucune aujourd'hui) : comportement antérieur, jamais reproposée.
        const naRelation = wantsCreation && slot.kind !== 'field' && (await userNotApplicableDecision(accountId, fileId, key)) !== null;
        const mayCreate = wantsCreation && !naInchange && !naRelation
          // Lot 31B (ticket T3, §9) : rattachement d'un document analysé —
          // la question attend l'échec ou l'abstention de T3 DOCUMENT_ASSET.
          && (key !== 'assetIds' || (await assetLinkQuestionAllowed(accountId, fileId)));
        const proposals = mayCreate && slot.storedProposals ? await slot.storedProposals(accountId, fileId) : [];
        const plan = planDocumentRule({ rule, state, proposals, mode: 'state', relevant, active, mayCreate });
        // Lot 58B / 61 : avant de créer ou de maintenir une question sur un
        // champ — ou une intervention, ou une valeur calculée à reconsidérer —
        // la connaissance, le calcul et la pertinence sont consultés.
        const calculable = slot.kind === 'field' && !isEmpty(state.value) && !state.userValidated && !!derivationFor(key);
        // Lot 75I (A) : échéance CONNUE — la complétion se ferme ET l'obligation est examinée (même décision).
        const obligation = slot.kind === 'field' && isDeadlineRule(rule) && !isEmpty(state.value) && ctx.open && (relevant || state.userValidated);
        if (slot.kind === 'field' && (plan.kind !== 'RESOLVE' || obligation) && (active || mayCreate || activeIntervention || calculable || obligation)) {
          await evaluateFieldRule({
            accountId, fileId, rule, slot, ctx, state, active, activeIntervention, relevant, trigger,
            // Carte active : la mettre à jour reste possible (document ouvert).
            mayCreate: active ? ctx.open : mayCreate, closeReason: reason, runRef: opts.runRef ?? null, deps: opts.deps, report,
            userNotApplicable: na,
          });
          continue;
        }
        const before = { ...report };
        const exec = await executePlan(accountId, fileId, rule, slot, plan, state, report, reason);
        await traceClassic({ accountId, fileId, rule, trigger, runRef: opts.runRef, plan, exec, active, state, report, before });
      } catch (e) {
        console.error(`[to-process] règle ${rule.code} du document ${fileId} non réévaluée :`, (e as Error).message);
        if (!(rule.code in report.errors)) await recordRuleError(accountId, fileId, rule, trigger, e, report, opts.runRef);
      }
    }
  } catch (e) {
    console.error(`[to-process] réévaluation du document ${fileId} impossible :`, (e as Error).message);
    pushError(report, { accountId, fileId, ruleCode: '*', step: 'CONTEXT', kind: 'READ_FAILED', cause: String((e as Error).message) });
  }
  return report;
}

/**
 * Raccourci des écrans métier : une donnée documentaire vient d'être
 * corrigée par l'utilisateur. Ferme ce qui est résolu (USER_COMPLETED) et
 * fait réapparaître un problème réel (rattachement retiré…). Ne lève jamais.
 */
export function onDocumentEditedByUser(accountId: number, fileId: number): Promise<DocumentRulesReport> {
  return syncDocumentRulesFromState(accountId, fileId, { reason: 'USER_COMPLETED', create: true });
}

// ══════════════════════════════════════════════════════════════════════════
// BALAYAGE — documents d'un compte à réévaluer (rattrapage inclus)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Documents à réévaluer pour un compte :
 *   · ceux qui portent une action documentaire active (fermeture si résolue),
 *     cartes d'intervention comprises (lot 61) ;
 *   · ceux qui manquent d'une donnée REQUISE sans action ouverte —
 *     rattachement à un bien pour tout document, donnée de la règle pour les
 *     Types concernés. C'est aussi le rattrapage automatique des documents
 *     antérieurs au lot 28, borné à `limit` documents par passage ;
 *   · lot 61 : ceux dont une valeur CALCULÉE a vu sa connaissance changer.
 *
 * Lot 61 (écart 4) : un document dont la DERNIÈRE évaluation de la règle a
 * conclu NO_ACTION ou DEFER n'est pas repris tant que sa connaissance
 * (révision : faits, unités, valeurs, type — même sans changement de
 * `asset_files.updated_at`) et la configuration IA T4 n'ont pas changé, ni
 * la date de réévaluation n'est atteinte : ni carte recréée, ni IA rappelée.
 *
 * Lot 72 : révision = empreinte du CONTENU (C3) ; une décision prise sans
 * l'IA n'est pas invalidée par une révision T4 (C3) ; une valeur CALCULÉE
 * par une version antérieure du moteur est revue (C1) ; un « Non
 * applicable » est revu quand la connaissance a changé depuis le choix (C5).
 */
export async function documentsToReevaluate(accountId: number, limit = 200): Promise<number[]> {
  const rules = documentBridgeRules();
  const keys = rules.map(ruleDataKey);
  const ids = new Set<number>();

  const actifs = (await pgClient.unsafe(
    `SELECT DISTINCT target_id AS id FROM to_process_actions
      WHERE account_id = $1 AND target_type = 'DOCUMENT' AND resolved_at IS NULL
        AND COALESCE(field_key, relation_key) = ANY($2::text[])`,
    [accountId, [...keys, ...keys.map(interventionKey)]] as never[],
  )) as unknown as Array<{ id: number }>;
  for (const r of actifs) ids.add(Number(r.id));

  const memoire = await ruleEvaluationsReady();
  const l61 = memoire && await relevanceColumnsReady();
  const rev = l61 ? await knowledgeRevSql('f') : '';
  const cfgFull = l61 ? await t4AssessmentConfig() : null;
  const cfg = cfgFull?.ref ?? null;
  // Lot 72 (C3) : décision prise sans l'IA — seule compte la configuration déterministe.
  const cfgDet = cfgFull ? deterministicConfigRef(cfgFull) : null;
  let budget = limit;
  for (const rule of rules) {
    // Seules les règles qui justifient une complétion peuvent naître d'un état.
    if (rule.completePriority === null || budget <= 0) continue;
    const key = ruleDataKey(rule);
    const manque = key === 'assetIds'
      ? `f.asset_id IS NULL AND f.linked_asset_id IS NULL AND NOT EXISTS (
           SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.status = 'ACTIVE'
              AND l.asset_id IS NOT NULL AND l.link_role IN ('PRIMARY', 'SECONDARY'))
         AND ${ASSET_LINK_QUESTION_ALLOWED_SQL}`
      : key === 'supplier'
        ? `f.supplier IS NULL`
        : `NOT EXISTS (SELECT 1 FROM document_field_values v WHERE v.file_id = f.id AND v.field_key = $4 AND v.value_text IS NOT NULL)`;
    const types = rule.relevantDocumentTypes ? [...rule.relevantDocumentTypes] : null;
    const derniere = `e.id = (SELECT max(x.id) FROM document_rule_evaluations x
                               WHERE x.account_id = f.account_id AND x.file_id = f.id AND x.rule_code = $5)`;
    const memoireSql = !memoire || !rule.fieldKey ? ''
      : l61
        ? `AND NOT EXISTS (SELECT 1 FROM document_rule_evaluations e WHERE ${derniere}
             AND (e.outcome IN ('NO_ACTION', 'DEFER')
                  OR (e.outcome IS NULL AND e.reason_code = 'NO_ACTION_NEEDED' AND e.last_seen_at >= f.updated_at))
             -- Lot 76 (C2) : « contrat terminé » de l'ANCIENNE détection — jamais une mémoire valable.
             AND NOT (e.pertinence IS NOT DISTINCT FROM 'CONTRACT_TERMINATED' AND e.engine_version IS DISTINCT FROM '${DOCUMENT_RULE_ENGINE_VERSION}')
             AND (e.outcome IS NULL OR (e.knowledge_rev = ${rev} AND e.config_ref IN ($6, $7)))
             AND (e.reevaluate_at IS NULL OR e.reevaluate_at > now()))`
        : `AND NOT EXISTS (SELECT 1 FROM document_rule_evaluations e WHERE ${derniere}
             AND e.reason_code = 'NO_ACTION_NEEDED' AND e.last_seen_at >= f.updated_at)`;
    const params = !memoire || !rule.fieldKey ? [accountId, types, budget, key] : l61 ? [accountId, types, budget, key, rule.code, cfg, cfgDet] : [accountId, types, budget, key, rule.code];
    // Lot 72 (C5) : « Non applicable » exclu tant que la connaissance n'a pas changé depuis la décision
    // (révision mémorisée à la décision ; décision antérieure : reprise UNE fois pour poser sa base).
    const naInchange = l61 && rule.fieldKey
      ? `AND COALESCE((SELECT ev.details ->> 'knowledgeRev' FROM to_process_action_events ev
                        WHERE ev.action_id = a.id AND ev.details ? 'knowledgeRev' ORDER BY ev.id DESC LIMIT 1), '') = ${rev}`
      : '';
    const selection = (avecMemoire: boolean) => pgClient.unsafe(
      `SELECT f.id FROM asset_files f
        WHERE f.account_id = $1 AND ${ELIGIBLE_SQL}
          AND ($2::text[] IS NULL OR f.document_type_code = ANY($2::text[]))
          AND ${manque}
          ${avecMemoire ? memoireSql : ''}
          AND NOT EXISTS (
            SELECT 1 FROM to_process_actions a WHERE a.account_id = f.account_id AND a.target_type = 'DOCUMENT'
               AND a.target_id = f.id AND COALESCE(a.field_key, a.relation_key) = $4
               AND (a.resolved_at IS NULL OR (a.resolution_reason = 'NOT_APPLICABLE' AND NOT EXISTS (
                 SELECT 1 FROM to_process_actions b WHERE b.account_id = a.account_id AND b.target_type = 'DOCUMENT'
                    AND b.target_id = a.target_id AND COALESCE(b.field_key, b.relation_key) = $4
                    AND b.resolved_at > a.resolved_at) ${avecMemoire ? naInchange : ''})))
        ORDER BY f.id
        LIMIT $3`,
      (avecMemoire ? params : params.slice(0, 4)) as never[],
    );
    // Lot 61 (écart 5) : une mémoire illisible (révision de connaissance en
    // échec) ne bloque pas le balayage du compte — les documents sont repris
    // et l'erreur réelle est tracée PAR DOCUMENT et par règle.
    let rows: Array<{ id: number }>;
    try {
      rows = (await selection(true)) as unknown as Array<{ id: number }>;
    } catch (e) {
      if (!memoireSql) throw e;
      console.error(`[to-process] mémoire de décision illisible (règle ${rule.code}, compte ${accountId}) :`, (e as Error).message);
      rows = (await selection(false)) as unknown as Array<{ id: number }>;
    }
    for (const r of rows) {
      if (!ids.has(Number(r.id))) budget -= 1;
      ids.add(Number(r.id));
    }
    // Lot 61 : valeur CALCULÉE dont la connaissance a changé depuis la dernière évaluation.
    if (l61 && rule.fieldKey && derivationFor(key) && budget > 0) {
      const calc = (await pgClient.unsafe(
        `SELECT f.id FROM asset_files f
           JOIN document_field_values v ON v.file_id = f.id AND v.account_id = f.account_id AND v.field_key = $2
          WHERE f.account_id = $1 AND ${ELIGIBLE_SQL} AND v.user_validated = false AND to_jsonb(v) ->> 'value_kind' = 'CALCULATED'
            AND NOT EXISTS (SELECT 1 FROM document_rule_evaluations e
                             WHERE e.id = (SELECT max(x.id) FROM document_rule_evaluations x
                                            WHERE x.account_id = f.account_id AND x.file_id = f.id AND x.rule_code = $3)
                               AND e.knowledge_rev = ${rev} AND e.engine_version = $5)
          ORDER BY f.id LIMIT $4`,
        [accountId, key, rule.code, budget, DOCUMENT_RULE_ENGINE_VERSION] as never[],
      ).catch((e: Error) => {
        console.error(`[to-process] valeurs calculées à revoir illisibles (compte ${accountId}) :`, e.message);
        return [];
      })) as unknown as Array<{ id: number }>;
      for (const r of calc) {
        if (!ids.has(Number(r.id))) budget -= 1;
        ids.add(Number(r.id));
      }
    }
  }

  // Lot 75I (A) : échéances CONNUES dont l'OBLIGATION n'a pas été évaluée avec
  // la connaissance et la configuration actuelles (jamais évaluée, preuves ou
  // configuration changées, réévaluation programmée atteinte, échec). Budget
  // propre, borné : une connaissance inchangée n'est jamais reprise (ni carte,
  // ni appel T4) ; le stock existant est absorbé par passes successives.
  if (l61) {
    let reste = Math.min(budget, OBLIGATION_SWEEP_BUDGET);
    for (const rule of rules.filter((r) => isDeadlineRule(r))) {
      if (reste <= 0) break;
      const types = rule.relevantDocumentTypes ? [...rule.relevantDocumentTypes] : null;
      const rows = (await pgClient.unsafe(
        `SELECT f.id FROM asset_files f
          WHERE f.account_id = $1 AND ${ELIGIBLE_SQL}
            AND EXISTS (SELECT 1 FROM document_field_values v WHERE v.file_id = f.id AND v.account_id = f.account_id AND v.field_key = $3
                          AND v.value_text IS NOT NULL AND ($2::text[] IS NULL OR f.document_type_code = ANY($2::text[]) OR v.user_validated))
            AND NOT EXISTS (SELECT 1 FROM to_process_actions a WHERE a.account_id = f.account_id AND a.target_type = 'DOCUMENT' AND a.target_id = f.id
                              AND a.resolved_at IS NULL AND COALESCE(a.field_key, a.relation_key) IN ($3, $8))
            AND NOT EXISTS (SELECT 1 FROM document_rule_evaluations e
                             WHERE e.id = (SELECT max(x.id) FROM document_rule_evaluations x
                                            WHERE x.account_id = f.account_id AND x.file_id = f.id AND x.rule_code = $4)
                               -- CASE : la révision (coûteuse) n'est calculée que si la décision mémorisée est encore valable par ailleurs.
                               AND CASE WHEN e.situation = 'KNOWN_DEADLINE' AND e.outcome IS DISTINCT FROM 'ERROR' AND e.config_ref IN ($5, $6)
                                             AND (e.reevaluate_at IS NULL OR e.reevaluate_at > now())
                                        THEN e.knowledge_rev = ${rev} ELSE false END)
          ORDER BY f.id LIMIT $7`,
        [accountId, types, rule.fieldKey, rule.code, cfg, cfgDet, reste, interventionKey(rule.fieldKey!)] as never[],
      ).catch((e: Error) => {
        console.error(`[to-process] obligations à réévaluer illisibles (règle ${rule.code}, compte ${accountId}) :`, e.message);
        return [];
      })) as unknown as Array<{ id: number }>;
      for (const r of rows) {
        if (!ids.has(Number(r.id))) reste -= 1;
        ids.add(Number(r.id));
      }
    }
  }
  return [...ids];
}

/** Lot 75I (A) : documents à échéance connue réévalués au plus par compte et par passage (obligation). */
export const OBLIGATION_SWEEP_BUDGET = 25;

// ══════════════════════════════════════════════════════════════════════════
// SAISIE DEPUIS UN ÉCRAN MÉTIER — valeur utilisateur d'une donnée du pont
// ══════════════════════════════════════════════════════════════════════════

/** Clé d'une donnée documentaire du pont pour une clé d'écran (déplacée en 58B, réexportée). */
export { documentBridgeFieldKey, t1KeyDesignates, t1LabelDesignates } from './document-field-evidence';

/**
 * Enregistre la valeur SAISIE ou VALIDÉE par l'utilisateur pour une donnée
 * documentaire du pont (validation utilisateur posée : jamais écrasée
 * ensuite). Rend vrai si la donnée relève du pont et a été écrite. Ne lève
 * jamais.
 */
export async function recordUserDocumentValue(
  accountId: number,
  fileId: number,
  screenKey: string,
  value: unknown,
): Promise<boolean> {
  const key = documentBridgeFieldKey(screenKey);
  if (!key) return false;
  try {
    const slot = documentSlotFor(key);
    if (value !== null && value !== undefined && !slot.validate(value)) return false;
    if (slot.check && !(await slot.check(db, accountId, fileId, value))) return false;
    await slot.writeUser(db, accountId, fileId, value ?? null);
    return true;
  } catch (e) {
    console.error(`[to-process] valeur ${screenKey} du document ${fileId} non enregistrée :`, (e as Error).message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// LOT 57B (défaut E) — REPRISE CIBLÉE D'UN CHAMP DEPUIS LA CONNAISSANCE T1
// ══════════════════════════════════════════════════════════════════════════

/** Issue de la reprise d'une donnée documentaire depuis la connaissance T1 persistée. */
export interface KnowledgeFieldResolution {
  /**
   * WRITTEN : valeur fiable écrite (lue, consolidée ou calculée), carte
   * fermée · RESOLVED : carte close sans écriture (donnée déjà présente, plus
   * pertinente…) · NO_ACTION_NEEDED (58B / 61) : carte fermée car sans
   * objet — échéance historique, interpellation différée, remplacée par
   * l'action réelle, décision de l'utilisateur respectée (motif dans
   * `reasonCode`) · ARBITRATE : valeur(s) incertaine(s), carte maintenue
   * avec propositions · NO_EVIDENCE : aucune valeur dans T1 · USER_PROTECTED :
   * choix de l'utilisateur protégé · TARGET_GONE · NOT_A_FIELD (relation,
   * règle inconnue) · NO_T1_KNOWLEDGE.
   */
  status: 'WRITTEN' | 'RESOLVED' | 'NO_ACTION_NEEDED' | 'ARBITRATE' | 'NO_EVIDENCE' | 'USER_PROTECTED' | 'TARGET_GONE' | 'NOT_A_FIELD' | 'NO_T1_KNOWLEDGE';
  reasonCode: string;
  /** Propositions issues de T1 (après regroupement par valeur). */
  proposals: number;
  /** Éléments T1 lus par source (FACTS, UNRESOLVED_FACTS, SOURCE_UNITS, TITLE_HINT…). */
  sources: Record<string, number>;
  /** Sources absentes ou en échec. */
  missingSources: string[];
  confidence: number | null;
  writeAttempted: boolean;
  /** Écriture et fermeture relues en base. */
  verified: boolean;
  /** Lot 58B : pertinence métier évaluée (échéance passée) et appel IA éventuel. */
  pertinence?: string | null;
  aiCalled?: boolean;
  aiTraceId?: string | null;
  aiStatus?: string | null;
  /** Lot 61 : issue centrale. */
  outcome?: string | null;
}

/**
 * Valeur BRUTE lue (unité source, fait non intégré) : une date non ambiguë
 * (« JJ/MM/AAAA », « JJ.MM.AAAA », « JJ-MM-AAAA », « JJ:MM:AAAA »,
 * « 20 juin 2026 ») devient ISO ; le reste est rendu tel quel (le slot
 * normalise ou rejette). Pure.
 */
export function rawValueOf(v: string): string {
  return parseDocumentDate(v).iso ?? v.trim();
}

/** Motifs de fermeture « sans objet » (lot 61). */
const SANS_OBJET = ['NO_ACTION_NEEDED', 'DEFERRED', 'REPLACED_BY_INTERVENTION', 'USER_DECISION_RESPECTED'];

/**
 * Reprise CIBLÉE d'une donnée documentaire (DATA-CONTRACT-END,
 * DATA-WARRANTY-END, DATA-SUPPLIER…) depuis la connaissance T1 PERSISTÉE,
 * appelée par le passage T3 sur une carte ouverte — même décision que
 * l'analyse et le balayage (`evaluateFieldRule`), jamais le nom du fichier
 * seul, jamais en relisant le fichier ni en relançant T1 :
 *   · valeur fiable (fait certain, unique, document du même contrat, calcul
 *     déterministe) → écrite, carte fermée, relue ;
 *   · valeurs incertaines ou contradictoires → carte maintenue (ARBITRATE) ;
 *   · carte sans objet (échéance historique, différée, action réelle) → fermée ;
 *   · valeur de l'utilisateur (saisie ou retrait) → jamais écrasée.
 * Ne lève que pour une erreur technique (journalisée RESOLVER_FAILED par l'appelant).
 */
export async function resolveDocumentRuleFromKnowledge(
  accountId: number, fileId: number, ruleCode: string, deps: FieldRuleDeps & { runRef?: string | null } = {},
): Promise<KnowledgeFieldResolution> {
  const { getRule } = await import('./rules-catalog');
  const res = (p: Partial<KnowledgeFieldResolution> & Pick<KnowledgeFieldResolution, 'status' | 'reasonCode'>): KnowledgeFieldResolution => ({
    proposals: 0, sources: {}, missingSources: [], confidence: null, writeAttempted: false, verified: false, ...p,
  });
  const rule = getRule(ruleCode);
  if (!rule || rule.producer !== 'DOCUMENT_BRIDGE' || !rule.fieldKey) return res({ status: 'NOT_A_FIELD', reasonCode: 'NOT_A_FIELD' });
  const key = ruleDataKey(rule);
  const ctx = await loadContext(accountId, fileId);
  if (!ctx.exists) {
    // Compte étranger ou document supprimé : seules les cartes DU COMPTE sont fermées (tracées).
    const closed = await closeDataActions(db, accountId, fileId, key, 'TARGET_DELETED', { ruleCode: rule.code, reason: 'TARGET_DELETED', trigger: 'T3' });
    if (closed.length) {
      await tracer(emptyReport(), {
        accountId, fileId, ruleCode: rule.code, fieldKey: key, trigger: 'T3', runRef: deps.runRef ?? null, targetPresent: null, userValidated: null,
        decision: 'CLOSE', reasonCode: 'TARGET_DELETED', outcome: 'NO_ACTION', actionIds: { closed },
      });
    }
    return res({ status: 'TARGET_GONE', reasonCode: 'TARGET_GONE' });
  }
  const slot = documentSlotFor(key);
  const state = await slot.read(db, accountId, fileId);
  const actives = await activeActions(accountId, fileId);
  const active = actives.get(key) ?? null;
  const relevant = isRuleRelevantForDocument(rule, ctx.documentTypeCode);
  const report = emptyReport();
  const present = !isEmpty(state.value);

  // 1. Réévaluation d'état : donnée déjà renseignée, plus pertinente, tranchée ailleurs.
  const etat = planDocumentRule({ rule, state, proposals: [], mode: 'state', relevant, active, mayCreate: false });
  if (etat.kind === 'RESOLVE') {
    const before = { ...report };
    const exec = await executePlan(accountId, fileId, rule, slot, etat, state, report, 'OBSOLETE');
    // Lot 61 (écart 6) : fermeture tracée comme toute décision.
    await traceClassic({ accountId, fileId, rule, trigger: 'T3', runRef: deps.runRef, plan: etat, exec, active, state, report, before });
    return res({ status: 'RESOLVED', reasonCode: etat.reason, verified: !(await activeActions(accountId, fileId)).has(key), outcome: 'NO_ACTION' });
  }
  // 2. Valeur RETIRÉE par l'utilisateur : rien n'est réécrit automatiquement.
  if (state.userValidated && !present) return res({ status: 'USER_PROTECTED', reasonCode: 'USER_DECISION_PROTECTED' });
  if (present && (state.userValidated || (await readValueKind(accountId, fileId, key)).kind !== 'CALCULATED')) {
    return res({ status: 'RESOLVED', reasonCode: 'ALREADY_SATISFIED', verified: !(await activeActions(accountId, fileId)).has(key) });
  }

  // 3. Connaissance T1 persistée, calcul, pertinence, trace (0418, 0444).
  const o = await evaluateFieldRule({
    accountId, fileId, rule, slot, ctx, state, active, activeIntervention: actives.get(interventionKey(key)) ?? null, relevant,
    trigger: 'T3', mayCreate: ctx.open, closeReason: 'OBSOLETE', runRef: deps.runRef ?? null, deps, report,
  });
  const ev = o.evidence;
  const base = {
    proposals: o.proposals.length, sources: ev?.sources ?? {}, missingSources: ev?.missing ?? [], confidence: o.proposals[0]?.confidence ?? null,
    pertinence: o.pertinence?.pertinence ?? null, aiCalled: o.pertinence?.aiCalled ?? false, aiTraceId: o.pertinence?.aiTraceId ?? null,
    aiStatus: o.pertinence?.aiStatus ?? null, outcome: o.outcome,
  };
  if (SANS_OBJET.includes(o.plan.reason)) {
    return res({ ...base, status: 'NO_ACTION_NEEDED', reasonCode: o.plan.reason, verified: !(await activeActions(accountId, fileId)).has(key) });
  }
  if (ev && !ev.hasExtraction && o.proposals.length === 0 && o.plan.kind !== 'WRITE') return res({ ...base, status: 'NO_T1_KNOWLEDGE', reasonCode: 'NO_T1_KNOWLEDGE' });
  if (o.plan.kind === 'WRITE') {
    return res({ ...base, status: 'WRITTEN', reasonCode: o.verified ? 'RESOLVED' : 'PERSISTENCE_FAILED', writeAttempted: true, verified: o.verified === true, confidence: o.plan.confidence });
  }
  if (o.plan.kind === 'RESOLVE') return res({ ...base, status: 'RESOLVED', reasonCode: o.plan.reason, verified: !(await activeActions(accountId, fileId)).has(key) });
  if (o.proposals.length === 0) return res({ ...base, status: 'NO_EVIDENCE', reasonCode: 'FIELD_NOT_IN_T1' });
  return res({ ...base, status: 'ARBITRATE', reasonCode: o.proposals.length > 1 ? 'AMBIGUOUS' : 'INSUFFICIENT_EVIDENCE' });
}
