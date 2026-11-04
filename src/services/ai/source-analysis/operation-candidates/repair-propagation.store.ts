/**
 * Lot 109K (COR-02) — écriture de la propagation d'une réparation T1 vers les
 * candidats du document et T3 (règles pures : `repair-propagation.ts`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   faits ACTIFS avant / après ──► diff + incidences métier
 *        │ aucune incidence nouvelle → NO_BUSINESS_IMPACT (aucune lecture des candidats)
 *        ▼
 *   UNE transaction, candidats ACTIFS du document verrouillés (FOR UPDATE) :
 *     · plafond de fréquence (`T1_REPAIR_PROPAGATION_MAX_PER_WINDOW` versions
 *       par document sur `T1_REPAIR_PROPAGATION_WINDOW_HOURS`) → RATE_LIMITED ;
 *     · réévaluation ciblée → état inchangé : UNCHANGED (aucune écriture) ;
 *     · état déjà signalé (même empreinte) : DUPLICATE_STATE ;
 *     · sinon SUPERSESSION ATOMIQUE : l'ancienne version passe SUPERSEDED
 *       (rouverte pour T3 si elle était consolidée, comme une réanalyse), la
 *       nouvelle (même clé, même extraction, trace de T3 conservée) est ACTIVE
 *       et en attente de T3 ; journal `document_candidate_repair_propagations`.
 *   APRÈS commit : demande T3 dédoublonnée par compte (`onDocumentAnalyzedForOperations`),
 *   statut consigné ; résumé posé sur la couverture (BO › Complétude T1).
 *
 * Ne lève jamais vers la réparation : un échec est journalisé et rendu (les
 * faits réparés restent écrits ; T3 les rattrapera au prochain passage).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { cachedSchemaProbe } from '../../telemetry/trace-schema';
import {
  attributeFacts, diffRepairFacts, reevaluateCandidate, reevaluatedPayload,
  type PersistedFactRow, type RepairEnrichmentKind, type StoredCandidateRow,
} from './repair-propagation';

type Row = Record<string, unknown>;
type Tx = { unsafe: (q: string, p?: never[]) => Promise<unknown> };

const probe = cachedSchemaProbe(async () => {
  const { pgClient } = await import('@/db');
  const r = (await pgClient.unsafe(`SELECT to_regclass('document_candidate_repair_propagations') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
  return { ready: r[0]?.ok === true, missing: r[0]?.ok === true ? [] : ['document_candidate_repair_propagations'] };
}, {
  scope: '[t1-repair-propagation]', migration: '1145', expected: ['document_candidate_repair_propagations'],
  consequence: 'Les réparations T1 ne réévaluent pas les candidats (comportement antérieur au lot 109K) ; les faits réparés restent écrits.',
});

export function repairPropagationSettings(env: Record<string, string | undefined> = process.env) {
  const n = (v: string | undefined, d: number, min: number, max: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= min ? Math.min(max, Math.trunc(x)) : d;
  };
  return {
    maxPerWindow: n(env.T1_REPAIR_PROPAGATION_MAX_PER_WINDOW, 3, 1, 50),
    windowHours: n(env.T1_REPAIR_PROPAGATION_WINDOW_HOURS, 24, 1, 24 * 30),
    enabled: env.T1_REPAIR_PROPAGATION_ENABLED !== 'false',
  };
}

export type PropagationDecision = 'NO_NEW_FACT' | 'NO_BUSINESS_IMPACT' | 'NO_CANDIDATE' | 'UNCHANGED' | 'DUPLICATE_STATE' | 'RATE_LIMITED' | 'SUPERSEDED';

export interface RepairPropagationOutcome {
  decision: PropagationDecision | 'DISABLED' | 'ERROR';
  reason: string;
  newFactIds: number[];
  categories: RepairEnrichmentKind[];
  candidates: Array<{ candidateKey: string; decision: PropagationDecision; previousId: number; newId: number | null; changes: string[] }>;
  t3: { status: 'NONE' | 'REQUESTED' | 'NOT_REQUESTED'; jobId: number | null };
}

const FACT_COLUMNS = `id::float8 AS id, fact_key, canonical_key, raw_key, label, attribute, value_text, value_number::float8 AS value_number, value_unit,
  raw_value, value_type, excerpt, (location ->> 'page') AS page, evidence_origin, confidence, target_type, target_entity_id, target_entity_label,
  semantic_event_type, semantic_event_nature, source_unit_ids`;

function factOf(r: Row): PersistedFactRow {
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    id: Number(r.id), factKey: s(r.fact_key), canonicalKey: s(r.canonical_key), rawKey: s(r.raw_key), label: s(r.label), attribute: s(r.attribute),
    valueText: s(r.value_text), valueNumber: r.value_number == null ? null : Number(r.value_number), valueUnit: s(r.value_unit), rawValue: s(r.raw_value),
    valueType: s(r.value_type), excerpt: s(r.excerpt), page: r.page == null ? null : Number(r.page) || null, evidenceOrigin: s(r.evidence_origin),
    confidence: s(r.confidence), targetType: s(r.target_type), targetEntityId: r.target_entity_id == null ? null : Number(r.target_entity_id),
    targetEntityLabel: s(r.target_entity_label), semanticEventType: s(r.semantic_event_type), semanticEventNature: s(r.semantic_event_nature),
    sourceUnitIds: Array.isArray(r.source_unit_ids) ? (r.source_unit_ids as unknown[]).map(String) : [],
  };
}

/**
 * Faits ACTIFS d'un document (ou leur seule liste d'identifiants) — à relever
 * AVANT une réparation pour le diff. Colonnes canoniques absentes (0218) :
 * lecture en `to_jsonb` sans erreur.
 */
export async function activeFactIds(fileId: number, accountId: number): Promise<number[]> {
  const { pgClient } = await import('@/db');
  return ((await pgClient.unsafe(`SELECT id::float8 AS id FROM document_facts WHERE file_id = $1 AND account_id = $2 AND status = 'active'`,
    [fileId, accountId] as never[])) as unknown as Row[]).map((r) => Number(r.id));
}

async function loadFacts(fileId: number, accountId: number): Promise<PersistedFactRow[]> {
  const { pgClient } = await import('@/db');
  const { documentFactsCanonicalReady } = await import('../../evidence/canonical-columns');
  const cols = (await documentFactsCanonicalReady())
    ? FACT_COLUMNS
    : FACT_COLUMNS.replace(/canonical_key|raw_key|raw_value|value_type|target_type|target_entity_id|target_entity_label|semantic_event_type|semantic_event_nature|source_unit_ids/g, (c) => `NULL AS ${c}`);
  return ((await pgClient.unsafe(`SELECT ${cols} FROM document_facts WHERE file_id = $1 AND account_id = $2 AND status = 'active' ORDER BY id`,
    [fileId, accountId] as never[])) as unknown as Row[]).map(factOf);
}

/** Cibles nouvelles VÉRIFIÉES en base pour le compte (monde fermé, U9). */
async function verifiedTargets(tx: Tx, accountId: number, facts: readonly PersistedFactRow[]) {
  const ids = (t: string) => [...new Set(facts.filter((f) => f.targetType === t && f.targetEntityId !== null).map((f) => f.targetEntityId as number))];
  const lire = async (sql: string, l: number[]) => (l.length ? ((await tx.unsafe(sql, [accountId, l] as never[])) as Row[]).map((r) => Number(r.id)) : []);
  return {
    ASSET: new Set(await lire(`SELECT id FROM assets WHERE account_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL`, ids('ASSET'))),
    EQUIPMENT: new Set(await lire(`SELECT e.id FROM equipments e JOIN assets a ON a.id = e.asset_id WHERE a.account_id = $1 AND e.id = ANY($2::int[]) AND a.deleted_at IS NULL`, ids('EQUIPMENT'))),
    ROOM: new Set(await lire(`SELECT r.id FROM rooms r JOIN assets a ON a.id = r.asset_id WHERE a.account_id = $1 AND r.id = ANY($2::int[]) AND a.deleted_at IS NULL`, ids('ROOM'))),
  };
}

async function journal(tx: Tx, p: {
  accountId: number; fileId: number; origin: string; decision: PropagationDecision; reason: string; candidateKey?: string | null;
  previousId?: number | null; newId?: number | null; fingerprint?: string | null; factIds: number[]; categories: string[]; changes?: string[];
}): Promise<void> {
  await tx.unsafe(
    `INSERT INTO document_candidate_repair_propagations
       (account_id, file_id, origin, decision, reason, candidate_key, previous_candidate_id, candidate_id, state_fingerprint, new_fact_ids, categories, changes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint[], $11::text[], $12::text[])
     ON CONFLICT DO NOTHING`,
    [p.accountId, p.fileId, p.origin.slice(0, 60), p.decision, p.reason.slice(0, 300), p.candidateKey ?? null, p.previousId ?? null, p.newId ?? null,
      p.fingerprint ?? null, p.factIds, p.categories, (p.changes ?? []).slice(0, 40)] as never[],
  );
}

/**
 * Propage une réparation T1 (voir l'en-tête). `beforeFactIds` : faits actifs
 * relevés AVANT la réparation. Idempotente : rejouée sans fait nouveau, ou sur
 * un état déjà signalé, elle n'écrit aucune version et ne réveille pas T3.
 */
export async function propagateRepairToCandidates(p: {
  accountId: number; fileId: number; beforeFactIds: readonly number[]; origin: string; env?: Record<string, string | undefined>;
}): Promise<RepairPropagationOutcome> {
  const vide = (decision: RepairPropagationOutcome['decision'], reason: string, extra: Partial<RepairPropagationOutcome> = {}): RepairPropagationOutcome => ({
    decision, reason, newFactIds: [], categories: [], candidates: [], t3: { status: 'NONE', jobId: null }, ...extra,
  });
  const s = repairPropagationSettings(p.env);
  if (!s.enabled) return vide('DISABLED', 'T1_REPAIR_PROPAGATION_ENABLED=false');
  if (!(await probe())) return vide('DISABLED', 'migration 1145 absente');
  try {
    const { pgClient } = await import('@/db');
    const tous = await loadFacts(p.fileId, p.accountId);
    const avant = new Set(p.beforeFactIds);
    const diff = diffRepairFacts(tous.filter((f) => avant.has(f.id)), tous);
    const newFactIds = diff.added.map((a) => a.fact.id);
    if (newFactIds.length === 0) return vide('NO_NEW_FACT', 'aucun fait nouveau');
    const base = { accountId: p.accountId, fileId: p.fileId, origin: p.origin, factIds: newFactIds, categories: diff.categories as string[] };
    if (diff.significant.length === 0) {
      await journal(pgClient as unknown as Tx, { ...base, decision: 'NO_BUSINESS_IMPACT', reason: 'faits nouveaux sans incidence métier nouvelle (texte, valeurs déjà connues)' });
      return vide('NO_BUSINESS_IMPACT', 'faits nouveaux sans incidence métier nouvelle', { newFactIds });
    }

    const out: RepairPropagationOutcome = vide('UNCHANGED', '', { newFactIds, categories: diff.categories });
    await pgClient.begin(async (t) => {
      const tx = t as unknown as Tx;
      const cands = ((await tx.unsafe(
        `SELECT id::float8 AS id, candidate_key, established, confidence, type_hint, status_hint, summary, payload
           FROM document_operation_candidates WHERE file_id = $1 AND account_id = $2 AND status = 'ACTIVE' ORDER BY id FOR UPDATE`,
        [p.fileId, p.accountId] as never[],
      )) as Row[]).map((r): StoredCandidateRow => ({
        id: Number(r.id), candidateKey: String(r.candidate_key), established: r.established === true,
        confidence: r.confidence as StoredCandidateRow['confidence'], typeHint: (r.type_hint ?? null) as StoredCandidateRow['typeHint'],
        statusHint: (r.status_hint ?? null) as StoredCandidateRow['statusHint'], summary: String(r.summary ?? ''),
        payload: (r.payload ?? {}) as Record<string, unknown>,
      }));
      if (!cands.some((c) => c.established)) {
        out.decision = 'NO_CANDIDATE';
        out.reason = 'aucun candidat établi actif : T1 ne crée jamais d’événement de référence';
        await journal(tx, { ...base, decision: 'NO_CANDIDATE', reason: out.reason });
        return;
      }
      const [recent] = (await tx.unsafe(
        `SELECT count(*)::int AS n FROM document_candidate_repair_propagations
          WHERE file_id = $1 AND decision = 'SUPERSEDED' AND created_at > now() - make_interval(hours => $2)`,
        [p.fileId, s.windowHours] as never[],
      )) as Row[];
      if (Number(recent?.n ?? 0) >= s.maxPerWindow) {
        out.decision = 'RATE_LIMITED';
        out.reason = `plafond de ${s.maxPerWindow} version(s) par ${s.windowHours} h atteint : faits conservés, T3 les lira au prochain passage`;
        await journal(tx, { ...base, decision: 'RATE_LIMITED', reason: out.reason });
        return;
      }
      const attribues = attributeFacts(cands, diff.significant);
      if (attribues.size === 0) {
        out.decision = 'UNCHANGED';
        out.reason = 'faits nouveaux non attribuables à un candidat précis (plusieurs candidats, ni unité ni cible commune)';
        await journal(tx, { ...base, decision: 'UNCHANGED', reason: out.reason });
        return;
      }
      const [doc] = (await tx.unsafe(`SELECT document_type_code FROM asset_files WHERE id = $1 AND account_id = $2`, [p.fileId, p.accountId] as never[])) as Row[];
      const nouvelles = await verifiedTargets(tx, p.accountId, diff.significant.map((x) => x.fact));
      const { getAccountCapabilities } = await import('@/services/account-capabilities.service');
      const caps = await getAccountCapabilities(p.accountId).catch(() => ({ rooms: false, equipments: false }));
      for (const c of cands) {
        const faits = attribues.get(c.candidateKey);
        if (!c.established || !faits?.length) continue;
        // Cibles DÉJÀ retenues par la barrière à l'analyse : conservées telles quelles (jamais retirées par une réparation).
        const deja = (Array.isArray(c.payload.targetHints) ? c.payload.targetHints : []) as Array<{ type?: string; entityId?: unknown }>;
        const ids = (t: 'ASSET' | 'EQUIPMENT' | 'ROOM') => new Set([...nouvelles[t], ...deja.filter((x) => x.type === t && typeof x.entityId === 'number').map((x) => x.entityId as number)]);
        const r = reevaluateCandidate(c, faits, {
          documentTypeCode: (doc?.document_type_code as string | null) ?? null,
          verifiedIds: { ASSET: ids('ASSET'), EQUIPMENT: ids('EQUIPMENT'), ROOM: ids('ROOM') },
          capabilities: { rooms: caps.rooms || deja.some((x) => x.type === 'ROOM'), equipments: caps.equipments || deja.some((x) => x.type === 'EQUIPMENT') },
        });
        const ligne = { candidateKey: c.candidateKey, previousId: c.id, newId: null as number | null, changes: r.changes };
        if (!r.candidate || r.after === null || r.after === r.before) {
          out.candidates.push({ ...ligne, decision: 'UNCHANGED' });
          await journal(tx, { ...base, decision: 'UNCHANGED', reason: r.candidate ? 'état pertinent inchangé' : 'candidat écarté par la barrière serveur : version conservée',
            candidateKey: c.candidateKey, previousId: c.id, fingerprint: r.after, changes: r.changes });
          continue;
        }
        const [dup] = (await tx.unsafe(
          `SELECT 1 FROM document_candidate_repair_propagations WHERE file_id = $1 AND candidate_key = $2 AND state_fingerprint = $3 AND decision = 'SUPERSEDED'`,
          [p.fileId, c.candidateKey, r.after] as never[],
        )) as Row[];
        if (dup) {
          out.candidates.push({ ...ligne, decision: 'DUPLICATE_STATE' });
          await journal(tx, { ...base, decision: 'DUPLICATE_STATE', reason: 'état déjà signalé à T3', candidateKey: c.candidateKey, previousId: c.id, fingerprint: r.after, changes: r.changes });
          continue;
        }
        // SUPERSESSION ATOMIQUE (même transaction, même règle que la réanalyse — `persist.ts`).
        await tx.unsafe(
          `UPDATE document_operation_candidates SET status = 'SUPERSEDED', superseded_at = now(), t3_pending = (t3_processed_at IS NOT NULL)
            WHERE id = $1 AND status = 'ACTIVE'`, [c.id] as never[],
        );
        const payload = reevaluatedPayload(c.payload, r, { origin: p.origin, supersedes: c.id, at: new Date().toISOString() });
        const [ins] = (await tx.unsafe(
          `INSERT INTO document_operation_candidates (
             account_id, file_id, extraction_id, analysis_run_id, candidate_key, established, confidence,
             type_hint, status_hint, summary, payload, status, t3_pending, trigger_code, t3_detail
           )
           SELECT account_id, file_id, extraction_id, analysis_run_id, candidate_key, $2, confidence, type_hint, $3, summary,
                  $4::jsonb, 'ACTIVE', $2, 'source_reanalyzed', t3_detail
             FROM document_operation_candidates WHERE id = $1
           RETURNING id::float8 AS id`,
          [c.id, r.candidate.established, r.candidate.statusHint, JSON.stringify(payload)] as never[],
        )) as Row[];
        ligne.newId = Number(ins.id);
        out.candidates.push({ ...ligne, decision: 'SUPERSEDED' });
        await journal(tx, { ...base, decision: 'SUPERSEDED', reason: 'enrichissement métier : nouvelle version, T3 signalé', candidateKey: c.candidateKey,
          previousId: c.id, newId: ligne.newId, fingerprint: r.after, changes: r.changes });
      }
      out.decision = out.candidates.some((x) => x.decision === 'SUPERSEDED') ? 'SUPERSEDED'
        : out.candidates.some((x) => x.decision === 'DUPLICATE_STATE') ? 'DUPLICATE_STATE' : 'UNCHANGED';
      out.reason = out.decision === 'SUPERSEDED' ? 'candidat(s) réévalué(s) : nouvelle version, T3 signalé'
        : out.decision === 'DUPLICATE_STATE' ? 'état déjà signalé à T3' : 'réévaluation sans changement d’état pertinent';
    });

    if (out.decision === 'SUPERSEDED') {
      const { onDocumentAnalyzedForOperations } = await import('@/services/business-operations/consolidation/queue');
      const jobId = await onDocumentAnalyzedForOperations(p.accountId, p.fileId);
      out.t3 = { status: jobId ? 'REQUESTED' : 'NOT_REQUESTED', jobId: jobId ?? null };
      await pgClient.unsafe(
        `UPDATE document_candidate_repair_propagations SET t3_status = $2, t3_job_id = $3
          WHERE file_id = $1 AND decision = 'SUPERSEDED' AND t3_status = 'NONE' AND candidate_id = ANY($4::bigint[])`,
        [p.fileId, out.t3.status, out.t3.jobId, out.candidates.flatMap((c) => (c.newId ? [c.newId] : []))] as never[],
      ).catch(() => undefined);
    }
    await recordOnCoverage(p.fileId, p.accountId, out);
    console.info(`[t1-repair-propagation] fichier ${p.fileId} : ${out.decision} — ${newFactIds.length} fait(s) nouveau(x), `
      + `catégories ${diff.categories.join(',') || '—'}, T3 ${out.t3.status}${out.t3.jobId ? ` (travail ${out.t3.jobId})` : ''}`);
    return out;
  } catch (e) {
    console.error(`[t1-repair-propagation] fichier ${p.fileId} : propagation non écrite :`, (e as Error).message);
    return vide('ERROR', (e as Error).message.slice(0, 300));
  }
}

/** Résumé borné de la dernière propagation, posé sur la couverture (BO › Complétude T1). Ne lève jamais. */
async function recordOnCoverage(fileId: number, accountId: number, o: RepairPropagationOutcome): Promise<void> {
  try {
    const { pgClient } = await import('@/db');
    const resume = {
      decision: o.decision, reason: o.reason, newFacts: o.newFactIds.length, categories: o.categories,
      candidates: o.candidates.slice(0, 10).map((c) => ({ key: c.candidateKey, decision: c.decision, from: c.previousId, to: c.newId, changes: c.changes.slice(0, 12) })),
      t3: o.t3, at: new Date().toISOString(),
    };
    await pgClient.unsafe(
      `UPDATE document_extraction_coverage SET verification = jsonb_set(coalesce(verification, '{}'::jsonb), '{repairPropagation}', $3::jsonb, true)
        WHERE file_id = $1 AND account_id = $2`,
      [fileId, accountId, JSON.stringify(resume)] as never[],
    );
  } catch { /* diagnostic seulement */ }
}

/** Journal de propagation d'un document (diagnostic, recette). */
export async function loadRepairPropagations(fileId: number, accountId: number): Promise<Row[]> {
  const { pgClient } = await import('@/db');
  return (await pgClient.unsafe(
    `SELECT id::float8 AS id, origin, decision, reason, candidate_key, previous_candidate_id::float8 AS previous_candidate_id,
            candidate_id::float8 AS candidate_id, state_fingerprint, new_fact_ids, categories, changes, t3_status, t3_job_id::float8 AS t3_job_id, created_at
       FROM document_candidate_repair_propagations WHERE file_id = $1 AND account_id = $2 ORDER BY id`,
    [fileId, accountId] as never[],
  )) as unknown as Row[];
}
