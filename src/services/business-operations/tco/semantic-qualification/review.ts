/**
 * Lot 113AL (Trello #737, §3 D) — ORCHESTRATION de l'arbitrage sémantique T3
 * des montants non qualifiés : demandes, mémoire, et PHASE du passage T3 du
 * compte (file durable de consolidation), sur le patron du lot 113AD.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   demande  `requestQualificationReviews` — posée par le contrôle
 *            COH-TCO-EXTRACTED-EXPENSES (campagne, contrôle ciblé quand un
 *            document est analysé ou modifié), SANS appel IA : une ligne
 *            PENDING par document et empreinte de contexte jamais examinée ;
 *   phase    `runQualificationPhase` — passage T3 du compte (hors verrou de
 *            consolidation, jamais à la consultation) : capacité (contrat du
 *            prompt T3 actif, coupure) → verrou de la demande (RUNNING) →
 *            TCO relu par le moteur → montants encore à arbitrer ? → mémoire
 *            (même empreinte déjà examinée : aucun appel) → budget (plafonds
 *            EXISTANTS du rapprochement sémantique, par passage et par 24 h ;
 *            éligibilité et plafond de coût du compte appliqués par la
 *            passerelle) → appel T3 → VALIDATION stricte (toute sortie
 *            invalide = abstention) → décision persistée (effets par montant,
 *            avant / après, versions, coût) → examen précédent SUPERSEDED ;
 *   lecture  `readSemanticStates` (`tco/service.ts`) — effets relus par le
 *            moteur à chaque calcul, SOUS les décisions de l'utilisateur.
 * Contrat absent : CONTRACT_PENDING durable, reprise automatique au retour du
 * contrat. Fournisseur indisponible : AI_FAILED (3 essais, 6 h), puis
 * TECHNICAL_WAIT (un essai par jour) — jamais une décision métier, jamais une
 * faute de l'utilisateur.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type postgres from 'postgres';
import { ECONOMIC_QUALIFICATION_CONTRACT_VERSION, type QualificationEffect, type RawQualificationAmount } from './contract';

type Sql = postgres.Sql | postgres.TransactionSql;
type Row = Record<string, unknown>;
const q = async (sql: Sql, text: string, params: unknown[]): Promise<Row[]> => (await sql.unsafe(text, params as never[])) as unknown as Row[];
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const tableMissing = (e: unknown) => (e as { code?: string })?.code === '42P01';

/** Paramètres centralisés (à valider par le PO). */
export const QUALIFICATION_PARAMS = {
  /** Demandes examinées par passage (au-delà : passage suivant). */
  requestsPerPass: 10,
  /** Essais rapprochés après un échec technique, puis attente technique quotidienne. */
  maxAttempts: 3,
  retryAfterHours: 6,
  technicalWaitHours: 24,
  /** Une demande RUNNING plus ancienne est reprise (processus interrompu). */
  runningStaleMinutes: 30,
  /** Contrat absent : nouvel examen de la capacité au plus tard après ce délai (reprise automatique). */
  contractRecheckHours: 24,
} as const;

export type QualificationTrigger = 'COHERENCE' | 'EVIDENCE_CHANGE' | 'BACKFILL' | 'BACKGROUND';

/** Statuts d'examen conclu (relus par le moteur). */
export const CONCLUDED = ['DECIDED', 'ABSTAINED', 'NOT_CERTAIN', 'REJECTED'] as const;

/** État des examens d'un document pour une empreinte (contrôle de cohérence). */
export type ReviewState = 'NONE' | 'AWAITING' | 'CONTRACT_PENDING' | 'CONCLUDED';

/** États par document et empreinte (une requête ; table absente : NONE). */
export async function reviewStates(sql: Sql, accountId: number, assetId: number, items: ReadonlyArray<{ fileId: number; fingerprint: string }>): Promise<Map<string, { state: ReviewState; status: string }>> {
  const out = new Map<string, { state: ReviewState; status: string }>();
  if (!items.length) return out;
  let r: Row[] = [];
  try {
    r = await q(sql, `SELECT file_id, fingerprint, status FROM economic_qualification_reviews
                       WHERE account_id = $1 AND asset_id = $2 AND fingerprint = ANY($3::text[])`,
    [accountId, assetId, `{${items.map((i) => i.fingerprint).join(',')}}`]);
  } catch (e) { if (tableMissing(e)) return out; throw e; }
  for (const x of r) {
    const st = String(x.status);
    const state: ReviewState = (CONCLUDED as readonly string[]).includes(st) || st === 'SUPERSEDED' || st === 'OBSOLETE' ? 'CONCLUDED'
      : st === 'CONTRACT_PENDING' ? 'CONTRACT_PENDING' : 'AWAITING';
    out.set(`${Number(x.file_id)}:${String(x.fingerprint)}`, { state, status: st });
  }
  return out;
}

/** Demandes d'examen (aucun appel IA) ; une empreinte déjà connue n'est jamais redemandée. Rend les demandes posées. */
export async function requestQualificationReviews(sql: Sql, accountId: number, assetId: number,
  items: ReadonlyArray<{ fileId: number; fingerprint: string; amounts: readonly RawQualificationAmount[] }>, trigger: QualificationTrigger): Promise<number> {
  let n = 0;
  for (const it of items) {
    const r = await q(sql, `
      INSERT INTO economic_qualification_reviews (account_id, asset_id, file_id, fingerprint, status, trigger, amounts, contract_version)
      SELECT $1::int, $2::int, $3::int, $4::text, 'PENDING', $5::text, $6::text::jsonb, $7::text
       WHERE EXISTS (SELECT 1 FROM asset_files f WHERE f.id = $3::int AND f.account_id = $1::int AND f.deleted_at IS NULL)
         AND EXISTS (SELECT 1 FROM assets a WHERE a.id = $2::int AND a.account_id = $1::int AND a.deleted_at IS NULL)
      ON CONFLICT (account_id, file_id, fingerprint) DO NOTHING
      RETURNING id`, [accountId, assetId, it.fileId, it.fingerprint, trigger, json(it.amounts.map((a) => ({ amountMinor: a.amountMinor, currency: a.currency, origin: a.origin, lineId: a.lineId }))), ECONOMIC_QUALIFICATION_CONTRACT_VERSION]);
    n += r.length;
  }
  return n;
}

/** Prédicat SQL « demande à traiter » (balayage horaire du passage T3, file de la phase). */
export const QUALIFICATION_PENDING_SQL = (alias: string) => `
  (${alias}.status = 'PENDING'
   OR (${alias}.status IN ('AI_FAILED', 'TECHNICAL_WAIT') AND ${alias}.retry_at <= now())
   OR (${alias}.status = 'RUNNING' AND ${alias}.claimed_at < now() - make_interval(mins => ${QUALIFICATION_PARAMS.runningStaleMinutes}))
   OR (${alias}.status = 'CONTRACT_PENDING' AND ${alias}.updated_at < now() - make_interval(hours => ${QUALIFICATION_PARAMS.contractRecheckHours})))`;

interface Pending { id: number; assetId: number; fileId: number; fingerprint: string; attempts: number; trigger: string }

async function pendingRequests(sql: Sql, accountId: number, limit: number, withContractPending: boolean): Promise<Pending[]> {
  const r = await q(sql, `
    SELECT r.id, r.asset_id, r.file_id, r.fingerprint, r.attempts, r.trigger FROM economic_qualification_reviews r
     WHERE r.account_id = $1 AND (${QUALIFICATION_PENDING_SQL('r')}${withContractPending ? ` OR r.status = 'CONTRACT_PENDING'` : ''})
     ORDER BY r.id LIMIT $2`, [accountId, limit]);
  return r.map((x) => ({ id: Number(x.id), assetId: Number(x.asset_id), fileId: Number(x.file_id), fingerprint: String(x.fingerprint), attempts: Number(x.attempts ?? 0), trigger: String(x.trigger) }));
}

/** Verrou anti-concurrence : la demande passe RUNNING si elle est encore à traiter (rend false sinon). */
async function claim(sql: Sql, id: number): Promise<boolean> {
  const r = await q(sql, `
    UPDATE economic_qualification_reviews r SET status = 'RUNNING', claimed_at = now(), updated_at = now()
     WHERE r.id = $1 AND (${QUALIFICATION_PENDING_SQL('r')} OR r.status = 'CONTRACT_PENDING') RETURNING r.id`, [id]);
  return r.length === 1;
}

/** Appels IA du compte sur 24 h glissantes (budget de cette branche). */
async function callsLastDay(sql: Sql, accountId: number): Promise<number> {
  const [r] = await q(sql, `SELECT COALESCE(sum(ai_calls), 0)::int AS n FROM economic_qualification_reviews WHERE account_id = $1 AND last_call_at > now() - interval '24 hours'`, [accountId]);
  return Number(r?.n ?? 0);
}

async function complete(sql: Sql, id: number, r: {
  status: string; reason?: string | null; decisions?: unknown; aiOutput?: unknown; validation?: Record<string, unknown>; before?: unknown; after?: unknown;
  promptVersion?: string | null; model?: string | null; traceId?: string | null; costMicros?: number | null; called?: boolean; error?: string | null;
  retryHours?: number | null; fingerprint?: string | null;
}): Promise<void> {
  await q(sql, `
    UPDATE economic_qualification_reviews
       SET status = $2::text, reason = COALESCE($3::text, reason), decisions = COALESCE($4::text::jsonb, decisions), ai_output = COALESCE($5::text::jsonb, ai_output),
           validation = COALESCE($6::text::jsonb, validation), lines_before = COALESCE($7::text::jsonb, lines_before), lines_after = COALESCE($8::text::jsonb, lines_after),
           prompt_version = COALESCE($9::text, prompt_version), model = COALESCE($10::text, model), ai_trace_id = COALESCE($11::text, ai_trace_id),
           ai_cost_micros = CASE WHEN $12::bigint IS NULL THEN ai_cost_micros ELSE COALESCE(ai_cost_micros, 0) + $12::bigint END,
           ai_calls = ai_calls + CASE WHEN $13::boolean THEN 1 ELSE 0 END, attempts = attempts + CASE WHEN $13::boolean THEN 1 ELSE 0 END,
           last_call_at = CASE WHEN $13::boolean THEN now() ELSE last_call_at END, error = $14::text,
           retry_at = CASE WHEN $15::int IS NULL THEN NULL ELSE now() + make_interval(hours => $15::int) END,
           fingerprint = COALESCE($16::text, fingerprint), claimed_at = NULL,
           decided_at = CASE WHEN $2::text IN ('DECIDED', 'ABSTAINED', 'NOT_CERTAIN', 'REJECTED', 'OBSOLETE') THEN now() ELSE decided_at END, updated_at = now()
     WHERE id = $1`,
  [id, r.status, r.reason ? r.reason.slice(0, 300) : null, json(r.decisions), json(r.aiOutput), json(r.validation), json(r.before), json(r.after),
    r.promptVersion ?? null, r.model ?? null, r.traceId ?? null, r.costMicros ?? null, r.called === true, r.error ? r.error.slice(0, 500) : null,
    r.retryHours ?? null, r.fingerprint ?? null]);
}

/** Lignes du document dans le TCO (traçabilité avant / après, jamais un contenu de document). */
const snapshot = (lines: ReadonlyArray<{ id: string; fileId: number | null; status: string; reason: string | null; kind: string | null; amountMinor: number; currency: string; includedCents: number }>, fileId: number) =>
  lines.filter((l) => l.fileId === fileId).map((l) => ({ lineId: l.id, status: l.status, reason: l.reason, kind: l.kind, amountMinor: l.amountMinor, currency: l.currency, includedCents: l.includedCents }));

/** Effets d'abstention (sortie refusée, aucune décision) : la trace reste lisible, rien ne change dans le calcul. */
const abstentions = (amounts: readonly RawQualificationAmount[], reason: string): QualificationEffect[] => amounts.map((a, i) => ({
  amountRef: `M${i + 1}`, fileId: a.fileId, lineId: a.lineId, amountMinor: a.amountMinor, currency: a.currency, origin: a.origin, outcome: 'ABSTAIN', applied: false,
  role: null, scope: null, economicDate: null, periodStart: null, periodEnd: null, allocation: null, representedBy: null, exclusion: null,
  confidence: 'ambiguous', reason, evidence: [], serverNote: null,
}));

export interface QualificationPhaseResult {
  processed: number;
  aiCalls: number;
  outcomes: Record<string, number>;
  /** Capacité absente (bloc 31 non collé, coupure) : aucune demande traitée par l'IA. */
  unavailable?: string;
}

const todayParis = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);

/**
 * Phase du passage T3 du compte (file de consolidation) : traite les demandes d'arbitrage en attente, par lot borné.
 * Ne lève que l'annulation coopérative ; tout autre échec est tracé sur la demande.
 */
export async function runQualificationPhase(accountId: number, opts: {
  sql?: Sql; now?: () => Date; beforeCall?: (what: string) => Promise<void> | void;
  decider?: import('./decider').QualificationDecider; dailyMax?: number; passMax?: number; limit?: number; today?: string;
} = {}): Promise<QualificationPhaseResult> {
  const out: QualificationPhaseResult = { processed: 0, aiCalls: 0, outcomes: {} };
  const [{ pgClient }, deciderMod, contract, m3, targets] = await Promise.all([
    import('@/db'), import('./decider'), import('./contract'), import('@/services/business-operations/consolidation/m3'), import('./targets'),
  ]);
  const sql = opts.sql ?? pgClient;
  const decider = opts.decider ?? deciderMod.qualificationDecider();
  const compter = (s: string) => { out.outcomes[s] = (out.outcomes[s] ?? 0) + 1; };
  // Compte restreint (lecture seule, impayé, terminé, sans abonnement) : zéro appel modèle et zéro écriture (82A, 113AE).
  const { checkAccountProcessingEligibility } = await import('@/services/account/processing-eligibility');
  if (!(await checkAccountProcessingEligibility(accountId)).eligible) return out;
  const cap = await decider.capability();
  let demandes: Pending[];
  try { demandes = await pendingRequests(sql, accountId, opts.limit ?? QUALIFICATION_PARAMS.requestsPerPass, cap.available); } catch (e) { if (tableMissing(e)) return out; throw e; }
  if (!demandes.length) return out;
  if (!cap.available) {
    // Contrat absent (bloc 31 non collé, branche retirée) ou coupure : attente DURABLE et supervisée, aucun appel ; la
    // demande est reprise automatiquement dès que le prompt actif porte de nouveau le contrat.
    for (const d of demandes) {
      await q(sql, `UPDATE economic_qualification_reviews SET status = 'CONTRACT_PENDING', reason = $2::text, validation = $3::text::jsonb, claimed_at = NULL, updated_at = now() WHERE id = $1`,
        [d.id, cap.reason, json({ contractState: cap.contractState ?? null })]);
      compter('CONTRACT_PENDING');
      out.processed++;
    }
    out.unavailable = cap.contractState ?? cap.reason;
    return out;
  }
  const now = opts.now ?? (() => new Date());
  const parJour = opts.dailyMax ?? m3.operationMatchCallsPerDay();
  const parPassage = opts.passMax ?? m3.operationMatchCallsPerPass();
  const { readAssetTco, AssetNotFoundForTcoError } = await import('../service');
  const { tcoLineKeys } = await import('../user-decisions');
  const cle = (l: Parameters<typeof tcoLineKeys>[0]) => tcoLineKeys(l).primary;

  for (const d of demandes) {
    // Budget : plafonds existants du rapprochement sémantique (par passage, par 24 h et par compte) — la demande reste en attente.
    if (out.aiCalls >= parPassage || (await callsLastDay(sql, accountId)) >= parJour) { compter('DEFERRED_BUDGET'); break; }
    if (!(await claim(sql, d.id))) { compter('CLAIMED_ELSEWHERE'); continue; }
    out.processed++;
    let tco: Awaited<ReturnType<typeof readAssetTco>>;
    try {
      tco = await readAssetTco(accountId, d.assetId, { today: opts.today });
    } catch (e) {
      if (e instanceof AssetNotFoundForTcoError) { await complete(sql, d.id, { status: 'OBSOLETE', reason: 'ASSET_GONE' }); compter('OBSOLETE'); continue; }
      throw e;
    }
    // Montants ENCORE à arbitrer (une décision de l'utilisateur, une réanalyse ou un autre examen a pu les qualifier).
    const silent = await targets.silentAmountSources(sql, accountId, d.assetId, new Set(tco.lines.map((l) => l.fileId).filter((x): x is number => x != null)));
    const cible = targets.qualificationTargets(tco, silent).find((t) => t.fileId === d.fileId);
    if (!cible) { await complete(sql, d.id, { status: 'OBSOLETE', reason: 'ALREADY_QUALIFIED' }); compter('OBSOLETE'); continue; }
    const versions = await targets.documentVersions(sql, accountId, [d.fileId]);
    const comptes = targets.countedFactsOf(tco, cle);
    const fp = targets.qualificationFingerprint({ fileId: d.fileId, docVersion: versions.get(d.fileId) ?? null, amounts: cible.amounts, counted: comptes });
    if (fp !== d.fingerprint) {
      // Contexte changé depuis la demande : mémoire de la nouvelle empreinte, sinon la demande la porte.
      const [deja] = await q(sql, `SELECT id FROM economic_qualification_reviews WHERE account_id = $1 AND file_id = $2 AND fingerprint = $3 AND id <> $4`, [accountId, d.fileId, fp, d.id]);
      if (deja) { await complete(sql, d.id, { status: 'OBSOLETE', reason: 'CONTEXT_ALREADY_EXAMINED' }); compter('OBSOLETE'); continue; }
    }
    const [asset] = await q(sql, `SELECT category FROM assets WHERE id = $1 AND account_id = $2`, [d.assetId, accountId]);
    const { loadQualificationContext } = await import('./context');
    const raw = await loadQualificationContext(sql, accountId, {
      assetId: d.assetId, assetCategory: (asset?.category as string | null) ?? null, fileId: d.fileId, tco, amounts: cible.amounts, today: opts.today ?? todayParis(now()),
    });
    if (!raw) { await complete(sql, d.id, { status: 'OBSOLETE', reason: 'DOCUMENT_GONE' }); compter('OBSOLETE'); continue; }
    const b = contract.buildQualificationInput(raw);
    const avant = snapshot(tco.lines, d.fileId);
    await opts.beforeCall?.('T3 arbitrage sémantique des montants non qualifiés du TCO — décision économique');
    out.aiCalls++;
    let answer: import('./decider').QualificationAnswer;
    try {
      answer = await decider.decide({ accountId, fileIds: Object.values(b.scope.documents), input: b.input });
    } catch (e) {
      const { isExecutionCancelled } = await import('@/services/ai/queue/execution-control');
      if (isExecutionCancelled(e)) throw e;
      // Échec technique (fournisseur indisponible, quota…) : attente technique, jamais une décision métier.
      const rapproche = d.attempts + 1 < QUALIFICATION_PARAMS.maxAttempts;
      await complete(sql, d.id, {
        status: rapproche ? 'AI_FAILED' : 'TECHNICAL_WAIT', reason: 'AI_CALL_FAILED', error: String((e as Error)?.message ?? e), called: true,
        promptVersion: cap.version, retryHours: rapproche ? QUALIFICATION_PARAMS.retryAfterHours : QUALIFICATION_PARAMS.technicalWaitHours, fingerprint: fp !== d.fingerprint ? fp : null,
        traceId: (e as { traceId?: string })?.traceId ?? null,
      });
      compter(rapproche ? 'AI_FAILED' : 'TECHNICAL_WAIT');
      continue;
    }
    const commun = {
      aiOutput: answer.output ?? null, promptVersion: answer.promptVersion ?? cap.version, model: answer.model ?? null, traceId: answer.traceId,
      costMicros: answer.costMicros ?? null, called: true, before: avant, fingerprint: fp !== d.fingerprint ? fp : null,
    };
    const v = contract.validateQualification(answer.output, b.scope);
    let statut: string;
    let decisions: QualificationEffect[];
    let raison: string;
    if (!v.ok) {
      // Toute sortie invalide vaut abstention : rien ne change dans le calcul, motif tracé ; arbitrage de l'utilisateur.
      statut = 'REJECTED';
      decisions = abstentions(cible.amounts.slice(0, Object.keys(b.scope.amounts).length), 'Réponse refusée par la validation du serveur.');
      raison = `INVALID_DECISION:${v.problems[0]?.issue ?? 'SCHEMA'}`;
    } else {
      decisions = v.effects;
      const appliquees = decisions.filter((e) => e.applied);
      statut = appliquees.length ? 'DECIDED' : decisions.every((e) => e.outcome === 'ABSTAIN') ? 'ABSTAINED' : 'NOT_CERTAIN';
      raison = decisions.map((e) => `${e.amountRef}:${e.outcome}${e.applied ? '' : '(non appliquée)'}`).join(' ').slice(0, 300);
    }
    await complete(sql, d.id, { ...commun, status: statut, decisions, reason: raison, validation: v.ok ? { valid: true } : { valid: false, problems: v.problems } });
    // L'examen précédent du même document pour ce bien reste en historique, remplacé (jamais effacé).
    await q(sql, `UPDATE economic_qualification_reviews SET status = 'SUPERSEDED', superseded_by = $1, updated_at = now()
                   WHERE account_id = $2 AND asset_id = $3 AND file_id = $4 AND id <> $1 AND status IN ('DECIDED', 'ABSTAINED', 'NOT_CERTAIN', 'REJECTED')`,
    [d.id, accountId, d.assetId, d.fileId]);
    // Effet sur le moteur : relu immédiatement (avant / après, preuve de l'influence sur le calcul).
    try {
      const apres = await readAssetTco(accountId, d.assetId, { today: opts.today });
      await complete(sql, d.id, { status: statut, after: snapshot(apres.lines, d.fileId) });
    } catch (e) {
      console.warn(`[t3-economic-qualification] relecture du TCO après décision (compte ${accountId}, bien ${d.assetId}) :`, (e as Error).message);
    }
    compter(statut);
    console.info(JSON.stringify({ event: 't3.economic_qualification', accountId, assetId: d.assetId, fileId: d.fileId, reviewId: d.id, status: statut, traceId: answer.traceId, trigger: d.trigger }));
  }
  return out;
}

/**
 * Lot 113AL — reprise ciblée et IDEMPOTENTE du stock historique d'un compte (lignes `NOT_QUALIFIED / THEME_UNKNOWN`
 * et sources `SOURCE_AMOUNT_NOT_EXPLOITED`) : demandes posées sans appel IA, une par document et empreinte jamais
 * examinée ; aucun re-T1, aucune remise à zéro. Le contrôle COH-TCO-EXTRACTED-EXPENSES fait la même chose bien par
 * bien ; ce point d'entrée sert au rattrapage du BO et aux tests.
 */
export async function requestAccountBackfill(accountId: number, opts: { sql?: Sql; today?: string; trigger?: QualificationTrigger } = {}): Promise<{ assets: number; requested: number }> {
  const [{ pgClient }, targets, { readAssetTco }, { tcoLineKeys }] = await Promise.all([import('@/db'), import('./targets'), import('../service'), import('../user-decisions')]);
  const sql = opts.sql ?? pgClient;
  const biens = await q(sql, `SELECT id FROM assets WHERE account_id = $1 AND deleted_at IS NULL ORDER BY id`, [accountId]);
  let requested = 0;
  for (const a of biens) {
    const assetId = Number(a.id);
    const tco = await readAssetTco(accountId, assetId, { today: opts.today });
    const silent = await targets.silentAmountSources(sql, accountId, assetId, new Set(tco.lines.map((l) => l.fileId).filter((x): x is number => x != null)));
    const cibles = targets.qualificationTargets(tco, silent);
    if (!cibles.length) continue;
    const versions = await targets.documentVersions(sql, accountId, cibles.map((c) => c.fileId));
    const comptes = targets.countedFactsOf(tco, (l) => tcoLineKeys(l).primary);
    requested += await requestQualificationReviews(sql, accountId, assetId, cibles.map((c) => ({
      fileId: c.fileId, amounts: c.amounts, fingerprint: targets.qualificationFingerprint({ fileId: c.fileId, docVersion: versions.get(c.fileId) ?? null, amounts: c.amounts, counted: comptes }),
    })), opts.trigger ?? 'BACKFILL');
  }
  return { assets: biens.length, requested };
}
