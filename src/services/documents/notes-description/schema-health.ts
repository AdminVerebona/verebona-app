/**
 * Disponibilité du schéma « Notes / Description » (migration 1580) — carte
 * #767 (E05), page BO « Exploitation › Santé ».
 *
 * La présence du fichier de migration dans le dépôt, ou une CI verte, ne
 * prouvent pas que les colonnes existent dans la base de l'environnement :
 * elles sont RELUES en base à l'instant (`information_schema`), avec la trace
 * d'application de la migration (`_migrations`). Lecture seule, bornée, sans
 * aucune donnée de compte ni texte documentaire.
 *
 * Conséquences d'un schéma incomplet ou illisible (fail-closed) :
 *   · enregistrer, modifier ou effacer « Notes / Description » est refusé ;
 *   · une transmission ou un dossier tiers avec inclusion est refusé.
 * Les lectures de l'application et la recherche restent disponibles.
 */
import { pgClient } from '@/db';
import { NOTES_DESCRIPTION_REQUIRED_COLUMNS, type NotesDescriptionSchemaState } from './store';

/** Colonnes de la migration 1580 (indispensables + trace). */
export const NOTES_DESCRIPTION_ALL_COLUMNS = [
  ...NOTES_DESCRIPTION_REQUIRED_COLUMNS, 'notes_updated_at', 'description_t1_status_at', 'description_t1_run_id',
] as const;

/** Fichiers de migration qui posent ces colonnes (1704 : filet de sûreté rejouable de la carte #767). */
export const NOTES_DESCRIPTION_MIGRATIONS = ['1580_l113z_notes_description.sql', '1704_l114z_notes_description_surete.sql'] as const;

export interface NotesDescriptionSchemaHealth {
  state: NotesDescriptionSchemaState;
  /** Colonnes attendues absentes de `asset_files` (noms). */
  missingColumns: string[];
  /** Migrations tracées comme appliquées (`_migrations`) ; `null` : suivi illisible. */
  appliedMigrations: string[] | null;
  /** Documents portant une reprise en main (`notes_user_owned`) ; `null` : non lu. Nombre seulement. */
  userOwnedDocuments: number | null;
  error: string | null;
}

/** Pure : état à partir des colonnes présentes. */
export function notesSchemaStateFromColumns(present: readonly string[]): { state: NotesDescriptionSchemaState; missingColumns: string[] } {
  const p = new Set(present);
  const missingColumns = NOTES_DESCRIPTION_ALL_COLUMNS.filter((c) => !p.has(c));
  const indispensable = NOTES_DESCRIPTION_REQUIRED_COLUMNS.every((c) => p.has(c));
  return { state: indispensable ? 'READY' : 'MISSING', missingColumns };
}

/** Relit en base l'état du schéma 1580. Ne lève jamais. */
export async function readNotesDescriptionSchemaHealth(): Promise<NotesDescriptionSchemaHealth> {
  let present: string[];
  try {
    const r = (await pgClient.unsafe(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'asset_files' AND column_name = ANY($1::text[])`,
      [[...NOTES_DESCRIPTION_ALL_COLUMNS]] as never[],
    )) as unknown as Array<{ column_name: string }>;
    present = r.map((x) => String(x.column_name));
  } catch (e) {
    return { state: 'UNKNOWN', missingColumns: [], appliedMigrations: null, userOwnedDocuments: null, error: (e as Error).message?.slice(0, 200) ?? 'erreur' };
  }
  const { state, missingColumns } = notesSchemaStateFromColumns(present);
  const appliedMigrations = await (pgClient.unsafe(
    `SELECT filename FROM _migrations WHERE filename = ANY($1::text[]) ORDER BY filename`,
    [[...NOTES_DESCRIPTION_MIGRATIONS]] as never[],
  ) as unknown as Promise<Array<{ filename: string }>>).then((r) => r.map((x) => String(x.filename)), () => null);
  const userOwnedDocuments = state === 'READY'
    ? await (pgClient.unsafe(`SELECT count(*)::int AS n FROM asset_files WHERE notes_user_owned`) as unknown as Promise<Array<{ n: number }>>)
      .then((r) => Number(r[0]?.n ?? 0), () => null)
    : null;
  return { state, missingColumns, appliedMigrations, userOwnedDocuments, error: null };
}
