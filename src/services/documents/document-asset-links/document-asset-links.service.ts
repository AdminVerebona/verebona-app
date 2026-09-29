/**
 * Service de la relation N-N document ↔ bien — CDC 15 X-01, T1-05, §12.
 *
 * Écritures USER / AI / MIGRATION (les liens LEGACY_COLUMN sont tenus par le
 * déclencheur SQL de la migration 0221 depuis les colonnes d'asset_files, et
 * jamais écrits ici). Lecture N-N : `listDocumentAssets`,
 * `listAssetDocuments` (y compris SECONDARY / MENTIONED).
 *
 * Cloisonnement : chaque appel vérifie que le document ET la cible
 * appartiennent au compte (§11.4) ; un identifiant étranger lève
 * `DocumentLinkOwnershipError` sans rien écrire.
 *
 * Aucun écran ni export ne lit encore cette table (lots 15 et 16).
 */
import { db } from '@/db';
import { assetFiles, assets, documentAssetLinks, equipments, rooms } from '@/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  canRefresh,
  ROLE_RANK,
  type DocumentAssetLink,
  type LinkOrigin,
  type LinkRole,
  type LinkStatus,
  type LinkTarget,
} from './types';

export class DocumentLinkOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentLinkOwnershipError';
  }
}

type Row = typeof documentAssetLinks.$inferSelect;

function toLink(r: Row): DocumentAssetLink {
  return {
    id: r.id, accountId: r.accountId, fileId: r.fileId,
    assetId: r.assetId, roomId: r.roomId, equipmentId: r.equipmentId,
    linkRole: r.linkRole as LinkRole, origin: r.origin as LinkOrigin,
    confidence: r.confidence === null ? null : Number(r.confidence),
    status: r.status as LinkStatus,
    createdAt: r.createdAt, updatedAt: r.updatedAt, removedAt: r.removedAt,
  };
}

/** Condition SQL « même cible » (NULL comparé comme absent, comme l'index unique). */
function sameTarget(t: Required<LinkTarget>) {
  return sql`COALESCE(${documentAssetLinks.assetId}, 0) = ${t.assetId ?? 0}
    AND COALESCE(${documentAssetLinks.roomId}, 0) = ${t.roomId ?? 0}
    AND COALESCE(${documentAssetLinks.equipmentId}, 0) = ${t.equipmentId ?? 0}`;
}

async function assertFileInAccount(accountId: number, fileId: number): Promise<void> {
  const [f] = await db.select({ id: assetFiles.id }).from(assetFiles)
    .where(and(eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId))).limit(1);
  if (!f) throw new DocumentLinkOwnershipError(`Document ${fileId} introuvable dans le compte ${accountId}.`);
}

/**
 * Cible complète et vérifiée : une pièce ou un équipement porte aussi son
 * bien (déduit, jamais fourni par l'appelant s'il contredit).
 */
async function resolveTarget(accountId: number, t: LinkTarget): Promise<Required<LinkTarget>> {
  const out: Required<LinkTarget> = { assetId: t.assetId ?? null, roomId: t.roomId ?? null, equipmentId: t.equipmentId ?? null };
  if (out.assetId === null && out.roomId === null && out.equipmentId === null) {
    throw new DocumentLinkOwnershipError('Lien sans cible (bien, pièce ou équipement).');
  }
  const parent = async (id: number | null, kind: 'room' | 'equipment'): Promise<number | null> => {
    if (id === null) return null;
    const table = kind === 'room' ? rooms : equipments;
    const [r] = await db.select({ assetId: table.assetId }).from(table)
      .innerJoin(assets, eq(table.assetId, assets.id))
      .where(and(eq(table.id, id), eq(assets.accountId, accountId), isNull(assets.deletedAt))).limit(1);
    if (!r) throw new DocumentLinkOwnershipError(`${kind === 'room' ? 'Pièce' : 'Équipement'} ${id} introuvable dans le compte ${accountId}.`);
    return r.assetId;
  };
  const roomAsset = await parent(out.roomId, 'room');
  const equipAsset = await parent(out.equipmentId, 'equipment');
  const derived = roomAsset ?? equipAsset;
  if (derived !== null) {
    if (out.assetId !== null && out.assetId !== derived) {
      throw new DocumentLinkOwnershipError(`La cible appartient au bien ${derived}, pas au bien ${out.assetId}.`);
    }
    out.assetId = derived;
  } else if (out.assetId !== null) {
    const [a] = await db.select({ id: assets.id }).from(assets)
      .where(and(eq(assets.id, out.assetId), eq(assets.accountId, accountId), isNull(assets.deletedAt))).limit(1);
    if (!a) throw new DocumentLinkOwnershipError(`Bien ${out.assetId} introuvable dans le compte ${accountId}.`);
  }
  return out;
}

export interface LinkDocumentInput {
  accountId: number;
  fileId: number;
  target: LinkTarget;
  role: LinkRole;
  origin: Exclude<LinkOrigin, 'LEGACY_COLUMN'>;
  confidence?: number | null;
  /** ACTIVE par défaut ; PROPOSED pour un lien à faire valider. */
  status?: Extract<LinkStatus, 'ACTIVE' | 'PROPOSED'>;
}

export type LinkOutcome = 'created' | 'updated' | 'unchanged';

/**
 * Pose (ou rafraîchit) le lien d'un document vers une cible. Un seul lien
 * ACTIF par (document, cible) : s'il existe, il n'est rafraîchi que selon
 * `canRefresh` (un lien LEGACY_COLUMN ou USER n'est jamais écrasé par l'IA).
 */
export async function linkDocumentToAsset(input: LinkDocumentInput): Promise<{ outcome: LinkOutcome; link: DocumentAssetLink }> {
  await assertFileInAccount(input.accountId, input.fileId);
  const target = await resolveTarget(input.accountId, input.target);
  const confidence = input.confidence === undefined || input.confidence === null
    ? null : Math.min(1, Math.max(0, Math.round(input.confidence * 1000) / 1000));
  const status = input.status ?? 'ACTIVE';

  const [existing] = await db.select().from(documentAssetLinks).where(and(
    eq(documentAssetLinks.fileId, input.fileId),
    eq(documentAssetLinks.status, 'ACTIVE'),
    sameTarget(target),
  )).limit(1);

  if (existing) {
    const current = toLink(existing);
    if (status !== 'ACTIVE' || !canRefresh(current.origin, input.origin)) return { outcome: 'unchanged', link: current };
    const role = input.role;
    if (role === current.linkRole && input.origin === current.origin && confidence === current.confidence) {
      return { outcome: 'unchanged', link: current };
    }
    const [updated] = await db.update(documentAssetLinks)
      .set({ linkRole: role, origin: input.origin, confidence: confidence === null ? null : String(confidence), updatedAt: new Date() })
      .where(eq(documentAssetLinks.id, current.id)).returning();
    return { outcome: 'updated', link: toLink(updated) };
  }

  const inserted = await db.insert(documentAssetLinks).values({
    accountId: input.accountId, fileId: input.fileId,
    assetId: target.assetId, roomId: target.roomId, equipmentId: target.equipmentId,
    linkRole: input.role, origin: input.origin,
    confidence: confidence === null ? null : String(confidence), status,
  }).onConflictDoNothing().returning();
  if (inserted[0]) return { outcome: 'created', link: toLink(inserted[0]) };

  // Course avec une autre écriture (déclencheur, autre instance) : lien déjà posé.
  const [racing] = await db.select().from(documentAssetLinks).where(and(
    eq(documentAssetLinks.fileId, input.fileId), eq(documentAssetLinks.status, 'ACTIVE'), sameTarget(target),
  )).limit(1);
  return { outcome: 'unchanged', link: toLink(racing) };
}

export interface UnlinkInput {
  accountId: number;
  fileId: number;
  /** Cible à délier ; absente : toutes les cibles. */
  target?: LinkTarget;
  /**
   * Origines retirées (défaut : USER, AI, MIGRATION). Les liens LEGACY_COLUMN
   * suivent les colonnes d'asset_files : on les retire en modifiant la
   * colonne (le déclencheur s'en charge), pas ici.
   */
  origins?: Array<Exclude<LinkOrigin, 'LEGACY_COLUMN'>>;
  /** Ne retirer que les liens hors de cette liste d'identifiants (remplacement). */
  keepIds?: number[];
  /** Ne retirer que les liens vers un bien hors de cette liste (remplacement par cible). */
  keepAssetIds?: number[];
}

/** Retire des liens (status REMOVED, removed_at) — jamais de suppression physique. */
export async function unlinkDocument(input: UnlinkInput): Promise<number> {
  await assertFileInAccount(input.accountId, input.fileId);
  const origins = input.origins ?? ['USER', 'AI', 'MIGRATION'];
  const conditions = [
    eq(documentAssetLinks.fileId, input.fileId),
    eq(documentAssetLinks.accountId, input.accountId),
    eq(documentAssetLinks.status, 'ACTIVE'),
    inArray(documentAssetLinks.origin, origins),
  ];
  if (input.target) {
    const t = { assetId: input.target.assetId ?? null, roomId: input.target.roomId ?? null, equipmentId: input.target.equipmentId ?? null };
    conditions.push(sameTarget(t));
  }
  if (input.keepIds?.length) conditions.push(sql`${documentAssetLinks.id} NOT IN (${sql.join(input.keepIds.map((id) => sql`${id}`), sql`, `)})`);
  if (input.keepAssetIds?.length) {
    conditions.push(sql`COALESCE(${documentAssetLinks.assetId}, 0) NOT IN (${sql.join(input.keepAssetIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  const rows = await db.update(documentAssetLinks)
    .set({ status: 'REMOVED', removedAt: new Date(), updatedAt: new Date() })
    .where(and(...conditions)).returning({ id: documentAssetLinks.id });
  return rows.length;
}

/** Liens ACTIFS d'un document (toutes origines, tous rôles), rôle le plus fort d'abord. */
export async function listDocumentAssets(accountId: number, fileId: number): Promise<DocumentAssetLink[]> {
  const rows = await db.select().from(documentAssetLinks).where(and(
    eq(documentAssetLinks.accountId, accountId),
    eq(documentAssetLinks.fileId, fileId),
    eq(documentAssetLinks.status, 'ACTIVE'),
  ));
  return rows.map(toLink).sort((a, b) => ROLE_RANK[a.linkRole] - ROLE_RANK[b.linkRole] || a.id - b.id);
}

/**
 * Documents d'un bien par la relation N-N (PRIMARY, SECONDARY et MENTIONED
 * par défaut), documents supprimés exclus. Helper de lecture destiné aux
 * écrans et exports (lots 15 et 16).
 */
export async function listAssetDocuments(
  accountId: number,
  assetId: number,
  opts: { roles?: LinkRole[] } = {},
): Promise<Array<DocumentAssetLink>> {
  const roles = opts.roles ?? ['PRIMARY', 'SECONDARY', 'MENTIONED'];
  const rows = await db.select({ link: documentAssetLinks }).from(documentAssetLinks)
    .innerJoin(assetFiles, eq(documentAssetLinks.fileId, assetFiles.id))
    .where(and(
      eq(documentAssetLinks.accountId, accountId),
      eq(documentAssetLinks.assetId, assetId),
      eq(documentAssetLinks.status, 'ACTIVE'),
      inArray(documentAssetLinks.linkRole, roles),
      eq(assetFiles.accountId, accountId),
      isNull(assetFiles.deletedAt),
    ));
  // Un document lié au bien ET à l'une de ses pièces n'apparaît qu'une fois (rôle le plus fort).
  const parDoc = new Map<number, DocumentAssetLink>();
  for (const { link } of rows) {
    const l = toLink(link);
    const deja = parDoc.get(l.fileId);
    if (!deja || ROLE_RANK[l.linkRole] < ROLE_RANK[deja.linkRole]) parDoc.set(l.fileId, l);
  }
  return [...parDoc.values()].sort((a, b) => ROLE_RANK[a.linkRole] - ROLE_RANK[b.linkRole] || a.fileId - b.fileId);
}
