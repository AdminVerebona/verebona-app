/**
 * Carte #849 (C1, C2) — ZIP COMPLET d'un bien : moteur `EXPORT_BRUT`, portée
 * `complete` (onglet Exports et fenêtre de suppression, même moteur, même
 * exhaustivité pour Standard, Premium et Duo).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INVENTAIRE INDÉPENDANT, SNAPSHOT STABLE
 *
 * Les éléments ATTENDUS sont relus en base dans UNE transaction REPEATABLE
 * READ en lecture seule (périmètre cohérent pendant la génération) : fiche,
 * documents rattachés (colonnes historiques et liens N-N ACTIFS PRIMARY /
 * SECONDARY, pièces et équipements du bien compris) et leurs versions,
 * photos, pièces, équipements, Opérations (liens, équipements, pièces,
 * composantes), dépenses / ventilations du bien, sources, Agenda historique
 * et futur, échéances et événements historiques. Rien d'un autre compte ;
 * d'une Opération partagée, seules les ventilations de CE bien (les autres
 * sont déclarées exclues, motif à l'appui).
 *
 * CONTRÔLE SOURCE ↔ ARCHIVE
 *
 *   · chaque binaire est relu dans le stockage ; objet absent, illisible ou
 *     dont l'empreinte SHA-256 diffère de celle enregistrée → MANQUANT,
 *     motif à l'appui — jamais ignoré en silence ;
 *   · noms uniques (Unicode NFC, collisions suffixées « (2) »), jamais
 *     écrasés ; chaque entrée est inscrite au manifeste avec taille et
 *     SHA-256 ;
 *   · l'archive produite est RELUE : nombre d'entrées, tailles et empreintes
 *     recontrôlés ; tout écart = échec ;
 *   · un seul manquant → statut INCOMPLETE : l'appelant marque la génération
 *     en échec (jamais « prête », jamais « ZIP complet ») avec le détail.
 *
 * Bornes : taille cumulée des binaires plafonnée (`COMPLETE_ARCHIVE_MAX_BYTES`,
 * 512 Mio par défaut) — au-delà, échec explicite, aucun ZIP tronqué. V1 :
 * archive exploitable (CSV UTF-8 + JSON + fichiers), SANS réimport.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { pgClient } from '@/db';
import { downloadFilename, makeUniqueNamer } from '@/lib/download-filename';

export type StorageReader = (key: string, bucket: string | null) => Promise<Buffer>;

export const COMPLETE_ARCHIVE_VERSION = 'c849-v1';
const MAX_BYTES = (): number => Number(process.env.COMPLETE_ARCHIVE_MAX_BYTES) || 512 * 1024 * 1024;

type Row = Record<string, unknown>;

export interface ManifestFile { path: string; size: number; sha256: string; category: string; sourceId: number | null }
export interface ManifestGap { category: string; id: number; motif: string; detail?: string }
export interface CompleteArchiveManifest {
  format: typeof COMPLETE_ARCHIVE_VERSION;
  generatedAt: string;
  asset: { id: number; name: string };
  status: 'COMPLETE' | 'INCOMPLETE';
  categories: Record<string, { expected: number; exported: number; excluded: number; missing: number }>;
  files: ManifestFile[];
  excluded: ManifestGap[];
  missing: ManifestGap[];
  notApplicable: string[];
}

export interface CompleteArchiveResult {
  status: 'COMPLETE' | 'INCOMPLETE';
  buffer: Buffer | null;
  sha256: string | null;
  manifest: CompleteArchiveManifest;
}

export class CompleteArchiveError extends Error {
  constructor(public readonly code: 'ARCHIVE_TOO_LARGE' | 'ARCHIVE_VERIFICATION_FAILED' | 'ASSET_NOT_FOUND', message: string) {
    super(message);
    this.name = 'CompleteArchiveError';
  }
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
};
const SENSIBLE = /token|secret|password|fingerprint|api_?key/i;
const sansSecrets = (o: Row): Row => Object.fromEntries(Object.entries(o).filter(([k]) => !SENSIBLE.test(k)));

/** CSV UTF-8 (BOM, séparateur « ; », guillemets échappés) — pur, testé. */
export function toCsv(columns: readonly string[], lines: ReadonlyArray<Row>): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[columns.join(';'), ...lines.map((l) => columns.map((c) => cell(l[c])).join(';'))].join('\r\n')}\r\n`;
}

/** Segment de nom sûr pour un dossier (Unicode conservé, séparateurs retirés). */
function segment(s: string | null | undefined, repli: string): string {
  const v = (s ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
  return v || repli;
}

interface Inventory {
  asset: Row;
  files: Row[];
  excludedLinks: Row[];
  versions: Row[];
  photos: Row[];
  rooms: Row[];
  equipments: Row[];
  operations: Row[];
  components: Row[];
  foreignComponents: Row[];
  sources: Row[];
  operationLinks: Row[];
  agenda: Row[];
  agendaLinks: Row[];
  deadlines: Row[];
  events: Row[];
}

/** Inventaire attendu, relu dans un snapshot stable (REPEATABLE READ, lecture seule). */
export async function loadCompleteInventory(accountId: number, assetId: number): Promise<Inventory | null> {
  return pgClient.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const q = async (text: string, params: unknown[] = [assetId, accountId]) =>
      (await tx.unsafe(text, params as never[])) as unknown as Row[];
    const [asset] = await q(`SELECT row_to_json(a.*)::jsonb AS j FROM assets a WHERE a.id = $1 AND a.account_id = $2 AND a.deleted_at IS NULL`);
    if (!asset) return null;
    const scope = `
      WITH subs AS (SELECT id FROM substructures WHERE asset_id = $1),
           eqs  AS (SELECT id FROM equipments WHERE asset_id = $1),
           rms  AS (SELECT id FROM rooms WHERE asset_id = $1),
           lies AS (
             SELECT f.id, CASE WHEN f.asset_id = $1 THEN 'PRIMARY' ELSE 'SECONDARY' END AS role
               FROM asset_files f
              WHERE f.account_id = $2 AND (f.asset_id = $1 OR f.linked_asset_id = $1 OR f.linked_room_id IN (SELECT id FROM rms)
                    OR f.substructure_id IN (SELECT id FROM subs) OR f.equipment_id IN (SELECT id FROM eqs))
             UNION ALL
             SELECT l.file_id, l.link_role FROM document_asset_links l
              WHERE l.account_id = $2 AND l.status = 'ACTIVE' AND l.link_role IN ('PRIMARY', 'SECONDARY')
                AND (l.asset_id = $1 OR l.equipment_id IN (SELECT id FROM eqs) OR l.substructure_id IN (SELECT id FROM subs)))`;
    const files = await q(`${scope}
      SELECT f.id, f.public_id, f.retained_title, f.original_filename, f.filename, f.mime_type, f.size, f.sha256_hash,
             f.s3_key, f.s3_bucket, f.is_web_link, f.web_link_url, f.web_link_title, f.document_type, f.document_type_code,
             f.rubric_code, f.document_date, f.description, f.notes, f.supplier, f.amount_cents, f.equipment_id,
             f.substructure_id, f.created_at, f.uploaded_at,
             (SELECT CASE WHEN bool_or(x.role = 'PRIMARY') THEN 'PRIMARY' ELSE 'SECONDARY' END FROM lies x WHERE x.id = f.id) AS relation,
             EXISTS (SELECT 1 FROM asset_photos p WHERE p.file_id = f.id AND p.asset_id = $1) AS is_photo
        FROM asset_files f
       WHERE f.account_id = $2 AND f.id IN (SELECT id FROM lies) AND f.deleted_at IS NULL
         AND COALESCE(f.upload_status, 'COMPLETED') = 'COMPLETED'
       ORDER BY f.id`);
    const excludedLinks = await q(`
      SELECT DISTINCT l.file_id AS id, l.link_role, l.status FROM document_asset_links l
        JOIN asset_files f ON f.id = l.file_id AND f.account_id = $2 AND f.deleted_at IS NULL
       WHERE l.account_id = $2 AND (l.asset_id = $1 OR l.equipment_id IN (SELECT id FROM equipments WHERE asset_id = $1)
                                    OR l.substructure_id IN (SELECT id FROM substructures WHERE asset_id = $1))
         AND (l.status = 'PROPOSED' OR (l.status = 'ACTIVE' AND l.link_role = 'MENTIONED'))
       ORDER BY 1`);
    const fileIds = `{${files.map((f) => Number(f.id)).join(',')}}`;
    const versions = await q(`
      SELECT v.id, v.file_id, v.version_number, v.s3_key, v.s3_bucket, v.file_size, v.sha256_hash, v.change_description,
             v.is_current_version, v.created_at
        FROM document_versions v WHERE v.account_id = $1 AND v.file_id = ANY($2::int[]) ORDER BY v.file_id, v.version_number`,
      [accountId, fileIds]);
    const photos = await q(`
      SELECT p.id, p.file_id, p.display_order, p.is_primary, p.caption, p.created_at
        FROM asset_photos p JOIN asset_files f ON f.id = p.file_id AND f.account_id = $2
       WHERE p.asset_id = $1 ORDER BY p.is_primary DESC, p.display_order, p.id`);
    const rooms = await q(`SELECT row_to_json(s.*)::jsonb AS j FROM substructures s WHERE s.asset_id = $1 ORDER BY s.id`, [assetId]);
    const equipments = await q(`SELECT row_to_json(e.*)::jsonb AS j FROM equipments e WHERE e.asset_id = $1 ORDER BY e.id`, [assetId]);
    const operations = await q(`
      SELECT o.id, o.type_code, o.status, o.technical_label, o.provider, o.planned_date, o.start_date, o.realized_date, o.end_date,
             o.user_notes, o.invalidated_at, o.merged_into_operation_id, o.created_at, o.updated_at
        FROM business_operations o
       WHERE o.account_id = $2 AND (
             EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.active AND l.asset_id = $1)
          OR EXISTS (SELECT 1 FROM business_operation_equipment_links l WHERE l.operation_id = o.id AND l.active AND l.asset_id = $1)
          OR EXISTS (SELECT 1 FROM business_operation_room_links l WHERE l.operation_id = o.id AND l.active AND l.asset_id = $1)
          OR EXISTS (SELECT 1 FROM business_operation_financial_components c WHERE c.operation_id = o.id AND c.active
                      AND (c.target_asset_id = $1 OR c.target_equipment_id IN (SELECT id FROM equipments WHERE asset_id = $1))))
       ORDER BY o.id`);
    const opIds = `{${operations.map((o) => Number(o.id)).join(',')}}`;
    const allComponents = await q(`
      SELECT c.id, c.operation_id, c.kind, c.amount_minor, c.currency, c.amount_eur_cents, c.economic_date, c.period_start,
             c.period_end, c.target_asset_id, c.target_equipment_id, c.label, c.active
        FROM business_operation_financial_components c
       WHERE c.account_id = $1 AND c.operation_id = ANY($2::bigint[]) AND c.active ORDER BY c.operation_id, c.id`,
      [accountId, opIds]);
    const eqIds = new Set(equipments.map((e) => Number((e.j as Row).id)));
    const ceBien = (c: Row) => c.target_asset_id === null || Number(c.target_asset_id) === assetId
      || (c.target_equipment_id !== null && eqIds.has(Number(c.target_equipment_id)));
    const sources = await q(`
      SELECT s.id, s.operation_id, s.source_kind, s.source_entity_key, s.source_role, s.authority, s.created_at
        FROM business_operation_sources s WHERE s.account_id = $1 AND s.operation_id = ANY($2::bigint[]) AND s.active
       ORDER BY s.operation_id, s.id`, [accountId, opIds]);
    const operationLinks = await q(`
      SELECT l.operation_id, 'asset' AS target_type, l.asset_id AS target_id, l.link_role AS role
        FROM business_operation_asset_links l WHERE l.account_id = $2 AND l.operation_id = ANY($3::bigint[]) AND l.active AND l.asset_id = $1
      UNION ALL SELECT l.operation_id, 'equipment', l.equipment_id, NULL
        FROM business_operation_equipment_links l WHERE l.account_id = $2 AND l.operation_id = ANY($3::bigint[]) AND l.active AND l.asset_id = $1
      UNION ALL SELECT l.operation_id, 'room', l.substructure_id, NULL
        FROM business_operation_room_links l WHERE l.account_id = $2 AND l.operation_id = ANY($3::bigint[]) AND l.active AND l.asset_id = $1
      UNION ALL SELECT d.operation_id, 'document', d.file_id, NULL
        FROM business_operation_documents d WHERE d.account_id = $2 AND d.operation_id = ANY($3::bigint[]) AND d.active AND d.file_id = ANY($4::int[])
      ORDER BY 1, 2, 3`, [assetId, accountId, opIds, fileIds]);
    const agenda = await q(`
      SELECT i.id, i.title, i.description, i.start_date, i.start_time, i.end_date, i.end_time, i.event_nature, i.business_type,
             i.home_category, i.situation, i.business_operation_id, i.is_automatic, i.created_at
        FROM agenda_items i
       WHERE i.account_id = $2 AND (
             EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = i.id AND l.asset_id = $1)
          OR EXISTS (SELECT 1 FROM agenda_equipment_links l JOIN equipments e ON e.id = l.equipment_id WHERE l.agenda_item_id = i.id AND e.asset_id = $1)
          OR EXISTS (SELECT 1 FROM agenda_room_links l JOIN substructures s ON s.id = l.substructure_id WHERE l.agenda_item_id = i.id AND s.asset_id = $1)
          OR EXISTS (SELECT 1 FROM agenda_file_links l WHERE l.agenda_item_id = i.id AND l.asset_file_id = ANY($3::int[])))
       ORDER BY i.start_date NULLS LAST, i.id`, [assetId, accountId, fileIds]);
    const agIds = `{${agenda.map((a) => Number(a.id)).join(',')}}`;
    const agendaLinks = await q(`
      SELECT l.agenda_item_id, 'asset' AS target_type, l.asset_id AS target_id FROM agenda_asset_links l
       WHERE l.agenda_item_id = ANY($2::int[]) AND l.asset_id = $1
      UNION ALL SELECT l.agenda_item_id, 'equipment', l.equipment_id FROM agenda_equipment_links l JOIN equipments e ON e.id = l.equipment_id
       WHERE l.agenda_item_id = ANY($2::int[]) AND e.asset_id = $1
      UNION ALL SELECT l.agenda_item_id, 'room', l.substructure_id FROM agenda_room_links l JOIN substructures s ON s.id = l.substructure_id
       WHERE l.agenda_item_id = ANY($2::int[]) AND s.asset_id = $1
      UNION ALL SELECT l.agenda_item_id, 'document', l.asset_file_id FROM agenda_file_links l
       WHERE l.agenda_item_id = ANY($2::int[]) AND l.asset_file_id = ANY($3::int[])
      ORDER BY 1, 2, 3`, [assetId, agIds, fileIds]);
    const legacy = async (t: 'deadlines' | 'events') => q(`
      SELECT row_to_json(t.*)::jsonb AS j FROM ${t} t
       WHERE t.account_id = $2 AND (t.asset_id = $1 OR t.linked_asset_id = $1) ORDER BY t.id`);
    return {
      asset: asset.j as Row, files, excludedLinks, versions, photos,
      rooms: rooms.map((r) => r.j as Row), equipments: equipments.map((r) => r.j as Row),
      operations, components: allComponents.filter(ceBien), foreignComponents: allComponents.filter((c) => !ceBien(c)),
      sources, operationLinks, agenda, agendaLinks,
      deadlines: (await legacy('deadlines')).map((r) => r.j as Row), events: (await legacy('events')).map((r) => r.j as Row),
    };
  }) as Promise<Inventory | null>;
}

/**
 * Construit et VÉRIFIE l'archive complète. `readObject` lève si l'objet est
 * absent ou illisible (motif repris au manifeste). `extra` : fichiers texte
 * complémentaires (récapitulatif lisible, TCO).
 */
export async function buildCompleteAssetArchive(p: {
  accountId: number;
  assetId: number;
  readObject: StorageReader;
  recapTxt?: string | null;
  tco?: unknown;
  now?: Date;
}): Promise<CompleteArchiveResult> {
  const inv = await loadCompleteInventory(p.accountId, p.assetId);
  if (!inv) throw new CompleteArchiveError('ASSET_NOT_FOUND', `Bien ${p.assetId} introuvable dans le compte ${p.accountId}`);
  const now = p.now ?? new Date();
  const zip = new JSZip();
  const nommer = makeUniqueNamer();
  const files: ManifestFile[] = [];
  const missing: ManifestGap[] = [];
  const excluded: ManifestGap[] = [];
  const cats: CompleteArchiveManifest['categories'] = {};
  const cat = (name: string) => (cats[name] ??= { expected: 0, exported: 0, excluded: 0, missing: 0 });
  let total = 0;

  const ajouter = (path: string, data: Buffer, category: string, sourceId: number | null) => {
    total += data.length;
    if (total > MAX_BYTES()) {
      throw new CompleteArchiveError('ARCHIVE_TOO_LARGE', `Archive au-delà de ${MAX_BYTES()} octets : génération interrompue, aucun ZIP partiel.`);
    }
    zip.file(path, data, { binary: true, createFolders: false });
    files.push({ path, size: data.length, sha256: sha256(data), category, sourceId });
  };
  const binaire = async (category: string, id: number, key: unknown, bucket: unknown, expectedSha: unknown): Promise<Buffer | null> => {
    cat(category).expected++;
    if (typeof key !== 'string' || !key || key === 'temp') {
      missing.push({ category, id, motif: 'OBJET_SANS_CLE' });
      cat(category).missing++;
      return null;
    }
    let buf: Buffer;
    try {
      buf = await p.readObject(key, typeof bucket === 'string' && bucket ? bucket : null);
    } catch (e) {
      missing.push({ category, id, motif: 'OBJET_ILLISIBLE', detail: (e as Error).message?.slice(0, 200) });
      cat(category).missing++;
      return null;
    }
    if (typeof expectedSha === 'string' && /^[0-9a-f]{64}$/i.test(expectedSha) && sha256(buf) !== expectedSha.toLowerCase()) {
      missing.push({ category, id, motif: 'EMPREINTE_DIFFERENTE' });
      cat(category).missing++;
      return null;
    }
    cat(category).exported++;
    return buf;
  };

  // ── Fichiers : documents (versions courantes), versions conservées, photos ──
  const docs = inv.files.filter((f) => f.is_photo !== true);
  const webLinks = docs.filter((f) => f.is_web_link === true);
  const docPath = new Map<number, string>();
  for (const f of docs.filter((d) => d.is_web_link !== true)) {
    const id = Number(f.id);
    const buf = await binaire('documents', id, f.s3_key, f.s3_bucket, f.sha256_hash);
    if (!buf) continue;
    const nom = downloadFilename({
      retainedTitle: f.retained_title as string | null, originalFilename: f.original_filename as string | null,
      filename: f.filename as string | null, mimeType: f.mime_type as string | null,
    });
    const path = nommer(nom, `documents/${segment(f.document_type as string | null, 'AUTRE')}`);
    docPath.set(id, path);
    ajouter(path, buf, 'documents', id);
  }
  const versionsConservees = inv.versions.filter((v) => {
    const f = inv.files.find((x) => Number(x.id) === Number(v.file_id));
    return v.is_current_version !== true && (!f || v.s3_key !== f.s3_key);
  });
  for (const v of versionsConservees) {
    const id = Number(v.id);
    const buf = await binaire('versions', id, v.s3_key, v.s3_bucket, v.sha256_hash);
    if (!buf) continue;
    const f = inv.files.find((x) => Number(x.id) === Number(v.file_id));
    const nomDoc = f ? downloadFilename({
      retainedTitle: f.retained_title as string | null, originalFilename: f.original_filename as string | null,
      filename: f.filename as string | null, mimeType: f.mime_type as string | null,
    }) : `document_${v.file_id}`;
    const point = nomDoc.lastIndexOf('.');
    const nomVersion = point > 0 ? `${nomDoc.slice(0, point)} (v${v.version_number})${nomDoc.slice(point)}` : `${nomDoc} (v${v.version_number})`;
    ajouter(nommer(nomVersion, `documents/versions/${v.file_id}`), buf, 'versions', id);
  }
  const photoFiles = new Map(inv.files.filter((f) => f.is_photo === true).map((f) => [Number(f.id), f]));
  let rang = 1;
  for (const ph of inv.photos) {
    const f = photoFiles.get(Number(ph.file_id));
    const id = Number(ph.id);
    if (!f) {
      cat('photos').expected++;
      missing.push({ category: 'photos', id, motif: 'FICHIER_PHOTO_ABSENT' });
      cat('photos').missing++;
      continue;
    }
    const buf = await binaire('photos', id, f.s3_key, f.s3_bucket, f.sha256_hash);
    if (!buf) continue;
    const ext = downloadFilename({ originalFilename: f.original_filename as string | null, mimeType: f.mime_type as string | null }).split('.').pop();
    ajouter(nommer(`photo_${rang++}${ph.is_primary ? '_principale' : ''}${ext ? `.${ext}` : ''}`, 'photos'), buf, 'photos', id);
  }
  for (const l of inv.excludedLinks) {
    excluded.push({ category: 'documents', id: Number(l.id), motif: l.status === 'PROPOSED' ? 'RATTACHEMENT_PROPOSE_NON_CONFIRME' : 'DOCUMENT_SEULEMENT_MENTIONNE' });
    cat('documents').excluded++;
  }
  for (const c of inv.foreignComponents) {
    excluded.push({ category: 'depenses', id: Number(c.id), motif: 'VENTILATION_D_UN_AUTRE_BIEN' });
    cat('depenses').excluded++;
  }

  // ── Données structurées (CSV UTF-8 + JSON), identifiants locaux stables ──
  const texte = (path: string, contenu: string, category = 'donnees') => ajouter(path, Buffer.from(contenu, 'utf8'), category, null);
  const asset = sansSecrets(inv.asset);
  let kc: unknown = asset.key_characteristics;
  if (typeof kc === 'string') { try { kc = JSON.parse(kc); } catch { /* texte brut conservé */ } }
  texte('donnees/bien.json', JSON.stringify({ ...asset, key_characteristics: kc }, null, 2));
  const docCols = ['id', 'relation', 'titre', 'nom_original', 'type', 'rubrique', 'date_document', 'description', 'notes', 'fournisseur', 'montant_centimes', 'mime', 'taille', 'sha256', 'equipement_id', 'piece_id', 'chemin_archive', 'ajoute_le'];
  const docLines = docs.filter((d) => d.is_web_link !== true).map((d) => ({
    id: d.id, relation: d.relation, titre: d.retained_title, nom_original: d.original_filename, type: d.document_type ?? d.document_type_code,
    rubrique: d.rubric_code, date_document: iso(d.document_date), description: d.description, notes: d.notes, fournisseur: d.supplier,
    montant_centimes: d.amount_cents, mime: d.mime_type, taille: d.size, sha256: d.sha256_hash, equipement_id: d.equipment_id,
    piece_id: d.substructure_id, chemin_archive: docPath.get(Number(d.id)) ?? null, ajoute_le: iso(d.uploaded_at ?? d.created_at),
  }));
  texte('donnees/documents.csv', toCsv(docCols, docLines));
  texte('donnees/documents.json', JSON.stringify(docLines, null, 2));
  cat('liens_web').expected += webLinks.length;
  cat('liens_web').exported += webLinks.length;
  texte('donnees/liens_web.csv', toCsv(['id', 'titre', 'url', 'type', 'ajoute_le'], webLinks.map((w) => ({
    id: w.id, titre: w.web_link_title ?? w.retained_title, url: w.web_link_url, type: w.document_type, ajoute_le: iso(w.created_at),
  }))));
  texte('donnees/versions.csv', toCsv(['id', 'document_id', 'numero', 'courante', 'taille', 'sha256', 'description', 'creee_le'], inv.versions.map((v) => ({
    id: v.id, document_id: v.file_id, numero: v.version_number, courante: v.is_current_version, taille: v.file_size, sha256: v.sha256_hash,
    description: v.change_description, creee_le: iso(v.created_at),
  }))));
  texte('donnees/photos.csv', toCsv(['id', 'document_id', 'ordre', 'principale', 'legende'], inv.photos.map((ph) => ({
    id: ph.id, document_id: ph.file_id, ordre: ph.display_order, principale: ph.is_primary, legende: ph.caption,
  }))));
  texte('donnees/pieces.json', JSON.stringify(inv.rooms.map(sansSecrets), null, 2));
  texte('donnees/equipements.json', JSON.stringify(inv.equipments.map(sansSecrets), null, 2));
  cat('pieces').expected = cat('pieces').exported = inv.rooms.length;
  cat('equipements').expected = cat('equipements').exported = inv.equipments.length;
  texte('donnees/operations.csv', toCsv(
    ['id', 'type', 'statut', 'libelle', 'prestataire', 'date_prevue', 'date_debut', 'date_realisee', 'date_fin', 'notes', 'invalidee_le', 'fusionnee_dans', 'creee_le'],
    inv.operations.map((o) => ({
      id: o.id, type: o.type_code, statut: o.status, libelle: o.technical_label, prestataire: o.provider, date_prevue: iso(o.planned_date),
      date_debut: iso(o.start_date), notes: o.user_notes, date_realisee: iso(o.realized_date), date_fin: iso(o.end_date), invalidee_le: iso(o.invalidated_at), fusionnee_dans: o.merged_into_operation_id,
      creee_le: iso(o.created_at),
    }))));
  cat('operations').expected = cat('operations').exported = inv.operations.length;
  const depenses = inv.components.map((c) => ({
    id: c.id, operation_id: c.operation_id, nature: c.kind, montant_minor: c.amount_minor, devise: c.currency, montant_eur_centimes: c.amount_eur_cents,
    date_economique: iso(c.economic_date), periode_debut: iso(c.period_start), periode_fin: iso(c.period_end),
    bien_vise: c.target_asset_id, equipement_vise: c.target_equipment_id, libelle: c.label,
  }));
  texte('donnees/depenses.csv', toCsv(['id', 'operation_id', 'nature', 'montant_minor', 'devise', 'montant_eur_centimes', 'date_economique', 'periode_debut', 'periode_fin', 'bien_vise', 'equipement_vise', 'libelle'], depenses));
  cat('depenses').expected += depenses.length;
  cat('depenses').exported += depenses.length;
  texte('donnees/preuves_operations.csv', toCsv(['id', 'operation_id', 'nature_source', 'cle_source', 'role', 'autorite', 'ajoutee_le'], inv.sources.map((s) => ({
    id: s.id, operation_id: s.operation_id, nature_source: s.source_kind, cle_source: s.source_entity_key, role: s.source_role,
    autorite: s.authority, ajoutee_le: iso(s.created_at),
  }))));
  texte('donnees/agenda.csv', toCsv(
    ['id', 'titre', 'description', 'date_debut', 'heure_debut', 'date_fin', 'heure_fin', 'nature', 'type_metier', 'categorie', 'situation', 'operation_id', 'automatique', 'cree_le'],
    inv.agenda.map((a) => ({
      id: a.id, titre: a.title, description: a.description, date_debut: iso(a.start_date), heure_debut: a.start_time, date_fin: iso(a.end_date),
      heure_fin: a.end_time, nature: a.event_nature, type_metier: a.business_type, categorie: a.home_category, situation: a.situation,
      operation_id: a.business_operation_id, automatique: a.is_automatic, cree_le: iso(a.created_at),
    }))));
  cat('agenda').expected = cat('agenda').exported = inv.agenda.length;
  texte('donnees/echeances_historiques.json', JSON.stringify(inv.deadlines.map(sansSecrets), null, 2));
  texte('donnees/evenements_historiques.json', JSON.stringify(inv.events.map(sansSecrets), null, 2));
  // Relations bien ↔ document ↔ opération ↔ dépense ↔ événement ↔ équipement.
  const relations: Row[] = [
    ...docs.map((d) => ({ de_type: 'bien', de_id: p.assetId, vers_type: d.is_web_link ? 'lien_web' : 'document', vers_id: d.id, role: d.relation })),
    ...docs.filter((d) => d.equipment_id).map((d) => ({ de_type: 'equipement', de_id: d.equipment_id, vers_type: 'document', vers_id: d.id, role: null })),
    ...docs.filter((d) => d.substructure_id).map((d) => ({ de_type: 'piece', de_id: d.substructure_id, vers_type: 'document', vers_id: d.id, role: null })),
    ...inv.photos.map((ph) => ({ de_type: 'bien', de_id: p.assetId, vers_type: 'photo', vers_id: ph.id, role: ph.is_primary ? 'PRINCIPALE' : null })),
    ...inv.operationLinks.map((l) => ({ de_type: 'operation', de_id: l.operation_id, vers_type: l.target_type, vers_id: l.target_id, role: l.role })),
    ...inv.components.map((c) => ({ de_type: 'operation', de_id: c.operation_id, vers_type: 'depense', vers_id: c.id, role: c.kind })),
    ...inv.sources.filter((s) => s.source_kind === 'DOCUMENT').map((s) => ({ de_type: 'operation', de_id: s.operation_id, vers_type: 'document_source', vers_id: s.source_entity_key, role: s.source_role })),
    ...inv.agendaLinks.map((l) => ({ de_type: 'agenda', de_id: l.agenda_item_id, vers_type: l.target_type, vers_id: l.target_id, role: null })),
    ...inv.agenda.filter((a) => a.business_operation_id).map((a) => ({ de_type: 'agenda', de_id: a.id, vers_type: 'operation', vers_id: a.business_operation_id, role: 'PROJECTION' })),
  ];
  texte('donnees/relations.csv', toCsv(['de_type', 'de_id', 'vers_type', 'vers_id', 'role'], relations));
  const notApplicable: string[] = [];
  if (p.tco !== undefined && p.tco !== null) texte('donnees/tco.json', JSON.stringify(p.tco, null, 2));
  else notApplicable.push('TCO : non calculé pour ce bien (aucune donnée exploitable)');
  if (!inv.operations.length) notApplicable.push('Opérations : aucune Opération ne vise ce bien');
  if (!webLinks.length) notApplicable.push('Liens web : aucun');
  if (p.recapTxt) texte('recap_donnees.txt', p.recapTxt);

  const status: CompleteArchiveManifest['status'] = missing.length ? 'INCOMPLETE' : 'COMPLETE';
  texte('LISEZMOI.txt', [
    'ARCHIVE COMPLÈTE DU BIEN — VEREBONA',
    '',
    `Bien : ${String(inv.asset.name ?? '')} (identifiant ${p.assetId})`,
    `Générée le : ${now.toISOString()}`,
    `État : ${status === 'COMPLETE' ? 'COMPLÈTE — tous les éléments attendus sont présents' : 'INCOMPLÈTE — voir manifest.json (manquants)'}`,
    '',
    'Contenu :',
    '  documents/<type>/…       documents originaux (version courante)',
    '  documents/versions/…     versions antérieures conservées',
    '  photos/…                 photos du bien',
    '  donnees/*.csv, *.json    fiche, documents, versions, photos, pièces, équipements, Opérations,',
    '                           dépenses, preuves, Agenda, échéances et événements, relations, TCO',
    '  manifest.json            inventaire : attendus / exportés / exclus / manquants, tailles et SHA-256',
    '',
    'Les CSV sont en UTF-8 (séparateur « ; »), montants en unités mineures (centimes) avec leur devise,',
    'dates au format ISO 8601. Les liens web sont exportés comme adresses (URL) : le contenu du site',
    'externe n\'est pas copié.',
    'Cette archive est une copie consultable : elle ne peut pas être réimportée automatiquement (V1).',
    '',
  ].join('\n'));

  const manifest: CompleteArchiveManifest = {
    format: COMPLETE_ARCHIVE_VERSION, generatedAt: now.toISOString(),
    asset: { id: p.assetId, name: String(inv.asset.name ?? '') },
    status, categories: cats, files: [...files], excluded, missing, notApplicable,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  if (status === 'INCOMPLETE') return { status, buffer: null, sha256: null, manifest };

  const buffer = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  // Relecture de l'archive : chaque entrée du manifeste présente, taille et empreinte identiques.
  const relue = await JSZip.loadAsync(buffer);
  const entrees = Object.values(relue.files).filter((f) => !f.dir).map((f) => f.name);
  if (entrees.length !== files.length + 1) {
    throw new CompleteArchiveError('ARCHIVE_VERIFICATION_FAILED', `Archive relue : ${entrees.length} entrées pour ${files.length + 1} attendues.`);
  }
  for (const f of files) {
    const e = relue.file(f.path);
    const data = e ? await e.async('nodebuffer') : null;
    if (!data || data.length !== f.size || sha256(data) !== f.sha256) {
      throw new CompleteArchiveError('ARCHIVE_VERIFICATION_FAILED', `Archive relue : entrée « ${f.path} » absente ou altérée.`);
    }
  }
  return { status, buffer, sha256: sha256(buffer), manifest };
}
