/**
 * Lot 88B — fragments SQL PURS partagés (énumération du contrôle de
 * cohérence) : aucun accès base ici, importable par le registre.
 */
import { MISSING_PROPERTIES_PROJECTION_RULE, type SubjectType } from './contract';

/** L'objet a-t-il au moins une source à examiner ? (énumération du contrôle : SQL partagé.) */
export function subjectSourcesSql(type: SubjectType, alias: string): string {
  if (type === 'ASSET') {
    return `(EXISTS (SELECT 1 FROM asset_files f WHERE f.account_id = ${alias}.account_id AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
                     AND (f.asset_id = ${alias}.id OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.asset_id = ${alias}.id AND l.status = 'ACTIVE')))
         OR EXISTS (SELECT 1 FROM business_operation_asset_links l JOIN business_operations o ON o.id = l.operation_id AND o.invalidated_at IS NULL
                     WHERE l.asset_id = ${alias}.id AND l.active AND o.account_id = ${alias}.account_id)
         OR EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.asset_id = ${alias}.id)
         OR EXISTS (SELECT 1 FROM field_evidence fe WHERE fe.account_id = ${alias}.account_id AND fe.asset_id = ${alias}.id
                     AND (fe.lifecycle_status IS NULL OR fe.lifecycle_status = 'ACTIVE') AND fe.projection_rule IS DISTINCT FROM '${MISSING_PROPERTIES_PROJECTION_RULE}'))`;
  }
  return `(EXISTS (SELECT 1 FROM document_asset_links l JOIN asset_files f ON f.id = l.file_id AND f.deleted_at IS NULL
                    WHERE l.equipment_id = ${alias}.id AND l.status = 'ACTIVE')
        OR EXISTS (SELECT 1 FROM business_operation_equipment_links l JOIN business_operations o ON o.id = l.operation_id AND o.invalidated_at IS NULL
                    WHERE l.equipment_id = ${alias}.id AND l.active)
        OR EXISTS (SELECT 1 FROM agenda_equipment_links l WHERE l.equipment_id = ${alias}.id)
        OR EXISTS (SELECT 1 FROM field_evidence fe WHERE fe.target_type = 'EQUIPMENT' AND fe.target_entity_id = ${alias}.id
                    AND (fe.lifecycle_status IS NULL OR fe.lifecycle_status = 'ACTIVE') AND fe.projection_rule IS DISTINCT FROM '${MISSING_PROPERTIES_PROJECTION_RULE}'))`;
}
