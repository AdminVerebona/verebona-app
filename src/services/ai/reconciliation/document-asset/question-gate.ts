/**
 * Quand l'utilisateur peut-il être interrogé sur le rattachement d'un
 * document (« À traiter » LINK-ASSET) ? — lot 31B, ticket T3 §9.
 *
 * « Une abstention T1 ne doit plus suffire à demander immédiatement une
 * intervention utilisateur. » Pour un document dont T1 est terminé et dont la
 * représentation est persistée, la question n'est posée qu'APRÈS T3
 * DOCUMENT_ASSET (abstention ou absence de candidat) — T3 la crée lui-même,
 * avec SES candidats. Le pont documentaire et le balayage horaire n'en
 * créent pas avant.
 *
 * Restent interrogeables sans T3 (T3 ne pourrait rien pour eux) :
 *   · document jamais analysé, en cours, ou en échec d'analyse ;
 *   · document analysé SANS représentation persistée (ancien moteur) ;
 *   · document dont l'utilisateur a retiré le rattachement (T3 ne rattache
 *     jamais un document détaché par l'utilisateur).
 */
import { pgClient } from '@/db';

/** États d'analyse où T1 est terminé. */
export const T1_SETTLED_STATES = ['ANALYZED', 'VALIDATION_REQUIRED', 'CONFLICT_DETECTED', 'FUSION_SUGGESTED'] as const;

/** Condition SQL (alias `f` = asset_files) : la question peut être posée. */
export const ASSET_LINK_QUESTION_ALLOWED_SQL = `(
  f.analysis_state IS NULL
  OR f.analysis_state NOT IN ('${T1_SETTLED_STATES.join("', '")}')
  OR NOT EXISTS (SELECT 1 FROM document_extractions qe WHERE qe.file_id = f.id)
  OR COALESCE((f.user_edited_fields ->> 'assetId')::boolean, false)
  OR EXISTS (SELECT 1 FROM document_asset_resolutions qr
              WHERE qr.file_id = f.id AND qr.status IN ('ABSTAINED', 'NO_CANDIDATE')))`;

/** La question LINK-ASSET peut-elle être créée pour ce document ? */
export async function assetLinkQuestionAllowed(accountId: number, fileId: number): Promise<boolean> {
  const rows = (await pgClient.unsafe(
    `SELECT ${ASSET_LINK_QUESTION_ALLOWED_SQL} AS ok FROM asset_files f WHERE f.id = $1 AND f.account_id = $2`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ ok: boolean }>;
  return rows[0]?.ok === true;
}
