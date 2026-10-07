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
import { assets, toProcessActions } from '@/db/schema';
import { AI_CONFIDENCE_THRESHOLD } from '@/lib/referential/v2';
import { resolveAlias } from '@/services/canonical/registry';
import type { ActionKind, ActionProposal, ResolutionReason } from './action-model';
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
    if (f.canonicalKey === key) ajouter(f.value, score(f.confidence), f.excerpt);
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
}

const emptyReport = (): DocumentRulesReport => ({ created: 0, updated: 0, closed: 0, written: 0, plans: {} });

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
): Promise<void> {
  const key = ruleDataKey(rule);
  report.plans[rule.code] = plan.kind;
  switch (plan.kind) {
    case 'NONE':
      return;
    case 'RESOLVE':
      report.closed += await resolveActionsForData(accountId, 'DOCUMENT', fileId, key, closeReason);
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
      return;
    }
  }
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

/**
 * Après l'analyse d'un document (pipeline T1, une fois le classement V2 et
 * les liens N-N écrits). Ne lève jamais.
 */
export async function syncDocumentRulesFromAnalysis(input: {
  accountId: number;
  fileId: number;
  observations: AnalysisObservations;
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

    for (const rule of documentBridgeRules()) {
      const key = ruleDataKey(rule);
      try {
        const slot = documentSlotFor(key);
        const state = await slot.read(db, input.accountId, input.fileId);
        const proposals = proposalsFromAnalysis(key, slot, obs, names);
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
  opts: { reason?: ResolutionReason; create?: boolean } = {},
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
        await executePlan(accountId, fileId, rule, slot, plan, state, report, reason);
      } catch (e) {
        console.error(`[to-process] règle ${rule.code} du document ${fileId} non réévaluée :`, (e as Error).message);
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
          AND NOT EXISTS (
            SELECT 1 FROM to_process_actions a WHERE a.account_id = f.account_id AND a.target_type = 'DOCUMENT'
               AND a.target_id = f.id AND COALESCE(a.field_key, a.relation_key) = $4
               AND (a.resolved_at IS NULL OR (a.resolution_reason = 'NOT_APPLICABLE' AND NOT EXISTS (
                 SELECT 1 FROM to_process_actions b WHERE b.account_id = a.account_id AND b.target_type = 'DOCUMENT'
                    AND b.target_id = a.target_id AND COALESCE(b.field_key, b.relation_key) = $4
                    AND b.resolved_at > a.resolved_at))))
        ORDER BY f.id
        LIMIT $3`,
      [accountId, types, budget, key] as never[],
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

/**
 * Clé d'une donnée documentaire du pont pour une clé d'écran (proposition
 * d'analyse validée ou modifiée dans le tiroir : `warrantyEndDate`,
 * `dateFinContrat`…), sinon null. Les relations (rattachement) ont leurs
 * propres écrans et ne passent pas ici.
 */
export function documentBridgeFieldKey(screenKey: string): string | null {
  const keys = new Set(documentBridgeRules().filter((r) => r.fieldKey).map((r) => r.fieldKey!));
  if (keys.has(screenKey)) return screenKey;
  const canonique = resolveAlias(screenKey);
  return canonique && keys.has(canonique) ? canonique : null;
}

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
