/**
 * Réparation de la date du document posée par repli sur le jour d'import —
 * lot 108D (appelée par COH-DOC-DATE-FALLBACK, seule autorisée à l'appeler).
 *
 * Écriture CONDITIONNELLE, en une instruction :
 *   · la valeur courante est encore celle qui a été diagnostiquée ;
 *   · aucune marque utilisateur (`user_edited_fields.documentDate`) — une
 *     correction manuelle n'est jamais remplacée, même posée entre
 *     l'inspection et la réparation ;
 *   · document du compte, non supprimé.
 * Seule la colonne `document_date` change (et `updated_at`) : date d'ajout,
 * fichiers, relations, Opérations, événements, titres utilisateur intacts.
 * Le journal (avant / après, motif) est tenu par le moteur de cohérence
 * (`coherence_repairs`).
 */
import type postgres from 'postgres';

export async function repairDocumentDateFallback(
  sql: postgres.Sql,
  p: { accountId: number; fileId: number; currentDate: string; newDate: string | null },
): Promise<{ changed: boolean }> {
  const r = (await sql.unsafe(
    `UPDATE asset_files
        SET document_date = $4::date, updated_at = NOW()
      WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL
        AND document_date = $3::date
        AND COALESCE(user_edited_fields ->> 'documentDate', 'false') <> 'true'
      RETURNING id`,
    [p.fileId, p.accountId, p.currentDate, p.newDate] as never[],
  )) as unknown as Array<{ id: number }>;
  return { changed: r.length > 0 };
}
