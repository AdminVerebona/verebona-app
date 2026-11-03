/**
 * Lectures et application des décisions d'équivalence Agenda — lot 106A
 * (ticket P1 « Agenda — doublons DPE non autoréparés »).
 *
 *   · `loadAssetEquivalenceInput` : éléments d'UN bien (toutes origines),
 *     documents liés et leurs faits T1 actifs, fiche du bien — lectures
 *     groupées, aucune IA ;
 *   · `applyAssetEquivalence` : relecture SOUS VERROU (39102, même espace que
 *     les consolidations 76H / 87B), décisions recalculées, puis pour chaque
 *     groupe CERTAIN : absorption par le mécanisme EXISTANT
 *     (`absorbEquivalentItemsInTx`, journal 0591 restaurable, retrait tracé
 *     0223, mémoire anti-recréation T4), intitulé non informatif remplacé,
 *     preuve de réalisation de la même occurrence reportée, décision et état
 *     AVANT / APRÈS au journal `agenda_equivalence_decisions` — tout ou rien
 *     par bien, idempotent (un second passage ne trouve plus rien) ;
 *   · `recordUncertainGroups` : FILE DURABLE des groupes incertains (une
 *     ligne par empreinte), consultée par le diagnostic ; la réévaluation T4
 *     ciblée passe par l'orchestration EXISTANTE (`reevaluateRepresentation`)
 *     quand une Opération est concernée, sinon le groupe reste un constat
 *     qualifié (contrat T4 sans Opération à livrer — bloc PO), sans fusion.
 */
import type postgres from 'postgres';
import { resolveEventSemantics } from '../agenda-functional-key';
import { corroborationsOf, decideAsset, type EqAsset, type EqDocument, type EqItem, type GroupDecision } from './model';
import { OCCURRENCE_DATE_FIELDS, STABLE_REFERENCE_FIELDS } from './rules';

/** Liste SQL littérale de constantes du code (jamais une donnée utilisateur). */
const litteraux = (l: readonly string[]): string => (l.length ? l.map((x) => `'${x.replace(/'/g, "''")}'`).join(', ') : `''`);

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type Row = Record<string, unknown>;

/** Événements qui prouvent un geste de l'utilisateur (même liste que 103D). */
const USER_TOUCH_EVENTS = ['STATUS_CHANGED', 'USER_MODIFIED', 'USER_CONFIRMED'];
/** Motif journalisé des absorptions de ce contrôle (journal 0591). */
export const EQUIVALENCE_CONSOLIDATION_REASON = 'COHERENCE_EQUIVALENT_REPRESENTATION';

const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((x) => Number.isSafeInteger(x) && x > 0) : []);
const txt = (v: unknown): string | null => (v == null ? null : String(v));
const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;

let pret: { ready: boolean; at: number } | null = null;

/** Journal 0591 (origine COHERENCE admise) et table 1000 présents ? (cache 5 min ; ne lève jamais) */
export async function equivalenceJournalReady(sql: Sql): Promise<boolean> {
  if (pret && (pret.ready || Date.now() - pret.at < 5 * 60_000)) return pret.ready;
  let ready = false;
  try {
    const [r] = await sql<{ t: boolean; c: boolean; trace: boolean }[]>`
      SELECT to_regclass('agenda_equivalence_decisions') IS NOT NULL AS t,
             to_regclass('agenda_item_removals') IS NOT NULL AS trace,
             EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
                      WHERE t.relname = 'agenda_intervention_consolidations' AND c.conname = 'agenda_intervention_consolidations_origin_chk'
                        AND pg_get_constraintdef(c.oid) LIKE '%COHERENCE%') AS c`;
    ready = r?.t === true && r?.c === true && r?.trace === true;
  } catch { ready = false; }
  if (!ready && (!pret || pret.ready)) {
    console.error('[agenda-equivalence] migration 1000 absente : aucune consolidation de représentations équivalentes (constat seulement).');
  }
  pret = { ready, at: Date.now() };
  return ready;
}

/**
 * Biens du compte portant au moins deux faits réalisés (HISTORICAL) datés du
 * même jour — préfiltre SQL large (toutes origines, tous types) ; la décision
 * fine est celle du modèle pur. `extra` : filtre additionnel (`a` = bien).
 */
export async function assetsWithCandidateGroups(sql: Sql, accountId: number, extra = 'AND a.id > $2', params: unknown[] = [0], limit = 500): Promise<number[]> {
  const { historicalSql } = await import('../agenda-historical');
  const r = await sql.unsafe<Row[]>(
    `SELECT a.id FROM assets a
      WHERE a.account_id = $1 AND a.deleted_at IS NULL ${extra}
        AND (EXISTS (SELECT 1 FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = a.account_id
                     WHERE l.asset_id = a.id AND i.start_date IS NOT NULL AND COALESCE(i.manual_status, '') <> 'annule' AND ${historicalSql('i')}
                     GROUP BY i.start_date HAVING count(*) >= 2)
             OR EXISTS (${corroborationCandidateSql('a')}))
      ORDER BY a.id LIMIT ${Math.max(1, Math.min(limit, 5000))}`,
    [accountId, ...params] as never[]);
  return r.map((x) => Number(x.id));
}

/**
 * Préfiltre « preuve à réunir » (bien `a`) : un élément d'un type à référence
 * stable et un document du bien qui porte, à la même date, le fait de date du
 * type ET une référence stable, sans lui être lié. La décision fine (même
 * référence) reste celle du modèle pur.
 */
function corroborationCandidateSql(a: string): string {
  const types = Object.keys(STABLE_REFERENCE_FIELDS);
  const refs = [...new Set(Object.values(STABLE_REFERENCE_FIELDS).flat())];
  const dates = [...new Set(Object.values(OCCURRENCE_DATE_FIELDS).flat())];
  return `SELECT 1 FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = ${a}.account_id
           WHERE l.asset_id = ${a}.id AND i.start_date IS NOT NULL AND i.business_type IN (${litteraux(types)})
             AND EXISTS (SELECT 1 FROM document_facts d JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id AND f.deleted_at IS NULL
                          WHERE d.account_id = ${a}.account_id AND d.status = 'active' AND d.canonical_key IN (${litteraux(dates)})
                            AND left(COALESCE(d.normalized_value, d.value_text), 10) = i.start_date::text
                            AND (f.asset_id = ${a}.id OR f.linked_asset_id = ${a}.id
                                 OR EXISTS (SELECT 1 FROM document_asset_links dl WHERE dl.file_id = f.id AND dl.status = 'ACTIVE' AND dl.asset_id = ${a}.id))
                            AND NOT EXISTS (SELECT 1 FROM agenda_file_links fl WHERE fl.agenda_item_id = i.id AND fl.asset_file_id = f.id)
                            AND EXISTS (SELECT 1 FROM document_facts r WHERE r.account_id = d.account_id AND r.file_id = d.file_id AND r.status = 'active'
                                         AND r.canonical_key IN (${litteraux(refs)})))`;
}

export interface AssetEquivalenceInput {
  asset: EqAsset; items: EqItem[]; docs: Map<number, EqDocument>;
  /** Documents du bien portant une référence stable (preuves possibles d'une occurrence). */
  assetDocIds: number[];
}

/** Entrées du modèle pour UN bien (lecture seule) ; null : bien absent. */
export async function loadAssetEquivalenceInput(sql: Sql | Tx, accountId: number, assetId: number): Promise<AssetEquivalenceInput | null> {
  const [a] = await sql.unsafe<Row[]>(`SELECT id, name, key_characteristics FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [assetId, accountId] as never[]);
  if (!a) return null;
  const kcBrut = a.key_characteristics;
  const fields = (typeof kcBrut === 'string' ? JSON.parse(kcBrut) : kcBrut ?? {}) as Record<string, unknown>;
  const { agendaCompletionColumnsReady } = await import('../agenda-columns');
  const preuve = await agendaCompletionColumnsReady();
  const journal = (await sql.unsafe<Row[]>(`SELECT to_regclass('agenda_intervention_consolidations') IS NOT NULL AS ok`))[0]?.ok === true;
  const r = await sql.unsafe<Row[]>(`
    SELECT i.id, i.title, i.start_date::text AS date, i.event_nature, i.business_type, i.origin_type, i.origin_field_key, i.functional_key,
           CASE WHEN i.origin_ref_type = 'asset_file' THEN i.origin_ref_id END AS origin_file_id,
           ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[CASE WHEN i.origin_ref_type = 'asset_file' THEN i.origin_ref_id END]
                   || ARRAY(SELECT s.asset_file_id FROM agenda_item_sources s WHERE s.agenda_item_id = i.id AND s.asset_file_id IS NOT NULL)
                   || ARRAY(SELECT l.asset_file_id FROM agenda_file_links l WHERE l.agenda_item_id = i.id)) x
                 WHERE x IS NOT NULL ORDER BY x) AS file_ids,
           ARRAY(SELECT e.equipment_id FROM agenda_equipment_links e WHERE e.agenda_item_id = i.id ORDER BY 1) AS equipment_ids,
           i.is_automatic, COALESCE(i.is_automatic_modified, false) AS modified, NULLIF(i.manual_status, '') AS manual_status, i.confirmation_mode,
           COALESCE(i.requires_qualification, false) AS rq, i.occurrence_nature, (i.projection_origin IS NOT DISTINCT FROM 'OPERATION') AS projected,
           i.business_operation_id, (lo.id IS NOT NULL AND lo.invalidated_at IS NULL AND lo.merged_into_operation_id IS NULL) AS op_active,
           ${preuve ? 'i.completion_proof_file_id' : 'NULL::int'} AS proof,
           EXISTS (SELECT 1 FROM agenda_occurrence_events e WHERE e.agenda_item_id = i.id AND e.event_type = ANY($3::text[])) AS user_touch,
           EXISTS (SELECT 1 FROM agenda_occurrence_events e WHERE e.agenda_item_id = i.id AND e.event_type = 'STATUS_AUTO_COMPLETED') AS auto_status,
           EXISTS (SELECT 1 FROM agenda_data_conflicts c WHERE c.agenda_item_id = i.id AND c.current_decision = 'pending') AS conflict,
           ${journal ? `EXISTS (SELECT 1 FROM agenda_intervention_consolidations k WHERE k.account_id = i.account_id AND k.restored_at IS NOT NULL
                          AND (k.absorbed_item_id = i.id OR (k.kind <> 'ABSORB' AND k.principal_item_id = i.id)))` : 'false'} AS restored
      FROM agenda_items i
      JOIN agenda_asset_links al ON al.agenda_item_id = i.id AND al.asset_id = $2
      LEFT JOIN business_operations lo ON lo.id = i.business_operation_id
     WHERE i.account_id = $1 AND i.start_date IS NOT NULL
     ORDER BY i.id`, [accountId, assetId, USER_TOUCH_EVENTS] as never[]);
  const items: EqItem[] = r.map((x) => {
    const originFieldKey = txt(x.origin_field_key);
    const sem = resolveEventSemantics({ originFieldKey, businessType: txt(x.business_type), nature: (txt(x.event_nature) as 'HISTORICAL' | 'DEADLINE' | null) });
    return {
      id: Number(x.id), title: String(x.title ?? ''), date: day(x.date), nature: sem.nature, businessType: sem.businessType,
      originType: txt(x.origin_type), originFieldKey, functionalKey: txt(x.functional_key),
      originFileId: x.origin_file_id == null ? null : Number(x.origin_file_id), fileIds: nums(x.file_ids), equipmentIds: nums(x.equipment_ids),
      isAutomatic: x.is_automatic === true, isAutomaticModified: x.modified === true, manualStatus: txt(x.manual_status), confirmationMode: txt(x.confirmation_mode),
      requiresQualification: x.rq === true, occurrenceNature: txt(x.occurrence_nature), projected: x.projected === true,
      operationId: x.business_operation_id == null ? null : Number(x.business_operation_id), operationActive: x.op_active === true,
      completionProofFileId: x.proof == null ? null : Number(x.proof), userTouchEvent: x.user_touch === true, autoStatusEvent: x.auto_status === true,
      pendingConflict: x.conflict === true, restored: x.restored === true,
    };
  });
  const refKeys = [...new Set(Object.values(STABLE_REFERENCE_FIELDS).flat())];
  const assetDocIds = refKeys.length ? (await sql.unsafe<Row[]>(
    `SELECT f.id FROM asset_files f
      WHERE f.account_id = $1 AND f.deleted_at IS NULL
        AND (f.asset_id = $2 OR f.linked_asset_id = $2
             OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.asset_id = $2))
        AND EXISTS (SELECT 1 FROM document_facts d WHERE d.account_id = f.account_id AND d.file_id = f.id AND d.status = 'active' AND d.canonical_key = ANY($3::text[]))
      ORDER BY f.id LIMIT 200`, [accountId, assetId, refKeys] as never[])).map((x) => Number(x.id)) : [];
  const fileIds = [...new Set([...items.flatMap((i) => i.fileIds), ...assetDocIds])];
  const docs = new Map<number, EqDocument>();
  if (fileIds.length) {
    const fs = await sql.unsafe<Row[]>(
      `SELECT f.id, COALESCE(f.retained_title, f.original_filename) AS title, COALESCE(f.document_type_code, f.document_type) AS type_code, f.document_date::text AS d
         FROM asset_files f WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND f.deleted_at IS NULL`, [accountId, intArray(fileIds)] as never[]);
    for (const f of fs) docs.set(Number(f.id), { fileId: Number(f.id), title: txt(f.title), documentTypeCode: txt(f.type_code), documentDate: day(f.d), facts: [] });
    const facts = await sql.unsafe<Row[]>(
      `SELECT file_id, canonical_key, COALESCE(normalized_value, value_text, value_number::text) AS v, subject, semantic_event_type, semantic_event_nature
         FROM document_facts WHERE account_id = $1 AND file_id = ANY($2::int[]) AND status = 'active' ORDER BY id`, [accountId, intArray([...docs.keys()])] as never[]);
    for (const f of facts) {
      docs.get(Number(f.file_id))?.facts.push({
        canonicalKey: txt(f.canonical_key), value: txt(f.v), subject: txt(f.subject), semanticType: txt(f.semantic_event_type), semanticNature: txt(f.semantic_event_nature),
      });
    }
  }
  // Un document supprimé n'est plus une preuve : retiré des documents de l'élément.
  for (const i of items) i.fileIds = i.fileIds.filter((f) => docs.has(f));
  return { asset: { assetId, name: String(a.name ?? ''), fields }, items, docs, assetDocIds: assetDocIds.filter((f) => docs.has(f)) };
}

/** Décisions (lecture seule) d'un bien ; null : bien absent. */
export async function diagnoseAssetEquivalence(sql: Sql, accountId: number, assetId: number): Promise<{
  input: AssetEquivalenceInput; decisions: GroupDecision[]; corroborations: Array<{ itemId: number; fileId: number; reference: string }>;
} | null> {
  const input = await loadAssetEquivalenceInput(sql, accountId, assetId);
  if (!input) return null;
  const decisions = decideAsset(input.items, input.docs, input.asset);
  const corroborations = await withoutRejectedLinks(sql, corroborationsOf(input.items, input.docs, input.asset, input.assetDocIds, decisions));
  return { input, decisions, corroborations };
}

/** Écarte les liens élément ↔ document que l'utilisateur a détachés (mémoire 82D). */
async function withoutRejectedLinks<T extends { itemId: number; fileId: number }>(sql: Sql | Tx, l: T[]): Promise<T[]> {
  if (!l.length) return l;
  const { linkRejectedSql } = await import('@/services/business-operations/grouping/decisions');
  const out: T[] = [];
  for (const c of l) {
    const [r] = await sql.unsafe<Row[]>(`SELECT ${linkRejectedSql('$1::int', '$2::int')} AS refuse`, [c.itemId, c.fileId] as never[]);
    if (r?.refuse !== true) out.push(c);
  }
  return out;
}

/** État borné d'un groupe (avant / après) : identifiants, intitulés, statuts, documents — jamais de contenu. */
function etatGroupe(items: readonly EqItem[], ids: readonly number[]): Array<Record<string, unknown>> {
  return ids.map((id) => items.find((i) => i.id === id)).filter((i): i is EqItem => !!i).map((i) => ({
    id: i.id, title: i.title, date: i.date, businessType: i.businessType, originType: i.originType, originFieldKey: i.originFieldKey,
    manualStatus: i.manualStatus, completionProofFileId: i.completionProofFileId, fileIds: i.fileIds,
  }));
}

export interface AppliedGroup {
  groupKey: string;
  verdict: 'CONSOLIDATED' | 'PROTECTED' | 'FAILED';
  canonicalId: number | null;
  absorbed: number[];
  protectedIds: number[];
  retitled: boolean;
  proofCarried: boolean;
  decisionId: number | null;
}

/**
 * Applique les groupes CERTAINS d'un bien (voir l'en-tête), tout ou rien.
 * Lève sur une erreur technique (transaction annulée, aucune écriture).
 */
export async function applyAssetEquivalence(sql: Sql, accountId: number, assetId: number, opts: {
  correlationId: string; campaignId?: number | null; trigger?: string | null; runId?: string | null;
}): Promise<{ applied: AppliedGroup[]; attached?: Array<{ itemId: number; fileId: number; closedCards: number }>; skipped?: 'JOURNAL_MISSING' | 'ASSET_GONE' }> {
  if (!(await equivalenceJournalReady(sql))) return { applied: [], skipped: 'JOURNAL_MISSING' };
  // Identifiant d'exécution : toutes les lignes 0591 de ce passage se restaurent ensemble (`restoreAgendaConsolidations({ runId })`).
  const { randomUUID } = await import('node:crypto');
  opts = { ...opts, runId: opts.runId ?? randomUUID() };
  const { absorbEquivalentItemsInTx, retitleEquivalentInTx, AGENDA_CONSOLIDATION_LOCK_SPACE } = await import('@/services/business-operations/agenda-projection/consolidation');
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${AGENDA_CONSOLIDATION_LOCK_SPACE}::int, ${accountId}::int)`;
    const input = await loadAssetEquivalenceInput(tx, accountId, assetId);
    if (!input) return { applied: [], skipped: 'ASSET_GONE' as const };
    const decisions = decideAsset(input.items, input.docs, input.asset).filter((d) => d.verdict === 'CONSOLIDATE');
    const applied: AppliedGroup[] = [];
    for (const d of decisions) {
      const before = etatGroupe(input.items, [...d.group.memberIds, ...d.group.genericIds]);
      const r = await absorbEquivalentItemsInTx(tx, {
        accountId, principalId: d.canonicalId!, absorbedIds: d.absorbIds, reason: EQUIVALENCE_CONSOLIDATION_REASON, runId: opts.runId ?? null, correlationId: opts.correlationId,
      });
      let retitled = false;
      if (r.absorbed.length && d.retitle) {
        retitled = await retitleEquivalentInTx(tx, { accountId, itemId: d.canonicalId!, from: d.retitle.from, to: d.retitle.to, reason: EQUIVALENCE_CONSOLIDATION_REASON, runId: opts.runId ?? null, correlationId: opts.correlationId });
      }
      let proofCarried = false;
      if (r.absorbed.length && d.proofFileId) proofCarried = await carryProofInTx(tx, accountId, d.canonicalId!, d.proofFileId, opts.correlationId);
      const after = await tx.unsafe<Row[]>(
        `SELECT i.id, i.title, i.start_date::text AS date, NULLIF(i.manual_status, '') AS manual_status,
                ARRAY(SELECT l.asset_file_id FROM agenda_file_links l WHERE l.agenda_item_id = i.id ORDER BY 1) AS file_ids
           FROM agenda_items i WHERE i.account_id = $1 AND i.id = ANY($2::int[]) ORDER BY i.id`,
        [accountId, intArray([...d.group.memberIds, ...d.group.genericIds])] as never[]);
      const verdict = r.absorbed.length ? 'CONSOLIDATED' : 'PROTECTED';
      const [row] = await tx.unsafe<Row[]>(
        `INSERT INTO agenda_equivalence_decisions
           (account_id, asset_id, group_key, fingerprint, verdict, reason, canonical_item_id, member_item_ids, absorbed_item_ids, absorbed_functional_keys,
            protected_item_ids, evidence, before_state, after_state, correlation_id, campaign_id, trigger, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::int[], $9::int[], $10::text[], $11::int[], $12::text::jsonb, $13::text::jsonb, $14::text::jsonb, $15, $16, $17, now())
         RETURNING id`,
        [accountId, assetId, d.group.key, d.fingerprint, verdict, d.reason, d.canonicalId, intArray([...d.group.memberIds, ...d.group.genericIds]),
          intArray(r.absorbed), r.functionalKeys, intArray([...r.protectedIds, ...d.kept.map((k) => k.id)]),
          JSON.stringify({ ...d.evidence, kept: d.kept, retitle: d.retitle, proofFileId: d.proofFileId, rulesVersion: 1, runId: opts.runId }),
          JSON.stringify({ items: before }), JSON.stringify({ items: after.map((x) => ({ id: Number(x.id), title: x.title, date: x.date, manualStatus: x.manual_status, fileIds: nums(x.file_ids) })), retitled, proofCarried }),
          opts.correlationId, opts.campaignId ?? null, opts.trigger ?? null] as never[]);
      applied.push({ groupKey: d.group.key, verdict, canonicalId: d.canonicalId, absorbed: r.absorbed, protectedIds: r.protectedIds, retitled, proofCarried, decisionId: row ? Number(row.id) : null });
      console.info(JSON.stringify({
        event: 'agenda.equivalence_consolidated', accountId, assetId, groupKey: d.group.key, canonicalId: d.canonicalId, absorbed: r.absorbed,
        protected: r.protectedIds, retitled, proofCarried, reason: d.reason, correlationId: opts.correlationId,
      }));
    }
    // Preuves réunies (état APRÈS consolidation, relu) : documents décrivant la même occurrence.
    const apres = await loadAssetEquivalenceInput(tx, accountId, assetId);
    const corroborations = apres
      ? await withoutRejectedLinks(tx, corroborationsOf(apres.items, apres.docs, apres.asset, apres.assetDocIds, decideAsset(apres.items, apres.docs, apres.asset)))
      : [];
    const attached: Array<{ itemId: number; fileId: number; closedCards: number }> = [];
    for (const c of corroborations) {
      const closed = await attachProofInTx(tx, accountId, c.itemId, c.fileId, opts.correlationId, c.reference);
      attached.push({ itemId: c.itemId, fileId: c.fileId, closedCards: closed });
    }
    return { applied, attached };
  }) as Promise<{ applied: AppliedGroup[]; attached?: Array<{ itemId: number; fileId: number; closedCards: number }>; skipped?: 'JOURNAL_MISSING' | 'ASSET_GONE' }>;
}

/**
 * Document décrivant la MÊME occurrence (même référence stable, même date)
 * rattaché comme preuve SOURCE de son unique représentation : lien affiché
 * (provenance AI_DIRECT) + trace `agenda_item_sources`, cartes « Ajouter à
 * l'agenda ? » ouvertes de ce document pour ce fait closes (OBSOLETE, tracé :
 * l'occurrence est déjà à l'agenda). Idempotent. Rend le nombre de cartes closes.
 */
async function attachProofInTx(tx: Tx, accountId: number, itemId: number, fileId: number, correlationId: string, reference: string): Promise<number> {
  const [item] = await tx.unsafe<Row[]>(`SELECT start_date::text AS d, origin_field_key FROM agenda_items WHERE id = $1 AND account_id = $2`, [itemId, accountId] as never[]);
  if (!item) return 0;
  await tx.unsafe(
    `INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances)
     SELECT $1, f.id, ARRAY['AI_DIRECT']::text[] FROM asset_files f WHERE f.id = $2 AND f.account_id = $3 AND f.deleted_at IS NULL
     ON CONFLICT (agenda_item_id, asset_file_id) DO UPDATE
       SET provenances = (SELECT array_agg(DISTINCT x) FROM unnest(agenda_file_links.provenances || ARRAY['AI_DIRECT']::text[]) x)`,
    [itemId, fileId, accountId] as never[]);
  await tx.unsafe(
    `INSERT INTO agenda_item_sources (agenda_item_id, asset_file_id, effect_type, source_role)
     SELECT $1, $2, 'linked', 'SOURCE'
      WHERE NOT EXISTS (SELECT 1 FROM agenda_item_sources x WHERE x.agenda_item_id = $1 AND x.asset_file_id = $2 AND x.source_role = 'SOURCE')`,
    [itemId, fileId] as never[]);
  const cartes = await tx.unsafe<Row[]>(
    `UPDATE to_process_actions a SET resolved_at = now(), resolution_reason = 'OBSOLETE', updated_at = now()
      WHERE a.account_id = $1 AND a.rule_code = 'AGENDA-PROPOSAL' AND a.target_type = 'DOCUMENT' AND a.target_id = $2 AND a.resolved_at IS NULL
        AND a.trigger_context -> 'candidate' ->> 'date' = $3
        AND COALESCE(a.trigger_context -> 'candidate' ->> 'originFieldKey', '') = COALESCE($4::text, '')
      RETURNING a.id, a.target_type, a.target_id, a.relation_key`,
    [accountId, fileId, String(item.d ?? ''), item.origin_field_key ?? null] as never[]);
  for (const c of cartes) {
    await tx.unsafe(
      `INSERT INTO to_process_action_events (action_id, account_id, event, actor_user_id, target_type, target_id, field_key, details, created_at)
       VALUES ($1, $2, 'OBSOLETE', NULL, $3, $4, $5, $6::text::jsonb, now())`,
      [c.id, accountId, c.target_type, c.target_id, c.relation_key ?? null, JSON.stringify({ ruleCode: 'AGENDA-PROPOSAL', reason: 'AGENDA_ITEM_EXISTS', agendaItemId: itemId })] as never[]);
  }
  await tx.unsafe(
    `INSERT INTO agenda_occurrence_events (agenda_item_id, account_id, event_type, detail_json) VALUES ($1, $2, 'CORROBORATING_SOURCE_ADDED', $3::text::jsonb)`,
    [itemId, accountId, JSON.stringify({ reasonCode: 'SAME_STABLE_REFERENCE', sourceFileId: fileId, reference: reference.slice(0, 4) + '…', correlationId, closedCardIds: cartes.map((c) => Number(c.id)) })] as never[]);
  return cartes.length;
}

/**
 * Preuve de réalisation d'une occurrence absorbée reportée sur le canonique
 * (même fait, identité certaine) : écriture gardée (automatique intact, sans
 * statut ni preuve), lien document requis, trace COMPLETION_PROVEN (origine
 * EQUIVALENCE). « Réalisé » reste CALCULÉ à la lecture (0945).
 */
async function carryProofInTx(tx: Tx, accountId: number, itemId: number, fileId: number, correlationId: string): Promise<boolean> {
  const { agendaCompletionColumnsReady } = await import('../agenda-columns');
  if (!(await agendaCompletionColumnsReady())) return false;
  const r = await tx.unsafe<Row[]>(
    `UPDATE agenda_items i SET completion_proof_file_id = $3, completion_proven_at = now(), updated_at = now()
      WHERE i.id = $1 AND i.account_id = $2 AND i.is_automatic AND NOT COALESCE(i.is_automatic_modified, false)
        AND (i.manual_status IS NULL OR trim(i.manual_status) = '') AND i.completion_proof_file_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM agenda_occurrence_events e WHERE e.agenda_item_id = i.id AND e.event_type = ANY($4::text[]))
        AND EXISTS (SELECT 1 FROM agenda_file_links l JOIN asset_files f ON f.id = l.asset_file_id AND f.deleted_at IS NULL AND f.account_id = $2
                     WHERE l.agenda_item_id = i.id AND l.asset_file_id = $3)
      RETURNING i.id`, [itemId, accountId, fileId, USER_TOUCH_EVENTS] as never[]);
  if (!r.length) return false;
  await tx.unsafe(
    `INSERT INTO agenda_occurrence_events (agenda_item_id, account_id, event_type, detail_json) VALUES ($1, $2, 'COMPLETION_PROVEN', $3::text::jsonb)`,
    [itemId, accountId, JSON.stringify({ origin: 'EQUIVALENCE', reasonCode: 'COMPLETION_PROOF_OF_SAME_OCCURRENCE', correlationId, proof: { fileId } })] as never[]);
  return true;
}

/**
 * File DURABLE des groupes INCERTAINS : une ligne par (groupe, empreinte) —
 * `T4_PENDING` (une Opération active est concernée : réévaluation T4 par
 * l'orchestration existante) ou `T4_UNAVAILABLE` (aucune Opération : contrat
 * T4 sans Opération à livrer, constat qualifié). Idempotent ; ne lève pas.
 */
export async function recordUncertainGroups(sql: Sql, accountId: number, assetId: number, decisions: readonly GroupDecision[], opts: {
  correlationId: string; campaignId?: number | null; trigger?: string | null;
  /** Groupes dont la décision T4 ne peut pas être demandée (contrat absent) : file T4_UNAVAILABLE même avec une Opération. */
  unavailableGroupKeys?: ReadonlySet<string>;
}): Promise<number> {
  if (!(await equivalenceJournalReady(sql))) return 0;
  let n = 0;
  for (const d of decisions.filter((x) => x.verdict === 'UNCERTAIN' || (x.uncertainIds.length > 0))) {
    const verdict = d.operationIds.length && !opts.unavailableGroupKeys?.has(d.group.key) ? 'T4_PENDING' : 'T4_UNAVAILABLE';
    try {
      const r = await sql.unsafe<Row[]>(
        `INSERT INTO agenda_equivalence_decisions (account_id, asset_id, group_key, fingerprint, verdict, reason, canonical_item_id, member_item_ids,
            protected_item_ids, evidence, before_state, operation_id, correlation_id, campaign_id, trigger, t4_last_status)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8::int[], '{}'::int[], $9::text::jsonb, $10::text::jsonb, $11, $12, $13, $14, $15
          WHERE NOT EXISTS (SELECT 1 FROM agenda_equivalence_decisions x WHERE x.account_id = $1 AND x.group_key = $3 AND x.fingerprint = $4 AND x.asset_id = $2)
         RETURNING id`,
        [accountId, assetId, d.group.key, d.fingerprint, verdict, d.reason, d.canonicalId, intArray(d.uncertainIds),
          JSON.stringify({ ...d.evidence, kept: d.kept, operationIds: d.operationIds }), JSON.stringify({ itemIds: d.uncertainIds }),
          d.operationIds[0] ?? null, opts.correlationId, opts.campaignId ?? null, opts.trigger ?? null,
          verdict === 'T4_UNAVAILABLE' ? (d.operationIds.length ? 'T4_REPRESENTATION_UNAVAILABLE' : 'CONTRACT_WITHOUT_OPERATION_MISSING') : 'QUEUED'] as never[]);
      n += r.length;
    } catch (e) {
      console.error(`[agenda-equivalence] file des groupes incertains (compte ${accountId}) :`, (e as Error).message);
    }
  }
  return n;
}
