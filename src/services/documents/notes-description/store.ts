/**
 * Persistance du champ unique « Notes / Description » — lot 113Z (Trello #723).
 *
 * Colonnes de la migration 1580, NON déclarées dans Drizzle (comme 0223 /
 * 0337) : leur présence est vérifiée avant toute lecture ou écriture.
 *
 * Carte #767 (E02 / E05) — colonnes absentes OU illisibles :
 *   · lectures de l'application (tiroir, diagnostic) : valeurs neutres, comme
 *     avant — les parcours indépendants ne sont pas bloqués ;
 *   · écriture d'une intention utilisateur (`markNotesUserOwned`) : REFUSÉE,
 *     dans la transaction de la note (aucun succès trompeur) ;
 *   · sortie vers un tiers (`readCurrentNotesDescriptionManyStrict`) : REFUSÉE
 *     (jamais une valeur de repli).
 *
 *   · `notes_user_owned` / `notes_updated_at`   reprise en main utilisateur ;
 *   · `description_source`                      provenance établie ('T1') ;
 *   · `description_t1_status[_at]` / `_run_id`  dernier constat T1 (diagnostic).
 */
import { db, pgClient } from '@/db';
import { sql } from 'drizzle-orm';
import type { DescriptionT1Status } from '@/lib/documents/notes-description';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

/**
 * État du schéma 1580 (carte #767, E02 / E05) :
 *   · READY    les colonnes indispensables sont là ;
 *   · MISSING  la base a répondu : au moins une colonne manque (migration non appliquée ou défaite) ;
 *   · UNKNOWN  la base n'a PAS répondu (erreur SQL, délai) — on ne sait pas.
 * « Absent » et « illisible » ne sont plus confondus : une sortie vers un tiers
 * ou une écriture d'intention utilisateur refuse dans les deux cas (fail-closed).
 */
export type NotesDescriptionSchemaState = 'READY' | 'MISSING' | 'UNKNOWN';

/** Colonnes indispensables de la migration 1580 (les trois sondées depuis le lot 113Z). */
export const NOTES_DESCRIPTION_REQUIRED_COLUMNS = ['notes_user_owned', 'description_source', 'description_t1_status'] as const;

let etat: Promise<NotesDescriptionSchemaState> | null = null;
/** État du schéma 1580. Mémorisé (seul un résultat READY l'est). Ne lève jamais. */
export function notesDescriptionSchemaState(): Promise<NotesDescriptionSchemaState> {
  etat ??= Promise.resolve().then(() => pgClient.unsafe(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'asset_files'
        AND column_name IN ('notes_user_owned', 'description_source', 'description_t1_status')`) as unknown as Promise<Array<{ n: number }>>)
    .then((r): NotesDescriptionSchemaState => (Number(r[0]?.n) === NOTES_DESCRIPTION_REQUIRED_COLUMNS.length ? 'READY' : 'MISSING'))
    .catch((): NotesDescriptionSchemaState => 'UNKNOWN')
    .then((s) => { if (s !== 'READY') etat = null; return s; });
  return etat;
}

/** Remise à zéro de la mémoire de l'état du schéma (tests). */
export function resetNotesDescriptionSchemaCache(): void {
  etat = null;
}

/** Colonnes de la migration 1580 présentes ? Mémorisé (seul un résultat positif l'est). */
export function notesDescriptionColumnsReady(): Promise<boolean> {
  return notesDescriptionSchemaState().then((s) => s === 'READY');
}

/** Motif d'indisponibilité (journal et réponse : jamais de texte documentaire). */
export type NotesDescriptionUnavailableReason = 'SCHEMA_MISSING' | 'SCHEMA_UNKNOWN' | 'READ_FAILED' | 'WRITE_FAILED';

/**
 * Carte #767 (E05) : l'intention de l'utilisateur (prise en main, modification,
 * effacement de « Notes / Description ») ne peut pas être persistée — colonnes
 * 1580 indisponibles ou écriture du drapeau impossible. Levée DANS la
 * transaction de l'écriture de `notes` : rien n'est écrit, rien n'est confirmé.
 */
export class NotesIntentUnavailableError extends Error {
  readonly code = 'NOTES_INTENT_UNAVAILABLE' as const;
  readonly reason: NotesDescriptionUnavailableReason;
  constructor(reason: NotesDescriptionUnavailableReason) {
    super(`intention « Notes / Description » non persistable (${reason})`);
    this.name = 'NotesIntentUnavailableError';
    this.reason = reason;
  }
}

/**
 * Carte #767 (E02 / E03) : les valeurs de priorité / provenance nécessaires à
 * une sortie vers un tiers sont indisponibles. L'appelant REFUSE la sortie :
 * aucune valeur de repli (une description masquée par l'utilisateur pourrait
 * être divulguée).
 */
export class NotesDescriptionUnavailableError extends Error {
  readonly code = 'NOTES_DESCRIPTION_UNAVAILABLE' as const;
  readonly reason: NotesDescriptionUnavailableReason;
  constructor(reason: NotesDescriptionUnavailableReason) {
    super(`métadonnées « Notes / Description » indisponibles (${reason})`);
    this.name = 'NotesDescriptionUnavailableError';
    this.reason = reason;
  }
}

/** Texte de l'erreur rendue à l'utilisateur quand son intention ne peut pas être enregistrée (à valider par le PO). */
export const NOTES_INTENT_UNAVAILABLE_MESSAGE =
  'Votre modification de « Notes / Description » n’a pas pu être enregistrée : rien n’a été modifié. Réessayez dans un instant ; si le problème persiste, contactez le support.';

const motifSchema = (s: NotesDescriptionSchemaState): NotesDescriptionUnavailableReason => (s === 'MISSING' ? 'SCHEMA_MISSING' : 'SCHEMA_UNKNOWN');

/**
 * Carte #767 (E05) : à appeler AVANT une écriture qui porte une intention
 * utilisateur sur « Notes / Description » — lève si elle ne pourra pas être
 * persistée (aucune écriture n'a encore eu lieu).
 */
export async function assertNotesIntentPersistable(): Promise<void> {
  const s = await notesDescriptionSchemaState();
  if (s !== 'READY') {
    console.error(`[notes-description] intention utilisateur refusée : schéma 1580 ${s === 'MISSING' ? 'incomplet' : 'illisible'} (aucune écriture).`);
    throw new NotesIntentUnavailableError(motifSchema(s));
  }
}

export interface NotesDescriptionMeta {
  notesUserOwned: boolean;
  notesUpdatedAt: string | null;
  descriptionSource: string | null;
  descriptionT1Status: DescriptionT1Status | null;
  descriptionT1StatusAt: string | null;
  descriptionT1RunId: number | null;
}

const VIDE: NotesDescriptionMeta = {
  notesUserOwned: false, notesUpdatedAt: null, descriptionSource: null,
  descriptionT1Status: null, descriptionT1StatusAt: null, descriptionT1RunId: null,
};

/** Métadonnées 1580 d'un document du compte (valeurs neutres si les colonnes manquent). */
export async function readNotesDescriptionMeta(accountId: number, fileId: number): Promise<NotesDescriptionMeta> {
  if (!(await notesDescriptionColumnsReady())) return { ...VIDE };
  const r = (await pgClient.unsafe(
    `SELECT notes_user_owned, notes_updated_at, description_source, description_t1_status, description_t1_status_at, description_t1_run_id
       FROM asset_files WHERE id = $1 AND account_id = $2`,
    [fileId, accountId] as never[],
  )) as unknown as Array<Record<string, unknown>>;
  const x = r[0];
  if (!x) return { ...VIDE };
  const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
  return {
    notesUserOwned: x.notes_user_owned === true,
    notesUpdatedAt: iso(x.notes_updated_at),
    descriptionSource: x.description_source == null ? null : String(x.description_source),
    descriptionT1Status: x.description_t1_status == null ? null : String(x.description_t1_status) as DescriptionT1Status,
    descriptionT1StatusAt: iso(x.description_t1_status_at),
    descriptionT1RunId: x.description_t1_run_id == null ? null : Number(x.description_t1_run_id),
  };
}

/**
 * Reprise en main utilisateur, dans la transaction de l'écriture de `notes`.
 *
 * Carte #767 (E05) — règle remplacée : le lot 113Z rendait `false` quand les
 * colonnes manquaient (« la note est écrite, sans drapeau ») : un effacement
 * volontaire ne survivait pas et l'ancienne description réapparaissait.
 * Désormais l'écriture est REFUSÉE (`NotesIntentUnavailableError`) : levée dans
 * la transaction de l'appelant, elle annule aussi l'écriture de `notes` — tout
 * ou rien (`notes`, `notes_user_owned`, `notes_updated_at`).
 */
export async function markNotesUserOwned(x: Exec, accountId: number, fileId: number): Promise<true> {
  await assertNotesIntentPersistable();
  let r: unknown;
  try {
    r = await x.execute(sql`UPDATE asset_files SET notes_user_owned = true, notes_updated_at = now()
    WHERE id = ${fileId} AND account_id = ${accountId} RETURNING id`);
  } catch (e) {
    console.error(`[notes-description] drapeau de reprise en main non écrit (fichier ${fileId}) :`, (e as Error).message);
    throw new NotesIntentUnavailableError('WRITE_FAILED');
  }
  const lignes = (Array.isArray(r) ? r : (r as { rows?: unknown[] } | null)?.rows ?? []) as unknown[];
  // Aucune ligne : document absent du compte — l'intention n'est pas persistée, donc pas confirmée.
  if (lignes.length === 0) throw new NotesIntentUnavailableError('WRITE_FAILED');
  return true;
}

/** Reprise en main déjà posée ? (`false` si colonnes absentes). */
export async function isNotesUserOwned(x: Exec, accountId: number, fileId: number): Promise<boolean> {
  if (!(await notesDescriptionColumnsReady())) return false;
  const r = await x.execute(sql`SELECT notes_user_owned FROM asset_files WHERE id = ${fileId} AND account_id = ${accountId}`);
  const rows = (Array.isArray(r) ? r : (r as unknown as { rows?: unknown[] }).rows ?? []) as Array<{ notes_user_owned?: boolean }>;
  return rows[0]?.notes_user_owned === true;
}

/**
 * Constat T1 sur la description (et provenance quand T1 l'a écrite). Ne lève
 * jamais : une trace manquée ne fait pas échouer une analyse.
 */
export async function recordDescriptionT1Status(
  x: Exec,
  p: { accountId: number; fileId: number; status: DescriptionT1Status; runId?: number | null; setSourceT1?: boolean },
): Promise<boolean> {
  try {
    if (!(await notesDescriptionColumnsReady())) return false;
    // Point de reprise (transaction appelante) : un échec ici n'annule jamais
    // les écritures de l'analyse.
    await x.transaction(async (sp) => sp.execute(sql`UPDATE asset_files
       SET description_t1_status = ${p.status}, description_t1_status_at = now(),
           description_t1_run_id = COALESCE(${p.runId ?? null}::int, description_t1_run_id)
           ${p.setSourceT1 ? sql`, description_source = 'T1'` : sql``}
     WHERE id = ${p.fileId} AND account_id = ${p.accountId}`));
    return true;
  } catch (e) {
    console.error(`[notes-description] constat T1 « ${p.status} » non écrit (fichier ${p.fileId}) :`, (e as Error).message);
    return false;
  }
}

/** Provenance de la description courante (`null` si inconnue ou colonnes absentes). */
export async function readDescriptionSource(x: Exec, accountId: number, fileId: number): Promise<string | null> {
  if (!(await notesDescriptionColumnsReady())) return null;
  const r = await x.execute(sql`SELECT description_source FROM asset_files WHERE id = ${fileId} AND account_id = ${accountId}`);
  const rows = (Array.isArray(r) ? r : (r as unknown as { rows?: unknown[] }).rows ?? []) as Array<{ description_source?: string | null }>;
  return rows[0]?.description_source ?? null;
}

/** Métadonnées 1580 de plusieurs documents d'un compte (absents / colonnes manquantes : neutres). */
export async function readNotesDescriptionMetaMany(accountId: number, fileIds: number[]): Promise<Map<number, Pick<NotesDescriptionMeta, 'notesUserOwned' | 'descriptionSource'>>> {
  const out = new Map<number, Pick<NotesDescriptionMeta, 'notesUserOwned' | 'descriptionSource'>>();
  if (fileIds.length === 0 || !(await notesDescriptionColumnsReady())) return out;
  const r = (await pgClient.unsafe(
    `SELECT id, notes_user_owned, description_source FROM asset_files WHERE account_id = $1 AND id = ANY($2::int[])`,
    [accountId, fileIds] as never[],
  )) as unknown as Array<{ id: number; notes_user_owned: boolean | null; description_source: string | null }>;
  for (const x of r) out.set(Number(x.id), { notesUserOwned: x.notes_user_owned === true, descriptionSource: x.description_source ?? null });
  return out;
}

/** Provenance T1 d'une description copiée (transmission avec inclusion explicite). */
export async function markDescriptionSourceT1(x: Exec, accountId: number, fileId: number): Promise<void> {
  if (!(await notesDescriptionColumnsReady())) return;
  await x.execute(sql`UPDATE asset_files SET description_source = 'T1' WHERE id = ${fileId} AND account_id = ${accountId}`);
}

/** Valeurs COURANTES d'un document, nécessaires à `resolveNotesDescription` (lecture stricte). */
export interface CurrentNotesDescriptionRow {
  notes: string | null;
  description: string | null;
  notesUserOwned: boolean;
  descriptionSource: string | null;
}

/**
 * Carte #767 (E02 / E03) — lecture STRICTE, pour une sortie vers un tiers, des
 * valeurs courantes (`notes`, `description`, reprise en main, provenance) des
 * documents d'un compte, en UNE requête (jamais un mélange « instantané ancien
 * + métadonnées du jour »).
 *
 * Fail-closed : schéma 1580 incomplet ou illisible, erreur SQL, délai → lève
 * `NotesDescriptionUnavailableError` (l'appelant refuse la sortie). Un document
 * absent du résultat (supprimé du compte entre-temps) n'a pas d'entrée :
 * l'appelant n'inclut alors AUCUN texte pour lui (jamais un repli).
 * Le journal ne porte que des nombres et un motif — jamais de texte documentaire.
 */
export async function readCurrentNotesDescriptionManyStrict(
  accountId: number, fileIds: readonly number[], contexte: string,
): Promise<Map<number, CurrentNotesDescriptionRow>> {
  const out = new Map<number, CurrentNotesDescriptionRow>();
  const ids = [...new Set(fileIds.filter((n) => Number.isSafeInteger(n) && n > 0))];
  const s = await notesDescriptionSchemaState();
  if (s !== 'READY') {
    console.error(`[notes-description] ${contexte} : inclusion refusée — schéma 1580 ${s === 'MISSING' ? 'incomplet' : 'illisible'} (compte ${accountId}, ${ids.length} document(s)).`);
    throw new NotesDescriptionUnavailableError(motifSchema(s));
  }
  if (ids.length === 0) return out;
  let r: Array<{ id: number; notes: string | null; description: string | null; notes_user_owned: boolean | null; description_source: string | null }>;
  try {
    r = (await pgClient.unsafe(
      `SELECT id, notes, description, notes_user_owned, description_source FROM asset_files WHERE account_id = $1 AND id = ANY($2::int[])`,
      [accountId, ids] as never[],
    )) as unknown as typeof r;
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    console.error(`[notes-description] ${contexte} : inclusion refusée — lecture des métadonnées en échec (compte ${accountId}, ${ids.length} document(s), code ${code ?? 'inconnu'}).`);
    throw new NotesDescriptionUnavailableError('READ_FAILED');
  }
  for (const x of r) {
    out.set(Number(x.id), {
      notes: x.notes ?? null, description: x.description ?? null,
      notesUserOwned: x.notes_user_owned === true, descriptionSource: x.description_source ?? null,
    });
  }
  if (out.size < ids.length) {
    console.warn(`[notes-description] ${contexte} : ${ids.length - out.size} document(s) sans métadonnées (absents du compte ${accountId}) — aucun texte inclus pour eux.`);
  }
  return out;
}
