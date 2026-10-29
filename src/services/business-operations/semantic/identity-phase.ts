/**
 * Lot 97A — PHASE « identité T3 » du passage T3 d'un compte (file durable de
 * consolidation, hors verrou) : traite les demandes en attente de
 * réévaluation T3 de l'identité d'une Opération à plusieurs sources (contrat
 * `t3-operation-identity-v1`), enregistrées par `requestIdentityReevaluation`.
 *
 *   capacité (prompt T3 actif : branche + marqueur) → contexte borné →
 *   mémoire (même contexte, même contrat, même version : aucun nouvel appel)
 *   → budget (plafonds EXISTANTS du rapprochement sémantique, par passage et
 *   par 24 h) → appel T3 (passerelle : traces, coûts, schéma) → VALIDATION
 *   (refus en bloc, jamais de repli heuristique) → plan (décisions certaines
 *   seulement) → application (décisions de rattachement relues par la
 *   consolidation T3 existante, tout ou rien) → journal.
 *
 * Les documents touchés sont rendus à l'appelant, qui les reconsolide dans le
 * même passage (`consolidator.passer`). Une demande dont la capacité a été
 * retirée entre-temps (prompt réactivé) est close « indisponible ».
 */
import type postgres from 'postgres';

type Sql = postgres.Sql;

interface IdentityPhaseResult {
  processed: number;
  aiCalls: number;
  /** Documents remis en consolidation (décisions appliquées). */
  files: number[];
  outcomes: Record<string, number>;
}

const todayParis = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);

export async function runIdentityPhase(accountId: number, opts: {
  sql?: Sql; now?: () => Date; beforeCall?: (what: string) => Promise<void> | void;
  decider?: import('./identity-decider').IdentityDecider; dailyMax?: number; passMax?: number; limit?: number;
} = {}): Promise<IdentityPhaseResult> {
  const out: IdentityPhaseResult = { processed: 0, aiCalls: 0, files: [], outcomes: {} };
  const [{ pgClient }, store, ctxMod, contract, validate, deciderMod, m3] = await Promise.all([
    import('@/db'), import('./store'), import('./identity-context'), import('./identity-contract'), import('./identity-validate'),
    import('./identity-decider'), import('../consolidation/m3'),
  ]);
  const sql = opts.sql ?? pgClient;
  if (!(await store.semanticJournalReady(sql))) return out;
  const demandes = await store.pendingIdentityRequests(sql, accountId, contract.IDENTITY_CONTRACT_VERSION, opts.limit ?? 20);
  if (!demandes.length) return out;
  const now = opts.now ?? (() => new Date());
  const decider = opts.decider ?? deciderMod.identityDecider();
  const parJour = opts.dailyMax ?? m3.operationMatchCallsPerDay();
  const parPassage = opts.passMax ?? m3.operationMatchCallsPerPass();
  const compter = (s: string) => { out.outcomes[s] = (out.outcomes[s] ?? 0) + 1; };

  for (const d of demandes) {
    const cap = await decider.capability();
    if (!cap.available) {
      await store.completeReevaluation(sql, d.id, { status: 'UNAVAILABLE', reason: cap.reason, contextSummary: { contractState: cap.contractState ?? null } });
      compter('UNAVAILABLE');
      out.processed++;
      continue;
    }
    const raw = await ctxMod.loadIdentityRaw(sql, accountId, d.operationId, { today: todayParis(now()), request: d.reason ?? '' });
    if (!raw || !raw.operation.active) {
      await store.completeReevaluation(sql, d.id, { status: 'NO_CHANGE', reason: raw ? 'OPERATION_INACTIVE' : 'OPERATION_GONE', decided: true });
      compter('NO_CHANGE');
      out.processed++;
      continue;
    }
    const b = ctxMod.buildIdentityInput(raw);
    const summary = {
      sources: b.input.sources.length, inScope: b.input.sources.filter((s) => s.inScope).length, protectedSources: b.input.sources.filter((s) => s.protected).length,
      neighbours: b.input.neighbours.length, documents: b.input.documents.length, bounds: b.input.bounds,
    };
    const avant = { sources: b.scope.sources.map((s) => ({ ref: s.ref, sourceId: s.sourceId, fileId: s.fileId, candidateKey: s.candidateKey, protected: s.protected })) };
    if (b.tooLarge) {
      await store.completeReevaluation(sql, d.id, { status: 'DEFERRED', reason: 'CONTEXT_TOO_LARGE', contextFingerprint: b.fingerprint, contextSummary: summary });
      compter('DEFERRED');
      out.processed++;
      continue;
    }
    if (!b.scope.sources.some((s) => s.inScope)) {
      await store.completeReevaluation(sql, d.id, { status: 'NO_CHANGE', reason: 'NO_DOCUMENT_SOURCE', contextFingerprint: b.fingerprint, contextSummary: summary, decided: true });
      compter('NO_CHANGE');
      out.processed++;
      continue;
    }
    // Mémoire : même contexte, même contrat, même version du prompt → aucune nouvelle demande.
    const couvre = await store.findCovering(sql, {
      accountId, scope: 'T3', operationId: d.operationId, fingerprint: b.fingerprint, contractVersion: contract.IDENTITY_CONTRACT_VERSION, deciderVersion: cap.version ?? '', now: now(),
    });
    if (couvre && couvre.id !== d.id) {
      await store.completeReevaluation(sql, d.id, { status: 'NO_CHANGE', reason: `SETTLED_BY:${couvre.id}`, contextFingerprint: b.fingerprint, contextSummary: summary, decided: true });
      compter('SETTLED');
      out.processed++;
      continue;
    }
    // Budget : plafonds existants (par passage, par 24 h et par compte) — la demande reste en attente.
    if (out.aiCalls >= parPassage || (await store.semanticCallsLastDay(sql, accountId, 'T3', now())) >= parJour) { compter('DEFERRED_BUDGET'); break; }

    await opts.beforeCall?.('T3 identité multi-sources — décision sémantique');
    let answer: { output: unknown; traceId: string | null };
    out.aiCalls++;
    out.processed++;
    try {
      answer = await decider.decide({ accountId, operationId: d.operationId, sourceIds: Object.values(b.scope.documents), input: b.input });
    } catch (e) {
      const { isExecutionCancelled } = await import('@/services/ai/queue/execution-control');
      if (isExecutionCancelled(e)) throw e;
      await store.completeReevaluation(sql, d.id, {
        status: 'AI_FAILED', reason: 'AI_CALL_FAILED', error: String((e as Error)?.message ?? e), aiCalls: 1, deciderVersion: cap.version ?? undefined,
        contextFingerprint: b.fingerprint, contextSummary: summary, beforeState: avant,
      });
      compter('AI_FAILED');
      continue;
    }
    const commun = {
      aiCalls: 1, aiTraceId: answer.traceId, deciderVersion: cap.version ?? undefined, contextFingerprint: b.fingerprint, contextSummary: summary, beforeState: avant, decided: true,
    };
    const v = validate.validateIdentity(answer.output, b.scope);
    if (!v.ok) {
      await store.completeReevaluation(sql, d.id, {
        ...commun, status: 'REJECTED', reason: `INVALID_DECISION:${v.problems[0]?.issue ?? 'SCHEMA'}`, aiOutput: answer.output ?? null,
        validation: { valid: false, problems: v.problems }, afterState: avant, resultingFingerprint: b.fingerprint,
      });
      compter('REJECTED');
      continue;
    }
    const decision = v.decision;
    if (decision.outcome === 'ABSTAIN') {
      await store.completeReevaluation(sql, d.id, { ...commun, status: 'ABSTAINED', reason: decision.reason, aiOutput: decision, validation: { valid: true }, resultingFingerprint: b.fingerprint });
      compter('ABSTAINED');
      continue;
    }
    const plan = validate.planIdentity(decision, b.scope);
    if (!plan.mutations.length) {
      await store.completeReevaluation(sql, d.id, {
        ...commun, status: 'NO_CHANGE', reason: decision.reason, aiOutput: decision, validation: { valid: true, decided: plan.decided },
        refused: plan.refused, resultingFingerprint: b.fingerprint,
      });
      compter('NO_CHANGE');
      continue;
    }
    const { applyIdentityMutations, IdentityApplyRefused } = await import('./identity-apply');
    try {
      const r = await applyIdentityMutations({ scope: b.scope, mutations: plan.mutations, journalId: d.id, correlationId: d.correlationId, beforeWrite: opts.beforeCall });
      out.files.push(...r.files);
      const status = plan.refused.length ? 'PARTIAL' : 'APPLIED';
      await store.completeReevaluation(sql, d.id, {
        ...commun, status, reason: decision.reason, aiOutput: decision, validation: { valid: true, decided: plan.decided },
        applied: plan.mutations.map((m, i) => ({ ...m, decisionId: r.decisionIds[i] ?? null })), refused: plan.refused,
        afterState: { decisions: r.decisionIds, files: r.files, reconsolidation: 'T3' },
      });
      console.info(JSON.stringify({ event: 't3.semantic_identity', accountId, operationId: d.operationId, status, applied: plan.mutations.length, journalId: d.id }));
      compter(status);
    } catch (e) {
      const { isExecutionCancelled } = await import('@/services/ai/queue/execution-control');
      if (isExecutionCancelled(e)) throw e;
      const garde = e instanceof IdentityApplyRefused;
      await store.completeReevaluation(sql, d.id, {
        ...commun, status: garde ? 'REJECTED' : 'FAILED', reason: garde ? 'STATE_CHANGED' : 'APPLY_FAILED', aiOutput: decision,
        validation: garde ? { valid: false, problems: (e as InstanceType<typeof IdentityApplyRefused>).refused.map((x) => ({ issue: 'STATE_CHANGED', detail: `${x.mutation.kind}:${x.mutation.sourceRef}:${x.reason}` })) } : { valid: true },
        refused: plan.mutations.map((m) => ({ mutation: m, reason: garde ? 'STATE_CHANGED' : 'APPLY_FAILED' })), error: String((e as Error)?.message ?? e),
      });
      compter(garde ? 'REJECTED' : 'FAILED');
    }
  }
  out.files = [...new Set(out.files)];
  return out;
}
