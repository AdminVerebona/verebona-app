/**
 * Suppression d'un événement PAR L'UTILISATEUR — trace persistante
 * d'exclusion (« tombstone ») — lot 113P (#715, décision PO du 06/11/2026).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Les événements n'ont plus de statut : un événement inexistant, erroné ou
 * « annulé » est SUPPRIMÉ par l'utilisateur. Cette suppression doit PRÉVALOIR
 * sur toutes les réanalyses (rattrapage T3, passage T4, réanalyse T1, contrôle
 * de cohérence quotidien, nouvelle lecture des mêmes documents) : le même
 * événement n'est jamais recréé automatiquement depuis les mêmes sources.
 *
 * REPRÉSENTATION (aucune table nouvelle)
 *
 * Une ligne `agenda_item_removals` (0223, journal des retraits déjà
 * restaurable) écrite dans la MÊME transaction que la suppression :
 *   · `reason` = USER_DELETED (cet événement / cette occurrence) ou
 *     USER_DELETED_SERIES (suppression de toute la série) ;
 *   · `functional_key`, `start_date`, `title`, image complète de l'élément
 *     (`item_snapshot` : série, champ d'origine, document d'origine…) et de
 *     ses liens (`links_snapshot`).
 *
 * RÈGLE DE BLOCAGE (`userDeletionBlocks`, création AUTOMATIQUE seulement)
 *   1. même clé fonctionnelle (même document, même cible, même type, même
 *      occurrence) qu'un événement supprimé par l'utilisateur ;
 *   2. occurrence PRÉVISIONNELLE (récurrence) d'une série supprimée en entier
 *      (même `series_key`) ;
 *   3. sans clé fonctionnelle : même champ d'origine, même date et même bien
 *      qu'un événement supprimé par l'utilisateur.
 * Jamais bloqués : une création MANUELLE (l'utilisateur peut toujours
 * recréer l'événement), un événement distinct (autre clé, autre date), une
 * nouvelle occurrence d'une série dont seule UNE occurrence a été supprimée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql as dsql } from 'drizzle-orm';

/** Motifs de `agenda_item_removals.reason` posés par une suppression utilisateur. */
export const USER_DELETION_REASONS = ['USER_DELETED', 'USER_DELETED_SERIES'] as const;
export type UserDeletionReason = (typeof USER_DELETION_REASONS)[number];

/** Portée d'une suppression demandée par l'utilisateur. */
export type AgendaDeletionScope = 'OCCURRENCE' | 'SERIES';

type Executor = { execute: (q: ReturnType<typeof dsql>) => Promise<unknown> };

/**
 * Écrit la trace d'exclusion des éléments `ids` du compte, AVANT leur
 * suppression (même transaction : l'image des liens est encore lisible).
 * Rend le nombre de traces écrites.
 */
export async function recordUserDeletion(tx: Executor, p: {
  accountId: number; ids: readonly number[]; scope: AgendaDeletionScope; userId: number | null;
}): Promise<number> {
  const ids = [...new Set(p.ids.filter((x) => Number.isSafeInteger(x) && x > 0))];
  if (!ids.length) return 0;
  const reason: UserDeletionReason = p.scope === 'SERIES' ? 'USER_DELETED_SERIES' : 'USER_DELETED';
  const r = await tx.execute(dsql`
    INSERT INTO agenda_item_removals
      (account_id, agenda_item_id, functional_key, start_date, title, source_file_id, asset_id, reason, item_snapshot, links_snapshot)
    SELECT g.account_id, g.id, to_jsonb(g)->>'functional_key', g.start_date, g.title,
           CASE WHEN g.origin_ref_type = 'asset_file' THEN g.origin_ref_id END,
           (SELECT min(l.asset_id) FROM agenda_asset_links l WHERE l.agenda_item_id = g.id),
           ${reason},
           to_jsonb(g) || jsonb_build_object('deleted_by_user_id', ${p.userId}::int),
           jsonb_build_object(
             'assets',     COALESCE((SELECT jsonb_agg(l.asset_id) FROM agenda_asset_links l WHERE l.agenda_item_id = g.id), '[]'::jsonb),
             'files',      COALESCE((SELECT jsonb_agg(l.asset_file_id) FROM agenda_file_links l WHERE l.agenda_item_id = g.id), '[]'::jsonb),
             'rooms',      COALESCE((SELECT jsonb_agg(l.substructure_id) FROM agenda_room_links l WHERE l.agenda_item_id = g.id), '[]'::jsonb),
             'equipments', COALESCE((SELECT jsonb_agg(l.equipment_id) FROM agenda_equipment_links l WHERE l.agenda_item_id = g.id), '[]'::jsonb)
           )
      FROM agenda_items g
     WHERE g.account_id = ${p.accountId} AND g.id IN (${dsql.join(ids.map((i) => dsql`${i}`), dsql`, `)})
    RETURNING id`);
  return Array.isArray(r) ? r.length : Number((r as { length?: number })?.length ?? 0);
}

/** Candidat à une création AUTOMATIQUE (T4, projection, reprise). */
export interface AutomaticAgendaCandidate {
  functionalKey?: string | null;
  seriesKey?: string | null;
  occurrenceNature?: string | null;
  originFieldKey?: string | null;
  startDate?: string | null;
  assetIds?: readonly number[];
}

type Unsafe = { unsafe: (q: string, p?: never[]) => Promise<unknown> };

/**
 * La création automatique de `c` recréerait-elle un événement que
 * l'utilisateur a supprimé ? (règle de l'en-tête). Ne lève jamais : une
 * lecture impossible rend `null` (l'appelant journalise et poursuit — la
 * table 0223 est présente partout ; aucune création n'est bloquée sur une
 * panne de lecture, comportement antérieur).
 */
export async function userDeletionBlocks(accountId: number, c: AutomaticAgendaCandidate, client?: Unsafe): Promise<UserDeletionReason | null> {
  const key = c.functionalKey?.trim() || null;
  const serie = c.occurrenceNature === 'FORECAST' ? (c.seriesKey?.trim() || null) : null;
  const champ = !key && c.originFieldKey && c.startDate && c.assetIds?.length ? c.originFieldKey : null;
  if (!key && !serie && !champ) return null;
  try {
    const sql = client ?? ((await import('@/db')).pgClient as unknown as Unsafe);
    const r = (await sql.unsafe(
      `SELECT reason FROM agenda_item_removals
        WHERE account_id = $1 AND reason = ANY($2::text[])
          AND (($3::text IS NOT NULL AND functional_key = $3)
            OR ($4::text IS NOT NULL AND reason = 'USER_DELETED_SERIES' AND item_snapshot->>'series_key' = $4)
            OR ($5::text IS NOT NULL AND item_snapshot->>'origin_field_key' = $5 AND start_date = $6::date
                AND links_snapshot->'assets' ?| $7::text[]))
        ORDER BY id DESC LIMIT 1`,
      [accountId, [...USER_DELETION_REASONS], key, serie, champ, champ ? c.startDate : null,
        (c.assetIds ?? []).map(String)] as never[],
    )) as Array<{ reason: string }>;
    return (r[0]?.reason as UserDeletionReason | undefined) ?? null;
  } catch (e) {
    console.error('[agenda] lecture des suppressions utilisateur impossible :', (e as Error).message);
    return null;
  }
}
