/**
 * Lot 85A (O-2, CDC v5 §20.3) — inventaire (lecture seule) et purge des
 * données DÉRIVÉES d'un compte, dans l'ordre des clés étrangères. Règles :
 * `model.ts` (en-tête). Toutes les écritures ont lieu dans la transaction de
 * l'appelant, sous le verrou Opération du compte (39101), APRÈS la copie de
 * l'image avant (`snapshot.ts`).
 *
 * Ordre de la purge (clés étrangères et déclencheurs) :
 *   1. décisions TCO `o:` des Opérations purgées → clé stable `s:` (O-9) ;
 *   2. cartes « À traiter » ouvertes sur une Opération purgée ou une
 *      projection retirée → closes « obsolètes » (événement tracé) ;
 *   3. projections automatiques intactes → `removeAgendaItemsTraced`
 *      (trace `agenda_item_removals`, cascade des liens de l'élément) ;
 *   4. provenance dérivée `OPERATION_PRINCIPAL` des liens Document ↔ Agenda
 *      des éléments conservés → retirée (lien supprimé sans autre provenance) ;
 *   5. Opérations purgées → DELETE (cascade : sources, liens bien / équipement
 *      / Pièce, appartenances, composantes et leurs sources, références,
 *      historique, revues d'identité, décisions système, montants hors
 *      total, détails dérivés ; éléments d'agenda conservés DÉTACHÉS par la
 *      clé `agenda_items_business_operation_fk` ON DELETE SET NULL — rôle
 *      retiré par le déclencheur `agenda_items_operation_role_sync`) ;
 *   6. repères de la migration structurée (lot 43) du compte → supprimés
 *      (les données de la fiche sont reconsolidées) ;
 *   7. candidats T1 actifs du compte → remis en consolidation (trace T3
 *      effacée, verdict M3 conservé : réutilisé si son contexte est inchangé).
 */
import type postgres from 'postgres';
import {
  computeKeepSet, parseLegacyOperationKey, stableDecisionKey,
  type KeepReason, type OperationFlags, type PurgePlan, type UserDataCounts,
} from './model';

type Sql = postgres.Sql | postgres.TransactionSql;
type Row = Record<string, unknown>;

const OPERATION_CARD_RULES = ['OPERATION-MATCH', 'OPERATION-AMOUNT', 'OPERATION-CLAIM-ASSET', 'OPERATION-CURRENCY', 'AGENDA-PROJECTION-MATCH'];
/** Identité stable d'une source (même forme que `tcoSourceIdentity` / la provenance TCO). */
const SOURCE_IDENTITY_SQL = `s.source_kind || ':' || s.source_entity_key || COALESCE(':' || NULLIF(s.locator->>'nature', ''), '')`;
const STABLE_KINDS = `'ASSET_DATA', 'EQUIPMENT_DATA', 'AGENDA'`;

async function tableExists(sql: Sql, t: string): Promise<boolean> {
  const [r] = await sql.unsafe<Array<{ ok: boolean }>>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [t] as never[]);
  return r?.ok === true;
}

/** Indicateurs de chaque Opération du compte (lecture seule). */
async function readOperationFlags(sql: Sql, accountId: number): Promise<OperationFlags[]> {
  // Ancien modèle Sinistres (avant la finalisation 84A) : lu seulement s'il est présent (sonde et noms de `legacy-schema.ts`).
  const { readLegacyClaimSchema, LEGACY_CLAIM_COLUMNS } = await import('../claims/legacy-schema');
  const schema = await readLegacyClaimSchema(sql);
  const legacy = (Object.entries(schema.tables) as Array<[string, boolean]>)
    .filter(([t, present]) => present && !t.endsWith('_marks'))
    .map(([t]) => `EXISTS (SELECT 1 FROM "${t}" lx WHERE lx.operation_id = o.id)`).join(' OR ') || 'false';
  const parentCol = schema.parentColumn ? LEGACY_CLAIM_COLUMNS.business_operations[0] : null;
  const r = await sql.unsafe<Row[]>(`
    SELECT o.id, o.invalidated_at IS NOT NULL AS invalidated, o.merged_into_operation_id AS merged_into,
           EXISTS (SELECT 1 FROM business_operation_history h WHERE h.operation_id = o.id AND h.account_id = o.account_id AND h.actor_user_id IS NOT NULL) AS user_history,
           EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.account_id = o.account_id
                     AND (s.source_kind IN ('CLAIM_FORM', 'USER_ARBITRATION', 'MIGRATION') OR (s.source_kind = 'AGENDA' AND s.locator ? 'grouping'))) AS user_source,
           EXISTS (SELECT 1 FROM business_operation_match_decisions d WHERE d.candidate_operation_id = o.id AND d.account_id = o.account_id
                     AND d.active AND d.origin IN ('USER_ARBITRATION', 'ADMIN_REVIEW')) AS user_decision,
           EXISTS (SELECT 1 FROM business_operation_asset_exclusions x WHERE x.operation_id = o.id) AS exclusion,
           EXISTS (SELECT 1 FROM business_operation_projection_suppressions p WHERE p.operation_id = o.id AND p.account_id = o.account_id) AS suppression,
           EXISTS (SELECT 1 FROM agenda_items i WHERE i.business_operation_id = o.id AND i.account_id = o.account_id AND i.operation_role_origin = 'USER') AS user_agenda_role,
           EXISTS (SELECT 1 FROM business_operation_documents bd WHERE bd.operation_id = o.id AND bd.account_id = o.account_id AND 'USER' = ANY(bd.origins)) AS user_document,
           EXISTS (SELECT 1 FROM business_operation_claim_damages cd WHERE cd.operation_id = o.id) AS claim_damages,
           (${legacy}) AS legacy_claim,
           (SELECT kd.insurance_contract_operation_id FROM business_operation_claim_details kd WHERE kd.operation_id = o.id) AS insurance_contract,
           ${parentCol ? `to_jsonb(o)->>'${parentCol}'` : 'NULL'} AS legacy_parent
      FROM business_operations o WHERE o.account_id = $1 ORDER BY o.id`, [accountId] as never[]);
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return r.map((x) => ({
    id: Number(x.id), invalidated: x.invalidated === true, mergedInto: n(x.merged_into),
    userHistory: x.user_history === true, userSource: x.user_source === true, userDecision: x.user_decision === true,
    exclusion: x.exclusion === true, suppression: x.suppression === true, userAgendaRole: x.user_agenda_role === true,
    userDocument: x.user_document === true, claimDamages: x.claim_damages === true, legacyClaim: x.legacy_claim === true,
    insuranceContract: n(x.insurance_contract), legacyParent: n(x.legacy_parent),
  }));
}

/** Données de l'utilisateur du compte (décomptes, avant / après : aucune ne doit baisser). */
export async function readUserData(sql: Sql, accountId: number): Promise<UserDataCounts> {
  const [r] = await sql.unsafe<Row[]>(`
    SELECT (SELECT count(*)::int FROM agenda_items WHERE account_id = $1 AND NOT is_automatic) AS agenda_user,
           (SELECT count(*)::int FROM agenda_items WHERE account_id = $1 AND is_automatic
              AND (is_automatic_modified OR COALESCE(manual_status, '') <> '' OR confirmation_mode IS NOT DISTINCT FROM 'USER')) AS agenda_modified,
           (SELECT count(*)::int FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id
             WHERE i.account_id = $1 AND 'MANUAL_DIRECT' = ANY(l.provenances)) AS manual_links,
           (SELECT count(*)::int FROM business_operation_match_decisions WHERE account_id = $1 AND active AND origin IN ('USER_ARBITRATION', 'ADMIN_REVIEW')) AS decisions,
           (SELECT count(*)::int FROM business_operation_asset_exclusions WHERE account_id = $1) AS exclusions,
           (SELECT count(*)::int FROM business_operation_projection_suppressions WHERE account_id = $1) AS suppressions,
           (SELECT count(*)::int FROM agenda_items WHERE account_id = $1 AND date_source IS NOT DISTINCT FROM 'USER') AS user_dates,
           (SELECT count(*)::int FROM asset_cost_line_decisions WHERE account_id = $1) AS tco`, [accountId] as never[]);
  return {
    agendaUserItems: Number(r.agenda_user), agendaModifiedItems: Number(r.agenda_modified), manualDocumentLinks: Number(r.manual_links),
    decisions: Number(r.decisions), exclusions: Number(r.exclusions), suppressions: Number(r.suppressions), userDates: Number(r.user_dates),
    tcoDecisions: Number(r.tco),
  };
}

/**
 * Inventaire EXACT d'un compte (lecture seule, même lecture pour simuler et
 * pour appliquer) : Opérations purgées / conservées, projections retirées,
 * cartes closes, décisions TCO re-clées, données de l'utilisateur.
 */
export async function inventoryAccount(sql: Sql, accountId: number): Promise<PurgePlan> {
  const flags = await readOperationFlags(sql, accountId);
  const ids = new Set(flags.map((f) => f.id));

  // Décisions TCO `o:` : identité stable de la composante, sinon l'Opération est conservée (aucune décision perdue).
  const decisions = await sql.unsafe<Array<{ id: number; asset_id: number; line_key: string; decided_at: string }>>(
    `SELECT id::int AS id, asset_id, line_key, decided_at::text AS decided_at FROM asset_cost_line_decisions
      WHERE account_id = $1 AND line_key LIKE 'o:%' ORDER BY id`, [accountId] as never[]);
  const identites = new Map<string, string | null>();
  const forced = new Map<number, KeepReason>();
  const provisoire = computeKeepSet(flags);
  for (const d of decisions) {
    const k = parseLegacyOperationKey(d.line_key);
    if (!k || !ids.has(k.operationId) || provisoire.has(k.operationId)) continue;
    const r = await sql.unsafe<Array<{ ids: string[] | null }>>(`
      SELECT ARRAY(SELECT DISTINCT ${SOURCE_IDENTITY_SQL}
                     FROM business_operation_financial_components c
                     JOIN business_operation_financial_component_sources cs ON cs.component_id = c.id
                     JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.account_id = c.account_id AND s.active
                    WHERE c.operation_id = $2 AND c.account_id = $1 AND c.active AND c.kind = $3 AND c.amount_minor = $4
                      AND upper(trim(c.currency)) = $5 AND s.source_kind IN (${STABLE_KINDS})) AS ids`,
    [accountId, k.operationId, k.kind, k.amountMinor, k.currency] as never[]);
    const cle = stableDecisionKey(r[0]?.ids ?? [], k.fact);
    identites.set(d.line_key, cle);
    if (!cle) forced.set(k.operationId, 'TCO_DECISION');
  }
  const keep = computeKeepSet(flags, forced);
  const purged = flags.filter((f) => !keep.has(f.id)).map((f) => f.id);
  const purgedSet = new Set(purged);
  const tcoDecisionsRekeyed: PurgePlan['tcoDecisionsRekeyed'] = [];
  for (const d of decisions) {
    const k = parseLegacyOperationKey(d.line_key);
    const to = identites.get(d.line_key);
    if (k && to && purgedSet.has(k.operationId)) tcoDecisionsRekeyed.push({ id: d.id, from: d.line_key, to });
  }
  // Fusion de deux décisions sur la même clé (même bien) : la plus récente reste.
  const cles = new Set<string>();
  let merged = 0;
  for (const d of decisions) {
    const r = tcoDecisionsRekeyed.find((x) => x.id === d.id);
    if (!r) continue;
    const k = `${d.asset_id}|${r.to}`;
    if (cles.has(k)) merged++;
    cles.add(k);
  }

  const purgedArr = `{${purged.join(',')}}`;
  // Projections automatiques INTACTES d'une Opération purgée (mêmes gardes que `removeAgendaItemsTraced`, plus :
  // aucun lien manuel, aucune préférence de rappel, aucun travail énergétique — données de l'utilisateur).
  const t6 = await tableExists(sql, 't6_reminder_preferences');
  const projections = purged.length ? (await sql.unsafe<Array<{ id: number }>>(`
    SELECT i.id FROM agenda_items i
     WHERE i.account_id = $1 AND i.business_operation_id = ANY($2::bigint[]) AND i.projection_origin = 'OPERATION'
       AND i.is_automatic AND NOT i.is_automatic_modified AND COALESCE(i.manual_status, '') = ''
       AND i.confirmation_mode IS DISTINCT FROM 'USER'
       AND NOT EXISTS (SELECT 1 FROM agenda_file_links l WHERE l.agenda_item_id = i.id AND 'MANUAL_DIRECT' = ANY(l.provenances))
       ${t6 ? 'AND NOT EXISTS (SELECT 1 FROM t6_reminder_preferences p WHERE p.agenda_item_id = i.id)' : ''}
       AND NOT EXISTS (SELECT 1 FROM energy_works w WHERE w.agenda_item_id = i.id)
     ORDER BY i.id`, [accountId, purgedArr] as never[])).map((x) => Number(x.id)) : [];
  const projSet = new Set(projections);
  const lies = purged.length ? (await sql.unsafe<Array<{ id: number }>>(
    `SELECT id FROM agenda_items WHERE account_id = $1 AND business_operation_id = ANY($2::bigint[]) ORDER BY id`,
    [accountId, purgedArr] as never[])).map((x) => Number(x.id)) : [];
  const conserves = lies.filter((i) => !projSet.has(i));
  const prov = conserves.length ? (await sql.unsafe<Array<{ n: number; d: number }>>(`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE provenances = ARRAY['OPERATION_PRINCIPAL']::text[])::int AS d
      FROM agenda_file_links WHERE agenda_item_id = ANY($1::int[]) AND 'OPERATION_PRINCIPAL' = ANY(provenances)`,
  [`{${conserves.join(',')}}`] as never[]))[0] : { n: 0, d: 0 };

  const cards = purged.length || projections.length ? (await sql.unsafe<Array<{ id: number }>>(`
    SELECT id FROM to_process_actions
     WHERE account_id = $1 AND resolved_at IS NULL
       AND ((rule_code = ANY($2::text[]) AND (
              (trigger_context ? 'operationId' AND (trigger_context->>'operationId') ~ '^[0-9]{1,18}$' AND (trigger_context->>'operationId')::bigint = ANY($3::bigint[]))
              OR (jsonb_typeof(trigger_context->'operationIds') = 'array' AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements_text(trigger_context->'operationIds') e WHERE e ~ '^[0-9]{1,18}$' AND e::bigint = ANY($3::bigint[])))))
            OR (target_type = 'AGENDA_ITEM' AND target_id = ANY($4::int[])))
     ORDER BY id`, [accountId, `{${OPERATION_CARD_RULES.join(',')}}`, purgedArr, `{${projections.join(',')}}`] as never[])).map((x) => Number(x.id)) : [];

  const agendaSources = purged.length ? (await sql.unsafe<Array<{ k: string }>>(`
    SELECT DISTINCT s.source_entity_key AS k FROM business_operation_sources s
     WHERE s.account_id = $1 AND s.operation_id = ANY($2::bigint[]) AND s.source_kind = 'AGENDA' AND NOT (s.locator ? 'grouping')
       AND s.source_entity_key ~ '^[0-9]{1,9}$'
       AND EXISTS (SELECT 1 FROM agenda_items i WHERE i.id = s.source_entity_key::int AND i.account_id = s.account_id)`,
  [accountId, purgedArr] as never[])).map((x) => Number(x.k)).filter((n) => !projSet.has(n)).sort((a, b) => a - b) : [];

  const [c] = await sql.unsafe<Array<{ cand: number; docs: number }>>(`
    SELECT count(*)::int AS cand, count(DISTINCT file_id)::int AS docs FROM document_operation_candidates WHERE account_id = $1 AND status = 'ACTIVE'`,
  [accountId] as never[]);

  const keptByReason: PurgePlan['keptByReason'] = {};
  for (const r of keep.values()) for (const x of r) keptByReason[x] = (keptByReason[x] ?? 0) + 1;
  return {
    operations: {
      total: flags.length, active: flags.filter((f) => !f.invalidated && f.mergedInto === null).length,
      invalidated: flags.filter((f) => f.invalidated && f.mergedInto === null).length, merged: flags.filter((f) => f.mergedInto !== null).length,
    },
    purged, kept: [...keep].map(([id, reasons]) => ({ id, reasons })).sort((a, b) => a.id - b.id), keptByReason,
    projectionsRemoved: projections, itemsDetached: conserves.length,
    principalProvenancesRemoved: Number(prov.n), principalLinksDeleted: Number(prov.d),
    cardsClosed: cards, candidatesRequeued: Number(c.cand), documents: Number(c.docs), agendaSourceItems: agendaSources,
    tcoDecisionsRekeyed, tcoDecisionsMerged: merged,
    userData: await readUserData(sql, accountId),
  };
}

/** Applique l'inventaire (transaction de l'appelant, verrou du compte pris, image avant copiée). Rend les écritures. */
export async function applyPurge(tx: postgres.TransactionSql, accountId: number, plan: PurgePlan, p: { runId: string; now: Date }): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const now = p.now.toISOString();
  // 1. Décisions TCO : clé stable (la plus récente l'emporte sur une même clé).
  let rekeyed = 0;
  for (const d of plan.tcoDecisionsRekeyed) {
    const [cur] = await tx<{ asset_id: number; decided_at: string }[]>`SELECT asset_id, decided_at::text AS decided_at FROM asset_cost_line_decisions WHERE id = ${d.id} AND account_id = ${accountId}`;
    if (!cur) continue;
    const [autre] = await tx<{ id: number; decided_at: string }[]>`
      SELECT id::int AS id, decided_at::text AS decided_at FROM asset_cost_line_decisions
       WHERE account_id = ${accountId} AND asset_id = ${cur.asset_id} AND line_key = ${d.to} AND id <> ${d.id}`;
    if (autre) {
      if (autre.decided_at >= cur.decided_at) { await tx`DELETE FROM asset_cost_line_decisions WHERE id = ${d.id}`; rekeyed++; continue; }
      await tx`DELETE FROM asset_cost_line_decisions WHERE id = ${autre.id}`;
    }
    await tx`UPDATE asset_cost_line_decisions SET line_key = ${d.to}, updated_at = ${now}::timestamptz WHERE id = ${d.id}`;
    rekeyed++;
  }
  out.tcoDecisionsRekeyed = rekeyed;
  // 2. Cartes ouvertes devenues sans objet : closes « obsolètes » (événement tracé).
  let cartes = 0;
  for (const id of plan.cardsClosed) {
    const [a] = await tx<{ id: number; target_type: string; target_id: number; relation_key: string | null; rule_code: string }[]>`
      UPDATE to_process_actions SET resolved_at = ${now}::timestamptz, resolution_reason = 'OBSOLETE', updated_at = ${now}::timestamptz
       WHERE id = ${id} AND account_id = ${accountId} AND resolved_at IS NULL
      RETURNING id, target_type, target_id, relation_key, rule_code`;
    if (!a) continue;
    await tx`
      INSERT INTO to_process_action_events (action_id, account_id, event, actor_user_id, target_type, target_id, field_key, details, created_at)
      VALUES (${a.id}, ${accountId}, 'OBSOLETE', NULL, ${a.target_type}, ${a.target_id}, ${a.relation_key},
              ${JSON.stringify({ ruleCode: a.rule_code, reason: 'L85A_OPERATIONS_REBUILD', runId: p.runId })}::jsonb, ${now}::timestamptz)`;
    cartes++;
  }
  out.cardsClosed = cartes;
  // 3. Projections automatiques intactes : retrait TRACÉ (mêmes gardes dans le DELETE).
  const { removeAgendaItemsTraced } = await import('@/services/agenda/agenda-removal-trace');
  out.projectionsRemoved = plan.projectionsRemoved.length
    ? (await removeAgendaItemsTraced(tx as unknown as postgres.Sql, { accountId, ids: plan.projectionsRemoved, reason: 'OPERATION_PROJECTION' })).length : 0;
  const purgedArr = `{${plan.purged.join(',')}}`;
  // 4. Provenance dérivée OPERATION_PRINCIPAL des liens des éléments conservés (les liens précis restent).
  if (plan.purged.length) {
    const del = await tx.unsafe(`
      DELETE FROM agenda_file_links l USING agenda_items i
       WHERE i.id = l.agenda_item_id AND i.account_id = $1 AND i.business_operation_id = ANY($2::bigint[])
         AND l.provenances = ARRAY['OPERATION_PRINCIPAL']::text[] RETURNING 1`, [accountId, purgedArr] as never[]);
    const upd = await tx.unsafe(`
      UPDATE agenda_file_links l SET provenances = array_remove(l.provenances, 'OPERATION_PRINCIPAL') FROM agenda_items i
       WHERE i.id = l.agenda_item_id AND i.account_id = $1 AND i.business_operation_id = ANY($2::bigint[])
         AND 'OPERATION_PRINCIPAL' = ANY(l.provenances) RETURNING 1`, [accountId, purgedArr] as never[]);
    out.principalLinksDeleted = del.length;
    out.principalProvenancesRemoved = del.length + upd.length;
    // 5. Opérations purgées (une instruction : les fusions internes au lot sont cohérentes en fin d'instruction).
    const ops = await tx.unsafe(`DELETE FROM business_operations WHERE account_id = $1 AND id = ANY($2::bigint[]) RETURNING 1`, [accountId, purgedArr] as never[]);
    out.operationsPurged = ops.length;
  }
  // 6. Repères de la migration structurée du compte (données de la fiche reconsolidées).
  out.assetDataMarks = (await tx.unsafe(`DELETE FROM business_operation_asset_data_marks WHERE account_id = $1 RETURNING 1`, [accountId] as never[])).length;
  // 7. Candidats T1 persistés remis en consolidation (aucune nouvelle analyse) ; verdict M3 conservé.
  out.candidatesRequeued = (await tx.unsafe(`
    UPDATE document_operation_candidates
       SET t3_pending = true, t3_outcome = NULL, t3_reason = NULL, t3_operation_id = NULL,
           t3_detail = CASE WHEN t3_detail ? 'm3' THEN jsonb_build_object('m3', t3_detail->'m3') ELSE NULL END,
           t3_error_attempts = 0, t3_retry_at = NULL, t3_cards_pending = false
     WHERE account_id = $1 AND status = 'ACTIVE' RETURNING 1`, [accountId] as never[])).length;
  return out;
}

