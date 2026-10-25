/**
 * Lot 87B — ORCHESTRATION des réévaluations sémantiques T3 → T4 (CODE-02,
 * CODE-03, CODE-05 à CODE-11).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * faits / documents → T3 : identité Opération → Opérations consolidées
 *                   → T4 : représentation Agenda → éléments consolidés
 *
 *   reevaluateRepresentation   (T4) une Opération et TOUS ses éléments
 *     candidats : contexte large et borné → mémoire (même contexte, même
 *     contrat, même décideur : aucun nouvel appel ; état produit par une
 *     décision appliquée : convergé) → capacité (contrat multi-événements
 *     livré ?) → budget (plafonds existants du rapprochement sémantique) →
 *     décision → VALIDATION (refus en bloc, jamais d'heuristique de repli) →
 *     plan (protections de l'utilisateur) → application atomique → nouvel
 *     état relu (empreinte produite) → journal (décision reçue, mutations
 *     appliquées / refusées, avant / après). Une préoccupation d'identité
 *     signalée par T4 demande une réévaluation T3.
 *   requestIdentityReevaluation (T3) une Opération dont l'identité est
 *     suspecte : son document est remis en examen T3 avec le verdict M3
 *     historique ÉCARTÉ (CODE-06) — consolidation T3 par la file durable
 *     existante ; une fusion décidée par T3 émet l'événement Opération, la
 *     projection est rejouée et, si l'Agenda en est affecté, T4 réévalue
 *     (même file : CODE-02).
 *
 * Déclencheurs (`SemanticTrigger`) : contrôle de cohérence (CODE-05),
 * projection après une décision T3 (file durable, CODE-02), reprise du stock
 * (CODE-07), geste d'exploitation. Compte non éligible (C-Q10) : rien.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  REPRESENTATION_AI_CONTRACT, REPRESENTATION_CONTRACT_VERSION, T3_IDENTITY_AI_CONTRACT,
  type RefusedMutation, type RepresentationMutation, type SemanticStatus, type SemanticTrigger,
} from './contract';
import { buildRepresentationInput, DEFAULT_REPRESENTATION_BOUNDS, type BuiltRepresentation, type RepresentationBounds } from './context';
import type { RepresentationDecider } from './decider';
import { decidedRoles, planRepresentation } from './plan';
import { validateRepresentation } from './validate';

type Sql = postgres.Sql;

export interface RepresentationRequest {
  accountId: number;
  operationId: number;
  trigger: SemanticTrigger;
  triggerRef?: string | null;
  correlationId?: string | null;
  /** Candidats fournis par l'appelant (projection : rapprochement incertain). */
  extraItemIds?: readonly number[];
  today?: string;
  /** DRY_RUN : diagnostic seulement (aucun appel, aucune écriture, aucun journal). */
  mode?: 'APPLY' | 'DRY_RUN';
  /** Appels du passage déjà consommés (plafond par passage). */
  passCalls?: { n: number };
  origin?: 'PROJECTION' | 'REPRISE';
  runId?: string | null;
  beforeWrite?: (what: string) => Promise<void> | void;
  deps?: { decider?: RepresentationDecider; now?: () => Date; bounds?: RepresentationBounds; sql?: Sql; dailyMax?: number; passMax?: number; reproject?: boolean };
}

export type RepresentationOutcomeStatus = SemanticStatus | 'SETTLED' | 'NOT_NEEDED' | 'WOULD_REQUEST';

export interface RepresentationOutcome {
  status: RepresentationOutcomeStatus;
  journalId: number | null;
  fingerprint: string | null;
  /** Décision close couvrant ce contexte (mémoire). */
  settledBy?: { id: number; status: SemanticStatus } | null;
  reason?: string;
  aiContract?: string;
  applied: number;
  refused: number;
  aiCalls: number;
  identityConcern?: string | null;
}

const vide = (status: RepresentationOutcomeStatus, extra: Partial<RepresentationOutcome> = {}): RepresentationOutcome =>
  ({ status, journalId: null, fingerprint: null, applied: 0, refused: 0, aiCalls: 0, ...extra });

const todayParis = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);

/**
 * Y a-t-il une décision de représentation à prendre ? (pur) Plusieurs
 * éléments à décider, une ancienne consolidation à réexaminer, ou un
 * candidat DEMANDÉ (projection : rapprochement incertain) qui n'est pas
 * encore rattaché à l'Opération — T4 dit s'il la représente.
 */
export function representationNeeded(b: BuiltRepresentation, requested: readonly number[] = []): boolean {
  const aDecider = b.scope.items.filter((i) => i.inScope);
  if (aDecider.length >= 2 || b.input.restorable.length > 0) return true;
  const demandes = new Set(requested);
  return aDecider.some((i) => demandes.has(i.id) && i.operationId !== b.scope.operationId);
}

/** Résumé d'état (avant / après) borné : éléments, rattachements, rôles, restaurables. */
export function stateSummary(b: BuiltRepresentation): Record<string, unknown> {
  return {
    items: b.scope.items.filter((i) => i.inScope).map((i) => ({ id: i.id, op: i.operationId, role: i.role, roleOrigin: i.roleOrigin, projected: i.projected })),
    restorable: b.scope.restorables.map((r) => ({ journalId: r.journalId, absorbedItemId: r.absorbedItemId })),
  };
}

function contextSummary(b: BuiltRepresentation): Record<string, unknown> {
  return {
    items: b.input.agendaItems.length, inScope: b.input.agendaItems.filter((i) => i.inScope).length, restorable: b.input.restorable.length,
    documents: b.input.documents.length, neighbours: b.input.neighbours.length, userDecisions: b.input.userDecisions.length, bounds: b.input.bounds,
  };
}

async function build(sql: Sql, accountId: number, operationId: number, today: string, extra: readonly number[], bounds: RepresentationBounds): Promise<BuiltRepresentation | null> {
  const { loadRepresentationRaw } = await import('./load');
  const raw = await loadRepresentationRaw(sql, accountId, operationId, { today, extraItemIds: extra });
  return raw ? buildRepresentationInput(raw, bounds) : null;
}

/** Réévaluation T4 de la représentation Agenda d'UNE Opération (voir l'en-tête). Lève sur une lecture en échec. */
export async function reevaluateRepresentation(req: RepresentationRequest): Promise<RepresentationOutcome> {
  const [{ pgClient }, deciderMod, store, m3] = await Promise.all([
    import('@/db'), import('./decider'), import('./store'), import('../consolidation/m3'),
  ]);
  const sql = req.deps?.sql ?? pgClient;
  const now = req.deps?.now ?? (() => new Date());
  const decider = req.deps?.decider ?? deciderMod.representationDecider();
  const bounds = req.deps?.bounds ?? DEFAULT_REPRESENTATION_BOUNDS;
  const today = req.today ?? todayParis(now());
  const dry = req.mode === 'DRY_RUN';

  if (!dry) {
    const { isAccountProcessingEligible } = await import('@/services/account/processing-eligibility');
    if (!(await isAccountProcessingEligible(req.accountId))) return vide('DEFERRED', { reason: 'ACCOUNT_INELIGIBLE' });
  }
  if (!(await store.semanticJournalReady(sql))) return vide('UNAVAILABLE', { reason: 'JOURNAL_MISSING' });
  const b = await build(sql, req.accountId, req.operationId, today, req.extraItemIds ?? [], bounds);
  if (!b || !b.scope.operationActive) return vide('NOT_NEEDED', { reason: b ? 'OPERATION_INACTIVE' : 'OPERATION_GONE' });
  if (!representationNeeded(b, req.extraItemIds ?? [])) return vide('NOT_NEEDED', { fingerprint: b.fingerprint, reason: 'SINGLE_REPRESENTATION' });

  const cap = await decider.capability();
  const version = cap.version ?? '';
  const base = {
    accountId: req.accountId, scope: 'T4' as const, operationId: req.operationId, triggerKind: req.trigger, triggerRef: req.triggerRef ?? null,
    correlationId: req.correlationId ?? null, contractVersion: REPRESENTATION_CONTRACT_VERSION, deciderVersion: version,
    contextFingerprint: b.fingerprint, contextSummary: contextSummary(b),
  };
  const couvre = await store.findCovering(sql, { accountId: req.accountId, scope: 'T4', operationId: req.operationId, fingerprint: b.fingerprint, contractVersion: REPRESENTATION_CONTRACT_VERSION, deciderVersion: version, now: now() });
  if (couvre) return vide('SETTLED', { fingerprint: b.fingerprint, journalId: couvre.id, settledBy: { id: couvre.id, status: couvre.status }, reason: couvre.reason ?? undefined });

  /** Constat d'attente journalisé une seule fois par contexte (pas de ligne quotidienne identique). */
  const attente = async (status: 'UNAVAILABLE' | 'DEFERRED', reason: string, aiContract?: string): Promise<RepresentationOutcome> => {
    if (dry) return vide(status, { fingerprint: b.fingerprint, reason, aiContract });
    const deja = await store.findSameWaiting(sql, { accountId: req.accountId, scope: 'T4', operationId: req.operationId, fingerprint: b.fingerprint, status, reason, deciderVersion: version });
    const id = deja?.id ?? await store.recordReevaluation(sql, { ...base, status, reason, beforeState: stateSummary(b) });
    return vide(status, { fingerprint: b.fingerprint, journalId: id, reason, aiContract });
  };
  if (!cap.available) return attente('UNAVAILABLE', cap.reason, REPRESENTATION_AI_CONTRACT);
  if (b.tooLarge) return attente('DEFERRED', 'CONTEXT_TOO_LARGE');
  if (dry) return vide('WOULD_REQUEST', { fingerprint: b.fingerprint });

  // Budget : plafonds EXISTANTS du rapprochement sémantique (par passage, par 24 h et par compte).
  const parJour = req.deps?.dailyMax ?? m3.operationMatchCallsPerDay();
  const parPassage = req.deps?.passMax ?? m3.operationMatchCallsPerPass();
  if (req.passCalls && req.passCalls.n >= parPassage) return vide('DEFERRED', { fingerprint: b.fingerprint, reason: 'PASS_CAP' });
  if ((await store.semanticCallsLastDay(sql, req.accountId, 'T4', now())) >= parJour) return attente('DEFERRED', 'DAILY_CAP');

  await req.beforeWrite?.('T4 représentation Agenda — décision sémantique');
  const sourceIds = Object.values(b.scope.documents);
  let answer: { output: unknown; traceId: string | null };
  try {
    if (req.passCalls) req.passCalls.n++;
    answer = await decider.decide({ accountId: req.accountId, operationId: req.operationId, sourceIds, input: b.input });
  } catch (e) {
    const { isExecutionCancelled } = await import('@/services/ai/queue/execution-control');
    if (isExecutionCancelled(e)) throw e;
    const message = String((e as Error)?.message ?? e).slice(0, 400);
    const id = await store.recordReevaluation(sql, { ...base, status: 'AI_FAILED', reason: 'AI_CALL_FAILED', error: message, aiCalls: 1, beforeState: stateSummary(b) });
    return vide('AI_FAILED', { fingerprint: b.fingerprint, journalId: id, reason: message, aiCalls: 1 });
  }

  // CODE-10 : une réponse invalide est refusée EN BLOC, tracée, sans mutation ni repli heuristique.
  const v = validateRepresentation(answer.output, b.scope);
  if (!v.ok) {
    const id = await store.recordReevaluation(sql, {
      ...base, status: 'REJECTED', reason: `INVALID_DECISION:${v.problems[0]?.issue ?? 'SCHEMA'}`, aiOutput: answer.output ?? null,
      validation: { valid: false, problems: v.problems }, aiCalls: 1, aiTraceId: answer.traceId, beforeState: stateSummary(b), afterState: stateSummary(b),
      resultingFingerprint: b.fingerprint, decided: true,
    });
    return vide('REJECTED', { fingerprint: b.fingerprint, journalId: id, reason: v.problems.map((p) => p.issue).join(','), aiCalls: 1 });
  }
  const decision = v.decision;
  const concern = decision.identityConcern ? `${decision.identityConcern.kind}: ${decision.identityConcern.reason}`.slice(0, 300) : null;
  if (decision.outcome === 'ABSTAIN') {
    const id = await store.recordReevaluation(sql, {
      ...base, status: 'ABSTAINED', reason: decision.reason, aiOutput: decision, validation: { valid: true }, aiCalls: 1, aiTraceId: answer.traceId,
      beforeState: stateSummary(b), afterState: stateSummary(b), resultingFingerprint: b.fingerprint, decided: true,
    });
    await signalIdentity(req, concern);
    return vide('ABSTAINED', { fingerprint: b.fingerprint, journalId: id, reason: decision.reason, aiCalls: 1, identityConcern: concern });
  }

  const plan = planRepresentation(decision, b.scope);
  const roles = decidedRoles(decision, b.scope);
  // CODE-10 : une décision qui modifierait un objet PROTÉGÉ (correction de l'utilisateur, élément d'une autre
  // Opération, élément restauré…) est refusée EN BLOC — jamais appliquée en partie, jamais corrigée par le code.
  const violations = plan.refused.filter((r) => r.reason !== 'NOT_CERTAIN');
  if (violations.length) {
    const id = await store.recordReevaluation(sql, {
      ...base, status: 'REJECTED', reason: `PROTECTED_OBJECT:${violations[0].reason}`, aiOutput: decision,
      validation: { valid: false, problems: violations.slice(0, 10).map((r) => ({ issue: 'PROTECTED_OBJECT', detail: `${r.mutation.kind}:${r.reason}` })) },
      refused: plan.refused.slice(0, 100), aiCalls: 1, aiTraceId: answer.traceId, beforeState: stateSummary(b), afterState: stateSummary(b),
      resultingFingerprint: b.fingerprint, decided: true,
    });
    await signalIdentity(req, concern);
    return vide('REJECTED', { fingerprint: b.fingerprint, journalId: id, reason: `PROTECTED_OBJECT:${violations.map((v) => v.reason).join(',')}`, aiCalls: 1, refused: violations.length, identityConcern: concern });
  }
  let applied: RepresentationMutation[] = [];
  const restoreRunId = randomUUID();
  if (plan.mutations.length) {
    const { applyRepresentationMutations, RepresentationApplyRefused } = await import('./apply');
    try {
      applied = (await applyRepresentationMutations(sql, {
        accountId: req.accountId, operationId: req.operationId, mutations: plan.mutations, correlationId: req.correlationId ?? `t4-semantic:${restoreRunId}`,
        restoreRunId, origin: req.origin ?? 'PROJECTION', runId: req.runId ?? null, beforeWrite: req.beforeWrite,
      })).applied;
    } catch (e) {
      const { isExecutionCancelled } = await import('@/services/ai/queue/execution-control');
      if (isExecutionCancelled(e)) throw e;
      // Tout ou rien : la transaction est annulée, aucune mutation n'est restée.
      const garde = e instanceof RepresentationApplyRefused;
      const message = String((e as Error)?.message ?? e).slice(0, 400);
      const id = await store.recordReevaluation(sql, {
        ...base, status: garde ? 'REJECTED' : 'FAILED', reason: garde ? 'STATE_CHANGED' : 'APPLY_FAILED', aiOutput: decision,
        validation: garde ? { valid: false, problems: (e as InstanceType<typeof RepresentationApplyRefused>).refused.slice(0, 10).map((r) => ({ issue: 'STATE_CHANGED', detail: `${r.mutation.kind}:${r.reason}` })) } : { valid: true },
        refused: [...plan.refused, ...(garde ? (e as InstanceType<typeof RepresentationApplyRefused>).refused
          : plan.mutations.map((m): RefusedMutation => ({ mutation: m, reason: 'APPLY_FAILED' })))].slice(0, 100),
        error: message, aiCalls: 1, aiTraceId: answer.traceId, beforeState: stateSummary(b), afterState: stateSummary(b),
        // Une garde : l'état a changé — la décision ne vaut pas pour le nouveau contexte (nouvelle empreinte).
        ...(garde ? { decided: true } : {}),
      });
      return vide(garde ? 'REJECTED' : 'FAILED', { fingerprint: b.fingerprint, journalId: id, reason: garde ? 'STATE_CHANGED' : message, aiCalls: 1 });
    }
  }
  const apres = await build(sql, req.accountId, req.operationId, today, req.extraItemIds ?? [], bounds);
  const nonCertaines = plan.refused.filter((r) => r.reason === 'NOT_CERTAIN');
  const status: SemanticStatus = applied.length === 0 ? 'NO_CHANGE' : nonCertaines.length ? 'PARTIAL' : 'APPLIED';
  const id = await store.recordReevaluation(sql, {
    ...base, status, reason: decision.reason, aiOutput: decision, validation: { valid: true }, decidedItems: roles, applied, refused: plan.refused.slice(0, 100),
    aiCalls: 1, aiTraceId: answer.traceId, beforeState: stateSummary(b), afterState: apres ? stateSummary(apres) : null,
    resultingFingerprint: apres?.fingerprint ?? b.fingerprint, decided: true,
  });
  console.info(JSON.stringify({
    event: 't4.semantic_representation', accountId: req.accountId, operationId: req.operationId, trigger: req.trigger, status,
    applied: applied.length, refused: plan.refused.length, journalId: id,
  }));
  // Convergence (CODE-02, CODE-11) : la projection de l'Opération est rejouée avec la décision mémorisée —
  // cartes D14 devenues sans objet closes, principal et documents propagés. Jamais de nouvel appel T4 ici.
  if (applied.length || Object.keys(roles).length) {
    await reproject(req, sql);
    // État FINAL (après la projection) : c'est lui que la mémoire reconnaît comme produit par cette décision.
    const final = await build(sql, req.accountId, req.operationId, today, req.extraItemIds ?? [], bounds);
    if (final) await store.updateOutcome(sql, id, { afterState: stateSummary(final), resultingFingerprint: final.fingerprint });
  }
  await signalIdentity(req, concern);
  return vide(status, { fingerprint: b.fingerprint, journalId: id, applied: applied.length, refused: plan.refused.length, aiCalls: 1, identityConcern: concern });
}

/** Projection de l'Opération après une décision T4 (aucun appel T4). Ne lève jamais. */
async function reproject(req: RepresentationRequest, sql: Sql): Promise<void> {
  if (req.deps?.reproject === false) return;
  try {
    const { projectAccountOperations } = await import('../agenda-projection/service');
    // `runId` : les écritures de la projection (intitulé précisé, journal 0591) se restaurent avec l'exécution (reprise BO).
    await projectAccountOperations(req.accountId, {
      operationIds: [req.operationId], correlationId: req.correlationId ?? null, today: req.today, beforeWrite: req.beforeWrite,
      ...(req.runId ? { runId: req.runId } : {}),
    });
  } catch (e) {
    const { isExecutionCancelled } = await import('@/services/ai/queue/execution-control');
    if (isExecutionCancelled(e)) throw e;
    console.error(`[semantic] projection après décision T4 (compte ${req.accountId}, Opération ${req.operationId}) :`, (e as Error).message);
  }
  void sql;
}

/** T4 signale une identité d'Opération suspecte : réévaluation T3 (« T3 puis T4 »). Ne lève jamais. */
async function signalIdentity(req: RepresentationRequest, concern: string | null): Promise<void> {
  if (!concern || req.mode === 'DRY_RUN') return;
  try {
    await requestIdentityReevaluation({
      accountId: req.accountId, operationIds: [req.operationId], trigger: req.trigger, triggerRef: 'T4_IDENTITY_CONCERN',
      correlationId: req.correlationId ?? null, reason: `T4 : ${concern}`, deps: req.deps?.sql ? { sql: req.deps.sql } : undefined,
    });
  } catch (e) {
    console.error(`[semantic] réévaluation T3 demandée par T4 non enregistrée (Opération ${req.operationId}) :`, (e as Error).message);
  }
}

// ── T3 : identité ──────────────────────────────────────────────────────────

export interface IdentityRequest {
  accountId: number;
  operationIds: readonly number[];
  trigger: SemanticTrigger;
  triggerRef?: string | null;
  correlationId?: string | null;
  reason: string;
  /** Ne pas mettre la consolidation T3 en file (appelant qui consolide lui-même : contrôle, tests). */
  enqueue?: boolean;
  /**
   * Écarter le verdict M3 historique (décision suspecte, CODE-06) — défaut.
   * `false` : l'examen est rouvert mais un verdict déjà rendu reste appliqué
   * (décision établie à rejouer, aucun nouvel appel).
   */
  discardVerdict?: boolean;
  deps?: { sql?: Sql; now?: () => Date };
}

export interface IdentityOutcome {
  /** Opérations dont le document est remis en examen T3 (verdict historique écarté). */
  requested: number[];
  /** Opérations déjà en réexamen T3 (aucune seconde demande). */
  alreadyPending: number[];
  /** Opérations dont l'identité ne peut pas être réexaminée avec le contrat T3 actuel (constat). */
  unsupported: Array<{ operationId: number; reason: string; aiContract: string }>;
  journalIds: number[];
}

/**
 * Demande à T3 une NOUVELLE décision d'identité pour des Opérations
 * suspectes (CODE-05, CODE-06). Contrat T3 actuel (`OPERATION_MATCH`) : le
 * document d'une Opération à document UNIQUE est réexaminé face aux autres
 * Opérations du compte — décision recalculée sans sa propre Opération, verdict
 * M3 antérieur ÉCARTÉ (nouvel appel sous les plafonds existants), fusion
 * existante si T3 établit la même réalité. Une Opération à plusieurs
 * documents (scission, déplacement d'une source) n'est pas décidable avec ce
 * contrat : constat + demande IA (`87B-t3-identite-multi-operations`).
 */
export async function requestIdentityReevaluation(req: IdentityRequest): Promise<IdentityOutcome> {
  const [{ pgClient }, store] = await Promise.all([import('@/db'), import('./store')]);
  const sql = req.deps?.sql ?? pgClient;
  const now = req.deps?.now ?? (() => new Date());
  const out: IdentityOutcome = { requested: [], alreadyPending: [], unsupported: [], journalIds: [] };
  if (!(await store.semanticJournalReady(sql))) return out;
  const { isAccountProcessingEligible } = await import('@/services/account/processing-eligibility');
  if (!(await isAccountProcessingEligible(req.accountId))) return out;
  const ids = [...new Set(req.operationIds)].filter((x) => Number.isSafeInteger(x) && x > 0);
  for (const operationId of ids) {
    if (await store.openT3Request(sql, req.accountId, operationId)) { out.alreadyPending.push(operationId); continue; }
    const docs = await sql.unsafe<Array<{ file_id: number; n: number }>>(`
      SELECT DISTINCT f.id AS file_id, count(*) OVER ()::int AS n FROM business_operation_sources s
        JOIN asset_files f ON f.id::text = s.source_entity_key AND f.account_id = s.account_id AND f.deleted_at IS NULL
        JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
       WHERE s.account_id = $1 AND s.operation_id = $2 AND s.active AND s.source_kind = 'DOCUMENT'`, [req.accountId, operationId] as never[]);
    const autres = await sql.unsafe<Array<{ n: number }>>(`
      SELECT count(*)::int AS n FROM business_operation_sources s WHERE s.account_id = $1 AND s.operation_id = $2 AND s.active AND s.source_kind <> 'DOCUMENT'`,
    [req.accountId, operationId] as never[]);
    const fichiers = [...new Set(docs.map((d) => Number(d.file_id)))];
    if (fichiers.length !== 1 || Number(autres[0]?.n ?? 0) > 0) {
      const reason = fichiers.length === 0 ? 'NO_DOCUMENT_SOURCE' : 'MULTI_SOURCE_IDENTITY';
      const deja = await store.findSameWaiting(sql, { accountId: req.accountId, scope: 'T3', operationId, fingerprint: null, status: 'UNAVAILABLE', reason, deciderVersion: '' });
      const id = deja?.id ?? await store.recordReevaluation(sql, {
        accountId: req.accountId, scope: 'T3', operationId, triggerKind: req.trigger, triggerRef: req.triggerRef ?? null, correlationId: req.correlationId ?? null,
        status: 'UNAVAILABLE', reason, contractVersion: 'OPERATION_MATCH', deciderVersion: '', contextSummary: { documents: fichiers.length, otherSources: Number(autres[0]?.n ?? 0), request: req.reason.slice(0, 200) },
      });
      out.unsupported.push({ operationId, reason, aiContract: T3_IDENTITY_AI_CONTRACT });
      out.journalIds.push(id);
      continue;
    }
    const requestId = randomUUID();
    const at = req.discardVerdict === false ? '1970-01-01T00:00:00.000Z' : now().toISOString();
    const marques = await sql.unsafe<Array<{ id: number }>>(`
      UPDATE document_operation_candidates c
         SET t3_pending = true,
             t3_detail = COALESCE(c.t3_detail, '{}'::jsonb)
               || jsonb_build_object('retroRequested', jsonb_build_object('by', 'SEMANTIC_REEVALUATION_T3', 'at', $4::text))
               || jsonb_build_object('semanticReevaluation', jsonb_build_object('requestId', $5::text, 'at', $4::text, 'operationId', $3::bigint, 'trigger', $6::text))
       WHERE c.account_id = $1 AND c.file_id = $2 AND c.status = 'ACTIVE' AND c.established
         AND EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.account_id = c.account_id AND s.operation_id = $3 AND s.active
                       AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = c.file_id::text AND s.locator->>'candidateKey' = c.candidate_key)
      RETURNING c.id`, [req.accountId, fichiers[0], operationId, at, requestId, req.trigger] as never[]);
    if (!marques.length) {
      out.unsupported.push({ operationId, reason: 'NO_CANDIDATE', aiContract: T3_IDENTITY_AI_CONTRACT });
      continue;
    }
    const id = await store.recordReevaluation(sql, {
      accountId: req.accountId, scope: 'T3', operationId, triggerKind: req.trigger, triggerRef: req.triggerRef ?? null, correlationId: req.correlationId ?? null,
      status: 'PENDING', reason: req.reason, contractVersion: 'OPERATION_MATCH', deciderVersion: '',
      contextSummary: { fileId: fichiers[0], candidates: marques.map((m) => Number(m.id)), requestId, at },
    });
    out.requested.push(operationId);
    out.journalIds.push(id);
  }
  if (out.requested.length && req.enqueue !== false) {
    const { requestOperationsConsolidation } = await import('../consolidation/queue');
    await requestOperationsConsolidation(req.accountId, { trigger: 'admin_reconsolidation', correlationId: req.correlationId ?? `t3-semantic:${randomUUID()}` })
      .catch((e: Error) => console.error(`[semantic] consolidation T3 non mise en file (compte ${req.accountId}) :`, e.message));
  }
  return out;
}

/**
 * Clôt les demandes T3 en attente dont l'examen est terminé (appelé après une
 * consolidation T3 du compte) : DONE avec fusion → APPLIED, sinon NO_CHANGE.
 * Ne lève jamais.
 */
export async function settleIdentityRequests(accountId: number, sql?: Sql): Promise<number> {
  try {
    const [{ pgClient }, store] = await Promise.all([import('@/db'), import('./store')]);
    const s = sql ?? pgClient;
    if (!(await store.semanticJournalReady(s))) return 0;
    const lignes = await s.unsafe<Array<{ id: number; candidates: number[] | null; request_id: string | null }>>(`
      SELECT r.id, ARRAY(SELECT jsonb_array_elements_text(r.context_summary -> 'candidates')::int) AS candidates, r.context_summary ->> 'requestId' AS request_id
        FROM operation_semantic_reevaluations r WHERE r.account_id = $1 AND r.scope = 'T3' AND r.status = 'PENDING' ORDER BY r.id LIMIT 200`, [accountId] as never[]);
    let n = 0;
    for (const l of lignes) {
      const c = await s.unsafe<Array<{ pending: boolean; retro_status: string | null; retro_result: string | null; outcome: string | null; op: number | null; done: string | null }>>(`
        SELECT t3_pending AS pending, t3_detail -> 'retro' ->> 'status' AS retro_status, t3_detail -> 'retro' ->> 'result' AS retro_result,
               t3_outcome AS outcome, t3_operation_id::int AS op, t3_detail -> 'semanticReevaluation' ->> 'doneAt' AS done
          FROM document_operation_candidates WHERE account_id = $1 AND id = ANY($2::int[])`, [accountId, `{${(l.candidates ?? []).join(',')}}`] as never[]);
      if (!c.length) { await store.settlePending(s, { id: Number(l.id), status: 'NO_CHANGE', reason: 'CANDIDATE_GONE' }); n++; continue; }
      if (c.some((x) => x.pending || x.retro_status === 'PENDING' || !x.done)) continue;
      const fusion = c.some((x) => x.retro_result === 'MERGED');
      await store.settlePending(s, {
        id: Number(l.id), status: fusion ? 'APPLIED' : 'NO_CHANGE', reason: fusion ? 'T3_RETRO_MERGE' : `T3_${c[0].retro_result ?? c[0].outcome ?? 'DONE'}`,
        afterState: { candidates: c.map((x) => ({ outcome: x.outcome, operationId: x.op, retro: x.retro_result })) },
      });
      n++;
    }
    return n;
  } catch (e) {
    console.error(`[semantic] clôture des réévaluations T3 (compte ${accountId}) :`, (e as Error).message);
    return 0;
  }
}

export { REPRESENTATION_AI_CONTRACT, T3_IDENTITY_AI_CONTRACT };

export interface RequestedRepresentation { operationId: number; itemIds: number[]; reason: string }

export interface RequestedRun {
  requested: number;
  outcomes: Partial<Record<RepresentationOutcomeStatus, number>>;
  aiCalls: number;
  applied: number;
}

/**
 * Lot 87B (CODE-02) : demandes de décision T4 rendues par la projection
 * (`representationRequired`) — une réévaluation par Opération, plafonnée par
 * passage. Appelée par l'exécutant de la file durable de projection, par la
 * reprise du stock et par le contrôle de cohérence. Ne lève que sur une
 * interruption d'exécution ; une erreur d'Opération est journalisée.
 */
export async function reevaluateRequestedRepresentations(accountId: number, requests: readonly RequestedRepresentation[], o: {
  trigger: SemanticTrigger; correlationId?: string | null; triggerRef?: string | null; today?: string; origin?: 'PROJECTION' | 'REPRISE'; runId?: string | null;
  beforeWrite?: (what: string) => Promise<void> | void; deps?: RepresentationRequest['deps'];
}): Promise<RequestedRun> {
  const run: RequestedRun = { requested: 0, outcomes: {}, aiCalls: 0, applied: 0 };
  const parOp = new Map<number, Set<number>>();
  for (const r of requests) {
    const s = parOp.get(r.operationId) ?? new Set<number>();
    for (const id of r.itemIds) s.add(id);
    parOp.set(r.operationId, s);
  }
  const passCalls = { n: 0 };
  for (const [operationId, items] of parOp) {
    run.requested++;
    try {
      const r = await reevaluateRepresentation({
        accountId, operationId, trigger: o.trigger, triggerRef: o.triggerRef ?? null, correlationId: o.correlationId ?? null,
        extraItemIds: [...items], today: o.today, passCalls, origin: o.origin, runId: o.runId, beforeWrite: o.beforeWrite, deps: o.deps,
      });
      run.outcomes[r.status] = (run.outcomes[r.status] ?? 0) + 1;
      run.aiCalls += r.aiCalls;
      run.applied += r.applied;
    } catch (e) {
      const { isExecutionCancelled } = await import('@/services/ai/queue/execution-control');
      if (isExecutionCancelled(e)) throw e;
      run.outcomes.FAILED = (run.outcomes.FAILED ?? 0) + 1;
      console.error(`[semantic] réévaluation T4 (compte ${accountId}, Opération ${operationId}) :`, (e as Error).message);
    }
  }
  return run;
}
