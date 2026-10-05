/**
 * Lecture de la cible des lignes `ai_field_updates` (migration 0236, lot 22)
 * — accueil « Ce que j'ai fait », historique des enrichissements.
 *
 * Une ligne SANS cible est un champ du bien `asset_id` ; une ligne AVEC cible
 * (`EQUIPMENT` → `equipments.id`, `ROOM` → `substructures.id`) est un champ
 * de l'équipement ou de la pièce, `asset_id` étant le bien porteur.
 *
 * Colonnes non déclarées dans Drizzle (en-tête de la 0236) : les fragments
 * ci-dessous ne les nomment que si `aiFieldUpdatesTargetReady()` a confirmé
 * leur présence ; sinon ils valent NULL (aucune ligne d'entité n'existe).
 * Module serveur (drizzle-orm seul, aucune connexion).
 */
import { sql, type SQL } from 'drizzle-orm';
import { getField } from '@/services/canonical/registry';

export type FieldUpdateTargetType = 'EQUIPMENT' | 'ROOM';

/** Colonnes de cible et libellé de l'entité (nom de l'équipement / de la pièce). */
export function fieldUpdateTargetColumns(ready: boolean): {
  targetType: SQL<FieldUpdateTargetType | null>;
  targetId: SQL<number | null>;
  entityName: SQL<string | null>;
} {
  if (!ready) {
    return {
      targetType: sql<FieldUpdateTargetType | null>`NULL::text`,
      targetId: sql<number | null>`NULL::int`,
      entityName: sql<string | null>`NULL::text`,
    };
  }
  return {
    targetType: sql<FieldUpdateTargetType | null>`ai_field_updates.target_type`,
    targetId: sql<number | null>`ai_field_updates.target_id`,
    // Équipement ou sous-structure d'un bien NON SUPPRIMÉ du MÊME COMPTE
    // (cloisonnement par compte, pas par bien d'origine : un équipement
    // déplacé vers un autre bien du compte garde ses lignes et son nom).
    entityName: sql<string | null>`CASE ai_field_updates.target_type
      WHEN 'EQUIPMENT' THEN (SELECT e.name FROM equipments e
                               JOIN assets pa ON pa.id = e.asset_id AND pa.deleted_at IS NULL
                              WHERE e.id = ai_field_updates.target_id AND pa.account_id = ai_field_updates.account_id)
      WHEN 'ROOM' THEN (SELECT s.name FROM substructures s
                          JOIN assets pa ON pa.id = s.asset_id AND pa.deleted_at IS NULL
                         WHERE s.id = ai_field_updates.target_id AND pa.account_id = ai_field_updates.account_id)
    END`,
  };
}

/**
 * Lignes visibles : champ du bien parmi `visibleAssetKeys`, ou champ
 * d'entité (la primitive d'entité n'écrit que des clés du registre admises
 * pour ce type d'entité — `targetTypes`).
 */
export function visibleFieldUpdatesWhere(ready: boolean, visibleAssetKeys: readonly string[]): SQL {
  const liste = sql.join(visibleAssetKeys.map((k) => sql`${k}`), sql`, `);
  if (!ready) return sql`ai_field_updates.field_key IN (${liste})`;
  return sql`((ai_field_updates.target_type IS NULL AND ai_field_updates.field_key IN (${liste}))
           OR ai_field_updates.target_type IS NOT NULL)`;
}

/** Condition « ligne du BIEN » (lecteurs qui interprètent la ligne comme un champ du bien). */
export function assetOnlyFieldUpdatesWhere(ready: boolean): SQL {
  return ready ? sql`ai_field_updates.target_type IS NULL` : sql`TRUE`;
}

/** Libellé du registre d'un champ (« Fin de garantie »), à défaut la clé. */
export function registryFieldLabel(key: string): string {
  return getField(key)?.label ?? key;
}

/** Libellé d'un champ d'entité suivi du nom de l'entité : « Numéro de série (Chaudière) ». */
export function entityScopedLabel(fieldLabel: string, entityName: string | null | undefined): string {
  const nom = entityName?.trim();
  return nom ? `${fieldLabel} (${nom})` : fieldLabel;
}
