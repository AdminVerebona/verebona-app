/**
 * Champ COURANT « Notes / Description » en SQL — carte #767 (E01), suite du
 * lot 113Z (#723).
 *
 * La règle est celle de `resolveNotesDescription()` (`@/lib/documents/
 * notes-description`), et elle seule : reprise en main explicite → `notes`,
 * même VIDE ; sinon `notes` non vide ; sinon `description`. Ce module en donne
 * la forme SQL pour les recherches de l'Assistant (T2), qui filtrent et
 * pondèrent en base : une description masquée (note prioritaire) ou effacée
 * (`notes_user_owned = true`, `notes = NULL`) n'est plus cherchée, ni rendue.
 * Les lignes lues sont ensuite résolues par `resolveNotesDescription()` : SQL,
 * score et contenu passé au modèle appliquent la même priorité.
 *
 * Aucune seconde source de vérité : `L114Z-U-SQL` vérifie que l'expression SQL
 * et la fonction pure donnent le même texte sur les mêmes lignes.
 *
 * Schéma 1580 :
 *   · READY / UNKNOWN → la colonne `notes_user_owned` est lue (si elle manque
 *     réellement, la requête échoue : aucune valeur de repli) ;
 *   · MISSING (la base a répondu : colonnes absentes) → aucune reprise en main
 *     n'a pu être enregistrée (écritures refusées, E05) : `false`, les
 *     recherches restent disponibles.
 */
import { notesDescriptionSchemaState, type NotesDescriptionSchemaState } from './store';

/** Fragments SQL (texte brut) du champ courant, pour un alias de `asset_files`. */
export interface CurrentFieldSql {
  state: NotesDescriptionSchemaState;
  /** Booléen : l'utilisateur a repris la main. */
  owned: string;
  /** Texte : le champ courant (chaîne vide si rien). */
  current: string;
  /** Booléen : le texte courant vient de `notes` (reprise en main ou note non vide). */
  fromNotes: string;
  /** Booléen : la description (T1 / historique) EST le champ courant — ni masquée, ni effacée. */
  descriptionIsCurrent: string;
}

const ALIAS = /^[a-z_"][a-z0-9_".]*$/i;

/** Fragments SQL du champ courant. Pure. `alias` : alias (ou nom entre guillemets) de `asset_files`. */
export function currentFieldSqlFor(alias: string, state: NotesDescriptionSchemaState): CurrentFieldSql {
  if (!ALIAS.test(alias)) throw new Error(`alias SQL invalide : ${alias}`);
  const owned = state === 'MISSING' ? 'false' : `coalesce(${alias}.notes_user_owned, false)`;
  // Mêmes bords que `String.prototype.trim()` pour les blancs usuels (espace, tabulation, fins de ligne).
  const net = (col: string) => `btrim(${alias}.${col}, E' \\t\\n\\r')`;
  const note = `NULLIF(${net('notes')}, '')`;
  const fromNotes = `(${owned} OR ${note} IS NOT NULL)`;
  return {
    state,
    owned,
    fromNotes,
    current: `(CASE WHEN ${owned} THEN coalesce(${net('notes')}, '') WHEN ${note} IS NOT NULL THEN ${net('notes')} ELSE coalesce(${net('description')}, '') END)`,
    descriptionIsCurrent: `(NOT ${fromNotes})`,
  };
}

/** Fragments SQL du champ courant selon l'état réel du schéma. */
export async function currentFieldSql(alias: string): Promise<CurrentFieldSql> {
  return currentFieldSqlFor(alias, await notesDescriptionSchemaState());
}
