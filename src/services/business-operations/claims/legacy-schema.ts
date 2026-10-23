/**
 * Lot 84A — CDC « Opérations v5 », lot O-10 : objets de l'ANCIEN modèle
 * Sinistres encore présents en base (inertes depuis le lot 83D), supprimés
 * par la FINALISATION du rattrapage BO « Sinistres : nettoyage de l'ancien
 * modèle » (`legacy-finalize.ts`) — jamais par une migration (une migration
 * s'applique dès le déploiement, avant le nettoyage du PO).
 *
 * Le code applicatif fonctionne AVANT et APRÈS la finalisation : il ne lit
 * plus ces objets (schéma Drizzle sans eux), sauf le rattrapage lui-même et
 * la garde d'intégrité du transfert d'un bien (clé étrangère composée de
 * `parent_operation_id`), qui les lisent SEULEMENT s'ils sont présents
 * (`readLegacyClaimSchema`, sonde sans cache : un autre conteneur a pu
 * finaliser entre-temps).
 *
 * Module sans import serveur (constantes partagées par la signature de
 * schéma des points de restauration et le catalogue de l'export de recette).
 */
import type postgres from 'postgres';

/** Tables de l'ancien modèle supprimées par la finalisation. */
export const LEGACY_CLAIM_TABLES = [
  'business_operation_claim_actions',
  'business_operation_claim_exchanges',
  'business_operation_claim_migration_marks',
] as const;
export type LegacyClaimTable = (typeof LEGACY_CLAIM_TABLES)[number];

/** Colonnes de l'ancien modèle supprimées par la finalisation (avec leurs contraintes et index). */
export const LEGACY_CLAIM_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  business_operations: ['parent_operation_id'],
  asset_additional_infos: ['claim_json'],
};

/** Contraintes et index qui disparaissent avec `parent_operation_id`. */
export const LEGACY_PARENT_OBJECTS = {
  foreignKey: 'business_operations_parent_fk',
  check: 'business_operations_parent_not_self_chk',
  index: 'business_operations_parent_idx',
} as const;

/**
 * Contrainte « sous-rubriques = objets JSON » des informations
 * complémentaires : elle portait aussi sur `claim_json` (0213 / 0214) et
 * disparaît avec la colonne (PostgreSQL retire une contrainte qui porte sur
 * une colonne supprimée) — reposée À L'IDENTIQUE sans `claim_json`.
 */
export const ADDITIONAL_INFOS_JSON_CHECK = {
  name: 'asset_additional_infos_json_objects_check',
  definition: "jsonb_typeof(commercial_json) = 'object' AND jsonb_typeof(rental_json) = 'object' "
    + "AND jsonb_typeof(insurance_json) = 'object' AND jsonb_typeof(finance_json) = 'object'",
} as const;

export interface LegacyClaimSchema {
  tables: Record<LegacyClaimTable, boolean>;
  /** `business_operations.parent_operation_id` présente. */
  parentColumn: boolean;
  /** `asset_additional_infos.claim_json` présente. */
  claimJsonColumn: boolean;
}

/** Au moins un objet de l'ancien modèle subsiste (finalisation pas encore faite, ou partielle). */
export function legacyClaimModelPresent(s: LegacyClaimSchema): boolean {
  return s.parentColumn || s.claimJsonColumn || LEGACY_CLAIM_TABLES.some((t) => s.tables[t]);
}

/** Tous les objets de l'ancien modèle sont présents (état d'avant la finalisation). */
export function legacyClaimModelComplete(s: LegacyClaimSchema): boolean {
  return s.parentColumn && s.claimJsonColumn && LEGACY_CLAIM_TABLES.every((t) => s.tables[t]);
}

/** Sonde (texte SQL, une ligne `present`) de la colonne `parent_operation_id` — garde du transfert d'un bien. */
export const LEGACY_PARENT_COLUMN_PROBE_SQL = `
  SELECT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = to_regclass(quote_ident(current_schema()) || '.business_operations')
                    AND attname = 'parent_operation_id' AND attnum > 0 AND NOT attisdropped) AS present`;

/** État de l'ancien modèle dans le schéma courant (lecture du catalogue, sans cache). */
export async function readLegacyClaimSchema(q: postgres.Sql | postgres.TransactionSql): Promise<LegacyClaimSchema> {
  const colonne = (table: string, col: string) => `EXISTS (SELECT 1 FROM pg_attribute
      WHERE attrelid = to_regclass(quote_ident(current_schema()) || '.${table}') AND attname = '${col}' AND attnum > 0 AND NOT attisdropped)`;
  const [r] = await q.unsafe<Array<Record<string, boolean>>>(`
    SELECT ${LEGACY_CLAIM_TABLES.map((t) => `to_regclass(quote_ident(current_schema()) || '.${t}') IS NOT NULL AS "${t}"`).join(', ')},
           ${colonne('business_operations', 'parent_operation_id')} AS parent_column,
           ${colonne('asset_additional_infos', 'claim_json')} AS claim_json_column`);
  return {
    tables: Object.fromEntries(LEGACY_CLAIM_TABLES.map((t) => [t, r[t] === true])) as Record<LegacyClaimTable, boolean>,
    parentColumn: r.parent_column === true,
    claimJsonColumn: r.claim_json_column === true,
  };
}

/** Date de la finalisation réussie la plus récente (journal 0672 / 0680), ou null. */
export async function lastLegacyFinalization(q: postgres.Sql | postgres.TransactionSql): Promise<{ runId: string; at: string } | null> {
  const [r] = await q.unsafe<Array<{ id: string; at: Date | string }>>(`
    SELECT id::text AS id, finished_at AS at FROM claim_legacy_cleanup_runs
     WHERE mode = 'FINALIZE' AND status = 'succeeded' AND finished_at IS NOT NULL
       AND jsonb_array_length(COALESCE(counters->'dropped', '[]'::jsonb)) > 0
     ORDER BY finished_at DESC LIMIT 1`);
  return r ? { runId: r.id, at: new Date(r.at).toISOString() } : null;
}
