/**
 * Titre AFFICHÉ d'un document lu en SQL — une seule reconstruction pour toutes
 * les vues (lot 87D, ticket P1 « titres des factures périodiques » §3.4).
 *
 * Cause corrigée : chaque vue reconstruisait son libellé à sa façon —
 * `coalesce(retained_title, original_filename)` ici (titre technique affiché,
 * lien web sans son titre), `displayDocumentTitle` sans le titre du lien web
 * ni les identifiants techniques là — si bien qu'un même document pouvait
 * porter deux libellés (liste, fiche, recherche, Agenda, TCO, « À traiter »,
 * assistant, notifications). Toute vue utilisateur lit désormais les MÊMES
 * colonnes (`documentTitleColumnsSql`) et applique la MÊME règle
 * (`documentTitleOf` → `displayDocumentTitle`) : titre métier enregistré →
 * titre du lien web → nom original exploitable → nom technique en dernier
 * recours.
 *
 * Module pur (aucun accès base) : importable par les composants.
 */
import { displayDocumentTitle } from './document-title-rules';

/**
 * Colonnes du titre affiché d'un document (`alias` : alias SQL de
 * `asset_files`), à insérer dans une liste de SELECT.
 */
export function documentTitleColumnsSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`alias SQL invalide : ${alias}`);
  return `${alias}.retained_title AS "titleRetained", ${alias}.web_link_title AS "titleWebLink", `
    + `${alias}.original_filename AS "titleOriginal", ${alias}.filename AS "titleFilename", `
    + `${alias}.s3_key AS "titleS3Key", ${alias}.public_id::text AS "titlePublicId"`;
}

/**
 * Mêmes colonnes en UN objet JSON (sous-requête scalaire : `(SELECT
 * ${documentTitleJsonSql('f')} FROM … LIMIT 1) AS titre`) — à lire avec
 * `documentTitleOf(row.titre)` ou `withDocumentTitles`. JSONB (et non JSON) :
 * comparable, donc utilisable sous `SELECT DISTINCT`, `GROUP BY`, `UNION`.
 */
export function documentTitleJsonSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`alias SQL invalide : ${alias}`);
  return `jsonb_build_object('titleRetained', ${alias}.retained_title, 'titleWebLink', ${alias}.web_link_title, `
    + `'titleOriginal', ${alias}.original_filename, 'titleFilename', ${alias}.filename, `
    + `'titleS3Key', ${alias}.s3_key, 'titlePublicId', ${alias}.public_id::text)`;
}

/** Ligne portant les colonnes de `documentTitleColumnsSql`. */
export interface DocumentTitleColumns {
  titleRetained?: unknown;
  titleWebLink?: unknown;
  titleOriginal?: unknown;
  titleFilename?: unknown;
  titleS3Key?: unknown;
  titlePublicId?: unknown;
}

const txt = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Titre affiché (règle unique) d'une ligne lue avec `documentTitleColumnsSql`. */
export function documentTitleOf(row: DocumentTitleColumns, fallback = 'Document'): string {
  return displayDocumentTitle({
    retainedTitle: txt(row.titleRetained),
    webLinkTitle: txt(row.titleWebLink),
    originalFilename: txt(row.titleOriginal),
    filename: txt(row.titleFilename),
    s3Key: txt(row.titleS3Key),
    publicId: txt(row.titlePublicId),
  }, fallback);
}

/** Document lu par l'ORM (noms de propriétés Drizzle). */
export interface DocumentTitleRecord {
  retainedTitle?: string | null;
  webLinkTitle?: string | null;
  originalFilename?: string | null;
  filename?: string | null;
  s3Key?: string | null;
  publicId?: string | null;
}

/** Titre affiché (règle unique) d'un document lu par l'ORM — la fiche documentaire (`GET /api/files/:id`). */
export function documentTitleFromRecord(doc: DocumentTitleRecord, fallback = 'Document'): string {
  return documentTitleOf({
    titleRetained: doc.retainedTitle, titleWebLink: doc.webLinkTitle, titleOriginal: doc.originalFilename,
    titleFilename: doc.filename, titleS3Key: doc.s3Key, titlePublicId: doc.publicId == null ? null : String(doc.publicId),
  }, fallback);
}

const estObjetTitre = (v: unknown): v is DocumentTitleColumns =>
  !!v && typeof v === 'object' && !Array.isArray(v) && 'titleRetained' in (v as Record<string, unknown>);

/**
 * Lignes lues avec `documentTitleJsonSql(…) AS <colonne>` : chaque colonne
 * portant l'objet des sources du titre est remplacée par le titre AFFICHÉ
 * (règle unique). Accepte des lignes ou une promesse de lignes.
 */
export function withDocumentTitles<T>(rows: T, fallback?: string): T;
export function withDocumentTitles<T>(rows: Promise<T>, fallback?: string): Promise<T>;
export function withDocumentTitles<T>(rows: T | Promise<T>, fallback = 'Document'): T | Promise<T> {
  const resoudre = (liste: T): T => {
    if (Array.isArray(liste)) {
      for (const r of liste as unknown[]) {
        if (!r || typeof r !== 'object') continue;
        for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
          if (estObjetTitre(v)) (r as Record<string, unknown>)[k] = documentTitleOf(v, fallback);
        }
      }
    }
    return liste;
  };
  const thenable = !!rows && typeof (rows as { then?: unknown }).then === 'function';
  return thenable ? Promise.resolve(rows as Promise<T>).then(resoudre) : resoudre(rows as T);
}
