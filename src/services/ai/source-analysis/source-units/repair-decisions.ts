/**
 * Carte #854 (P1-02 de #835) — DÉCISIONS DE VALEUR DES RÉPARATIONS DIFFÉRÉES :
 * contrat figé par appel, validation sur les connaissances PERSISTÉES,
 * persistance des décisions ET des rejets, relecture EXACTE, reprise sûre.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLES REMPLACÉES (`persistRepairDecisions`, lots 114G / 115F)
 *
 *   A  contexte limité aux faits de la passe (`p.facts` + `factIdsByRef`) :
 *      une réponse « décision seule » sur un fait ANCIEN était rejetée ; les
 *      candidats n'étaient connus que par leur clé, et une erreur SQL de
 *      lecture devenait un ensemble vide (`catch(() => [])`) ;
 *   B  contrat relu à la persistance (`valueDecisionsCapability()`, config
 *      ACTIVE, cache 60 s) — jamais celui de l'appel qui a produit la
 *      décision ;
 *   C  écriture en échec comptée puis couverture poursuivie ; relecture =
 *      nombre GLOBAL de décisions VALID du document (les anciennes masquaient
 *      une nouvelle décision perdue) ; rejets jamais tracés durablement.
 *
 * ORCHESTRATION (une passe) :
 *   faits persistés (`appendRepairedFacts`) → MANIFESTE des réceptions
 *   (`PENDING`, journal 2012) → contrat de CHAQUE appel (`promptContract`
 *   figé par la passerelle) → contexte persisté (faits actifs, candidats
 *   actifs avec leurs preuves ; lecture exhaustive contrôlée, erreur ≠ vide)
 *   → résolution des références (fait de la réponse → fait PERSISTÉ exact ;
 *   ambigu / inconnu : rejet motivé) → validation → écriture transactionnelle
 *   sous verrou (références revalidées au commit, issues des réceptions dans
 *   la même transaction) → RELECTURE EXACTE par identités → couverture (les
 *   décisions non confirmées sont exclues, `stored-reconciliation`) → rapport.
 *
 * Reprise : un manifeste resté `PENDING` (crash), un incident réessayable ou
 * une écriture non confirmée est repris par la passe suivante SANS appel IA
 * (`recoverDecisionReceipts`), au plus `RECEIPT_RECOVERY_MAX` fois.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { T1Fact } from '../master/t1-contract';
import type { AnchoredValueDecision, FactContext, PreparedValueDecision } from '../value-decisions/validate';
import { decisionContractOfCall, valueDecisionsEnabled, type CallDecisionContract, type CallContractState } from '../value-decisions/contract';
import type { ReceiptOutcomeRow, ReceiptWriteState, StoredReceipt } from '../value-decisions/receipts';
import type { FactReferenceResolution } from './repair-identity';
import type { CoveredSourceUnit } from './types';
import type { RepairCallEnvelope, RepairReceivedDecision } from './repair';

type Row = Record<string, unknown>;
type Sql = { unsafe: (q: string, p?: never[]) => Promise<unknown> };
type RefFact = T1Fact & { t1FactRef?: string };

/** Bilan des décisions de valeur d'une passe de réparation différée (ou de sa reprise sans IA). */
export interface RepairDecisionsDiag {
  /** Décisions REÇUES brutes (avant tout filtrage) = valid + invalid + rejected + notEvaluated. */
  received: number;
  /** Réceptions acceptées VALID par le validateur. */
  valid: number;
  /** Réceptions rejetées par la validation (INVALID, motif). */
  invalid: number;
  /** Lignes NOUVELLEMENT écrites (compatibilité : « écrite(s) »). */
  persisted: number;
  /** Motifs de non-exploitation (rejets de validation `INVALID:<motif>`, rejets avant validation, incidents). */
  skipped: Record<string, number>;
  /** Version de prompt du premier appel qui a rendu des décisions (compatibilité lot 115F). */
  promptVersion?: string | null;
  /** Plusieurs versions de prompt dans la passe, ou version d'appel différente de celle de l'analyse d'origine. */
  contractVersionChanged?: boolean;
  /** Candidats ACTIFS du document fournis à la validation. */
  candidateKeys?: number;
  /** Métrique CONTEXTUELLE : décisions actives VALID du document après la passe (jamais une preuve de cette passe). */
  rereadActive?: number | null;
  // ── Carte #854 ────────────────────────────────────────────────────────
  passId?: string;
  /** NONE : aucune décision reçue ; CONFIRMED : toutes les réceptions ont une issue durable relue ; INCOMPLETE : sinon. */
  state?: 'NONE' | 'CONFIRMED' | 'INCOMPLETE';
  /** Une reprise sans IA est admissible (incident technique, écriture non confirmée). */
  retryable?: boolean;
  /** Reprise SANS IA d'une passe antérieure. */
  recovery?: boolean;
  /** Rejets AVANT validation (schéma, unité hors zone, contrat absent / incompatible). */
  rejected?: number;
  /** Non évaluées : incident technique (contexte, écriture, relecture, référence invalidée, journal). */
  notEvaluated?: number;
  /** Acceptées : déjà présentes à l'identique (aucune nouvelle ligne). */
  alreadyPresent?: number;
  /** Acceptées et écrites : nouvelles lignes. */
  newlyWritten?: number;
  /** Écritures relues identiques (par identité exacte). */
  confirmed?: number;
  missing?: number;
  divergent?: number;
  /** Écrites mais relecture impossible : ne justifient aucune couverture. */
  unconfirmed?: number;
  /** Réceptions de la passe présentes en base mais absentes du manifeste. */
  unexpected?: number;
  /** Ventilation par type de décision reçue. */
  byType?: Record<string, { received: number; valid: number; invalid: number; rejected: number; notEvaluated: number }>;
  /** Une entrée par appel de la passe (contrat consommé, identité, décisions brutes). */
  calls?: Array<{
    callIndex: number; callRef: string | null; contractState: CallContractState; contractVersion: string | null;
    promptVersion: string | null; promptFingerprint: string | null; configVersionId: number | null;
    received: number | null; failed: boolean; decisionsField: string | null; persistenceSuspended: boolean;
  }>;
  /** Journal des réceptions : écrit, indisponible (migration absente), en échec, issues non finalisées. */
  journal?: 'RECORDED' | 'UNAVAILABLE' | 'FAILED' | 'NOT_FINALIZED';
  /** Contexte persisté de validation (faits et candidats actifs) — `complete` : lecture exhaustive vérifiée. */
  context?: { facts: number; candidates: number | null; complete: boolean } | null;
  /** received = valid + invalid + rejected + notEvaluated. */
  balanced?: boolean;
}

/** Contrat d'une réception (copie figée du contrat de son appel). */
type ReceptionContract = Pick<CallDecisionContract, 'state' | 'contractVersion' | 'promptVersion' | 'promptFingerprint' | 'configVersionId' | 'persistenceSuspended'>;

/** Réception d'une décision (live ou relue du journal). */
interface Reception {
  key: string;
  callIndex: number;
  ordinal: number;
  callRef: string | null;
  contract: ReceptionContract;
  decision: AnchoredValueDecision;
  preRejected: string | null;
  refFacts: RefFact[];
  /** Empreinte de fait → faits persistés confirmés par l'écriture des faits de la passe. */
  refIds: Record<string, number[]>;
}

interface Issue { outcome: ReceiptOutcomeRow['outcome']; reason: string | null; retryable: boolean; fp: string | null; id: number | null; write: ReceiptWriteState; unit: string | null }

/** Panne simulée (recette PostgreSQL) — un « crash » traverse la passe comme un arrêt du processus. */
export class DecisionPassCrashSimulated extends Error {
  constructor(point: string) { super(`[recette #854] arrêt simulé : ${point}`); this.name = 'DecisionPassCrashSimulated'; }
}
type Failpoint = 'context' | 'resolve' | 'before_write' | 'crash_before_write' | 'during_write' | 'crash_after_commit' | 'reread' | 'crash_after_reread';
let failpoints = new Set<Failpoint>();
/** Réservé à la recette : pannes injectées dans la passe (aucun effet en production). */
export function __setDecisionFailpointsForTests(points: readonly Failpoint[] | null): void { failpoints = new Set(points ?? []); }
/** Réservé à la recette : actions concurrentes simulées (invalidation avant le commit, altération avant la relecture). */
let hooks: { beforeWrite?: () => Promise<void>; afterCommit?: () => Promise<void> } = {};
export function __setDecisionHooksForTests(h: typeof hooks | null): void { hooks = h ?? {}; }
const panne = (p: Failpoint) => {
  if (!failpoints.has(p)) return;
  if (p.startsWith('crash_')) throw new DecisionPassCrashSimulated(p);
  throw new Error(`[recette #854] panne simulée : ${p}`);
};

const MAX_PAYLOAD_TEXT = 400;
/** Décision bornée pour le journal (valeur, motif, extrait), sans rien de plus que la ligne de décision. */
function minimal(d: AnchoredValueDecision): AnchoredValueDecision {
  return {
    ...d, value: String(d.value ?? '').slice(0, 200), reason: String(d.reason ?? '').slice(0, MAX_PAYLOAD_TEXT),
    evidence: { ...(d.evidence ?? {}), ...(d.evidence?.excerpt ? { excerpt: String(d.evidence.excerpt).slice(0, MAX_PAYLOAD_TEXT) } : {}) },
  };
}

/** Une passe de réparation différée, telle que la décrit `retryDocument`. */
export interface RepairDecisionPassInput {
  accountId: number; fileId: number; extractionId: number | null; assetId: number | null;
  passId: string; passOrigin: string;
  received: readonly RepairReceivedDecision[];
  envelopes: readonly RepairCallEnvelope[];
  units: readonly CoveredSourceUnit[];
  /** Empreinte de fait → faits persistés (nouveaux ou déjà présents) — après le commit des faits. */
  factIdsByRef: ReadonlyMap<string, readonly number[]>;
}

const contratDe = (c: CallDecisionContract): ReceptionContract => ({
  state: c.state, contractVersion: c.contractVersion, promptVersion: c.promptVersion, promptFingerprint: c.promptFingerprint,
  configVersionId: c.configVersionId, persistenceSuspended: c.persistenceSuspended,
});

/**
 * Passe EN DIRECT : manifeste, puis évaluation. Ne lève jamais, sauf arrêt
 * simulé (recette) : tout incident est une issue explicite et réessayable.
 */
export async function persistRepairDecisions(p: RepairDecisionPassInput): Promise<RepairDecisionsDiag> {
  const { receiptKeyOf } = await import('../value-decisions/receipts');
  const enveloppe = new Map(p.envelopes.map((e) => [e.callIndex, e]));
  const receptions: Reception[] = p.received.map((r) => {
    const env = enveloppe.get(r.callIndex);
    // Réception sans enveloppe d'appel : contrat NON prouvé (jamais celui du prompt actif).
    const contract = env ? env.contract : decisionContractOfCall(null);
    const refIds: Record<string, number[]> = {};
    for (const ref of r.decision.relatedFactRefs) {
      const ids = p.factIdsByRef.get(ref);
      if (ids?.length) refIds[ref] = [...ids];
    }
    return {
      key: receiptKeyOf(p.passId, r.callIndex, r.ordinal), callIndex: r.callIndex, ordinal: r.ordinal, callRef: env?.callRef ?? null,
      contract: contratDe(contract), decision: r.decision, preRejected: r.preRejected, refFacts: r.refFacts, refIds,
    };
  });
  const diag = baseDiag(p.passId, receptions, p.envelopes, false);
  if (receptions.length === 0) return finish(diag);
  // ── Manifeste AVANT toute validation : chaque réception a une trace durable, même rejetée. ──
  const { pgClient } = await import('@/db');
  const sql = pgClient as unknown as Sql;
  const receipts = await import('../value-decisions/receipts');
  let journal: NonNullable<RepairDecisionsDiag['journal']> = 'RECORDED';
  if (!(await receipts.receiptsTableReady(sql))) journal = 'UNAVAILABLE';
  else {
    try {
      await receipts.writeReceiptManifest(sql, { accountId: p.accountId, fileId: p.fileId, extractionId: p.extractionId, passId: p.passId, passOrigin: p.passOrigin },
        receptions.map((r) => ({
          receiptKey: r.key, callIndex: r.callIndex, callRef: r.callRef, ordinal: r.ordinal, contractState: r.contract.state,
          contractVersion: r.contract.contractVersion, promptVersion: r.contract.promptVersion, promptFingerprint: r.contract.promptFingerprint,
          configVersionId: r.contract.configVersionId, decisionType: r.decision.decision ?? null, sourceUnitId: r.decision.sourceUnitId ?? null,
          payload: {
            decision: minimal(r.decision), preRejected: r.preRejected, refFacts: r.refFacts.slice(0, 10), refIds: r.refIds,
            persistenceSuspended: r.contract.persistenceSuspended,
          },
        })));
    } catch (e) {
      journal = 'FAILED';
      console.error(`[t1-completeness-retry] manifeste des décisions du fichier ${p.fileId} non écrit :`, (e as Error).message);
    }
  }
  diag.journal = journal;
  return evaluate({ accountId: p.accountId, fileId: p.fileId, extractionId: p.extractionId, assetId: p.assetId, passId: p.passId, units: p.units }, receptions, diag, false);
}

function baseDiag(passId: string, receptions: readonly Reception[], envelopes: readonly RepairCallEnvelope[], recovery: boolean): RepairDecisionsDiag {
  const parAppel = new Map<number, Reception[]>();
  for (const r of receptions) parAppel.set(r.callIndex, [...(parAppel.get(r.callIndex) ?? []), r]);
  const calls: NonNullable<RepairDecisionsDiag['calls']> = envelopes.length > 0
    ? envelopes.map((e) => ({
      callIndex: e.callIndex, callRef: e.callRef, contractState: e.contract.state, contractVersion: e.contract.contractVersion,
      promptVersion: e.contract.promptVersion, promptFingerprint: e.contract.promptFingerprint, configVersionId: e.contract.configVersionId,
      received: e.rawDecisions, failed: e.failed, decisionsField: e.decisionsField, persistenceSuspended: e.contract.persistenceSuspended,
    }))
    : [...parAppel.entries()].map(([callIndex, l]) => ({
      callIndex, callRef: l[0].callRef, contractState: l[0].contract.state, contractVersion: l[0].contract.contractVersion,
      promptVersion: l[0].contract.promptVersion, promptFingerprint: l[0].contract.promptFingerprint, configVersionId: l[0].contract.configVersionId,
      received: l.length, failed: false, decisionsField: null, persistenceSuspended: l[0].contract.persistenceSuspended,
    }));
  // Versions des appels qui ont réellement rendu des décisions (une par réception, jamais devinée).
  const versions = [...new Set(receptions.map((r) => r.contract.promptVersion))];
  return {
    received: receptions.length, valid: 0, invalid: 0, persisted: 0, skipped: {}, passId, recovery,
    promptVersion: versions[0] ?? null, contractVersionChanged: versions.length > 1,
    rejected: 0, notEvaluated: 0, alreadyPresent: 0, newlyWritten: 0, confirmed: 0, missing: 0, divergent: 0, unconfirmed: 0, unexpected: 0,
    byType: {}, calls, context: null,
  };
}

function finish(diag: RepairDecisionsDiag): RepairDecisionsDiag {
  diag.balanced = diag.received === diag.valid + diag.invalid + (diag.rejected ?? 0) + (diag.notEvaluated ?? 0);
  const incomplet = (diag.notEvaluated ?? 0) + (diag.missing ?? 0) + (diag.divergent ?? 0) + (diag.unconfirmed ?? 0) > 0
    || diag.journal === 'NOT_FINALIZED' || diag.journal === 'FAILED' || diag.journal === 'UNAVAILABLE' || !diag.balanced;
  diag.state = diag.received === 0 ? 'NONE' : incomplet ? 'INCOMPLETE' : 'CONFIRMED';
  return diag;
}

/** Contexte PERSISTÉ de validation : faits actifs et candidats actifs du document, avec leurs preuves. */
interface DecisionContext {
  facts: Map<string, FactContext>;
  factIds: Set<number>;
  candidateKeys: Set<string>;
  candidateFacts: Map<string, string[]>;
  candidatesAvailable: boolean;
  complete: boolean;
}

/**
 * Lecture EXHAUSTIVE (contrôlée par le total de la même lecture) ; une erreur
 * SQL LÈVE (jamais un ensemble vide) ; table des candidats absente : contexte
 * sans candidat, dit (`candidatesAvailable`).
 */
async function loadDecisionContext(sql: Sql, accountId: number, fileId: number): Promise<DecisionContext> {
  panne('context');
  const [{ valueFormsOf }, { unitOfCell }, { candidateReconciliationValue }] = await Promise.all([
    import('../value-decisions/validate'), import('./build-units'), import('./coverage-reconciliation'),
  ]);
  const faits = (await sql.unsafe(
    `SELECT f.id::float8 AS id, f.excerpt, f.value_text, f.normalized_value, to_jsonb(f)->>'raw_value' AS raw_value,
            f.value_number::float8 AS value_number, f.label, f.fact_key, f.canonical_key, to_jsonb(f)->>'raw_key' AS raw_key,
            to_jsonb(f)->'source_unit_ids' AS source_unit_ids, count(*) OVER ()::int AS total
       FROM document_facts f WHERE f.account_id = $1 AND f.file_id = $2 AND f.status = 'active' ORDER BY f.id`,
    [accountId, fileId] as never[],
  )) as Row[];
  const out: DecisionContext = { facts: new Map(), factIds: new Set(), candidateKeys: new Set(), candidateFacts: new Map(), candidatesAvailable: false, complete: true };
  if (faits.length > 0 && Number(faits[0].total) !== faits.length) out.complete = false;
  for (const f of faits) {
    const id = Number(f.id);
    out.factIds.add(id);
    const forms = new Set<string>();
    for (const v of [f.value_text, f.normalized_value, f.raw_value, f.value_number == null ? null : Number(f.value_number)]) for (const x of valueFormsOf(v)) forms.add(x);
    const ids = Array.isArray(f.source_unit_ids) ? (f.source_unit_ids as unknown[]).map((x) => unitOfCell(String(x))) : [];
    out.facts.set(`db:${id}`, {
      forms, text: [f.label, f.raw_key ?? f.canonical_key ?? f.fact_key, f.excerpt].filter((x): x is string => typeof x === 'string' && x !== '').join(' — '),
      unitIds: [...new Set(ids)],
    });
  }
  const [t] = (await sql.unsafe(`SELECT to_regclass('document_operation_candidates') IS NOT NULL AS ok`)) as Array<{ ok: boolean }>;
  if (t?.ok) {
    out.candidatesAvailable = true;
    const cands = (await sql.unsafe(
      `SELECT candidate_key, payload, count(*) OVER ()::int AS total FROM document_operation_candidates
        WHERE account_id = $1 AND file_id = $2 AND status = 'ACTIVE' ORDER BY id`,
      [accountId, fileId] as never[],
    )) as Row[];
    if (cands.length > 0 && Number(cands[0].total) !== cands.length) out.complete = false;
    for (const c of cands) {
      const key = String(c.candidate_key);
      const payload = (typeof c.payload === 'string' ? JSON.parse(c.payload) : c.payload) as Record<string, unknown> | null;
      const v = candidateReconciliationValue(key, payload);
      const forms = new Set<string>();
      for (const x of v.values) for (const y of valueFormsOf(x)) forms.add(y);
      const ev = Array.isArray(payload?.evidence) ? payload!.evidence as Array<{ excerpt?: unknown }> : payload?.evidence ? [payload.evidence as { excerpt?: unknown }] : [];
      out.candidateKeys.add(key);
      out.facts.set(`cand:${key}`, {
        forms, unitIds: (v.unitIds ?? []).map(unitOfCell),
        text: [key, ...ev.map((e) => (typeof e?.excerpt === 'string' ? e.excerpt : null))].filter((x): x is string => !!x).join(' — '),
      });
      out.candidateFacts.set(key, [`cand:${key}`]);
    }
  }
  return out;
}

interface EvalBase { accountId: number; fileId: number; extractionId: number | null; assetId: number | null; passId: string; units: readonly CoveredSourceUnit[] }

/** Évaluation, écriture et relecture exacte d'un ensemble de réceptions (live ou reprise). */
async function evaluate(b: EvalBase, receptions: readonly Reception[], diag: RepairDecisionsDiag, recovery: boolean): Promise<RepairDecisionsDiag> {
  const { pgClient } = await import('@/db');
  const sql = pgClient as unknown as Sql;
  const issues = new Map<string, Issue>();
  const poser = (r: Reception, i: Partial<Issue> & Pick<Issue, 'outcome'>) => issues.set(r.key, {
    reason: null, retryable: false, fp: null, id: null, write: 'NOT_APPLICABLE', unit: r.decision.sourceUnitId ?? null, ...i,
  });
  const evaluables: Reception[] = [];
  for (const r of receptions) {
    if (r.preRejected) poser(r, { outcome: 'REJECTED', reason: r.preRejected });
    else if (r.contract.state !== 'CARRIED') poser(r, { outcome: 'REJECTED', reason: `CONTRACT_${r.contract.state}` });
    else if (r.contract.persistenceSuspended) poser(r, { outcome: 'NOT_EVALUATED', reason: 'PERSISTENCE_SUSPENDED' });
    else if (diag.journal !== 'RECORDED') poser(r, { outcome: 'NOT_EVALUATED', reason: 'JOURNAL_UNAVAILABLE', retryable: diag.journal === 'FAILED' });
    else evaluables.push(r);
  }
  const lignes = new Map<string, PreparedValueDecision>();
  /** Réception → empreinte de décision attendue (doublons de la passe compris). */
  const attendus = new Map<string, { fp: string; line: PreparedValueDecision; promptVersion: string | null }>();
  let ecrit = false;
  if (evaluables.length > 0) {
    const [{ validateValueDecisions, decisionFingerprint }, store] = await Promise.all([
      import('../value-decisions/validate'), import('../value-decisions/store'),
    ]);
    const technique = (reason: string, retryable = true) => { for (const r of evaluables) poser(r, { outcome: 'NOT_EVALUATED', reason, retryable }); };
    let ctx: DecisionContext | null = null;
    if (!(await store.valueDecisionsTableReady())) technique('TABLE_MISSING', false);
    else {
      try {
        ctx = await loadDecisionContext(sql, b.accountId, b.fileId);
        diag.context = { facts: ctx.factIds.size, candidates: ctx.candidatesAvailable ? ctx.candidateKeys.size : null, complete: ctx.complete };
        diag.candidateKeys = ctx.candidateKeys.size;
        if (!ctx.complete) { technique('CONTEXT_INCOMPLETE'); ctx = null; }
      } catch (e) {
        if (e instanceof DecisionPassCrashSimulated) throw e;
        console.error(`[t1-completeness-retry] contexte des décisions du fichier ${b.fileId} illisible :`, (e as Error).message);
        technique('CONTEXT_UNAVAILABLE');
        ctx = null;
      }
    }
    // ── Références : fait de la réponse → fait PERSISTÉ (confirmé par l'écriture des faits, sinon identité exacte). ──
    let resolutions: Map<string, FactReferenceResolution> | null = null;
    if (ctx) {
      try {
        panne('resolve');
        const aResoudre = new Map<string, RefFact>();
        for (const r of evaluables) for (const f of r.refFacts) if (f.t1FactRef && !r.refIds[f.t1FactRef]) aResoudre.set(f.t1FactRef, f);
        const { resolvePersistedFactRefs } = await import('./jobs');
        resolutions = aResoudre.size > 0
          ? await resolvePersistedFactRefs({ accountId: b.accountId, fileId: b.fileId, assetId: b.assetId, facts: [...aResoudre.values()] })
          : new Map();
      } catch (e) {
        if (e instanceof DecisionPassCrashSimulated) throw e;
        console.error(`[t1-completeness-retry] références des décisions du fichier ${b.fileId} non résolues :`, (e as Error).message);
        technique('CONTEXT_UNAVAILABLE');
        ctx = null;
      }
    }
    if (ctx && resolutions) {
      const ambigus = new Set<number>();
      const ancrees = evaluables.map((r, i) => {
        const refs: string[] = [];
        for (const ref of r.decision.relatedFactRefs) {
          const ids = (r.refIds[ref] ?? []).filter((id) => ctx!.factIds.has(id));
          if (ids.length > 0) { refs.push(...ids.map((id) => `db:${id}`)); continue; }
          const res = resolutions!.get(ref) ?? null;
          if (res && 'id' in res && ctx!.factIds.has(res.id)) refs.push(`db:${res.id}`);
          else if (res && 'ambiguous' in res) ambigus.add(i);
          else refs.push(`unknown:${ref}`);
        }
        return { ...r.decision, relatedFactRefs: [...new Set(refs)] };
      });
      const doublons: PreparedValueDecision[] = [];
      const preparees = validateValueDecisions(ancrees, {
        units: b.units, keptFactRefs: new Set([...ctx.factIds].map((id) => `db:${id}`)), candidateKeys: ctx.candidateKeys,
        facts: ctx.facts, candidateFacts: ctx.candidateFacts,
      }, { duplicates: doublons });
      for (const pr of [...preparees, ...doublons]) {
        if (pr.inputIndex !== undefined && ambigus.has(pr.inputIndex)) { pr.validity = 'INVALID'; pr.invalidReason = 'LINK_AMBIGUOUS'; }
      }
      // Une ligne principale par réception (la première unité retenue) ; doublons exacts : même empreinte attendue.
      const factIds = new Map<string, number[]>([...ctx.factIds].map((id) => [`db:${id}`, [id]]));
      const parReception = new Map<number, PreparedValueDecision>();
      for (const pr of preparees) if (pr.inputIndex !== undefined && !parReception.has(pr.inputIndex)) parReception.set(pr.inputIndex, pr);
      for (const pr of doublons) if (pr.inputIndex !== undefined && !parReception.has(pr.inputIndex)) parReception.set(pr.inputIndex, pr);
      evaluables.forEach((r, i) => {
        const pr = parReception.get(i);
        if (!pr) { poser(r, { outcome: 'NOT_EVALUATED', reason: 'NO_VALIDATION_RESULT', retryable: true }); return; }
        const fp = decisionFingerprint(b.fileId, pr);
        attendus.set(r.key, { fp, line: pr, promptVersion: r.contract.promptVersion });
        lignes.set(fp, pr);
      });
      // ── Écriture : verrou par document, références revalidées AU COMMIT, issues dans la même transaction. ──
      try {
        panne('before_write');
        panne('crash_before_write');
        if (hooks.beforeWrite) await hooks.beforeWrite();
        await pgClient.begin(async (tx) => {
          const t = tx as unknown as Sql;
          await t.unsafe(`SELECT pg_advisory_xact_lock(hashtext('t1-value-decisions:' || $1::text))`, [b.fileId] as never[]);
          const idsCites = [...new Set([...attendus.values()].flatMap((a) => a.line.relatedFactRefs).filter((x) => x.startsWith('db:')).map((x) => Number(x.slice(3))))];
          const actifs = idsCites.length === 0 ? new Set<number>() : new Set(((await t.unsafe(
            `SELECT id::float8 AS id FROM document_facts WHERE id = ANY($1::bigint[]) AND account_id = $2 AND file_id = $3 AND status = 'active' FOR SHARE`,
            [idsCites, b.accountId, b.fileId] as never[],
          )) as Array<{ id: number }>).map((x) => Number(x.id)));
          const clesCitees = [...new Set([...attendus.values()].flatMap((a) => a.line.relatedCandidateKeys))];
          const clesActives = clesCitees.length === 0 || !ctx!.candidatesAvailable ? new Set<string>() : new Set(((await t.unsafe(
            `SELECT candidate_key FROM document_operation_candidates WHERE account_id = $1 AND file_id = $2 AND status = 'ACTIVE' AND candidate_key = ANY($3::text[])`,
            [b.accountId, b.fileId, clesCitees] as never[],
          )) as Row[]).map((x) => String(x.candidate_key)));
          const invalidee = (pr: PreparedValueDecision) => pr.validity === 'VALID' && (
            pr.relatedFactRefs.some((x) => x.startsWith('db:') && !actifs.has(Number(x.slice(3))))
            || pr.relatedCandidateKeys.some((k) => !clesActives.has(k)));
          // Lignes par appel : la version de prompt et la trace enregistrées sont celles de l'appel qui les a produites.
          const parAppel = new Map<number, { pv: string | null; ref: string | null; lignes: Map<string, PreparedValueDecision> }>();
          for (const r of evaluables) {
            const a = attendus.get(r.key);
            if (!a) continue;
            if (invalidee(a.line)) { poser(r, { outcome: 'NOT_EVALUATED', reason: 'REFERENCE_INVALIDATED', retryable: true }); attendus.delete(r.key); continue; }
            const g = parAppel.get(r.callIndex) ?? { pv: r.contract.promptVersion, ref: r.callRef, lignes: new Map() };
            g.lignes.set(a.fp, a.line);
            parAppel.set(r.callIndex, g);
          }
          const ecrites = new Map<string, { id: number; inserted: boolean }>();
          for (const g of parAppel.values()) {
            const lot = [...g.lignes.values()];
            const res = await store.insertValueDecisionsDetailed(t as never, {
              accountId: b.accountId, fileId: b.fileId, extractionId: b.extractionId, analysisRunId: null, promptVersion: g.pv,
              aiTraceId: g.ref, factIds,
            }, lot);
            for (const [fp, x] of res.rows) if (!ecrites.has(fp)) ecrites.set(fp, x);
          }
          const vues = new Set<string>();
          for (const r of evaluables) {
            const a = attendus.get(r.key);
            if (!a) continue;
            const w = ecrites.get(a.fp);
            // Même décision canonique reçue plusieurs fois : UNE ligne nouvelle, les autres réceptions s'y rattachent.
            poser(r, {
              outcome: a.line.validity === 'VALID' ? 'VALID' : 'INVALID', reason: a.line.invalidReason, fp: a.fp, id: w?.id ?? null,
              write: w ? (w.inserted && !vues.has(a.fp) ? 'NEW' : 'ALREADY_PRESENT') : 'MISSING', unit: a.line.sourceUnitId,
            });
            vues.add(a.fp);
          }
          panne('during_write');
          const { finalizeReceipts } = await import('../value-decisions/receipts');
          await finalizeReceipts(t, b.accountId, b.fileId, receptions.map((r) => issueRow(r.key, issues.get(r.key)!)));
        });
        ecrit = true;
        // Acceptées : nouvelles lignes ≠ lignes déjà présentes (avant relecture).
        for (const i of issues.values()) {
          if (i.write === 'NEW') diag.newlyWritten!++;
          else if (i.write === 'ALREADY_PRESENT') diag.alreadyPresent!++;
        }
      } catch (e) {
        if (e instanceof DecisionPassCrashSimulated) throw e;
        console.error(`[t1-completeness-retry] décisions de valeur du fichier ${b.fileId} non écrites (annulées) :`, (e as Error).message);
        attendus.clear();
        technique('WRITE_FAILED');
      }
    }
  }
  // Incidents et rejets sans transaction d'écriture : issues finalisées seules (trace durable, best effort).
  if (!ecrit && diag.journal === 'RECORDED') {
    try {
      const { finalizeReceipts } = await import('../value-decisions/receipts');
      await finalizeReceipts(sql, b.accountId, b.fileId, receptions.map((r) => issueRow(r.key, issues.get(r.key)!)));
    } catch (e) {
      diag.journal = 'NOT_FINALIZED';
      console.error(`[t1-completeness-retry] issues des décisions du fichier ${b.fileId} non consignées :`, (e as Error).message);
    }
  }
  panne('crash_after_commit');
  if (ecrit && hooks.afterCommit) await hooks.afterCommit();
  // ── Relecture EXACTE (identités de CETTE passe), jamais un compte global. ──
  if (ecrit && attendus.size > 0) await reread(sql, b, receptions, issues, attendus, diag, recovery);
  // Compteurs (par réception) et motifs.
  for (const r of receptions) {
    const i = issues.get(r.key)!;
    const t = r.decision.decision ?? 'UNKNOWN';
    const bt = (diag.byType![t] ??= { received: 0, valid: 0, invalid: 0, rejected: 0, notEvaluated: 0 });
    bt.received++;
    if (i.outcome === 'VALID') { diag.valid++; bt.valid++; } else if (i.outcome === 'INVALID') { diag.invalid++; bt.invalid++; }
    else if (i.outcome === 'REJECTED') { diag.rejected!++; bt.rejected++; } else { diag.notEvaluated!++; bt.notEvaluated++; }
    if (i.outcome !== 'VALID') {
      const motif = i.outcome === 'INVALID' ? `INVALID:${i.reason ?? 'UNKNOWN'}` : i.reason ?? i.outcome;
      diag.skipped[motif] = (diag.skipped[motif] ?? 0) + 1;
    }
    if (i.outcome === 'NOT_EVALUATED' && i.retryable) diag.retryable = true;
  }
  diag.persisted = diag.newlyWritten!;
  if ((diag.unconfirmed ?? 0) + (diag.missing ?? 0) + (diag.divergent ?? 0) > 0) diag.retryable = true;
  // Métrique CONTEXTUELLE distincte (jamais la preuve de cette passe).
  try {
    const { loadActiveValueDecisions } = await import('../value-decisions/store');
    diag.rereadActive = (await loadActiveValueDecisions(sql as never, b.accountId, [b.fileId])).filter((d) => d.validity === 'VALID').length;
  } catch {
    diag.rereadActive = null;
  }
  return finish(diag);
}

const issueRow = (key: string, i: Issue): ReceiptOutcomeRow => ({
  receiptKey: key, outcome: i.outcome, reason: i.reason ?? (i.outcome === 'VALID' || i.outcome === 'PENDING' ? null : i.outcome),
  retryable: i.retryable, decisionFp: i.fp, decisionId: i.id, writeState: i.write, sourceUnitId: i.unit,
});

/** Relecture exacte : chaque ligne attendue relue par identifiant, comparée champ par champ ; réceptions de la passe comparées au manifeste. */
async function reread(
  sql: Sql, b: EvalBase, receptions: readonly Reception[], issues: Map<string, Issue>,
  attendus: Map<string, { fp: string; line: PreparedValueDecision; promptVersion: string | null }>, diag: RepairDecisionsDiag, recovery: boolean,
): Promise<void> {
  const receipts = await import('../value-decisions/receipts');
  const ecrites = receptions.filter((r) => attendus.has(r.key) && issues.get(r.key)?.id != null);
  const nonRelues = receptions.filter((r) => attendus.has(r.key) && issues.get(r.key)?.id == null);
  for (const r of nonRelues) { issues.get(r.key)!.write = 'MISSING'; diag.missing!++; }
  try {
    panne('reread');
    const ids = [...new Set(ecrites.map((r) => issues.get(r.key)!.id!))];
    const lignes = new Map(((await sql.unsafe(
      `SELECT id::float8 AS id, decision_fp AS fp, status, source_unit_id AS unit, value_kind AS kind, normalized_value AS norm, decision, validity,
              invalid_reason AS invalid, coalesce(related_fact_ids, '{}')::float8[] AS facts, related_candidate_keys AS keys, prompt_version AS pv
         FROM document_value_decisions WHERE id = ANY($1::bigint[]) AND account_id = $2 AND file_id = $3`,
      [ids, b.accountId, b.fileId] as never[],
    )) as Row[]).map((x) => [Number(x.id), x]));
    const manifeste = await receipts.loadPassReceipts(sql, b.accountId, b.fileId, b.passId);
    const parCle = new Map(manifeste.map((m) => [m.receiptKey, m]));
    if (!recovery) {
      const connues = new Set(receptions.map((r) => r.key));
      diag.unexpected = manifeste.filter((m) => !connues.has(m.receiptKey)).length;
    }
    const tri = (l: unknown) => (Array.isArray(l) ? l.map(Number) : []).sort((x, y) => x - y).join(',');
    for (const r of ecrites) {
      const i = issues.get(r.key)!;
      const a = attendus.get(r.key)!;
      const l = lignes.get(i.id!);
      const m = parCle.get(r.key);
      if (!l) { i.write = 'MISSING'; diag.missing!++; continue; }
      const attenduIds = tri(a.line.relatedFactRefs.filter((x) => x.startsWith('db:')).map((x) => Number(x.slice(3))));
      const conforme = String(l.fp) === a.fp && l.status === 'ACTIVE' && l.unit === a.line.sourceUnitId && l.kind === a.line.kind
        && l.norm === a.line.normalizedValue && l.decision === a.line.decision && l.validity === a.line.validity
        && (l.invalid ?? null) === (a.line.invalidReason ?? null) && tri(l.facts) === attenduIds
        && [...((l.keys as string[] | null) ?? [])].sort().join('|') === [...a.line.relatedCandidateKeys].sort().join('|')
        && (i.write !== 'NEW' || String(l.pv ?? '') === String(a.promptVersion ?? ''))
        && !!m && m.outcome === i.outcome && m.decisionFp === a.fp;
      if (conforme) { i.write = 'CONFIRMED'; diag.confirmed!++; } else { i.write = 'DIVERGENT'; diag.divergent!++; }
    }
    await receipts.finalizeReceipts(sql, b.accountId, b.fileId, ecrites.concat(nonRelues).map((r) => issueRow(r.key, issues.get(r.key)!)));
    panne('crash_after_reread');
  } catch (e) {
    if (e instanceof DecisionPassCrashSimulated) throw e;
    console.warn(`[t1-completeness-retry] relecture des décisions du fichier ${b.fileId} impossible :`, (e as Error).message);
    for (const r of ecrites) {
      const i = issues.get(r.key)!;
      if (i.write === 'CONFIRMED') diag.confirmed!--;
      else if (i.write === 'DIVERGENT') diag.divergent!--;
      else if (i.write === 'MISSING') diag.missing!--;
      i.write = 'UNCONFIRMED';
      diag.unconfirmed!++;
    }
    try {
      await receipts.finalizeReceipts(sql, b.accountId, b.fileId, ecrites.map((r) => issueRow(r.key, issues.get(r.key)!)));
    } catch { /* l'état durable reste NEW / ALREADY_PRESENT : repris à la passe suivante */ }
  }
}

/**
 * Reprise SANS IA des réceptions d'un document (manifeste `PENDING` après un
 * arrêt, incident réessayable, écriture non confirmée) : réévaluées sur le
 * contexte persisté ACTUEL avec le contrat FIGÉ de leur appel, écrites sans
 * doublon, relues. Au-delà de `RECEIPT_RECOVERY_MAX` reprises : état final
 * `RECOVERY_EXHAUSTED`, jamais de boucle. `null` : rien à reprendre.
 */
export async function recoverDecisionReceipts(p: {
  accountId: number; fileId: number; extractionId: number | null; assetId: number | null;
}): Promise<RepairDecisionsDiag | null> {
  const { pgClient } = await import('@/db');
  const sql = pgClient as unknown as Sql;
  const receipts = await import('../value-decisions/receipts');
  if (!(await receipts.receiptsTableReady(sql))) return null;
  const aReprendre = await receipts.loadRecoverableReceipts(sql, p.accountId, p.fileId);
  if (aReprendre.length === 0) return null;
  const pris = await receipts.claimRecovery(sql, p.accountId, p.fileId, aReprendre.map((r) => r.receiptKey));
  const epuisees = aReprendre.filter((r) => !pris.has(r.receiptKey));
  if (epuisees.length > 0) {
    await receipts.finalizeReceipts(sql, p.accountId, p.fileId, epuisees.map((r) => ({
      receiptKey: r.receiptKey, outcome: 'NOT_EVALUATED', reason: 'RECOVERY_EXHAUSTED', retryable: false,
      decisionFp: r.decisionFp, decisionId: r.decisionId, writeState: r.writeState === 'PENDING' ? 'NOT_APPLICABLE' : r.writeState,
    })));
  }
  const retenues = aReprendre.filter((r) => pris.has(r.receiptKey));
  const total: RepairDecisionsDiag = {
    received: 0, valid: 0, invalid: 0, persisted: 0, skipped: {}, recovery: true, rejected: 0, notEvaluated: 0, alreadyPresent: 0,
    newlyWritten: 0, confirmed: 0, missing: 0, divergent: 0, unconfirmed: 0, unexpected: 0, byType: {}, calls: [], journal: 'RECORDED',
  };
  if (epuisees.length > 0) total.skipped.RECOVERY_EXHAUSTED = epuisees.length;
  if (retenues.length === 0) return finishRecovery(total, epuisees.length);
  const [{ loadAllDocumentSourceUnits }, { toCovered }] = await Promise.all([import('./repository'), import('./jobs')]);
  const units = (await loadAllDocumentSourceUnits(p.fileId, { accountId: p.accountId })).map(toCovered);
  const parPasse = new Map<string, StoredReceipt[]>();
  for (const r of retenues) parPasse.set(r.passId, [...(parPasse.get(r.passId) ?? []), r]);
  for (const [passId, lot] of parPasse) {
    const receptions: Reception[] = lot.map((r) => {
      const pl = r.payload as { decision?: AnchoredValueDecision; preRejected?: string | null; refFacts?: RefFact[]; refIds?: Record<string, number[]>; persistenceSuspended?: boolean };
      return {
        key: r.receiptKey, callIndex: r.callIndex, ordinal: r.ordinal, callRef: r.callRef,
        // Contrat FIGÉ de l'appel, relu du journal — jamais celui du prompt actif.
        contract: {
          state: r.contractState as CallContractState, contractVersion: r.contractVersion, promptVersion: r.promptVersion,
          promptFingerprint: r.promptFingerprint, configVersionId: r.configVersionId,
          persistenceSuspended: !valueDecisionsEnabled(),
        },
        decision: pl.decision ?? { value: '', kind: null, normalizedValue: null, decision: null, reason: '', sourceUnitId: null, evidence: {}, relatedFactRefs: [], relatedCandidateKeys: [], confidence: null, origin: 'REVIEW', schemaInvalid: true },
        preRejected: pl.preRejected ?? null, refFacts: pl.refFacts ?? [], refIds: pl.refIds ?? {},
      };
    });
    const d = baseDiag(passId, receptions, [], true);
    d.journal = 'RECORDED';
    const r = await evaluate({ ...p, passId, units }, receptions, d, true);
    for (const k of ['received', 'valid', 'invalid', 'persisted', 'rejected', 'notEvaluated', 'alreadyPresent', 'newlyWritten', 'confirmed', 'missing', 'divergent', 'unconfirmed'] as const) {
      (total[k] as number) = ((total[k] as number) ?? 0) + ((r[k] as number) ?? 0);
    }
    for (const [m, n] of Object.entries(r.skipped)) total.skipped[m] = (total.skipped[m] ?? 0) + n;
    total.calls!.push(...(r.calls ?? []));
    if (r.retryable) total.retryable = true;
    total.rereadActive = r.rereadActive;
    total.context = r.context;
    total.passId = passId;
  }
  return finishRecovery(total, epuisees.length);
}

function finishRecovery(d: RepairDecisionsDiag, epuisees: number): RepairDecisionsDiag {
  d.received += epuisees;
  d.notEvaluated = (d.notEvaluated ?? 0) + epuisees;
  return finish(d);
}
