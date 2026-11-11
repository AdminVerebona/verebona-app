/**
 * Provenance des faits T1 et preuves par champ orphelines — lectures,
 * corrections, journal, rattrapage BO (lot 113AK, carte Trello #736).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL MOTEUR, TROIS USAGES
 *
 *   · contrôle de cohérence COH-DOC-FACT-PROVENANCE (inspection en lecture
 *     seule, réparation déterministe sans IA) ;
 *   · rattrapage BO « T1 : provenance des faits et preuves orphelines »
 *     (simuler / appliquer avec motif / restaurer une exécution) ;
 *   · journal `document_fact_provenance_events` (aussi écrit par la
 *     persistance T1 et la reprise historique de la couche A).
 *
 * Toutes les qualifications sont celles de `provenance-integrity.ts`
 * (pures). Les corrections ne s'appuient QUE sur ce qui est conservé : unités
 * du MÊME document (compte + document + identifiant), extrait, cellule ou
 * observation enregistrés avec le fait. Aucun appel IA, aucune relecture du
 * fichier, aucune réanalyse.
 *
 *   Fait BROKEN, provenance retrouvée     → `source_unit_ids` rétablis,
 *                                           `provenance_status = RELINKED` ;
 *   Fait BROKEN, rien de conservé          → références invalides RETIRÉES,
 *                                           valeur du fait intacte,
 *                                           `provenance_status = NOT_RECONSTRUCTIBLE`
 *                                           (« provenance non reconstituable ») ;
 *   Contradiction, version remplacée,      → constat (jamais réécrit d'office) ;
 *   document d'un autre compte
 *   Preuve ACTIVE vers un bien / document  → `lifecycle_status = WITHDRAWN`
 *   supprimé, purgé, transféré, fusionné,    (ligne conservée : historique),
 *   ou plus rattaché                         qualification au journal.
 *
 * Idempotent : un objet corrigé n'est plus qualifié BROKEN / orphelin ; un
 * second passage n'écrit rien. Réversible : l'état AVANT est au journal
 * (`detail.before`), la restauration d'une exécution le remet si l'objet n'a
 * pas changé depuis.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  factCorrection, qualifyEvidence, qualifyFact,
  type EvidenceOrphanStatus, type FactDocumentContext, type FactQualification, type StoredFactView, type StoredUnitView,
} from './provenance-integrity';

type Sql = postgres.Sql;
type Exec = { unsafe: (q: string, p?: never[]) => Promise<unknown> };
type Row = Record<string, unknown>;

const q = async (s: Exec, text: string, params: unknown[] = []): Promise<Row[]> => (await s.unsafe(text, params as never[])) as unknown as Row[];
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const parse = <T>(v: unknown): T | null => (typeof v === 'string' ? JSON.parse(v) as T : (v as T) ?? null);

// ── Journal ─────────────────────────────────────────────────────────────────

export type ProvenancePhase = 'PERSISTENCE' | 'BACKFILL' | 'CHECK' | 'CATCHUP' | 'LIFECYCLE';
export type ProvenanceEventStatus =
  | 'UNIT_MISSING' | 'SUPERSEDED_VERSION' | 'SOURCE_UNLINKED' | 'CONTRADICTION' | 'RELINKED' | 'NOT_RECONSTRUCTIBLE'
  | 'ASSET_DELETED' | 'ASSET_TRANSFERRED' | 'DOCUMENT_DELETED' | 'DOCUMENT_PURGED' | 'DOCUMENT_TRANSFERRED' | 'DOCUMENT_MERGED';

export interface ProvenanceEvent {
  accountId: number;
  fileId: number;
  subject: 'FACT' | 'EVIDENCE';
  factId?: number | null;
  evidenceId?: number | null;
  assetId?: number | null;
  extractionId?: number | null;
  sourceUnitId?: string | null;
  status: ProvenanceEventStatus;
  cause: string;
  phase: ProvenancePhase;
  runId?: string | null;
  detail?: Record<string, unknown>;
}

let journalEtat: { ready: boolean; at: number } | null = null;

/** Journal 1640 (table + colonne `provenance_status`) présent ? Ne lève jamais ; recontrôlé toutes les 5 min s'il manque. */
export async function provenanceJournalReady(s?: Exec): Promise<boolean> {
  if (journalEtat && (journalEtat.ready || Date.now() - journalEtat.at < 300_000)) return journalEtat.ready;
  let ready = false;
  try {
    const exec = s ?? (await import('@/db')).pgClient;
    const [r] = await q(exec, `SELECT to_regclass('document_fact_provenance_events') IS NOT NULL AS t,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'document_facts' AND column_name = 'provenance_status') AS c`);
    ready = r?.t === true && r?.c === true;
  } catch { ready = false; }
  journalEtat = { ready, at: Date.now() };
  return ready;
}

/** Tests : oublie l'état du contrôle de schéma. */
export function __resetProvenanceJournalProbe(): void { journalEtat = null; }

/** Écrit des lignes de journal (une requête). À appeler sous point de sauvegarde quand une transaction métier est en cours. */
export async function recordProvenanceEvents(s: Exec, events: readonly ProvenanceEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const lot = events.map((e) => ({
    a: e.accountId, f: e.fileId, s: e.subject, fa: e.factId ?? null, ev: e.evidenceId ?? null, as: e.assetId ?? null, ex: e.extractionId ?? null,
    u: e.sourceUnitId ?? null, st: e.status, c: e.cause, p: e.phase, r: e.runId ?? null, d: e.detail ?? {},
  }));
  await s.unsafe(
    `INSERT INTO document_fact_provenance_events (account_id, file_id, subject, fact_id, evidence_id, asset_id, extraction_id, source_unit_id,
       status, cause, phase, run_id, detail)
     SELECT x.a, x.f, x.s, x.fa, x.ev, x."as", x.ex, x.u, x.st, x.c, x.p, x.r::uuid, coalesce(x.d, '{}'::jsonb)
       FROM jsonb_to_recordset($1::jsonb) AS x(a int, f int, s text, fa bigint, ev int, "as" int, ex int, u text, st text, c text, p text, r text, d jsonb)`,
    [JSON.stringify(lot)] as never[],
  );
  return events.length;
}

// ── Lectures ────────────────────────────────────────────────────────────────

export interface FileProvenanceState {
  accountId: number;
  fileId: number;
  doc: FactDocumentContext;
  facts: FactQualification[];
  evidence: EvidenceQualification[];
}

export interface EvidenceQualification {
  evidenceId: number;
  accountId: number;
  assetId: number;
  fileId: number;
  fieldKey: string | null;
  lifecycleBefore: string | null;
  status: EvidenceOrphanStatus;
  withdraw: boolean;
}

/** Documents d'un compte à examiner (faits actifs porteurs de provenance ou qualifiés, preuves actives de document), après `afterId`. */
export async function listProvenanceObjects(s: Exec, accountId: number, afterId: number, limit: number): Promise<number[]> {
  const ready = await provenanceJournalReady(s);
  const r = await q(s, `
    SELECT id FROM (
      SELECT DISTINCT f.file_id AS id FROM document_facts f
       WHERE f.account_id = $1 AND f.file_id > $2 AND f.status = 'active'
         AND (cardinality(f.source_unit_ids) > 0 ${ready ? `OR f.provenance_status IS NOT NULL` : ''})
      UNION
      SELECT DISTINCT fe.source_id AS id FROM field_evidence fe
       WHERE fe.account_id = $1 AND fe.source_id > $2 AND fe.source_type IN ('document', 'web_link', 'asset_file', 'file')
         AND (fe.lifecycle_status IS NULL OR fe.lifecycle_status = 'ACTIVE')
    ) x ORDER BY id LIMIT $3`, [accountId, afterId, limit]);
  return r.map((x) => Number(x.id));
}

/** Qualification complète (lecture seule) des documents `fileIds` d'un compte. */
export async function inspectFileProvenance(s: Exec, accountId: number, fileIds: readonly number[]): Promise<Map<number, FileProvenanceState>> {
  const ids = [...new Set(fileIds.filter((x) => Number.isSafeInteger(x)))];
  const out = new Map<number, FileProvenanceState>();
  if (ids.length === 0) return out;
  const ready = await provenanceJournalReady(s);
  const docs = new Map((await q(s, `
    SELECT af.id, af.account_id, af.deleted_at IS NOT NULL AS deleted,
           (SELECT e.id FROM document_extractions e WHERE e.file_id = af.id ORDER BY e.id DESC LIMIT 1) AS extraction_id,
           EXISTS (SELECT 1 FROM document_extraction_coverage c WHERE c.file_id = af.id) AS has_coverage
      FROM asset_files af WHERE af.id = ANY($1::int[])`, [ids])).map((r) => [Number(r.id), r]));
  const facts = await q(s, `
    SELECT f.id::float8 AS id, f.account_id, f.file_id, f.extraction_id, f.status, f.source_unit_ids, f.excerpt, f.location,
           f.evidence_origin, f.visual_evidence, ${ready ? 'f.provenance_status' : 'NULL::text AS provenance_status'}
      FROM document_facts f
     WHERE f.account_id = $1 AND f.file_id = ANY($2::int[]) AND f.status = 'active'
       AND (cardinality(f.source_unit_ids) > 0 ${ready ? 'OR f.provenance_status IS NOT NULL' : ''})
     ORDER BY f.file_id, f.id`, [accountId, ids]);
  const unitsByFile = new Map<number, StoredUnitView[]>();
  for (const u of await q(s, `
    SELECT file_id, source_unit_id, kind, page, ordinal, content_text, label, value_text, payload
      FROM document_source_units WHERE account_id = $1 AND file_id = ANY($2::int[]) ORDER BY file_id, ordinal`, [accountId, ids])) {
    const l = unitsByFile.get(Number(u.file_id)) ?? [];
    l.push({
      sourceUnitId: String(u.source_unit_id), kind: String(u.kind), page: num(u.page), ordinal: Number(u.ordinal),
      text: (u.content_text as string | null) ?? null, label: (u.label as string | null) ?? null, value: (u.value_text as string | null) ?? null,
      payload: parse<Record<string, unknown>>(u.payload) ?? {},
    });
    unitsByFile.set(Number(u.file_id), l);
  }
  // Identifiants manquants présents dans D'AUTRES documents du compte : diagnostic seulement, jamais une correspondance.
  const refs = [...new Set(facts.flatMap((f) => (Array.isArray(f.source_unit_ids) ? (f.source_unit_ids as unknown[]).map(String) : [])))];
  const ailleurs = new Map<string, Set<number>>();
  if (refs.length) {
    const lignes = [...new Set(refs.map((r) => r.replace(/:cell:\d+$/, '')))];
    for (const r of await q(s, `SELECT source_unit_id, array_agg(DISTINCT file_id) AS files FROM document_source_units
                                 WHERE account_id = $1 AND source_unit_id = ANY($2::text[]) GROUP BY 1`, [accountId, [...new Set([...refs, ...lignes])]])) {
      ailleurs.set(String(r.source_unit_id), new Set((r.files as unknown[]).map(Number)));
    }
  }
  const evidence = await loadActiveDocumentEvidence(s, accountId, ids);
  for (const fileId of ids) {
    const d = docs.get(fileId);
    const doc: FactDocumentContext = {
      exists: !!d, accountId: d ? num(d.account_id) : null, deleted: d?.deleted === true,
      currentExtractionId: d ? num(d.extraction_id) : null, hasCoverage: d?.has_coverage === true,
    };
    const units = unitsByFile.get(fileId) ?? [];
    const qs = facts.filter((f) => Number(f.file_id) === fileId).map((f) => {
      const view: StoredFactView = {
        id: Number(f.id), accountId: Number(f.account_id), fileId, extractionId: num(f.extraction_id), status: String(f.status),
        sourceUnitIds: Array.isArray(f.source_unit_ids) ? (f.source_unit_ids as unknown[]).map(String) : null,
        excerpt: (f.excerpt as string | null) ?? null, location: parse<Record<string, unknown>>(f.location),
        evidenceOrigin: (f.evidence_origin as string | null) ?? null, visualEvidence: parse(f.visual_evidence),
        provenanceStatus: (f.provenance_status as string | null) ?? null,
      };
      const autre = (ref: string) => {
        const de = (k: string) => [...(ailleurs.get(k) ?? [])].some((x) => x !== fileId);
        return de(ref) || de(ref.replace(/:cell:\d+$/, ''));
      };
      return qualifyFact(view, doc, units, autre);
    });
    out.set(fileId, { accountId, fileId, doc, facts: qs, evidence: evidence.filter((e) => e.fileId === fileId) });
  }
  return out;
}

/** Preuves ACTIVES dont la source est un document (`fileIds` ; null : tout le compte), qualifiées. */
export async function loadActiveDocumentEvidence(s: Exec, accountId: number, fileIds: readonly number[] | null): Promise<EvidenceQualification[]> {
  const ready = await provenanceJournalReady(s);
  const rowsEv = await q(s, `
    SELECT fe.id, fe.account_id, fe.asset_id, fe.source_id, fe.field_key, fe.lifecycle_status,
           a.id IS NOT NULL AS asset_exists, a.account_id AS asset_account, a.deleted_at IS NOT NULL AS asset_deleted, a.status AS asset_status,
           af.id IS NOT NULL AS doc_exists, af.account_id AS doc_account,
           -- Source secondaire regroupée (0143) : masquée mais consultable tant que son document principal vit.
           (af.deleted_at IS NOT NULL AND NOT (af.grouped_into_file_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM asset_files lead WHERE lead.id = af.grouped_into_file_id AND lead.deleted_at IS NULL))) AS doc_deleted,
           ${ready ? `EXISTS (SELECT 1 FROM document_fact_provenance_events j WHERE j.account_id = fe.account_id AND j.file_id = fe.source_id
                                AND j.status = 'DOCUMENT_MERGED' AND j.reverted_at IS NULL)` : 'false'} AS merged,
           (af.asset_id = fe.asset_id OR af.linked_asset_id = fe.asset_id
             OR af.equipment_id IN (SELECT e.id FROM equipments e WHERE e.asset_id = fe.asset_id)
             OR af.substructure_id IN (SELECT x.id FROM substructures x WHERE x.asset_id = fe.asset_id)
             OR af.linked_room_id IN (SELECT r.id FROM rooms r WHERE r.asset_id = fe.asset_id)
             OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = af.id AND l.status = 'ACTIVE'
                          AND (l.asset_id = fe.asset_id
                            OR l.equipment_id IN (SELECT e.id FROM equipments e WHERE e.asset_id = fe.asset_id)
                            OR l.substructure_id IN (SELECT x.id FROM substructures x WHERE x.asset_id = fe.asset_id)))
             OR EXISTS (SELECT 1 FROM document_facts d WHERE d.file_id = af.id AND d.status = 'active'
                          AND ((d.target_type = 'ASSET' AND d.target_entity_id = fe.asset_id)
                            OR (d.target_type = 'EQUIPMENT' AND d.target_entity_id IN (SELECT e.id FROM equipments e WHERE e.asset_id = fe.asset_id))
                            OR (d.target_type = 'ROOM' AND d.target_entity_id IN (SELECT x.id FROM substructures x WHERE x.asset_id = fe.asset_id))))
           ) AS linked
      FROM field_evidence fe
      LEFT JOIN assets a ON a.id = fe.asset_id
      LEFT JOIN asset_files af ON af.id = fe.source_id
     WHERE fe.account_id = $1 AND ($2::int[] IS NULL OR fe.source_id = ANY($2::int[]))
       AND fe.source_type IN ('document', 'web_link', 'asset_file', 'file')
       AND (fe.lifecycle_status IS NULL OR fe.lifecycle_status = 'ACTIVE')
     ORDER BY fe.source_id, fe.id`, [accountId, fileIds ? [...fileIds] : null]);
  return rowsEv.map((r) => {
    const v = qualifyEvidence({
      id: Number(r.id), accountId: Number(r.account_id), assetId: Number(r.asset_id), sourceId: Number(r.source_id),
      asset: r.asset_exists ? { accountId: num(r.asset_account), deleted: r.asset_deleted === true, status: (r.asset_status as string | null) ?? null } : null,
      document: r.doc_exists ? { accountId: num(r.doc_account), deleted: r.doc_deleted === true, merged: r.merged === true, linkedToAsset: r.linked === true } : null,
    });
    return {
      evidenceId: Number(r.id), accountId: Number(r.account_id), assetId: Number(r.asset_id), fileId: Number(r.source_id),
      fieldKey: (r.field_key as string | null) ?? null, lifecycleBefore: (r.lifecycle_status as string | null) ?? null, ...v,
    };
  });
}

// ── Corrections ─────────────────────────────────────────────────────────────

/** Qualifications de preuves qu'un passage AUTOMATIQUE (contrôle de cohérence) peut retirer : objet disparu ou parti, sans ambiguïté. */
export const UNAMBIGUOUS_EVIDENCE_WITHDRAWALS: ReadonlySet<EvidenceOrphanStatus> = new Set([
  'ASSET_DELETED', 'ASSET_TRANSFERRED', 'DOCUMENT_DELETED', 'DOCUMENT_PURGED', 'DOCUMENT_TRANSFERRED', 'DOCUMENT_MERGED',
]);

export interface CorrectionOutcome {
  relinked: number;
  notReconstructible: number;
  evidenceWithdrawn: number;
  events: number;
  /** Biens vivants du compte dont des preuves ont été retirées (à réconcilier par T3 à son prochain passage). */
  assetsToReconcile: number[];
}

/**
 * Applique les corrections d'UN document (une transaction). Garde
 * optimiste : un fait dont la provenance a changé depuis la lecture, une
 * preuve qui n'est plus ACTIVE, ne sont pas touchés.
 */
export async function applyFileCorrections(sql: Sql, st: FileProvenanceState, o: {
  phase: ProvenancePhase; runId?: string | null; reason?: string | null;
  /** Qualifications de preuves retirables (défaut : toutes celles qui demandent un retrait). */
  evidenceStatuses?: ReadonlySet<EvidenceOrphanStatus> | null;
}): Promise<CorrectionOutcome> {
  const res: CorrectionOutcome = { relinked: 0, notReconstructible: 0, evidenceWithdrawn: 0, events: 0, assetsToReconcile: [] };
  const journal = await provenanceJournalReady(sql);
  const corrections = st.facts.map((f) => ({ f, c: factCorrection(f) })).filter((x) => x.c !== null);
  const retraits = st.evidence.filter((e) => e.withdraw && (!o.evidenceStatuses || o.evidenceStatuses.has(e.status)));
  if (!journal || (corrections.length === 0 && retraits.length === 0)) return res;
  await sql.begin(async (tx) => {
    const events: ProvenanceEvent[] = [];
    for (const { f, c } of corrections) {
      const avant = f.refs.map((r) => r.ref);
      const fait = await q(tx, `
        UPDATE document_facts SET source_unit_ids = $4::text[], provenance_status = $5
         WHERE id = $1 AND account_id = $2 AND file_id = $3 AND status = 'active'
           AND source_unit_ids IS NOT DISTINCT FROM $6::text[]
        RETURNING id, extraction_id`, [f.factId, f.accountId, f.fileId, c!.sourceUnitIds, c!.provenanceStatus, avant]);
      if (!fait.length) continue;
      if (c!.eventStatus === 'RELINKED') res.relinked++; else res.notReconstructible++;
      for (const r of f.refs.filter((x) => x.status === 'UNIT_MISSING')) {
        events.push({
          accountId: f.accountId, fileId: f.fileId, subject: 'FACT', factId: f.factId, extractionId: num(fait[0].extraction_id),
          sourceUnitId: r.ref, status: c!.eventStatus, cause: f.cause, phase: o.phase, runId: o.runId ?? null,
          detail: { before: avant, after: c!.sourceUnitIds, beforeStatus: f.previousStatus, elsewhere: r.elsewhere, ...(o.reason ? { reason: o.reason } : {}) },
        });
      }
    }
    const vivants = new Set<number>();
    for (const e of retraits) {
      const r = await q(tx, `
        UPDATE field_evidence SET lifecycle_status = 'WITHDRAWN', superseded_at = now()
         WHERE id = $1 AND account_id = $2 AND (lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE') RETURNING id`, [e.evidenceId, e.accountId]);
      if (!r.length) continue;
      res.evidenceWithdrawn++;
      if (e.status === 'DOCUMENT_DELETED' || e.status === 'DOCUMENT_PURGED' || e.status === 'DOCUMENT_MERGED' || e.status === 'DOCUMENT_TRANSFERRED' || e.status === 'SOURCE_UNLINKED') vivants.add(e.assetId);
      events.push({
        accountId: e.accountId, fileId: e.fileId, subject: 'EVIDENCE', evidenceId: e.evidenceId, assetId: e.assetId,
        status: e.status as ProvenanceEventStatus, cause: `EVIDENCE_${e.status}`, phase: o.phase, runId: o.runId ?? null,
        detail: { lifecycleBefore: e.lifecycleBefore, fieldKey: e.fieldKey, ...(o.reason ? { reason: o.reason } : {}) },
      });
    }
    res.events = await recordProvenanceEvents(tx, events);
    if (vivants.size) {
      const v = await q(tx, `SELECT id FROM assets WHERE id = ANY($1::int[]) AND account_id = $2 AND deleted_at IS NULL`, [[...vivants], st.accountId]);
      res.assetsToReconcile = v.map((x) => Number(x.id));
    }
  });
  return res;
}

// ── Rattrapage BO ───────────────────────────────────────────────────────────

const SAMPLE = 30;

export interface ProvenanceCatchupReport {
  mode: 'simulate' | 'apply';
  runId: string | null;
  disabled: string | null;
  accounts: number;
  documents: number;
  facts: {
    examined: number; valid: number; historicalReferences: number; outOfScope: number; layerPending: number;
    broken: number; relinkable: number; notReconstructible: number; alreadyNotReconstructible: number;
    contradictions: number; supersededVersion: number; sourceUnlinked: number; crossDocumentIds: number;
  };
  evidence: { examined: number; valid: number; historicalArchived: number; byStatus: Record<string, number>; withdrawable: number };
  written: { relinked: number; notReconstructible: number; evidenceWithdrawn: number; events: number };
  assetsToReconcile: Array<{ accountId: number; assetId: number }>;
  /** Échantillons consultables : compte, document, fait / preuve, unité, statut, cause. */
  samples: Array<{ accountId: number; fileId: number; factId?: number; evidenceId?: number; assetId?: number; unit?: string; status: string; cause: string }>;
  more: boolean;
}

/** Rattrapage (simulation ou application) — comptes éligibles ou un compte ; borné par `deadline`. */
export async function runProvenanceCatchup(o: {
  sql: Sql; apply: boolean; accountId?: number | null; reason?: string | null; deadline?: number; log?: (m: string) => void;
}): Promise<ProvenanceCatchupReport> {
  const rep: ProvenanceCatchupReport = {
    mode: o.apply ? 'apply' : 'simulate', runId: null, disabled: null, accounts: 0, documents: 0,
    facts: { examined: 0, valid: 0, historicalReferences: 0, outOfScope: 0, layerPending: 0, broken: 0, relinkable: 0, notReconstructible: 0,
      alreadyNotReconstructible: 0, contradictions: 0, supersededVersion: 0, sourceUnlinked: 0, crossDocumentIds: 0 },
    evidence: { examined: 0, valid: 0, historicalArchived: 0, byStatus: {}, withdrawable: 0 },
    written: { relinked: 0, notReconstructible: 0, evidenceWithdrawn: 0, events: 0 },
    assetsToReconcile: [], samples: [], more: false,
  };
  if (!(await provenanceJournalReady(o.sql))) { rep.disabled = 'migration 1640 absente (journal de provenance)'; return rep; }
  if (o.apply) rep.runId = randomUUID();
  const comptes = o.accountId ? [o.accountId] : (await q(o.sql, `
    SELECT DISTINCT account_id FROM (
      SELECT account_id FROM document_facts WHERE status = 'active' AND cardinality(source_unit_ids) > 0
      UNION SELECT account_id FROM field_evidence WHERE source_type IN ('document', 'web_link', 'asset_file', 'file')
                                                  AND (lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE')) x
     ORDER BY 1`)).map((r) => Number(r.account_id));
  const echantillon = (x: ProvenanceCatchupReport['samples'][number]) => { if (rep.samples.length < SAMPLE) rep.samples.push(x); };
  for (const accountId of comptes) {
    if (o.deadline && Date.now() > o.deadline) { rep.more = true; break; }
    rep.accounts++;
    const [h] = await q(o.sql, `SELECT count(*)::int AS n FROM document_facts WHERE account_id = $1 AND status <> 'active' AND cardinality(source_unit_ids) > 0`, [accountId]);
    rep.facts.historicalReferences += Number(h?.n ?? 0);
    let apres = 0;
    for (;;) {
      if (o.deadline && Date.now() > o.deadline) { rep.more = true; break; }
      const ids = await listProvenanceObjects(o.sql, accountId, apres, 100);
      if (ids.length === 0) break;
      apres = ids[ids.length - 1];
      const etats = await inspectFileProvenance(o.sql, accountId, ids);
      for (const st of etats.values()) {
        rep.documents++;
        for (const f of st.facts) {
          rep.facts.examined++;
          const premier = f.refs.find((r) => r.status === 'UNIT_MISSING' || r.status === 'CONTRADICTION');
          if (f.refs.some((r) => r.status === 'UNIT_MISSING' && r.elsewhere)) rep.facts.crossDocumentIds++;
          switch (f.state) {
            case 'VALID': rep.facts.valid++; break;
            case 'OUT_OF_SCOPE': rep.facts.outOfScope++; break;
            case 'LAYER_PENDING': rep.facts.layerPending++; break;
            case 'NOT_RECONSTRUCTIBLE': rep.facts.alreadyNotReconstructible++; break;
            case 'SUPERSEDED_VERSION': rep.facts.supersededVersion++; echantillon({ accountId, fileId: f.fileId, factId: f.factId, status: f.state, cause: f.cause }); break;
            case 'SOURCE_UNLINKED': rep.facts.sourceUnlinked++; echantillon({ accountId, fileId: f.fileId, factId: f.factId, status: f.state, cause: f.cause }); break;
            case 'BROKEN': {
              const c = factCorrection(f);
              if (!c) { rep.facts.contradictions++; echantillon({ accountId, fileId: f.fileId, factId: f.factId, unit: premier?.ref, status: 'CONTRADICTION', cause: f.cause }); break; }
              rep.facts.broken++;
              if (c.eventStatus === 'RELINKED') rep.facts.relinkable++; else rep.facts.notReconstructible++;
              echantillon({ accountId, fileId: f.fileId, factId: f.factId, unit: premier?.ref, status: c.eventStatus, cause: f.cause });
              break;
            }
            default: break;
          }
        }
        for (const e of st.evidence) {
          rep.evidence.examined++;
          if (e.status === 'VALID') { rep.evidence.valid++; continue; }
          if (e.status === 'HISTORICAL_ARCHIVED') { rep.evidence.historicalArchived++; continue; }
          rep.evidence.byStatus[e.status] = (rep.evidence.byStatus[e.status] ?? 0) + 1;
          if (e.withdraw) rep.evidence.withdrawable++;
          echantillon({ accountId, fileId: e.fileId, evidenceId: e.evidenceId, assetId: e.assetId, status: e.status, cause: `EVIDENCE_${e.status}` });
        }
        if (o.apply) {
          const w = await applyFileCorrections(o.sql, st, { phase: 'CATCHUP', runId: rep.runId, reason: o.reason ?? null });
          rep.written.relinked += w.relinked; rep.written.notReconstructible += w.notReconstructible;
          rep.written.evidenceWithdrawn += w.evidenceWithdrawn; rep.written.events += w.events;
          for (const a of w.assetsToReconcile) rep.assetsToReconcile.push({ accountId, assetId: a });
        }
      }
      if (ids.length < 100) break;
    }
    o.log?.(`compte ${accountId} : ${rep.documents} document(s) examiné(s) au total`);
  }
  return rep;
}

export interface ProvenanceRestoreReport { runId: string; facts: number; evidence: number; skipped: number }

/**
 * Restauration d'une exécution du rattrapage : état AVANT remis sur les
 * objets que l'exécution a modifiés et qui n'ont pas changé depuis ; lignes
 * de journal marquées `reverted_at` (jamais supprimées). Rejouée : rien.
 */
export async function restoreProvenanceCatchup(sql: Sql, runId: string): Promise<ProvenanceRestoreReport> {
  const rep: ProvenanceRestoreReport = { runId, facts: 0, evidence: 0, skipped: 0 };
  if (!(await provenanceJournalReady(sql))) return rep;
  const lignes = await q(sql, `
    SELECT DISTINCT ON (subject, coalesce(fact_id, evidence_id)) id, subject, fact_id::float8 AS fact_id, evidence_id, account_id, detail
      FROM document_fact_provenance_events WHERE run_id = $1::uuid AND reverted_at IS NULL
     ORDER BY subject, coalesce(fact_id, evidence_id), id`, [runId]);
  for (const l of lignes) {
    const d = parse<Record<string, unknown>>(l.detail) ?? {};
    try {
      // Compteurs mis à jour APRÈS la validation : une garde différée (isolation des comptes) peut refuser au COMMIT.
      const ok = await sql.begin(async (tx) => {
        let fait = false;
        if (l.subject === 'FACT') {
          const r = await q(tx, `UPDATE document_facts SET source_unit_ids = $3::text[], provenance_status = $4
                                  WHERE id = $1 AND account_id = $2 AND source_unit_ids IS NOT DISTINCT FROM $5::text[] RETURNING id`,
          [l.fact_id, l.account_id, d.before ?? null, d.beforeStatus ?? null, d.after ?? null]);
          fait = r.length > 0;
        } else {
          const r = await q(tx, `UPDATE field_evidence SET lifecycle_status = $3, superseded_at = NULL
                                  WHERE id = $1 AND account_id = $2 AND lifecycle_status = 'WITHDRAWN' RETURNING id`,
          [l.evidence_id, l.account_id, (d.lifecycleBefore as string | null) ?? 'ACTIVE']);
          fait = r.length > 0;
        }
        if (!fait) return false;
        await tx.unsafe(`UPDATE document_fact_provenance_events SET reverted_at = now()
                          WHERE run_id = $1::uuid AND subject = $2 AND coalesce(fact_id, evidence_id) = $3 AND reverted_at IS NULL`,
        [runId, l.subject, l.subject === 'FACT' ? l.fact_id : l.evidence_id] as never[]);
        return true;
      });
      if (!ok) rep.skipped++;
      else if (l.subject === 'FACT') rep.facts++;
      else rep.evidence++;
    } catch {
      // Objet devenu incompatible (garde d'isolation, objet supprimé) : laissé tel quel, compté.
      rep.skipped++;
    }
  }
  return rep;
}
