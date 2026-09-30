/**
 * Source canonique des dossiers V12 — CDC 15 X-02 (P0), §12, §14 point 8,
 * T3-05 ; plan lot 16 volet B. Commutateur `EXPORTS_CANONICAL_SOURCE`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI CHANGE PAR RAPPORT À LA LECTURE HISTORIQUE (`source.ts`)
 *
 * 1. Champs du bien : lus par `CanonicalAssetView` (clé du registre, puis
 *    alias, puis colonne miroir — D-10), et non plus « colonne d'abord,
 *    `keyCharacteristics` à côté ». Unités du registre : montants en EUROS
 *    (`acquisitionPrice`) ; seul le champ d'export `purchasePriceCents`
 *    reste en centimes, par conversion exacte. Les informations
 *    complémentaires (D-12) restent lues comme aujourd'hui, hors registre.
 *
 * 2. Documents du bien : relation N-N `document_asset_links`
 *    (`listAssetDocuments`, rôles PRIMARY et SECONDARY, toutes origines
 *    ACTIVES : LEGACY_COLUMN, USER, MIGRATION, AI acceptée), et en REPLI les
 *    colonnes historiques `asset_id` / `linked_asset_id` / `linked_room_id` /
 *    `equipment_id` pour un document qui n'a encore AUCUNE ligne de lien
 *    (rattrapage §14.8 non passé). Un document dont le lien a été retiré
 *    (REMOVED, REJECTED) n'est donc pas repêché par sa colonne. Le chemin
 *    `substructure_id` (sous-structure), que la relation N-N ne modélise
 *    pas, est conservé tel quel.
 *
 *    RATTACHEMENTS NON CONFIRMÉS (relecture lot 16) : il n'existe AUCUNE
 *    notion de lien « confirmé » dans `document_asset_links` (statuts
 *    ACTIVE / PROPOSED / REJECTED / REMOVED, origines USER / AI / MIGRATION /
 *    LEGACY_COLUMN, sans date ni auteur de validation), ni sur les colonnes
 *    `linked_asset_id` / `linked_room_id` (écrites aussi par la validation
 *    des propositions IA, `commit-engine`). Règle retenue pour tout envoi à
 *    un tiers (`isConfirmedAttachment`) :
 *      · CONFIRMÉ : colonne `asset_id`, équipement ou sous-structure du bien
 *        (chemins déjà exportés en legacy), lien PRIMARY hors colonnes
 *        croisées, lien d'origine USER ou MIGRATION ;
 *      · NON CONFIRMÉ : lien SECONDARY d'origine AI, lien reflétant
 *        `linked_asset_id` / `linked_room_id`, repli sur ces colonnes.
 *    Un document non confirmé est PROPOSÉ DÉCOCHÉ dans la préparation V12
 *    (l'utilisateur le voit et choisit) ; il est EXCLU de la transmission,
 *    de l'export brut et de l'aperçu admin, qui n'ont pas d'étape de choix.
 *
 *    MENTIONED exclus par défaut : un document qui ne fait que CITER le bien
 *    appartient à un autre bien (facture multi-lignes, contrat d'un autre
 *    bien…). Le CDC Exports V12 centre chaque dossier sur UN bien (EXC-004),
 *    et sa matrice de pré-sélection (§6.2) PRÉ-COCHE les documents non
 *    sensibles intégrables (« Oui si clés », CIL, assurance) : un document
 *    mentionné serait joint d'office à un dossier remis à un tiers, alors
 *    que l'inclusion d'un élément non propre au bien doit rester une action
 *    explicite (définition « Élément sensible », SEL-GEN-007). Option
 *    `includeMentioned` pour un usage futur explicite.
 *
 * 3. Agenda : nature HISTORICAL / DEADLINE (D-14, `resolveEventSemantics`)
 *    et statut à 4 états (lot 14) portés par chaque événement ; les règles de
 *    `choices.ts` en tiennent compte (jamais d'échéance à venir tirée d'un
 *    fait historique ; une échéance passée non prouvée n'est pas présentée
 *    comme réalisée).
 *
 * 4. Traçabilité : le snapshot garde la source réellement utilisée et la
 *    version du registre (`sourceTrace`).
 *
 * Mode `shadow` : la version historique est construite ET utilisée ; la
 * version canonique est calculée en plus (4 requêtes, aucun rendu), puis
 * comparée : rapport d'écarts STRUCTURÉ, journalisé, SANS AUCUNE VALEUR —
 * noms de champs, identifiants de pièces et d'événements seulement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { getRolloutMode, type RolloutMode } from '@/services/canonical/rollout';
import { buildCanonicalAssetState, loadAssetRow, isEmptyValue, parseKc, type AssetRowJson, type CanonicalAssetState } from '@/services/canonical/asset-state';
import { isMetaKey } from '@/services/canonical/asset-state/canonical-asset-view';
import { REGISTRY_VERSION, eurToCents, getField, resolveAlias, type AssetFamily } from '@/services/canonical/registry';
import { listAssetDocuments, type LinkRole } from '@/services/documents/document-asset-links';
import { resolveEventSemantics } from '@/services/agenda/agenda-functional-key';
import { agendaFunctionalColumnsReady } from '@/services/agenda/agenda-columns';
import { agendaStatus4, type AgendaStatus4 } from '@/services/verebona-assistant/canonical/agenda';
import type { DocumentRef } from '@/services/export-snapshot.service';

/** Mode du commutateur (lu à chaque appel). */
export function exportsSourceMode(env: Record<string, string | undefined> = process.env): RolloutMode {
  return getRolloutMode('EXPORTS_CANONICAL_SOURCE', env);
}

// ── Champs du bien ──────────────────────────────────────────────────────────

/** Sous-ensemble scalaire de `ExportSource.asset` lu depuis la vue canonique. */
export interface CanonicalAssetScalars {
  purchaseDate: string | null;
  purchasePriceCents: number | null;
  warrantyEndDate: string | null;
  mileageOrHours: number | null;
  registrationNumber: string | null;
  dimensions: string | null;
  engineInfo: string | null;
  purchaseLocation: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  generalCondition: string | null;
  objectCategory: string | null;
  description: string | null;
}

/**
 * Champ d'export → clé canonique, PAR FAMILLE. Une clé absente de la famille
 * (ex. `mileage` pour un objet) laisse la valeur historique : la vue
 * canonique n'en dit rien (colonne hors registre pour cette famille).
 */
const SCALAR_KEYS: Record<keyof CanonicalAssetScalars, Partial<Record<AssetFamily, string>> | string> = {
  purchaseDate: 'acquisitionDate',
  purchasePriceCents: 'acquisitionPrice',
  warrantyEndDate: 'warrantyEndDate',
  mileageOrHours: { VEHICULE: 'mileage' },
  registrationNumber: { VEHICULE: 'registrationNumber' },
  dimensions: { OBJECT: 'dimensions' },
  engineInfo: { VEHICULE: 'engine' },
  purchaseLocation: 'acquisitionLocation',
  address: { IMMOBILIER: 'address1' },
  postalCode: { IMMOBILIER: 'postalCode' },
  city: { IMMOBILIER: 'city' },
  generalCondition: { IMMOBILIER: 'generalCondition', OBJECT: 'condition' },
  objectCategory: { OBJECT: 'objectCategory' },
  description: 'description',
};

const iso = (v: unknown): string | null => (isEmptyValue(v) ? null : String(v).slice(0, 10));
const text = (v: unknown): string | null => (isEmptyValue(v) ? null : String(v));
const int = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return isEmptyValue(v) || !Number.isFinite(n) ? null : Math.round(n);
};
/** Euros (unité du registre) → centimes, exacte ; null si non convertible. */
const cents = (v: unknown): number | null => {
  if (isEmptyValue(v)) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  try { return eurToCents(n); } catch { return Math.round(n * 100); }
};

/**
 * Champs scalaires du bien lus dans la vue canonique (pure, testée).
 * `legacy` : valeurs historiques, gardées pour un champ sans clé dans la
 * famille du bien.
 */
export function canonicalAssetScalars(state: CanonicalAssetState, legacy: CanonicalAssetScalars): CanonicalAssetScalars {
  const out = { ...legacy };
  for (const [champ, cles] of Object.entries(SCALAR_KEYS) as Array<[keyof CanonicalAssetScalars, Partial<Record<AssetFamily, string>> | string]>) {
    const cle = typeof cles === 'string' ? cles : cles[state.family];
    if (!cle || !getField(cle)?.families.includes(state.family)) continue;
    const v = state.fields[cle]?.value;
    switch (champ) {
      case 'purchaseDate': case 'warrantyEndDate': out[champ] = iso(v); break;
      case 'purchasePriceCents': out[champ] = cents(v); break;
      case 'mileageOrHours': out[champ] = int(v); break;
      default: (out as Record<string, unknown>)[champ] = text(v);
    }
  }
  return out;
}

/**
 * Caractéristiques canoniques (pure, testée) : les valeurs de la vue
 * canonique sous leur CLÉ du registre, plus les clés libres de la fiche
 * (hors registre pour la famille). Retirées : clés techniques
 * (`x__origin`…), alias d'une clé canonique de la famille (la valeur est
 * sous la clé canonique). Le filtre des clés interdites (estimation,
 * occupation) est appliqué par l'appelant (`cleanCharacteristics`).
 */
export function canonicalCharacteristics(row: AssetRowJson, state: CanonicalAssetState): Record<string, unknown> {
  const kc = parseKc(row.key_characteristics);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(kc)) {
    if (isMetaKey(k)) continue;
    if (getField(k)?.families.includes(state.family)) continue; // clé canonique : remplacée ci-dessous
    const alias = resolveAlias(k, state.family);
    if (alias && getField(alias)?.families.includes(state.family)) continue; // alias : lu sous sa clé
    out[k] = v;
  }
  for (const [k, f] of Object.entries(state.fields)) out[k] = f.value;
  return out;
}

// ── Documents du bien ───────────────────────────────────────────────────────

/** Chemin par lequel un document est rattaché au bien (traçabilité). */
export type DocumentPath =
  | 'link:PRIMARY' | 'link:SECONDARY' | 'link:MENTIONED'
  | 'column:asset_id' | 'column:linked_asset_id' | 'column:linked_room_id' | 'column:equipment_id'
  | 'column:substructure_id';

/** Lien ACTIF d'un document vers le bien (ou l'une de ses pièces / équipements). */
export interface AttachmentLink {
  role: LinkRole;
  origin: 'USER' | 'AI' | 'MIGRATION' | 'LEGACY_COLUMN';
  roomId: number | null;
  equipmentId: number | null;
}

/**
 * Rattachement confirmé (pure, testée) — voir l'en-tête. `links` : liens
 * ACTIFS du document vers ce bien (toutes cibles du bien).
 */
export function isConfirmedAttachment(
  d: Pick<CanonicalDocumentRow, 'assetId' | 'equipmentId' | 'substructureId'>,
  links: AttachmentLink[],
  ctx: { assetId: number; substructureIds: Set<number>; equipmentIds: Set<number> },
): boolean {
  if (d.assetId === ctx.assetId) return true;
  if (d.substructureId != null && ctx.substructureIds.has(d.substructureId)) return true;
  if (d.equipmentId != null && ctx.equipmentIds.has(d.equipmentId)) return true;
  return links.some((l) => {
    if (l.origin === 'USER' || l.origin === 'MIGRATION') return true;
    // Lien tenu depuis equipment_id (équipement du bien, archivé compris — arbitrage lot 16).
    if (l.origin === 'LEGACY_COLUMN') return l.equipmentId != null;
    // AI : PRIMARY seulement ; un lien de pièce reste secondaire par nature.
    return l.role === 'PRIMARY' && l.roomId == null;
  });
}

export interface CanonicalDocumentRow extends DocumentRef {
  assetId: number | null;
  linkedAssetId: number | null;
  linkedRoomId: number | null;
  /** Le document a au moins une ligne dans `document_asset_links` (toute cible, tout statut). */
  hasLinkRows: boolean;
}

/**
 * Chemins d'un document vers le bien (pure, testée). Les colonnes
 * `asset_id` / `linked_asset_id` / `linked_room_id` / `equipment_id` ne
 * comptent qu'en REPLI (aucune ligne de lien) ; `substructure_id` toujours.
 */
export function documentPaths(
  d: CanonicalDocumentRow,
  ctx: { assetId: number; links: Map<number, LinkRole>; roomIds: Set<number>; equipmentIds: Set<number>; substructureIds: Set<number> },
): DocumentPath[] {
  const p: DocumentPath[] = [];
  const role = ctx.links.get(d.id);
  if (role) p.push(`link:${role}`);
  if (!d.hasLinkRows) {
    if (d.assetId === ctx.assetId) p.push('column:asset_id');
    if (d.linkedAssetId === ctx.assetId) p.push('column:linked_asset_id');
    if (d.linkedRoomId != null && ctx.roomIds.has(d.linkedRoomId)) p.push('column:linked_room_id');
    if (d.equipmentId != null && ctx.equipmentIds.has(d.equipmentId)) p.push('column:equipment_id');
  }
  if (d.substructureId != null && ctx.substructureIds.has(d.substructureId)) p.push('column:substructure_id');
  return p;
}

const DOC_COLUMNS = `
  f.id, f.s3_key AS "s3Key", f.s3_bucket AS "s3Bucket", f.original_filename AS "originalFilename",
  f.document_type AS "documentType", f.document_date::text AS "documentDate", f.description,
  f.retained_title AS "retainedTitle", f.retained_function_code AS "retainedFunctionCode",
  f.cil_rubric_codes AS "cilRubricCodes", f.mime_type AS "mimeType", f.size, f.is_web_link AS "isWebLink",
  f.web_link_url AS "webLinkUrl", f.web_link_title AS "webLinkTitle", f.substructure_id AS "substructureId",
  f.equipment_id AS "equipmentId", f.document_type_code AS "documentTypeCode", f.supplier, f.amount_cents AS "amountCents",
  f.asset_id AS "assetId", f.linked_asset_id AS "linkedAssetId", f.linked_room_id AS "linkedRoomId",
  EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id) AS "hasLinkRows"`;

/**
 * Documents du bien par la relation canonique (voir l'en-tête), mêmes
 * exclusions que l'historique (supprimé, brouillon, ignoré, téléversement
 * inachevé). Rend les documents et, par document, ses chemins.
 */
export async function loadCanonicalDocuments(
  accountId: number,
  assetId: number,
  opts: { includeMentioned?: boolean } = {},
): Promise<{ documents: DocumentRef[]; paths: Record<number, DocumentPath[]>; unconfirmed: number[] }> {
  const roles: LinkRole[] = opts.includeMentioned ? ['PRIMARY', 'SECONDARY', 'MENTIONED'] : ['PRIMARY', 'SECONDARY'];
  const liens = await listAssetDocuments(accountId, assetId, { roles });
  const links = new Map(liens.map((l) => [l.fileId, l.linkRole]));
  const [cibles] = (await pgClient.unsafe(
    `SELECT coalesce((SELECT array_agg(id) FROM rooms WHERE asset_id = $1 AND account_id = $2), '{}') AS rooms,
            coalesce((SELECT array_agg(id) FROM equipments WHERE asset_id = $1 AND archived_at IS NULL), '{}') AS equipments,
            coalesce((SELECT array_agg(id) FROM substructures WHERE asset_id = $1), '{}') AS subs,
            coalesce((SELECT array_agg(id) FROM equipments WHERE asset_id = $1), '{}') AS "allEquipments"`,
    [assetId, accountId] as never[],
  )) as unknown as Array<{ rooms: number[]; equipments: number[]; subs: number[]; allEquipments: number[] }>;
  const roomIds = new Set((cibles?.rooms ?? []).map(Number));
  const equipmentIds = new Set((cibles?.equipments ?? []).map(Number));
  const substructureIds = new Set((cibles?.subs ?? []).map(Number));
  const rows = (await pgClient.unsafe(
    `SELECT ${DOC_COLUMNS}
       FROM asset_files f
      WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.is_draft = false AND f.is_ignored = false
        AND (f.upload_status = 'COMPLETED' OR f.upload_status IS NULL)
        AND (f.id = ANY($3::int[])
             OR f.asset_id = $2 OR f.linked_asset_id = $2
             OR f.linked_room_id = ANY($4::int[]) OR f.equipment_id = ANY($5::int[]) OR f.substructure_id = ANY($6::int[]))
      ORDER BY f.id`,
    [accountId, assetId, [...links.keys()], [...roomIds], [...equipmentIds], [...substructureIds]] as never[],
  )) as unknown as CanonicalDocumentRow[];
  // Origine et cible de chaque lien actif (règle de confirmation).
  const detail = (await pgClient.unsafe(
    `SELECT file_id AS "fileId", link_role AS role, origin, room_id AS "roomId", equipment_id AS "equipmentId"
       FROM document_asset_links
      WHERE account_id = $1 AND asset_id = $2 AND status = 'ACTIVE' AND link_role = ANY($3::text[]) AND file_id = ANY($4::int[])`,
    [accountId, assetId, roles, [...links.keys()]] as never[],
  )) as unknown as Array<AttachmentLink & { fileId: number }>;
  const liensParDoc = new Map<number, AttachmentLink[]>();
  for (const l of detail) liensParDoc.set(Number(l.fileId), [...(liensParDoc.get(Number(l.fileId)) ?? []), l]);
  const tousEquipements = new Set((cibles?.allEquipments ?? []).map(Number));

  const documents: DocumentRef[] = [];
  const paths: Record<number, DocumentPath[]> = {};
  const unconfirmed: number[] = [];
  for (const r of rows) {
    const d = { ...r, id: Number(r.id) };
    const p = documentPaths(d, { assetId, links, roomIds, equipmentIds, substructureIds });
    if (!p.length) continue;
    paths[d.id] = p;
    if (!isConfirmedAttachment(d, liensParDoc.get(d.id) ?? [], { assetId, substructureIds, equipmentIds: tousEquipements })) unconfirmed.push(d.id);
    const { assetId: _a, linkedAssetId: _l, linkedRoomId: _r, hasLinkRows: _h, ...ref } = d;
    documents.push(ref as DocumentRef);
  }
  return { documents, paths, unconfirmed };
}

// ── Agenda ──────────────────────────────────────────────────────────────────

export interface CanonicalAgendaRow {
  id: number;
  title: string;
  description: string | null;
  startDate: string | null;
  manualStatus: string | null;
  occurrenceNature: string | null;
  nature: 'HISTORICAL' | 'DEADLINE' | null;
  status4: AgendaStatus4;
}

/** Agenda du bien avec nature (D-14) et statut à 4 états (T4-12). */
export async function loadCanonicalAgenda(accountId: number, assetId: number, today: string): Promise<CanonicalAgendaRow[]> {
  const col = await agendaFunctionalColumnsReady().catch(() => false);
  const rows = (await pgClient.unsafe(
    `SELECT i.id, i.title, i.description, to_char(i.start_date, 'YYYY-MM-DD') AS "startDate", i.manual_status AS "manualStatus",
            i.occurrence_nature AS "occurrenceNature", i.origin_field_key AS "originFieldKey",
            ${col ? 'i.event_nature' : 'NULL::text'} AS "eventNature", ${col ? 'i.business_type' : 'NULL::text'} AS "businessType",
            EXISTS (SELECT 1 FROM to_process_actions t WHERE t.account_id = i.account_id AND t.target_type = 'AGENDA_ITEM'
                     AND t.target_id = i.id AND t.field_key = 'manualStatus' AND t.resolved_at IS NULL) AS "pendingCard"
       FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id
      WHERE l.asset_id = $1 AND i.account_id = $2
      ORDER BY i.id`,
    [assetId, accountId] as never[],
  )) as unknown as Array<{
    id: number; title: string; description: string | null; startDate: string | null; manualStatus: string | null;
    occurrenceNature: string | null; originFieldKey: string | null; eventNature: string | null; businessType: string | null; pendingCard: boolean;
  }>;
  return rows.map((r) => {
    const sem = resolveEventSemantics({ originFieldKey: r.originFieldKey, businessType: r.businessType });
    return {
      id: Number(r.id), title: r.title, description: r.description, startDate: r.startDate,
      manualStatus: r.manualStatus || null, occurrenceNature: r.occurrenceNature,
      nature: (r.eventNature as CanonicalAgendaRow['nature']) ?? sem.nature,
      status4: agendaStatus4(r.manualStatus || null, !!r.pendingCard, r.startDate, today),
    };
  });
}

// ── Traçabilité et rapport d'écarts ─────────────────────────────────────────

/** Rapport d'écarts historique ↔ canonique — SANS AUCUNE VALEUR. */
export interface ExportSourceDiff {
  /** Champs dont la valeur diffère (noms seulement ; `asset.x` ou `characteristics.x`). */
  fields: string[];
  documents: {
    /** Pièces de la version historique absentes de la canonique. */
    onlyLegacy: number[];
    /** Pièces de la version canonique absentes de l'historique, avec leur chemin. */
    onlyCanonical: Array<{ id: number; paths: DocumentPath[]; confirmed: boolean }>;
    /**
     * « Ajoutés en canonique » : pièces absentes de l'historique, par
     * confirmation du rattachement. Les non confirmées ne partent jamais
     * sans choix explicite (proposées décochées, ou exclues sans étape de choix).
     */
    addedInCanonical: { confirmed: number; unconfirmed: number };
  };
  /** Événements classés différemment (historique / échéance / aucun). */
  events: Array<{ key: string; legacy: EventBucket; canonical: EventBucket }>;
  total: number;
}

export type EventBucket = 'history' | 'deadline' | null;

/** Trace de la source d'un dossier, figée dans le snapshot. */
export interface ExportSourceTrace {
  mode: RolloutMode;
  /** Source réellement utilisée pour les données du dossier. */
  source: 'legacy' | 'canonical';
  registryVersion: string;
  /** Chemins de rattachement des pièces (source canonique). */
  documentPaths?: Record<number, DocumentPath[]>;
  /** Mode shadow : compteurs d'écarts (le détail est journalisé). */
  shadowDiff?: {
    fields: number; documentsOnlyLegacy: number; documentsOnlyCanonical: number; events: number;
    /** Ajoutés en canonique, rattachement confirmé / non confirmé. */
    addedConfirmed?: number; addedUnconfirmed?: number;
    failed?: boolean;
  };
  /** Pièces au rattachement non confirmé (source canonique). */
  unconfirmedDocuments?: number[];
}

export const traceOf = (mode: RolloutMode, source: 'legacy' | 'canonical', extra: Partial<ExportSourceTrace> = {}): ExportSourceTrace =>
  ({ mode, source, registryVersion: REGISTRY_VERSION, ...extra });

/** Égalité tolérante : vide = vide, nombres et dates comparés sous forme texte. */
export function sameExportValue(a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  if (isEmptyValue(a) || isEmptyValue(b)) return false;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb;
  return String(a).trim() === String(b).trim();
}

export { REGISTRY_VERSION };
export type { AssetRowJson, CanonicalAssetState };
export { buildCanonicalAssetState, loadAssetRow };
