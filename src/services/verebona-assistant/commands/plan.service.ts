/**
 * Plans de commandes de l'assistant — préparation, confirmation, exécution.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUNE ÉCRITURE AVANT CONFIRMATION, ET RIEN QUI CHANGE ENTRE LES DEUX
 *
 *   1. PRÉPARATION : la commande reconnue est résolue dans le compte (bien,
 *      échéance), ses paramètres sont figés et enregistrés tels que
 *      présentés, avec leur empreinte. Aucune donnée métier n'est touchée.
 *   2. PRÉVISUALISATION : l'utilisateur voit l'action et ses effets.
 *   3. CONFIRMATION : explicite, par identifiant de plan seulement. Prise
 *      atomique (un plan ne s'exécute qu'une fois), propriétaire vérifié
 *      (compte + utilisateur : l'autre membre d'un Duo ne confirme pas),
 *      expiration, empreinte, droits d'écriture ÉVALUÉS À CET INSTANT.
 *   4. EXÉCUTION : par les services métier existants (executors.ts).
 *   5. RÉSULTAT : par action, tracé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash, randomUUID } from 'crypto';
import { pgClient } from '@/db';
import { assistantAssetAvailability } from '../core/asset-availability';
import { getEntitlements, restrictedRefusal } from '@/services/entitlements.service';
import { formatDateFr } from '../core/deterministic-format';
import type { AssistantRequestInput } from '../types/contracts';
import type {
  ActionResult, CommandPlanPreview, PlannedAction, PlanStatus,
} from './catalog';
import { WRITE_COMMAND_CATALOG, type DocumentCommandField, type SupplierCommandField } from './catalog';
import { parseCommands, type CommandDraft } from './parser';
import { runAction, EXECUTORS, type Executor, type ExecutionContext } from './executors';
import { agendaVersion, armUndo, purgeExpiredUndoSteps, type UndoCapture } from './undo.service';
import { ASSISTANT_ASSET_FIELDS, familyOf, formatFieldValue, type AssetFieldDefinition } from './asset-fields';
import { parseDateFr } from './parser';
import type { SuppliedFact } from '../types/contracts';
import { getField } from '@/services/canonical/registry';
import { tenureEndKey, tenureSituationHint, TENURE_END_LABEL } from '@/lib/assets/tenure-end';
import { validateDetailChanges } from '@/lib/asset-detail-rules';
import { plain } from '../core/routing-text';
import { undatedLabel } from '@/lib/agenda/no-deadline';
import { DEFAULT_NEW_SITUATION } from '@/lib/agenda/situation';
import { getAssetCategories, getAssetFamily } from '@/lib/asset-taxonomy';

/** Validité d'un plan non confirmé. */
const PLAN_TTL_MS = 15 * 60_000;

interface StoredPlan {
  planId: string;
  accountId: number;
  userId: number;
  conversationId: number | null;
  summary: string;
  actions: PlannedAction[];
  expiresAt: string;
}

type Preparation =
  | { kind: 'plan'; plan: StoredPlan; preview: CommandPlanPreview }
  /** Commande reconnue mais incomplète ou ambiguë : on demande, on n'écrit rien. */
  | { kind: 'need_info'; message: string };

// ── Résolution dans le compte ──────────────────────────────────────────────

export interface CommandLookup {
  today(): string;
  findAssets(accountId: number, words: string[]): Promise<Array<{ id: number; name: string; city?: string | null }>>;
  getAsset(accountId: number, id: number): Promise<{ id: number; name: string; city?: string | null } | null>;
  /** Bien et ses caractéristiques, pour UPDATE_ASSET_FIELD (ancienne valeur, famille, disponibilité). */
  getAssetState?(accountId: number, id: number): Promise<AssetState | null>;
  /**
   * Lot 114B (#753, W16 / W17) : échéances du compte désignées par les mots de
   * leur titre, leur date et/ou leur bien. Jamais une échéance d'un autre compte.
   */
  findAgendaItems?(accountId: number, q: { words: string[]; date: string | null; assetIds: number[] }): Promise<AgendaCandidate[]>;
  /**
   * Lot 114B (#753, W01) : la création d'un bien est-elle permise (droits, quota de
   * l'offre) ? `null` : oui ; sinon le message de refus de la façade métier.
   */
  assetCreationRefusal?(accountId: number): Promise<string | null>;
  /** Lot 114B (#753, W03) : décompte de ce que la suppression du bien emportera ; `null` : bien absent du compte. */
  assetDeletionSummary?(accountId: number, assetId: number): Promise<(Record<string, number> & { name: string }) | null>;
  /** Lot 114 (#753, W18 – W20) : fiches fournisseur du compte (jamais supprimées) dont le nom porte TOUS ces mots. */
  findSuppliers?(accountId: number, words: string[]): Promise<Array<{ id: number; name: string; status: string }>>;
  /** Fiche fournisseur du compte : coordonnées modifiables, empreinte de l'état présenté, relations conservées. */
  getSupplierState?(accountId: number, supplierId: number): Promise<SupplierState | null>;
  /** Doublon possible d'un nom (même rapprochement que les documents et le tiroir Agenda) — lecture seule. */
  supplierDuplicates?(accountId: number, name: string): Promise<{ decision: 'certain' | 'uncertain' | 'new'; candidates: Array<{ id: number; name: string }> }>;
  /** Lot 114 (#753, W04 – W09) : nature du bien (pièces et équipements possibles ou non). */
  getAssetKind?(accountId: number, assetId: number): Promise<{ category: string; subtype: string | null } | null>;
  /** Création d'une pièce ou d'un équipement sur ce bien : `null` si permise, sinon le refus de l'offre (façade métier). */
  structureRefusal?(accountId: number, asset: { category: string; subtype: string | null }, kind: 'room' | 'equipment'): Promise<string | null>;
  /** Pièces du compte dont le nom porte TOUS ces mots (dans ce bien si `assetId`). */
  findRooms?(accountId: number, words: string[], assetId: number | null): Promise<StructureCandidate[]>;
  getRoomState?(accountId: number, roomId: number): Promise<RoomState | null>;
  /** Équipements NON archivés du compte dont le nom porte TOUS ces mots (dans ce bien si `assetId`). */
  findEquipments?(accountId: number, words: string[], assetId: number | null): Promise<StructureCandidate[]>;
  getEquipmentState?(accountId: number, equipmentId: number): Promise<EquipmentState | null>;
  /** Lot 114 (#753, W12 / W14) : documents du compte (non supprimés) dont le titre affiché porte TOUS ces mots. */
  findDocuments?(accountId: number, words: string[]): Promise<Array<{ id: number; title: string; documentDate: string | null }>>;
  /** Document du compte : titre affiché, date, note de l'utilisateur, empreinte de l'état présenté. */
  getDocumentState?(accountId: number, documentId: number): Promise<DocumentState | null>;
  /**
   * Lot 114F (#753, W13) : biens auxquels le document est rattaché — `chosen` : choisis en propre (liste que le
   * tiroir du document enregistre) ; `implied` : déduits d'une pièce ou d'un équipement rattaché. `null` : document
   * absent du compte. Même lecture que le tiroir (`document-targets`).
   */
  getDocumentAssetTargets?(accountId: number, documentId: number): Promise<DocumentAssetTargets | null>;
}

export interface DocumentAssetTargets {
  chosen: Array<{ id: number; name: string }>;
  implied: Array<{ id: number; name: string }>;
}

/** Empreinte des rattachements présentés (document tel que présenté + biens choisis, sans ordre) — pure. */
export function documentTargetsVersion(documentVersionShown: string, chosenAssetIds: number[]): string {
  return createHash('sha256').update(JSON.stringify([documentVersionShown, [...chosenAssetIds].sort((a, b) => a - b)])).digest('hex').slice(0, 32);
}

export interface StructureCandidate { id: number; name: string; assetId: number; assetName: string }
export interface RoomState extends StructureCandidate {
  /** Ce qui est rattaché à la pièce (conservé dans le bien à sa suppression, sauf les liens d'échéances). */
  documents: number; equipments: number; agenda: number;
  version: string;
}
export interface EquipmentState extends StructureCandidate {
  roomName: string | null;
  documents: number; agenda: number;
  version: string;
}
/** Empreinte d'une pièce ou d'un équipement tel que présenté (pure). */
export function structureVersion(kind: 'room' | 'equipment', s: { id: number; name: string; assetId: number }, counts: number[]): string {
  return createHash('sha256').update(JSON.stringify([kind, s.id, s.name, s.assetId, ...counts])).digest('hex').slice(0, 32);
}

export interface DocumentState {
  id: number;
  /** Titre affiché (règle unique des vues). */
  title: string;
  originalFilename: string | null;
  documentDate: string | null;
  /** Texte affiché du champ unique « Notes / Description » (note de l'utilisateur, sinon description lue). */
  notesShown: string;
  /** La note affichée est-elle celle de l'utilisateur ? (une description lue ne s'« efface » pas : elle se remplace) */
  notesUserOwned: boolean;
  isWebLink: boolean;
  webLinkUrl: string | null;
  assetLabel: string | null;
  /** Empreinte de l'état présenté — recontrôlée à l'exécution. */
  version: string;
}

/** Empreinte d'un document tel que présenté (pure). */
export function documentVersion(d: Pick<DocumentState, 'id' | 'title' | 'documentDate' | 'notesShown'>): string {
  return createHash('sha256').update(JSON.stringify([d.id, d.title, d.documentDate, d.notesShown])).digest('hex').slice(0, 32);
}

export interface SupplierState {
  id: number;
  name: string;
  status: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  /** Empreinte de l'état présenté (coordonnées, statut) — recontrôlée à l'exécution. */
  version: string;
  /** Relations conservées par l'archivage (totaux de la fiche). */
  links: { documents: number; assets: number; equipments: number; agenda: number };
}

/** Empreinte d'une fiche fournisseur telle que présentée (pure). */
export function supplierVersion(s: Pick<SupplierState, 'id' | 'name' | 'status' | 'phone' | 'email' | 'website'>): string {
  return createHash('sha256').update(JSON.stringify([s.id, s.name, s.status, s.phone, s.email, s.website])).digest('hex').slice(0, 32);
}

export interface AgendaCandidate {
  id: number;
  title: string;
  startDate: string | null;
  /** Empreinte de l'état présenté (titre, date, mise à jour) — recontrôlée à l'exécution. */
  version: string;
  /** Nombre d'échéances de la même série (1 : échéance isolée). */
  seriesCount: number;
  assetLabel: string | null;
}

export interface AssetState {
  id: number;
  name: string;
  city?: string | null;
  category: string;
  status: string | null;
  lockState: string | null;
  characteristics: Record<string, unknown>;
}

/** Plafond d'une action en masse : au-delà, on demande de restreindre. */
export const MAX_BULK_TARGETS = 50;


export const sqlLookup: CommandLookup = {
  today: () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
  async findAssets(accountId, words) {
    const w = words.filter((x) => x.length >= 3).slice(0, 4);
    if (w.length === 0) return [];
    const cond = w.map((_, i) => `unaccent(lower(a.name || ' ' || coalesce(a.subtype,'') || ' ' || a.category)) LIKE unaccent(lower($${i + 2}))`).join(' OR ');
    return (await pgClient.unsafe(
      `SELECT a.id, a.name, a.city FROM assets a
        WHERE a.account_id = $1 AND ${assistantAssetAvailability.sql('a')} AND (${cond})
        ORDER BY a.name LIMIT 10`,
      [accountId, ...w.map((x) => `%${x}%`)] as never[],
    )) as unknown as Array<{ id: number; name: string; city: string | null }>;
  },
  async getAsset(accountId, id) {
    const r = (await pgClient.unsafe(
      `SELECT a.id, a.name, a.city FROM assets a WHERE a.id = $1 AND a.account_id = $2 AND ${assistantAssetAvailability.sql('a')}`,
      [id, accountId] as never[],
    )) as unknown as Array<{ id: number; name: string; city: string | null }>;
    return r[0] ?? null;
  },
  async findAgendaItems(accountId, q) {
    const w = q.words.filter((x) => x.length >= 3).slice(0, 5);
    if (w.length === 0 && !q.date && q.assetIds.length === 0) return [];
    const params: unknown[] = [accountId];
    const cond: string[] = [];
    // TOUS les mots du titre demandés : « vidange » ne désigne pas « contrôle technique ».
    for (const x of w) { params.push(`%${x}%`); cond.push(`unaccent(lower(i.title)) LIKE unaccent(lower($${params.length}))`); }
    if (q.date) { params.push(q.date); cond.push(`i.start_date = $${params.length}::date`); }
    if (q.assetIds.length) {
      params.push(q.assetIds);
      cond.push(`EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = i.id AND l.asset_id = ANY($${params.length}::int[]))`);
    }
    const rows = (await pgClient.unsafe(
      `SELECT i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS "startDate",
              (extract(epoch FROM i.updated_at) * 1000000)::bigint::text AS "updatedAt",
              CASE WHEN i.series_key IS NULL THEN 1
                   ELSE (SELECT count(*)::int FROM agenda_items s WHERE s.account_id = i.account_id AND s.series_key = i.series_key) END AS "seriesCount",
              (SELECT string_agg(a.name, ', ' ORDER BY a.name) FROM agenda_asset_links l JOIN assets a ON a.id = l.asset_id
                WHERE l.agenda_item_id = i.id AND a.account_id = i.account_id) AS "assetLabel"
         FROM agenda_items i
        WHERE i.account_id = $1${cond.length ? ` AND ${cond.join(' AND ')}` : ''}
        ORDER BY i.start_date NULLS LAST, i.id LIMIT 11`,
      params as never[],
    )) as unknown as Array<{ id: number; title: string; startDate: string | null; updatedAt: string; seriesCount: number; assetLabel: string | null }>;
    return rows.map((r) => ({
      id: Number(r.id), title: r.title, startDate: r.startDate, seriesCount: Number(r.seriesCount), assetLabel: r.assetLabel,
      version: agendaVersion({ id: Number(r.id), title: r.title, startDate: r.startDate, updatedAt: r.updatedAt }),
    }));
  },
  async assetCreationRefusal(accountId) {
    const { checkAssetCreationAllowed } = await import('@/services/assets/asset-write.facade');
    const r = await checkAssetCreationAllowed(accountId);
    return r.ok ? null : r.message;
  },
  async assetDeletionSummary(accountId, assetId) {
    const { readAssetDeletionSummary } = await import('@/services/assets/asset-write.facade');
    const r = await readAssetDeletionSummary(accountId, assetId);
    return r ? { ...r } as unknown as Record<string, number> & { name: string } : null;
  },
  async getAssetKind(accountId, assetId) {
    const [r] = (await pgClient.unsafe(
      `SELECT a.category, a.subtype FROM assets a WHERE a.id = $1 AND a.account_id = $2 AND a.deleted_at IS NULL`,
      [assetId, accountId] as never[],
    )) as unknown as Array<{ category: string; subtype: string | null }>;
    return r ?? null;
  },
  async structureRefusal(accountId, asset, kind) {
    const { structureCreationRefusal } = await import('@/services/assets/structure-write.facade');
    return (await structureCreationRefusal(accountId, asset, kind))?.message ?? null;
  },
  async findRooms(accountId, words, assetId) {
    const w = words.filter((x) => x.length >= 2).slice(0, 6);
    if (w.length === 0) return [];
    const cond = w.map((_, i) => `unaccent(lower(r.name)) LIKE unaccent(lower($${i + 3}))`).join(' AND ');
    return (await pgClient.unsafe(
      `SELECT r.id, r.name, a.id AS "assetId", a.name AS "assetName"
         FROM substructures r JOIN assets a ON a.id = r.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
        WHERE ($2::int IS NULL OR a.id = $2::int) AND ${cond}
        ORDER BY r.name, r.id LIMIT 11`,
      [accountId, assetId, ...w.map((x) => `%${x}%`)] as never[],
    )) as unknown as StructureCandidate[];
  },
  async getRoomState(accountId, roomId) {
    const [r] = (await pgClient.unsafe(
      `SELECT r.id, r.name, a.id AS "assetId", a.name AS "assetName",
              (SELECT count(*)::int FROM asset_files f WHERE f.account_id = $2 AND f.deleted_at IS NULL AND f.substructure_id = r.id) AS documents,
              (SELECT count(*)::int FROM equipments e WHERE e.substructure_id = r.id AND e.archived_at IS NULL) AS equipments,
              (SELECT count(*)::int FROM agenda_room_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $2 WHERE l.substructure_id = r.id) AS agenda
         FROM substructures r JOIN assets a ON a.id = r.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
        WHERE r.id = $1`,
      [roomId, accountId] as never[],
    )) as unknown as Array<Omit<RoomState, 'version'>>;
    if (!r) return null;
    const base = { id: Number(r.id), name: r.name, assetId: Number(r.assetId), assetName: r.assetName, documents: Number(r.documents), equipments: Number(r.equipments), agenda: Number(r.agenda) };
    return { ...base, version: structureVersion('room', base, [base.documents, base.equipments, base.agenda]) };
  },
  async findEquipments(accountId, words, assetId) {
    const w = words.filter((x) => x.length >= 2).slice(0, 6);
    if (w.length === 0) return [];
    const cond = w.map((_, i) => `unaccent(lower(e.name)) LIKE unaccent(lower($${i + 3}))`).join(' AND ');
    return (await pgClient.unsafe(
      `SELECT e.id, e.name, a.id AS "assetId", a.name AS "assetName"
         FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
        WHERE e.archived_at IS NULL AND ($2::int IS NULL OR a.id = $2::int) AND ${cond}
        ORDER BY e.name, e.id LIMIT 11`,
      [accountId, assetId, ...w.map((x) => `%${x}%`)] as never[],
    )) as unknown as StructureCandidate[];
  },
  async getEquipmentState(accountId, equipmentId) {
    const [r] = (await pgClient.unsafe(
      `SELECT e.id, e.name, a.id AS "assetId", a.name AS "assetName",
              (SELECT r.name FROM substructures r WHERE r.id = e.substructure_id AND r.asset_id = a.id) AS "roomName",
              (SELECT count(*)::int FROM asset_files f WHERE f.account_id = $2 AND f.deleted_at IS NULL AND f.equipment_id = e.id) AS documents,
              (SELECT count(*)::int FROM agenda_equipment_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $2 WHERE l.equipment_id = e.id) AS agenda
         FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
        WHERE e.id = $1 AND e.archived_at IS NULL`,
      [equipmentId, accountId] as never[],
    )) as unknown as Array<Omit<EquipmentState, 'version'>>;
    if (!r) return null;
    const base = { id: Number(r.id), name: r.name, assetId: Number(r.assetId), assetName: r.assetName, roomName: r.roomName ?? null, documents: Number(r.documents), agenda: Number(r.agenda) };
    return { ...base, version: structureVersion('equipment', base, [base.documents, base.agenda]) };
  },
  async findDocuments(accountId, words) {
    const w = words.filter((x) => x.length >= 2).slice(0, 6);
    if (w.length === 0) return [];
    const { documentTitleColumnsSql, documentTitleOf } = await import('@/lib/documents/document-title-source');
    // Le titre cherché est celui que les vues affichent (titre retenu, titre du lien, nom du fichier).
    const cond = w.map((_, i) => `unaccent(lower(coalesce(f.retained_title, '') || ' ' || coalesce(f.web_link_title, '') || ' ' || coalesce(f.original_filename, ''))) LIKE unaccent(lower($${i + 2}))`).join(' AND ');
    const rows = (await pgClient.unsafe(
      `SELECT f.id, to_char(f.document_date, 'YYYY-MM-DD') AS "documentDate", ${documentTitleColumnsSql('f')}
         FROM asset_files f
        WHERE f.account_id = $1 AND f.deleted_at IS NULL AND ${cond}
        ORDER BY f.document_date DESC NULLS LAST, f.id DESC LIMIT 11`,
      [accountId, ...w.map((x) => `%${x}%`)] as never[],
    )) as unknown as Array<{ id: number; documentDate: string | null } & Record<string, unknown>>;
    // Seuls les documents dont le titre AFFICHÉ porte les mots sont retenus (jamais un nom de fichier masqué).
    const plat = (t: string) => plain(t);
    return rows.map((r) => ({ id: Number(r.id), title: documentTitleOf(r as never), documentDate: r.documentDate }))
      .filter((d) => w.every((x) => plat(d.title).includes(plat(x))));
  },
  async getDocumentState(accountId, documentId) {
    const { documentTitleColumnsSql, documentTitleOf } = await import('@/lib/documents/document-title-source');
    const [r] = (await pgClient.unsafe(
      `SELECT f.id, f.original_filename AS "originalFilename", to_char(f.document_date, 'YYYY-MM-DD') AS "documentDate", f.notes, f.description,
              f.is_web_link AS "isWebLink", f.web_link_url AS "webLinkUrl", ${documentTitleColumnsSql('f')},
              (SELECT a.name FROM assets a WHERE a.id = f.asset_id AND a.account_id = f.account_id AND a.deleted_at IS NULL) AS "assetLabel"
         FROM asset_files f WHERE f.id = $1 AND f.account_id = $2 AND f.deleted_at IS NULL`,
      [documentId, accountId] as never[],
    )) as unknown as Array<Record<string, unknown>>;
    if (!r) return null;
    // Même règle que le tiroir du document pour le champ unique « Notes / Description » (lot 113Z).
    const { readNotesDescriptionMeta } = await import('@/services/documents/notes-description/store');
    const { resolveNotesDescription } = await import('@/lib/documents/notes-description');
    const meta = await readNotesDescriptionMeta(accountId, documentId).catch(() => null);
    const vue = resolveNotesDescription({
      notes: (r.notes as string | null) ?? null, description: (r.description as string | null) ?? null,
      notesUserOwned: meta?.notesUserOwned ?? false, descriptionSource: meta?.descriptionSource ?? null,
    });
    const base = { id: Number(r.id), title: documentTitleOf(r as never), documentDate: (r.documentDate as string | null) ?? null, notesShown: vue.text ?? '' };
    return {
      ...base, originalFilename: (r.originalFilename as string | null) ?? null,
      notesUserOwned: !!((r.notes as string | null) ?? '').trim(),
      isWebLink: r.isWebLink === true, webLinkUrl: (r.webLinkUrl as string | null) ?? null, assetLabel: (r.assetLabel as string | null) ?? null,
      version: documentVersion(base),
    };
  },
  async getDocumentAssetTargets(accountId, documentId) {
    const [{ db }, { readDocumentTargets }] = await Promise.all([import('@/db'), import('@/services/documents/document-targets/service')]);
    const vue = await readDocumentTargets(db as unknown as import('@/services/documents/document-targets/service').TargetsExecutor, accountId, documentId);
    if (!vue) return null;
    const bien = (a: { id: number; name: string }) => ({ id: a.id, name: a.name });
    return { chosen: vue.assets.filter((a) => !a.implied).map(bien), implied: vue.assets.filter((a) => a.implied).map(bien) };
  },
  async findSuppliers(accountId, words) {
    const w = words.filter((x) => x.length >= 2).slice(0, 6);
    if (w.length === 0) return [];
    const cond = w.map((_, i) => `unaccent(lower(s.name)) LIKE unaccent(lower($${i + 2}))`).join(' AND ');
    return (await pgClient.unsafe(
      `SELECT s.id, s.name, s.status FROM suppliers s
        WHERE s.account_id = $1 AND s.status <> 'deleted' AND ${cond}
        ORDER BY (s.status = 'active') DESC, s.name, s.id LIMIT 11`,
      [accountId, ...w.map((x) => `%${x}%`)] as never[],
    )) as unknown as Array<{ id: number; name: string; status: string }>;
  },
  async getSupplierState(accountId, supplierId) {
    // Même lecture que la fiche fournisseur (compte borné, fiche non supprimée, totaux exacts des sections).
    const { getSupplierDetail } = await import('@/services/suppliers/supplier-detail.service');
    const d = await getSupplierDetail(accountId, supplierId);
    if (!d) return null;
    const base = { id: d.supplier.id, name: d.supplier.name, status: d.supplier.status, phone: d.supplier.phone, email: d.supplier.email, website: d.supplier.website };
    return {
      ...base, version: supplierVersion(base),
      links: { documents: d.documents.total, assets: d.assets.total, equipments: d.equipments.total, agenda: d.agendaItems.length },
    };
  },
  async supplierDuplicates(accountId, name) {
    const { checkSupplierDuplicate } = await import('@/services/agenda/agenda-suppliers');
    return checkSupplierDuplicate(accountId, name);
  },
  async getAssetState(accountId, id) {
    // CDC 15 T2-40 : la valeur présentée à la confirmation (« A → B ») est
    // la valeur CANONIQUE — celle que l'assistant lit et que la fiche affiche
    // (`commandAssetState`), la même que l'exécuteur relit avant d'écrire.
    return (await import('../canonical/commands')).commandAssetState(accountId, id);
  },
};

const nomBien = (a: { name: string; city?: string | null }) => (a.city ? `${a.name} (${a.city})` : a.name);

/** Résout un brouillon en action figée — ou dit ce qui manque. */
export async function resolveDraft(
  draft: CommandDraft,
  input: AssistantRequestInput,
  lookup: CommandLookup,
  actionId = 'a1',
): Promise<PlannedAction | PlannedAction[] | { needInfo: string }> {
  const acc = input.accountId;

  if (draft.command === 'CREATE_AGENDA_ITEM') {
    // Lot 114B (Trello #753, CDC T2 §9.4, D26, M29, W15) — règle remplacée : « une
    // échéance sans date est refusée ». La date est facultative, comme dans
    // l'Agenda : l'événement est préparé sans date. « Sans échéance » n'est posé
    // que s'il est demandé ; une date et « sans échéance » ensemble sont refusés
    // par le service de l'Agenda (même règle que le formulaire).
    if (draft.noDeadline && draft.date) {
      return { needInfo: 'Une tâche « Sans échéance » n’a pas de date : voulez-vous une date, ou « Sans échéance » ?' };
    }
    const targets: PlannedAction['targets'] = [];
    let assetIds: number[] = [];
    if (draft.assetFromContext || (!draft.assetWords.length && input.reference?.type === 'asset')) {
      const id = input.reference?.type === 'asset' ? input.reference.id : Number(input.pageContext?.assetId) || null;
      const a = id ? await lookup.getAsset(acc, id) : null;
      if (!a) return { needInfo: 'Pour quel bien voulez-vous créer cette échéance ?' };
      assetIds = [a.id]; targets.push({ type: 'asset', id: a.id, label: nomBien(a) });
    } else if (draft.assetWords.length) {
      const found = await lookup.findAssets(acc, draft.assetWords);
      if (found.length === 0) return { needInfo: 'Je n’ai pas trouvé ce bien dans votre compte. Pour quel bien voulez-vous créer cette échéance ?' };
      if (found.length > 1) {
        return { needInfo: `Plusieurs biens correspondent : ${found.slice(0, 5).map((a) => nomBien(a)).join(', ')}. Précisez lequel dans votre demande.` };
      }
      assetIds = [found[0].id]; targets.push({ type: 'asset', id: found[0].id, label: nomBien(found[0]) });
    }
    const bien = targets[0] ? `, rattachée à ${targets[0].label}` : '';
    // Lot 114V (#742) — règle remplacée : une échéance créée sans date n'est plus annoncée « Sans date » mais
    // « À prévoir » (situation enregistrée par défaut par le service de l'Agenda pour toute création manuelle).
    const quand = draft.date ? formatDateFr(draft.date) : undatedLabel({ noDeadline: draft.noDeadline, situation: DEFAULT_NEW_SITUATION });
    return {
      actionId, command: 'CREATE_AGENDA_ITEM', targets, dependsOn: [],
      params: { title: draft.title, startDate: draft.date, assetIds, ...(draft.noDeadline ? { noDeadline: true } : {}) },
      preview: draft.date
        ? `Créer l’échéance « ${draft.title} » le ${quand}${bien}.`
        : `Créer l’échéance « ${draft.title} » (${quand.toLowerCase()})${bien}.`,
      effects: [
        `Titre : ${draft.title}`,
        `Date : ${quand}`,
        targets[0] ? `Bien : ${targets[0].label}` : 'Bien : aucun',
      ],
    };
  }

  if (draft.command === 'UPDATE_ASSET_FIELD') {
    return resolveAssetFieldUpdate(draft, input, lookup, actionId);
  }

  if (draft.command === 'UPDATE_AGENDA_ITEM' || draft.command === 'DELETE_AGENDA_ITEM') {
    return resolveAgendaChange(draft, input, lookup, actionId);
  }

  if (draft.command === 'CREATE_SUPPLIER' || draft.command === 'UPDATE_SUPPLIER' || draft.command === 'ARCHIVE_SUPPLIER') {
    return resolveSupplierCommand(draft, input, lookup, actionId);
  }
  if (draft.command === 'CREATE_ROOM' || draft.command === 'CREATE_EQUIPMENT' || draft.command === 'RENAME_ROOM' || draft.command === 'RENAME_EQUIPMENT'
    || draft.command === 'DELETE_ROOM' || draft.command === 'ARCHIVE_EQUIPMENT') {
    return resolveStructureCommand(draft, input, lookup, actionId);
  }
  if (draft.command === 'CREATE_WEB_DOCUMENT' || draft.command === 'UPDATE_DOCUMENT' || draft.command === 'DELETE_DOCUMENT') {
    return resolveDocumentCommand(draft, input, lookup, actionId);
  }
  if (draft.command === 'UPDATE_DOCUMENT_TARGETS') return resolveDocumentTargets(draft, input, lookup, actionId);
  if (draft.command === 'RENAME_ASSET') return resolveAssetRename(draft, input, lookup, actionId);
  if (draft.command === 'CLEAR_ASSET_FIELD') return resolveAssetFieldClear(draft, input, lookup, actionId);
  if (draft.command === 'CREATE_ASSET') return resolveAssetCreation(draft, input, lookup, actionId);
  if (draft.command === 'DELETE_ASSET') return resolveAssetDeletion(draft, input, lookup, actionId);

  // Lot 113P (#715) : plus de « marquer réalisée » / « annuler » (aucun statut d'événement).
  return { needInfo: 'Je ne peux pas faire cette modification depuis l’assistant.' };
}

/** Éléments du décompte de suppression — mêmes libellés et même ordre que la boîte de suppression de la fiche. */
export const DELETION_NOUNS: ReadonlyArray<{ key: string; one: string; many: string }> = [
  { key: 'documents', one: 'document', many: 'documents' },
  { key: 'deadlines', one: 'échéance', many: 'échéances' },
  { key: 'events', one: 'événement', many: 'événements' },
  { key: 'photos', one: 'photo', many: 'photos' },
  { key: 'rooms', one: 'pièce', many: 'pièces' },
  { key: 'equipments', one: 'équipement', many: 'équipements' },
];
/** « 12 documents, 1 échéance » — éléments à zéro omis (pure). */
export function deletionCounts(summary: Record<string, number>): string[] {
  return DELETION_NOUNS.filter((n) => (summary[n.key] ?? 0) > 0).map((n) => `${summary[n.key]} ${summary[n.key] > 1 ? n.many : n.one}`);
}
const countsOnly = (summary: Record<string, unknown>): Record<string, number> =>
  Object.fromEntries(DELETION_NOUNS.map((n) => [n.key, Number(summary[n.key] ?? 0)]));

/**
 * Lot 114B (Trello #753, CDC T2 §14.3 W01, §14.4 « Biens », §10.1) — créer un
 * bien : famille et catégorie du référentiel, nom donné par l'utilisateur.
 * Seuls le nom et la catégorie sont demandés (D26) ; le quota de l'offre est
 * contrôlé AVANT de proposer le plan, puis de nouveau à l'exécution.
 */
async function resolveAssetCreation(
  draft: Extract<CommandDraft, { command: 'CREATE_ASSET' }>,
  input: AssistantRequestInput,
  lookup: CommandLookup,
  actionId: string,
): Promise<PlannedAction | { needInfo: string }> {
  const famille = getAssetFamily(draft.family);
  if (!famille) return { needInfo: 'Je ne peux pas faire cette modification depuis l’assistant.' };
  const categories = getAssetCategories(draft.family);
  const categorie = draft.category ? categories.find((c) => c.value === draft.category) ?? null : null;
  // Objet : la catégorie d'objet est obligatoire (même règle que le formulaire).
  if (draft.family === 'OBJECT' && !categorie) {
    return { needInfo: `De quel type d’objet s’agit-il ? Par exemple : ${categories.slice(0, 6).map((c) => c.label.toLowerCase()).join(', ')}.` };
  }
  const nature = (categorie?.label ?? famille.label).toLowerCase();
  if (!draft.name) return { needInfo: `Quel nom voulez-vous donner à ce bien (${nature}) ?` };
  const refus = lookup.assetCreationRefusal ? await lookup.assetCreationRefusal(input.accountId) : null;
  if (refus) return { needInfo: refus };
  // Un bien du même nom existe déjà : dit dans l'aperçu, jamais créé en silence (CDC §9.8).
  const homonymes = (await lookup.findAssets(input.accountId, plain(draft.name).split(/[^a-z0-9]+/).filter((w) => w.length >= 3)))
    .filter((a) => plain(a.name) === plain(draft.name!));
  return {
    actionId, command: 'CREATE_ASSET', targets: [], dependsOn: [],
    params: {
      kind: 'asset_create', category: draft.family, name: draft.name,
      subtype: draft.family === 'OBJECT' ? null : categorie?.value ?? null,
      objectCategory: draft.family === 'OBJECT' ? categorie!.value : null,
    },
    preview: `Créer le bien « ${draft.name} » (${nature}).`,
    effects: [
      `Nom : ${draft.name}`,
      `Type : ${categorie ? `${famille.label} — ${categorie.label}` : famille.label}`,
      ...(homonymes.length ? [`Attention : un bien nommé « ${homonymes[0].name} » existe déjà dans votre compte.`] : []),
    ],
  };
}

/**
 * Lot 114B (Trello #753, CDC T2 §9.2, §14.2-3, §14.3 W03, M20-M21, D08 / D29) —
 * supprimer DÉFINITIVEMENT un bien et tout son contenu. L'aperçu donne le
 * décompte réel (le même que la fiche) ; aucune conservation des documents
 * n'est promise, puisque le métier n'en propose pas. Le décompte est figé :
 * s'il a changé à la confirmation, rien n'est supprimé.
 */
async function resolveAssetDeletion(
  draft: Extract<CommandDraft, { command: 'DELETE_ASSET' }>,
  input: AssistantRequestInput,
  lookup: CommandLookup,
  actionId: string,
): Promise<PlannedAction | { needInfo: string }> {
  const acc = input.accountId;
  if (!lookup.assetDeletionSummary) return { needInfo: 'Je ne peux pas faire cette modification depuis l’assistant.' };
  let bien: { id: number; name: string; city?: string | null } | null = null;
  if (draft.assetFromContext) {
    const id = input.reference?.type === 'asset' ? input.reference.id : Number(input.pageContext?.assetId) || null;
    bien = id ? await lookup.getAsset(acc, id) : null;
    if (!bien) return { needInfo: 'Quel bien voulez-vous supprimer ?' };
  } else {
    const found = await lookup.findAssets(acc, draft.assetWords);
    if (found.length === 0) return { needInfo: 'Je n’ai pas trouvé ce bien dans votre compte. Quel bien voulez-vous supprimer ?' };
    if (found.length > 1) {
      return { needInfo: `Plusieurs biens correspondent : ${found.slice(0, 5).map((a) => nomBien(a)).join(', ')}. Précisez lequel dans votre demande.` };
    }
    bien = found[0];
  }
  const resume = await lookup.assetDeletionSummary(acc, bien.id);
  if (!resume) return { needInfo: 'Je n’ai pas trouvé ce bien dans votre compte. Quel bien voulez-vous supprimer ?' };
  const comptes = countsOnly(resume);
  const contenu = deletionCounts(comptes);
  return {
    actionId, command: 'DELETE_ASSET', dependsOn: [],
    targets: [{ type: 'asset', id: bien.id, label: nomBien(bien) }],
    params: { kind: 'asset_delete', assetId: bien.id, expectedSummary: comptes },
    preview: `Supprimer définitivement le bien « ${nomBien(bien)} »${contenu.length ? ` et tout ce qui lui est rattaché : ${contenu.join(', ')}` : ''}.`,
    effects: [
      'Le bien et tout ce qui lui est rattaché seront supprimés définitivement.',
      contenu.length ? `Supprimés avec le bien : ${contenu.join(', ')}.` : 'Aucun document, échéance ni autre élément n’est rattaché à ce bien.',
      'Pour garder un document, téléchargez-le avant de supprimer le bien.',
      'Cette action est irréversible.',
    ],
  };
}

// ── Lot 114F (#753, W02 / W27 / W13) : renommer un bien, effacer une caractéristique, rattacher un document ──

const BIEN_NON_MODIFIABLE = (nom: string) => `${nom} n’est pas modifiable actuellement (bien archivé ou verrouillé par votre offre).`;

/** Bien visé par une commande sur sa fiche : désigné, sinon celui du fil / de la page ; jamais choisi au hasard. */
async function bienAModifier(
  lookup: CommandLookup, input: AssistantRequestInput, d: { assetWords: string[]; assetFromContext: boolean }, question: string,
): Promise<{ asset: AssetState } | { needInfo: string }> {
  if (!lookup.getAssetState) return { needInfo: 'Je ne peux pas faire cette modification depuis l’assistant.' };
  // `bienDesigne` est déclaré plus bas (fonction : disponible ici).
  const r = await bienDesigne(lookup, input, d, question);
  if ('needInfo' in r) return r;
  if (!r.bien) return { needInfo: question };
  const asset = await lookup.getAssetState(input.accountId, r.bien.id);
  if (!asset) return { needInfo: `Je n’ai pas trouvé ce bien dans votre compte. ${question}` };
  if (asset.status === 'ARCHIVED' || (asset.lockState && asset.lockState !== 'NONE')) return { needInfo: BIEN_NON_MODIFIABLE(nomBien(asset)) };
  return { asset };
}

/**
 * Lot 114F (Trello #753, CDC T2 §14.3 W02) — renommer un bien : ancien nom → nouveau nom, présentés avant toute
 * confirmation. Le nom s'écrit par le service de la fiche (`updateAssetDetails`, section commune), comme
 * `PATCH /api/assets/[id]/details/common`. L'ancien nom est figé : s'il a changé à la confirmation, rien n'est écrit.
 */
async function resolveAssetRename(
  draft: Extract<CommandDraft, { command: 'RENAME_ASSET' }>, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<PlannedAction | { needInfo: string }> {
  const cible = await bienAModifier(lookup, input, draft, 'Quel bien voulez-vous renommer ?');
  if ('needInfo' in cible) return cible;
  const asset = cible.asset;
  const nom = (draft.newName ?? '').trim().replace(/\s+/g, ' ');
  if (!nom) return { needInfo: `Quel nouveau nom voulez-vous donner à ${nomBien(asset)} ?` };
  if (nom === asset.name.trim()) return { needInfo: `Ce bien s’appelle déjà « ${asset.name} ».` };
  return {
    actionId, command: 'RENAME_ASSET', dependsOn: [],
    targets: [{ type: 'asset', id: asset.id, label: nomBien(asset) }],
    params: { kind: 'asset_rename', renamedAssetId: asset.id, assetNewName: nom, expectedName: asset.name },
    preview: `Renommer le bien « ${asset.name} » en « ${nom} ».`,
    effects: [
      `Nom : ${asset.name} → ${nom}`,
      'Le nouveau nom apparaîtra partout où ce bien est cité.',
      'Pour revenir à l’ancien nom, refaites une demande de renommage.',
    ],
  };
}

/**
 * Lot 114F (Trello #753, CDC T2 §14.3 W27) — effacement VOLONTAIRE d'une caractéristique d'un bien : champ de la
 * liste fermée du registre (aucun champ fantôme), applicable à la famille du bien, valeur actuelle présentée.
 * Écrit `null` par le service de la fiche, origine USER — le même marqueur d'effacement que le formulaire.
 * La valeur présentée est figée : si elle a changé à la confirmation, rien n'est effacé.
 */
async function resolveAssetFieldClear(
  draft: Extract<CommandDraft, { command: 'CLEAR_ASSET_FIELD' }>, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<PlannedAction | { needInfo: string }> {
  const def = ASSISTANT_ASSET_FIELDS.find((f) => f.key === draft.fieldKey);
  if (!def) return { needInfo: 'Je ne peux pas modifier ce champ depuis l’assistant.' };
  const cible = await bienAModifier(lookup, input, draft, `Pour quel bien voulez-vous effacer « ${def.label} » ?`);
  if ('needInfo' in cible) return cible;
  const asset = cible.asset;
  const section = def.sections[familyOf(asset.category)];
  if (!section) return { needInfo: `« ${def.label} » ne s’applique pas à ${nomBien(asset)}.` };
  const previous = asset.characteristics[def.key] ?? null;
  if (previous === null || previous === '') return { needInfo: `« ${def.label} » de ${nomBien(asset)} n’est pas renseigné : il n’y a rien à effacer.` };
  const avant = formatFieldValue(def, previous);
  return {
    actionId, command: 'CLEAR_ASSET_FIELD', dependsOn: [],
    targets: [{ type: 'asset', id: asset.id, label: nomBien(asset) }],
    params: { kind: 'asset_field_clear', clearAssetId: asset.id, clearSection: section, clearedField: def.key, clearedPrevious: previous },
    preview: `Effacer « ${def.label} » de ${nomBien(asset)} (valeur actuelle : ${avant}).`,
    effects: [
      `Bien : ${nomBien(asset)}`,
      `Champ : ${def.label}`,
      `Valeur actuelle : ${avant}`,
      'Nouvelle valeur : non renseigné',
      'Le champ sera vide : cet effacement est enregistré comme votre décision.',
    ],
  };
}

/**
 * Lot 114F (Trello #753, CDC T2 §14.3 W13, §14.4 « Documents ») — rattacher un document à un bien du compte, ou
 * l'en détacher. La liste COMPLÈTE des biens après l'action est figée (celle que le tiroir du document
 * enregistrerait) ; les autres rattachements sont conservés. Détacher est une dissociation : le document reste
 * dans le compte. Pièces et équipements : depuis le document (non proposé ici).
 */
async function resolveDocumentTargets(
  draft: Extract<CommandDraft, { command: 'UPDATE_DOCUMENT_TARGETS' }>, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<PlannedAction | { needInfo: string }> {
  const acc = input.accountId;
  if (!lookup.getDocumentAssetTargets) return { needInfo: 'Je ne peux pas faire cette modification depuis l’assistant.' };
  if (draft.structureTarget) {
    return { needInfo: 'Depuis l’assistant, un document se rattache à un bien. Pour une pièce ou un équipement, ouvrez le document et modifiez ses rattachements.' };
  }
  const attacher = draft.mode === 'attach';
  const doc = await documentDesigne(lookup, input, draft, attacher ? 'rattacher' : 'détacher');
  if ('needInfo' in doc) return doc;
  const d = doc.state;
  const question = attacher ? `À quel bien voulez-vous rattacher « ${d.title} » ?` : `De quel bien voulez-vous détacher « ${d.title} » ?`;
  if (!draft.assetWords.length && !draft.assetFromContext) return { needInfo: question };
  const r = await bienDesigne(lookup, input, draft, question);
  if ('needInfo' in r) return r;
  if (!r.bien) return { needInfo: question };
  const bien = r.bien;
  const cibles = await lookup.getDocumentAssetTargets(acc, d.id);
  if (!cibles) return { needInfo: `Je n’ai pas trouvé ce document dans votre compte. Quel document voulez-vous ${attacher ? 'rattacher' : 'détacher'} ?` };
  const choisis = cibles.chosen.map((a) => a.id);
  const liste = (biens: Array<{ name: string }>) => (biens.length ? biens.map((a) => a.name).join(', ') : 'aucun');
  let apres: Array<{ id: number; name: string }>;
  if (attacher) {
    if (choisis.includes(bien.id) || cibles.implied.some((a) => a.id === bien.id)) return { needInfo: `« ${d.title} » est déjà rattaché à ${nomBien(bien)}.` };
    apres = [...cibles.chosen, { id: bien.id, name: bien.name }];
  } else {
    if (cibles.implied.some((a) => a.id === bien.id)) {
      return { needInfo: `« ${d.title} » est rattaché à ${nomBien(bien)} par une pièce ou un équipement. Ouvrez le document pour modifier ce rattachement.` };
    }
    if (!choisis.includes(bien.id)) return { needInfo: `« ${d.title} » n’est pas rattaché à ${nomBien(bien)}.` };
    apres = cibles.chosen.filter((a) => a.id !== bien.id);
  }
  return {
    actionId, command: 'UPDATE_DOCUMENT_TARGETS', dependsOn: [],
    targets: [{ type: 'document', id: d.id, label: d.title }, { type: 'asset', id: bien.id, label: nomBien(bien) }],
    params: {
      kind: 'document_targets', documentId: d.id, targetAssetIds: apres.map((a) => a.id), expectedAssetIds: choisis,
      expectedVersion: documentTargetsVersion(d.version, choisis),
    },
    preview: attacher ? `Rattacher le document « ${d.title} » à ${nomBien(bien)}.` : `Détacher le document « ${d.title} » de ${nomBien(bien)}.`,
    effects: [
      `Document : ${d.title}`,
      `Biens rattachés : ${liste(cibles.chosen)} → ${liste(apres)}`,
      attacher ? 'Les autres rattachements du document sont conservés.' : 'Le document reste dans vos documents : il n’est pas supprimé.',
      'Ce rattachement est votre décision : il ne sera pas défait par une analyse.',
    ],
  };
}

// ── Lot 114 (#753, W04 – W09) : pièces et équipements d'un bien ────────────

type StructureDraft = Extract<CommandDraft, { command: 'CREATE_ROOM' | 'CREATE_EQUIPMENT' | 'RENAME_ROOM' | 'RENAME_EQUIPMENT' | 'DELETE_ROOM' | 'ARCHIVE_EQUIPMENT' }>;
const memeNom = (a: string, b: string) => plain(a).replace(/\s+/g, ' ').trim() === plain(b).replace(/\s+/g, ' ').trim();

/** Bien désigné par la demande (mots, ou bien du fil / de la page) ; `null` : aucun bien désigné. */
async function bienDesigne(
  lookup: CommandLookup, input: AssistantRequestInput, d: { assetWords: string[]; assetFromContext: boolean }, question: string,
): Promise<{ bien: { id: number; name: string; city?: string | null } | null } | { needInfo: string }> {
  const acc = input.accountId;
  if (d.assetWords.length) {
    const found = await lookup.findAssets(acc, d.assetWords);
    if (found.length === 0) return { needInfo: `Je n’ai pas trouvé ce bien dans votre compte. ${question}` };
    if (found.length > 1) return { needInfo: `Plusieurs biens correspondent : ${found.slice(0, 5).map((a) => nomBien(a)).join(', ')}. Précisez lequel dans votre demande.` };
    return { bien: found[0] };
  }
  const id = input.reference?.type === 'asset' ? input.reference.id : Number(input.pageContext?.assetId) || null;
  const bien = id ? await lookup.getAsset(acc, id) : null;
  if (!bien && d.assetFromContext) return { needInfo: question };
  return { bien };
}

/**
 * Lot 114 (Trello #753, CDC T2 §14.3 W04 – W09, §14.4, E2E-07) :
 *   · créer : nom et bien seulement ; le bien doit accepter des pièces / équipements et l'offre le permettre
 *     (mêmes contrôles que les écrans, refus dit AVANT tout plan) ; jamais un doublon de nom dans le même bien ;
 *   · renommer : ancien → nouveau ;
 *   · supprimer une pièce : ce qui y est rattaché est annoncé — conservé dans le bien, sans pièce ;
 *   · retirer un équipement : ARCHIVAGE (règle existante), rien n'est supprimé.
 * Jamais un bien, une pièce ou un équipement choisi à la place de l'utilisateur.
 */
async function resolveStructureCommand(
  draft: StructureDraft, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<PlannedAction | { needInfo: string }> {
  const acc = input.accountId;
  const piece = draft.command === 'CREATE_ROOM' || draft.command === 'RENAME_ROOM' || draft.command === 'DELETE_ROOM';
  const nom = piece ? { un: 'cette pièce', le: 'la pièce', objet: 'pièce' } : { un: 'cet équipement', le: 'l’équipement', objet: 'équipement' };
  if (!lookup.findRooms || !lookup.getRoomState || !lookup.findEquipments || !lookup.getEquipmentState || !lookup.getAssetKind || !lookup.structureRefusal) {
    return { needInfo: 'Je ne peux pas faire cette modification depuis l’assistant.' };
  }

  if ('roomWords' in draft) {
    if (!draft.name) return { needInfo: piece ? 'Quel nom voulez-vous donner à cette pièce ?' : 'Quel nom voulez-vous donner à cet équipement ?' };
    const r = await bienDesigne(lookup, input, draft, `Dans quel bien voulez-vous créer ${nom.un} ?`);
    if ('needInfo' in r) return r;
    if (!r.bien) return { needInfo: `Dans quel bien voulez-vous créer ${nom.un} ?` };
    const bien = r.bien;
    const nature = await lookup.getAssetKind(acc, bien.id);
    if (!nature) return { needInfo: `Dans quel bien voulez-vous créer ${nom.un} ?` };
    const refus = await lookup.structureRefusal(acc, nature, piece ? 'room' : 'equipment');
    if (refus) return { needInfo: refus };
    const homonymes = (piece ? await lookup.findRooms(acc, plain(draft.name).split(/[^a-z0-9]+/).filter((w) => w.length >= 2), bien.id)
      : await lookup.findEquipments(acc, plain(draft.name).split(/[^a-z0-9]+/).filter((w) => w.length >= 2), bien.id)).filter((x) => memeNom(x.name, draft.name!));
    if (homonymes.length) return { needInfo: `${piece ? 'La pièce' : 'L’équipement'} « ${homonymes[0].name} » existe déjà dans ${nomBien(bien)}.` };
    if (piece) {
      return {
        actionId, command: 'CREATE_ROOM', dependsOn: [], targets: [{ type: 'asset', id: bien.id, label: nomBien(bien) }],
        params: { kind: 'room_create', roomAssetId: bien.id, roomName: draft.name },
        preview: `Créer la pièce « ${draft.name} » dans ${nomBien(bien)}.`,
        effects: [`Pièce : ${draft.name}`, `Bien : ${nomBien(bien)}`],
      };
    }
    let salle: StructureCandidate | null = null;
    if (draft.roomWords.length) {
      const salles = await lookup.findRooms(acc, draft.roomWords, bien.id);
      if (salles.length === 0) return { needInfo: `Je n’ai pas trouvé cette pièce dans ${nomBien(bien)}. Dans quelle pièce se trouve cet équipement ?` };
      const exactes = salles.filter((x) => plain(x.name).split(/[^a-z0-9]+/).filter(Boolean).join(' ') === draft.roomWords.join(' '));
      const retenues = exactes.length === 1 ? exactes : salles;
      if (retenues.length > 1) return { needInfo: `Plusieurs pièces correspondent : ${retenues.slice(0, 5).map((x) => x.name).join(', ')}. Précisez laquelle dans votre demande.` };
      salle = retenues[0];
    }
    return {
      actionId, command: 'CREATE_EQUIPMENT', dependsOn: [], targets: [{ type: 'asset', id: bien.id, label: nomBien(bien) }],
      params: { kind: 'equipment_create', equipmentAssetId: bien.id, equipmentName: draft.name, equipmentRoomId: salle?.id ?? null },
      preview: `Créer l’équipement « ${draft.name} » dans ${nomBien(bien)}${salle ? ` (pièce « ${salle.name} »)` : ''}.`,
      effects: [`Équipement : ${draft.name}`, `Bien : ${nomBien(bien)}`, salle ? `Pièce : ${salle.name}` : 'Pièce : aucune'],
    };
  }

  // Renommer / retirer : la cible est cherchée dans le compte (dans le bien nommé s'il l'est).
  const verbe = 'newName' in draft ? 'renommer' : piece ? 'supprimer' : 'retirer';
  const r = await bienDesigne(lookup, input, { assetWords: draft.assetWords, assetFromContext: draft.assetFromContext }, `Dans quel bien se trouve ${nom.un} ?`);
  if ('needInfo' in r) return r;
  // Le bien du fil ne restreint la recherche que s'il a été demandé (« de ce bien ») ou nommé.
  const filtre = draft.assetWords.length || draft.assetFromContext ? r.bien?.id ?? null : null;
  const trouves = piece ? await lookup.findRooms(acc, draft.targetWords, filtre) : await lookup.findEquipments(acc, draft.targetWords, filtre);
  if (trouves.length === 0) return { needInfo: `Je n’ai pas trouvé ${nom.un} dans votre compte. ${piece ? 'Quelle pièce' : 'Quel équipement'} voulez-vous ${verbe} ?` };
  const exacts = trouves.filter((x) => plain(x.name).split(/[^a-z0-9]+/).filter(Boolean).join(' ') === draft.targetWords.join(' '));
  const retenus = exacts.length === 1 ? exacts : trouves;
  if (retenus.length > 1) {
    return { needInfo: `${piece ? 'Plusieurs pièces correspondent' : 'Plusieurs équipements correspondent'} : ${retenus.slice(0, 5).map((x) => `${x.name} (${x.assetName})`).join(', ')}. Précisez ${piece ? 'laquelle' : 'lequel'} dans votre demande.` };
  }
  const cible = retenus[0];
  const etat = piece ? await lookup.getRoomState(acc, cible.id) : await lookup.getEquipmentState(acc, cible.id);
  if (!etat) return { needInfo: `Je n’ai pas trouvé ${nom.un} dans votre compte. ${piece ? 'Quelle pièce' : 'Quel équipement'} voulez-vous ${verbe} ?` };
  const targets: PlannedAction['targets'] = [{ type: piece ? 'room' : 'equipment', id: etat.id, label: etat.name }];

  if ('newName' in draft) {
    if (!draft.newName) return { needInfo: `Quel nouveau nom voulez-vous donner à ${nom.le} « ${etat.name} » ?` };
    if (draft.newName === etat.name) return { needInfo: `${piece ? 'Cette pièce' : 'Cet équipement'} s’appelle déjà « ${etat.name} ».` };
    const autres = (piece ? await lookup.findRooms(acc, plain(draft.newName).split(/[^a-z0-9]+/).filter((w) => w.length >= 2), etat.assetId)
      : await lookup.findEquipments(acc, plain(draft.newName).split(/[^a-z0-9]+/).filter((w) => w.length >= 2), etat.assetId)).filter((x) => x.id !== etat.id && memeNom(x.name, draft.newName!));
    if (autres.length) return { needInfo: `${piece ? 'La pièce' : 'L’équipement'} « ${autres[0].name} » existe déjà dans ${etat.assetName}.` };
    return piece
      ? {
        actionId, command: 'RENAME_ROOM', dependsOn: [], targets,
        params: { kind: 'room_rename', roomId: etat.id, roomAssetId: etat.assetId, roomName: draft.newName, expectedVersion: etat.version },
        preview: `Renommer la pièce « ${etat.name} » (${etat.assetName}) en « ${draft.newName} ».`, effects: [`Pièce : ${etat.name} → ${draft.newName}`, `Bien : ${etat.assetName}`],
      }
      : {
        actionId, command: 'RENAME_EQUIPMENT', dependsOn: [], targets,
        params: { kind: 'equipment_rename', equipmentId: etat.id, equipmentAssetId: etat.assetId, equipmentName: draft.newName, expectedVersion: etat.version },
        preview: `Renommer l’équipement « ${etat.name} » (${etat.assetName}) en « ${draft.newName} ».`, effects: [`Équipement : ${etat.name} → ${draft.newName}`, `Bien : ${etat.assetName}`],
      };
  }

  if (piece) {
    const e = etat as RoomState;
    const contenu = [
      ...(e.documents ? [pluriel(e.documents, 'document', 'documents')] : []),
      ...(e.equipments ? [pluriel(e.equipments, 'équipement', 'équipements')] : []),
    ];
    return {
      actionId, command: 'DELETE_ROOM', dependsOn: [], targets,
      params: { kind: 'room_delete', roomId: e.id, roomAssetId: e.assetId, expectedVersion: e.version },
      preview: `Supprimer la pièce « ${e.name} » de ${e.assetName}.`,
      effects: [
        contenu.length ? `Conservés dans ${e.assetName}, sans pièce : ${contenu.join(', ')}.` : 'Aucun document ni équipement n’est rattaché à cette pièce.',
        ...(e.agenda ? [`${pluriel(e.agenda, 'échéance ne sera plus liée', 'échéances ne seront plus liées')} à cette pièce (${e.agenda > 1 ? 'elles restent' : 'elle reste'} dans l’Agenda).`] : []),
        'Cette action est irréversible.',
      ],
    };
  }
  const e = etat as EquipmentState;
  const liens = [
    ...(e.documents ? [pluriel(e.documents, 'document', 'documents')] : []),
    ...(e.agenda ? [pluriel(e.agenda, 'échéance', 'échéances')] : []),
  ];
  return {
    actionId, command: 'ARCHIVE_EQUIPMENT', dependsOn: [], targets,
    params: { kind: 'equipment_archive', equipmentId: e.id, equipmentAssetId: e.assetId, expectedVersion: e.version },
    preview: `Retirer l’équipement « ${e.name} » de ${e.assetName}.`,
    effects: [
      'L’équipement est archivé : il n’apparaît plus dans le bien, rien n’est supprimé.',
      liens.length ? `Conservés : ${liens.join(', ')}.` : 'Aucun document ni échéance ne lui est rattaché.',
    ],
  };
}

// ── Lot 114 (#753, W10 / W12 / W14) : documents ────────────────────────────

/** Libellés des champs d'un document modifiables depuis l'Assistant (textes à valider par le PO). */
export const DOCUMENT_FIELD_LABELS: Readonly<Record<DocumentCommandField, { label: string; article: string }>> = {
  title: { label: 'Titre', article: 'le titre' },
  date: { label: 'Date du document', article: 'la date' },
  notes: { label: 'Notes / Description', article: 'la note' },
};
const extrait = (t: string, n = 80) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const dateOuVide = (d: string | null) => (d ? formatDateFr(d) : '(aucune)');

/** Document unique désigné (« ce document » du fil, ou mots du titre), ou la précision à demander. */
async function documentDesigne(
  lookup: CommandLookup, input: AssistantRequestInput, d: { documentWords: string[]; documentFromContext: boolean }, pourQuoi: string,
): Promise<{ state: DocumentState } | { needInfo: string }> {
  if (!lookup.findDocuments || !lookup.getDocumentState) return { needInfo: 'Je ne peux pas faire cette modification depuis l’assistant.' };
  const acc = input.accountId;
  if (d.documentFromContext) {
    const id = input.reference?.type === 'document' ? input.reference.id : Number((input.pageContext as { documentId?: unknown } | undefined)?.documentId) || null;
    const state = id ? await lookup.getDocumentState(acc, id) : null;
    return state ? { state } : { needInfo: `Quel document voulez-vous ${pourQuoi} ?` };
  }
  const trouves = await lookup.findDocuments(acc, d.documentWords);
  if (trouves.length === 0) return { needInfo: `Je n’ai pas trouvé ce document dans votre compte. Quel document voulez-vous ${pourQuoi} ?` };
  const mots = (t: string) => plain(t).split(/[^a-z0-9]+/).filter(Boolean).join(' ');
  const exacts = trouves.filter((x) => mots(x.title) === d.documentWords.join(' '));
  const retenus = exacts.length === 1 ? exacts : trouves;
  if (retenus.length > 1) {
    const liste = retenus.slice(0, 5).map((x) => `« ${x.title} »${x.documentDate ? ` du ${formatDateFr(x.documentDate)}` : ''}`).join(', ');
    return { needInfo: `Plusieurs documents correspondent : ${liste}. Précisez lequel dans votre demande.` };
  }
  const state = await lookup.getDocumentState(acc, retenus[0].id);
  return state ? { state } : { needInfo: `Je n’ai pas trouvé ce document dans votre compte. Quel document voulez-vous ${pourQuoi} ?` };
}

/**
 * Lot 114 (Trello #753, CDC T2 §14.3 W10, W12, W14, §14.4 « Documents ») :
 *   · lien web : adresse http(s) et titre obligatoires, bien facultatif ; le lien est enregistré, jamais ouvert ;
 *   · modifier : titre, date ou note — un champ à la fois, ancien → nouveau ; la décision de l'utilisateur est
 *     protégée des analyses (règles du tiroir du document) ;
 *   · supprimer : le document quitte le compte (suppression logique), comme depuis la liste des documents.
 */
async function resolveDocumentCommand(
  draft: Extract<CommandDraft, { command: 'CREATE_WEB_DOCUMENT' | 'UPDATE_DOCUMENT' | 'DELETE_DOCUMENT' }>,
  input: AssistantRequestInput,
  lookup: CommandLookup,
  actionId: string,
): Promise<PlannedAction | { needInfo: string }> {
  const acc = input.accountId;

  if (draft.command === 'CREATE_WEB_DOCUMENT') {
    if (!draft.url) return { needInfo: 'Quelle est l’adresse du lien à enregistrer (elle commence par http:// ou https://) ?' };
    const { isValidWebDocumentUrl } = await import('@/services/documents/document-write.facade');
    if (!isValidWebDocumentUrl(draft.url)) return { needInfo: 'Cette adresse ne semble pas valide : elle doit commencer par http:// ou https://.' };
    if (!draft.title) return { needInfo: 'Quel titre voulez-vous donner à ce lien ?' };
    let bien: { id: number; name: string; city?: string | null } | null = null;
    if (draft.assetFromContext) {
      const id = input.reference?.type === 'asset' ? input.reference.id : Number(input.pageContext?.assetId) || null;
      bien = id ? await lookup.getAsset(acc, id) : null;
      if (!bien) return { needInfo: 'À quel bien voulez-vous rattacher ce lien ?' };
    } else if (draft.assetWords.length) {
      const found = await lookup.findAssets(acc, draft.assetWords);
      if (found.length === 0) return { needInfo: 'Je n’ai pas trouvé ce bien dans votre compte. À quel bien voulez-vous rattacher ce lien ?' };
      if (found.length > 1) return { needInfo: `Plusieurs biens correspondent : ${found.slice(0, 5).map((a) => nomBien(a)).join(', ')}. Précisez lequel dans votre demande.` };
      bien = found[0];
    }
    return {
      actionId, command: 'CREATE_WEB_DOCUMENT', dependsOn: [],
      targets: bien ? [{ type: 'asset', id: bien.id, label: nomBien(bien) }] : [],
      params: { kind: 'document_web_create', url: draft.url, linkTitle: draft.title, linkAssetId: bien?.id ?? null },
      preview: `Ajouter le lien « ${draft.title} »${bien ? `, rattaché à ${nomBien(bien)}` : ''}.`,
      effects: [`Titre : ${draft.title}`, `Adresse : ${draft.url}`, bien ? `Bien : ${nomBien(bien)}` : 'Bien : aucun', 'Le lien est enregistré tel quel : la page n’est pas lue.'],
    };
  }

  if (draft.command === 'UPDATE_DOCUMENT') {
    const cible = await documentDesigne(lookup, input, draft, 'modifier');
    if ('needInfo' in cible) return cible;
    const d = cible.state;
    const def = DOCUMENT_FIELD_LABELS[draft.field];
    if (!draft.clear && !draft.value) {
      return { needInfo: draft.field === 'date' ? `Quelle date voulez-vous enregistrer pour « ${d.title} » ?` : `Quelle valeur voulez-vous enregistrer pour ${def.article} de « ${d.title} » ?` };
    }
    const base = { actionId, command: 'UPDATE_DOCUMENT' as const, dependsOn: [], targets: [{ type: 'document' as const, id: d.id, label: d.title }] };
    const params = (newValue: string | null) => ({ kind: 'document_update' as const, documentId: d.id, documentField: draft.field, newValue, expectedVersion: d.version });
    if (draft.field === 'title') {
      const titre = draft.value!.trim().replace(/\s+/g, ' ').slice(0, 200);
      if (titre === d.title) return { needInfo: `Ce document s’appelle déjà « ${d.title} ».` };
      return { ...base, params: params(titre), preview: `Renommer le document « ${d.title} » en « ${titre} ».`, effects: [`Titre : ${d.title} → ${titre}`, 'Ce titre ne sera pas remplacé par une analyse.'] };
    }
    if (draft.field === 'date') {
      if (draft.clear && !d.documentDate) return { needInfo: `« ${d.title} » n’a pas de date enregistrée.` };
      const date = draft.clear ? null : draft.value!;
      if (date === d.documentDate) return { needInfo: `La date de « ${d.title} » est déjà le ${formatDateFr(date!)}.` };
      if (date && date > lookup.today()) return { needInfo: 'La date d’un document ne peut pas être dans le futur. Pouvez-vous la vérifier ?' };
      return {
        ...base, params: params(date),
        preview: date ? `Changer la date du document « ${d.title} » : ${dateOuVide(d.documentDate)} → ${formatDateFr(date)}.` : `Effacer la date du document « ${d.title} » (${dateOuVide(d.documentDate)}).`,
        effects: [`Document : ${d.title}`, `Date du document : ${dateOuVide(d.documentDate)} → ${dateOuVide(date)}`, 'Cette date ne sera pas remplacée par une analyse.'],
      };
    }
    // Note de l'utilisateur (champ unique « Notes / Description »).
    if (draft.clear) {
      if (!d.notesShown.trim()) return { needInfo: `« ${d.title} » n’a aucune note.` };
      return {
        ...base, params: params(null), preview: `Effacer la note du document « ${d.title} ».`,
        effects: [`Document : ${d.title}`, `Note effacée : « ${extrait(d.notesShown)} »`, 'Le champ restera vide : il ne sera pas rempli de nouveau par une analyse.'],
      };
    }
    const note = draft.value!.trim();
    const { NOTES_MAX_LENGTH } = await import('@/lib/documents/notes-description');
    if (note.length > NOTES_MAX_LENGTH) return { needInfo: `Une note fait ${NOTES_MAX_LENGTH} caractères au plus.` };
    if (note === d.notesShown.trim()) return { needInfo: `Cette note est déjà enregistrée sur « ${d.title} ».` };
    return {
      ...base, params: params(note),
      preview: d.notesShown.trim() ? `Remplacer la note du document « ${d.title} ».` : `Ajouter une note au document « ${d.title} ».`,
      effects: [
        `Document : ${d.title}`,
        ...(d.notesShown.trim() ? [`Texte actuel : « ${extrait(d.notesShown)} »`] : []),
        `Nouvelle note : « ${extrait(note)} »`,
      ],
    };
  }

  const cible = await documentDesigne(lookup, input, draft, 'supprimer');
  if ('needInfo' in cible) return cible;
  const d = cible.state;
  return {
    actionId, command: 'DELETE_DOCUMENT', dependsOn: [],
    targets: [{ type: 'document', id: d.id, label: d.title }],
    params: { kind: 'document_delete', documentId: d.id, expectedVersion: d.version },
    preview: `Supprimer le document « ${d.title} »${d.documentDate ? ` du ${formatDateFr(d.documentDate)}` : ''}${d.assetLabel ? ` (${d.assetLabel})` : ''}.`,
    effects: [
      'Le document ne sera plus visible dans votre compte.',
      'Les informations qu’il justifiait sont retirées des fiches concernées, qui sont recalculées.',
      'Cette suppression ne s’annule pas depuis l’Assistant.',
    ],
  };
}

// ── Lot 114 (#753, W18 – W20) : fournisseurs ───────────────────────────────

/** Libellés des coordonnées modifiables depuis l'Assistant (textes à valider par le PO). */
export const SUPPLIER_FIELD_LABELS: Readonly<Record<SupplierCommandField, { label: string; article: string }>> = {
  name: { label: 'Nom', article: 'le nom' },
  phone: { label: 'Téléphone', article: 'le téléphone' },
  email: { label: 'E-mail', article: 'l’e-mail' },
  website: { label: 'Site web', article: 'le site web' },
};
const vide = (v: string | null) => (v && v.trim() ? v : '(vide)');
const pluriel = (n: number, un: string, plusieurs: string) => `${n} ${n > 1 ? plusieurs : un}`;

/** Fiche unique désignée par des mots, ou la précision à demander. */
async function fournisseurDesigne(
  lookup: CommandLookup, accountId: number, words: string[], pourQuoi: string,
): Promise<{ state: SupplierState } | { needInfo: string }> {
  if (!lookup.findSuppliers || !lookup.getSupplierState) return { needInfo: 'Je ne peux pas faire cette modification depuis l’assistant.' };
  const trouves = await lookup.findSuppliers(accountId, words);
  if (trouves.length === 0) return { needInfo: `Je n’ai pas trouvé ce fournisseur dans votre compte. Quel fournisseur voulez-vous ${pourQuoi} ?` };
  // Un nom exact l'emporte sur les fiches qui le contiennent (« Durand » face à « Durand & Fils »).
  const exacts = trouves.filter((s) => plain(s.name).split(/[^a-z0-9]+/).filter(Boolean).join(' ') === words.join(' '));
  const retenus = exacts.length === 1 ? exacts : trouves;
  if (retenus.length > 1) {
    return { needInfo: `Plusieurs fournisseurs correspondent : ${retenus.slice(0, 5).map((s) => s.name).join(', ')}. Précisez lequel dans votre demande.` };
  }
  const state = await lookup.getSupplierState(accountId, retenus[0].id);
  return state ? { state } : { needInfo: `Je n’ai pas trouvé ce fournisseur dans votre compte. Quel fournisseur voulez-vous ${pourQuoi} ?` };
}

/**
 * Lot 114 (Trello #753, CDC T2 §14.3 W18 – W20, §14.4 « Fournisseurs », X65 – X68) :
 *   · créer : seul le nom est demandé ; un doublon CERTAIN n'est jamais créé ; des fiches PROCHES sont annoncées
 *     dans l'aperçu — confirmer vaut décision « fournisseurs distincts », conservée (jamais une fusion par similarité) ;
 *   · modifier : une coordonnée à la fois, validée comme sur la fiche ; l'effacement est une décision protégée ;
 *   · retirer : ARCHIVAGE (règle métier existante) — rien n'est supprimé, les relations sont conservées.
 * Les coordonnées bancaires ne se modifient jamais depuis l'Assistant.
 */
async function resolveSupplierCommand(
  draft: Extract<CommandDraft, { command: 'CREATE_SUPPLIER' | 'UPDATE_SUPPLIER' | 'ARCHIVE_SUPPLIER' }>,
  input: AssistantRequestInput,
  lookup: CommandLookup,
  actionId: string,
): Promise<PlannedAction | { needInfo: string }> {
  const acc = input.accountId;
  const { validateSupplierPatch } = await import('@/services/suppliers/supplier-validation');

  if (draft.command === 'CREATE_SUPPLIER') {
    if (!draft.name) return { needInfo: 'Quel est le nom du fournisseur à créer ?' };
    const v = validateSupplierPatch({ name: draft.name, ...(draft.phone ? { phone: draft.phone } : {}), ...(draft.email ? { email: draft.email } : {}), ...(draft.website ? { website: draft.website } : {}) });
    if (!v.ok) {
      return { needInfo: v.field === 'email' ? 'Cette adresse e-mail ne semble pas valide. Pouvez-vous la vérifier ?' : 'Ces informations ne peuvent pas être enregistrées telles quelles. Pouvez-vous les vérifier ?' };
    }
    const nom = v.updates.name!;
    const doublon = lookup.supplierDuplicates ? await lookup.supplierDuplicates(acc, nom) : { decision: 'new' as const, candidates: [] };
    if (doublon.decision === 'certain' && doublon.candidates[0]) {
      return { needInfo: `Le fournisseur « ${doublon.candidates[0].name} » existe déjà dans votre compte : je ne crée pas de doublon.` };
    }
    const proches = doublon.decision === 'uncertain' ? doublon.candidates : [];
    return {
      actionId, command: 'CREATE_SUPPLIER', targets: [], dependsOn: [],
      params: {
        kind: 'supplier_create', name: nom, phone: v.updates.phone ?? null, email: v.updates.email ?? null, website: v.updates.website ?? null,
        distinctFrom: proches.map((c) => c.id),
      },
      preview: `Créer le fournisseur « ${nom} ».`,
      effects: [
        `Nom : ${nom}`,
        ...(v.updates.phone ? [`Téléphone : ${v.updates.phone}`] : []),
        ...(v.updates.email ? [`E-mail : ${v.updates.email}`] : []),
        ...(v.updates.website ? [`Site web : ${v.updates.website}`] : []),
        ...(proches.length ? [
          `Attention : ${proches.length > 1 ? 'des fournisseurs proches existent' : 'un fournisseur proche existe'} déjà : ${proches.map((c) => `« ${c.name} »`).join(', ')}.`,
          'En confirmant, vous indiquez qu’il s’agit d’un fournisseur différent : ce choix sera conservé.',
        ] : []),
      ],
    };
  }

  if (draft.command === 'UPDATE_SUPPLIER') {
    const cible = await fournisseurDesigne(lookup, acc, draft.supplierWords, 'modifier');
    if ('needInfo' in cible) return cible;
    const s = cible.state;
    const def = SUPPLIER_FIELD_LABELS[draft.field];
    if (draft.field === 'name' && draft.clear) return { needInfo: 'Le nom d’un fournisseur ne peut pas être vide.' };
    if (!draft.clear && !draft.value) return { needInfo: `Quelle valeur voulez-vous enregistrer pour ${def.article} de « ${s.name} » ?` };
    const v = validateSupplierPatch({ [draft.field]: draft.clear ? '' : draft.value });
    if (!v.ok) {
      return { needInfo: draft.field === 'email' ? 'Cette adresse e-mail ne semble pas valide. Pouvez-vous la vérifier ?' : 'Cette valeur ne peut pas être enregistrée telle quelle. Pouvez-vous la vérifier ?' };
    }
    const nouvelle = (v.updates[draft.field] ?? null) as string | null;
    const actuelle = s[draft.field];
    if ((actuelle ?? '') === (nouvelle ?? '')) {
      return { needInfo: nouvelle ? `${def.label} de « ${s.name} » : c’est déjà ${nouvelle}.` : `${def.label} de « ${s.name} » : aucune valeur n’est enregistrée.` };
    }
    return {
      actionId, command: 'UPDATE_SUPPLIER', dependsOn: [],
      targets: [{ type: 'supplier', id: s.id, label: s.name }],
      params: { kind: 'supplier_update', supplierId: s.id, patch: { [draft.field]: nouvelle }, expectedVersion: s.version },
      preview: nouvelle
        ? `Modifier ${def.article} du fournisseur « ${s.name} » : ${vide(actuelle)} → ${nouvelle}.`
        : `Effacer ${def.article} du fournisseur « ${s.name} » (${vide(actuelle)}).`,
      effects: [
        `Fournisseur : ${s.name}`,
        `${def.label} : ${vide(actuelle)} → ${vide(nouvelle)}`,
        nouvelle ? 'Cette valeur ne sera pas remplacée par celle d’un document.' : 'Cette valeur ne sera pas rétablie par un document.',
      ],
    };
  }

  const cible = await fournisseurDesigne(lookup, acc, draft.supplierWords, 'archiver');
  if ('needInfo' in cible) return cible;
  const s = cible.state;
  if (s.status === 'archived') return { needInfo: `Le fournisseur « ${s.name} » est déjà archivé.` };
  const liens = [
    ...(s.links.documents ? [pluriel(s.links.documents, 'document', 'documents')] : []),
    ...(s.links.assets ? [pluriel(s.links.assets, 'bien', 'biens')] : []),
    ...(s.links.equipments ? [pluriel(s.links.equipments, 'équipement', 'équipements')] : []),
    ...(s.links.agenda ? [pluriel(s.links.agenda, 'échéance', 'échéances')] : []),
  ];
  return {
    actionId, command: 'ARCHIVE_SUPPLIER', dependsOn: [],
    targets: [{ type: 'supplier', id: s.id, label: s.name }],
    params: { kind: 'supplier_archive', supplierId: s.id, expectedVersion: s.version },
    preview: `Archiver le fournisseur « ${s.name} ».`,
    effects: [
      'Un fournisseur ne se supprime pas : il est archivé.',
      liens.length ? `Conservés et toujours rattachés à lui : ${liens.join(', ')}.` : 'Aucun document, bien, équipement ni échéance ne lui est rattaché.',
      'Sa fiche reste consultable et peut être réactivée depuis vos fournisseurs.',
    ],
  };
}

const quandFr = (d: string | null) => (d ? `du ${formatDateFr(d)}` : `(${undatedLabel({}).toLowerCase()})`);
const designer = (c: AgendaCandidate) => `« ${c.title} » ${quandFr(c.startDate)}${c.assetLabel ? ` — ${c.assetLabel}` : ''}`;

/**
 * Lot 114B (Trello #753, CDC T2 §9.6, §14.4 « Agenda », M28, W16 / W17) —
 * modifier ou supprimer UNE échéance retrouvée dans le compte.
 *
 *   · aucune échéance, ou plusieurs également plausibles : on demande, on
 *     n'écrit rien et on ne choisit jamais à la place de l'utilisateur ;
 *   · l'état présenté (titre, date) est figé par son empreinte : s'il change
 *     avant la confirmation, l'exécution refuse ;
 *   · suppression : portée OCCURRENCE par défaut ; SERIES seulement si elle
 *     est demandée ET si l'échéance appartient à une série — le nombre
 *     d'échéances supprimées est annoncé et recontrôlé à l'exécution.
 */
async function resolveAgendaChange(
  draft: Extract<CommandDraft, { command: 'UPDATE_AGENDA_ITEM' | 'DELETE_AGENDA_ITEM' }>,
  input: AssistantRequestInput,
  lookup: CommandLookup,
  actionId: string,
): Promise<PlannedAction | { needInfo: string }> {
  const acc = input.accountId;
  if (!lookup.findAgendaItems) return { needInfo: 'Je ne peux pas faire cette modification depuis l’assistant.' };
  const verbe = draft.command === 'DELETE_AGENDA_ITEM' ? 'supprimer' : 'modifier';

  // Bien désigné : il restreint la recherche, il ne remplace jamais l'échéance.
  let assetIds: number[] = [];
  if (draft.assetFromContext) {
    const id = input.reference?.type === 'asset' ? input.reference.id : Number(input.pageContext?.assetId) || null;
    const a = id ? await lookup.getAsset(acc, id) : null;
    if (!a) return { needInfo: `Pour quel bien voulez-vous ${verbe} cette échéance ?` };
    assetIds = [a.id];
  } else if (draft.assetWords.length) {
    const found = await lookup.findAssets(acc, draft.assetWords);
    if (found.length === 0) return { needInfo: 'Je n’ai pas trouvé ce bien dans votre compte. De quelle échéance parlez-vous ?' };
    assetIds = found.map((a) => a.id);
  }
  if (draft.itemWords.length === 0 && !draft.itemDate && assetIds.length === 0) {
    return { needInfo: `Quelle échéance voulez-vous ${verbe} ? Indiquez son titre ou sa date.` };
  }

  const trouves = await lookup.findAgendaItems(acc, { words: draft.itemWords, date: draft.itemDate, assetIds });
  if (trouves.length === 0) return { needInfo: 'Je n’ai pas trouvé cette échéance dans votre Agenda. Indiquez son titre exact ou sa date.' };
  // Une série entière demandée : ses échéances ne sont pas des candidats concurrents.
  const serie = draft.command === 'DELETE_AGENDA_ITEM' && draft.scope === 'SERIES';
  const memeSerie = serie && trouves.length > 1 && trouves.every((c) => c.seriesCount === trouves[0].seriesCount && c.seriesCount >= trouves.length && c.title === trouves[0].title);
  if (trouves.length > 1 && !memeSerie) {
    return { needInfo: `Plusieurs échéances correspondent : ${trouves.slice(0, 5).map(designer).join(' ; ')}${trouves.length > 5 ? '…' : ''}. Précisez laquelle (titre et date) dans votre demande.` };
  }
  const c = trouves[0];
  const targets: PlannedAction['targets'] = [{ type: 'agenda_item', id: c.id, label: c.title }];

  if (draft.command === 'DELETE_AGENDA_ITEM') {
    if (serie && c.seriesCount <= 1) {
      return { needInfo: `L’échéance ${designer(c)} n’appartient pas à une série. Voulez-vous supprimer cette échéance seule ?` };
    }
    const scope = serie ? 'SERIES' as const : 'OCCURRENCE' as const;
    const n = scope === 'SERIES' ? c.seriesCount : 1;
    return {
      actionId, command: 'DELETE_AGENDA_ITEM', targets, dependsOn: [],
      params: { kind: 'agenda_delete', agendaItemId: c.id, scope, expectedVersion: c.version, expectedCount: n },
      preview: scope === 'SERIES'
        ? `Supprimer toute la série « ${c.title} » : ${n} échéances.`
        : `Supprimer l’échéance ${designer(c)}.`,
      effects: [
        `Titre : ${c.title}`,
        scope === 'SERIES' ? `Portée : toute la série (${n} échéances)` : `Portée : cette échéance seulement${c.seriesCount > 1 ? ` (les ${c.seriesCount - 1} autres de la série sont conservées)` : ''}`,
        c.assetLabel ? `Bien : ${c.assetLabel}` : 'Bien : aucun',
        'Suppression définitive : elle ne pourra pas être annulée depuis l’assistant.',
      ],
    };
  }

  const patch: { title?: string; startDate?: string | null } = {};
  if (draft.newDate && draft.newDate !== c.startDate) patch.startDate = draft.newDate;
  if (draft.newTitle && draft.newTitle !== c.title) patch.title = draft.newTitle;
  if (Object.keys(patch).length === 0) return { needInfo: `L’échéance ${designer(c)} a déjà cette valeur : rien à modifier.` };
  const changements = [
    patch.title !== undefined ? `Titre : ${c.title} → ${patch.title}` : null,
    patch.startDate !== undefined ? `Date : ${c.startDate ? formatDateFr(c.startDate) : undatedLabel({})} → ${formatDateFr(patch.startDate!)}` : null,
  ].filter((x): x is string => !!x);
  return {
    actionId, command: 'UPDATE_AGENDA_ITEM', targets, dependsOn: [],
    params: { kind: 'agenda_update', agendaItemId: c.id, patch, expectedVersion: c.version },
    preview: patch.startDate !== undefined && patch.title === undefined
      ? `Déplacer l’échéance ${designer(c)} au ${formatDateFr(patch.startDate!)}.`
      : `Modifier l’échéance ${designer(c)} : ${changements.join(' ; ')}.`,
    effects: [...changements, c.assetLabel ? `Bien : ${c.assetLabel}` : 'Bien : aucun'],
  };
}

/**
 * Modification d'une caractéristique : bien trouvé dans le compte, champ
 * applicable à sa famille, valeur valide selon les règles de la fiche,
 * ancienne valeur lue — et présentée — avant toute confirmation.
 */
async function resolveAssetFieldUpdate(
  draft: Extract<CommandDraft, { command: 'UPDATE_ASSET_FIELD' }>,
  input: AssistantRequestInput,
  lookup: CommandLookup,
  actionId: string,
  // Lot 54E (#419 §15) : proposition issue d'UNDERSTAND — capacité et bien
  // déjà résolus par le SERVEUR ; mêmes contrôles et même plan ensuite.
  opts: { def?: AssetFieldDefinition; assetId?: number | null; applicable?: (asset: AssetState) => string | null } = {},
): Promise<PlannedAction | { needInfo: string }> {
  const def = opts.def ?? ASSISTANT_ASSET_FIELDS.find((f) => f.key === draft.field);
  if (!def || !lookup.getAssetState) return { needInfo: 'Je ne peux pas modifier ce champ depuis l’assistant.' };

  // Le bien : nommé, ou celui du fil / de la page.
  let assetId: number | null = opts.assetId ?? null;
  if (assetId) {
    // Bien déjà résolu par le serveur (proposition de mise à jour).
  } else if (draft.assetWords.length) {
    const found = await lookup.findAssets(input.accountId, draft.assetWords);
    if (found.length === 0) return { needInfo: `Je n’ai pas trouvé ce bien dans votre compte. Pour quel bien voulez-vous modifier « ${def.label} » ?` };
    if (found.length > 1) {
      return { needInfo: `Plusieurs biens correspondent : ${found.slice(0, 5).map((a) => nomBien(a)).join(', ')}. Précisez lequel.` };
    }
    assetId = found[0].id;
  } else if (input.reference?.type === 'asset') {
    assetId = input.reference.id;
  } else if (Number(input.pageContext?.assetId)) {
    assetId = Number(input.pageContext?.assetId);
  }
  if (!assetId) return { needInfo: `Pour quel bien voulez-vous modifier « ${def.label} » ?` };

  const asset = await lookup.getAssetState(input.accountId, assetId);
  if (!asset) return { needInfo: 'Je n’ai pas trouvé ce bien dans votre compte.' };
  if (asset.status === 'ARCHIVED' || (asset.lockState && asset.lockState !== 'NONE')) {
    return { needInfo: `${nomBien(asset)} n’est pas modifiable actuellement (bien archivé ou verrouillé par votre offre).` };
  }
  const section = def.sections[familyOf(asset.category)];
  if (!section) return { needInfo: `« ${def.label} » ne s’applique pas à ${nomBien(asset)}.` };
  const nonApplicable = opts.applicable?.(asset) ?? null;
  if (nonApplicable) return { needInfo: nonApplicable };

  if (draft.value === null) {
    const attendu = def.type === 'date' ? 'une date complète, par exemple 25/05/2021' : def.type === 'number' ? 'un nombre' : 'une valeur';
    return { needInfo: `Quelle valeur voulez-vous pour « ${def.label} » de ${nomBien(asset)} ? Indiquez ${attendu}.` };
  }

  const previous = asset.characteristics[def.key] ?? null;
  // Mêmes contrôles que l'enregistrement depuis la fiche.
  const erreurs = validateDetailChanges({ [def.key]: draft.value }, { [def.key]: previous }, lookup.today());
  if (erreurs.length) return { needInfo: erreurs.map((e) => e.message).join(' ') };
  if (previous !== null && String(previous) === String(draft.value)) {
    return { needInfo: `« ${def.label} » de ${nomBien(asset)} vaut déjà ${formatFieldValue(def, draft.value)}.` };
  }

  const avant = formatFieldValue(def, previous);
  const apres = formatFieldValue(def, draft.value);
  return {
    actionId, command: 'UPDATE_ASSET_FIELD', dependsOn: [],
    targets: [{ type: 'asset', id: asset.id, label: nomBien(asset) }],
    params: { assetId: asset.id, section, field: def.key, value: draft.value, previous },
    preview: `Modifier « ${def.label} » de ${nomBien(asset)} : ${avant} → ${apres}.`,
    effects: [
      `Bien : ${nomBien(asset)}`,
      `Champ : ${def.label}`,
      `Valeur actuelle : ${avant}`,
      `Nouvelle valeur : ${apres}`,
    ],
  };
}

// ── Empreinte et persistance ───────────────────────────────────────────────

export const hashActions = (payload: string) => createHash('sha256').update(payload).digest('hex');

/** Libellé d'une commande retirée encore présente dans un plan ancien (#715 : « réalisé » / « annulé »). */
export const RETIRED_COMMAND_LABEL = 'Action retirée';

function toPreview(plan: StoredPlan): CommandPlanPreview {
  return {
    planId: plan.planId,
    summary: plan.summary,
    expiresAt: plan.expiresAt,
    actions: plan.actions.map((a) => ({
      // #715 (lot 113P) : un plan ancien peut porter une commande retirée (statut d'échéance).
      actionId: a.actionId, label: WRITE_COMMAND_CATALOG[a.command]?.label ?? RETIRED_COMMAND_LABEL,
      preview: a.preview, effects: a.effects, dependsOn: a.dependsOn,
    })),
  };
}

export async function tracer(planId: string, accountId: number, userId: number | null, event: string, detail: Record<string, unknown> = {}) {
  try {
    await pgClient.unsafe(
      `INSERT INTO verebona_command_events (plan_id, account_id, user_id, event_type, detail_json) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [planId, accountId, userId, event, JSON.stringify(detail)] as never[],
    );
  } catch (e) {
    console.error('[verebona] trace de commande non enregistrée :', (e as Error).message);
  }
}

async function savePlan(plan: StoredPlan, requestId: string | null): Promise<void> {
  const payload = JSON.stringify(plan.actions);
  await pgClient.unsafe(
    `INSERT INTO verebona_command_plans
       (plan_id, account_id, user_id, conversation_id, request_id, status, summary, actions_payload, params_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'PENDING_CONFIRMATION', $6, $7, $8, $9)`,
    [plan.planId, plan.accountId, plan.userId, plan.conversationId, requestId, plan.summary, payload, hashActions(payload), plan.expiresAt] as never[],
  );
  await tracer(plan.planId, plan.accountId, plan.userId, 'PREPARED', { summary: plan.summary, actions: plan.actions });
}

/**
 * Prépare un plan si le message est une commande claire. Rien n'est écrit
 * dans les données métier : seul le plan (en attente) est enregistré.
 */
export async function prepareCommand(
  input: AssistantRequestInput,
  lookup: CommandLookup = sqlLookup,
  now: Date = new Date(),
): Promise<Preparation | null> {
  const segments = parseCommands(input.message, lookup.today());
  if (!segments) return null;

  // Construction du plan : chaque segment résolu dans le compte ; « puis »
  // rend un segment dépendant de TOUTES les actions du précédent.
  const actions: PlannedAction[] = [];
  let precedent: string[] = [];
  for (const [i, seg] of segments.entries()) {
    const r = await resolveDraft(seg.draft, input, lookup, `a${i + 1}`);
    if ('needInfo' in r) {
      // Un plan partiellement compris n'est jamais proposé.
      return { kind: 'need_info', message: segments.length > 1 ? `Action ${i + 1} : ${r.needInfo}` : r.needInfo };
    }
    const lot = Array.isArray(r) ? r : [r];
    if (seg.dependsOnPrevious) for (const a of lot) a.dependsOn = [...precedent];
    actions.push(...lot);
    precedent = lot.map((a) => a.actionId);
  }

  const summary = actions.length === 1
    ? `${actions[0].preview} Confirmez-vous ?`
    : segments.length === 1
      ? `${actions.length} échéances concernées : chacune sera traitée séparément. Confirmez-vous l’ensemble ?`
      : `Je vais effectuer ${actions.length} actions, dans l’ordre indiqué. Confirmez-vous l’ensemble ?`;
  const plan: StoredPlan = {
    planId: randomUUID(),
    accountId: input.accountId,
    userId: input.userId,
    conversationId: input.conversationId ?? null,
    summary,
    actions,
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
  };
  await savePlan(plan, null);
  return { kind: 'plan', plan, preview: toPreview(plan) };
}

// ── Proposition de mise à jour issue d'UNDERSTAND (lot 54E, #419 §15) ─────

/**
 * Capacité d'écriture RÉELLE d'une information apportée (pure, testée) —
 * résolue par le SERVEUR à partir d'une clé du FIELD_CATALOG, jamais choisie
 * par le modèle (ni table, ni colonne, ni identifiant) :
 *   · `asset_field`      champ modifiable depuis l'assistant (registre,
 *                        `assistantWritable`) — même liste que la commande ;
 *   · `asset_tenure_end` « Fin de contrat prévue » de la fiche (LLD / LOA,
 *                        bail, prêt) : la clé qui s'applique à la SITUATION
 *                        du bien, saisie dans la section usage de la fiche.
 * Extensible : une capacité future (champ d'opération…) s'ajoute ici.
 */
type UpdateCapability =
  | { type: 'asset_field'; def: AssetFieldDefinition }
  | { type: 'asset_tenure_end'; def: AssetFieldDefinition };

const TENURE_SECTIONS: Record<string, string> = { IMMOBILIER: 'occupancy_usage', VEHICULE: 'vehicle_usage', OBJET: 'object_usage' };

export function updateCapabilityFor(fieldKey: string | null): UpdateCapability | null {
  if (!fieldKey) return null;
  const champ = ASSISTANT_ASSET_FIELDS.find((f) => f.key === fieldKey);
  if (champ) return { type: 'asset_field', def: champ };
  if (fieldKey === 'leaseEndDate' || fieldKey === 'contractEndDate') {
    const reg = getField(fieldKey);
    if (!reg) return null;
    const familles = reg.families.map((f) => (f === 'OBJECT' ? 'OBJET' : f)) as Array<'IMMOBILIER' | 'VEHICULE' | 'OBJET'>;
    const sections: AssetFieldDefinition['sections'] = {};
    for (const f of familles) if (TENURE_SECTIONS[f]) sections[f] = TENURE_SECTIONS[f];
    return { type: 'asset_tenure_end', def: { key: fieldKey, label: TENURE_END_LABEL, sections, type: 'date', aliases: [] } };
  }
  return null;
}

/**
 * Valeur proposée, VALIDÉE par le serveur (pure, testée) : type du champ, et
 * présence dans le message de l'utilisateur — le modèle ne peut pas
 * introduire une valeur que l'utilisateur n'a pas donnée.
 */
export function validateSuppliedValue(def: AssetFieldDefinition, fact: Pick<SuppliedFact, 'value' | 'normalizedValue'>, message: string, today: string): string | number | null {
  const brut = (fact.normalizedValue ?? fact.value ?? '').trim();
  if (!brut) return null;
  if (def.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(brut)) return null;
    const [y, m, d] = brut.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return message.includes(brut) || parseDateFr(message, today) === brut ? brut : null;
  }
  if (def.type === 'number') {
    const n = Number(brut.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'));
    if (!Number.isFinite(n)) return null;
    const nombres = (plain(message).match(/\d{1,3}(?:[ \u00a0\u202f.]\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g) ?? [])
      .map((x) => Number(x.replace(/[ \u00a0\u202f.]/g, '').replace(',', '.')));
    const k = /k(?:€|m)?\b/.test(plain(message)) ? nombres.map((x) => x * 1000) : [];
    return [...nombres, ...k].includes(n) ? n : null;
  }
  return brut.length >= 2 && brut.length <= 80 && plain(message).includes(plain(brut)) ? brut : null;
}

type ProposalPreparation =
  | { kind: 'plan'; plan: StoredPlan; preview: CommandPlanPreview; capability: UpdateCapability['type']; proposed?: number; refused?: ProposalRefusal[] }
  | { kind: 'need_info'; message: string; reason: string; capability: UpdateCapability['type'] | null; proposed?: number; refused?: ProposalRefusal[] };

/** Information apportée NON proposée, et pourquoi (lot 59, #419 R08 — jamais abandonnée en silence). */
interface ProposalRefusal { fieldKey: string | null; reason: string; message: string }

type ProposalRequest = { fact: SuppliedFact; assetId: number | null };

/**
 * Prépare un plan PENDING_CONFIRMATION à partir d'une information APPORTÉE
 * (UPDATE_PROPOSAL compris par T2). Même résolution, mêmes contrôles (bien
 * du compte, disponibilité, verrou, famille, règles de la fiche, valeur
 * actuelle), même table de plans et MÊME confirmation que les commandes :
 * aucun second mécanisme, aucune écriture ici.
 *
 * Lot 59 (#419 R08) : TOUTES les informations apportées (`req` puis
 * `req.more`) sont traitées. Toutes validées → UN plan regroupant chaque
 * modification (confirmation unique) ; une seule refusée → AUCUN plan
 * partiel : le refus est expliqué information par information et
 * l'utilisateur est invité à préciser ou séparer sa demande.
 */
export async function prepareUpdateProposal(
  input: AssistantRequestInput,
  req: ProposalRequest & { more?: ProposalRequest[] },
  lookup: CommandLookup = sqlLookup,
  now: Date = new Date(),
): Promise<ProposalPreparation> {
  const demandes: ProposalRequest[] = [{ fact: req.fact, assetId: req.assetId }, ...(req.more ?? [])];
  const multiple = demandes.length > 1;
  const actions: PlannedAction[] = [];
  const caps: UpdateCapability['type'][] = [];
  const refused: ProposalRefusal[] = [];
  let premierRefus: { message: string; reason: string; capability: UpdateCapability['type'] | null } | null = null;
  const refuser = (fieldKey: string | null, reason: string, message: string, capability: UpdateCapability['type'] | null) => {
    refused.push({ fieldKey, reason, message });
    premierRefus ??= { message, reason, capability };
  };
  for (const [i, d] of demandes.entries()) {
    const cap = updateCapabilityFor(d.fact.fieldKey);
    if (!cap) {
      // Lot 75J (#419 R08) : champ NON résolu (information non identifiée) ≠ champ connu non modifiable.
      if (!d.fact.fieldKey || !getField(d.fact.fieldKey)) {
        const quoi = (d.fact.topic ?? d.fact.value ?? '').trim();
        refuser(d.fact.fieldKey ?? null, 'NO_FIELD',
          `Je n’ai pas identifié quelle information modifier${quoi ? ` (« ${quoi.slice(0, 60)} »)` : ''} : rien n’a été modifié. Précisez le champ concerné.`, null);
        continue;
      }
      refuser(d.fact.fieldKey ?? null, 'FIELD_NOT_WRITABLE',
        'Merci pour cette information. Je ne peux pas l’enregistrer depuis l’assistant : rien n’a été modifié. Vous pouvez la renseigner depuis la fiche concernée.', null);
      continue;
    }
    // Lot 75J (#419 R08) : information reconnue SANS valeur — la valeur manque (jamais ignorée).
    if (!(d.fact.normalizedValue ?? d.fact.value ?? '').trim()) {
      refuser(cap.def.key, 'VALUE_MISSING', `Il me manque la valeur de « ${cap.def.label} » : rien n’a été modifié. Indiquez-la.`, cap.type);
      continue;
    }
    const valeur = validateSuppliedValue(cap.def, d.fact, input.message, lookup.today());
    if (valeur === null) {
      refuser(cap.def.key, 'VALUE_NOT_VALIDATED',
        `Je n’ai pas pu relire avec certitude la valeur de « ${cap.def.label} » dans votre message : rien n’a été modifié. Précisez-la, par exemple « 21/05/2027 ».`, cap.type);
      continue;
    }
    const draft: Extract<CommandDraft, { command: 'UPDATE_ASSET_FIELD' }> = {
      command: 'UPDATE_ASSET_FIELD', field: cap.def.key, value: valeur, assetWords: [], assetFromContext: false,
    };
    const applicable = cap.type === 'asset_tenure_end'
      ? (a: AssetState) => (tenureEndKey(familyOf(a.category), a.characteristics) === cap.def.key ? null
        : `« ${cap.def.label} » ne s’applique pas à la situation actuelle de ${nomBien(a)} (${tenureSituationHint(familyOf(a.category), a.characteristics)}) : rien n’a été modifié.`)
      : undefined;
    const r = await resolveAssetFieldUpdate(draft, input, lookup, `a${i + 1}`, { def: cap.def, assetId: d.assetId, applicable });
    if ('needInfo' in r) { refuser(cap.def.key, 'RESOLUTION', r.needInfo, cap.type); continue; }
    // Deux valeurs DIFFÉRENTES pour la même information du même bien : jamais un choix arbitraire.
    const cle = (a: PlannedAction) => ('field' in a.params ? `${a.params.assetId}:${a.params.field}` : a.actionId);
    const doublon = actions.find((a) => cle(a) === cle(r));
    if (doublon && 'value' in doublon.params && 'value' in r.params && String(doublon.params.value) === String(r.params.value)) continue;
    if (doublon) {
      refuser(cap.def.key, 'CONFLICTING_VALUES', `Votre message donne deux valeurs pour « ${cap.def.label} » : rien n’a été modifié. Précisez la bonne valeur.`, cap.type);
      continue;
    }
    actions.push(r);
    caps.push(cap.type);
  }
  if (refused.length) {
    const p = premierRefus!;
    if (!multiple) return { kind: 'need_info', message: p.message, reason: p.reason, capability: p.capability, proposed: 0, refused };
    const message = `Votre message contient ${demandes.length} informations ; je ne peux pas toutes les proposer, donc je n’ai rien préparé et rien n’a été modifié. `
      + refused.map((x) => x.message.replace(/\s*:?\s*rien n’a été modifié\.?/g, '').replace(/\s+$/, '')).map((m) => `— ${m.replace(/\.$/, '')}.`).join(' ')
      + ' Précisez ces informations ou envoyez-les séparément.';
    return { kind: 'need_info', message, reason: multiple ? 'MULTIPLE_PARTIALLY_REFUSED' : p.reason, capability: p.capability, proposed: 0, refused };
  }
  const summary = actions.length === 1
    ? `${actions[0].preview} Confirmez-vous ?`
    : `Je vais effectuer ${actions.length} modifications : ${actions.map((a) => a.preview.replace(/\.$/, '')).join(' ; ')}. Confirmez-vous l’ensemble ?`;
  const plan: StoredPlan = {
    planId: randomUUID(), accountId: input.accountId, userId: input.userId, conversationId: input.conversationId ?? null,
    summary, actions, expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
  };
  await savePlan(plan, null);
  await tracer(plan.planId, plan.accountId, plan.userId, 'PROPOSED_FROM_UNDERSTAND', { capability: caps[0], capabilities: caps, fields: actions.map((a) => ('field' in a.params ? a.params.field : null)) });
  return { kind: 'plan', plan, preview: toPreview(plan), capability: caps[0], proposed: actions.length, refused: [] };
}

// ── Confirmation et exécution ──────────────────────────────────────────────

export type Confirmation =
  | {
      ok: true; status: PlanStatus; results: ActionResult[]; summary: string;
      /** Fin de la fenêtre « Annuler » (undo.service) ; null si le plan n'est pas annulable. */
      undoUntil: string | null;
    }
  | { ok: false; code: 'PLAN_NOT_FOUND' | 'PLAN_EXPIRED' | 'PLAN_ALREADY_HANDLED' | 'PLAN_INTEGRITY' | 'WRITE_REFUSED'; message: string; status?: PlanStatus };

/**
 * Exécution ordonnée d'un plan.
 *
 * Chaque action s'exécute seulement si TOUTES ses dépendances ont réussi ;
 * sinon SKIPPED_DEPENDENCY (et ses propres dépendantes à leur tour). Une
 * action indépendante continue malgré l'échec d'une autre. Aucun retour
 * arrière automatique : ce qui a réussi reste acquis (l'utilisateur peut
 * ensuite « Annuler » un plan réversible, voir undo.service).
 */
export async function executeActions(
  actions: PlannedAction[],
  ctx: ExecutionContext,
  // Lot 114B : jeu d'exécuteurs éventuellement partiel (tests) — une commande sans exécuteur est refusée, jamais exécutée.
  executors: Partial<Record<PlannedAction['command'], Executor>> = EXECUTORS,
): Promise<ActionResult[]> {
  const byId = new Map<string, ActionResult>();
  const results: ActionResult[] = [];
  for (const a of actions) {
    const bloquante = a.dependsOn.find((d) => byId.get(d)?.status !== 'SUCCESS');
    const r: ActionResult = bloquante
      ? { actionId: a.actionId, status: 'SKIPPED_DEPENDENCY', message: `${a.preview.replace(/\.$/, '')} — non exécutée : l’action ${bloquante} n’a pas réussi.` }
      : await runAction(a, ctx, executors);
    byId.set(a.actionId, r);
    results.push(r);
  }
  return results;
}

export function planStatusFrom(results: ActionResult[]): PlanStatus {
  const ok = results.filter((r) => r.status === 'SUCCESS').length;
  if (ok === results.length) return 'EXECUTED';
  return ok > 0 ? 'PARTIAL' : 'FAILED';
}

export function summarizeResults(results: ActionResult[]): string {
  if (results.length === 1) return results[0].message;
  const n = (s: string) => results.filter((r) => r.status === s).length;
  const parts = [`${n('SUCCESS')} réussie(s)`];
  if (n('FAILED')) parts.push(`${n('FAILED')} en échec`);
  if (n('SKIPPED_DEPENDENCY')) parts.push(`${n('SKIPPED_DEPENDENCY')} non exécutée(s) (dépendance en échec)`);
  if (n('REFUSED')) parts.push(`${n('REFUSED')} refusée(s)`);
  // Lot 75J (#419 R08) : échec PARTIEL restitué action par action (ce qui n'a pas été fait et pourquoi).
  const echecs = results.filter((r) => r.status !== 'SUCCESS').map((r) => `— ${String(r.message ?? '').replace(/\.$/, '')}.`);
  return `Plan exécuté : ${parts.join(', ')}.${echecs.length ? ` ${echecs.join(' ')}` : ''}`;
}

export async function confirmCommandPlan(
  p: { planId: string; accountId: number; userId: number },
  deps: {
    executors?: Partial<Record<PlannedAction['command'], Executor>>;
    canWrite?: (accountId: number) => Promise<{ allowed: boolean; message?: string }>;
  } = {},
): Promise<Confirmation> {
  // Prise atomique : propriétaire, en attente, non expiré.
  const pris = (await pgClient.unsafe(
    `UPDATE verebona_command_plans
        SET status = 'EXECUTING', confirmed_at = now()
      WHERE plan_id = $1 AND account_id = $2 AND user_id = $3
        AND status = 'PENDING_CONFIRMATION' AND expires_at > now()
      RETURNING actions_payload, params_hash, summary, conversation_id AS "conversationId", message_id AS "messageId"`,
    [p.planId, p.accountId, p.userId] as never[],
  )) as unknown as Array<{ actions_payload: string; params_hash: string; summary: string; conversationId: number | null; messageId: number | null }>;

  if (!pris[0]) {
    const [etat] = (await pgClient.unsafe(
      `SELECT status, expires_at < now() AS expired, conversation_id AS "conversationId", message_id AS "messageId"
         FROM verebona_command_plans
        WHERE plan_id = $1 AND account_id = $2 AND user_id = $3`,
      [p.planId, p.accountId, p.userId] as never[],
    )) as unknown as Array<{ status: PlanStatus; expired: boolean; conversationId?: number | null; messageId?: number | null }>;
    if (!etat) return { ok: false, code: 'PLAN_NOT_FOUND', message: 'Cette action n’existe pas ou ne vous appartient pas.' };
    if (etat.status === 'EXPIRED' || (etat.status === 'PENDING_CONFIRMATION' && etat.expired)) {
      if (etat.status === 'PENDING_CONFIRMATION') {
        await pgClient.unsafe(`UPDATE verebona_command_plans SET status = 'EXPIRED' WHERE plan_id = $1 AND status = 'PENDING_CONFIRMATION'`, [p.planId] as never[]);
        await tracer(p.planId, p.accountId, p.userId, 'EXPIRED');
        await recordPlanOutcome({ ...p, conversationId: etat.conversationId ?? null, messageId: etat.messageId ?? null }, EXPIRED_MESSAGE);
      }
      return { ok: false, code: 'PLAN_EXPIRED', message: EXPIRED_MESSAGE, status: 'EXPIRED' };
    }
    if (etat.status === 'CANCELLED') {
      return { ok: false, code: 'PLAN_ALREADY_HANDLED', message: 'Cette action a été annulée : rien n’a été modifié.', status: 'CANCELLED' };
    }
    return { ok: false, code: 'PLAN_ALREADY_HANDLED', message: 'Cette action a déjà été traitée.', status: etat.status };
  }

  const fin = async (status: PlanStatus, results: ActionResult[]) => {
    await pgClient.unsafe(
      `UPDATE verebona_command_plans SET status = $2, results_json = $3::jsonb, executed_at = now() WHERE plan_id = $1`,
      [p.planId, status, JSON.stringify(results)] as never[],
    );
  };

  await tracer(p.planId, p.accountId, p.userId, 'CONFIRMED');
  const fil = { ...p, conversationId: pris[0].conversationId ?? null, messageId: pris[0].messageId ?? null };

  // Paramètres figés : l'empreinte doit correspondre à ce qui a été présenté.
  if (hashActions(pris[0].actions_payload) !== pris[0].params_hash) {
    await fin('FAILED', []);
    await tracer(p.planId, p.accountId, p.userId, 'INTEGRITY_FAILED');
    const message = 'Cette action ne peut pas être exécutée. Refaites votre demande.';
    await recordPlanOutcome(fil, message);
    return { ok: false, code: 'PLAN_INTEGRITY', message, status: 'FAILED' };
  }
  const actions = JSON.parse(pris[0].actions_payload) as PlannedAction[];

  // Droits évalués À L'EXÉCUTION, comme dans l'interface classique : un
  // compte passé en lecture seule entre-temps ne peut pas écrire en
  // confirmant une proposition antérieure.
  const droit = await (deps.canWrite ?? defaultCanWrite)(p.accountId);
  if (!droit.allowed) {
    const refus = actions.map((a) => ({ actionId: a.actionId, status: 'REFUSED' as const, message: droit.message ?? 'Écriture non autorisée.' }));
    await fin('REFUSED', refus);
    await tracer(p.planId, p.accountId, p.userId, 'REFUSED', { reason: droit.message });
    await recordPlanOutcome(fil, droit.message ?? 'Écriture non autorisée.');
    return { ok: false, code: 'WRITE_REFUSED', message: droit.message ?? 'Écriture non autorisée.', status: 'REFUSED' };
  }

  // Chaque exécuteur réversible décrit sa commande inverse et l'état
  // antérieur de sa cible (undo.service) ; la fenêtre « Annuler » ne s'ouvre
  // que si TOUTES les étapes réussies sont réversibles (T2-039).
  const captures = new Map<string, UndoCapture>();
  const results = await executeActions(
    actions,
    { accountId: p.accountId, userId: p.userId, recordUndo: (c) => { captures.set(c.actionId, c); } },
    deps.executors,
  );
  const status = planStatusFrom(results);
  await fin(status, results);
  const undo = await armUndo(p, results, captures);
  await tracer(p.planId, p.accountId, p.userId, 'EXECUTED', {
    status, results, undo: { reversible: undo.undoUntil !== null, undoUntil: undo.undoUntil, reasons: undo.reasons },
  });
  const summary = summarizeResults(results);
  await recordPlanOutcome(fil, outcomeText(summary, results));
  return { ok: true, status, results, summary, undoUntil: undo.undoUntil };
}

export async function defaultCanWrite(accountId: number): Promise<{ allowed: boolean; message?: string }> {
  const d = await getEntitlements(accountId);
  if (d.canWrite) return { allowed: true };
  const r = await restrictedRefusal(accountId, d.status);
  return { allowed: false, message: r.message };
}

// ── Annulation d'une proposition ───────────────────────────────────────────

type Cancellation =
  /**
   * Proposition close sans aucune écriture : annulée maintenant, déjà
   * annulée (appel rejoué — idempotence), ou expirée entre-temps.
   */
  | { ok: true; status: 'CANCELLED' | 'EXPIRED'; alreadyHandled: boolean; message: string }
  | { ok: false; code: 'PLAN_NOT_FOUND' | 'PLAN_ALREADY_HANDLED'; message: string; status?: PlanStatus };

export const CANCELLED_MESSAGE = 'D’accord, j’ai annulé cette action : rien n’a été modifié.';
export const EXPIRED_MESSAGE = 'Cette proposition a expiré : rien n’a été modifié. Refaites votre demande si besoin.';

/**
 * Annulation, par l'utilisateur, d'une commande proposée et NON confirmée
 * (CDC §5.3 « possibilité d'annulation », §9.6 états CANCELLED / EXPIRED,
 * §27.5 idempotence).
 *
 *   · prise atomique : seul un plan EN ATTENTE, non expiré, du même compte
 *     ET du même utilisateur passe à CANCELLED — une confirmation
 *     concurrente et une annulation ne peuvent pas réussir toutes les deux ;
 *   · idempotente : rejouée sur un plan déjà annulé, elle rend le même
 *     résultat, sans nouvelle trace ni nouveau message ;
 *   · une proposition expirée est close comme EXPIRED (rien à annuler) ;
 *   · un plan déjà confirmé n'est plus annulable ici (pas de retour arrière
 *     sur des écritures exécutées) ;
 *   · le plan d'un autre utilisateur (autre membre d'un Duo) ou d'un autre
 *     compte est traité comme inexistant ;
 *   · l'issue est enregistrée dans le fil (message de l'assistant) et tracée.
 *
 * Aucune donnée métier n'est touchée.
 */
export async function cancelCommandPlan(p: { planId: string; accountId: number; userId: number }): Promise<Cancellation> {
  const rows = (await pgClient.unsafe(
    `UPDATE verebona_command_plans SET status = 'CANCELLED', cancelled_at = now()
      WHERE plan_id = $1 AND account_id = $2 AND user_id = $3
        AND status = 'PENDING_CONFIRMATION' AND expires_at > now()
      RETURNING conversation_id AS "conversationId", message_id AS "messageId"`,
    [p.planId, p.accountId, p.userId] as never[],
  )) as unknown as Array<{ conversationId: number | null; messageId: number | null }>;
  if (rows[0]) {
    await tracer(p.planId, p.accountId, p.userId, 'CANCELLED');
    await recordPlanOutcome({ ...p, ...rows[0] }, CANCELLED_MESSAGE);
    return { ok: true, status: 'CANCELLED', alreadyHandled: false, message: CANCELLED_MESSAGE };
  }

  const [etat] = (await pgClient.unsafe(
    `SELECT status, expires_at < now() AS expired, conversation_id AS "conversationId", message_id AS "messageId"
       FROM verebona_command_plans WHERE plan_id = $1 AND account_id = $2 AND user_id = $3`,
    [p.planId, p.accountId, p.userId] as never[],
  )) as unknown as Array<{ status: PlanStatus; expired: boolean; conversationId: number | null; messageId: number | null }>;
  if (!etat) return { ok: false, code: 'PLAN_NOT_FOUND', message: 'Cette action n’existe pas ou ne vous appartient pas.' };

  if (etat.status === 'CANCELLED') {
    return { ok: true, status: 'CANCELLED', alreadyHandled: true, message: CANCELLED_MESSAGE };
  }
  if (etat.status === 'EXPIRED' || (etat.status === 'PENDING_CONFIRMATION' && etat.expired)) {
    if (etat.status === 'PENDING_CONFIRMATION') {
      const passe = (await pgClient.unsafe(
        `UPDATE verebona_command_plans SET status = 'EXPIRED' WHERE plan_id = $1 AND status = 'PENDING_CONFIRMATION' RETURNING plan_id`,
        [p.planId] as never[],
      )) as unknown as unknown[];
      if (passe.length) {
        await tracer(p.planId, p.accountId, p.userId, 'EXPIRED');
        await recordPlanOutcome({ ...p, conversationId: etat.conversationId, messageId: etat.messageId }, EXPIRED_MESSAGE);
        return { ok: true, status: 'EXPIRED', alreadyHandled: false, message: EXPIRED_MESSAGE };
      }
    }
    return { ok: true, status: 'EXPIRED', alreadyHandled: true, message: EXPIRED_MESSAGE };
  }
  return {
    ok: false, code: 'PLAN_ALREADY_HANDLED', status: etat.status,
    message: 'Cette action a déjà été confirmée : elle ne peut plus être annulée depuis l’assistant.',
  };
}

/**
 * Passe à EXPIRED les propositions en attente dont la validité est dépassée
 * (purge quotidienne, et avant restitution d'un fil). Rend leur nombre.
 * Aucun message n'est ajouté aux fils : l'état suffit à l'affichage.
 */
export async function expirePendingPlans(scope: { accountId?: number; userId?: number } = {}): Promise<number> {
  const rows = (await pgClient.unsafe(
    `UPDATE verebona_command_plans SET status = 'EXPIRED'
      WHERE status = 'PENDING_CONFIRMATION' AND expires_at <= now()
        AND ($1::int IS NULL OR account_id = $1) AND ($2::int IS NULL OR user_id = $2)
      RETURNING plan_id, account_id, user_id`,
    [scope.accountId ?? null, scope.userId ?? null] as never[],
  )) as unknown as Array<{ plan_id: string; account_id: number; user_id: number }>;
  for (const r of rows) await tracer(r.plan_id, r.account_id, r.user_id, 'EXPIRED', { by: 'expiry' });
  // Purge quotidienne (sans périmètre) : états antérieurs des annulations
  // dont la fenêtre est close.
  if (scope.accountId == null && scope.userId == null) await purgeExpiredUndoSteps();
  return rows.length;
}

/** Plan tel que restitué dans l'historique d'un fil. */
interface ThreadCommandPlan extends CommandPlanPreview {
  messageId: number;
  status: PlanStatus;
  /**
   * Fin de la fenêtre « Annuler » d'un plan exécuté et réversible ; null
   * sinon (irréversible, non exécuté, déjà annulé). Le serveur fait foi.
   */
  undoUntil: string | null;
}

/**
 * Plans présentés dans un fil de l'utilisateur, par message : l'historique
 * rechargé montre leur état réel (en attente et encore annulable, annulé,
 * expiré, exécuté). Seuls les plans du compte ET de l'utilisateur sortent.
 */
export async function listThreadCommandPlans(
  accountId: number,
  userId: number,
  conversationId: number,
): Promise<ThreadCommandPlan[]> {
  await expirePendingPlans({ accountId, userId });
  const rows = (await pgClient.unsafe(
    `SELECT plan_id AS "planId", account_id AS "accountId", user_id AS "userId", conversation_id AS "conversationId",
            message_id AS "messageId", status, summary, actions_payload AS "actionsPayload", expires_at AS "expiresAt",
            undo_until AS "undoUntil"
       FROM verebona_command_plans
      WHERE account_id = $1 AND user_id = $2 AND conversation_id = $3 AND message_id IS NOT NULL
      ORDER BY created_at ASC`,
    [accountId, userId, conversationId] as never[],
  )) as unknown as Array<{
    planId: string; accountId: number; userId: number; conversationId: number | null; messageId: number;
    status: PlanStatus; summary: string; actionsPayload: string; expiresAt: string | Date; undoUntil?: string | Date | null;
  }>;
  const out: ThreadCommandPlan[] = [];
  for (const r of rows) {
    let actions: PlannedAction[];
    try { actions = JSON.parse(r.actionsPayload) as PlannedAction[]; } catch { continue; }
    const expiresAt = r.expiresAt instanceof Date ? r.expiresAt.toISOString() : String(r.expiresAt);
    const preview = toPreview({ ...r, actions, expiresAt });
    const annulable = (r.status === 'EXECUTED' || r.status === 'PARTIAL') && r.undoUntil;
    out.push({
      ...preview, messageId: r.messageId, status: r.status,
      undoUntil: annulable ? new Date(r.undoUntil as string | Date).toISOString() : null,
    });
  }
  return out;
}

/**
 * Issue d'un plan (annulation, expiration, exécution) enregistrée dans le
 * fil comme message de l'assistant, rattaché au message qui présentait le
 * plan. Seulement si le fil existe toujours et appartient à l'utilisateur.
 * Ne lève jamais : l'issue est déjà rendue et tracée.
 */
export async function recordPlanOutcome(
  p: { planId: string; accountId: number; userId: number; conversationId: number | null; messageId: number | null },
  content: string,
): Promise<void> {
  if (!p.conversationId) return;
  try {
    const { getAssistantConfig } = await import('../config/assistant-config');
    const expires = new Date(Date.now() + getAssistantConfig().historyDays * 86400_000).toISOString();
    const rows = (await pgClient.unsafe(
      `INSERT INTO verebona_messages
         (conversation_id, account_id, author_user_id, role, status, content, intent, mode,
          parent_message_id, response_locale, expires_at)
       SELECT c.id, $2, NULL, 'assistant', 'ready', $4, 'WRITE_COMMAND', 'deterministic', $5, 'fr-FR', $6
         FROM verebona_conversations c
        WHERE c.id = $1 AND c.account_id = $2 AND c.user_id = $3 AND c.status = 'active'
       RETURNING conversation_id`,
      [p.conversationId, p.accountId, p.userId, content, p.messageId, expires] as never[],
    )) as unknown as unknown[];
    if (rows.length) {
      await pgClient.unsafe(
        `UPDATE verebona_conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`,
        [p.conversationId] as never[],
      );
    }
  } catch (e) {
    console.error('[verebona] issue de commande non enregistrée dans le fil :', (e as Error).message);
  }
}

/** Texte de l'issue d'une exécution, tel qu'il est montré et enregistré. */
export function outcomeText(summary: string, results: ActionResult[]): string {
  if (results.length <= 1) return summary;
  const puce = (s: ActionResult['status']) => (s === 'SUCCESS' ? '✓' : s === 'SKIPPED_DEPENDENCY' ? '↷' : '✗');
  return `${summary}\n${results.map((r) => `• ${puce(r.status)} ${r.message}`).join('\n')}`;
}
