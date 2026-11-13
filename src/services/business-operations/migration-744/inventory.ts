/**
 * Lot 113AP (Trello #744, CDC Opérations / Agenda V2.0, §2 G) — INVENTAIRE
 * DE MIGRATION en LECTURE SEULE, compte par compte.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RIEN N'EST MODIFIÉ
 *
 * Le ticket exige une « simulation par compte avant modification » du modèle
 * (abandon du rôle d'événement PRINCIPAL / RELATED, relations N↔N
 * opération / événement). Ce module ne fait QUE compter : chaque requête est
 * un SELECT borné au compte (`$1`), exécuté dans UNE transaction
 * `REPEATABLE READ READ ONLY` (instantané cohérent ; PostgreSQL refuse toute
 * écriture). Aucune route, aucun bouton : il est appelé par l'e2e et, plus
 * tard, par le lot de migration (sauvegarde → simulation → bascule → retour
 * arrière), qui reste à livrer (voir docs/exploitation/audit-744-operations-agenda.md).
 *
 * Les familles comptées sont celles du ticket : ancien PRINCIPAL, événements
 * techniques vs réels, sources, notifications, liens, refus, TCO et coûts.
 * « Technique » est ici une PRÉSOMPTION mesurable (projection T4 non touchée
 * par l'utilisateur, sans lien direct ni fournisseur) : la qualification
 * définitive appartient au lot T4 (le ticket : « supprimer les projections
 * purement techniques seulement APRÈS qualification »).
 * ══════════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, unknown>;
/** Exécuteur SQL paramétré ($1 = compte). */
export type InventoryQuery = (sql: string, params: unknown[]) => Promise<Row[]>;

/** Une mesure : une requête qui rend UNE ligne de compteurs entiers. */
interface InventoryMeasure {
  readonly key: string;
  readonly label: string;
  readonly sql: string;
}

const OP_ACTIVE = `o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`;
/** Élément d'agenda rattaché à une Opération ACTIVE du même compte. */
const ITEM_OF_ACTIVE_OP = `FROM agenda_items i JOIN business_operations o ON o.id = i.business_operation_id AND o.account_id = i.account_id AND ${OP_ACTIVE}
 WHERE i.account_id = $1`;
/** Projection T4 présumée technique (non touchée, sans rôle USER, sans lien direct ni fournisseur). */
const PRESUMED_TECHNICAL = `i.projection_origin IS NOT NULL AND i.is_automatic AND NOT i.is_automatic_modified
   AND i.operation_role_origin IS DISTINCT FROM 'USER'
   AND NOT EXISTS (SELECT 1 FROM agenda_file_links l WHERE l.agenda_item_id = i.id AND l.provenances && ARRAY['MANUAL_DIRECT', 'AI_DIRECT']::text[])
   AND NOT EXISTS (SELECT 1 FROM agenda_item_suppliers s WHERE s.agenda_item_id = i.id)`;

/**
 * Mesures, dans l'ordre du rapport. Toutes : SELECT seul, `$1` = compte,
 * une ligne de colonnes entières (`::int`).
 */
export const INVENTORY_MEASURES: readonly InventoryMeasure[] = [
  {
    key: 'operations',
    label: 'Opérations par type et état',
    sql: `SELECT
      count(*) FILTER (WHERE ${OP_ACTIVE})::int AS actives,
      count(*) FILTER (WHERE o.invalidated_at IS NOT NULL AND o.merged_into_operation_id IS NULL)::int AS invalidees,
      count(*) FILTER (WHERE o.merged_into_operation_id IS NOT NULL)::int AS fusionnees,
      count(*) FILTER (WHERE ${OP_ACTIVE} AND o.type_code IS NULL)::int AS type_null,
      count(*) FILTER (WHERE ${OP_ACTIVE} AND o.type_code = 'ACQUISITION')::int AS acquisition,
      count(*) FILTER (WHERE ${OP_ACTIVE} AND o.type_code = 'INTERVENTION')::int AS intervention,
      count(*) FILTER (WHERE ${OP_ACTIVE} AND o.type_code = 'CONTRACT')::int AS contract,
      count(*) FILTER (WHERE ${OP_ACTIVE} AND o.type_code = 'FINANCING')::int AS financing,
      count(*) FILTER (WHERE ${OP_ACTIVE} AND o.type_code = 'CLAIM')::int AS claim,
      count(*) FILTER (WHERE ${OP_ACTIVE} AND o.type_code = 'DISPOSAL')::int AS disposal,
      count(*) FILTER (WHERE ${OP_ACTIVE} AND o.type_code = 'OTHER')::int AS other
    FROM business_operations o WHERE o.account_id = $1`,
  },
  {
    key: 'operationsSansEvenement',
    label: 'Opérations actives sans aucun événement / non datées',
    sql: `SELECT
      count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM agenda_items i WHERE i.business_operation_id = o.id AND i.account_id = o.account_id))::int AS sans_evenement,
      count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM agenda_items i WHERE i.business_operation_id = o.id AND i.account_id = o.account_id AND i.operation_role = 'PRINCIPAL'))::int AS sans_principal,
      count(*) FILTER (WHERE o.planned_date IS NULL AND o.start_date IS NULL AND o.realized_date IS NULL AND o.end_date IS NULL)::int AS sans_date_metier,
      count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM business_operation_asset_links b WHERE b.operation_id = o.id AND b.account_id = o.account_id AND b.active))::int AS sans_bien_actif
    FROM business_operations o WHERE o.account_id = $1 AND ${OP_ACTIVE}`,
  },
  {
    key: 'principal',
    label: 'Ancien rôle PRINCIPAL / RELATED des événements',
    sql: `SELECT
      count(*) FILTER (WHERE i.operation_role = 'PRINCIPAL')::int AS principal,
      count(*) FILTER (WHERE i.operation_role = 'PRINCIPAL' AND i.operation_role_origin = 'USER')::int AS principal_user,
      count(*) FILTER (WHERE i.operation_role = 'PRINCIPAL' AND i.start_date IS NULL)::int AS principal_non_date,
      count(*) FILTER (WHERE i.operation_role = 'PRINCIPAL' AND i.projection_origin IS NOT NULL)::int AS principal_projete,
      count(*) FILTER (WHERE i.operation_role = 'PRINCIPAL' AND ${PRESUMED_TECHNICAL})::int AS principal_presume_technique,
      count(*) FILTER (WHERE i.operation_role = 'RELATED')::int AS related,
      count(*) FILTER (WHERE i.operation_role IS NULL)::int AS role_nul
    ${ITEM_OF_ACTIVE_OP}`,
  },
  {
    key: 'evenements',
    label: 'Événements rattachés : techniques présumés vs réels',
    sql: `SELECT
      count(*)::int AS rattaches,
      count(*) FILTER (WHERE i.projection_origin IS NOT NULL)::int AS projetes_t4,
      count(*) FILTER (WHERE ${PRESUMED_TECHNICAL})::int AS techniques_presumes,
      count(*) FILTER (WHERE i.projection_origin IS NOT NULL AND (NOT i.is_automatic OR i.is_automatic_modified))::int AS projetes_modifies_utilisateur,
      count(*) FILTER (WHERE i.projection_origin IS NULL)::int AS non_projetes,
      count(*) FILTER (WHERE i.start_date IS NULL)::int AS non_dates,
      count(*) FILTER (WHERE i.start_date > CURRENT_DATE)::int AS futurs
    ${ITEM_OF_ACTIVE_OP}`,
  },
  {
    key: 'evenementsOrphelins',
    label: 'Événements pointant une Opération inactive ou d’un autre compte',
    sql: `SELECT
      count(*) FILTER (WHERE o.id IS NULL)::int AS operation_absente,
      count(*) FILTER (WHERE o.id IS NOT NULL AND o.account_id <> i.account_id)::int AS intercompte,
      count(*) FILTER (WHERE o.id IS NOT NULL AND o.account_id = i.account_id AND NOT (${OP_ACTIVE}))::int AS operation_inactive
    FROM agenda_items i LEFT JOIN business_operations o ON o.id = i.business_operation_id
    WHERE i.account_id = $1 AND i.business_operation_id IS NOT NULL`,
  },
  {
    key: 'liens',
    label: 'Liens documents / biens / fournisseurs / pièces / équipements',
    sql: `SELECT
      (SELECT count(*) FROM business_operation_documents d JOIN business_operations o ON o.id = d.operation_id AND o.account_id = d.account_id AND ${OP_ACTIVE} WHERE d.account_id = $1 AND d.active)::int AS documents_operation,
      (SELECT count(*) FROM business_operation_documents d JOIN business_operations o ON o.id = d.operation_id AND o.account_id = d.account_id AND ${OP_ACTIVE} WHERE d.account_id = $1 AND d.active AND 'USER' = ANY(d.origins))::int AS documents_operation_user,
      (SELECT count(*) FROM business_operation_asset_links b WHERE b.account_id = $1 AND b.active)::int AS biens_operation,
      (SELECT count(*) FROM business_operation_suppliers s WHERE s.account_id = $1 AND s.status = 'ACTIVE')::int AS fournisseurs_operation,
      (SELECT count(*) FROM business_operation_room_links r WHERE r.account_id = $1 AND r.active)::int AS pieces_operation,
      (SELECT count(*) FROM business_operation_equipment_links q WHERE q.account_id = $1 AND q.active)::int AS equipements_operation,
      (SELECT count(*) FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $1 WHERE 'OPERATION_PRINCIPAL' = ANY(l.provenances))::int AS liens_doc_propages_principal,
      (SELECT count(*) FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $1 WHERE l.provenances = ARRAY['OPERATION_PRINCIPAL']::text[])::int AS liens_doc_uniquement_principal`,
  },
  {
    key: 'decisions',
    label: 'Décisions et refus utilisateur à préserver',
    sql: `SELECT
      count(*) FILTER (WHERE m.decision = 'REJECTED')::int AS refus,
      count(*) FILTER (WHERE m.decision = 'CONFIRMED')::int AS confirmations,
      count(*) FILTER (WHERE m.source_kind = 'PRINCIPAL' AND m.decision = 'REJECTED')::int AS principal_retire,
      count(*) FILTER (WHERE m.source_kind = 'PRINCIPAL' AND m.decision = 'CONFIRMED')::int AS principal_designe,
      count(*) FILTER (WHERE m.source_kind = 'PRINCIPAL_LINK')::int AS liens_principal,
      count(*) FILTER (WHERE m.source_kind = 'AGENDA' AND m.decision = 'REJECTED')::int AS evenements_detaches,
      (SELECT count(*) FROM business_operation_projection_suppressions p WHERE p.account_id = $1)::int AS projections_supprimees
    FROM business_operation_match_decisions m WHERE m.account_id = $1 AND m.active`,
  },
  {
    key: 'notifications',
    label: 'Notifications d’événements rattachés à une Opération',
    sql: `SELECT
      count(*)::int AS notifications,
      count(*) FILTER (WHERE n.status = 'pending')::int AS en_attente,
      count(*) FILTER (WHERE i.operation_role = 'PRINCIPAL')::int AS sur_principal,
      count(*) FILTER (WHERE i.operation_role = 'PRINCIPAL' AND n.status = 'pending')::int AS en_attente_sur_principal
    FROM notification_outbox n
    JOIN agenda_items i ON n.entity_type = 'agenda_item' AND n.entity_id = i.id::text AND i.account_id = $1
    WHERE n.account_id = $1 AND i.business_operation_id IS NOT NULL`,
  },
  {
    key: 'finance',
    label: 'TCO / coûts : composantes financières (référence avant / après)',
    sql: `SELECT
      count(*)::int AS composantes,
      count(DISTINCT c.operation_id)::int AS operations_avec_composantes,
      coalesce(sum(c.amount_eur_cents) FILTER (WHERE c.amount_eur_cents IS NOT NULL), 0)::bigint::text AS somme_eur_cents,
      count(*) FILTER (WHERE c.amount_eur_cents IS NULL)::int AS sans_contrevaleur_eur,
      count(*) FILTER (WHERE o.type_code = 'FINANCING')::int AS composantes_financement
    FROM business_operation_financial_components c
    JOIN business_operations o ON o.id = c.operation_id AND o.account_id = c.account_id AND ${OP_ACTIVE}
    WHERE c.account_id = $1 AND c.active`,
  },
];

export type InventoryReport = Record<string, Record<string, number | string>>;

function normalise(row: Row | undefined): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    // Sommes en texte (bigint exact), compteurs en nombre.
    out[k] = k.startsWith('somme') ? String(v ?? '0') : Number(v ?? 0);
  }
  return out;
}

async function readOnlyQuery(): Promise<{ run<T>(fn: (q: InventoryQuery) => Promise<T>): Promise<T> }> {
  const { pgClient } = await import('@/db');
  return {
    run: async (fn) => pgClient.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) =>
      fn(async (sql, params) => (await tx.unsafe(sql, params as never[])) as unknown as Row[])) as never,
  };
}

/**
 * Inventaire d'UN compte : toutes les mesures dans un même instantané en
 * lecture seule. `q` (tests) : exécuteur fourni, sans transaction.
 */
export async function simulateAccountInventory(accountId: number, q?: InventoryQuery): Promise<InventoryReport> {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('INVALID_ACCOUNT_ID');
  const collect = async (exec: InventoryQuery): Promise<InventoryReport> => {
    const report: InventoryReport = {};
    for (const m of INVENTORY_MEASURES) report[m.key] = normalise((await exec(m.sql, [accountId]))[0]);
    return report;
  };
  if (q) return collect(q);
  return (await readOnlyQuery()).run(collect);
}

/** Point d'attention de migration (lecture du rapport, pur). */
export interface InventoryFinding {
  code: string;
  /** BLOQUANT : la migration ne peut pas partir sans traitement explicite. */
  severity: 'BLOQUANT' | 'A_PRESERVER' | 'INFO';
  count: number;
  message: string;
}

const n = (r: InventoryReport, k: string, f: string): number => Number(r[k]?.[f] ?? 0);

/** Lecture PURE du rapport : ce que le lot de migration devra traiter. */
export function inventoryFindings(r: InventoryReport): InventoryFinding[] {
  const out: InventoryFinding[] = [];
  const add = (code: string, severity: InventoryFinding['severity'], count: number, message: string) => { if (count > 0) out.push({ code, severity, count, message }); };
  add('CROSS_ACCOUNT_EVENT', 'BLOQUANT', n(r, 'evenementsOrphelins', 'intercompte'), 'Événement relié à une Opération d’un autre compte : à corriger avant toute migration.');
  add('USER_PRINCIPAL', 'A_PRESERVER', n(r, 'principal', 'principal_user'), 'Événement de référence désigné par l’utilisateur : la décision doit survivre à l’abandon du rôle.');
  add('PRINCIPAL_REFUSALS', 'A_PRESERVER', n(r, 'decisions', 'principal_retire'), 'Retrait mémorisé de l’événement de référence : ne jamais le rétablir.');
  add('USER_REFUSALS', 'A_PRESERVER', n(r, 'decisions', 'refus'), 'Refus utilisateur actifs : aucun lien refusé recréé silencieusement.');
  add('PROJECTION_SUPPRESSIONS', 'A_PRESERVER', n(r, 'decisions', 'projections_supprimees'), 'Projections supprimées par l’utilisateur : ne jamais les recréer.');
  add('PRINCIPAL_ONLY_DOC_LINKS', 'A_PRESERVER', n(r, 'liens', 'liens_doc_uniquement_principal'), 'Liens document ↔ événement qui n’existent que par la propagation au principal : à reporter sur l’Opération avant tout retrait.');
  add('PENDING_NOTIF_ON_PRINCIPAL', 'A_PRESERVER', n(r, 'notifications', 'en_attente_sur_principal'), 'Rappels en attente sur un événement de référence : à conserver (aucun rappel perdu ni doublé).');
  add('PRESUMED_TECHNICAL_PRINCIPAL', 'INFO', n(r, 'principal', 'principal_presume_technique'), 'Événements de référence présumés techniques : candidats au retrait APRÈS qualification T4.');
  add('OPERATION_WITHOUT_EVENT', 'INFO', n(r, 'operationsSansEvenement', 'sans_evenement'), 'Opérations sans événement : invisibles aujourd’hui dans l’Agenda et la Timeline.');
  add('OPERATION_WITHOUT_PRINCIPAL', 'INFO', n(r, 'operationsSansEvenement', 'sans_principal'), 'Opérations sans événement de référence : non regroupées dans la Timeline, sans libellé propre.');
  add('ORPHAN_OPERATION_REF', 'INFO', n(r, 'evenementsOrphelins', 'operation_absente') + n(r, 'evenementsOrphelins', 'operation_inactive'), 'Événements reliés à une Opération absente ou inactive.');
  return out;
}
