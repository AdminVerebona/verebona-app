/**
 * Incohérence de rattachement Document → Bien — carte « À traiter »
 * LINK-ASSET-CONFLICT (lot 32C, décisions PO 8 et PO 10 du 07/10).
 *
 * PO 8 : « L'utilisateur a rattaché un document à la maison A, mais il
 * contient l'adresse de la maison B → il faut traiter l'incohérence (doublon
 * de bien possible, mauvaise adresse, mauvais bien choisi). Donc À traiter. »
 * PO 10 : « le choix de l'utilisateur prévaut ; si une analyse rattacherait à
 * un autre bien, il faut À traiter. »
 *
 *   · producteur : l'abonné `source_analyzed` (toute analyse et réanalyse T1)
 *     lit l'avertissement `ASSET_TARGET_CONTRADICTION` — identifiant canonique
 *     exact d'un autre bien, ou candidat unique certain de l'analyse — et
 *     appelle `proposeDocumentAssetConflict` ;
 *   · cible : le DOCUMENT ; relation `assetConflict` — UNE carte active par
 *     document (index unique des actions actives), mise à jour si l'analyse
 *     désigne un autre bien ;
 *   · choix : « Rattacher à B » (déplacement par l'utilisateur, jamais
 *     automatique), « Ignorer » (clos comme « Non applicable » : ne revient
 *     pas sans élément nouveau, §7.4), « Garder A » (valeur actuelle : le
 *     rattachement devient une décision utilisateur explicite ; le même
 *     couple A / B n'est plus reproposé) ;
 *   · « Annuler » restaure l'état précédent et rouvre la MÊME carte ;
 *   · le balayage « À traiter » ferme une carte devenue sans objet (document
 *     détaché de A, rattaché à B par un autre chemin, bien supprimé).
 * Jamais de déplacement automatique : le système ne fait que demander.
 */
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { assetFiles, assets, toProcessActionEvents, toProcessActions } from '@/db/schema';
import type { ResolutionReason } from './action-model';
import type { DbClient, ResolveOptions, ResolveResult } from './resolve-action.service';
import { upsertAction, type UpsertActionResult } from './to-process-action.service';

export const ASSET_CONFLICT_RULE = 'LINK-ASSET-CONFLICT';
export const ASSET_CONFLICT_RELATION = 'assetConflict';

export type AssetConflictBasis = 'IDENTIFIER' | 'ANALYSIS';

/** Contexte conservé sur la carte (stable : entre dans l'empreinte §7.4, sans libellé). */
export interface AssetConflictContext {
  kind: 'asset_conflict';
  /** Bien choisi par l'utilisateur (A). */
  currentAssetId: number;
  /** Bien que l'analyse désigne (B). */
  suggestedAssetId: number;
  basis: AssetConflictBasis;
  /** Natures d'identifiant (ADDRESS, REGISTRATION…) — jamais la valeur. */
  kinds: string[];
}

const KIND_WITH_ARTICLE: Readonly<Record<string, string>> = {
  ADDRESS: 'l’adresse',
  REGISTRATION: 'l’immatriculation',
  VIN: 'le VIN',
  SERIAL: 'le numéro de série',
  CADASTRAL: 'la référence cadastrale',
};

const borne = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Question de la carte (pure) : claire, sans aucune valeur d'identifiant. */
export function assetConflictQuestion(p: { basis: AssetConflictBasis; kinds: readonly string[]; currentName: string; suggestedName: string }): string {
  const a = `« ${borne(p.currentName)} »`;
  const b = `« ${borne(p.suggestedName)} »`;
  if (p.basis === 'IDENTIFIER') {
    const natures = [...new Set(p.kinds.map((k) => KIND_WITH_ARTICLE[k]).filter(Boolean))];
    const quoi = natures.length === 0 ? 'un identifiant' : natures.length === 1 ? natures[0] : `${natures.slice(0, -1).join(', ')} et ${natures[natures.length - 1]}`;
    return `Ce document est rattaché à ${a} mais contient ${quoi} de ${b}. Quel bien garder ?`;
  }
  return `Ce document est rattaché à ${a} mais l’analyse indique qu’il concerne ${b}. Quel bien garder ?`;
}

/** Choix proposés (pure) : rattacher à B, ignorer, garder A (valeur actuelle). */
export function assetConflictProposals(p: { currentAssetId: number; suggestedAssetId: number; currentName: string; suggestedName: string; basis: AssetConflictBasis }) {
  return [
    {
      value: `MOVE:${p.suggestedAssetId}`,
      label: `Rattacher à « ${borne(p.suggestedName, 40)} »`,
      confidence: 0.6,
      sourceContext: { label: p.basis === 'IDENTIFIER' ? 'Identifiant exact lu dans le document' : 'Analyse du document', targetType: 'ASSET' as const, targetId: p.suggestedAssetId },
    },
    { value: 'IGNORE', label: 'Ignorer', confidence: 0.3 },
    { value: 'KEEP', label: `Garder « ${borne(p.currentName, 40)} »`, confidence: 1, isCurrentValue: true },
  ];
}

/** Rattachement actuel du document (colonnes et liens N-N ACTIFS). */
async function attachmentOf(client: Pick<typeof db, 'select'>, accountId: number, fileId: number) {
  const [f] = await client
    .select({
      assetId: assetFiles.assetId, linkedAssetId: assetFiles.linkedAssetId, userId: assetFiles.userId,
      edited: assetFiles.userEditedFields, deletedAt: assetFiles.deletedAt, groupedInto: assetFiles.groupedIntoFileId,
      isDraft: assetFiles.isDraft, isIgnored: assetFiles.isIgnored,
    })
    .from(assetFiles)
    .where(and(eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId)))
    .limit(1);
  if (!f || f.deletedAt || f.groupedInto) return null;
  const liens = (await pgClient.unsafe(
    `SELECT asset_id, link_role FROM document_asset_links
      WHERE file_id = $1 AND account_id = $2 AND status = 'ACTIVE' AND asset_id IS NOT NULL AND link_role IN ('PRIMARY', 'SECONDARY')`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ asset_id: number; link_role: string }>;
  const primaires = new Set(liens.filter((l) => l.link_role === 'PRIMARY').map((l) => Number(l.asset_id)));
  const tous = new Set(liens.map((l) => Number(l.asset_id)));
  for (const c of [f.assetId, f.linkedAssetId]) if (c) { primaires.add(c); tous.add(c); }
  return {
    userId: f.userId as number | null,
    open: !f.isDraft && !f.isIgnored,
    columnAssetId: f.assetId ?? null,
    linkedAssetId: f.linkedAssetId ?? null,
    userEdited: (f.edited as Record<string, unknown> | null)?.assetId === true,
    /** Biens auxquels le document est rattaché (principal). */
    primary: primaires,
    /** Biens auxquels le document est rattaché (principal ou lié). */
    attached: tous,
  };
}

async function assetNames(accountId: number, ids: number[]): Promise<Map<number, string>> {
  const rows = (await pgClient.unsafe(
    `SELECT id, name FROM assets WHERE account_id = $1 AND deleted_at IS NULL AND id = ANY($2::int[])`,
    [accountId, ids] as never[],
  )) as unknown as Array<{ id: number; name: string | null }>;
  return new Map(rows.map((r) => [Number(r.id), r.name ?? `Bien ${r.id}`]));
}

/**
 * Ouvre (ou met à jour) la carte d'incohérence d'un document rattaché par
 * l'utilisateur à A, que l'analyse désigne comme concernant B. Rien si :
 * A = B, l'un des biens n'existe plus, le document n'est plus rattaché à A,
 * il est déjà rattaché à B (document multi-biens), ou l'utilisateur a déjà
 * tranché ce même couple (« Garder A », « Ignorer »). Ne lève jamais.
 */
export async function proposeDocumentAssetConflict(p: {
  accountId: number; fileId: number; currentAssetId: number; suggestedAssetId: number;
  basis: AssetConflictBasis; kinds?: readonly string[];
}): Promise<UpsertActionResult> {
  try {
    if (p.currentAssetId === p.suggestedAssetId) return { status: 'SKIPPED', reason: 'Même bien.' };
    const etat = await attachmentOf(db, p.accountId, p.fileId);
    if (!etat || !etat.open) return { status: 'SKIPPED', reason: 'Document indisponible.' };
    if (!etat.primary.has(p.currentAssetId)) return { status: 'SKIPPED', reason: 'Document plus rattaché au bien choisi.' };
    if (etat.attached.has(p.suggestedAssetId)) return { status: 'SKIPPED', reason: 'Document déjà rattaché aux deux biens.' };
    const noms = await assetNames(p.accountId, [p.currentAssetId, p.suggestedAssetId]);
    if (!noms.has(p.currentAssetId) || !noms.has(p.suggestedAssetId)) return { status: 'SKIPPED', reason: 'Bien introuvable.' };

    // Couple déjà tranché par l'utilisateur : la carte ne revient pas.
    const [derniere] = await db.select({ reason: toProcessActions.resolutionReason, ctx: toProcessActions.triggerContext })
      .from(toProcessActions)
      .where(and(
        eq(toProcessActions.accountId, p.accountId), eq(toProcessActions.targetType, 'DOCUMENT'),
        eq(toProcessActions.targetId, p.fileId), eq(toProcessActions.relationKey, ASSET_CONFLICT_RELATION),
        isNotNull(toProcessActions.resolvedAt),
      ))
      .orderBy(desc(toProcessActions.resolvedAt)).limit(1);
    const ctxPrec = derniere?.ctx as Partial<AssetConflictContext> | null | undefined;
    if ((derniere?.reason === 'USER_ARBITRATED' || derniere?.reason === 'NOT_APPLICABLE')
        && ctxPrec?.currentAssetId === p.currentAssetId && ctxPrec?.suggestedAssetId === p.suggestedAssetId) {
      return { status: 'SKIPPED', reason: 'Incohérence déjà tranchée par l’utilisateur.' };
    }

    const kinds = [...new Set(p.kinds ?? [])].sort();
    const currentName = noms.get(p.currentAssetId)!;
    const suggestedName = noms.get(p.suggestedAssetId)!;
    const ctx: AssetConflictContext = {
      kind: 'asset_conflict', currentAssetId: p.currentAssetId, suggestedAssetId: p.suggestedAssetId, basis: p.basis, kinds,
    };
    return await upsertAction({
      accountId: p.accountId,
      targetType: 'DOCUMENT',
      targetId: p.fileId,
      relationKey: ASSET_CONFLICT_RELATION,
      actionKind: 'ARBITRATE',
      ruleCode: ASSET_CONFLICT_RULE,
      question: assetConflictQuestion({ basis: p.basis, kinds, currentName, suggestedName }),
      proposals: assetConflictProposals({ ...p, currentName, suggestedName }),
      triggerContext: ctx as unknown as Record<string, unknown>,
    });
  } catch (e) {
    console.error(`[to-process] incohérence de rattachement du document ${p.fileId} non signalée :`, (e as Error).message);
    return { status: 'SKIPPED', reason: (e as Error).message };
  }
}

/**
 * Nouvelle analyse SANS incohérence : une carte encore ouverte est close
 * (OBSOLETE). Ne lève jamais. Rend le nombre de cartes closes.
 */
export async function clearDocumentAssetConflict(accountId: number, fileId: number): Promise<number> {
  try {
    const now = new Date();
    const rows = await db.update(toProcessActions)
      .set({ resolvedAt: now, resolutionReason: 'OBSOLETE' satisfies ResolutionReason, updatedAt: now })
      .where(and(
        eq(toProcessActions.accountId, accountId), eq(toProcessActions.targetType, 'DOCUMENT'),
        eq(toProcessActions.targetId, fileId), eq(toProcessActions.relationKey, ASSET_CONFLICT_RELATION),
        isNull(toProcessActions.resolvedAt),
      ))
      .returning({ id: toProcessActions.id });
    return rows.length;
  } catch (e) {
    console.error(`[to-process] incohérence de rattachement du document ${fileId} non close :`, (e as Error).message);
    return 0;
  }
}

/**
 * Balayage « À traiter » : cartes devenues sans objet — document plus
 * rattaché à A, déjà rattaché à B (autre chemin), bien A ou B supprimé.
 * Une seule requête par compte. Rend le nombre de cartes closes.
 */
export async function closeObsoleteAssetConflicts(accountId: number): Promise<number> {
  const rows = (await pgClient.unsafe(
    `WITH cartes AS (
       SELECT a.id, a.target_id AS file_id,
              (a.trigger_context ->> 'currentAssetId')::int AS cur, (a.trigger_context ->> 'suggestedAssetId')::int AS sug
         FROM to_process_actions a
        WHERE a.account_id = $1 AND a.target_type = 'DOCUMENT' AND a.rule_code = $2 AND a.resolved_at IS NULL)
     UPDATE to_process_actions t
        SET resolved_at = now(), resolution_reason = 'OBSOLETE', updated_at = now()
       FROM cartes c
       JOIN asset_files f ON f.id = c.file_id AND f.account_id = $1
      WHERE t.id = c.id
        AND (NOT EXISTS (SELECT 1 FROM assets x WHERE x.id = c.cur AND x.account_id = $1 AND x.deleted_at IS NULL)
          OR NOT EXISTS (SELECT 1 FROM assets x WHERE x.id = c.sug AND x.account_id = $1 AND x.deleted_at IS NULL)
          OR NOT (f.asset_id IS NOT DISTINCT FROM c.cur OR f.linked_asset_id IS NOT DISTINCT FROM c.cur
                  OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.status = 'ACTIVE'
                                AND l.asset_id = c.cur AND l.link_role = 'PRIMARY'))
          OR f.asset_id IS NOT DISTINCT FROM c.sug OR f.linked_asset_id IS NOT DISTINCT FROM c.sug
          OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.status = 'ACTIVE'
                        AND l.asset_id = c.sug AND l.link_role IN ('PRIMARY', 'SECONDARY')))
      RETURNING t.id`,
    [accountId, ASSET_CONFLICT_RULE] as never[],
  )) as unknown as unknown[];
  return rows.length;
}

// ══════════════════════════════════════════════════════════════════════════
// RÉSOLUTION (appelée par `resolveArbitration`, dans SA transaction)
// ══════════════════════════════════════════════════════════════════════════

type Action = typeof toProcessActions.$inferSelect;

export type AssetConflictChoice = { kind: 'KEEP' } | { kind: 'IGNORE' } | { kind: 'MOVE'; assetId: number };

/** Choix reçu de la carte (pure) ; `null` : invalide. */
export function parseAssetConflictChoice(value: unknown, ctx: Pick<AssetConflictContext, 'suggestedAssetId'>): AssetConflictChoice | null {
  if (value === 'KEEP') return { kind: 'KEEP' };
  if (value === 'IGNORE') return { kind: 'IGNORE' };
  if (typeof value === 'string' && /^MOVE:\d+$/.test(value)) {
    const id = Number(value.slice(5));
    // Seul le bien désigné par la carte est accepté (une requête forgée ne déplace rien ailleurs).
    return id === ctx.suggestedAssetId ? { kind: 'MOVE', assetId: id } : null;
  }
  return null;
}

/** Valeur conservée dans la trace : de quoi annuler. */
interface Previous { choice: AssetConflictChoice['kind']; assetId: number | null; linkedAssetId: number | null; userEdited: boolean; assetIdAuto: unknown }

export async function resolveDocumentAssetConflict(
  tx: DbClient,
  action: Action,
  value: unknown,
  accountId: number,
  options: ResolveOptions,
): Promise<ResolveResult & { afterCommit?: () => Promise<void> }> {
  const ctx = action.triggerContext as AssetConflictContext | null;
  if (!ctx?.currentAssetId || !ctx.suggestedAssetId) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const choice = parseAssetConflictChoice(value, ctx);
  if (!choice) return { ok: false, previousValue: null, error: 'INVALID_VALUE' };

  const [f] = await tx.select({
    assetId: assetFiles.assetId, linkedAssetId: assetFiles.linkedAssetId, edited: assetFiles.userEditedFields, userId: assetFiles.userId,
  }).from(assetFiles)
    .where(and(eq(assetFiles.id, action.targetId), eq(assetFiles.accountId, accountId), isNull(assetFiles.deletedAt)))
    .for('update')
    .limit(1);
  if (!f) return { ok: false, previousValue: null, error: 'NOT_FOUND' };
  const now = new Date();
  const perimer = async (): Promise<ResolveResult> => {
    await tx.update(toProcessActions).set({ resolvedAt: now, resolutionReason: 'OBSOLETE' satisfies ResolutionReason, updatedAt: now })
      .where(eq(toProcessActions.id, action.id));
    await tx.insert(toProcessActionEvents).values({
      actionId: action.id, accountId, event: 'OBSOLETE', actorUserId: options.userId ?? null,
      targetType: action.targetType, targetId: action.targetId, fieldKey: action.relationKey,
      previousValue: null as never, newValue: null as never,
      details: { ruleCode: action.ruleCode, reason: 'ATTACHMENT_CHANGED' }, createdAt: now,
    });
    return { ok: false, previousValue: null, error: 'STALE' };
  };

  // Le document doit toujours être rattaché à A (colonnes ou lien PRIMARY) :
  // sinon l'utilisateur a déjà tranché ailleurs — carte périmée.
  const etat = await attachmentOf(tx, accountId, action.targetId);
  if (!etat || !etat.primary.has(ctx.currentAssetId)) return perimer();

  const edited = (f.edited as Record<string, unknown> | null) ?? {};
  const previous: Previous = {
    choice: choice.kind, assetId: f.assetId ?? null, linkedAssetId: f.linkedAssetId ?? null,
    userEdited: edited.assetId === true, assetIdAuto: edited.assetIdAuto ?? null,
  };

  if (choice.kind === 'MOVE') {
    const [b] = await tx.select({ id: assets.id }).from(assets)
      .where(and(eq(assets.id, choice.assetId), eq(assets.accountId, accountId), isNull(assets.deletedAt))).limit(1);
    if (!b) return perimer();
    // Déplacement DEMANDÉ par l'utilisateur : bien principal = B, A n'est
    // plus un rattachement (colonne secondaire comprise), choix utilisateur.
    await tx.update(assetFiles).set({
      assetId: choice.assetId,
      linkedAssetId: sql`CASE WHEN ${assetFiles.linkedAssetId} = ${ctx.currentAssetId} THEN NULL ELSE ${assetFiles.linkedAssetId} END`,
      userEditedFields: sql`(COALESCE(${assetFiles.userEditedFields}, '{}'::jsonb) - 'assetIdAuto') || '{"assetId": true}'::jsonb`,
      updatedAt: now,
    }).where(and(eq(assetFiles.id, action.targetId), eq(assetFiles.accountId, accountId)));
  } else if (choice.kind === 'KEEP') {
    // « Garder A » : le rattachement devient une décision utilisateur
    // explicite (colonne A, jamais déplacée par une analyse).
    await tx.update(assetFiles).set({
      assetId: sql`COALESCE(${assetFiles.assetId}, ${ctx.currentAssetId}::int)`,
      userEditedFields: sql`(COALESCE(${assetFiles.userEditedFields}, '{}'::jsonb) - 'assetIdAuto') || '{"assetId": true}'::jsonb`,
      updatedAt: now,
    }).where(and(eq(assetFiles.id, action.targetId), eq(assetFiles.accountId, accountId)));
  }

  const reason: ResolutionReason = choice.kind === 'IGNORE' ? 'NOT_APPLICABLE' : 'USER_ARBITRATED';
  await tx.update(toProcessActions).set({ resolvedAt: now, resolutionReason: reason, updatedAt: now })
    .where(eq(toProcessActions.id, action.id));
  await tx.insert(toProcessActionEvents).values({
    actionId: action.id,
    accountId,
    event: choice.kind === 'IGNORE' ? 'NOT_APPLICABLE' : 'RESOLVED_ARBITRATION',
    actorUserId: options.userId ?? null,
    targetType: action.targetType,
    targetId: action.targetId,
    fieldKey: action.relationKey,
    previousValue: previous as never,
    newValue: { choice: choice.kind, assetId: choice.kind === 'MOVE' ? choice.assetId : ctx.currentAssetId } as never,
    details: { ruleCode: action.ruleCode, cycleNumber: action.cycleNumber, choice: choice.kind, conflict: ctx },
    createdAt: now,
  });

  const userId = options.userId ?? f.userId ?? null;
  return {
    ok: true,
    previousValue: previous,
    afterCommit: choice.kind === 'MOVE'
      ? () => afterMove({ accountId, fileId: action.targetId, userId, from: ctx.currentAssetId, to: choice.assetId })
      : undefined,
  };
}

/** Après un déplacement A → B : relation N-N, preuves, fiche de B (hors transaction ; ne lève jamais). */
async function afterMove(p: { accountId: number; fileId: number; userId: number | null; from: number; to: number }): Promise<void> {
  try {
    const { linkDocumentToAsset, unlinkDocument } = await import('@/services/documents/document-asset-links');
    await unlinkDocument({ accountId: p.accountId, fileId: p.fileId, target: { assetId: p.from }, origins: ['USER', 'AI', 'MIGRATION'] });
    await linkDocumentToAsset({ accountId: p.accountId, fileId: p.fileId, target: { assetId: p.to }, role: 'PRIMARY', origin: 'USER' });
    if (p.userId) {
      const { onDocumentAssetChanged } = await import('@/services/ai/evidence/document-evidence-lifecycle');
      await onDocumentAssetChanged({ accountId: p.accountId, userId: p.userId, fileId: p.fileId, fromAssetId: p.from, toAssetId: p.to });
      const k = await import('@/services/ai/knowledge/document-knowledge.service');
      if (await k.hasProjectableKnowledge(p.fileId)) {
        await k.projectDocumentKnowledgeToAsset({ accountId: p.accountId, userId: p.userId, fileId: p.fileId, assetId: p.to });
      }
    }
  } catch (e) {
    console.error(`[to-process] déplacement du document ${p.fileId} vers le bien ${p.to} : suites non appliquées :`, (e as Error).message);
  }
}

/**
 * Annulation (§8.5) : l'état précédent du rattachement est restauré — sauf
 * si le document a encore changé depuis — et la MÊME carte est rouverte.
 */
export async function undoDocumentAssetConflict(action: Action, accountId: number): Promise<ResolveResult> {
  const ctx = action.triggerContext as AssetConflictContext | null;
  const [ev] = await db.select({ previousValue: toProcessActionEvents.previousValue })
    .from(toProcessActionEvents)
    .where(and(
      eq(toProcessActionEvents.actionId, action.id), eq(toProcessActionEvents.accountId, accountId),
      sql`${toProcessActionEvents.event} IN ('RESOLVED_ARBITRATION', 'NOT_APPLICABLE')`,
    ))
    .orderBy(desc(toProcessActionEvents.id)).limit(1);
  const prev = (ev?.previousValue ?? null) as Previous | null;
  let moveBack: { from: number; to: number; userId: number | null } | null = null;
  await db.transaction(async (tx) => {
    if (prev && ctx && prev.choice !== 'IGNORE') {
      const [f] = await tx.select({ assetId: assetFiles.assetId, userId: assetFiles.userId }).from(assetFiles)
        .where(and(eq(assetFiles.id, action.targetId), eq(assetFiles.accountId, accountId), isNull(assetFiles.deletedAt)))
        .for('update').limit(1);
      const attendu = prev.choice === 'MOVE' ? ctx.suggestedAssetId : (prev.assetId ?? ctx.currentAssetId);
      if (f && f.assetId === attendu) {
        const edited = prev.userEdited
          ? sql`'{"assetId": true}'::jsonb` : sql`'{}'::jsonb`;
        const auto = prev.assetIdAuto != null ? sql`jsonb_build_object('assetIdAuto', ${Number(prev.assetIdAuto)}::int)` : sql`'{}'::jsonb`;
        await tx.update(assetFiles).set({
          assetId: prev.assetId,
          linkedAssetId: prev.linkedAssetId,
          userEditedFields: sql`((COALESCE(${assetFiles.userEditedFields}, '{}'::jsonb) - 'assetId') - 'assetIdAuto') || ${edited} || ${auto}`,
          updatedAt: new Date(),
        }).where(and(eq(assetFiles.id, action.targetId), eq(assetFiles.accountId, accountId)));
        if (prev.choice === 'MOVE') moveBack = { from: ctx.suggestedAssetId, to: ctx.currentAssetId, userId: f.userId ?? null };
      }
    }
    await tx.update(toProcessActions)
      .set({ resolvedAt: null, resolutionReason: null, lastSeenAt: new Date(), updatedAt: new Date() })
      .where(and(eq(toProcessActions.id, action.id), eq(toProcessActions.accountId, accountId)));
  });
  const retour = moveBack as { from: number; to: number; userId: number | null } | null;
  if (retour) {
    try {
      const { linkDocumentToAsset, unlinkDocument } = await import('@/services/documents/document-asset-links');
      await unlinkDocument({ accountId, fileId: action.targetId, target: { assetId: retour.from }, origins: ['USER'] });
      // A redevient le bien choisi (lien USER, comme avant le déplacement ; sans
      // effet si la colonne restaurée le porte déjà).
      await linkDocumentToAsset({ accountId, fileId: action.targetId, target: { assetId: retour.to }, role: 'PRIMARY', origin: 'USER' });
      if (retour.userId) {
        const { onDocumentAssetChanged } = await import('@/services/ai/evidence/document-evidence-lifecycle');
        await onDocumentAssetChanged({ accountId, userId: retour.userId, fileId: action.targetId, fromAssetId: retour.from, toAssetId: retour.to });
      }
    } catch (e) {
      console.error(`[to-process] annulation du déplacement du document ${action.targetId} : suites non appliquées :`, (e as Error).message);
    }
  }
  return { ok: true, previousValue: null };
}
