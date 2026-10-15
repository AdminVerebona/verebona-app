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
 * suivant ; une analyse perdue, non.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { assets, toProcessActionEvents, toProcessActions } from '@/db/schema';
import { AI_CONFIDENCE_THRESHOLD } from '@/lib/referential/v2';
import type { ActionKind, ActionProposal, ResolutionReason } from './action-model';
import {
  assessDeadlinePertinence, documentBridgeFieldKey, gatherFieldEvidence, isDeadlineRule, parseDocumentDate,
  recordRuleEvaluation, rememberedPertinence, ruleEvaluationsReady, t1KeyDesignates, todayParis,
  type FieldEvidence, type PertinenceCandidate, type PertinenceResult, type RuleDecision, type RuleTrigger,
} from './document-field-evidence';
import { decide } from './decision-engine';
import { documentSlotFor, formatIsoDate, toIsoDate, type DocumentSlot, type DocumentSlotState } from './document-slots';
import {
  documentBridgeRules,
  isRuleRelevantForDocument,
  ruleDataKey,
  type ProcessingRule,
} from './rules-catalog';
import { resolveActionsForData, upsertAction } from './to-process-action.service';
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
    const label = (id: number) => assetNames.get(id) ?? `Bien ${id}`;
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
}

const emptyReport = (): DocumentRulesReport => ({ created: 0, updated: 0, closed: 0, written: 0, plans: {}, reasons: {}, errors: {} });

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

/** Actions actives du document, par donnée. */
async function activeActions(accountId: number, fileId: number) {
  const rows = await db
    .select({
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
      actionKind: r.actionKind as ActionKind,
      snapshot: ctx && 'current' in ctx ? asString(ctx.current) : null,
    }];
  }));
}

/** Dernière résolution « Non applicable » d'une donnée : pas de retour sans élément nouveau (§7.4). */
async function declaredNotApplicable(accountId: number, fileId: number, key: string): Promise<boolean> {
  const [last] = await db
    .select({ reason: toProcessActions.resolutionReason })
    .from(toProcessActions)
    .where(and(
      eq(toProcessActions.accountId, accountId), eq(toProcessActions.targetType, 'DOCUMENT'),
      eq(toProcessActions.targetId, fileId),
      sql`COALESCE(${toProcessActions.fieldKey}, ${toProcessActions.relationKey}) = ${key}`,
      isNotNull(toProcessActions.resolvedAt),
    ))
    .orderBy(desc(toProcessActions.resolvedAt))
    .limit(1);
  return last?.reason === 'NOT_APPLICABLE';
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
): Promise<{ actionId?: number | null } | void> {
  const key = ruleDataKey(rule);
  report.plans[rule.code] = plan.kind;
  report.reasons[rule.code] = plan.reason;
  switch (plan.kind) {
    case 'NONE':
      return;
    case 'RESOLVE':
      report.closed += plan.reason === 'NO_ACTION_NEEDED'
        ? await closeWithoutPurpose(accountId, fileId, rule, closeMotive)
        : await resolveActionsForData(accountId, 'DOCUMENT', fileId, key, closeReason);
      return;
    case 'WRITE': {
      // Fermer AVANT d'écrire : l'écriture d'un rattachement déclenche la
      // 0257, qui fermerait sinon l'action avec un motif « utilisateur ».
      report.closed += await resolveActionsForData(accountId, 'DOCUMENT', fileId, key, 'OBSOLETE');
      const ok = await slot.writeAuto(db, accountId, fileId, plan.value, {
        origin: 'RECONCILIATION', confidence: plan.confidence, evidenceIds: plan.evidenceIds,
      });
      if (ok) report.written += 1;
      return;
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
        triggerContext: { current: asString(state.value) },
      });
      if (res.status === 'CREATED') report.created += 1;
      else if (res.status === 'UPDATED') report.updated += 1;
      return { actionId: res.actionId ?? null };
    }
  }
}

/**
 * Lot 58B : fermeture d'une carte devenue SANS OBJET (échéance historique,
 * aucune intervention attendue). Motif `OBSOLETE` (« le problème a
 * disparu ») et trace explicable dans `to_process_action_events`
 * (`details.reason = NO_ACTION_NEEDED`, pertinence, trace IA). Une carte que
 * l'utilisateur a déjà tranchée n'est plus active : jamais touchée.
 */
async function closeWithoutPurpose(accountId: number, fileId: number, rule: ProcessingRule, motive: Record<string, unknown>): Promise<number> {
  const now = new Date();
  const closed = await db.update(toProcessActions)
    .set({ resolvedAt: now, resolutionReason: 'OBSOLETE' satisfies ResolutionReason, updatedAt: now })
    .where(and(
      eq(toProcessActions.accountId, accountId), eq(toProcessActions.targetType, 'DOCUMENT'), eq(toProcessActions.targetId, fileId),
      sql`COALESCE(${toProcessActions.fieldKey}, ${toProcessActions.relationKey}) = ${ruleDataKey(rule)}`, isNull(toProcessActions.resolvedAt),
    ))
    .returning({ id: toProcessActions.id });
  if (closed.length) {
    await db.insert(toProcessActionEvents).values(closed.map((a) => ({
      actionId: a.id, accountId, event: 'OBSOLETE', actorUserId: null, targetType: 'DOCUMENT', targetId: fileId,
      fieldKey: ruleDataKey(rule), details: { ruleCode: rule.code, reason: 'NO_ACTION_NEEDED', ...motive }, createdAt: now,
    }))).catch((e: Error) => console.error(`[to-process] trace de fermeture de la règle ${rule.code} (document ${fileId}) non écrite :`, e.message));
  }
  return closed.length;
}

/** Noms des biens du compte, pour les libellés des propositions. */
async function assetNamesOf(accountId: number, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: assets.id, name: assets.name })
    .from(assets)
    .where(and(inArray(assets.id, [...new Set(ids)]), eq(assets.accountId, accountId), isNull(assets.deletedAt)));
  return new Map(rows.map((r) => [r.id, r.name ?? `Bien ${r.id}`]));
}


// ══════════════════════════════════════════════════════════════════════════
// LOT 58B — DONNÉE DOCUMENTAIRE : CONNAISSANCE, PERTINENCE, DÉCISION, TRACE
// ══════════════════════════════════════════════════════════════════════════

/** Dépendances injectables (tests) : décision T4, date du jour. */
export interface FieldRuleDeps {
  decide?: Parameters<typeof assessDeadlinePertinence>[0]['decide'];
  today?: string;
}

interface FieldRuleInput {
  accountId: number;
  fileId: number;
  rule: ProcessingRule;
  slot: DocumentSlot;
  ctx: DocumentContext;
  state: DocumentSlotState;
  active: { actionKind: ActionKind; snapshot: string | null } | null;
  relevant: boolean;
  trigger: RuleTrigger;
  mayCreate: boolean;
  closeReason: ResolutionReason;
  /** Analyse T1 : propositions de la sortie fraîche. */
  obsProposals?: ActionProposal[];
  runRef?: string | null;
  deps?: FieldRuleDeps;
  report: DocumentRulesReport;
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

/**
 * Une donnée documentaire (champ) d'une règle du pont, pour UN document —
 * même décision quel que soit le déclencheur (analyse T1, balayage, passage
 * T3, correction utilisateur) :
 *
 *   1. donnée présente, retirée par l'utilisateur ou hors pertinence du
 *      Type → chemin antérieur (`planDocumentRule`), inchangé ;
 *   2. sinon, AVANT toute question : connaissance T1 persistée (faits, alias
 *      canoniques, faits non intégrés, unités, titre vérifié contre le
 *      contenu) + sortie fraîche de l'analyse → matrice `decide()` : valeur
 *      fiable écrite et relue, valeurs incertaines → À arbitrer ;
 *   3. une question subsiste sur une ÉCHÉANCE entièrement passée → la
 *      pertinence est demandée à T4 CLASSIFY_EVENT (branche existante) :
 *      information historique → pas de carte (fermée si elle existait,
 *      motif tracé) ; action, abstention, échec → question maintenue ;
 *   4. diagnostic par règle (0418), y compris en erreur.
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

  try {
    if (present || userCleared || !relevant) {
      plan = i.trigger === 'ANALYSIS'
        ? planDocumentRule({ rule, state, proposals, mode: 'analysis', relevant, mayCreate: i.mayCreate })
        : planDocumentRule({ rule, state, proposals: [], mode: 'state', relevant, active, mayCreate: i.mayCreate });
    } else {
      path = 'KNOWLEDGE';
      failedStep = 'KNOWLEDGE';
      evidence = await gatherFieldEvidence(accountId, fileId, key);
      const connus = proposalsFromAnalysis(key, slot, {
        facts: evidence.facts.map((f) => ({ canonicalKey: key, value: f.value, confidence: f.confidence, excerpt: f.excerpt ?? null })),
        assetCandidates: [], documentAssetId: null,
      });
      proposals = mergeProposals(i.obsProposals ?? [], connus);
      failedStep = 'PLAN';
      plan = planDocumentRule({ rule, state, proposals, mode: 'analysis', relevant, active, mayCreate: i.mayCreate });
      if (plan.kind === 'UPSERT' && isDeadlineRule(rule)) {
        failedStep = 'PERTINENCE';
        pertinence = await assessDeadlinePertinence({
          accountId, fileId, rule, documentType: i.ctx.documentTypeCode, candidates: pertinenceCandidates(proposals, evidence),
          today: i.deps?.today ?? todayParis(), decide: i.deps?.decide, documentTitle: evidence.documentTitle ?? null,
          remembered: await rememberedPertinence(accountId, fileId, rule.code),
        });
        if (pertinence.pertinence === 'NO_ACTION_NEEDED') {
          plan = active ? { kind: 'RESOLVE', reason: 'NO_ACTION_NEEDED' } : { kind: 'NONE', reason: 'NO_ACTION_NEEDED' };
        }
      }
      // Réévaluation sans élément nouveau : la même question reste en l'état.
      if (i.trigger !== 'ANALYSIS' && plan.kind === 'UPSERT' && plan.actionKind === 'COMPLETE' && active?.actionKind === 'COMPLETE') {
        plan = { kind: 'NONE', reason: 'STILL_OPEN' };
      }
    }
    failedStep = plan.kind === 'WRITE' ? 'WRITE' : 'EXECUTE';
    const exec = await executePlan(accountId, fileId, rule, slot, plan, state, report, i.closeReason, pertinence ? {
      pertinence: pertinence.pertinence, pertinenceReason: pertinence.reason, aiTraceId: pertinence.aiTraceId, trigger: i.trigger,
    } : {});
    let verified: boolean | null = null;
    if (plan.kind === 'WRITE') {
      failedStep = 'VERIFY';
      const apres = await slot.read(db, accountId, fileId);
      const ferme = !(await activeActions(accountId, fileId)).has(key);
      verified = report.written > avant.written && apres.value !== null && String(apres.value) === String(slot.normalize(plan.value)) && ferme;
    }
    const outcome: FieldRuleOutcome = {
      plan, path, evidence, proposals, pertinence, writeAttempted: plan.kind === 'WRITE', verified,
      actionId: exec && 'actionId' in exec ? exec.actionId ?? null : null, decision: diagDecision(plan, report, avant, !!active),
    };
    await recordRuleEvaluation({
      accountId, fileId, ruleCode: rule.code, fieldKey: key, trigger: i.trigger, runRef: i.runRef ?? null,
      targetPresent: present, userValidated: state.userValidated, sources: evidence?.sources ?? {}, missingSources: evidence?.missing ?? [],
      observations: evidence?.observations ?? [], proposals: proposals.map((p) => ({ value: p.value, confidence: p.confidence })),
      titleHint: evidence?.titleHint ?? null, pertinence, decision: plan.kind === 'WRITE' && verified === false ? 'ERROR' : outcome.decision,
      reasonCode: plan.kind === 'WRITE' && verified === false ? 'PERSISTENCE_FAILED' : plan.reason, actionId: outcome.actionId,
      writeVerified: verified, failedStep: plan.kind === 'WRITE' && verified === false ? 'VERIFY' : null,
    });
    return outcome;
  } catch (e) {
    report.errors[rule.code] = (e as Error).message;
    await recordRuleEvaluation({
      accountId, fileId, ruleCode: rule.code, fieldKey: key, trigger: i.trigger, runRef: i.runRef ?? null,
      targetPresent: present, userValidated: state.userValidated, sources: evidence?.sources ?? {}, missingSources: evidence?.missing ?? [],
      observations: evidence?.observations ?? [], titleHint: evidence?.titleHint ?? null, pertinence,
      decision: 'ERROR', reasonCode: 'RULE_EVALUATION_FAILED', error: (e as Error).message, failedStep,
    });
    throw e;
  }
}

/** Erreur d'évaluation d'une RELATION ou hors champ : tracée en base (0418), pas seulement en console. */
async function recordRuleError(accountId: number, fileId: number, rule: ProcessingRule, trigger: RuleTrigger, e: unknown, report: DocumentRulesReport): Promise<void> {
  report.errors[rule.code] = (e as Error).message;
  await recordRuleEvaluation({
    accountId, fileId, ruleCode: rule.code, fieldKey: rule.fieldKey ?? rule.relationKey ?? null, trigger, targetPresent: null, userValidated: null,
    decision: 'ERROR', reasonCode: 'RULE_EVALUATION_FAILED', error: (e as Error).message, failedStep: 'PLAN',
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
          // Lot 58B : connaissance persistée, alias, pertinence, diagnostic.
          await evaluateFieldRule({
            accountId: input.accountId, fileId: input.fileId, rule, slot, ctx, state, active: actives.get(key) ?? null,
            relevant: isRuleRelevantForDocument(rule, ctx.documentTypeCode), trigger: 'ANALYSIS', mayCreate: ctx.open,
            closeReason: 'OBSOLETE', obsProposals: proposals, runRef: input.runRef ?? null, deps: input.deps, report,
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
        await executePlan(input.accountId, input.fileId, rule, slot, plan, state, report, 'OBSOLETE');
      } catch (e) {
        console.error(`[to-process] règle ${rule.code} du document ${input.fileId} non évaluée :`, (e as Error).message);
        if (!(rule.code in report.errors)) await recordRuleError(input.accountId, input.fileId, rule, 'ANALYSIS', e, report);
      }
    }
  } catch (e) {
    console.error(`[to-process] pont documentaire du document ${input.fileId} impossible :`, (e as Error).message);
  }
  return report;
}

/**
 * Réévaluation SANS analyse : après une correction faite ailleurs (tiroir,
 * fiche, validation des propositions), ou par le balayage horaire.
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
  try {
    const ctx = await loadContext(accountId, fileId);
    if (!ctx.exists) {
      // Document supprimé (ou source secondaire regroupée) : plus rien à traiter.
      const closed = await db
        .update(toProcessActions)
        .set({ resolvedAt: new Date(), resolutionReason: 'TARGET_DELETED', updatedAt: new Date() })
        .where(and(
          eq(toProcessActions.accountId, accountId), eq(toProcessActions.targetType, 'DOCUMENT'),
          eq(toProcessActions.targetId, fileId), isNull(toProcessActions.resolvedAt),
        ))
        .returning({ id: toProcessActions.id });
      report.closed += closed.length;
      return report;
    }
    const actives = await activeActions(accountId, fileId);

    for (const rule of documentBridgeRules()) {
      const key = ruleDataKey(rule);
      try {
        const slot = documentSlotFor(key);
        const state = await slot.read(db, accountId, fileId);
        const active = actives.get(key) ?? null;
        const relevant = isRuleRelevantForDocument(rule, ctx.documentTypeCode);
        const wantsCreation = !active && opts.create !== false && ctx.eligible && relevant && rule.completePriority !== null;
        const mayCreate = wantsCreation && !(await declaredNotApplicable(accountId, fileId, key))
          // Lot 31B (ticket T3, §9) : rattachement d'un document analysé —
          // la question attend l'échec ou l'abstention de T3 DOCUMENT_ASSET.
          && (key !== 'assetIds' || (await assetLinkQuestionAllowed(accountId, fileId)));
        const proposals = mayCreate && slot.storedProposals ? await slot.storedProposals(accountId, fileId) : [];
        const plan = planDocumentRule({ rule, state, proposals, mode: 'state', relevant, active, mayCreate });
        // Lot 58B : avant de créer ou de maintenir une question sur un champ,
        // la connaissance persistée et la pertinence sont consultées.
        if (slot.kind === 'field' && plan.kind !== 'RESOLVE' && (active || mayCreate)) {
          await evaluateFieldRule({
            accountId, fileId, rule, slot, ctx, state, active, relevant, trigger: opts.trigger ?? (reason === 'USER_COMPLETED' ? 'USER' : 'SWEEP'),
            // Carte active : la mettre à jour reste possible (document ouvert).
            mayCreate: active ? ctx.open : mayCreate, closeReason: reason, runRef: opts.runRef ?? null, deps: opts.deps, report,
          });
          continue;
        }
        await executePlan(accountId, fileId, rule, slot, plan, state, report, reason);
      } catch (e) {
        console.error(`[to-process] règle ${rule.code} du document ${fileId} non réévaluée :`, (e as Error).message);
        if (!(rule.code in report.errors)) await recordRuleError(accountId, fileId, rule, opts.trigger ?? 'SWEEP', e, report);
      }
    }
  } catch (e) {
    console.error(`[to-process] réévaluation du document ${fileId} impossible :`, (e as Error).message);
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
 *   · ceux qui portent une action documentaire active (fermeture si résolue) ;
 *   · ceux qui manquent d'une donnée REQUISE sans action ouverte —
 *     rattachement à un bien pour tout document, donnée de la règle pour les
 *     Types concernés. C'est aussi le rattrapage automatique des documents
 *     antérieurs au lot 28, borné à `limit` documents par passage.
 */
export async function documentsToReevaluate(accountId: number, limit = 200): Promise<number[]> {
  const rules = documentBridgeRules();
  const keys = rules.map(ruleDataKey);
  const ids = new Set<number>();

  const actifs = (await pgClient.unsafe(
    `SELECT DISTINCT target_id AS id FROM to_process_actions
      WHERE account_id = $1 AND target_type = 'DOCUMENT' AND resolved_at IS NULL
        AND COALESCE(field_key, relation_key) = ANY($2::text[])`,
    [accountId, keys] as never[],
  )) as unknown as Array<{ id: number }>;
  for (const r of actifs) ids.add(Number(r.id));

  // Lot 58B : un document dont la DERNIÈRE évaluation de la règle a conclu
  // « aucune intervention nécessaire » (échéance historique) n'est pas repris
  // tant qu'il n'a pas changé — ni carte recréée, ni IA rappelée.
  const memoire = await ruleEvaluationsReady();
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
    const rows = (await pgClient.unsafe(
      `SELECT f.id FROM asset_files f
        WHERE f.account_id = $1 AND ${ELIGIBLE_SQL}
          AND ($2::text[] IS NULL OR f.document_type_code = ANY($2::text[]))
          AND ${manque}
          ${memoire && rule.fieldKey ? `AND NOT EXISTS (
            SELECT 1 FROM document_rule_evaluations e
             WHERE e.id = (SELECT max(x.id) FROM document_rule_evaluations x
                            WHERE x.account_id = f.account_id AND x.file_id = f.id AND x.rule_code = $5)
               AND e.reason_code = 'NO_ACTION_NEEDED' AND e.last_seen_at >= f.updated_at)` : ''}
          AND NOT EXISTS (
            SELECT 1 FROM to_process_actions a WHERE a.account_id = f.account_id AND a.target_type = 'DOCUMENT'
               AND a.target_id = f.id AND COALESCE(a.field_key, a.relation_key) = $4
               AND (a.resolved_at IS NULL OR (a.resolution_reason = 'NOT_APPLICABLE' AND NOT EXISTS (
                 SELECT 1 FROM to_process_actions b WHERE b.account_id = a.account_id AND b.target_type = 'DOCUMENT'
                    AND b.target_id = a.target_id AND COALESCE(b.field_key, b.relation_key) = $4
                    AND b.resolved_at > a.resolved_at))))
        ORDER BY f.id
        LIMIT $3`,
      (memoire && rule.fieldKey ? [accountId, types, budget, key, rule.code] : [accountId, types, budget, key]) as never[],
    )) as unknown as Array<{ id: number }>;
    for (const r of rows) {
      if (!ids.has(Number(r.id))) budget -= 1;
      ids.add(Number(r.id));
    }
  }
  return [...ids];
}

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
   * WRITTEN : valeur fiable écrite, carte fermée · RESOLVED : carte close sans
   * écriture (donnée déjà présente, plus pertinente…) · NO_ACTION_NEEDED
   * (58B) : échéance historique sans intervention attendue, carte fermée avec
   * motif tracé · ARBITRATE : valeur(s) incertaine(s), carte maintenue avec
   * propositions · NO_EVIDENCE : aucune valeur dans T1 · USER_PROTECTED :
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

/**
 * Reprise CIBLÉE d'une donnée documentaire (DATA-CONTRACT-END,
 * DATA-WARRANTY-END, DATA-SUPPLIER…) depuis la connaissance T1 PERSISTÉE,
 * appelée par le passage T3 sur une carte ouverte — même décision que
 * l'analyse et le balayage (`evaluateFieldRule`), jamais le nom du fichier
 * seul, jamais en relisant le fichier ni en relançant T1 :
 *   · valeur fiable (fait certain, unique) → écrite, carte fermée, relue ;
 *   · valeurs incertaines ou contradictoires → carte maintenue (ARBITRATE) ;
 *   · échéance passée sans intervention attendue (T4) → carte fermée ;
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
    await resolveActionsForData(accountId, 'DOCUMENT', fileId, key, 'TARGET_DELETED');
    return res({ status: 'TARGET_GONE', reasonCode: 'TARGET_GONE' });
  }
  const slot = documentSlotFor(key);
  const state = await slot.read(db, accountId, fileId);
  const active = (await activeActions(accountId, fileId)).get(key) ?? null;
  const relevant = isRuleRelevantForDocument(rule, ctx.documentTypeCode);
  const report = emptyReport();
  const present = !isEmpty(state.value);

  // 1. Réévaluation d'état : donnée déjà renseignée, plus pertinente, tranchée ailleurs.
  const etat = planDocumentRule({ rule, state, proposals: [], mode: 'state', relevant, active, mayCreate: false });
  if (etat.kind === 'RESOLVE') {
    await executePlan(accountId, fileId, rule, slot, etat, state, report, 'OBSOLETE');
    return res({ status: 'RESOLVED', reasonCode: etat.reason, verified: !(await activeActions(accountId, fileId)).has(key) });
  }
  // 2. Valeur RETIRÉE par l'utilisateur : rien n'est réécrit automatiquement.
  if (state.userValidated && !present) return res({ status: 'USER_PROTECTED', reasonCode: 'USER_DECISION_PROTECTED' });
  if (present) return res({ status: 'RESOLVED', reasonCode: 'ALREADY_SATISFIED', verified: !(await activeActions(accountId, fileId)).has(key) });

  // 3. Connaissance T1 persistée, matrice du pont, pertinence, trace (0418).
  const o = await evaluateFieldRule({
    accountId, fileId, rule, slot, ctx, state, active, relevant, trigger: 'T3', mayCreate: ctx.open, closeReason: 'OBSOLETE',
    runRef: deps.runRef ?? null, deps, report,
  });
  const ev = o.evidence;
  const base = {
    proposals: o.proposals.length, sources: ev?.sources ?? {}, missingSources: ev?.missing ?? [], confidence: o.proposals[0]?.confidence ?? null,
    pertinence: o.pertinence?.pertinence ?? null, aiCalled: o.pertinence?.aiCalled ?? false, aiTraceId: o.pertinence?.aiTraceId ?? null,
    aiStatus: o.pertinence?.aiStatus ?? null,
  };
  if (o.plan.reason === 'NO_ACTION_NEEDED') {
    return res({ ...base, status: 'NO_ACTION_NEEDED', reasonCode: 'NO_ACTION_NEEDED', verified: !(await activeActions(accountId, fileId)).has(key) });
  }
  if (ev && !ev.hasExtraction && o.proposals.length === 0) return res({ ...base, status: 'NO_T1_KNOWLEDGE', reasonCode: 'NO_T1_KNOWLEDGE' });
  if (o.plan.kind === 'WRITE') {
    return res({ ...base, status: 'WRITTEN', reasonCode: o.verified ? 'RESOLVED' : 'PERSISTENCE_FAILED', writeAttempted: true, verified: o.verified === true, confidence: o.plan.confidence });
  }
  if (o.plan.kind === 'RESOLVE') return res({ ...base, status: 'RESOLVED', reasonCode: o.plan.reason, verified: !(await activeActions(accountId, fileId)).has(key) });
  if (o.proposals.length === 0) return res({ ...base, status: 'NO_EVIDENCE', reasonCode: 'FIELD_NOT_IN_T1' });
  return res({ ...base, status: 'ARBITRATE', reasonCode: o.proposals.length > 1 ? 'AMBIGUOUS' : 'INSUFFICIENT_EVIDENCE' });
}
