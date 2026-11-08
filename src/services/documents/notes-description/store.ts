/**
 * Persistance du champ unique « Notes / Description » — lot 113Z (Trello #723).
 *
 * Colonnes de la migration 1580, NON déclarées dans Drizzle (comme 0223 /
 * 0337) : leur présence est vérifiée avant toute lecture ou écriture ;
 * absentes → comportement antérieur (aucune erreur, aucune écriture).
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

let pret: Promise<boolean> | null = null;
/** Colonnes de la migration 1580 présentes ? Mémorisé (seul un résultat positif l'est). */
export function notesDescriptionColumnsReady(): Promise<boolean> {
  pret ??= Promise.resolve().then(() => pgClient.unsafe(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'asset_files'
        AND column_name IN ('notes_user_owned', 'description_source', 'description_t1_status')`) as unknown as Promise<Array<{ n: number }>>)
    .then((r) => Number(r[0]?.n) === 3)
    .catch(() => false)
    .then((ok) => { if (!ok) pret = null; return ok; });
  return pret;
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
 * Rend `false` si les colonnes manquent (la note est écrite, sans drapeau).
 */
export async function markNotesUserOwned(x: Exec, accountId: number, fileId: number): Promise<boolean> {
  if (!(await notesDescriptionColumnsReady())) return false;
  await x.execute(sql`UPDATE asset_files SET notes_user_owned = true, notes_updated_at = now()
    WHERE id = ${fileId} AND account_id = ${accountId}`);
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
