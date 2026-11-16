/**
 * MÉMOIRE DU REFUS « événement de référence créé à tort » face à T3 (carte
 * Trello #744, CDC « Opérations / Agenda V2.0 » §5, §7, §19 ; AC13, AC47).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE PROBLÈME
 *
 * L'utilisateur supprime un événement de référence (façade
 * `invalidateOperation`, motif `USER_INVALIDATED`). Le lot B empêchait T3 de
 * le RÉACTIVER ; rien n'empêchait T3 d'en créer un NOUVEAU, identique, à
 * partir des mêmes preuves, dès qu'un passage ne retrouvait plus l'ancien
 * (document réanalysé et requalifié, clé de candidat changée, élément
 * d'Agenda modifié puis réexaminé). Le refus de l'utilisateur était alors
 * contourné sans bruit.
 *
 * LA RÈGLE (une seule, sans condition métier)
 *
 * Une SOURCE (document, élément d'Agenda) qui fondait un événement de
 * référence supprimé par l'utilisateur ne peut plus, à elle seule, en fonder
 * un nouveau par inférence. « Fondait » : source encore active de cet
 * événement, ou retirée DEPUIS sa suppression. Aucune table, aucune
 * migration : la mémoire EST la ligne de source de l'événement supprimé
 * (elle couvre donc aussi les suppressions antérieures à ce passage).
 *
 *   · T3 peut toujours RATTACHER la source à un événement de référence
 *     existant (ce n'est pas recréer) ;
 *   · une preuve NOUVELLE (autre document, autre élément) n'est pas concernée ;
 *   · le refus est levé par l'utilisateur seulement : restauration de
 *     l'événement (`restoreOperation`), ou geste explicite de rattachement.
 *
 * Document à plusieurs candidats : le refus vise le candidat qui portait la
 * source (même clé). Si cette clé n'existe plus après une réanalyse, on ne
 * sait plus lequel des candidats actuels reprend le fait refusé : aucun ne
 * crée (prudence : un refus n'est jamais contourné par un renommage).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';
import type { DbTx } from '../lock';
import { USER_INVALIDATION_REASON } from '../model';

/** Motif tracé d'un candidat ou d'un élément qui ne crée rien pour cette raison (`t3_reason`, journal, BO). */
export const USER_INVALIDATED_SOURCE_REASON = 'USER_INVALIDATED_REFERENCE_EVENT';

/**
 * Condition SQL (alias de `business_operation_sources` et de
 * `business_operations` déjà joints) : la source fondait un événement de
 * référence supprimé par l'utilisateur. Texte constant (aucune valeur reçue).
 */
export function userInvalidatedSourceSql(sourceAlias: string, operationAlias: string): string {
  if (!/^[a-z_]{1,12}$/.test(sourceAlias) || !/^[a-z_]{1,12}$/.test(operationAlias)) throw new Error('alias SQL invalide');
  return `(${operationAlias}.invalidated_at IS NOT NULL AND ${operationAlias}.invalidation_reason = '${USER_INVALIDATION_REASON}'
           AND ${operationAlias}.merged_into_operation_id IS NULL
           AND (${sourceAlias}.active OR ${sourceAlias}.superseded_at >= ${operationAlias}.invalidated_at))`;
}

/**
 * Le candidat `candidateKey` d'un document peut-il CRÉER un événement de
 * référence ? (pure). `refusedKeys` : clés des sources du document qui
 * fondaient un événement supprimé par l'utilisateur ; `activeKeys` : clés des
 * candidats actuels du document.
 */
export function creationRefusedByUserInvalidation(refusedKeys: readonly string[], candidateKey: string, activeKeys: readonly string[]): boolean {
  return refusedKeys.some((k) => k === candidateKey || !activeKeys.includes(k));
}

/**
 * La source (nature + identifiant) fondait-elle, dans CE compte, un événement
 * de référence supprimé par l'utilisateur ? Lecture seule, bornée au compte.
 */
export async function isSourceOfUserInvalidatedOperation(tx: DbTx, accountId: number, kind: 'DOCUMENT' | 'AGENDA', entityKey: number | string): Promise<boolean> {
  const q: SQL = sql`
    SELECT 1 FROM business_operation_sources s
      JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id
     WHERE s.account_id = ${accountId} AND s.source_kind = ${kind} AND s.source_entity_key = ${String(entityKey)}
       AND ${sql.raw(userInvalidatedSourceSql('s', 'o'))}
     LIMIT 1`;
  const r = (await tx.execute(q)) as unknown as unknown[];
  return r.length > 0;
}
