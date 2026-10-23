/**
 * Fusion d'Opérations : part REGROUPEMENT (lot 82D, CDC v5 §8.3, V-Q4).
 *
 * Appelée par la fusion existante (`BusinessOperationRepository.mergeOperations`,
 * lots 42 / 55B / 78A — seule fusion du code) à la place de l'ancien
 * « UPDATE agenda_items SET business_operation_id = canonique » : quel que soit
 * l'appelant (T3 rétroactif 55B, référence commune, formulaire Sinistre, lien
 * utilisateur Agenda ↔ Agenda), la fusion
 *   · rattache à la canonique les éléments d'agenda de l'absorbée SANS
 *     absorber aucun élément (§6.5 : même Opération ≠ doublon ; V-Q4 : le
 *     principal et ses étapes restent distincts) ;
 *   · garde UN principal (`principalAfterMerge`) : l'autre redevient lié ;
 *   · rapatrie l'appartenance USER des documents (l'appartenance SOURCE suit
 *     les sources par déclencheur 0655) et les Pièces ;
 *   · recalcule la propagation vers le principal.
 * Même transaction que la fusion : tout ou rien.
 */
import { principalAfterMerge } from './model';
import { currentPrincipal, recomputePrincipal, stripPrincipalLinks } from './principal';
import { lockGroupingAccount, type GroupingRunner } from './runner';

export async function reassignGroupingOnMerge(r: GroupingRunner, accountId: number, absorbedId: number, canonicalId: number): Promise<void> {
  await lockGroupingAccount(r, accountId);
  const pc = await currentPrincipal(r, accountId, canonicalId);
  const pa = await currentPrincipal(r, accountId, absorbedId);
  const { keep, demote } = principalAfterMerge(pc, pa);
  if (demote.length) {
    await stripPrincipalLinks(r, demote);
    await r.q(`UPDATE agenda_items SET operation_role = 'RELATED', updated_at = now() WHERE id = ANY($1::int[]) AND account_id = $2`,
      [`{${demote.join(',')}}`, accountId]);
  }
  await r.q(
    `UPDATE agenda_items
        SET business_operation_id = $3,
            operation_role = CASE WHEN id = $4::int THEN 'PRINCIPAL' ELSE 'RELATED' END,
            operation_role_origin = CASE WHEN id = $4::int THEN $5::text ELSE operation_role_origin END,
            updated_at = now()
      WHERE business_operation_id = $1 AND account_id = $2`,
    [absorbedId, accountId, canonicalId, keep?.itemId ?? 0, keep?.origin ?? null],
  );
  // Appartenance USER des documents.
  await r.q(
    `INSERT INTO business_operation_documents (account_id, operation_id, file_id, origins)
     SELECT a.account_id, $2, a.file_id, ARRAY['USER']::text[] FROM business_operation_documents a
      WHERE a.operation_id = $1 AND a.account_id = $3 AND 'USER' = ANY(a.origins)
     ON CONFLICT (operation_id, file_id) DO UPDATE
        SET origins = CASE WHEN 'USER' = ANY(business_operation_documents.origins) THEN business_operation_documents.origins
                           ELSE business_operation_documents.origins || ARRAY['USER']::text[] END, updated_at = now()`,
    [absorbedId, canonicalId, accountId],
  );
  await r.q(`UPDATE business_operation_documents SET origins = array_remove(origins, 'USER'), updated_at = now()
              WHERE operation_id = $1 AND account_id = $2 AND 'USER' = ANY(origins)`, [absorbedId, accountId]);
  // Pièces : couple déjà présent → la canonique garde le sien (réactivé), sinon déplacé.
  await r.q(`UPDATE business_operation_room_links c SET active = true, updated_at = now()
               FROM business_operation_room_links a
              WHERE a.operation_id = $1 AND a.active AND c.operation_id = $2 AND c.substructure_id = a.substructure_id AND NOT c.active`,
  [absorbedId, canonicalId]);
  await r.q(`UPDATE business_operation_room_links a SET active = false, updated_at = now()
              WHERE a.operation_id = $1 AND EXISTS (SELECT 1 FROM business_operation_room_links c WHERE c.operation_id = $2 AND c.substructure_id = a.substructure_id)`,
  [absorbedId, canonicalId]);
  await r.q(`UPDATE business_operation_room_links a SET operation_id = $2, updated_at = now()
              WHERE a.operation_id = $1 AND a.account_id = $3
                AND NOT EXISTS (SELECT 1 FROM business_operation_room_links c WHERE c.operation_id = $2 AND c.substructure_id = a.substructure_id)`,
  [absorbedId, canonicalId, accountId]);
  await recomputePrincipal(r, accountId, canonicalId);
}
