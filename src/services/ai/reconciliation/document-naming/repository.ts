/**
 * T3 — harmonisation du nommage documentaire (lot 61) : accès base.
 *
 * Toutes les lectures sont bornées au COMPTE (`account_id = $1` sur chaque
 * table) : aucune donnée d'un autre compte n'est lue ni écrite.
 *
 * ÉCRITURE D'UN NOM (`applyRename`) — une transaction :
 *   1. UPDATE asset_files … RETURNING, sous compare-and-swap : même compte,
 *      document actif, titre SYSTEM (jamais un titre utilisateur), marque
 *      historique du tiroir absente, nom en place = nom ATTENDU (celui lu
 *      dans le contexte envoyé à l'IA). Seul `retained_title` change (plus
 *      `title_checked_at` / `updated_at`) : ni le fichier stocké, ni son
 *      identifiant, ni ses liens, ni aucune Opération ;
 *   2. INSERT du journal (APPLIED, ancien et nouveau nom, origine, date,
 *      justification, références), clé d'idempotence unique.
 * Un renommage manuel intervenu entre l'analyse IA et l'écriture fait
 * échouer le compare-and-swap : CONFLICT, jamais écrasé.
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import { isValidBusinessTitle } from '@/lib/documents/document-title-rules';
import { T1_SETTLED_STATES } from '../document-asset/question-gate';
import type { KnownDocumentData, NameOrigin } from './guards';
import type { NamingDoc, NamingDocDetail } from './context';

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v == null ? null : String(v));
const n = (v: unknown): number | null => (v == null ? null : Number(v));
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

let pret: boolean | null = null;
/** Tables de la migration 0450 présentes ? (mémorisé une fois vrai). */
export async function namingTablesReady(): Promise<boolean> {
  if (pret) return true;
  const [r] = (await pgClient.unsafe(
    `SELECT to_regclass('document_naming_groups') IS NOT NULL AND to_regclass('document_rename_events') IS NOT NULL AS ok`,
  )) as unknown as Array<{ ok: boolean }>;
  pret = !!r?.ok;
  return pret;
}
export function resetNamingTablesReady(): void { pret = null; }

/**
 * Documents du compte éligibles au nommage : analysés par T1 (état abouti),
 * visibles (ni supprimés, ni regroupés, ni brouillons, ni ignorés, ni liens
 * web), avec un nom. AUCUNE condition sur les Opérations, le classement ou
 * le rattachement.
 */
export async function loadNamingDocs(accountId: number, limit: number): Promise<NamingDoc[]> {
  const rows = (await pgClient.unsafe(
    `SELECT f.id, f.retained_title, f.original_filename, f.filename, f.s3_key, f.public_id::text AS public_id,
            f.title_source, COALESCE((f.user_edited_fields ->> 'retainedTitle') = 'true', false) AS legacy_user_edit,
            COALESCE(f.document_type_code, e.document_type_code, f.document_type) AS type_code,
            COALESCE(NULLIF(btrim(f.supplier), ''), NULLIF(btrim(e.supplier_name), '')) AS supplier,
            to_char(COALESCE(f.document_date, e.document_date), 'YYYY-MM-DD') AS document_date,
            a.id AS asset_id, a.name AS asset_name,
            e.id AS extraction_id, e.extracted_at, e.title AS extraction_title,
            COALESCE(f.amount_cents::bigint, e.amount_cents) AS amount_cents
       FROM asset_files f
       LEFT JOIN document_extractions e ON e.file_id = f.id AND e.account_id = f.account_id
       LEFT JOIN assets a ON a.id = COALESCE(f.asset_id, f.linked_asset_id) AND a.account_id = f.account_id AND a.deleted_at IS NULL
      WHERE f.account_id = $1
        AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
        AND COALESCE(f.is_draft, false) = false AND COALESCE(f.is_ignored, false) = false
        AND COALESCE(f.is_web_link, false) = false
        AND f.analysis_state IN ('${T1_SETTLED_STATES.join("', '")}')
        AND NULLIF(btrim(f.retained_title), '') IS NOT NULL
      ORDER BY f.id
      LIMIT $2`,
    [accountId, limit] as never[],
  )) as unknown as Row[];
  return rows.map((r) => ({
    id: Number(r.id), name: String(r.retained_title), originalName: s(r.original_filename), filename: s(r.filename),
    s3Key: s(r.s3_key), publicId: s(r.public_id), titleSource: String(r.title_source ?? 'SYSTEM'), legacyUserEdit: r.legacy_user_edit === true,
    typeCode: s(r.type_code), supplier: s(r.supplier), documentDate: s(r.document_date),
    assetId: n(r.asset_id), assetName: s(r.asset_name), extractionId: n(r.extraction_id), extractedAt: iso(r.extracted_at),
    extractionTitle: s(r.extraction_title), amountCents: n(r.amount_cents),
  }));
}

/** Dernières écritures journalisées d'un document (harmonisation, titre T1/T3). */
export interface NameTrace {
  harmonization: { name: string; at: string; fingerprint: string | null } | null;
  titleEvent: { name: string | null; at: string; origin: string } | null;
}

/**
 * Origine du nom EN PLACE (pure) — auto-validante : une écriture journalisée
 * ne vaut origine que si son nom est TOUJOURS le nom en place.
 */
export function deriveNameOrigin(d: Pick<NamingDoc, 'name' | 'titleSource' | 'legacyUserEdit' | 'originalName' | 'filename' | 's3Key' | 'publicId'>, t: NameTrace | undefined): NameOrigin {
  if (d.titleSource === 'USER') return 'USER';
  if (d.legacyUserEdit && isValidBusinessTitle(d.name, { s3Key: d.s3Key, publicId: d.publicId })) return 'USER';
  const nom = d.name.trim();
  const h = t?.harmonization && t.harmonization.name.trim() === nom ? t.harmonization : null;
  const e = t?.titleEvent && (t.titleEvent.name ?? '').trim() === nom ? t.titleEvent : null;
  if (h && (!e || h.at >= e.at)) return 'T3_HARMONIZATION';
  if (e) return e.origin === 'T1' ? 'T1' : 'T3';
  if ([d.originalName, d.filename].some((x) => x && x.trim() === nom)) return 'UPLOAD';
  return 'UNKNOWN';
}

export async function loadNameTraces(accountId: number, ids: readonly number[]): Promise<Map<number, NameTrace>> {
  const out = new Map<number, NameTrace>();
  if (!ids.length) return out;
  const [h, e] = await Promise.all([
    pgClient.unsafe(
      `SELECT DISTINCT ON (file_id) file_id, applied_name, created_at, document_fingerprint
         FROM document_rename_events
        WHERE account_id = $1 AND file_id = ANY($2::int[]) AND outcome = 'APPLIED'
        ORDER BY file_id, id DESC`,
      [accountId, ids] as never[],
    ) as unknown as Promise<Row[]>,
    pgClient.unsafe(
      `SELECT DISTINCT ON (file_id) file_id, new_title, created_at, origin
         FROM document_title_events
        WHERE account_id = $1 AND file_id = ANY($2::int[]) AND outcome = 'UPDATED'
        ORDER BY file_id, id DESC`,
      [accountId, ids] as never[],
    ).catch(() => []) as unknown as Promise<Row[]>,
  ]);
  const get = (id: number) => out.get(id) ?? (out.set(id, { harmonization: null, titleEvent: null }), out.get(id)!);
  for (const r of h) get(Number(r.file_id)).harmonization = { name: String(r.applied_name), at: iso(r.created_at)!, fingerprint: s(r.document_fingerprint) };
  for (const r of e) get(Number(r.file_id)).titleEvent = { name: s(r.new_title), at: iso(r.created_at)!, origin: String(r.origin) };
  return out;
}

/** Détail des documents d'UN appel (faits, extrait, Opérations liées, historique du nom). Borné. */
export async function loadDocDetails(accountId: number, ids: readonly number[]): Promise<Map<number, NamingDocDetail>> {
  const out = new Map<number, NamingDocDetail>();
  for (const id of ids) out.set(id, { facts: [], excerpt: null, operations: [], history: [] });
  if (!ids.length) return out;
  const [faits, extraits, ops, histo, titres] = await Promise.all([
    pgClient.unsafe(
      `SELECT file_id, key, value, period FROM (
         SELECT f.file_id, COALESCE(f.canonical_key, f.label, f.fact_key) AS key,
                COALESCE(f.value_text, f.normalized_value, CASE WHEN f.value_number IS NULL THEN NULL ELSE f.value_number::text || COALESCE(' ' || f.value_unit, '') END) AS value,
                CASE WHEN f.period_start IS NULL AND f.period_end IS NULL THEN NULL
                     ELSE COALESCE(to_char(f.period_start, 'YYYY-MM-DD'), '?') || ' → ' || COALESCE(to_char(f.period_end, 'YYYY-MM-DD'), '?') END AS period,
                row_number() OVER (PARTITION BY f.file_id ORDER BY (f.canonical_key IS NULL), f.id) AS rang
           FROM document_facts f
          WHERE f.account_id = $1 AND f.file_id = ANY($2::int[]) AND f.status = 'active') x
        WHERE rang <= 10 AND value IS NOT NULL ORDER BY file_id, rang`,
      [accountId, ids] as never[],
    ) as unknown as Promise<Row[]>,
    pgClient.unsafe(
      `SELECT file_id, left(regexp_replace(COALESCE(full_text, description, ''), '\\s+', ' ', 'g'), 300) AS excerpt
         FROM document_extractions WHERE account_id = $1 AND file_id = ANY($2::int[])`,
      [accountId, ids] as never[],
    ) as unknown as Promise<Row[]>,
    pgClient.unsafe(
      `SELECT file_id, id, type_code, status FROM (
         SELECT s.source_entity_key::int AS file_id, o.id, o.type_code, o.status,
                row_number() OVER (PARTITION BY s.source_entity_key ORDER BY o.id) AS rang
           FROM business_operation_sources s
           JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id AND o.invalidated_at IS NULL
          WHERE s.account_id = $1 AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = ANY($2::text[])) x
        WHERE rang <= 3 ORDER BY file_id, id`,
      [accountId, ids.map(String)] as never[],
    ).catch(() => []) as unknown as Promise<Row[]>,
    pgClient.unsafe(
      `SELECT file_id, old_name, applied_name, created_at FROM (
         SELECT file_id, old_name, applied_name, created_at, row_number() OVER (PARTITION BY file_id ORDER BY id DESC) AS rang
           FROM document_rename_events WHERE account_id = $1 AND file_id = ANY($2::int[]) AND outcome = 'APPLIED') x
        WHERE rang <= 3`,
      [accountId, ids] as never[],
    ) as unknown as Promise<Row[]>,
    pgClient.unsafe(
      `SELECT file_id, old_title, new_title, created_at, origin FROM (
         SELECT file_id, old_title, new_title, created_at, origin, row_number() OVER (PARTITION BY file_id ORDER BY id DESC) AS rang
           FROM document_title_events WHERE account_id = $1 AND file_id = ANY($2::int[]) AND outcome = 'UPDATED') x
        WHERE rang <= 3`,
      [accountId, ids] as never[],
    ).catch(() => []) as unknown as Promise<Row[]>,
  ]);
  for (const r of faits) out.get(Number(r.file_id))?.facts.push({ key: String(r.key), value: String(r.value).slice(0, 160), period: s(r.period) });
  for (const r of extraits) { const d = out.get(Number(r.file_id)); if (d) d.excerpt = s(r.excerpt) || null; }
  for (const r of ops) out.get(Number(r.file_id))?.operations.push({ id: Number(r.id), type: s(r.type_code), status: String(r.status) });
  for (const r of histo) out.get(Number(r.file_id))?.history.push({ at: iso(r.created_at)!, from: s(r.old_name), to: s(r.applied_name), origin: 'T3_HARMONIZATION' });
  for (const r of titres) out.get(Number(r.file_id))?.history.push({ at: iso(r.created_at)!, from: s(r.old_title), to: s(r.new_title), origin: String(r.origin) });
  for (const d of out.values()) d.history.sort((a, b) => (a.at < b.at ? 1 : -1)).splice(3);
  return out;
}

/**
 * Données connues d'un document (garde « aucune invention ») : date, périodes
 * et valeurs des faits, montant, titre et texte d'extraction (borné), bien,
 * fournisseur, nom déposé.
 */
export async function loadKnownData(accountId: number, doc: NamingDoc): Promise<KnownDocumentData> {
  const [faits, ext] = await Promise.all([
    pgClient.unsafe(
      `SELECT COALESCE(value_text, normalized_value, value_number::text) AS v, label,
              to_char(period_start, 'YYYY-MM-DD') AS ps, to_char(period_end, 'YYYY-MM-DD') AS pe
         FROM document_facts WHERE account_id = $1 AND file_id = $2 AND status = 'active' ORDER BY id LIMIT 300`,
      [accountId, doc.id] as never[],
    ) as unknown as Promise<Row[]>,
    pgClient.unsafe(
      `SELECT title, description, supplier_name, to_char(document_date, 'YYYY-MM-DD') AS d, amount_cents, left(COALESCE(full_text, ''), 60000) AS txt
         FROM document_extractions WHERE account_id = $1 AND file_id = $2`,
      [accountId, doc.id] as never[],
    ) as unknown as Promise<Row[]>,
  ]);
  const e = ext[0];
  const textes = [
    doc.extractionTitle, doc.supplier, doc.assetName, doc.originalName,
    s(e?.title), s(e?.description), s(e?.supplier_name), s(e?.txt),
    ...faits.flatMap((f) => [s(f.v), s(f.label)]),
  ].filter((t): t is string => !!t && t.trim().length > 0);
  return {
    dates: [doc.documentDate, s(e?.d)].filter((x): x is string => !!x),
    periods: faits.filter((f) => f.ps || f.pe).map((f) => ({ start: s(f.ps), end: s(f.pe) })),
    amountsCents: [doc.amountCents, n(e?.amount_cents)].filter((x): x is number => x != null),
    texts: textes,
  };
}

// ── État des lots ───────────────────────────────────────────────────────────

export type GroupStatus = 'DONE' | 'IN_PROGRESS' | 'DEFERRED' | 'ERROR' | 'PROMPT_UNAVAILABLE';
export interface GroupProgress { nextChunk: number; chunks: number; examined: number[]; startedAt: string }
export interface GroupState {
  key: string;
  status: GroupStatus;
  fingerprint: string | null;
  progress: GroupProgress | null;
  /** Empreinte de chaque document au dernier examen complet (`docSnapshotHash`). */
  snapshot: Record<string, string> | null;
  conventions: unknown[];
  promptVersion: string | null;
  lastReviewedAt: string | null;
  retryAfter: string | null;
  attempts: number;
}

export async function loadGroupStates(accountId: number): Promise<Map<string, GroupState>> {
  const rows = (await pgClient.unsafe(
    `SELECT group_key, status, fingerprint, progress, snapshot, conventions, prompt_version, last_reviewed_at, retry_after, attempts
       FROM document_naming_groups WHERE account_id = $1`,
    [accountId] as never[],
  )) as unknown as Row[];
  return new Map(rows.map((r) => [String(r.group_key), {
    key: String(r.group_key), status: String(r.status) as GroupStatus, fingerprint: s(r.fingerprint),
    progress: (r.progress as GroupProgress | null) ?? null, snapshot: (r.snapshot as Record<string, string> | null) ?? null,
    conventions: Array.isArray(r.conventions) ? r.conventions as unknown[] : [],
    promptVersion: s(r.prompt_version), lastReviewedAt: iso(r.last_reviewed_at), retryAfter: iso(r.retry_after), attempts: Number(r.attempts ?? 0),
  }]));
}

export async function saveGroupState(accountId: number, st: Omit<GroupState, 'lastReviewedAt'> & { documentCount: number; lastError?: string | null; reviewed?: boolean }): Promise<void> {
  await pgClient.unsafe(
    `INSERT INTO document_naming_groups (account_id, group_key, status, fingerprint, document_count, progress, snapshot, conventions, prompt_version,
                                         last_reviewed_at, retry_after, last_error, attempts)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $13::jsonb, $7::jsonb, $8, CASE WHEN $9::boolean THEN now() END, $10::timestamptz, $11, $12)
     ON CONFLICT (account_id, group_key) DO UPDATE SET
       status = EXCLUDED.status, fingerprint = EXCLUDED.fingerprint, document_count = EXCLUDED.document_count,
       progress = EXCLUDED.progress, snapshot = EXCLUDED.snapshot, conventions = EXCLUDED.conventions, prompt_version = EXCLUDED.prompt_version,
       last_reviewed_at = COALESCE(EXCLUDED.last_reviewed_at, document_naming_groups.last_reviewed_at),
       retry_after = EXCLUDED.retry_after, last_error = EXCLUDED.last_error, attempts = EXCLUDED.attempts, updated_at = now()`,
    [accountId, st.key, st.status, st.fingerprint, st.documentCount, st.progress ? JSON.stringify(st.progress) : null,
      JSON.stringify(st.conventions ?? []), st.promptVersion, st.reviewed === true, st.retryAfter, st.lastError ?? null, st.attempts,
      st.snapshot ? JSON.stringify(st.snapshot) : null] as never[],
  );
}

// ── Journal et écriture ────────────────────────────────────────────────────

export type RenameOutcome = 'APPLIED' | 'REFUSED' | 'CONFLICT' | 'NO_CHANGE' | 'FAILED';
export interface RenameEvent {
  accountId: number;
  fileId: number;
  groupKey: string;
  accountRunId: number | null;
  outcome: RenameOutcome;
  reasonCode: string | null;
  oldName: string | null;
  expectedName: string;
  proposedName: string;
  appliedName: string | null;
  referenceIds: number[];
  aiReason: string;
  confidence: string;
  nameOrigin: NameOrigin;
  documentFingerprint: string;
  promptVersion: string | null;
  traceId: string | null;
  /** Empreinte de l'appel (lot + partie) : clé d'idempotence avec le document et les noms. */
  callKey: string;
}

export function renameIdempotencyKey(e: Pick<RenameEvent, 'accountId' | 'fileId' | 'expectedName' | 'proposedName' | 'callKey' | 'outcome'>): string {
  return createHash('sha256').update(JSON.stringify([e.accountId, e.fileId, e.expectedName, e.proposedName, e.callKey, e.outcome === 'APPLIED'])).digest('hex');
}

const EVENT_COLS = `account_id, file_id, group_key, account_run_id, origin, outcome, reason_code, old_name, expected_name, proposed_name,
  applied_name, reference_document_ids, ai_reason, confidence, name_origin, document_fingerprint, prompt_version, trace_id, idempotency_key`;
const eventParams = (e: RenameEvent) => [
  e.accountId, e.fileId, e.groupKey, e.accountRunId, 'T3_HARMONIZATION', e.outcome, e.reasonCode, e.oldName, e.expectedName.slice(0, 500),
  e.proposedName.slice(0, 500), e.appliedName, e.referenceIds, e.aiReason.slice(0, 400), e.confidence, e.nameOrigin, e.documentFingerprint,
  e.promptVersion, e.traceId, renameIdempotencyKey(e),
];
const EVENT_VALUES = '$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::int[],$13,$14,$15,$16,$17,$18,$19';

/** Journalise une issue SANS écriture du nom (refus, conflit, équivalent, échec). Rend l'identifiant, ou null (déjà journalisé). */
export async function recordRenameEvent(e: RenameEvent): Promise<number | null> {
  const rows = (await pgClient.unsafe(
    `INSERT INTO document_rename_events (${EVENT_COLS}) VALUES (${EVENT_VALUES})
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    eventParams(e) as never[],
  )) as unknown as Row[];
  return rows[0] ? Number(rows[0].id) : null;
}

export type ApplyResult =
  | { status: 'APPLIED'; eventId: number }
  | { status: 'CONFLICT'; reason: 'CONCURRENT_USER_RENAME' | 'CONCURRENT_NAME_CHANGE' | 'DOCUMENT_GONE'; currentName: string | null }
  | { status: 'ALREADY_APPLIED' };

/**
 * Écrit le nom harmonisé sous compare-and-swap et le journalise, dans UNE
 * transaction (jamais l'un sans l'autre).
 */
export async function applyRename(e: RenameEvent & { appliedName: string }): Promise<ApplyResult> {
  let res: ApplyResult | null = null;
  await pgClient.begin(async (tx) => {
    const up = (await tx.unsafe(
      `UPDATE asset_files
          SET retained_title = $3, title_source = 'SYSTEM', title_checked_at = now(), updated_at = now()
        WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL
          AND title_source = 'SYSTEM'
          AND NOT COALESCE((user_edited_fields ->> 'retainedTitle') = 'true', false)
          AND retained_title IS NOT DISTINCT FROM $4::text
        RETURNING id`,
      [e.fileId, e.accountId, e.appliedName, e.oldName] as never[],
    )) as unknown as Row[];
    if (!up.length) return;
    const ev = (await tx.unsafe(
      `INSERT INTO document_rename_events (${EVENT_COLS}) VALUES (${EVENT_VALUES})
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      eventParams({ ...e, outcome: 'APPLIED' }) as never[],
    )) as unknown as Row[];
    // Même décision déjà journalisée (reprise) : aucune écriture sans trace — annulation.
    if (!ev.length) throw new AlreadyApplied();
    res = { status: 'APPLIED', eventId: Number(ev[0].id) };
  }).catch((err) => { if (err instanceof AlreadyApplied) res = { status: 'ALREADY_APPLIED' }; else throw err; });
  if (res) return res;
  const [apres] = (await pgClient.unsafe(
    `SELECT retained_title, title_source, COALESCE((user_edited_fields ->> 'retainedTitle') = 'true', false) AS legacy
       FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
    [e.fileId, e.accountId] as never[],
  )) as unknown as Row[];
  if (!apres) return { status: 'CONFLICT', reason: 'DOCUMENT_GONE', currentName: null };
  if (apres.title_source === 'USER' || apres.legacy === true) return { status: 'CONFLICT', reason: 'CONCURRENT_USER_RENAME', currentName: s(apres.retained_title) };
  return { status: 'CONFLICT', reason: 'CONCURRENT_NAME_CHANGE', currentName: s(apres.retained_title) };
}
class AlreadyApplied extends Error { constructor() { super('renommage déjà journalisé'); } }

/** Relecture du journal transactionnel : renommages APPLIED réellement présents (confirmation du rapport). */
export async function confirmedRenames(accountId: number, eventIds: readonly number[]): Promise<Map<number, { fileId: number; appliedName: string }>> {
  if (!eventIds.length) return new Map();
  const rows = (await pgClient.unsafe(
    `SELECT id, file_id, applied_name FROM document_rename_events WHERE account_id = $1 AND id = ANY($2::bigint[]) AND outcome = 'APPLIED'`,
    [accountId, eventIds] as never[],
  )) as unknown as Row[];
  return new Map(rows.map((r) => [Number(r.id), { fileId: Number(r.file_id), appliedName: String(r.applied_name) }]));
}

/** Appels DOCUMENT_NAMING du compte sur 24 h glissantes (traces de la passerelle). */
export async function namingCallsLastDay(accountId: number): Promise<number> {
  const [r] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM ai_usage_event
      WHERE account_id = $1 AND operation_code = 't3_document_naming' AND created_at > now() - interval '24 hours'`,
    [accountId] as never[],
  ).catch(() => [{ n: 0 }])) as unknown as Array<{ n: number }>;
  return Number(r?.n ?? 0);
}
