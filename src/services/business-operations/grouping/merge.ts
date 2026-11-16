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
 *     porteur du fait et ses étapes restent distincts) ;
 *   · garde UN porteur par fait (`principalAfterMerge`, autorité puis
 *     ancienneté) : l'autre reste un membre de plein droit — lot 114O (#744) :
 *     le fait est porté par le LIEN N↔N, aucun rôle n'est écrit ;
 *   · rapatrie l'appartenance USER des documents (l'appartenance SOURCE suit
 *     les sources par déclencheur 0655) et les Pièces ;
 *   · recalcule la propagation vers l'élément porteur.
 * Même transaction que la fusion : tout ou rien.
 */
import { principalAfterMerge } from './model';
import { currentFactCarrier, recomputePrincipal, stripPropagatedDocumentLinks } from './principal';
import { lockGroupingAccount, type GroupingRunner } from './runner';
import { clearAgendaLinkFacts, readAgendaFactCarriers, stampAgendaLinkFact } from '../graph/store';
import { reassignOperationSuppliersOnMerge } from '@/services/relations/operation-suppliers';

export async function reassignGroupingOnMerge(r: GroupingRunner, accountId: number, absorbedId: number, canonicalId: number): Promise<void> {
  await lockGroupingAccount(r, accountId);
  // Faits portés des deux côtés, AVANT le déplacement (le déclencheur 1716 retire le lien de l'absorbée).
  const pc = await currentFactCarrier(r, accountId, canonicalId);
  const pa = await currentFactCarrier(r, accountId, absorbedId);
  const faitsAbsorbee = await readAgendaFactCarriers(r, accountId, absorbedId);
  const { keep, demote } = principalAfterMerge(pc, pa);
  if (demote.length) {
    await stripPropagatedDocumentLinks(r, demote);
    await clearAgendaLinkFacts(r, accountId, canonicalId, demote, 'OPERATION_MERGED');
    await clearAgendaLinkFacts(r, accountId, absorbedId, demote, 'OPERATION_MERGED');
  }
  await r.q(
    `UPDATE agenda_items SET business_operation_id = $3, updated_at = now()
      WHERE business_operation_id = $1 AND account_id = $2`,
    [absorbedId, accountId, canonicalId],
  );
  // Le fait porté suit son élément sur la canonique (sauf celui que la fusion vient de retirer).
  for (const f of faitsAbsorbee) {
    if (demote.includes(f.itemId)) continue;
    if (keep !== null && keep.itemId !== f.itemId && pc !== null && pc.factKey === f.factKey) continue;
    await stampAgendaLinkFact(r, accountId, {
      operationId: canonicalId, itemId: f.itemId, factKey: f.factKey, origin: f.origin, reasonCode: 'OPERATION_MERGED',
    });
  }
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
  // Lot 109A : fournisseurs de l'Opération — décisions de l'utilisateur rapatriées, liens T3 de l'absorbée
  // retirés (recalculés sur la canonique par la reconsolidation qui suit) : aucun héritage fantôme.
  await reassignOperationSuppliersOnMerge(r, accountId, absorbedId, canonicalId, { reasonCode: 'OPERATION_MERGED' });
  await recomputePrincipal(r, accountId, canonicalId);
}
