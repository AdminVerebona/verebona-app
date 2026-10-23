/**
 * Retrait TRACÉ d'éléments d'agenda automatiques — CDC 15 T4-08, §14.6
 * (relecture du lot 14).
 *
 * `agenda_items` n'admet pas de suppression logique (ni statut ni
 * `deleted_at`) : chaque retrait automatique écrit, dans la MÊME instruction
 * SQL que le DELETE, une ligne `agenda_item_removals` (migration 0223) —
 * clé fonctionnelle, date, titre, source, bien, motif, image de l'élément et
 * de ses liens — pour pouvoir le rattraper.
 *
 * Gardes dans le DELETE lui-même : compte, élément AUTOMATIQUE, jamais
 * modifié par l'utilisateur (`is_automatic_modified`, `manual_status`,
 * prévision confirmée par l'utilisateur — lot 75F) — un
 * élément touché entre le plan et le retrait est épargné, sans course.
 * Table de trace absente : AUCUN retrait (signalé) — on ne supprime pas sans
 * pouvoir rattraper.
 */
import { probeCount, schemaNotReadyMessage } from '@/lib/schema-readiness-log';
import type postgres from 'postgres';

type Sql = postgres.Sql;

/**
 * OPERATION_PROJECTION (lot 46, O7) : projection d'une Opération retirée (Opération invalidée, doublon de fusion, orpheline).
 * OPERATION_CONSOLIDATION (lot 76H) : représentation T4 équivalente absorbée par l'élément principal de l'Opération
 * (journal 0591 `agenda_intervention_consolidations`, restaurable).
 * ORPHAN_ASSET_FIELD (lot 82B) : échéance de fiche sans plus aucun rattachement vivant, retirée par le contrôle de
 * cohérence COH-AGENDA-ORPHANS (remplace l'ancien statut utilisateur « annulé » posé sans trace par la maintenance horaire).
 */
export type AgendaRemovalReason = 'SOURCE_SYNC' | 'DEDUPE_14_6' | 'OPERATION_PROJECTION' | 'OPERATION_CONSOLIDATION' | 'ORPHAN_ASSET_FIELD';

let pret: { ready: boolean; at: number } | null = null;

/** Table `agenda_item_removals` présente ? (cache 5 min ; ne lève jamais) */
export async function agendaRemovalTraceReady(sql: Sql): Promise<boolean> {
  if (pret && (pret.ready || Date.now() - pret.at < 5 * 60_000)) return pret.ready;
  let ready = false;
  let trouvees: number | null = null;
  let erreur: unknown;
  try {
    const [r] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'agenda_item_removals'`;
    trouvees = probeCount(r ? [r] : []); // lot 75A : résultat inexploitable = inconnu, pas 0
    ready = trouvees === 1;
  } catch (e) { ready = false; erreur = e; }
  if (!ready && (!pret || pret.ready)) {
    console.error(schemaNotReadyMessage({
      scope: '[agenda]', migration: '0223 (agenda_item_removals)', expected: ['table agenda_item_removals'], found: trouvees, error: erreur,
      consequence: 'Aucun retrait automatique d’élément d’agenda.',
    }));
  }
  pret = { ready, at: Date.now() };
  return ready;
}

/** Réservé aux tests. */
export function __resetAgendaRemovalTraceForTests(ready: boolean | null = null): void {
  pret = ready === null ? null : { ready, at: Date.now() };
}

/**
 * Retire les éléments `ids` du compte (gardes ci-dessus) en traçant chacun.
 * Rend les identifiants effectivement retirés.
 */
export async function removeAgendaItemsTraced(sql: Sql, p: {
  accountId: number;
  ids: number[];
  reason: AgendaRemovalReason;
  sourceFileId?: number | null;
  assetId?: number | null;
}): Promise<number[]> {
  const ids = [...new Set(p.ids.filter((x) => Number.isInteger(x) && x > 0))];
  if (ids.length === 0) return [];
  if (!(await agendaRemovalTraceReady(sql))) return [];
  const rows = await sql<{ id: number }[]>`
    WITH gone AS (
      DELETE FROM agenda_items
       WHERE account_id = ${p.accountId} AND id IN ${sql(ids)}
         AND is_automatic AND NOT is_automatic_modified
         AND (manual_status IS NULL OR manual_status = '')
         AND confirmation_mode IS DISTINCT FROM 'USER'
      RETURNING *
    )
    INSERT INTO agenda_item_removals
      (account_id, agenda_item_id, functional_key, start_date, title, source_file_id, asset_id, reason, item_snapshot, links_snapshot)
    SELECT g.account_id, g.id, to_jsonb(g)->>'functional_key', g.start_date, g.title,
           ${p.sourceFileId ?? null}::int,
           ${p.assetId ?? null}::int,
           ${p.reason},
           to_jsonb(g),
           jsonb_build_object(
             'assets',     COALESCE((SELECT jsonb_agg(l.asset_id) FROM agenda_asset_links l WHERE l.agenda_item_id = g.id), '[]'::jsonb),
             'files',      COALESCE((SELECT jsonb_agg(l.asset_file_id) FROM agenda_file_links l WHERE l.agenda_item_id = g.id), '[]'::jsonb),
             'rooms',      COALESCE((SELECT jsonb_agg(l.substructure_id) FROM agenda_room_links l WHERE l.agenda_item_id = g.id), '[]'::jsonb),
             'equipments', COALESCE((SELECT jsonb_agg(l.equipment_id) FROM agenda_equipment_links l WHERE l.agenda_item_id = g.id), '[]'::jsonb)
           )
      FROM gone g
    RETURNING agenda_item_id AS id`;
  return rows.map((r) => Number(r.id)).sort((a, b) => a - b);
}
