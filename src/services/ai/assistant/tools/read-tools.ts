/**
 * Les neuf outils de lecture — CDC Assistant §4.3.4.
 *
 * Chaque outil filtre sur `account_id` AU NIVEAU SQL. Les pièces, équipements
 * et preuves, qui n'ont pas de colonne de compte propre, passent par une
 * jointure sur le bien : le cloisonnement n'est jamais délégué à l'appelant.
 *
 * Aucun outil ne renvoie de coordonnées bancaires. Le CDC Assistant §16.2
 * l'interdit, et la décision métier du 28/07/2026 sur l'IBAN ne porte que sur
 * son extraction et son stockage — pas sur sa réutilisation par un modèle.
 */
import { db, pgClient } from '@/db';
import {
  assets, assetFiles, rooms, equipments, suppliers, agendaItems, agendaAssetLinks,
  aiFieldUpdates, inconsistencyRegistry,
} from '@/db/schema';
import { and, eq, ilike, or, isNull, desc, gte, lte } from 'drizzle-orm';
import type { AssistantTool, ToolContext, ToolResult, SourceRef } from './tool.port';
import { clampExcerpt } from './tool.port';
import { assertValidContext, assertRowsInScope, buildResult } from './account-scope';
import { isAiExcludedField } from '../../reconciliation/decision/ai-exclusion';

const like = (q: string) => `%${q.replace(/[%_]/g, '')}%`;

// ── 1. searchAssets ─────────────────────────────────────────────────────────
export const searchAssets: AssistantTool<{ query?: string; category?: string }> = {
  name: 'searchAssets',
  description: 'Recherche les biens du compte par nom, catégorie ou sous-type.',
  parameters: { query: 'texte libre, optionnel', category: 'immobilier | vehicule | objet, optionnel' },

  async execute(params, ctx): Promise<ToolResult<unknown>> {
    assertValidContext('searchAssets', ctx);

    const conditions = [eq(assets.accountId, ctx.accountId), isNull(assets.deletedAt)];
    if (params.query) {
      conditions.push(or(
        ilike(assets.name, like(params.query)),
        ilike(assets.subtype, like(params.query)),
      )!);
    }
    if (params.category) conditions.push(eq(assets.category, params.category));

    const rows = await db
      .select({
        id: assets.id, name: assets.name, category: assets.category,
        subtype: assets.subtype, accountId: assets.accountId,
      })
      .from(assets).where(and(...conditions)).limit(ctx.maxResults);

    assertRowsInScope('searchAssets', rows, ctx);

    return buildResult(
      rows.map(({ accountId: _a, ...rest }) => rest),
      rows.map((r) => ({ type: 'asset' as const, id: r.id, label: r.name })),
      rows.length === ctx.maxResults,
    );
  },
};

// ── 2. getAssetDetails ──────────────────────────────────────────────────────
export const getAssetDetails: AssistantTool<{ assetId: number }> = {
  name: 'getAssetDetails',
  description: "Détail d'un bien : caractéristiques, pièces et équipements.",
  parameters: { assetId: 'identifiant du bien' },

  async execute(params, ctx): Promise<ToolResult<unknown>> {
    assertValidContext('getAssetDetails', ctx);

    const [asset] = await db
      .select({
        id: assets.id, name: assets.name, category: assets.category,
        subtype: assets.subtype, keyCharacteristics: assets.keyCharacteristics,
      })
      .from(assets)
      .where(and(
        eq(assets.id, params.assetId),
        eq(assets.accountId, ctx.accountId),
        isNull(assets.deletedAt),
      ))
      .limit(1);

    if (!asset) return buildResult(null, []);

    const [roomRows, equipRows] = await Promise.all([
      db.select({ id: rooms.id, name: rooms.name })
        .from(rooms).where(eq(rooms.assetId, asset.id)).limit(ctx.maxResults),
      db.select({ id: equipments.id, name: equipments.name, type: equipments.type })
        .from(equipments).where(eq(equipments.assetId, asset.id)).limit(ctx.maxResults),
    ]);

    return buildResult(
      {
        id: asset.id, name: asset.name, category: asset.category, subtype: asset.subtype,
        characteristics: stripSensitiveFields(asset.keyCharacteristics),
        rooms: roomRows, equipments: equipRows,
      },
      [{ type: 'asset', id: asset.id, label: asset.name }],
    );
  },
};

// ── 3. searchDocuments ──────────────────────────────────────────────────────
export const searchDocuments: AssistantTool<{ query?: string; assetId?: number; documentType?: string }> = {
  name: 'searchDocuments',
  description: 'Recherche les documents du compte par titre, type ou bien rattaché.',
  parameters: { query: 'texte libre', assetId: 'bien concerné', documentType: 'type canonique' },

  async execute(params, ctx): Promise<ToolResult<unknown>> {
    assertValidContext('searchDocuments', ctx);

    const conditions = [eq(assetFiles.accountId, ctx.accountId), isNull(assetFiles.deletedAt)];
    if (params.assetId) conditions.push(eq(assetFiles.assetId, params.assetId));
    if (params.documentType) conditions.push(eq(assetFiles.documentType, params.documentType));
    if (params.query) {
      conditions.push(or(
        ilike(assetFiles.retainedTitle, like(params.query)),
        ilike(assetFiles.originalFilename, like(params.query)),
        ilike(assetFiles.supplier, like(params.query)),
      )!);
    }

    const rows = await db
      .select({
        id: assetFiles.id, title: assetFiles.retainedTitle,
        filename: assetFiles.originalFilename, documentType: assetFiles.documentType,
        documentDate: assetFiles.documentDate, supplier: assetFiles.supplier,
        assetId: assetFiles.assetId, accountId: assetFiles.accountId,
      })
      .from(assetFiles).where(and(...conditions))
      .orderBy(desc(assetFiles.documentDate)).limit(ctx.maxResults);

    assertRowsInScope('searchDocuments', rows, ctx);

    return buildResult(
      rows.map(({ accountId: _a, ...rest }) => rest),
      rows.map((r) => ({
        type: 'document' as const, id: r.id,
        label: r.title ?? r.filename ?? `document ${r.id}`,
      })),
      rows.length === ctx.maxResults,
    );
  },
};

// ── 4. getDocumentEvidence ──────────────────────────────────────────────────
export const getDocumentEvidence: AssistantTool<{ documentId: number; fieldKey?: string }> = {
  name: 'getDocumentEvidence',
  description: "Extraits justificatifs tirés d'un document, avec leur localisation.",
  parameters: { documentId: 'identifiant du document', fieldKey: 'champ concerné, optionnel' },

  async execute(params, ctx): Promise<ToolResult<unknown>> {
    assertValidContext('getDocumentEvidence', ctx);

    const sql = `SELECT id, field_key, value_json, evidence_excerpt, source_location, confidence
                   FROM field_evidence
                  WHERE account_id = $1 AND source_id = $2 AND status = 'active'
                    ${params.fieldKey ? 'AND field_key = $3' : ''}
                  ORDER BY authority_score DESC
                  LIMIT ${ctx.maxResults}`;

    const rows = await pgClient.unsafe(
      sql,
      (params.fieldKey
        ? [ctx.accountId, params.documentId, params.fieldKey]
        : [ctx.accountId, params.documentId]) as never[],
    );

    const evidences = (rows as unknown as Array<Record<string, unknown>>)
      .filter((r) => !isAiExcludedField(String(r.field_key)))
      .map((r) => ({
        id: Number(r.id),
        fieldKey: String(r.field_key),
        value: r.value_json,
        excerpt: clampExcerpt(String(r.evidence_excerpt)),
        confidence: String(r.confidence),
        page: (r.source_location as { page?: number } | null)?.page,
      }));

    return buildResult(
      evidences,
      evidences.map((e) => ({
        type: 'field_evidence' as const, id: e.id, label: e.fieldKey,
        excerpt: e.excerpt, page: e.page,
      })),
    );
  },
};

// ── 5. searchAgenda ─────────────────────────────────────────────────────────
//
// ⚠️ CORRECTION : la première version de cet outil référençait `dueDate`,
// `status` et `assetId` sur `agenda_items`. Ces trois colonnes N'EXISTENT PAS.
// Le schéma réel porte `start_date`, `manual_status`, et le rattachement au
// bien passe par la table de liaison `agenda_asset_links`.
export const searchAgenda: AssistantTool<{ from?: string; to?: string; assetId?: number }> = {
  name: 'searchAgenda',
  description: "Recherche les échéances et informations de l'agenda du compte.",
  parameters: {
    from: 'date ISO de début, optionnelle',
    to: 'date ISO de fin, optionnelle',
    assetId: 'bien concerné, optionnel',
  },

  async execute(params, ctx): Promise<ToolResult<unknown>> {
    assertValidContext('searchAgenda', ctx);

    const conditions = [eq(agendaItems.accountId, ctx.accountId)];
    if (params.from) conditions.push(gte(agendaItems.startDate, params.from));
    if (params.to) conditions.push(lte(agendaItems.startDate, params.to));

    // Le rattachement au bien impose une jointure : `agenda_items` ne porte pas
    // d'identifiant de bien.
    const base = db
      .select({
        id: agendaItems.id,
        title: agendaItems.title,
        startDate: agendaItems.startDate,
        category: agendaItems.homeCategory,
        manualStatus: agendaItems.manualStatus,
        requiresQualification: agendaItems.requiresQualification,
        accountId: agendaItems.accountId,
      })
      .from(agendaItems);

    const rows = params.assetId
      ? await base
          .innerJoin(agendaAssetLinks, eq(agendaAssetLinks.agendaItemId, agendaItems.id))
          .where(and(...conditions, eq(agendaAssetLinks.assetId, params.assetId)))
          .orderBy(agendaItems.startDate).limit(ctx.maxResults)
      : await base
          .where(and(...conditions))
          .orderBy(agendaItems.startDate).limit(ctx.maxResults);

    assertRowsInScope('searchAgenda', rows, ctx);

    return buildResult(
      rows.map(({ accountId: _a, ...rest }) => rest),
      rows.map((r) => ({
        type: 'agenda' as const,
        id: r.id,
        label: `${r.title} — ${r.startDate ?? 'sans date'}`,
      })),
      rows.length === ctx.maxResults,
    );
  },
};

// ── 6. searchSuppliers ──────────────────────────────────────────────────────
export const searchSuppliers: AssistantTool<{ query?: string }> = {
  name: 'searchSuppliers',
  description: 'Recherche les fournisseurs du compte.',
  parameters: { query: 'nom ou raison sociale' },

  async execute(params, ctx): Promise<ToolResult<unknown>> {
    assertValidContext('searchSuppliers', ctx);

    const conditions = [eq(suppliers.accountId, ctx.accountId)];
    if (params.query) conditions.push(ilike(suppliers.name, like(params.query)));

    const rows = await db
      .select({ id: suppliers.id, name: suppliers.name, accountId: suppliers.accountId })
      .from(suppliers).where(and(...conditions)).limit(ctx.maxResults);

    assertRowsInScope('searchSuppliers', rows, ctx);

    // Aucune coordonnée bancaire de fournisseur ne quitte le serveur (§16.2).
    return buildResult(
      rows.map((r) => ({ id: r.id, name: r.name })),
      rows.map((r) => ({ type: 'supplier' as const, id: r.id, label: r.name })),
    );
  },
};

// ── 7. searchEquipments ─────────────────────────────────────────────────────
export const searchEquipments: AssistantTool<{ query?: string; assetId?: number }> = {
  name: 'searchEquipments',
  description: 'Recherche les équipements rattachés aux biens du compte.',
  parameters: { query: 'nom ou type', assetId: 'bien concerné' },

  async execute(params, ctx): Promise<ToolResult<unknown>> {
    assertValidContext('searchEquipments', ctx);

    // Les équipements n'ont pas de colonne de compte : la jointure sur le bien
    // porte le cloisonnement.
    const conditions = [eq(assets.accountId, ctx.accountId), isNull(assets.deletedAt)];
    if (params.assetId) conditions.push(eq(equipments.assetId, params.assetId));
    if (params.query) {
      conditions.push(or(
        ilike(equipments.name, like(params.query)),
        ilike(equipments.type, like(params.query)),
      )!);
    }

    const rows = await db
      .select({
        id: equipments.id, name: equipments.name, type: equipments.type,
        assetId: equipments.assetId, assetName: assets.name,
      })
      .from(equipments)
      .innerJoin(assets, eq(equipments.assetId, assets.id))
      .where(and(...conditions)).limit(ctx.maxResults);

    return buildResult(
      rows,
      rows.map((r) => ({ type: 'equipment' as const, id: r.id, label: r.name })),
    );
  },
};

// ── 8. getFieldHistory ──────────────────────────────────────────────────────
export const getFieldHistory: AssistantTool<{ assetId: number; fieldKey: string }> = {
  name: 'getFieldHistory',
  description: "Historique des modifications automatiques d'un champ, avec leur motif.",
  parameters: { assetId: 'identifiant du bien', fieldKey: 'champ concerné' },

  async execute(params, ctx): Promise<ToolResult<unknown>> {
    assertValidContext('getFieldHistory', ctx);

    // Un champ sensible n'a pas d'historique consultable par un modèle.
    if (isAiExcludedField(params.fieldKey)) return buildResult([], []);

    const rows = await db
      .select({
        id: aiFieldUpdates.id, fieldKey: aiFieldUpdates.fieldKey,
        oldValue: aiFieldUpdates.oldValue, newValue: aiFieldUpdates.newValue,
        createdAt: aiFieldUpdates.createdAt, assetFileId: aiFieldUpdates.assetFileId,
        accountId: aiFieldUpdates.accountId,
      })
      .from(aiFieldUpdates)
      .where(and(
        eq(aiFieldUpdates.accountId, ctx.accountId),
        eq(aiFieldUpdates.assetId, params.assetId),
        eq(aiFieldUpdates.fieldKey, params.fieldKey),
      ))
      .orderBy(desc(aiFieldUpdates.createdAt)).limit(ctx.maxResults);

    assertRowsInScope('getFieldHistory', rows, ctx);

    return buildResult(
      rows.map(({ accountId: _a, ...rest }) => rest),
      rows.filter((r) => r.assetFileId !== null).map((r) => ({
        type: 'document' as const, id: r.assetFileId!, label: `source de ${r.fieldKey}`,
      })),
    );
  },
};

// ── 9. getOpenInconsistencies ───────────────────────────────────────────────
export const getOpenInconsistencies: AssistantTool<{ assetId?: number }> = {
  name: 'getOpenInconsistencies',
  description: "Contradictions en attente d'arbitrage sur les fiches du compte.",
  parameters: { assetId: 'bien concerné, optionnel' },

  async execute(params, ctx): Promise<ToolResult<unknown>> {
    assertValidContext('getOpenInconsistencies', ctx);

    const conditions = [
      eq(inconsistencyRegistry.accountId, ctx.accountId),
      eq(inconsistencyRegistry.status, 'open'),
    ];
    if (params.assetId) conditions.push(eq(inconsistencyRegistry.assetId, params.assetId));

    const rows = await db
      .select({
        id: inconsistencyRegistry.id, assetId: inconsistencyRegistry.assetId,
        fieldKey: inconsistencyRegistry.fieldKey,
        currentValue: inconsistencyRegistry.currentValue,
        proposedValue: inconsistencyRegistry.proposedValue,
        detail: inconsistencyRegistry.sourceDetail,
        accountId: inconsistencyRegistry.accountId,
      })
      .from(inconsistencyRegistry).where(and(...conditions)).limit(ctx.maxResults);

    assertRowsInScope('getOpenInconsistencies', rows, ctx);

    return buildResult(
      rows
        .filter((r) => !isAiExcludedField(r.fieldKey))
        .map(({ accountId: _a, ...rest }) => rest),
      [],
    );
  },
};

/** Retire des caractéristiques les champs interdits de transmission. */
export function stripSensitiveFields(raw: unknown): Record<string, unknown> {
  const kc = parseJson(raw);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(kc)) {
    if (isAiExcludedField(k)) continue;
    // Les clés techniques d'origine et d'autorité n'intéressent pas le modèle.
    if (k.includes('__origin') || k.includes('__authority') || k.includes('__sourceDate')) continue;
    out[k] = v;
  }
  return out;
}

function parseJson(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw)) as Record<string, unknown>; } catch { return {}; }
}

export const ALL_READ_TOOLS = [
  searchAssets, getAssetDetails, searchDocuments, getDocumentEvidence,
  searchAgenda, searchSuppliers, searchEquipments, getFieldHistory,
  getOpenInconsistencies,
];
