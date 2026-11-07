/**
 * Lot 113V (#719, post-MEP) — « Aucun » sur la carte « À quel bien rattacher
 * ce document ? » : enregistrement, annulation et lecture de la décision.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE CIRCUIT CANONIQUE DE LA FILE, SANS SECOND MOTEUR
 *
 *   · clic « Aucun » → route `/api/v2/to-process/[publicId]/resolve`
 *     (mode `arbitrate`, valeur `NONE`) → `resolveArbitration` : carte relue
 *     et VERROUILLÉE (`FOR UPDATE`) dans la transaction — deux clics
 *     simultanés ou une reprise ne créent jamais deux décisions
 *     (ALREADY_RESOLVED au second) ;
 *   · décision = la mémoire de décision existante de la file : carte close
 *     « Non applicable » (§7.4 — jamais recréée sans élément nouveau,
 *     `NOT_APPLICABLE_UNCHANGED`, pont documentaire `naRelation`) et trace
 *     `NOT_APPLICABLE` portant le CONTEXTE du choix : candidats, biens
 *     présentés, révision du document, issue T3 précédente, relations
 *     conservées (preuve que rien d'autre n'est touché) ;
 *   · issue T3 du document : `USER_DECIDED` / `USER_NO_ASSET` (distincte
 *     de « indéterminé » et de « non examiné ») ;
 *   · AUCUN lien, aucune colonne, aucun statut documentaire écrits : le
 *     document reste tel quel (extraction, classement, recherche, liens
 *     d'équipement ou de pièce, biens cités).
 *
 * « Annuler » rouvre la MÊME carte (§8.5) et rétablit l'issue T3 précédente.
 * Un rattachement choisi ensuite (fiche du document, autre carte) prime :
 * la décision cesse d'être en vigueur (`explicitNoAssetSql`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { toProcessActionEvents, toProcessActions } from '@/db/schema';
import type { ActionProposal, ResolutionReason } from './action-model';
import type { DbClient, ResolveOptions, ResolveResult } from './resolve-action.service';
import {
  explicitNoAssetSql, NO_ASSET_EVENT_CHOICE, NO_ASSET_REASON_CODE, parseNoAssetDecision, type ExplicitNoAssetDecision,
} from './no-asset-choice';

type LockedAction = typeof toProcessActions.$inferSelect;

const posInt = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v.trim()) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Issue T3 du document avant le choix (rétablie par « Annuler »). */
interface ResolutionBefore { status: string; lastOutcome: string | null; method: string | null; reasonCode: string | null }

async function readResolutionBefore(accountId: number, fileId: number): Promise<ResolutionBefore | null> {
  const rows = (await pgClient.unsafe(
    `SELECT status, last_outcome, method, reason_code FROM document_asset_resolutions WHERE file_id = $1 AND account_id = $2`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ status: string; last_outcome: string | null; method: string | null; reason_code: string | null }>;
  const r = rows[0];
  return r ? { status: r.status, lastOutcome: r.last_outcome, method: r.method, reasonCode: r.reason_code } : null;
}

/** Relations du document conservées par le choix (trace d'audit, jamais modifiées). */
async function keptRelations(accountId: number, fileId: number): Promise<Array<{ role: string; origin: string; target: string }>> {
  const rows = (await pgClient.unsafe(
    `SELECT link_role, origin, asset_id, equipment_id, substructure_id FROM document_asset_links
      WHERE file_id = $1 AND account_id = $2 AND status = 'ACTIVE' ORDER BY id LIMIT 50`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ link_role: string; origin: string; asset_id: number | null; equipment_id: number | null; substructure_id: number | null }>;
  return rows.map((r) => ({
    role: r.link_role, origin: r.origin,
    target: r.equipment_id != null ? `equipment:${r.equipment_id}` : r.substructure_id != null ? `room:${r.substructure_id}` : `asset:${r.asset_id}`,
  }));
}

/**
 * « Aucun » — appelé par `resolveArbitration` DANS sa transaction, carte
 * verrouillée et encore ouverte. Rien n'est écrit sur le document.
 */
export async function resolveNoAssetChoice(
  tx: DbClient,
  action: LockedAction,
  accountId: number,
  options: ResolveOptions,
): Promise<ResolveResult & { afterCommit?: () => Promise<void> }> {
  if (action.ruleCode !== 'LINK-ASSET' || action.targetType !== 'DOCUMENT' || (action.relationKey ?? action.fieldKey) !== 'assetIds') {
    return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  }
  const { documentExists } = await import('./document-slots');
  if (!(await documentExists(tx, accountId, action.targetId))) return { ok: false, previousValue: null, error: 'NOT_FOUND' };

  // Contexte du choix : candidats de la carte, TOUS les biens présentés
  // (lot 113A : la carte montre les biens éligibles du compte), révision du
  // document, issue T3 précédente, relations conservées.
  const proposals = ((action.proposalsJson as ActionProposal[] | null) ?? []).filter((p) => !p.isCurrentValue);
  const candidateAssetIds = [...new Set(proposals.map((p) => posInt(p.value)).filter((x): x is number => x !== null))];
  const { loadEligibleLinkAssets } = await import('./asset-link-choices');
  const eligibles = await loadEligibleLinkAssets(accountId);
  const offeredAssetIds = [...new Set([...candidateAssetIds, ...eligibles.map((a) => a.id)])].sort((a, b) => a - b);
  let knowledgeRev: string | null = null;
  try {
    const { currentKnowledgeRev } = await import('./document-field-evidence');
    knowledgeRev = await currentKnowledgeRev(accountId, action.targetId);
  } catch (e) {
    console.error('[to-process] contexte du choix « Aucun » non lu :', (e as Error).message);
  }
  const before = await readResolutionBefore(accountId, action.targetId);
  const relations = await keptRelations(accountId, action.targetId);
  const now = new Date();

  await options.onAfterFieldWrite?.();

  await tx.update(toProcessActions)
    .set({ resolvedAt: now, resolutionReason: 'NOT_APPLICABLE' satisfies ResolutionReason, updatedAt: now })
    .where(eq(toProcessActions.id, action.id));
  await tx.insert(toProcessActionEvents).values({
    actionId: action.id,
    accountId,
    event: 'NOT_APPLICABLE',
    actorUserId: options.userId ?? null,
    targetType: action.targetType,
    targetId: action.targetId,
    fieldKey: 'assetIds',
    previousValue: null as never,
    newValue: null as never,
    details: {
      ruleCode: action.ruleCode, cycleNumber: action.cycleNumber, choice: NO_ASSET_EVENT_CHOICE,
      source: 'TO_PROCESS_CARD', candidateAssetIds, offeredAssetIds, proposals: action.proposalsJson ?? null,
      knowledgeRev, resolutionBefore: before, keptRelations: relations,
      questionSource: (action.questionSource as unknown) ?? null,
    } as never,
    createdAt: now,
  });

  return {
    ok: true,
    previousValue: null,
    afterCommit: () => markResolutionNoAsset(accountId, action.targetId, { actionId: action.id, at: now.toISOString(), offeredAssetIds, candidateAssetIds }),
  };
}

/**
 * Issue T3 du document → `USER_DECIDED` / `USER_NO_ASSET`, empreintes
 * conservées (la décision n'est réévaluée que si le contexte change). Hors
 * transaction ; ne lève jamais (la trace de la carte fait foi).
 */
async function markResolutionNoAsset(accountId: number, fileId: number, detail: Record<string, unknown>): Promise<void> {
  try {
    await pgClient.unsafe(
      `INSERT INTO document_asset_resolutions (file_id, account_id, status, last_outcome, method, reason_code, decided_at, updated_at, last_evaluation)
       VALUES ($1, $2, 'USER_DECIDED', 'USER_DECIDED', 'NONE', $3, now(), now(), jsonb_build_object('explicitNoAsset', $4::jsonb))
       ON CONFLICT (file_id) DO UPDATE SET
         status = 'USER_DECIDED', last_outcome = 'USER_DECIDED', method = 'NONE', reason_code = $3, decided_at = now(), updated_at = now(),
         last_evaluation = COALESCE(document_asset_resolutions.last_evaluation, '{}'::jsonb) || jsonb_build_object('explicitNoAsset', $4::jsonb)
       WHERE document_asset_resolutions.account_id = $2`,
      [fileId, accountId, NO_ASSET_REASON_CODE, JSON.stringify(detail)] as never[],
    );
  } catch (e) {
    console.error(`[to-process] issue T3 « Aucun » du document ${fileId} non écrite :`, (e as Error).message);
  }
}

/**
 * « Annuler » après « Aucun » : la MÊME carte est rouverte (aucun nouveau
 * cycle), l'issue T3 précédente rétablie. Rend null si la carte n'a pas été
 * close par « Aucun » (annulation ordinaire).
 */
export async function undoNoAssetChoice(action: LockedAction, accountId: number): Promise<ResolveResult | null> {
  if (action.ruleCode !== 'LINK-ASSET') return null;
  const rows = (await pgClient.unsafe(
    `SELECT details FROM to_process_action_events
      WHERE action_id = $1 AND account_id = $2 AND event = 'NOT_APPLICABLE' AND details ->> 'choice' = $3
      ORDER BY id DESC LIMIT 1`,
    [action.id, accountId, NO_ASSET_EVENT_CHOICE] as never[],
  )) as unknown as Array<{ details: { resolutionBefore?: ResolutionBefore | null } | string | null }>;
  if (!rows[0]) return null;
  if (action.resolutionReason !== 'NOT_APPLICABLE' || action.resolvedAt === null) {
    // Déjà rouverte (double « Annuler », reprise) : rien de plus.
    return action.resolvedAt === null ? { ok: true, previousValue: null } : null;
  }
  const d = (typeof rows[0].details === 'string' ? JSON.parse(rows[0].details) : rows[0].details) as { resolutionBefore?: ResolutionBefore | null } | null;
  const before = d?.resolutionBefore ?? null;
  const now = new Date();
  const rouverte = await db.transaction(async (tx) => {
    const r = await tx.update(toProcessActions)
      .set({ resolvedAt: null, resolutionReason: null, lastSeenAt: now, updatedAt: now })
      .where(and(eq(toProcessActions.id, action.id), eq(toProcessActions.accountId, accountId), eq(toProcessActions.resolutionReason, 'NOT_APPLICABLE')))
      .returning({ id: toProcessActions.id });
    if (!r.length) return false;
    await tx.insert(toProcessActionEvents).values({
      actionId: action.id, accountId, event: 'REOPENED', actorUserId: null, targetType: action.targetType, targetId: action.targetId,
      fieldKey: 'assetIds', details: { ruleCode: action.ruleCode, cycleNumber: action.cycleNumber, reason: 'USER_UNDO_NO_ASSET' } as never, createdAt: now,
    });
    return true;
  });
  if (rouverte) {
    try {
      if (before) {
        await pgClient.unsafe(
          `UPDATE document_asset_resolutions SET status = $3, last_outcome = $4, method = $5, reason_code = $6, updated_at = now()
            WHERE file_id = $1 AND account_id = $2 AND reason_code = $7`,
          [action.targetId, accountId, before.status, before.lastOutcome, before.method, before.reasonCode, NO_ASSET_REASON_CODE] as never[],
        );
      } else {
        await pgClient.unsafe(
          `DELETE FROM document_asset_resolutions WHERE file_id = $1 AND account_id = $2 AND reason_code = $3 AND status = 'USER_DECIDED'`,
          [action.targetId, accountId, NO_ASSET_REASON_CODE] as never[],
        );
      }
    } catch (e) {
      console.error(`[to-process] issue T3 du document ${action.targetId} non rétablie après « Annuler » :`, (e as Error).message);
    }
  }
  return { ok: true, previousValue: null };
}

/**
 * Décision « Aucun » EN VIGUEUR pour un document (bornée au compte), ou null.
 * Ne lève jamais : une lecture impossible rend null (comportement d'avant).
 */
export async function readExplicitNoAssetDecision(accountId: number, fileId: number): Promise<ExplicitNoAssetDecision | null> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT na.id AS action_id, na.resolved_at AS decided_at, ne.actor_user_id AS user_id, ne.details
         FROM asset_files f
         JOIN to_process_actions na ON na.account_id = f.account_id AND na.target_type = 'DOCUMENT' AND na.target_id = f.id
              AND na.rule_code = 'LINK-ASSET' AND na.resolution_reason = 'NOT_APPLICABLE'
         JOIN to_process_action_events ne ON ne.action_id = na.id AND ne.account_id = na.account_id
              AND ne.event = 'NOT_APPLICABLE' AND ne.details ->> 'choice' = $3
        WHERE f.id = $1 AND f.account_id = $2 AND ${explicitNoAssetSql('f')}
        ORDER BY na.resolved_at DESC, ne.id DESC
        LIMIT 1`,
      [fileId, accountId, NO_ASSET_EVENT_CHOICE] as never[],
    )) as unknown as Array<{ action_id: unknown; decided_at: unknown; user_id: unknown; details: unknown }>;
    return Array.isArray(rows) ? parseNoAssetDecision(rows[0]) : null;
  } catch (e) {
    console.error(`[to-process] décision « Aucun » du document ${fileId} illisible :`, (e as Error).message);
    return null;
  }
}

/** Une décision « Aucun » est-elle en vigueur ? (ne lève jamais) */
export async function explicitNoAssetActive(accountId: number, fileId: number): Promise<boolean> {
  return (await readExplicitNoAssetDecision(accountId, fileId)) !== null;
}

