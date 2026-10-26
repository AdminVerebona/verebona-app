/**
 * Lot 76H — Opérations → Agenda : CONVERGENCE des représentations d'une
 * intervention (ticket « [P1] Opérations → Agenda — Corriger les doublons
 * d'interventions », §3.2 à §3.4, §4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * T4 DIT QUELLES REPRÉSENTATIONS SONT LA MÊME OCCURRENCE ; ICI ON APPLIQUE
 *
 * Lot 87B (ticket « orchestration T3/T4 », CODE-04, V-Q4) : la décision de
 * fusion n'est plus déduite par la projection (provenance T3 + type + date
 * proche) ; elle vient d'une décision T4 VALIDÉE (`semantic/`), et ce module
 * l'applique, sous trace et réversible :
 *
 *   consolidateInTx                    dans la transaction de l'appelant, verrou consultatif du
 *     compte (espace 39102) : principal relu et (si demandé) relié ; chaque
 *     élément absorbé relu SOUS VERROU avec les gardes complètes (automatique,
 *     intact, ni « à qualifier » ni « à confirmer », non projeté, non lié à
 *     une autre Opération active, jamais restauré) ; ses preuves
 *     (`agenda_item_sources`) passent au principal, ses liens (bien,
 *     document, pièce, équipement) y sont AJOUTÉS, ses cartes « À traiter »
 *     ouvertes sont closes (OBSOLETE, tracé) ; image complète (élément, liens,
 *     historique `agenda_occurrence_events`) écrite au journal 0591 ; retrait
 *     par `removeAgendaItemsTraced` (trace 0223). Tout ou rien.
 *   retitleAgendaItem                   intitulé générique T4 → description
 *     précise de l'Opération, élément automatique intact seulement (garde SQL),
 *     intitulé d'origine au journal.
 *   restoreAgendaConsolidations        restauration ligne à ligne (élément
 *     recréé sous son identifiant, liens, preuves, historique, cartes ; lien
 *     et intitulé rétablis) ; une ligne restaurée n'est plus jamais rejouée
 *     (`consolidation_restored` → l'élément redevient un choix utilisateur).
 *
 * Journal absent (migration 0591 non appliquée) : AUCUNE consolidation —
 * jamais de retrait sans trace (signalé une fois).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { linkRejectedSql } from '@/services/business-operations/grouping/decisions';
import type postgres from 'postgres';
import { pgClient } from '@/db';
import { removeAgendaItemsTraced } from '@/services/agenda/agenda-removal-trace';
import { postgresRunner } from '../grouping/runner';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type Row = Record<string, unknown>;

/** Espace du verrou consultatif des consolidations d'agenda (distinct de 39101, Opérations). */
export const AGENDA_CONSOLIDATION_LOCK_SPACE = 39102;
type ConsolidationOrigin = 'PROJECTION' | 'REPRISE';

const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;

let pret: { ready: boolean; at: number } | null = null;
let signale = false;

/** Journal 0591 présent ? (cache 5 min ; ne lève jamais) */
export async function consolidationJournalReady(sql: Sql = pgClient): Promise<boolean> {
  if (pret && (pret.ready || Date.now() - pret.at < 5 * 60_000)) return pret.ready;
  let ready = false;
  try {
    const [r] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name IN ('agenda_intervention_consolidations', 'agenda_intervention_reprise_runs')`;
    ready = Number(r?.n) === 2;
  } catch { ready = false; }
  if (!ready && !signale) {
    signale = true;
    console.error('[agenda-consolidation] migration 0591 absente : aucune consolidation d’agenda appliquée (abstention conservée).');
  }
  pret = { ready, at: Date.now() };
  return ready;
}

/** Gardes SQL d'un élément absorbable (alias `i`). Mêmes notions que `isTouched` + statuts ouverts + restauration. */
export const ABSORBABLE_SQL = `
  i.is_automatic AND NOT COALESCE(i.is_automatic_modified, false)
  AND (i.manual_status IS NULL OR i.manual_status = '')
  AND i.confirmation_mode IS DISTINCT FROM 'USER'
  AND i.projection_origin IS NULL
  AND NOT COALESCE(i.requires_qualification, false)
  AND i.occurrence_nature IS DISTINCT FROM 'FORECAST'
  AND NOT EXISTS (SELECT 1 FROM agenda_intervention_consolidations k
                   WHERE k.account_id = i.account_id AND k.restored_at IS NOT NULL
                     AND (k.absorbed_item_id = i.id OR (k.kind <> 'ABSORB' AND k.principal_item_id = i.id)))`;

/**
 * Lot 82D (V-Q4) : la fusion reste réservée aux occurrences réellement identiques — un élément ABSORBÉ n'est
 * jamais le principal d'une Opération, ni un élément que l'utilisateur a rattaché comme élément distinct
 * (étape, échéance). (Le changement d'intitulé du principal garde `ABSORBABLE_SQL` seul.)
 */
export const ABSORBABLE_ROLE_SQL = `
  AND i.operation_role IS DISTINCT FROM 'PRINCIPAL'
  AND i.operation_role_origin IS DISTINCT FROM 'USER'`;

interface ConsolidationInput {
  accountId: number;
  operationId: number;
  principalId: number;
  absorbedIds: readonly number[];
  linkPrincipal: boolean;
  reason: string;
  origin: ConsolidationOrigin;
  runId?: string | null;
  correlationId?: string | null;
}

export interface ConsolidationResult {
  linked: boolean;
  absorbed: number[];
  /** Éléments écartés par les gardes (touchés, liés ailleurs, statut ouvert, restaurés, disparus). */
  protectedIds: number[];
  skipped?: 'JOURNAL_MISSING' | 'OPERATION_INACTIVE' | 'PRINCIPAL_GONE' | 'PRINCIPAL_NOT_LINKED' | 'PRINCIPAL_LINKED_ELSEWHERE';
}

/**
 * Applique une consolidation DÉCIDÉE PAR T4 (lot 87B, CODE-09), DANS la
 * transaction de l'appelant (application atomique d'une décision de
 * représentation : consolidations, rattachements et restaurations, tout ou
 * rien). Le journal 0591 doit être présent (vérifié par l'appelant). Lève sur
 * une erreur technique : la transaction de l'appelant est annulée.
 */
export async function consolidateInTx(tx: Tx, p: ConsolidationInput): Promise<ConsolidationResult> {
  const vide: ConsolidationResult = { linked: false, absorbed: [], protectedIds: [] };
  const absorbes = [...new Set(p.absorbedIds.filter((x) => Number.isSafeInteger(x) && x > 0 && x !== p.principalId))];
  {
    await tx`SELECT pg_advisory_xact_lock(${AGENDA_CONSOLIDATION_LOCK_SPACE}::int, ${p.accountId}::int)`;
    const [op] = await tx<Row[]>`
      SELECT id FROM business_operations WHERE id = ${p.operationId} AND account_id = ${p.accountId}
         AND invalidated_at IS NULL AND merged_into_operation_id IS NULL`;
    if (!op) return { ...vide, protectedIds: absorbes, skipped: 'OPERATION_INACTIVE' as const };
    const [principal] = await tx<Row[]>`
      SELECT i.id, i.business_operation_id::text AS op,
             (lo.id IS NOT NULL AND lo.invalidated_at IS NULL AND lo.merged_into_operation_id IS NULL) AS op_active
        FROM agenda_items i LEFT JOIN business_operations lo ON lo.id = i.business_operation_id
       WHERE i.id = ${p.principalId} AND i.account_id = ${p.accountId}
       FOR UPDATE OF i`;
    if (!principal) return { ...vide, protectedIds: absorbes, skipped: 'PRINCIPAL_GONE' as const };
    const lieA = principal.op === null || principal.op === undefined ? null : Number(principal.op);
    let linked = false;
    if (lieA !== p.operationId) {
      if (!p.linkPrincipal) return { ...vide, protectedIds: absorbes, skipped: 'PRINCIPAL_NOT_LINKED' as const };
      if (lieA !== null && principal.op_active === true) return { ...vide, protectedIds: absorbes, skipped: 'PRINCIPAL_LINKED_ELSEWHERE' as const };
      // Un principal restauré par l'utilisateur / l'exploitation n'est jamais relié à nouveau automatiquement.
      const [restaure] = await tx.unsafe<Row[]>(
        `SELECT 1 FROM agenda_intervention_consolidations k WHERE k.account_id = $1 AND k.restored_at IS NOT NULL
            AND k.kind = 'LINK' AND k.principal_item_id = $2 LIMIT 1`, [p.accountId, p.principalId] as never[]);
      if (restaure) return { ...vide, protectedIds: absorbes, skipped: 'PRINCIPAL_NOT_LINKED' as const };
      // Lot 82D : service unique de regroupement — l'élément devient le principal (représentation T4 de l'intervention).
      const { attachAgendaItem, runnerContext } = await import('../grouping/service');
      const r = await attachAgendaItem(runnerContext(postgresRunner(tx), p.accountId, { correlationId: p.correlationId ?? null }),
        { operationId: p.operationId, itemId: p.principalId, role: 'PRINCIPAL', origin: 'T4', reasonCode: 'T4_AGENDA_CONSOLIDATION_LINK' });
      if (!r.changed && r.skipped) return { ...vide, protectedIds: absorbes, skipped: r.skipped === 'USER_REJECTED' ? 'PRINCIPAL_NOT_LINKED' as const : 'PRINCIPAL_LINKED_ELSEWHERE' as const };
      await journal(tx, p, 'LINK', null, { previousOperationId: lieA });
      linked = true;
    }

    const gardes = absorbes.length ? await tx.unsafe<Row[]>(
      `SELECT to_jsonb(i) AS item FROM agenda_items i
         LEFT JOIN business_operations lo ON lo.id = i.business_operation_id
        WHERE i.account_id = $1 AND i.id = ANY($2::int[])
          AND (i.business_operation_id IS NULL OR i.business_operation_id = $3
               OR lo.id IS NULL OR lo.invalidated_at IS NOT NULL OR lo.merged_into_operation_id IS NOT NULL)
          AND ${ABSORBABLE_SQL} ${ABSORBABLE_ROLE_SQL}
        ORDER BY i.id
        FOR UPDATE OF i`,
      [p.accountId, intArray(absorbes), p.operationId] as never[],
    ) : [];
    const ok = gardes.map((g) => Number((g.item as Row).id));
    const absorbed: number[] = [];
    for (const g of gardes) {
      const item = g.item as Row;
      const id = Number(item.id);
      const links = await tx.unsafe<Row[]>(
        `SELECT
           COALESCE((SELECT jsonb_agg(asset_id ORDER BY asset_id) FROM agenda_asset_links WHERE agenda_item_id = $1), '[]') AS assets,
           COALESCE((SELECT jsonb_agg(asset_file_id ORDER BY asset_file_id) FROM agenda_file_links WHERE agenda_item_id = $1), '[]') AS files,
           COALESCE((SELECT jsonb_object_agg(asset_file_id::text, provenances) FROM agenda_file_links WHERE agenda_item_id = $1), '{}') AS file_provenances,
           COALESCE((SELECT jsonb_agg(substructure_id ORDER BY substructure_id) FROM agenda_room_links WHERE agenda_item_id = $1), '[]') AS rooms,
           COALESCE((SELECT jsonb_agg(equipment_id ORDER BY equipment_id) FROM agenda_equipment_links WHERE agenda_item_id = $1), '[]') AS equipments,
           COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM agenda_occurrence_events e WHERE e.agenda_item_id = $1), '[]') AS occurrence_events`,
        [id] as never[],
      );
      const added = {
        assets: (await tx.unsafe<Row[]>(`INSERT INTO agenda_asset_links (agenda_item_id, asset_id)
            SELECT $1, asset_id FROM agenda_asset_links WHERE agenda_item_id = $2 ON CONFLICT DO NOTHING RETURNING asset_id`, [p.principalId, id] as never[])).map((r) => Number(r.asset_id)),
        // Lot 82D : provenances reprises (un élément absorbé n'est jamais principal : aucune propagation copiée).
        files: (await tx.unsafe<Row[]>(`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances)
            SELECT $1, asset_file_id, CASE WHEN cardinality(array_remove(provenances, 'OPERATION_PRINCIPAL')) > 0
                                           THEN array_remove(provenances, 'OPERATION_PRINCIPAL') ELSE ARRAY['AI_DIRECT']::text[] END
              FROM agenda_file_links WHERE agenda_item_id = $2
               -- Lot 86D : un lien détaché par l'utilisateur de l'élément retenu n'y est jamais recopié.
               AND NOT ${linkRejectedSql('$1::int', 'asset_file_id')}
             ON CONFLICT DO NOTHING RETURNING asset_file_id`, [p.principalId, id] as never[])).map((r) => Number(r.asset_file_id)),
        rooms: (await tx.unsafe<Row[]>(`INSERT INTO agenda_room_links (agenda_item_id, substructure_id)
            SELECT $1, substructure_id FROM agenda_room_links WHERE agenda_item_id = $2 ON CONFLICT DO NOTHING RETURNING substructure_id`, [p.principalId, id] as never[])).map((r) => Number(r.substructure_id)),
        equipments: (await tx.unsafe<Row[]>(`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id)
            SELECT $1, equipment_id FROM agenda_equipment_links WHERE agenda_item_id = $2 ON CONFLICT DO NOTHING RETURNING equipment_id`, [p.principalId, id] as never[])).map((r) => Number(r.equipment_id)),
      };
      // Preuves : déplacées vers le principal (une même source déjà citée par
      // le principal reste attachée à sa ligne : elle devient orpheline au
      // retrait — ON DELETE SET NULL — et est rattachée à la restauration).
      const moved = (await tx.unsafe<Row[]>(
        `UPDATE agenda_item_sources s SET agenda_item_id = $1
          WHERE s.agenda_item_id = $2
            AND NOT EXISTS (SELECT 1 FROM agenda_item_sources t WHERE t.agenda_item_id = $1
                             AND t.asset_file_id = s.asset_file_id AND t.source_role IS NOT DISTINCT FROM s.source_role)
          RETURNING s.id`, [p.principalId, id] as never[])).map((r) => Number(r.id));
      const kept = (await tx.unsafe<Row[]>(`SELECT id FROM agenda_item_sources WHERE agenda_item_id = $1`, [id] as never[])).map((r) => Number(r.id));
      const cartes = (await tx.unsafe<Row[]>(
        `UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'OBSOLETE', updated_at = now()
          WHERE account_id = $1 AND upper(target_type) IN ('AGENDA_ITEM', 'AGENDA') AND target_id = $2 AND resolved_at IS NULL
          RETURNING id, target_type, relation_key, rule_code`, [p.accountId, id] as never[]));
      for (const c of cartes) {
        await tx.unsafe(
          `INSERT INTO to_process_action_events (action_id, account_id, event, actor_user_id, target_type, target_id, field_key, details, created_at)
           VALUES ($1, $2, 'OBSOLETE', NULL, $3, $4, $5, $6::text::jsonb, now())`,
          [c.id, p.accountId, c.target_type, id, c.relation_key ?? null,
            JSON.stringify({ ruleCode: c.rule_code, reason: 'AGENDA_CONSOLIDATED', principalItemId: p.principalId })] as never[],
        );
      }
      await journal(tx, p, 'ABSORB', id, {
        item, links: links[0] ?? {}, added, movedSourceIds: moved, orphanedSourceIds: kept, closedCardIds: cartes.map((c) => Number(c.id)),
      });
      const gone = await removeAgendaItemsTraced(tx as unknown as Sql, { accountId: p.accountId, ids: [id], reason: 'OPERATION_CONSOLIDATION' });
      if (!gone.includes(id)) throw new Error(`consolidation : retrait tracé de l'élément ${id} impossible (garde ou trace 0223 absente) — transaction annulée`);
      absorbed.push(id);
    }
    if (absorbed.length) {
      await tx.unsafe(
        `INSERT INTO agenda_occurrence_events (agenda_item_id, account_id, event_type, detail_json) VALUES ($1, $2, 'DUPLICATE_CONSOLIDATED', $3::text::jsonb)`,
        [p.principalId, p.accountId, JSON.stringify({
          reasonCode: p.reason, operationId: p.operationId, absorbedItemIds: absorbed, origin: p.origin, runId: p.runId ?? null,
          correlationId: p.correlationId ?? null,
        })] as never[],
      );
    }
    console.info(JSON.stringify({
      event: 't4.operation_agenda_consolidation', accountId: p.accountId, operationId: p.operationId, principalId: p.principalId,
      linked, absorbed, protected: absorbes.filter((x) => !ok.includes(x)), origin: p.origin, runId: p.runId ?? null,
    }));
    return { linked, absorbed, protectedIds: absorbes.filter((x) => !absorbed.includes(x)) };
  }
}

async function journal(tx: Tx, p: ConsolidationInput, kind: 'ABSORB' | 'LINK' | 'RETITLE', absorbed: number | null, detail: Record<string, unknown>): Promise<void> {
  await tx.unsafe(
    `INSERT INTO agenda_intervention_consolidations
       (account_id, run_id, origin, kind, operation_id, principal_item_id, absorbed_item_id, reason, correlation_id, detail)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::text::jsonb)`,
    [p.accountId, p.runId ?? null, p.origin, kind, p.operationId, p.principalId, absorbed, p.reason, p.correlationId ?? null, JSON.stringify(detail)] as never[],
  );
}

/**
 * Intitulé générique d'un élément T4 automatique INTACT → description précise
 * de l'Opération (garde SQL complète, journal). Rend vrai si écrit.
 */
export async function retitleAgendaItem(p: {
  accountId: number; operationId: number; itemId: number; title: string; from: string; origin: ConsolidationOrigin; runId?: string | null; correlationId?: string | null;
}, sql: Sql = pgClient): Promise<boolean> {
  if (!(await consolidationJournalReady(sql))) return false;
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${AGENDA_CONSOLIDATION_LOCK_SPACE}::int, ${p.accountId}::int)`;
    const r = await tx.unsafe<Row[]>(
      `UPDATE agenda_items i SET title = $4, updated_at = now()
        WHERE i.id = $1 AND i.account_id = $2 AND i.business_operation_id = $3 AND i.title = $5 AND ${ABSORBABLE_SQL}
        RETURNING i.id`,
      [p.itemId, p.accountId, p.operationId, p.title, p.from] as never[],
    );
    if (!r.length) return false;
    await journal(tx, { ...p, principalId: p.itemId, absorbedIds: [], linkPrincipal: false, reason: 'OPERATION_PRECISE_TITLE' }, 'RETITLE', null, { from: p.from, to: p.title });
    await tx.unsafe(
      `INSERT INTO agenda_occurrence_events (agenda_item_id, account_id, event_type, detail_json) VALUES ($1, $2, 'TITLE_FROM_OPERATION', $3::text::jsonb)`,
      [p.itemId, p.accountId, JSON.stringify({ from: p.from, to: p.title, operationId: p.operationId })] as never[],
    );
    return true;
  }) as Promise<boolean>;
}

// ── Restauration ────────────────────────────────────────────────────────────

export interface RestoreResult {
  restored: number;
  conflicts: Array<{ journalId: number; itemId: number; reason: string }>;
}

/**
 * Restaure les lignes de journal visées (exécution du rattrapage `runId`, ou
 * identifiants) dans l'ordre inverse. Une ligne déjà restaurée est ignorée ;
 * un conflit (élément recréé entre-temps, clé fonctionnelle reprise, élément
 * modifié par l'utilisateur) est rapporté, jamais forcé.
 */
export async function restoreAgendaConsolidations(sql: Sql, p: { runId?: string; journalIds?: number[]; accountId?: number; restoreRunId: string }): Promise<RestoreResult> {
  const res: RestoreResult = { restored: 0, conflicts: [] };
  if (!(await consolidationJournalReady(sql))) return res;
  const lignes = await sql.unsafe<Row[]>(
    `SELECT id, account_id, kind, operation_id::text AS operation_id, principal_item_id, absorbed_item_id, detail
       FROM agenda_intervention_consolidations
      WHERE restored_at IS NULL
        AND (($1::uuid IS NOT NULL AND run_id = $1::uuid) OR ($2::bigint[] IS NOT NULL AND id = ANY($2::bigint[])))
        AND ($3::int IS NULL OR account_id = $3::int)
      ORDER BY id DESC`,
    [p.runId ?? null, p.journalIds ? intArray(p.journalIds) : null, p.accountId ?? null] as never[],
  );
  for (const l of lignes) {
    const conflit = (c: { journalId: number; itemId: number; reason: string }) => res.conflicts.push(c);
    const ok = await sql.begin((tx) => restoreConsolidationLineInTx(tx, l, p.restoreRunId, conflit));
    if (ok) res.restored++;
  }
  return res;
}

/** Ligne du journal 0591 telle que la restauration la lit. */
type ConsolidationJournalLine = Row;

/**
 * Lot 87B (CODE-07, CODE-09) : restauration d'UNE ligne du journal 0591 dans
 * la transaction de l'appelant (décision T4 « étapes fusionnées à tort »).
 * Rend vrai si la ligne est restaurée ; un conflit est rapporté, jamais forcé.
 */
export async function restoreConsolidationLineInTx(
  tx: Tx, l: ConsolidationJournalLine, restoreRunId: string, conflict: (c: { journalId: number; itemId: number; reason: string }) => void,
): Promise<boolean> {
  const journalId = Number(l.id);
  const accountId = Number(l.account_id);
  const d = (l.detail ?? {}) as Row;
  const principal = Number(l.principal_item_id);
  const conflit = (itemId: number, reason: string) => conflict({ journalId, itemId, reason });
  const p = { restoreRunId };
  {
      await tx`SELECT pg_advisory_xact_lock(${AGENDA_CONSOLIDATION_LOCK_SPACE}::int, ${accountId}::int)`;
      if (l.kind === 'RETITLE') {
        await tx.unsafe(
          `UPDATE agenda_items SET title = $3, updated_at = now() WHERE id = $1 AND account_id = $2 AND title = $4
              AND is_automatic AND NOT COALESCE(is_automatic_modified, false)`,
          [principal, accountId, String(d.from ?? ''), String(d.to ?? '')] as never[]);
      } else if (l.kind === 'LINK') {
        // Lot 82D : retour arrière par le service de regroupement (rôle et propagation retirés, puis lien antérieur rétabli s'il vaut encore).
        const { attachAgendaItem, detachAgendaItem, runnerContext } = await import('../grouping/service');
        const ctx = runnerContext(postgresRunner(tx), accountId);
        const r = await detachAgendaItem(ctx, { itemId: principal, operationId: Number(l.operation_id), origin: 'SYSTEM', reasonCode: 'AGENDA_CONSOLIDATION_RESTORED' });
        const avant = d.previousOperationId == null ? null : Number(d.previousOperationId);
        if (r.changed && avant !== null) {
          await attachAgendaItem(ctx, { operationId: avant, itemId: principal, origin: 'SYSTEM', reasonCode: 'AGENDA_CONSOLIDATION_RESTORED' }).catch(() => undefined);
        }
      } else {
        const id = Number(l.absorbed_item_id);
        const item = d.item as Row | undefined;
        if (!item) { conflit(id, 'SNAPSHOT_MISSING'); return false; }
        const [existe] = await tx.unsafe<Row[]>(`SELECT 1 FROM agenda_items WHERE id = $1`, [id] as never[]);
        if (existe) { conflit(id, 'ITEM_EXISTS'); return false; }
        if (item.functional_key) {
          const [cle] = await tx.unsafe<Row[]>(`SELECT id FROM agenda_items WHERE account_id = $1 AND functional_key = $2 LIMIT 1`, [accountId, item.functional_key] as never[]);
          if (cle) { conflit(id, `FUNCTIONAL_KEY_TAKEN:${String(cle.id)}`); return false; }
        }
        await tx.unsafe(`INSERT INTO agenda_items SELECT * FROM jsonb_populate_record(NULL::agenda_items, $1::text::jsonb)`, [JSON.stringify(item)] as never[]);
        const links = (d.links ?? {}) as Record<string, unknown>;
        const ids = (k: string) => intArray(Array.isArray(links[k]) ? (links[k] as unknown[]).map(Number) : []);
        await tx.unsafe(`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) SELECT $1, a.id FROM assets a WHERE a.id = ANY($2::int[]) ON CONFLICT DO NOTHING`, [id, ids('assets')] as never[]);
        // Lot 82D : provenances de l'instantané (journal antérieur : provenance de l'élément automatique).
        await tx.unsafe(`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances)
            SELECT $1, f.id, COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text($3::text::jsonb -> f.id::text) AS x), ARRAY['AI_DIRECT']::text[])
              FROM asset_files f WHERE f.id = ANY($2::int[]) ON CONFLICT DO NOTHING`, [id, ids('files'), JSON.stringify(links.file_provenances ?? {})] as never[]);
        await tx.unsafe(`INSERT INTO agenda_room_links (agenda_item_id, substructure_id) SELECT $1, s.id FROM substructures s WHERE s.id = ANY($2::int[]) ON CONFLICT DO NOTHING`, [id, ids('rooms')] as never[]);
        await tx.unsafe(`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id) SELECT $1, e.id FROM equipments e WHERE e.id = ANY($2::int[]) ON CONFLICT DO NOTHING`, [id, ids('equipments')] as never[]);
        const evts = Array.isArray(links.occurrence_events) ? links.occurrence_events : [];
        for (const e of evts as Row[]) {
          await tx.unsafe(`INSERT INTO agenda_occurrence_events SELECT * FROM jsonb_populate_record(NULL::agenda_occurrence_events, $1::text::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(e)] as never[]);
        }
        const nums = (k: string) => intArray(Array.isArray(d[k]) ? (d[k] as unknown[]).map(Number) : []);
        await tx.unsafe(`UPDATE agenda_item_sources SET agenda_item_id = $1 WHERE id = ANY($2::int[]) AND (agenda_item_id = $3 OR agenda_item_id IS NULL)`, [id, nums('movedSourceIds'), principal] as never[]);
        await tx.unsafe(`UPDATE agenda_item_sources SET agenda_item_id = $1 WHERE id = ANY($2::int[]) AND agenda_item_id IS NULL`, [id, nums('orphanedSourceIds')] as never[]);
        const added = (d.added ?? {}) as Record<string, unknown>;
        const a = (k: string) => intArray(Array.isArray(added[k]) ? (added[k] as unknown[]).map(Number) : []);
        await tx.unsafe(`DELETE FROM agenda_asset_links WHERE agenda_item_id = $1 AND asset_id = ANY($2::int[])`, [principal, a('assets')] as never[]);
        await tx.unsafe(`DELETE FROM agenda_file_links WHERE agenda_item_id = $1 AND asset_file_id = ANY($2::int[])`, [principal, a('files')] as never[]);
        await tx.unsafe(`DELETE FROM agenda_room_links WHERE agenda_item_id = $1 AND substructure_id = ANY($2::int[])`, [principal, a('rooms')] as never[]);
        await tx.unsafe(`DELETE FROM agenda_equipment_links WHERE agenda_item_id = $1 AND equipment_id = ANY($2::int[])`, [principal, a('equipments')] as never[]);
        await tx.unsafe(`UPDATE to_process_actions SET resolved_at = NULL, resolution_reason = NULL, updated_at = now()
                          WHERE account_id = $1 AND id = ANY($2::int[]) AND resolution_reason = 'OBSOLETE'`, [accountId, nums('closedCardIds')] as never[]);
        await tx.unsafe(`INSERT INTO agenda_occurrence_events (agenda_item_id, account_id, event_type, detail_json) VALUES ($1, $2, 'CONSOLIDATION_RESTORED', $3::text::jsonb)`,
          [id, accountId, JSON.stringify({ journalId, principalItemId: principal, restoreRunId: p.restoreRunId })] as never[]);
      }
      await tx.unsafe(`UPDATE agenda_intervention_consolidations SET restored_at = now(), restore_run_id = $2::uuid WHERE id = $1`, [journalId, p.restoreRunId] as never[]);
      return true;
  }
}
