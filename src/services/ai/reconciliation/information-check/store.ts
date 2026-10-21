/**
 * T3 — contrôle exhaustif de l'onglet « Informations » (lot 76J) : accès base.
 *
 *   · sources TRANSVERSALES de la date / du prix d'achat d'un bien : agenda
 *     (événements « achat » du bien seul), Opérations d'acquisition
 *     réalisées, candidats Opération T1 (prix ancré) — services et tables
 *     existants, lus en SQL, bornés au compte ;
 *   · matérialisation d'un prix d'achat ancré en preuve ordinaire
 *     (`recordEvidence`, règle `T3_ACQUISITION_OPERATION_PRICE`) — jamais
 *     quand le même document porte déjà une preuve du champ pour la même
 *     cible (une seule preuve par document, T3-COH-10) ; retirée si le
 *     candidat n'est plus actif ;
 *   · état du contrôle par bien (`t3_information_checks`, 0597) : version
 *     appliquée (rattrapage automatique borné du stock), synthèse, mémoire
 *     des arbitrages croisés déjà tranchés.
 *
 * Tout est tolérant : table 0597 absente → contrôle exécuté, sans
 * rattrapage ni mémoire ; colonne agenda 0223 absente → titre « achat ».
 */
import { pgClient } from '@/db';
import { envNumber } from '@/lib/env-number';
import { normalize } from '../decision/normalizers';
import { resolveAuthority } from '../decision/authority-matrix';
import { INFORMATION_CHECK_VERSION, type AgendaPurchaseObservation, type OperationAcquisitionObservation } from './inventory';
import { selectAcquisitionPrice, T3_OPERATION_PRICE_RULE, type OperationCandidateRow, type PriceTarget } from './operation-price';

type Row = Record<string, unknown>;
const q = async <T = Row>(sql: string, params: unknown[]): Promise<T[]> =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as T[];

const ids = (v: unknown): number[] => (Array.isArray(v) ? v : [])
  .map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);

/** Biens repris au plus par passage T3 du compte (rattrapage du stock). */
export const informationBackfillMaxAssets = (): number =>
  Math.min(500, Math.floor(envNumber('T3_INFORMATION_BACKFILL_MAX_ASSETS', 25, { min: 0 })));

// ── Présence des tables / colonnes ──────────────────────────────────────────

let tableEtat: { ready: boolean; at: number } | null = null;
/** Table 0597 présente ? (revérifiée toutes les 5 min tant qu'absente). Ne lève jamais. */
export async function informationChecksReady(): Promise<boolean> {
  if (tableEtat && (tableEtat.ready || Date.now() - tableEtat.at < 300_000)) return tableEtat.ready;
  let ready = false;
  try {
    const [r] = await q<{ ok: boolean }>(`SELECT to_regclass('t3_information_checks') IS NOT NULL AS ok`, []);
    ready = r?.ok === true;
  } catch { ready = false; }
  tableEtat = { ready, at: Date.now() };
  return ready;
}

async function agendaBusinessTypeReady(): Promise<boolean> {
  try {
    const { agendaFunctionalColumnsReady } = await import('@/services/agenda/agenda-columns');
    return await agendaFunctionalColumnsReady();
  } catch { return false; }
}

// ── Sources transversales ───────────────────────────────────────────────────

/**
 * Événements « achat » liés au BIEN, sans aucun équipement lié (l'achat d'un
 * équipement n'est jamais celui du bien, lot 71A), non annulés, datés.
 */
export async function loadAgendaPurchases(accountId: number, assetId: number, today = new Date().toISOString().slice(0, 10)): Promise<AgendaPurchaseObservation[]> {
  const bt = await agendaBusinessTypeReady();
  const rows = await q<{
    id: number; date: string; is_automatic: boolean; manual_status: string | null; confirmation_mode: string | null;
    origin_type: string | null; origin_ref_type: string | null; origin_ref_id: number | null; op_from_fiche: boolean | null;
    files: unknown; op_files: unknown;
  }>(
    `SELECT i.id, i.start_date::text AS date, i.is_automatic, i.manual_status, i.confirmation_mode, i.origin_type,
            i.origin_ref_type, i.origin_ref_id,
            CASE WHEN i.business_operation_id IS NULL THEN NULL ELSE (
              SELECT bool_and(s.source_kind = 'ASSET_DATA') FROM business_operation_sources s
               WHERE s.operation_id = i.business_operation_id AND s.account_id = i.account_id AND s.active) END AS op_from_fiche,
            (SELECT array_agg(DISTINCT s.asset_file_id) FROM agenda_item_sources s WHERE s.agenda_item_id = i.id) AS files,
            CASE WHEN i.business_operation_id IS NULL THEN NULL ELSE (
              SELECT array_agg(DISTINCT s.source_entity_key) FROM business_operation_sources s
               WHERE s.operation_id = i.business_operation_id AND s.account_id = i.account_id AND s.active AND s.source_kind = 'DOCUMENT') END AS op_files
       FROM agenda_items i
       JOIN agenda_asset_links l ON l.agenda_item_id = i.id AND l.asset_id = $2
      WHERE i.account_id = $1 AND i.start_date IS NOT NULL AND COALESCE(i.manual_status, '') <> 'annule'
        AND NOT EXISTS (SELECT 1 FROM agenda_equipment_links e WHERE e.agenda_item_id = i.id)
        AND ${bt ? `(i.business_type = 'purchase' OR (i.business_type IS NULL AND i.title ILIKE '%achat%'))` : `i.title ILIKE '%achat%'`}
      ORDER BY i.id LIMIT 50`,
    [accountId, assetId],
  );
  return rows.map((r) => {
    const fichiers = [...ids(r.files), ...ids(r.op_files), ...(r.origin_ref_type === 'asset_file' && r.origin_ref_id ? [Number(r.origin_ref_id)] : [])];
    // D-13 : un événement MANUEL réalisé (ou daté du passé) est une saisie ;
    // un événement AUTOMATIQUE n'est une donnée confirmée que si
    // l'utilisateur l'a marqué réalisé ou confirmé.
    const confirmed = r.is_automatic
      ? r.manual_status === 'realise' || r.confirmation_mode === 'USER'
      : r.manual_status === 'realise' || (r.date ?? '') <= today;
    return {
      source: 'AGENDA' as const, id: Number(r.id), date: String(r.date).slice(0, 10), automatic: r.is_automatic, confirmed,
      derivedFromField: r.origin_type === 'asset_field' || r.op_from_fiche === true,
      sourceFileIds: [...new Set(fichiers)],
    };
  });
}

/** Opérations d'ACQUISITION réalisées et valides du bien, sans équipement. */
export async function loadAcquisitionOperations(accountId: number, assetId: number): Promise<OperationAcquisitionObservation[]> {
  const rows = await q<{ id: number; date: string | null; kinds: unknown; files: unknown; cents: number | string | null }>(
    `SELECT o.id, o.realized_date::text AS date,
            (SELECT array_agg(DISTINCT s.source_kind) FROM business_operation_sources s WHERE s.operation_id = o.id AND s.account_id = o.account_id AND s.active) AS kinds,
            (SELECT array_agg(DISTINCT s.source_entity_key) FROM business_operation_sources s
              WHERE s.operation_id = o.id AND s.account_id = o.account_id AND s.active AND s.source_kind = 'DOCUMENT') AS files,
            (SELECT sum(COALESCE(c.amount_eur_cents, CASE WHEN c.currency = 'EUR' THEN c.amount_minor END))
               FROM business_operation_financial_components c
              WHERE c.operation_id = o.id AND c.account_id = o.account_id AND c.active AND c.kind = 'REALIZED_COST' AND c.target_equipment_id IS NULL) AS cents
       FROM business_operations o
       JOIN business_operation_asset_links al ON al.operation_id = o.id AND al.account_id = o.account_id AND al.asset_id = $2 AND al.active
      WHERE o.account_id = $1 AND o.type_code = 'ACQUISITION' AND o.status = 'REALIZED'
        AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM business_operation_equipment_links el WHERE el.operation_id = o.id AND el.active)
      ORDER BY o.id LIMIT 20`,
    [accountId, assetId],
  ).catch(() => []);
  return rows.map((r) => {
    const kinds = (Array.isArray(r.kinds) ? r.kinds : []).map(String);
    return {
      source: 'OPERATION' as const, id: Number(r.id), date: r.date ? String(r.date).slice(0, 10) : null,
      amountEur: r.cents == null ? null : Number(r.cents) / 100,
      derivedFromField: kinds.length > 0 && kinds.every((k) => k === 'ASSET_DATA'),
      sourceFileIds: ids(r.files),
    };
  });
}

// ── Prix d'achat ancré dans un candidat Opération T1 ────────────────────────

export interface PriceMaterialization {
  /** Preuves écrites (nouvelles ou réactivées). */
  recorded: Array<{ candidateId: number; target: PriceTarget; evidenceId: number }>;
  /** Candidats écartés, et pourquoi (rapport). */
  skipped: Array<{ candidateId: number; reason: string }>;
  /** Preuves dérivées retirées (candidat devenu inactif). */
  withdrawn: number;
  /** Équipements du bien qui portent une preuve dérivée active (réconciliation ciblée). */
  equipmentTargets: number[];
}

/**
 * Prix d'achat lus dans les candidats Opération des documents du bien →
 * preuves ordinaires du bien ou de SON équipement. Idempotent (empreinte de
 * preuve) ; une preuve existante du même document et de la même cible pour
 * ce champ suffit (provenance unique).
 */
export async function materializeAcquisitionPrices(p: { accountId: number; assetId: number }): Promise<PriceMaterialization> {
  const out: PriceMaterialization = { recorded: [], skipped: [], withdrawn: 0, equipmentTargets: [] };
  const [bien] = await q<{ category: string | null }>(
    `SELECT category FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [p.assetId, p.accountId],
  );
  if (!bien) return out;
  const { recordEvidence } = await import('../../evidence/field-evidence.service');

  // Preuves dérivées dont le candidat n'est plus actif : retirées (cycle de
  // vie WITHDRAWN, jamais supprimées ; `status` — décision T3 — intact). La
  // réconciliation négative retire ensuite la valeur automatique orpheline.
  const orphelines = await q<{ id: number }>(
    `UPDATE field_evidence fe SET lifecycle_status = 'WITHDRAWN', superseded_at = now()
      WHERE fe.account_id = $1 AND fe.asset_id = $2 AND fe.projection_rule = $3
        AND (fe.lifecycle_status IS NULL OR fe.lifecycle_status = 'ACTIVE')
        AND NOT EXISTS (SELECT 1 FROM document_operation_candidates c
                         WHERE c.account_id = fe.account_id AND c.status = 'ACTIVE'
                           AND c.id::text = split_part(fe.source_location->>'section', ':', 2))
      RETURNING fe.id`,
    [p.accountId, p.assetId, T3_OPERATION_PRICE_RULE],
  ).catch(() => []);
  out.withdrawn = orphelines.length;

  const equipementsDuBien = (await q<{ id: number }>(
    `SELECT id FROM equipments WHERE asset_id = $1 AND archived_at IS NULL ORDER BY id`, [p.assetId],
  )).map((e) => Number(e.id));

  const candidats = await q<{
    id: number; file_id: number; analysis_run_id: number | null; type_hint: string | null; status_hint: string | null;
    established: boolean; confidence: string; document_type: string | null; payload: unknown;
  }>(
    `SELECT c.id, c.file_id, c.analysis_run_id, c.type_hint, c.status_hint, c.established, c.confidence, f.document_type, c.payload
       FROM document_operation_candidates c
       JOIN asset_files f ON f.id = c.file_id AND f.account_id = c.account_id AND f.deleted_at IS NULL
      WHERE c.account_id = $1 AND c.status = 'ACTIVE' AND c.type_hint = 'ACQUISITION'
        AND (f.asset_id = $2 OR EXISTS (SELECT 1 FROM document_asset_links l
                                         WHERE l.file_id = f.id AND l.account_id = c.account_id AND l.asset_id = $2 AND l.status = 'ACTIVE'))
      ORDER BY c.id LIMIT 100`,
    [p.accountId, p.assetId],
  ).catch(() => []);

  for (const c of candidats) {
    const row: OperationCandidateRow = {
      id: Number(c.id), fileId: Number(c.file_id), analysisRunId: c.analysis_run_id == null ? null : Number(c.analysis_run_id),
      typeHint: c.type_hint, statusHint: c.status_hint, established: c.established, confidence: c.confidence,
      documentType: c.document_type, payload: (typeof c.payload === 'string' ? JSON.parse(c.payload) : c.payload ?? {}) as Record<string, unknown>,
    };
    const sel = selectAcquisitionPrice(row, { assetId: p.assetId, category: bien.category, equipmentIds: equipementsDuBien });
    if (!sel.ok) { out.skipped.push({ candidateId: row.id, reason: sel.reason }); continue; }
    // Provenance unique : ce document porte déjà une preuve ACTIVE du champ pour cette cible.
    const [deja] = await q<{ id: number; rule: string | null }>(
      `SELECT id, projection_rule AS rule FROM field_evidence
        WHERE account_id = $1 AND source_type = 'document' AND source_id = $2 AND status = 'active'
          AND (field_key = 'acquisitionPrice' OR canonical_key = 'acquisitionPrice')
          AND (lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE')
          AND ${sel.target.type === 'ASSET'
    ? `asset_id = $3 AND (target_type IS NULL OR (target_type = 'ASSET' AND COALESCE(target_entity_id, asset_id) = $3))`
    : `target_type = 'EQUIPMENT' AND target_entity_id = $3`}
        ORDER BY id LIMIT 1`,
      [p.accountId, row.fileId, sel.target.id],
    );
    if (deja && deja.rule !== T3_OPERATION_PRICE_RULE) { out.skipped.push({ candidateId: row.id, reason: 'SAME_DOCUMENT_EVIDENCE' }); continue; }
    const [fait] = await q<{ excerpt: string | null }>(
      `SELECT excerpt FROM document_facts WHERE id = $1 AND account_id = $2 AND file_id = $3 AND status = 'active'`,
      [sel.factId, p.accountId, row.fileId],
    );
    const extrait = (fait?.excerpt ?? '').trim();
    if (extrait.length < 3) { out.skipped.push({ candidateId: row.id, reason: 'NO_LITERAL_EXCERPT' }); continue; }
    const value = sel.amountMinor / 100;
    const evidenceId = await recordEvidence({
      accountId: p.accountId, assetId: p.assetId, fieldKey: 'acquisitionPrice', value,
      normalizedValue: normalize('acquisitionPrice', value) ?? undefined, sourceType: 'document', sourceId: row.fileId,
      // Localisation : le candidat Opération et le fait ancré (relus au retrait).
      location: { section: `operation_candidate:${row.id}:fact:${sel.factId}` }, excerpt: extrait,
      documentType: row.documentType ?? undefined, confidence: 'certain',
      authorityScore: resolveAuthority({ fieldKey: 'acquisitionPrice', documentType: row.documentType }).score,
      canonicalKey: 'acquisitionPrice', canonicalUnit: 'EUR', rawValue: String(value),
      projectionOrigin: 'DETERMINISTIC_RULE', projectionRule: T3_OPERATION_PRICE_RULE, analysisRunId: row.analysisRunId,
      target: sel.target.type === 'ASSET'
        ? { type: 'ASSET', entityId: p.assetId, label: null, confidence: 'certain' }
        : { type: 'EQUIPMENT', entityId: sel.target.id, label: null, confidence: 'certain' },
    });
    out.recorded.push({ candidateId: row.id, target: sel.target, evidenceId });
    if (sel.target.type === 'EQUIPMENT' && !out.equipmentTargets.includes(sel.target.id)) out.equipmentTargets.push(sel.target.id);
  }
  return out;
}

// ── État du contrôle par bien (0597) ────────────────────────────────────────

export interface CheckState { version: string | null; signatures: Record<string, { signature: string; at: string }> }

export async function readCheckState(accountId: number, assetId: number): Promise<CheckState> {
  if (!(await informationChecksReady())) return { version: null, signatures: {} };
  const [r] = await q<{ v: string; s: unknown }>(
    `SELECT check_version AS v, cross_signatures AS s FROM t3_information_checks WHERE asset_id = $1 AND account_id = $2`,
    [assetId, accountId],
  );
  const s = (typeof r?.s === 'string' ? JSON.parse(r.s) : r?.s ?? {}) as CheckState['signatures'];
  return { version: r?.v ?? null, signatures: s };
}

/**
 * Signature déjà proposée puis TRANCHÉE par l'utilisateur : aucune carte
 * ouverte sur le champ, et une carte du champ résolue depuis la proposition.
 */
export async function arbitratedSignature(accountId: number, assetId: number, fieldKey: string, st: CheckState): Promise<string | null> {
  const s = st.signatures[fieldKey];
  if (!s) return null;
  const [r] = await q<{ ouverte: boolean; tranchee: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM to_process_actions WHERE account_id = $1 AND target_type = 'ASSET' AND target_id = $2
                     AND field_key = $3 AND resolved_at IS NULL) AS ouverte,
            EXISTS (SELECT 1 FROM to_process_actions WHERE account_id = $1 AND target_type = 'ASSET' AND target_id = $2
                     AND field_key = $3 AND resolved_at >= $4::timestamptz) AS tranchee`,
    [accountId, assetId, fieldKey, s.at],
  );
  return r && !r.ouverte && r.tranchee ? s.signature : null;
}

/** Contrôle complet d'un bien : version, synthèse, signatures proposées (upsert). */
export async function recordCheck(p: {
  accountId: number; assetId: number; runId: number | null; summary: Record<string, number>;
  signatures: Record<string, string | null>;
}): Promise<void> {
  if (!(await informationChecksReady())) return;
  const now = new Date().toISOString();
  const ajouts = Object.fromEntries(Object.entries(p.signatures).filter(([, s]) => !!s).map(([k, s]) => [k, { signature: s, at: now }]));
  // Signature inchangée : la date de proposition d'origine est conservée.
  await q(
    `INSERT INTO t3_information_checks (asset_id, account_id, check_version, checked_at, last_run_id, summary, cross_signatures)
     VALUES ($1, $2, $3, now(), $4, $5::jsonb, $6::jsonb)
     ON CONFLICT (asset_id) DO UPDATE SET
       account_id = EXCLUDED.account_id, check_version = EXCLUDED.check_version, checked_at = now(),
       last_run_id = EXCLUDED.last_run_id, summary = EXCLUDED.summary,
       cross_signatures = t3_information_checks.cross_signatures || (
         SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(EXCLUDED.cross_signatures) AS e(k, v)
          WHERE (t3_information_checks.cross_signatures -> k ->> 'signature') IS DISTINCT FROM (v ->> 'signature'))`,
    [p.assetId, p.accountId, INFORMATION_CHECK_VERSION, p.runId, JSON.stringify(p.summary), JSON.stringify(ajouts)],
  );
}

// ── Rattrapage du stock (périmètre du passage T3 du compte) ─────────────────

/**
 * Biens du compte (en portefeuille) jamais contrôlés dans la version
 * courante, et reste à faire. Ordre : jamais tentés d'abord, puis tentative
 * la plus ancienne — un bien en échec répété ne bloque jamais le quota.
 */
export async function backfillScope(
  accountId: number, limit: number, excludedStatuses: readonly string[],
): Promise<{ ids: number[]; remaining: number } | null> {
  if (!(await informationChecksReady())) return null;
  const rows = await q<{ id: number }>(
    `SELECT a.id FROM assets a
       LEFT JOIN t3_information_checks k ON k.asset_id = a.id
      WHERE a.account_id = $1 AND a.deleted_at IS NULL
        AND NOT (COALESCE(a.status, 'EN_SERVICE') = ANY($3::text[]))
        AND k.check_version IS DISTINCT FROM $2
      ORDER BY k.checked_at NULLS FIRST, a.id`,
    [accountId, INFORMATION_CHECK_VERSION, [...excludedStatuses]],
  );
  const all = rows.map((r) => Number(r.id));
  const n = Math.max(0, limit);
  return { ids: all.slice(0, n), remaining: Math.max(0, all.length - n) };
}

/** Tentative de rattrapage en échec : repassée après les autres (jamais marquée contrôlée). */
export async function recordBackfillFailure(accountId: number, assetId: number): Promise<void> {
  if (!(await informationChecksReady())) return;
  await q(
    `INSERT INTO t3_information_checks (asset_id, account_id, check_version, checked_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (asset_id) DO UPDATE SET check_version = EXCLUDED.check_version, checked_at = now()
      WHERE t3_information_checks.check_version IS DISTINCT FROM $4`,
    [assetId, accountId, `${INFORMATION_CHECK_VERSION}:failed`, INFORMATION_CHECK_VERSION],
  ).catch(() => {});
}

/**
 * Biens dont les SOURCES TRANSVERSALES ont changé depuis `since` (agenda
 * « achat », Opérations d'acquisition, candidats Opération) : le passage T3
 * incrémental les reprend (déclencheurs agenda / Opérations, sans boucle :
 * T3 n'écrit ni l'agenda ni les Opérations).
 */
export async function assetsWithChangedSources(accountId: number, since: string): Promise<number[]> {
  const rows = await q<{ id: number }>(
    `SELECT DISTINCT id FROM (
       SELECT l.asset_id AS id FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id
        WHERE i.account_id = $1 AND i.updated_at > $2::timestamptz
       UNION SELECT al.asset_id FROM business_operations o
         JOIN business_operation_asset_links al ON al.operation_id = o.id AND al.account_id = o.account_id
        WHERE o.account_id = $1 AND o.updated_at > $2::timestamptz
       UNION SELECT f.asset_id FROM document_operation_candidates c JOIN asset_files f ON f.id = c.file_id
        WHERE c.account_id = $1 AND c.created_at > $2::timestamptz
     ) s WHERE id IS NOT NULL`,
    [accountId, since],
  ).catch(() => []);
  return rows.map((r) => Number(r.id));
}
