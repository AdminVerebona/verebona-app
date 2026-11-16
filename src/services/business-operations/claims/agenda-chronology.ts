/**
 * Carte #744, point G (« exports ») — CHRONOLOGIE d'un sinistre (événement de
 * référence CLAIM) lue dans le GRAPHE CANONIQUE.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CET AJOUT
 *
 * La lecture historique des sinistres (`./read.ts`) ne connaissait qu'UN
 * support : la colonne `agenda_items.business_operation_id`. Depuis le
 * modèle cible (CDC §4 : relations N↔N persistantes,
 * `business_operation_agenda_links`), un élément de l'Agenda peut être relié
 * à un événement de référence SANS passer par cette colonne — et par le même
 * élément à PLUSIEURS événements de référence. Il manquait alors à la
 * chronologie du dossier « Assurance — sinistre » et de l'Assistant.
 *
 * Ce module lit les DEUX supports et n'en rend qu'UNE entrée par élément
 * (clé = identifiant de l'élément d'Agenda) : un élément porté à la fois par
 * la colonne et par un lien actif, ou partagé entre deux événements de
 * référence, n'apparaît JAMAIS deux fois (CDC §12, AC24, AC69).
 *
 * Aucune donnée n'est inventée : seuls des éléments d'Agenda existants du
 * compte sont rendus, avec LEUR date (jamais la date de présentation de
 * l'événement de référence). Lecture seule.
 *
 * L'ordre de la lecture antérieure est conservé à l'identique (élément
 * encore marqué principal d'abord, puis par date — sans date en dernier —
 * puis identifiant) pour ne déplacer aucune ancre existante ; le rôle
 * PRINCIPAL n'est plus une condition d'APPARTENANCE, seulement un reste de
 * tri que la migration du point G retirera (AC40).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';

type Row = Record<string, unknown>;
export interface ClaimChronologyExecutor { execute: (q: SQL) => Promise<unknown> }

/** Entrée de chronologie : l'élément d'Agenda tel qu'il existe, et l'événement de référence qui le cite. */
export interface ClaimChronologyRow {
  operationId: number;
  id: number;
  title: string;
  date: string | null;
  /** L'élément porte ENCORE le rôle historique PRINCIPAL sur cet événement de référence. */
  principal: boolean;
}

const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x) && x > 0).join(',')}}`;

/**
 * Éléments d'Agenda des événements de référence `operationIds` du compte, par
 * les DEUX supports (colonne historique et liens actifs du graphe), chaque
 * élément une seule fois par événement de référence.
 */
export async function loadClaimChronology(
  x: ClaimChronologyExecutor, accountId: number, operationIds: readonly number[],
): Promise<ClaimChronologyRow[]> {
  const liste = intArray(operationIds);
  if (liste === '{}') return [];
  const rows = (await x.execute(sql`
    WITH supports AS (
      -- Lot 114O (#744) : « porte un fait de l'événement de référence » (lien N↔N) remplace le rôle
      -- « principal » comme ORDRE de tri (aucune ancre déplacée).
      SELECT ai.business_operation_id AS operation_id, ai.id,
             EXISTS (SELECT 1 FROM business_operation_agenda_links g
                      WHERE g.account_id = ai.account_id AND g.operation_id = ai.business_operation_id
                        AND g.agenda_item_id = ai.id AND g.state = 'ACTIVE' AND g.fact_key IS NOT NULL) AS principal
        FROM agenda_items ai
       WHERE ai.business_operation_id = ANY(${liste}::bigint[]) AND ai.account_id = ${accountId}
      UNION ALL
      SELECT l.operation_id, l.agenda_item_id AS id, false AS principal
        FROM business_operation_agenda_links l
       WHERE l.operation_id = ANY(${liste}::bigint[]) AND l.account_id = ${accountId} AND l.state = 'ACTIVE'
    ), uniques AS (
      -- Un élément, une entrée par événement de référence, quel que soit le nombre de supports.
      SELECT s.operation_id, s.id, bool_or(s.principal) AS principal FROM supports s GROUP BY s.operation_id, s.id
    )
    SELECT u.operation_id, u.id, ai.title, ai.start_date::text AS date, u.principal
      FROM uniques u
      JOIN agenda_items ai ON ai.id = u.id AND ai.account_id = ${accountId}
     ORDER BY u.operation_id, u.principal DESC, ai.start_date NULLS LAST, ai.id`)) as unknown as Row[];
  return rows.map((r) => ({
    operationId: Number(r.operation_id), id: Number(r.id), title: String(r.title ?? ''),
    date: r.date === null || r.date === undefined ? null : String(r.date),
    principal: r.principal === true,
  }));
}
