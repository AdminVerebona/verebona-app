/**
 * Emplacements des données documentaires pilotées par le catalogue
 * « À traiter » (lot 28, ticket P0) — lecture, écriture automatique,
 * écriture utilisateur.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN EMPLACEMENT PAR DÉFAUT, DEUX EXCEPTIONS
 *
 * Le pont documentaire (`document-rule-bridge.ts`) ne connaît aucune règle :
 * il parcourt `PROCESSING_RULES` et demande ici où vit la donnée.
 *
 *   · défaut — table `document_field_values` (migration 0256) : toute donnée
 *     documentaire déclarée au catalogue sans colonne propre (aujourd'hui
 *     `contractEndDate`, `warrantyEndDate`). Une nouvelle règle documentaire
 *     n'a besoin ni de code ni de migration ;
 *   · `supplier`  — colonne historique `asset_files.supplier`, protégée par
 *     `user_edited_fields.supplier` (tiroir, retrait de fournisseur) ;
 *   · `assetIds`  — relation N-N document ↔ bien (`document_asset_links`,
 *     colonnes `asset_id` / `linked_asset_id` reflétées par la 0221).
 *     Cardinalité « au moins un » : n'importe quel bien rattaché satisfait la
 *     règle LINK-ASSET.
 *
 * ── LA VALEUR UTILISATEUR N'EST JAMAIS ÉCRASÉE ────────────────────────────
 *
 * `writeAuto` est conditionnelle EN BASE (clause WHERE) : une valeur validée
 * par l'utilisateur entre la lecture et l'écriture n'est pas remplacée
 * (P-05, §12.2). `writeUser` pose la validation utilisateur.
 *
 * Toutes les écritures passent par le client fourni : dans
 * `resolveArbitration`, c'est la transaction (§13.5).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { assetFiles, assets, documentAssetLinks, documentFieldValues, documentSuppliers, suppliers } from '@/db/schema';
import { getField } from '@/services/canonical/registry';
import type { ActionProposal, ValueOrigin } from './action-model';

/** Client de base : transaction en cours ou `db` (même contrat que `resolve-action`). */
export type SlotClient = Pick<typeof db, 'select' | 'update' | 'insert'>;

export interface DocumentSlotState {
  /** Valeur retenue (relation : premier bien rattaché), `null` = absente. */
  value: string | number | null;
  /** Relation : toutes les cibles rattachées. */
  values: number[];
  /** Saisie ou validation explicite de l'utilisateur (y compris un retrait). */
  userValidated: boolean;
  origin: ValueOrigin | null;
}

export interface AutoWriteMeta {
  origin: ValueOrigin;
  confidence?: number | null;
  evidenceIds?: string[];
}

export interface DocumentSlot {
  key: string;
  kind: 'field' | 'relation';
  /** Saisie directe possible depuis la carte (« Compléter » en ligne). */
  inputType: 'date' | 'text' | null;
  validate(value: unknown): boolean;
  /** Valeur normalisée à écrire (date ISO, identifiant…). */
  normalize(value: unknown): string | number | null;
  /** Contrôle EN BASE (appartenance au compte) ; défaut : vrai. */
  check?(client: SlotClient, accountId: number, fileId: number, value: unknown): Promise<boolean>;
  read(client: SlotClient, accountId: number, fileId: number): Promise<DocumentSlotState>;
  /** Écriture automatique — refusée (faux) si une valeur utilisateur est en place. */
  writeAuto(client: SlotClient, accountId: number, fileId: number, value: unknown, meta: AutoWriteMeta): Promise<boolean>;
  /** Écriture utilisateur (carte, tiroir) : pose la validation. `null` efface (annulation). */
  writeUser(client: SlotClient, accountId: number, fileId: number, value: unknown): Promise<void>;
  /** Propositions conservées en base, pour une réévaluation sans analyse (balayage). */
  storedProposals?(accountId: number, fileId: number): Promise<ActionProposal[]>;
}

// ── Valeurs ─────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Date ISO depuis une valeur lue (`2026-03-14`, `2026-03-14T…`), sinon null. */
export function toIsoDate(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 10);
  return isIsoDate(s) ? s : null;
}

/** Libellé affiché d'une date (JJ/MM/AAAA). */
export function formatIsoDate(v: string): string {
  const [y, m, d] = v.split('-');
  return `${d}/${m}/${y}`;
}

export const asPositiveId = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};

const asText = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s.length > 0 && s.length <= 500 ? s : null;
};

// ── Emplacement par défaut : document_field_values ──────────────────────────

export async function documentExists(client: SlotClient, accountId: number, fileId: number): Promise<boolean> {
  const [f] = await client
    .select({ id: assetFiles.id })
    .from(assetFiles)
    .where(and(eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId), isNull(assetFiles.deletedAt)))
    .limit(1);
  return !!f;
}

/** Emplacement générique d'une donnée documentaire du catalogue. */
export function valueStoreSlot(key: string): DocumentSlot {
  const isDate = getField(key)?.valueType === 'date';
  const normalize = (v: unknown) => (isDate ? toIsoDate(v) : asText(v));
  return {
    key,
    kind: 'field',
    inputType: isDate ? 'date' : 'text',
    validate: (v) => normalize(v) !== null,
    normalize,
    check: (client, accountId, fileId) => documentExists(client, accountId, fileId),
    async read(client, accountId, fileId) {
      const [row] = await client
        .select({ value: documentFieldValues.valueText, userValidated: documentFieldValues.userValidated, origin: documentFieldValues.origin })
        .from(documentFieldValues)
        .where(and(eq(documentFieldValues.fileId, fileId), eq(documentFieldValues.accountId, accountId), eq(documentFieldValues.fieldKey, key)))
        .limit(1);
      return {
        value: row?.value ?? null,
        values: [],
        userValidated: row?.userValidated ?? false,
        origin: (row?.origin as ValueOrigin | undefined) ?? null,
      };
    },
    async writeAuto(client, accountId, fileId, value, meta) {
      const v = normalize(value);
      if (v === null) return false;
      const confidence = meta.confidence == null ? null : String(Math.min(1, Math.max(0, Math.round(meta.confidence * 1000) / 1000)));
      const rows = await client
        .insert(documentFieldValues)
        .values({
          accountId, fileId, fieldKey: key, valueText: String(v), origin: meta.origin,
          userValidated: false, confidence, evidenceIds: meta.evidenceIds ?? [],
        })
        .onConflictDoUpdate({
          target: [documentFieldValues.fileId, documentFieldValues.fieldKey],
          set: { valueText: String(v), origin: meta.origin, confidence, evidenceIds: meta.evidenceIds ?? [], updatedAt: new Date() },
          // P-05 : la base refuse de remplacer une valeur utilisateur.
          setWhere: eq(documentFieldValues.userValidated, false),
        })
        .returning({ id: documentFieldValues.id });
      return rows.length > 0;
    },
    async writeUser(client, accountId, fileId, value) {
      const v = value === null || value === undefined ? null : normalize(value);
      await client
        .insert(documentFieldValues)
        .values({ accountId, fileId, fieldKey: key, valueText: v === null ? null : String(v), origin: 'USER', userValidated: true })
        .onConflictDoUpdate({
          target: [documentFieldValues.fileId, documentFieldValues.fieldKey],
          set: { valueText: v === null ? null : String(v), origin: 'USER', userValidated: true, confidence: null, evidenceIds: [], updatedAt: new Date() },
        });
    },
  };
}

// ── supplier : colonne historique asset_files.supplier ──────────────────────

export const SUPPLIER_SLOT: DocumentSlot = {
  key: 'supplier',
  kind: 'field',
  inputType: 'text',
  validate: (v) => asText(v) !== null,
  normalize: asText,
  check: (client, accountId, fileId) => documentExists(client, accountId, fileId),
  async read(client, accountId, fileId) {
    const [f] = await client
      .select({ supplier: assetFiles.supplier, edited: assetFiles.userEditedFields })
      .from(assetFiles)
      .where(and(eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId)))
      .limit(1);
    // Fournisseur du référentiel CONFIRMÉ pour ce document (rapprochement
    // certain, choix dans le tiroir) : il répond à la question quand le
    // texte est vide. La validation utilisateur reste celle du texte.
    const [lie] = await client
      .select({ name: suppliers.name })
      .from(documentSuppliers)
      .innerJoin(suppliers, eq(documentSuppliers.supplierId, suppliers.id))
      .where(and(
        eq(documentSuppliers.documentId, fileId), eq(documentSuppliers.isConfirmed, true),
        eq(suppliers.accountId, accountId),
      ))
      .limit(1);
    const userValidated = f?.edited?.supplier === true;
    const value = f?.supplier ?? lie?.name ?? null;
    return {
      value,
      values: [],
      userValidated,
      origin: userValidated ? 'USER' : value ? 'DOCUMENT_EXTRACTION' : null,
    };
  },
  async writeAuto(client, accountId, fileId, value) {
    const v = asText(value);
    if (v === null) return false;
    const rows = await client
      .update(assetFiles)
      .set({ supplier: v, updatedAt: new Date() })
      .where(and(
        eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId),
        sql`COALESCE((${assetFiles.userEditedFields} ->> 'supplier')::boolean, false) = false`,
      ))
      .returning({ id: assetFiles.id });
    return rows.length > 0;
  },
  async writeUser(client, accountId, fileId, value) {
    const v = value === null || value === undefined ? null : asText(value);
    await client
      .update(assetFiles)
      .set({
        supplier: v,
        userEditedFields: sql`COALESCE(${assetFiles.userEditedFields}, '{}'::jsonb) || '{"supplier": true}'::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId)));
  },
};

// ── assetIds : rattachement à un bien (LINK-ASSET) ──────────────────────────

/** Bien du compte, non supprimé. */
async function assetOfAccount(client: SlotClient, accountId: number, assetId: number): Promise<boolean> {
  const [a] = await client
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId), isNull(assets.deletedAt)))
    .limit(1);
  return !!a;
}

export const ASSET_LINK_SLOT: DocumentSlot = {
  key: 'assetIds',
  kind: 'relation',
  // Le choix d'un bien se fait dans le tiroir (sélecteur de biens).
  inputType: null,
  validate: (v) => asPositiveId(v) !== null,
  normalize: asPositiveId,
  check: async (client, accountId, fileId, value) => {
    const id = asPositiveId(value);
    return id !== null && (await documentExists(client, accountId, fileId)) && assetOfAccount(client, accountId, id);
  },
  async read(client, accountId, fileId) {
    const [f] = await client
      .select({ assetId: assetFiles.assetId, linkedAssetId: assetFiles.linkedAssetId, edited: assetFiles.userEditedFields })
      .from(assetFiles)
      .where(and(eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId)))
      .limit(1);
    // Rattachement = colonne historique, ou lien N-N ACTIF vers un bien de
    // rôle PRIMARY / SECONDARY. Un bien seulement CITÉ (MENTIONED) ne
    // rattache pas le document.
    const liens = await client
      .select({ assetId: documentAssetLinks.assetId })
      .from(documentAssetLinks)
      .where(and(
        eq(documentAssetLinks.fileId, fileId),
        eq(documentAssetLinks.accountId, accountId),
        eq(documentAssetLinks.status, 'ACTIVE'),
        inArray(documentAssetLinks.linkRole, ['PRIMARY', 'SECONDARY']),
        sql`${documentAssetLinks.assetId} IS NOT NULL`,
      ));
    const values = [...new Set([f?.assetId, f?.linkedAssetId, ...liens.map((l) => l.assetId)]
      .filter((x): x is number => typeof x === 'number'))];
    return {
      value: values[0] ?? null,
      values,
      userValidated: f?.edited?.assetId === true,
      origin: null,
    };
  },
  async writeAuto(client, accountId, fileId, value) {
    const id = asPositiveId(value);
    if (id === null || !(await assetOfAccount(client, accountId, id))) return false;
    // Jamais par-dessus un rattachement existant, ni un retrait de l'utilisateur.
    const rows = await client
      .update(assetFiles)
      .set({ assetId: id, updatedAt: new Date() })
      .where(and(
        eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId), isNull(assetFiles.deletedAt),
        isNull(assetFiles.assetId), isNull(assetFiles.linkedAssetId),
        sql`COALESCE((${assetFiles.userEditedFields} ->> 'assetId')::boolean, false) = false`,
      ))
      .returning({ id: assetFiles.id });
    return rows.length > 0;
  },
  async writeUser(client, accountId, fileId, value) {
    const id = value === null || value === undefined ? null : asPositiveId(value);
    await client
      .update(assetFiles)
      .set({
        assetId: id,
        userEditedFields: sql`COALESCE(${assetFiles.userEditedFields}, '{}'::jsonb) || '{"assetId": true}'::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId)));
  },
  async storedProposals(accountId, fileId) {
    // Biens CITÉS par la dernière analyse (liens AI MENTIONED, 0221) : ils
    // restent proposables sans relancer l'analyse.
    const rows = await db
      .select({ assetId: documentAssetLinks.assetId, confidence: documentAssetLinks.confidence, name: assets.name })
      .from(documentAssetLinks)
      .innerJoin(assets, eq(documentAssetLinks.assetId, assets.id))
      .where(and(
        eq(documentAssetLinks.fileId, fileId), eq(documentAssetLinks.accountId, accountId),
        eq(documentAssetLinks.status, 'ACTIVE'), eq(documentAssetLinks.linkRole, 'MENTIONED'),
        eq(documentAssetLinks.origin, 'AI'), isNull(assets.deletedAt), eq(assets.accountId, accountId),
      ));
    return rows
      .filter((r): r is typeof r & { assetId: number } => r.assetId !== null)
      .map((r) => ({
        value: r.assetId,
        label: r.name ?? `Bien ${r.assetId}`,
        // Réévaluation sans analyse : jamais d'écriture automatique.
        confidence: Math.min(0.89, r.confidence === null ? 0.5 : Number(r.confidence)),
      }));
  },
};

// ── Registre ────────────────────────────────────────────────────────────────

const OVERRIDES: Record<string, DocumentSlot> = {
  supplier: SUPPLIER_SLOT,
  assetIds: ASSET_LINK_SLOT,
};

/** Emplacement d'une donnée documentaire (`fieldKey` / `relationKey` d'une règle). */
export function documentSlotFor(key: string): DocumentSlot {
  return OVERRIDES[key] ?? valueStoreSlot(key);
}
