/**
 * Lot 111R — PREUVE DE RÉALISATION VALIDE d'un élément d'agenda : expression
 * SQL UNIQUE, lue par tous les lecteurs du statut effectif (tiroir et liste
 * Agenda, Timeline du bien — groupes et membres, modes Regroupée / Détaillée —,
 * suivi du bien, équipement, export de recette, assistant).
 *
 * Règle du lot 103D (0945, inchangée — seulement appliquée partout de la même
 * façon) : la preuve MÉMORISÉE (`completion_proof_file_id`) ne vaut que si le
 * document existe encore, appartient au compte de l'élément, n'est pas
 * supprimé, et reste LIÉ à l'élément (`agenda_file_links`, condition déjà
 * exigée à l'écriture par `repairHistoricalStatus` et `carryProofInTx`).
 * Revérifiée à CHAQUE lecture : document supprimé ou délié → la preuve tombe,
 * le statut est recalculé (« Statut à confirmer » / « Date échue »), sans
 * état obsolète et sans rien écrire.
 *
 * Coût : deux lectures par clé (clé primaire `asset_files`, index unique
 * `agenda_file_links (agenda_item_id, asset_file_id)`) par élément lu, dans
 * la MÊME requête que les éléments (pas de N+1).
 */
import { agendaCompletionColumnsReady } from './agenda-columns';

/**
 * Expression SQL booléenne : l'élément (alias `a`, ligne de `agenda_items`)
 * a une preuve de réalisation valide. Exige les colonnes 0945.
 */
export function validCompletionProofSql(a = 'i'): string {
  return `(${a}.completion_proof_file_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM asset_files cpf
        JOIN agenda_file_links cpl ON cpl.asset_file_id = cpf.id AND cpl.agenda_item_id = ${a}.id
       WHERE cpf.id = ${a}.completion_proof_file_id AND cpf.account_id = ${a}.account_id AND cpf.deleted_at IS NULL))`;
}

/**
 * Même expression, ou `false` si les colonnes 0945 ne sont pas présentes
 * (requête toujours valide ; la preuve est alors ignorée, comme avant).
 */
export async function validCompletionProofSelect(a = 'i'): Promise<string> {
  return (await agendaCompletionColumnsReady()) ? validCompletionProofSql(a) : 'false';
}
