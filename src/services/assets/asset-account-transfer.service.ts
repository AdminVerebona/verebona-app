/**
 * Un bien change de compte : ses DONNÉES le suivent — lot 40, volet B
 * (décision PO : « les documents doivent suivre le bien qui change de
 * compte » ; constat du lot 39 sur `duo.service.ts`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ
 *
 * Un déplacement Duo (demande acceptée, départ d'un membre) ne mettait à jour
 * que `assets.account_id`. Tout ce qui porte son propre `account_id` restait
 * dans l'ancien compte : documents, analyses, liens, miniatures, preuves,
 * agenda, « À traiter »… Le nouveau titulaire ne voyait plus les documents
 * de son bien (accès refusé par compte), l'ancien voyait des documents d'un
 * bien qu'il n'a plus — et la suppression de l'ancien compte aurait PURGÉ
 * les fichiers (purge par `asset_files.account_id`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLES (même transaction que le changement de compte du bien)
 *
 * Arbre du bien : le bien, ses équipements, sous-structures et pièces.
 *
 * DOCUMENTS
 *   · rattaché UNIQUEMENT à l'arbre du bien (colonnes `asset_id`,
 *     `linked_asset_id`, `equipment_id`, `substructure_id`,
 *     `linked_room_id`, liens N-N ACTIFS) → SUIT le bien, avec tout ce qui
 *     en dérive (analyses T1, faits, tableaux, unités de la source,
 *     couverture, candidats Opération, valeurs « À traiter » du document,
 *     versions, miniatures, liens) et ses sources secondaires regroupées.
 *     Les fichiers S3 ne bougent pas : leur clé ne dépend pas du compte
 *     (`verebona/u_<déposant>/…`) et l'accès est contrôlé par
 *     `asset_files.account_id`. Les miniatures gardent leur clé (chemin
 *     servi tel quel par sa ligne).
 *   · rattaché AUSSI à un autre bien resté dans l'ancien compte → RESTE dans
 *     l'ancien compte ; son lien vers l'arbre du bien est retiré (colonnes
 *     remises sur un bien restant, liens N-N REMOVED), les preuves qu'il
 *     portait sur le bien sont retirées (WITHDRAWN, T3 réconcilie).
 *     Décision : aucune duplication automatique de données entre comptes
 *     (même parti que la transmission, qui COPIE à la demande, et que les
 *     Opérations multi-biens du lot 39, qui restent) ; aucune perte : le
 *     document reste entier là où il documente encore un bien.
 *   · un lien proposé (PROPOSED) seul ne rattache pas : le document reste,
 *     la proposition est retirée.
 *
 * DONNÉES DU BIEN : informations complémentaires, preuves par champ,
 * historiques d'écriture, pièces (rooms), événements et échéances
 * historiques, incohérences, réconciliations, changements d'identifiant,
 * tombstones d'agenda, transmissions (une transmission EN ATTENTE est
 * annulée : le lien envoyé par l'ancien titulaire ne vaut plus).
 *
 * AGENDA : un élément rattaché seulement à l'arbre du bien (ou, sans aucun
 * bien, seulement à des documents qui partent) suit, avec ses occurrences et
 * conflits ; un élément multi-biens reste, son lien vers l'arbre est retiré.
 * Aucun lien ne franchit les comptes (fichiers, sources, Opération).
 *
 * « À TRAITER » : actions ciblant le bien, ses équipements, pièces,
 * documents ou éléments d'agenda qui partent, avec leur journal.
 *
 * FOURNISSEURS (fiches par compte) : un fournisseur lié au bien, à ses
 * équipements ou aux documents qui partent est RÉUTILISÉ dans le nouveau
 * compte (même nom normalisé et même SIRET), sinon COPIÉ — sans IBAN ni
 * titulaire (donnée bancaire jamais recopiée d'office) ; la fiche d'origine
 * reste dans l'ancien compte.
 *
 * OPÉRATIONS : déjà transférées par `transferAssetOperationsInTx` (lot 39) ;
 * ici, toute source qui se retrouve dans un autre compte que son Opération
 * est désactivée (C25 : aucune relation inter-comptes) et l'Opération est
 * invalidée si plus rien ne la prouve (C8).
 *
 * N'EST PAS DÉPLACÉ (appartient au compte, pas au bien) : consommation et
 * coûts IA, quotas d'analyses consommés, journaux d'audit admin, exports
 * générés, conversations T2 (privées), rapports de migration historiques.
 * Quotas de STOCKAGE : calculés à la lecture depuis `asset_files`
 * (`storage-quota.ts`) — recalculés de fait pour les deux comptes.
 *
 * Idempotent : ne touche que ce qui est encore dans l'ancien compte ; rejoué
 * (rattrapage des déplacements passés, `asset-account-backfill.ts`), il ne
 * fait rien de plus.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';
import type { DbTx } from '@/services/business-operations/lock';
import type { BusinessOperationEvent } from '@/services/business-operations/events';
import { withBusinessOperationWriteInTx } from '@/services/business-operations/write';

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: DbTx, q: SQL): Promise<T[]> => (await tx.execute(q)) as unknown as T[];
const num = (v: unknown) => Number(v);
/** Tableau d'entiers en paramètre (`{1,2}`::int[]) — entiers seulement. */
const ints = (l: readonly number[]) => sql`${`{${l.filter((x) => Number.isInteger(x)).join(',')}}`}::int[]`;
/** Même tableau en texte (colonnes `target_id` TEXT d'`ai_job_queue`). */
const texts = (l: readonly number[]) => sql`${`{${l.filter((x) => Number.isInteger(x)).join(',')}}`}::text[]`;
const bigints = (l: readonly number[]) => sql`${`{${l.filter((x) => Number.isInteger(x)).join(',')}}`}::bigint[]`;

/**
 * Tables dérivées d'un DOCUMENT (colonne du fichier) qui suivent le document.
 * Ordre sans importance (aucune contrainte entre elles sur `account_id`).
 */
export const FILE_SCOPED_TABLES: ReadonlyArray<readonly [table: string, column: string]> = [
  ['asset_file_thumbnails', 'file_id'],
  ['document_versions', 'file_id'],
  ['document_analysis_runs', 'asset_file_id'],
  ['document_analysis_proposals', 'asset_file_id'],
  ['document_extractions', 'file_id'],
  ['document_facts', 'file_id'],
  ['document_field_values', 'file_id'],
  ['document_tables', 'file_id'],
  ['document_table_cells', 'file_id'],
  ['document_source_units', 'file_id'],
  ['document_extraction_coverage', 'file_id'],
  ['document_unresolved_facts', 'file_id'],
  ['document_title_events', 'file_id'],
  ['document_asset_resolutions', 'file_id'],
  ['document_operation_candidates', 'file_id'],
  ['t1_quality_signals', 'file_id'],
  ['ai_field_updates', 'asset_file_id'],
  // Lot 58B : diagnostic et mémoire de pertinence des règles documentaires (0418).
  ['document_rule_evaluations', 'file_id'],
  // Lot 61 : extract brut déterministe et états de phases T1 (0435).
  ['document_raw_extracts', 'file_id'],
  // Lot 61 : issue de chaque carte documentaire examinée par une campagne de réévaluation (0445).
  ['to_process_relevance_campaign_items', 'file_id'],
  // Lot 61 : historique des renommages (harmonisation T3) — suit le document (0450).
  ['document_rename_events', 'file_id'],
];

/** Tables des données du BIEN (colonne `asset_id`) qui suivent le bien. */
export const ASSET_SCOPED_TABLES: readonly string[] = [
  'asset_additional_infos', 'field_evidence', 'ai_field_updates', 'canonical_field_writes', 'rooms',
  'inconsistency_registry', 'reconciliation_runs', 'reconciliation_decisions', 'document_asset_identifier_changes',
  'agenda_item_removals', 'impact_queue',
  // Lot 54D (TCO §3.5) : forfaits d'usage du bien — suivent le bien.
  'asset_usage_budgets',
  // Lot 76J : état du contrôle « Informations » et mémoire des arbitrages tranchés — suivent le bien
  // (le nouveau compte n'a pas à reproposer un arbitrage déjà tranché sur ce bien).
  't3_information_checks',
];

/**
 * Tables À DESSEIN laissées au compte d'origine (documentation et test de
 * couverture : toute table portant `account_id` ET une colonne de bien ou de
 * fichier doit figurer dans l'une des trois listes).
 */
export const ACCOUNT_OWNED_TABLES: Readonly<Record<string, string>> = {
  ai_usage_event: 'consommation IA facturée au compte qui a analysé',
  ai_operation: 'trace d’appel IA du compte',
  ai_security_lock: 'verrou de sécurité IA du compte',
  ai_output_replays: 'rejeu technique des sorties IA',
  ai_execution_reports: 'rapport d’exécution T1 / T3 figé du compte qui a analysé (diagnostic BO, lot 58C) — jamais déplacé',
  export_generation: 'archive générée et téléchargée par l’ancien titulaire',
  cdc15_migration_backups: 'sauvegarde de migration historique (restauration)',
  cdc15_migration_report: 'rapport de migration historique',
  room_merge_changes: 'journal de migration historique (restauration)',
  field_origin_migration_audit: 'audit de migration historique',
  document_naming_members: 'index technique de l’harmonisation T3 (lot 72B), jamais déplacé : un document parti est retiré à la fin du prochain cycle de lecture de l’ancien compte et réindexé par la lecture du nouveau',
  document_validation_reprise: 'journal de la reprise des documents « à valider » (lot 71B, trace d’exploitation) — jamais déplacé',
  verebona_fact_revalidations: 'revalidation T2 d’une conversation privée',
  supplier_review_items: 'déplacé seulement pour les documents qui partent (traité à part)',
  events: 'traité à part (asset_id / linked_asset_id)',
  deadlines: 'traité à part (asset_id / linked_asset_id)',
  asset_transmissions: 'traité à part (transmission en attente annulée)',
  document_asset_links: 'traité à part (liens du document)',
  asset_files: 'traité à part (le document)',
  business_operation_asset_links: 'Opérations : lot 39 (transferAssetOperationsInTx)',
  business_operation_equipment_links: 'Opérations : lot 39',
  business_operation_financial_components: 'Opérations : lot 39',
  business_operation_asset_data_marks: 'Opérations : repère technique (lot 43) — un bien déplacé est réexaminé dans son nouveau compte (compte du repère ≠ compte du bien)',
  business_operation_claim_migration_marks: 'Opérations : repère technique de la migration Sinistre (lot 44) — un bien déplacé est réexaminé dans son nouveau compte (compte du repère ≠ compte du bien)',
  business_operation_asset_exclusions: 'Opérations : décision de l’utilisateur sur SON sinistre (lot 53, Q17 — bien retiré, exclusion mémorisée) — le sinistre reste au compte ; l’exclusion ne concerne que lui (sans effet sur le compte cible)',
  deadlines_compat_view: 'vue de compatibilité (deadlines)',
  business_operation_identity_reviews: 'Opérations : journal des contrôles d’identité économique (lot 78A, trace d’exploitation BO) — suit l’Opération, jamais le document ; reste au compte',
};

export interface AssetDataTransferResult {
  assetId: number;
  fromAccountId: number;
  toAccountId: number;
  /** Documents déplacés (sources secondaires comprises). */
  movedFileIds: number[];
  /** Documents multi-biens restés dans l'ancien compte, lien vers le bien retiré. */
  keptFileIds: number[];
  linksRemoved: number;
  evidenceWithdrawn: number;
  movedAgendaItemIds: number[];
  detachedAgendaItemIds: number[];
  toProcessActionsMoved: number;
  transmissionsCancelled: number;
  suppliersReused: number;
  suppliersCopied: number;
  operationSourcesDeactivated: number;
  operationsInvalidated: number[];
  /** Lignes déplacées par table. */
  rowsMoved: Record<string, number>;
  /** Biens à réconcilier par T3 après commit (preuves retirées). */
  t3: Array<{ accountId: number; assetId: number }>;
  events: BusinessOperationEvent[];
}

function vide(p: { assetId: number; fromAccountId: number; toAccountId: number }): AssetDataTransferResult {
  return {
    ...p, movedFileIds: [], keptFileIds: [], linksRemoved: 0, evidenceWithdrawn: 0, movedAgendaItemIds: [], detachedAgendaItemIds: [],
    toProcessActionsMoved: 0, transmissionsCancelled: 0, suppliersReused: 0, suppliersCopied: 0, operationSourcesDeactivated: 0,
    operationsInvalidated: [], rowsMoved: {}, t3: [], events: [],
  };
}

/** Tables existantes (une migration absente ne fait jamais échouer le transfert). */
async function existingTables(tx: DbTx, names: readonly string[]): Promise<Set<string>> {
  const r = await rows<{ name: string }>(tx, sql`
    SELECT n AS name FROM unnest(${`{${names.join(',')}}`}::text[]) AS n WHERE to_regclass(n) IS NOT NULL`);
  return new Set(r.map((x) => x.name));
}

/**
 * Fait suivre au bien `assetId` ses données de `fromAccountId` vers
 * `toAccountId`. À appeler DANS la transaction qui a DÉJÀ posé
 * `assets.account_id = toAccountId` (les déclencheurs de liens 0221 s'y
 * fient). Rend le rapport et les événements Opération (publiés après commit).
 */
export async function transferAssetDataInTx(
  tx: DbTx,
  p: { assetId: number; fromAccountId: number; toAccountId: number; reasonCode?: string; actorUserId?: number | null },
): Promise<AssetDataTransferResult> {
  const out = vide(p);
  const A = p.assetId;
  const from = p.fromAccountId;
  const to = p.toAccountId;
  if (!from || !to || from === to) return out;
  const reason = p.reasonCode ?? 'ASSET_TRANSFERRED';
  const [asset] = await rows<{ account_id: number | null }>(tx, sql`SELECT account_id FROM assets WHERE id = ${A} FOR UPDATE`);
  if (!asset) return out;
  if (num(asset.account_id) !== to) {
    throw new Error(`ASSET_NOT_IN_TARGET_ACCOUNT : le bien ${A} doit déjà appartenir au compte ${to} (compte ${String(asset.account_id)}).`);
  }
  const compte = (table: string, n: number) => { if (n > 0) out.rowsMoved[table] = (out.rowsMoved[table] ?? 0) + n; };
  const maj = async (table: string, q: SQL) => { const r = await rows(tx, q); compte(table, r.length); return r; };

  const idsOf = async (q: SQL) => (await rows<{ id: unknown }>(tx, q)).map((r) => num(r.id));
  const E = await idsOf(sql`SELECT id FROM equipments WHERE asset_id = ${A}`);
  const S = await idsOf(sql`SELECT id FROM substructures WHERE asset_id = ${A}`);
  const R = await idsOf(sql`SELECT id FROM rooms WHERE asset_id = ${A}`);

  // ── 1. Documents qui citent l'arbre du bien, dans l'ancien compte ─────────
  const candidats = await rows<{ id: number; asset_id: number | null; linked_asset_id: number | null; attached: boolean; others: number[] | null }>(tx, sql`
    WITH c AS (
      SELECT af.id FROM asset_files af
       WHERE af.account_id = ${from}
         AND (af.asset_id = ${A} OR af.linked_asset_id = ${A} OR af.equipment_id = ANY(${ints(E)})
           OR af.substructure_id = ANY(${ints(S)}) OR af.linked_room_id = ANY(${ints(R)})
           OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = af.id AND l.status IN ('ACTIVE', 'PROPOSED')
                       AND (l.asset_id = ${A} OR l.equipment_id = ANY(${ints(E)}) OR l.substructure_id = ANY(${ints(S)}) OR l.room_id = ANY(${ints(R)}))))
       FOR UPDATE OF af
    ),
    refs AS (
      SELECT af.id AS file_id, x.asset_id
        FROM asset_files af JOIN c ON c.id = af.id
        LEFT JOIN equipments e ON e.id = af.equipment_id
        LEFT JOIN substructures s ON s.id = af.substructure_id
        LEFT JOIN rooms r ON r.id = af.linked_room_id
        CROSS JOIN LATERAL (VALUES (af.asset_id), (af.linked_asset_id), (e.asset_id), (s.asset_id), (r.asset_id)) AS x(asset_id)
       WHERE x.asset_id IS NOT NULL
      UNION ALL
      SELECT l.file_id, COALESCE(l.asset_id, e.asset_id, s.asset_id, r.asset_id)
        FROM document_asset_links l JOIN c ON c.id = l.file_id
        LEFT JOIN equipments e ON e.id = l.equipment_id
        LEFT JOIN substructures s ON s.id = l.substructure_id
        LEFT JOIN rooms r ON r.id = l.room_id
       WHERE l.status = 'ACTIVE'
    )
    SELECT af.id, af.asset_id, af.linked_asset_id,
           COALESCE(bool_or(refs.asset_id = ${A}), false) AS attached,
           array_agg(DISTINCT refs.asset_id) FILTER (WHERE refs.asset_id <> ${A} AND a.account_id = ${from}) AS others
      FROM asset_files af JOIN c ON c.id = af.id
      LEFT JOIN refs ON refs.file_id = af.id
      LEFT JOIN assets a ON a.id = refs.asset_id
     GROUP BY af.id, af.asset_id, af.linked_asset_id
     ORDER BY af.id`);
  const move = new Set(candidats.filter((c) => c.attached && !(c.others?.length)).map((c) => num(c.id)));
  if (move.size) {
    // Sources secondaires regroupées dans un document qui part : elles le suivent.
    for (const id of await idsOf(sql`SELECT id FROM asset_files WHERE account_id = ${from} AND grouped_into_file_id = ANY(${ints([...move])})`)) move.add(id);
  }
  const stay = candidats.filter((c) => !move.has(num(c.id)));
  const M = [...move].sort((a, b) => a - b);
  const K = stay.map((c) => num(c.id));
  out.movedFileIds = M;
  out.keptFileIds = K;

  // ── 2. Documents qui restent : lien vers l'arbre du bien retiré ──────────
  for (const c of stay) {
    const autres = (c.others ?? []).map(num).sort((a, b) => a - b);
    const lie = c.linked_asset_id === null ? null : num(c.linked_asset_id);
    const primaire = c.asset_id === null ? null : num(c.asset_id);
    const nouveauPrimaire = primaire === A ? (lie !== null && lie !== A ? lie : autres[0] ?? null) : primaire;
    const nouveauLie = lie === A || lie === nouveauPrimaire ? null : lie;
    // Les déclencheurs 0221 réalignent les liens LEGACY_COLUMN sur les colonnes.
    await tx.execute(sql`
      UPDATE asset_files SET asset_id = ${nouveauPrimaire}, linked_asset_id = ${nouveauLie},
             equipment_id = CASE WHEN equipment_id = ANY(${ints(E)}) THEN NULL ELSE equipment_id END,
             substructure_id = CASE WHEN substructure_id = ANY(${ints(S)}) THEN NULL ELSE substructure_id END,
             linked_room_id = CASE WHEN linked_room_id = ANY(${ints(R)}) THEN NULL ELSE linked_room_id END,
             updated_at = now()
       WHERE id = ${num(c.id)}`);
  }
  if (K.length) {
    out.linksRemoved += (await rows(tx, sql`
      UPDATE document_asset_links SET status = 'REMOVED', removed_at = now(), updated_at = now()
       WHERE file_id = ANY(${ints(K)}) AND status IN ('ACTIVE', 'PROPOSED')
         AND (asset_id = ${A} OR equipment_id = ANY(${ints(E)}) OR substructure_id = ANY(${ints(S)}) OR room_id = ANY(${ints(R)}))
      RETURNING id`)).length;
    // Le bien perd ces preuves (document resté dans l'ancien compte) : T3 réconcilie.
    out.evidenceWithdrawn += (await rows(tx, sql`
      UPDATE field_evidence SET lifecycle_status = 'WITHDRAWN', superseded_at = now()
       WHERE asset_id = ${A} AND source_type IN ('document', 'web_link') AND source_id = ANY(${ints(K)})
         AND (lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE')
      RETURNING id`)).length;
    compte('asset_photos (retirées)', (await rows(tx, sql`DELETE FROM asset_photos WHERE asset_id = ${A} AND file_id = ANY(${ints(K)}) RETURNING id`)).length);
  }

  // ── 3. Documents qui partent, et tout ce qui en dérive ────────────────────
  const tables = await existingTables(tx, [...new Set([...FILE_SCOPED_TABLES.map(([t]) => t), ...ASSET_SCOPED_TABLES])]);
  if (M.length) {
    await maj('asset_files', sql`UPDATE asset_files SET account_id = ${to}, updated_at = now() WHERE id = ANY(${ints(M)}) AND account_id = ${from} RETURNING id`);
    await maj('document_asset_links', sql`
      UPDATE document_asset_links SET account_id = ${to}, updated_at = now()
       WHERE file_id = ANY(${ints(M)}) AND account_id = ${from}
         AND (asset_id = ${A} OR equipment_id = ANY(${ints(E)}) OR substructure_id = ANY(${ints(S)}) OR room_id = ANY(${ints(R)}))
      RETURNING id`);
    // Liens restants (inactifs, ou d'une source secondaire) vers des biens de l'ancien compte : jamais inter-comptes.
    out.linksRemoved += (await rows(tx, sql`DELETE FROM document_asset_links WHERE file_id = ANY(${ints(M)}) AND account_id = ${from} RETURNING id`)).length;
    for (const [table, col] of FILE_SCOPED_TABLES) {
      if (!tables.has(table)) continue;
      // Lot 54 (SEC-02) : un « champ complété » d'un AUTRE bien resté dans
      // l'ancien compte ne part pas avec le document (sinon relation
      // intercomptes, refusée en base par la garde 0373).
      const memeBien = table === 'ai_field_updates' ? sql` AND asset_id = ${A}` : sql``;
      await maj(table, sql`UPDATE ${sql.identifier(table)} SET account_id = ${to} WHERE ${sql.identifier(col)} = ANY(${ints(M)}) AND account_id = ${from}${memeBien} RETURNING 1`);
    }
    // Cible d'un fait vers une entité restée dans l'ancien compte : neutralisée (U8 : cible inconnue, jamais une fuite).
    await maj('document_facts (cibles neutralisées)', sql`
      UPDATE document_facts SET target_entity_id = NULL
       WHERE file_id = ANY(${ints(M)}) AND target_entity_id IS NOT NULL
         AND ((target_type = 'ASSET' AND target_entity_id <> ${A})
           OR (target_type = 'EQUIPMENT' AND NOT (target_entity_id = ANY(${ints(E)})))
           OR (target_type = 'ROOM' AND NOT (target_entity_id = ANY(${ints([...S, ...R])})))
           OR target_type = 'SUPPLIER')
      RETURNING 1`);
    // Preuves portées par d'AUTRES biens de l'ancien compte depuis un document qui part : retirées.
    const retirees = await rows<{ asset_id: number }>(tx, sql`
      UPDATE field_evidence SET lifecycle_status = 'WITHDRAWN', superseded_at = now()
       WHERE account_id = ${from} AND asset_id <> ${A} AND source_type IN ('document', 'web_link') AND source_id = ANY(${ints(M)})
         AND (lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE')
      RETURNING asset_id`);
    out.evidenceWithdrawn += retirees.length;
    for (const id of new Set(retirees.map((r) => num(r.asset_id)))) out.t3.push({ accountId: from, assetId: id });
    await maj('ai_job_queue', sql`
      UPDATE ai_job_queue SET account_id = ${to}
       WHERE account_id = ${from} AND status = 'PENDING' AND target_type = 'asset_file' AND target_id = ANY(${texts(M)})
      RETURNING 1`);
  }

  // ── 4. Données du bien ─────────────────────────────────────────────────────
  // Lot 54 (SEC-02) : preuves du bien tirées d'un document qui RESTE dans
  // l'ancien compte (hors arbre du bien : rattaché ailleurs depuis) —
  // retirées comme celles des documents conservés (étape 2) : elles ne
  // suivent jamais le bien vers l'autre compte.
  out.evidenceWithdrawn += (await rows(tx, sql`
    UPDATE field_evidence fe SET lifecycle_status = 'WITHDRAWN', superseded_at = now()
     WHERE fe.asset_id = ${A} AND fe.account_id = ${from}
       AND fe.source_type IN ('document', 'asset_file', 'file', 'web_link')
       AND (fe.lifecycle_status IS NULL OR fe.lifecycle_status = 'ACTIVE')
       AND NOT (fe.source_id = ANY(${ints(M)}))
       AND EXISTS (SELECT 1 FROM asset_files f WHERE f.id = fe.source_id AND f.account_id = ${from})
    RETURNING fe.id`)).length;
  for (const table of ASSET_SCOPED_TABLES) {
    if (!tables.has(table)) continue;
    await maj(table, sql`UPDATE ${sql.identifier(table)} SET account_id = ${to} WHERE asset_id = ${A} AND account_id = ${from} RETURNING 1`);
  }
  if (M.length) {
    await maj('impact_queue', sql`UPDATE impact_queue SET account_id = ${to} WHERE account_id = ${from} AND document_id = ANY(${ints(M)}) RETURNING 1`);
    await maj('agenda_item_removals', sql`UPDATE agenda_item_removals SET account_id = ${to} WHERE account_id = ${from} AND source_file_id = ANY(${ints(M)}) RETURNING 1`);
  }
  await maj('ai_job_queue', sql`
    UPDATE ai_job_queue SET account_id = ${to}
     WHERE account_id = ${from} AND status = 'PENDING'
       AND ((target_type = 'asset' AND target_id = ${String(A)}) OR (target_type = 'equipment' AND target_id = ANY(${texts(E)}))
         OR (target_type = 'room' AND target_id = ANY(${texts([...S, ...R])})))
    RETURNING 1`);
  // Événements et échéances historiques : ceux du bien suivent ; un lien secondaire vers lui est retiré.
  for (const table of ['events', 'deadlines'] as const) {
    await maj(table, sql`
      UPDATE ${sql.identifier(table)} SET account_id = ${to},
             linked_asset_id = CASE WHEN linked_asset_id = ${A} THEN linked_asset_id ELSE NULL END
       WHERE asset_id = ${A} AND account_id = ${from} RETURNING 1`);
    await maj(`${table} (lien secondaire retiré)`, sql`
      UPDATE ${sql.identifier(table)} SET linked_asset_id = NULL,
             equipment_id = CASE WHEN equipment_id = ANY(${ints(E)}) THEN NULL ELSE equipment_id END,
             substructure_id = CASE WHEN substructure_id = ANY(${ints(S)}) THEN NULL ELSE substructure_id END,
             linked_room_id = CASE WHEN linked_room_id = ANY(${ints(R)}) THEN NULL ELSE linked_room_id END
       WHERE account_id = ${from} AND (linked_asset_id = ${A} OR equipment_id = ANY(${ints(E)}) OR substructure_id = ANY(${ints(S)}) OR linked_room_id = ANY(${ints(R)}))
      RETURNING 1`);
  }
  // Transmissions : l'historique suit le bien ; un lien EN ATTENTE ne vaut plus.
  out.transmissionsCancelled = (await rows(tx, sql`
    UPDATE asset_transmissions SET status = 'cancelled', cancelled_at = now()
     WHERE asset_id = ${A} AND account_id = ${from} AND status = 'pending' RETURNING id`)).length;
  await maj('asset_transmissions', sql`UPDATE asset_transmissions SET account_id = ${to} WHERE asset_id = ${A} AND account_id = ${from} RETURNING 1`);

  // ── 5. Agenda ──────────────────────────────────────────────────────────────
  const agenda = await rows<{ id: number; has_tree: boolean; others: number[] | null; files_only_moving: boolean }>(tx, sql`
    WITH c AS (
      SELECT ai.id FROM agenda_items ai
       WHERE ai.account_id = ${from}
         AND (EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = ai.id AND l.asset_id = ${A})
           OR EXISTS (SELECT 1 FROM agenda_equipment_links l WHERE l.agenda_item_id = ai.id AND l.equipment_id = ANY(${ints(E)}))
           OR EXISTS (SELECT 1 FROM agenda_room_links l WHERE l.agenda_item_id = ai.id AND l.substructure_id = ANY(${ints(S)}))
           OR EXISTS (SELECT 1 FROM agenda_file_links l WHERE l.agenda_item_id = ai.id AND l.asset_file_id = ANY(${ints(M)})))
       FOR UPDATE OF ai
    ),
    refs AS (
      SELECT l.agenda_item_id AS id, l.asset_id FROM agenda_asset_links l JOIN c ON c.id = l.agenda_item_id
      UNION ALL SELECT l.agenda_item_id, e.asset_id FROM agenda_equipment_links l JOIN c ON c.id = l.agenda_item_id JOIN equipments e ON e.id = l.equipment_id
      UNION ALL SELECT l.agenda_item_id, s.asset_id FROM agenda_room_links l JOIN c ON c.id = l.agenda_item_id JOIN substructures s ON s.id = l.substructure_id
    )
    SELECT c.id,
           COALESCE(bool_or(refs.asset_id = ${A}), false) AS has_tree,
           array_agg(DISTINCT refs.asset_id) FILTER (WHERE refs.asset_id <> ${A} AND a.account_id = ${from}) AS others,
           NOT EXISTS (SELECT 1 FROM agenda_file_links fl WHERE fl.agenda_item_id = c.id AND NOT (fl.asset_file_id = ANY(${ints(M)})))
             AND NOT bool_or(refs.asset_id IS NOT NULL) IS TRUE AS files_only_moving
      FROM c LEFT JOIN refs ON refs.id = c.id LEFT JOIN assets a ON a.id = refs.asset_id
     GROUP BY c.id ORDER BY c.id`);
  const agMove = agenda.filter((x) => !(x.others?.length) && (x.has_tree || x.files_only_moving)).map((x) => num(x.id));
  const agStay = agenda.filter((x) => !agMove.includes(num(x.id))).map((x) => num(x.id));
  out.movedAgendaItemIds = agMove;
  out.detachedAgendaItemIds = agStay;
  if (agMove.length) {
    await maj('agenda_items', sql`UPDATE agenda_items SET account_id = ${to}, updated_at = now() WHERE id = ANY(${ints(agMove)}) AND account_id = ${from} RETURNING 1`);
    // Lot 54 (SEC-02) : document d'origine resté dans l'ancien compte — la
    // référence d'origine est retirée (jamais une relation intercomptes).
    await maj('agenda_items (origine retirée)', sql`
      UPDATE agenda_items i SET origin_ref_id = NULL
       WHERE i.id = ANY(${ints(agMove)}) AND i.origin_ref_type = 'asset_file' AND i.origin_ref_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM asset_files f WHERE f.id = i.origin_ref_id AND f.account_id <> ${to})
      RETURNING 1`);
    await maj('agenda_occurrence_events', sql`UPDATE agenda_occurrence_events SET account_id = ${to} WHERE agenda_item_id = ANY(${ints(agMove)}) AND account_id = ${from} RETURNING 1`);
    await maj('agenda_data_conflicts', sql`
      UPDATE agenda_data_conflicts SET account_id = ${to}
       WHERE account_id = ${from} AND (agenda_item_id = ANY(${ints(agMove)}) OR result_agenda_item_id = ANY(${ints(agMove)})) RETURNING 1`);
    await maj('agenda_item_removals', sql`UPDATE agenda_item_removals SET account_id = ${to} WHERE account_id = ${from} AND agenda_item_id = ANY(${ints(agMove)}) RETURNING 1`);
  }
  if (agStay.length) {
    await maj('agenda_asset_links (retirés)', sql`DELETE FROM agenda_asset_links WHERE agenda_item_id = ANY(${ints(agStay)}) AND asset_id = ${A} RETURNING 1`);
    await maj('agenda_equipment_links (retirés)', sql`DELETE FROM agenda_equipment_links WHERE agenda_item_id = ANY(${ints(agStay)}) AND equipment_id = ANY(${ints(E)}) RETURNING 1`);
    await maj('agenda_room_links (retirés)', sql`DELETE FROM agenda_room_links WHERE agenda_item_id = ANY(${ints(agStay)}) AND substructure_id = ANY(${ints(S)}) RETURNING 1`);
  }
  // Aucun lien agenda → document entre deux comptes.
  for (const t of ['agenda_file_links', 'agenda_item_sources'] as const) {
    await maj(`${t} (inter-comptes retirés)`, sql`
      DELETE FROM ${sql.identifier(t)} x USING agenda_items ai, asset_files f
       WHERE x.agenda_item_id = ai.id AND f.id = x.asset_file_id AND ai.account_id IN (${from}, ${to}) AND f.account_id <> ai.account_id
         AND (ai.id = ANY(${ints([...agMove, ...agStay])}) OR f.id = ANY(${ints([...M, ...K])}))
      RETURNING 1`);
  }

  // ── 6. « À traiter » ───────────────────────────────────────────────────────
  const actions = await rows<{ id: number; public_id: string }>(tx, sql`
    UPDATE to_process_actions SET account_id = ${to}, updated_at = now()
     WHERE account_id = ${from}
       AND ((target_type = 'ASSET' AND target_id = ${A}) OR (target_type = 'DOCUMENT' AND target_id = ANY(${ints(M)}))
         OR (target_type = 'EQUIPMENT' AND target_id = ANY(${ints(E)})) OR (target_type = 'ROOM' AND target_id = ANY(${ints([...S, ...R])}))
         OR (target_type = 'AGENDA_ITEM' AND target_id = ANY(${ints(agMove)})))
    RETURNING id, public_id::text AS public_id`);
  out.toProcessActionsMoved = actions.length;
  compte('to_process_actions', actions.length);
  if (actions.length) {
    await maj('to_process_action_events', sql`UPDATE to_process_action_events SET account_id = ${to} WHERE action_id = ANY(${bigints(actions.map((a) => num(a.id)))}) RETURNING 1`);
    await maj('to_process_item_state', sql`
      UPDATE to_process_item_state SET account_id = ${to}
       WHERE account_id = ${from} AND item_key = ANY(${`{${actions.map((a) => a.public_id).join(',')}}`}::text[]) RETURNING 1`);
  }

  // ── 7. Versions suivies (cohérence) ───────────────────────────────────────
  const objets: Array<[string, number[]]> = [['asset', [A]], ['document', M], ['equipment', E], ['agenda_item', agMove]];
  for (const [type, l] of objets) {
    if (!l.length) continue;
    await tx.execute(sql`DELETE FROM object_versions WHERE account_id = ${to} AND object_type = ${type} AND object_id = ANY(${bigints(l)})`);
    await maj('object_versions', sql`UPDATE object_versions SET account_id = ${to} WHERE account_id = ${from} AND object_type = ${type} AND object_id = ANY(${bigints(l)}) RETURNING 1`);
  }

  // ── 8. Fournisseurs (fiches par compte) ───────────────────────────────────
  await transferSuppliers(tx, { A, E, M, from, to }, out);

  // ── 9. Opérations : aucune source ni lien Agenda entre deux comptes ───────
  await tx.execute(sql`
    UPDATE agenda_items ai SET business_operation_id = NULL, updated_at = now()
     WHERE ai.account_id IN (${from}, ${to}) AND ai.business_operation_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM business_operations o WHERE o.id = ai.business_operation_id AND o.account_id <> ai.account_id)`);
  await detachCrossAccountOperationSources(tx, { from, to, reason, actorUserId: p.actorUserId ?? null }, out);

  // Le bien perd des preuves (documents restés) : réconciliation T3 dans son nouveau compte.
  if (out.evidenceWithdrawn > 0 || K.length > 0) out.t3.push({ accountId: to, assetId: A });
  return out;
}

async function transferSuppliers(
  tx: DbTx, p: { A: number; E: number[]; M: number[]; from: number; to: number }, out: AssetDataTransferResult,
): Promise<void> {
  const correspondance = new Map<number, number | null>();
  const fournisseur = async (ancien: number): Promise<number | null> => {
    if (correspondance.has(ancien)) return correspondance.get(ancien)!;
    const [s] = await rows<Row>(tx, sql`SELECT * FROM suppliers WHERE id = ${ancien}`);
    let id: number | null = null;
    if (s && num(s.account_id) === p.to) id = ancien;
    else if (s && num(s.account_id) === p.from) {
      const [m] = await rows<{ id: number }>(tx, sql`
        SELECT id FROM suppliers WHERE account_id = ${p.to} AND normalized_name = ${s.normalized_name as string}
           AND siret IS NOT DISTINCT FROM ${(s.siret as string | null) ?? null} AND status <> 'deleted'
         ORDER BY id LIMIT 1`);
      if (m) { id = num(m.id); out.suppliersReused++; }
      else {
        const [c] = await rows<{ id: number }>(tx, sql`
          INSERT INTO suppliers (account_id, created_by_user_id, scope, name, normalized_name, email, phone, website,
                                 address_line_1, address_line_2, postal_code, city, country, siren, siret, vat_number,
                                 source, contact_status, status)
          SELECT ${p.to}, created_by_user_id, 'personal', name, normalized_name, email, phone, website,
                 address_line_1, address_line_2, postal_code, city, country, siren, siret, vat_number,
                 source, contact_status, status
            FROM suppliers WHERE id = ${ancien}
          RETURNING id`);
        id = num(c.id);
        out.suppliersCopied++;
      }
    }
    correspondance.set(ancien, id);
    return id;
  };
  const relier = async (table: 'asset_suppliers' | 'equipment_suppliers' | 'document_suppliers', col: string, cibles: number[]) => {
    if (!cibles.length) return;
    const liens = await rows<Row>(tx, sql`
      SELECT x.* FROM ${sql.identifier(table)} x JOIN suppliers s ON s.id = x.supplier_id
       WHERE x.${sql.identifier(col)} = ANY(${ints(cibles)}) AND s.account_id <> ${p.to}`);
    for (const l of liens) {
      const nouveau = await fournisseur(num(l.supplier_id));
      await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE ${sql.identifier(col)} = ${num(l[col])} AND supplier_id = ${num(l.supplier_id)}`);
      if (nouveau === null) continue;
      if (table === 'asset_suppliers') {
        await tx.execute(sql`INSERT INTO asset_suppliers (asset_id, supplier_id, source_type) VALUES (${num(l.asset_id)}, ${nouveau}, ${l.source_type as string}) ON CONFLICT DO NOTHING`);
      } else if (table === 'equipment_suppliers') {
        await tx.execute(sql`
          INSERT INTO equipment_suppliers (equipment_id, supplier_id, relationship_type, source_document_id, source_type, is_primary)
          VALUES (${num(l.equipment_id)}, ${nouveau}, ${(l.relationship_type as string | null) ?? null},
                  (SELECT id FROM asset_files WHERE id = ${l.source_document_id === null ? null : num(l.source_document_id)} AND account_id = ${p.to}),
                  ${l.source_type as string}, ${Boolean(l.is_primary)})
          ON CONFLICT DO NOTHING`);
      } else {
        await tx.execute(sql`
          INSERT INTO document_suppliers (document_id, supplier_id, role, confidence_score, is_confirmed)
          VALUES (${num(l.document_id)}, ${nouveau}, ${l.role as string}, ${l.confidence_score as number | null}, ${Boolean(l.is_confirmed)})
          ON CONFLICT DO NOTHING`);
      }
      out.rowsMoved[table] = (out.rowsMoved[table] ?? 0) + 1;
    }
  };
  await relier('asset_suppliers', 'asset_id', [p.A]);
  await relier('equipment_suppliers', 'equipment_id', p.E);
  await relier('document_suppliers', 'document_id', p.M);
  // Source d'un lien équipement ↔ fournisseur restée dans l'ancien compte : retirée.
  if (p.E.length) {
    await tx.execute(sql`
      UPDATE equipment_suppliers es SET source_document_id = NULL FROM asset_files f
       WHERE es.equipment_id = ANY(${ints(p.E)}) AND f.id = es.source_document_id AND f.account_id <> ${p.to}`);
  }
  if (!p.M.length) return;
  for (const o of await rows<{ id: number; supplier_id: number }>(tx, sql`
    SELECT o.id, o.supplier_id FROM supplier_contact_observations o JOIN suppliers s ON s.id = o.supplier_id
     WHERE o.document_id = ANY(${ints(p.M)}) AND s.account_id <> ${p.to}`)) {
    const nouveau = await fournisseur(num(o.supplier_id));
    if (nouveau === null) await tx.execute(sql`DELETE FROM supplier_contact_observations WHERE id = ${num(o.id)}`);
    else await tx.execute(sql`UPDATE supplier_contact_observations SET supplier_id = ${nouveau} WHERE id = ${num(o.id)}`);
  }
  for (const r of await rows<{ id: number; supplier_id: number | null; candidate_supplier_ids: unknown }>(tx, sql`
    SELECT id, supplier_id, candidate_supplier_ids FROM supplier_review_items WHERE document_id = ANY(${ints(p.M)}) AND account_id = ${p.from}`)) {
    const sid = r.supplier_id === null ? null : await fournisseur(num(r.supplier_id));
    const cands: number[] = [];
    for (const c of Array.isArray(r.candidate_supplier_ids) ? r.candidate_supplier_ids : []) {
      const n = await fournisseur(num(c));
      if (n !== null) cands.push(n);
    }
    await tx.execute(sql`
      UPDATE supplier_review_items SET account_id = ${p.to}, supplier_id = ${sid}, candidate_supplier_ids = ${JSON.stringify(cands)}::jsonb, updated_at = now()
       WHERE id = ${num(r.id)}`);
    out.rowsMoved.supplier_review_items = (out.rowsMoved.supplier_review_items ?? 0) + 1;
  }
}

/**
 * Sources d'Opération dont l'objet est désormais dans un autre compte que
 * l'Opération (document, élément d'agenda, bien, équipement) : désactivées,
 * Opération invalidée si plus rien ne la prouve (C8, C25, INV-FINAL-006).
 */
async function detachCrossAccountOperationSources(
  tx: DbTx, p: { from: number; to: number; reason: string; actorUserId: number | null }, out: AssetDataTransferResult,
): Promise<void> {
  const sources = await rows<{ id: number; operation_id: number; account_id: number }>(tx, sql`
    SELECT s.id, s.operation_id, s.account_id FROM business_operation_sources s
     WHERE s.active AND s.account_id IN (${p.from}, ${p.to})
       AND ((s.source_kind = 'DOCUMENT' AND EXISTS (SELECT 1 FROM asset_files f WHERE f.id::text = s.source_entity_key AND f.account_id <> s.account_id))
         OR (s.source_kind = 'AGENDA' AND EXISTS (SELECT 1 FROM agenda_items ai WHERE ai.id::text = s.source_entity_key AND ai.account_id <> s.account_id))
         OR (s.source_kind IN ('ASSET_DATA', 'CLAIM_FORM') AND EXISTS (SELECT 1 FROM assets a WHERE a.id::text = s.source_entity_key AND a.account_id <> s.account_id))
         OR (s.source_kind = 'EQUIPMENT_DATA' AND EXISTS (SELECT 1 FROM equipments e JOIN assets a ON a.id = e.asset_id
                                                          WHERE e.id::text = s.source_entity_key AND a.account_id <> s.account_id)))
     ORDER BY s.id`);
  // Références de fichiers des détails Sinistre : jamais vers un autre compte.
  await tx.execute(sql`
    UPDATE business_operation_claim_exchanges x SET document_file_id = NULL FROM business_operations o, asset_files f
     WHERE x.operation_id = o.id AND f.id = x.document_file_id AND o.account_id IN (${p.from}, ${p.to}) AND f.account_id <> o.account_id`);
  await tx.execute(sql`
    UPDATE business_operation_claim_actions x SET invoice_file_id = NULL FROM business_operations o, asset_files f
     WHERE x.operation_id = o.id AND f.id = x.invoice_file_id AND o.account_id IN (${p.from}, ${p.to}) AND f.account_id <> o.account_id`);
  // Lot 44 : ancre « historique » d'un Sinistre resté dans l'autre compte (multi-biens).
  await tx.execute(sql`
    UPDATE business_operation_claim_details x SET history_event_id = NULL FROM business_operations o, events e
     WHERE x.operation_id = o.id AND e.id = x.history_event_id AND o.account_id IN (${p.from}, ${p.to}) AND e.account_id <> o.account_id`);
  await tx.execute(sql`
    DELETE FROM business_operation_claim_damage_documents dd USING business_operation_claim_damages d, business_operations o, asset_files f
     WHERE dd.damage_id = d.id AND d.operation_id = o.id AND f.id = dd.file_id AND o.account_id IN (${p.from}, ${p.to}) AND f.account_id <> o.account_id`);
  if (!sources.length) return;
  const reason = `${p.reason}_SOURCE_OTHER_ACCOUNT`;
  const { result, events } = await withBusinessOperationWriteInTx(tx, [p.from, p.to], async (session) => {
    const invalidees: number[] = [];
    for (const s of sources) await session.repository(num(s.account_id)).deactivateSource(num(s.id), reason);
    for (const [opId, acc] of new Map(sources.map((s) => [num(s.operation_id), num(s.account_id)]))) {
      if (await session.repository(acc).invalidateIfUnsupported(opId, `${reason}_NO_SOURCE`)) invalidees.push(opId);
    }
    return invalidees;
  }, { actorUserId: p.actorUserId });
  out.operationSourcesDeactivated = sources.length;
  out.operationsInvalidated = result;
  out.events.push(...events);
}

/**
 * Après commit : réconciliation T3 des biens qui ont perdu des preuves.
 * Ne lève jamais (le transfert est déjà validé ; la reprise continue rattrape).
 */
export async function afterAssetDataTransfer(results: readonly AssetDataTransferResult[], userId: number | null): Promise<void> {
  const parCompte = new Map<number, Set<number>>();
  for (const r of results) for (const t of r.t3) parCompte.set(t.accountId, (parCompte.get(t.accountId) ?? new Set()).add(t.assetId));
  if (!parCompte.size) return;
  try {
    const { enqueueT3ForAssets } = await import('@/services/ai/reconciliation/t3-queue');
    for (const [accountId, assets] of parCompte) {
      await enqueueT3ForAssets({ accountId, userId: userId ?? 0, assetIds: [...assets], reason: 'asset_transferred' }).catch(() => undefined);
    }
  } catch (e) {
    console.error('[asset-account-transfer] réconciliation T3 non mise en file :', (e as Error).message);
  }
}
