/**
 * Reprise de la description T1 depuis l'extraction persistée — lot 113Z
 * (contrôle COH-DOC-DESCRIPTION-T1). Aucune IA, aucune réanalyse.
 *
 * Écritures CONDITIONNELLES (l'état lu par le contrôle doit être inchangé) :
 *   · RECOVER  description vide, non verrouillée → description de
 *              l'extraction, provenance T1, constat RECOVERED ;
 *   · QUALIFY  description identique à l'extraction, sans provenance →
 *              provenance T1 (valeur inchangée).
 * La note de l'utilisateur n'est jamais lue ni écrite.
 */
import type postgres from 'postgres';

export async function repairDocumentDescriptionFromExtraction(
  sql: postgres.Sql,
  p: { accountId: number; fileId: number; mode: 'RECOVER' | 'QUALIFY' },
): Promise<{ changed: boolean }> {
  const r = p.mode === 'RECOVER'
    ? (await sql.unsafe(
      `UPDATE asset_files f
          SET description = btrim(x.description), description_source = 'T1',
              description_t1_status = 'RECOVERED', description_t1_status_at = now(), updated_at = now()
         FROM document_extractions x
        WHERE f.id = $1 AND f.account_id = $2 AND f.deleted_at IS NULL
          AND x.file_id = f.id AND x.account_id = f.account_id AND NULLIF(btrim(x.description), '') IS NOT NULL
          AND NULLIF(btrim(f.description), '') IS NULL
          AND COALESCE(f.user_edited_fields ->> 'description', 'false') <> 'true'
        RETURNING f.id`,
      [p.fileId, p.accountId] as never[],
    )) as unknown as Array<{ id: number }>
    : (await sql.unsafe(
      `UPDATE asset_files f
          SET description_source = 'T1'
         FROM document_extractions x
        WHERE f.id = $1 AND f.account_id = $2 AND f.deleted_at IS NULL
          AND x.file_id = f.id AND x.account_id = f.account_id
          AND f.description_source IS NULL AND btrim(f.description) = btrim(x.description)
        RETURNING f.id`,
      [p.fileId, p.accountId] as never[],
    )) as unknown as Array<{ id: number }>;
  return { changed: r.length > 0 };
}
