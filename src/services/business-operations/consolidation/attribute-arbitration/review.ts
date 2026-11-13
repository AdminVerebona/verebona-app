/**
 * Lot 114 (Trello #750, issue B) — ARBITRAGE T3 par l'IA d'une contradiction
 * RÉELLE d'attribut d'un événement de référence : mémoire, demandes, et PHASE
 * du passage T3 du compte (file durable de consolidation). Même forme que le
 * réexamen des périodes (lot 113AD, `relation-review.ts`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   lecture  `loadAttributeReviews` — arbitrages et examens de l'événement,
 *            relus par la consolidation (`reconsolidateOperation`) AVANT la
 *            qualification : valeur retenue (RESOLVED certain), faits
 *            distincts, indécidable, document étranger, examen attendu ;
 *   demande  `requestAttributeReviews` — posée par la consolidation, SANS
 *            appel IA, seulement si le prompt T3 effectif porte la branche ET
 *            le marqueur : une ligne PENDING par constat jamais examiné. La
 *            carte « À traiter » est alors DIFFÉRÉE (au plus
 *            `ATTRIBUTE_ARBITRATION_MAX_WAIT_HOURS`) ;
 *   phase    `runAttributeArbitrationPhase` — passage T3 du compte (hors
 *            verrou, jamais à la consultation) : capacité → ligne encore
 *            présente ? → budget (plafonds EXISTANTS du rapprochement
 *            sémantique) → appel T3 → VALIDATION stricte (toute sortie
 *            invalide = abstention) → mémoire → reconsolidation de
 *            l'événement (valeur retenue écrite sous les protections,
 *            carte posée ou fermée) → valeur avant / après tracée.
 * Un constat déjà examiné n'est JAMAIS renvoyé à l'IA (une ligne par
 * empreinte et par compte). La décision de l'utilisateur prime toujours.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  attributeChoiceKey, attributeSubjectKey, type AttributeChoice, type AttributeReview, type ConflictField, type QualifiedAttributeConflict,
} from '../attribute-conflicts';
import { ATTRIBUTE_ARBITRATION_CONTRACT_VERSION } from './contract';

type Row = Record<string, unknown>;
/** Transaction de consolidation ou client global (Drizzle). */
interface Exec { execute(q: SQL): Promise<unknown> }
const rows = async <T = Row>(x: Exec, q: SQL): Promise<T[]> => (await x.execute(q)) as unknown as T[];

/** Délai pendant lequel la carte « À traiter » attend l'arbitrage T3 demandé (heures). Paramètre centralisé, à valider par le PO. */
export const ATTRIBUTE_ARBITRATION_MAX_WAIT_HOURS = 24;
const RETRY_AFTER_HOURS = 6;
export const ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS = 3;
const REQUESTS_PER_PASS = 20;

const COLONNE: Record<ConflictField, string> = {
  plannedDate: 'planned_date', startDate: 'start_date', realizedDate: 'realized_date', endDate: 'end_date', provider: 'provider',
};
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const intArray = (v: readonly number[]): string => `{${v.filter((x) => Number.isSafeInteger(x)).join(',')}}`;

/** Empreinte STABLE d'un constat : événement, attribut, rôle, valeurs normalisées (triées). */
export function arbitrationFingerprint(operationId: number, field: string, role: string, normalized: readonly string[]): string {
  const cle = `${operationId}|${field}|${role}|${[...new Set(normalized)].sort().join('\u0001')}`;
  return createHash('sha256').update(cle).digest('hex').slice(0, 40);
}

const lineFingerprint = (operationId: number, c: Pick<QualifiedAttributeConflict, 'field' | 'role' | 'values'>) =>
  arbitrationFingerprint(operationId, c.field, c.role, c.values.map((v) => v.normalized));

let tablePrete: boolean | null = null;
/** La table 1690 existe-t-elle ? (sonde sans erreur : jamais une transaction de consolidation annulée) */
async function arbitrationTableReady(x: Exec): Promise<boolean> {
  if (tablePrete) return true;
  const [r] = await rows<{ ok: boolean }>(x, sql`SELECT to_regclass('business_operation_attribute_arbitrations') IS NOT NULL AS ok`);
  tablePrete = !!r?.ok;
  return tablePrete;
}
/** Réservé aux tests. */
export function __resetArbitrationTableProbeForTests(): void { tablePrete = null; }

export interface LoadedAttributeReviews {
  /** Valeurs retenues par T3 (RESOLVED certain), à appliquer sous les protections. */
  choices: AttributeChoice[];
  /** Dernier examen par sujet (attribut, rôle) qui n'a pas retenu de valeur. */
  reviews: Map<string, AttributeReview>;
  /** Empreintes déjà demandées ou examinées (jamais redemandées). */
  fingerprints: Set<string>;
  ready: boolean;
}

/** Arbitrages et examens T3 de l'événement (table absente : aucun — la contradiction réelle va à la carte). */
export async function loadAttributeReviews(x: Exec, accountId: number, operationId: number): Promise<LoadedAttributeReviews> {
  const out: LoadedAttributeReviews = { choices: [], reviews: new Map(), fingerprints: new Set(), ready: false };
  if (!(await arbitrationTableReady(x))) return out;
  out.ready = true;
  const r = await rows(x, sql`
    SELECT id, field, role, fingerprint, presented_values, status, outcome, retained_normalized, confidence, attempts,
           (requested_at > now() - make_interval(hours => ${ATTRIBUTE_ARBITRATION_MAX_WAIT_HOURS})) AS fresh
      FROM business_operation_attribute_arbitrations
     WHERE account_id = ${accountId} AND operation_id = ${operationId} AND status NOT IN ('OBSOLETE', 'UNAVAILABLE')
     ORDER BY id`);
  for (const l of r) {
    out.fingerprints.add(String(l.fingerprint));
    const field = String(l.field) as ConflictField;
    const role = String(l.role);
    const known = (Array.isArray(l.presented_values) ? l.presented_values as Array<{ normalized?: unknown }> : [])
      .map((v) => v?.normalized).filter((v): v is string => typeof v === 'string');
    const cle = attributeChoiceKey(field, role);
    const reviewId = Number(l.id);
    const status = String(l.status);
    const certain = status === 'DECIDED' && l.confidence === 'certain';
    // Le constat le plus récent d'un sujet remplace le précédent (valeurs différentes : autre empreinte).
    out.choices = out.choices.filter((c) => attributeChoiceKey(c.field, c.role) !== cle);
    out.reviews.delete(cle);
    if (certain && l.outcome === 'RESOLVED' && typeof l.retained_normalized === 'string') {
      out.choices.push({ field, role, normalized: l.retained_normalized, known, by: 'T3', reviewId });
    } else if (certain && (l.outcome === 'DISTINCT_FACTS' || l.outcome === 'UNDECIDABLE' || l.outcome === 'LINK_ERROR')) {
      out.reviews.set(cle, { field, role, known, reviewId, outcome: l.outcome === 'DISTINCT_FACTS' ? 'LEGITIMATE_DIFFERENCE' : l.outcome });
    } else if ((status === 'PENDING' || (status === 'AI_FAILED' && Number(l.attempts ?? 0) < ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS)) && l.fresh === true) {
      out.reviews.set(cle, { field, role, known, reviewId, outcome: 'PENDING' });
    } else {
      out.reviews.set(cle, { field, role, known, reviewId, outcome: status === 'AI_FAILED' || status === 'PENDING' ? 'FAILED' : 'ABSTAINED' });
    }
  }
  return out;
}

/**
 * La ligne relève-t-elle de l'arbitrage T3 ? Contradiction du même attribut et du même rôle, non
 * tranchée, sans valeur protégée par l'utilisateur (celle-là va directement à la carte), avec au
 * moins deux valeurs réellement différentes.
 */
export function eligibleForArbitration(c: QualifiedAttributeConflict): boolean {
  const reelle = c.qualification === 'REAL_CONFLICT_UNRESOLVED' && c.reasonCode !== 'USER_VALUE_NOT_RETAINED';
  const identiteNonEtablie = c.qualification === 'INSUFFICIENT_EVIDENCE' && c.reasonCode === 'FACT_IDENTITY_NOT_ESTABLISHED';
  return (reelle || identiteNonEtablie) && c.role !== 'MIXED' && c.protection !== 'USER'
    && new Set(c.values.map((v) => v.normalized)).size >= 2;
}

/**
 * Demandes d'arbitrage des constats JAMAIS examinés (aucun appel IA), si le prompt T3 effectif porte
 * la branche. Rend les sujets (attribut, rôle) dont l'examen vient d'être demandé.
 */
export async function requestAttributeReviews(
  x: Exec, accountId: number, operationId: number, open: readonly QualifiedAttributeConflict[], loaded: LoadedAttributeReviews,
  fileOfSource: ReadonlyMap<number, number> = new Map(),
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!loaded.ready) return out;
  const candidates = open.filter((c) => eligibleForArbitration(c) && !loaded.fingerprints.has(lineFingerprint(operationId, c)));
  if (!candidates.length) return out;
  const { arbitrationDecider } = await import('./decider');
  const cap = await arbitrationDecider().capability();
  if (!cap.available) return out;
  for (const c of candidates) {
    const presentees = c.values.map((v) => ({
      value: v.value, normalized: v.normalized, sourceIds: v.sourceIds,
      fileIds: [...new Set(v.sourceIds.map((id) => fileOfSource.get(id)).filter((f): f is number => f !== undefined))],
      userProtected: v.sources.some((s) => s.role === 'USER_ENTRY' || s.authority === 'USER'),
    }));
    const fichiers = [...new Set(presentees.flatMap((v) => v.fileIds))].sort((a, b) => a - b);
    // Sans document à citer, T3 n'a aucune preuve à examiner : la ligne suit son cours.
    if (!fichiers.length) continue;
    const r = await rows(x, sql`
      INSERT INTO business_operation_attribute_arbitrations (account_id, operation_id, field, role, fingerprint, presented_values, file_ids, status, contract_version)
      VALUES (${accountId}, ${operationId}, ${c.field}, ${c.role}, ${lineFingerprint(operationId, c)}, ${JSON.stringify(presentees)}::jsonb,
              ${intArray(fichiers)}::int[], 'PENDING', ${ATTRIBUTE_ARBITRATION_CONTRACT_VERSION})
      ON CONFLICT (account_id, fingerprint) DO UPDATE
         SET status = 'PENDING', presented_values = EXCLUDED.presented_values, file_ids = EXCLUDED.file_ids,
             requested_at = now(), updated_at = now(), attempts = 0, retry_at = NULL, error = NULL
       WHERE business_operation_attribute_arbitrations.status IN ('OBSOLETE', 'UNAVAILABLE')
      RETURNING id`);
    if (r.length) out.add(attributeSubjectKey(c));
  }
  return out;
}

/** Prédicat SQL « le compte a une demande d'arbitrage à traiter » (balayage horaire du passage T3). */
export const ATTRIBUTE_ARBITRATION_PENDING_SQL = (alias: string) => `
  (${alias}.status = 'PENDING' OR (${alias}.status = 'AI_FAILED' AND ${alias}.retry_at <= now() AND ${alias}.attempts < ${ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS}))`;

interface Presented { value: string; normalized: string; sourceIds: number[]; fileIds: number[]; userProtected: boolean }
interface Pending { id: number; operationId: number; field: ConflictField; role: string; fingerprint: string; values: Presented[]; attempts: number }

async function pendingRequests(x: Exec, accountId: number, limit: number): Promise<Pending[]> {
  const r = await rows(x, sql`
    SELECT r.id, r.operation_id, r.field, r.role, r.fingerprint, r.presented_values, r.attempts
      FROM business_operation_attribute_arbitrations r
     WHERE r.account_id = ${accountId} AND ${sql.raw(ATTRIBUTE_ARBITRATION_PENDING_SQL('r'))} ORDER BY r.id LIMIT ${limit}`);
  return r.map((l) => ({
    id: Number(l.id), operationId: Number(l.operation_id), field: String(l.field) as ConflictField, role: String(l.role),
    fingerprint: String(l.fingerprint), values: (Array.isArray(l.presented_values) ? l.presented_values : []) as Presented[], attempts: Number(l.attempts ?? 0),
  }));
}

async function callsLastDay(x: Exec, accountId: number): Promise<number> {
  const [r] = await rows<{ n: number }>(x, sql`
    SELECT COALESCE(sum(ai_calls), 0)::int AS n FROM business_operation_attribute_arbitrations
     WHERE account_id = ${accountId} AND last_call_at > now() - interval '24 hours'`);
  return Number(r?.n ?? 0);
}

async function complete(x: Exec, id: number, r: {
  status: string; outcome?: string | null; retainedValue?: string | null; retainedNormalized?: string | null; foreignFileId?: number | null;
  confidence?: string | null; evidence?: unknown; reason?: string | null; aiOutput?: unknown; validation?: Record<string, unknown>;
  deciderVersion?: string | null; traceId?: string | null; called?: boolean; error?: string | null; retry?: boolean;
}): Promise<void> {
  const appele = r.called === true;
  await x.execute(sql`
    UPDATE business_operation_attribute_arbitrations
       SET status = ${r.status}, outcome = COALESCE(${r.outcome ?? null}, outcome),
           retained_value = ${r.retainedValue ?? null}, retained_normalized = ${r.retainedNormalized ?? null}, foreign_file_id = ${r.foreignFileId ?? null},
           confidence = COALESCE(${r.confidence ?? null}, confidence), evidence = COALESCE(${json(r.evidence)}::jsonb, evidence),
           reason = COALESCE(${r.reason ? r.reason.slice(0, 300) : null}, reason), ai_output = COALESCE(${json(r.aiOutput)}::jsonb, ai_output),
           validation = COALESCE(${json(r.validation)}::jsonb, validation), decider_version = COALESCE(${r.deciderVersion ?? null}, decider_version),
           ai_trace_id = COALESCE(${r.traceId ?? null}, ai_trace_id),
           ai_calls = ai_calls + ${appele ? 1 : 0}, attempts = attempts + ${appele ? 1 : 0},
           last_call_at = CASE WHEN ${appele} THEN now() ELSE last_call_at END, error = ${r.error ? r.error.slice(0, 500) : null},
           retry_at = CASE WHEN ${r.retry === true} THEN now() + make_interval(hours => ${RETRY_AFTER_HOURS}) ELSE NULL END,
           decided_at = CASE WHEN ${r.status} IN ('PENDING', 'AI_FAILED') THEN decided_at ELSE now() END, updated_at = now()
     WHERE id = ${id}`);
}

/** La ligne existe-t-elle encore sur l'événement (mêmes valeurs, toujours une contradiction active) ? */
async function currentLine(x: Exec, accountId: number, d: Pending): Promise<{ line: QualifiedAttributeConflict; type: string | null; label: string | null; current: string | null } | null> {
  const [o] = await rows(x, sql`
    SELECT type_code, technical_label, ${sql.raw(COLONNE[d.field])}::text AS courant, to_jsonb(o)->'attribute_provenance'->'conflicts' AS conflicts
      FROM business_operations o
     WHERE o.id = ${d.operationId} AND o.account_id = ${accountId} AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`);
  if (!o) return null;
  const lignes = (Array.isArray(o.conflicts) ? o.conflicts : []) as QualifiedAttributeConflict[];
  const line = lignes.find((c) => c && c.field === d.field && c.role === d.role && Array.isArray(c.values)
    && lineFingerprint(d.operationId, c) === d.fingerprint && eligibleForArbitration(c));
  return line ? { line, type: (o.type_code as string | null) ?? null, label: (o.technical_label as string | null) ?? null, current: (o.courant as string | null) ?? null } : null;
}

const valueOf = async (x: Exec, accountId: number, operationId: number, field: ConflictField): Promise<string | null> => {
  const [o] = await rows(x, sql`SELECT ${sql.raw(COLONNE[field])}::text AS v FROM business_operations WHERE id = ${operationId} AND account_id = ${accountId}`);
  return (o?.v as string | null) ?? null;
};

export interface AttributeArbitrationPhaseResult {
  processed: number;
  aiCalls: number;
  /** Événements de référence reconsolidés (valeur appliquée, carte posée ou fermée). */
  operations: number[];
  outcomes: Record<string, number>;
  /** Valeurs réellement écrites sur un événement de référence. */
  applied: number;
  /** Capacité absente (bloc 38 non collé, coupure) : aucune demande traitée par l'IA. */
  unavailable?: string;
}

const todayParis = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);

/**
 * Phase du passage T3 du compte (file de consolidation) : traite les demandes d'arbitrage en attente,
 * par lot borné. Ne lève que l'annulation coopérative ; tout autre échec est tracé sur la demande.
 */
export async function runAttributeArbitrationPhase(accountId: number, opts: {
  now?: () => Date; beforeCall?: (what: string) => Promise<void> | void;
  decider?: import('./decider').ArbitrationDecider; dailyMax?: number; passMax?: number; limit?: number;
} = {}): Promise<AttributeArbitrationPhaseResult> {
  const out: AttributeArbitrationPhaseResult = { processed: 0, aiCalls: 0, operations: [], outcomes: {}, applied: 0 };
  const [{ db, pgClient }, deciderMod, contract, m3] = await Promise.all([
    import('@/db'), import('./decider'), import('./contract'), import('../m3'),
  ]);
  const x: Exec = db;
  if (!(await arbitrationTableReady(x))) return out;
  const demandes = await pendingRequests(x, accountId, opts.limit ?? REQUESTS_PER_PASS);
  if (!demandes.length) return out;
  const now = opts.now ?? (() => new Date());
  const decider = opts.decider ?? deciderMod.arbitrationDecider();
  const parJour = opts.dailyMax ?? m3.operationMatchCallsPerDay();
  const parPassage = opts.passMax ?? m3.operationMatchCallsPerPass();
  const compter = (s: string) => { out.outcomes[s] = (out.outcomes[s] ?? 0) + 1; };
  const touchees = new Set<number>();
  /** Arbitrages RESOLVED de ce passage : valeur avant, à comparer après la reconsolidation. */
  const resolus: Array<{ id: number; operationId: number; field: ConflictField; before: string | null; value: string }> = [];

  const cap = await decider.capability();
  if (!cap.available) {
    // Branche retirée (ou coupure) : demandes closes « indisponibles » — la contradiction réelle va à la carte.
    for (const d of demandes) {
      await complete(x, d.id, { status: 'UNAVAILABLE', reason: cap.reason, validation: { contractState: cap.contractState ?? null } });
      touchees.add(d.operationId);
      compter('UNAVAILABLE');
      out.processed++;
    }
    out.unavailable = cap.contractState ?? cap.reason;
  } else {
    const { loadDocuments } = await import('../../semantic/load');
    for (const d of demandes) {
      const etat = await currentLine(x, accountId, d);
      if (!etat) {
        await complete(x, d.id, { status: 'OBSOLETE', reason: 'LINE_GONE' });
        touchees.add(d.operationId);
        compter('OBSOLETE');
        out.processed++;
        continue;
      }
      // Budget : plafonds existants du rapprochement sémantique — la demande reste en attente.
      if (out.aiCalls >= parPassage || (await callsLastDay(x, accountId)) >= parJour) { compter('DEFERRED_BUDGET'); break; }
      const fichiers = [...new Set(d.values.flatMap((v) => v.fileIds))];
      const docs = await loadDocuments(pgClient, accountId, fichiers);
      const b = contract.buildArbitrationInput({
        today: todayParis(now()), field: d.field, role: d.role, operation: { typeCode: etat.type, label: etat.label },
        values: d.values.map((v) => ({ value: v.value, normalized: v.normalized, fileIds: v.fileIds, held: etat.current !== null && v.value === etat.current, userProtected: v.userProtected })),
        documents: docs.map((doc) => ({ id: doc.id, type: doc.type, title: doc.title, date: doc.date, provider: doc.provider, references: doc.references, excerpts: doc.excerpts })),
      });
      await opts.beforeCall?.('T3 arbitrage d’une contradiction d’attribut — décision sémantique');
      out.aiCalls++;
      out.processed++;
      touchees.add(d.operationId);
      let answer: { output: unknown; traceId: string | null };
      try {
        answer = await decider.decide({ accountId, fileIds: Object.values(b.scope.documents).filter((f): f is number => f !== undefined), input: b.input });
      } catch (e) {
        const { isExecutionCancelled } = await import('@/services/ai/queue/execution-control');
        if (isExecutionCancelled(e)) throw e;
        // Panne IA : distincte de l'absence de preuve — nouvel essai borné, aucune modification spéculative.
        await complete(x, d.id, {
          status: 'AI_FAILED', reason: 'AI_CALL_FAILED', error: String((e as Error)?.message ?? e), deciderVersion: cap.version, called: true,
          retry: d.attempts + 1 < ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS,
        });
        compter('AI_FAILED');
        continue;
      }
      const commun = { aiOutput: answer.output ?? null, deciderVersion: cap.version, traceId: answer.traceId, called: true };
      const v = contract.validateArbitration(answer.output, b.scope);
      if (!v.ok) {
        await complete(x, d.id, { ...commun, status: 'REJECTED', reason: `INVALID_DECISION:${v.problems[0]?.issue ?? 'SCHEMA'}`, validation: { valid: false, problems: v.problems } });
        compter('REJECTED');
        continue;
      }
      const dec = v.decision;
      const evidence = dec.evidence.map((e) => ({ document: e.document, fileId: b.scope.documents[e.document] ?? null, excerpt: e.excerpt }));
      const base = { ...commun, outcome: dec.outcome, confidence: dec.confidence, reason: dec.reason, evidence, validation: { valid: true, ignored: v.ignored } };
      if (v.ignored === 'ABSTAIN') {
        await complete(x, d.id, { ...base, status: 'ABSTAINED' });
        compter('ABSTAINED');
      } else if (v.ignored === 'NOT_CERTAIN' || !v.effect) {
        await complete(x, d.id, { ...base, status: 'NOT_CERTAIN' });
        compter('NOT_CERTAIN');
      } else if (v.effect.outcome === 'RESOLVED') {
        await complete(x, d.id, { ...base, status: 'DECIDED', retainedValue: v.effect.value, retainedNormalized: v.effect.normalized });
        resolus.push({ id: d.id, operationId: d.operationId, field: d.field, before: etat.current, value: v.effect.value });
        compter('DECIDED_RESOLVED');
      } else {
        await complete(x, d.id, { ...base, status: 'DECIDED', foreignFileId: v.effect.outcome === 'LINK_ERROR' ? v.effect.foreignFileId : null });
        compter(`DECIDED_${v.effect.outcome}`);
      }
      console.info(JSON.stringify({ event: 't3.attribute_arbitration', accountId, operationId: d.operationId, reviewId: d.id, outcome: dec.outcome, confidence: dec.confidence }));
    }
  }
  // Reconsolidation : valeur retenue écrite sous les protections, carte « À traiter » posée ou fermée.
  out.operations = [...touchees].sort((a, b) => a - b);
  if (out.operations.length) {
    const { reconsolidateOperations } = await import('../consolidator');
    await reconsolidateOperations(accountId, out.operations, { correlationId: 't3-attribute-arbitration' });
    for (const r of resolus) {
      const apres = await valueOf(x, accountId, r.operationId, r.field);
      const appliquee = apres === r.value;
      if (appliquee && apres !== r.before) out.applied++;
      await x.execute(sql`
        UPDATE business_operation_attribute_arbitrations
           SET value_before = ${r.before}, value_after = ${apres}, applied_at = CASE WHEN ${appliquee} THEN now() ELSE NULL END,
               validation = validation || ${JSON.stringify({ applied: appliquee, ...(appliquee ? {} : { notApplied: 'PROTECTED_OR_UNMANAGED_VALUE' }) })}::jsonb,
               updated_at = now()
         WHERE id = ${r.id}`);
    }
  }
  return out;
}
