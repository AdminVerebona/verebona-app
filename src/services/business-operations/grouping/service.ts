/**
 * SERVICE UNIQUE DE REGROUPEMENT des Opérations (lot 82D — CDC « Opérations,
 * Agenda, Timeline, Sinistres v5 », lot O-1 : §8, §10, §11, §27.5, §28 ;
 * arbitrages PO V-Q4, V-Q5, V-Q6, V-Q8).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL CHEMIN D'ÉCRITURE DU REGROUPEMENT
 *
 * Toute écriture de l'appartenance d'un élément d'agenda à une Opération
 * (`agenda_items.business_operation_id`, `operation_role`), de l'appartenance
 * d'un document (`business_operation_documents`), des Pièces
 * (`business_operation_room_links`), de la propagation vers le principal
 * (`agenda_file_links.provenances` OPERATION_PRINCIPAL) et des décisions
 * utilisateur de regroupement passe par ce service. Il réutilise le dépôt des
 * Opérations (`repository.ts` : création, sources, biens, équipements,
 * invalidation, FUSION existante 55B / 78A) — aucun second modèle, aucune
 * seconde fusion.
 *
 *   attachAgendaItem / detachAgendaItem   0..1 Opération par élément (§6.1),
 *                                         déplacement explicite seulement ;
 *   designatePrincipal / releasePrincipal rôle PRINCIPAL décidé par T4 ou
 *                                         l'utilisateur (V-Q5) — jamais déduit ;
 *   attachDocument / detachDocument       appartenance ≠ provenance (§27.3) ;
 *   attachRoom / detachRoom               Pièces (table `substructures`, V-Q6) ;
 *   attachEquipment / detachEquipment     équipements existants (V-Q8) ;
 *   attachAsset / detachAsset             biens ;
 *   linkAgendaItems                       Agenda ↔ Agenda, quatre cas (§8.3) ;
 *   mergeOperations                       fusion existante du dépôt ;
 *   recomputePrincipal                    unicité + propagation (P4, §11.9) ;
 *   recomputeOperation                    membres, principal, existence (§8.4) ;
 *   deleteOrInvalidateOperation           invalidation, objets sources conservés.
 *
 * Décisions utilisateur (§10) : tout geste USER est mémorisé
 * (`decisions.ts`) ; une inférence (T3, T4, SYSTEM) ne recrée jamais un
 * rattachement refusé et ne remplace jamais un principal posé par
 * l'utilisateur. Aucun lien intercomptes (§28) : chaque objet est relu dans
 * le compte, sous le verrou 39101 du compte.
 *
 * Contexte : `groupingContext(session)` dans une écriture Opération
 * (`withGroupingWrite`) — requis pour créer, fusionner, invalider ; ou
 * `runnerContext(runner)` pour les seules écritures d'agenda (projection T4,
 * consolidation 76H, cartes « À traiter »).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { withBusinessOperationWrite, type WriteOptions, type WriteSession } from '../write';
import type { BusinessOperationRepository } from '../repository';
import { isRejected, recordAssetDecision, recordGroupingDecision } from './decisions';
import { canReplacePrincipal, planLinkAgendaItems, type OperationRole, type RoleOrigin } from './model';
import { currentPrincipal, recomputePrincipal as recompute, stripPrincipalLinks, type PrincipalRecompute } from './principal';
import { drizzleRunner, intArray, lockGroupingAccount, type GroupingRunner } from './runner';

export type GroupingErrorCode =
  | 'ITEM_NOT_FOUND' | 'OPERATION_NOT_FOUND' | 'OPERATION_INACTIVE' | 'CROSS_ACCOUNT' | 'LINKED_ELSEWHERE'
  | 'SESSION_REQUIRED' | 'SAME_ITEM' | 'MERGE_REFUSED';

/** Erreur TECHNIQUE du regroupement (jamais une carte « À traiter ») ; annule la transaction. */
export class GroupingError extends Error {
  constructor(readonly code: GroupingErrorCode, message: string) {
    super(`[grouping] ${code} : ${message}`);
    this.name = 'GroupingError';
  }
}

export interface GroupingContext {
  runner: GroupingRunner;
  accountId: number;
  actorUserId: number | null;
  correlationId: string | null;
  /** Écriture Opération ouverte (dépôt, événements après commit). */
  session?: WriteSession;
}

export function groupingContext(session: WriteSession, accountId: number): GroupingContext {
  return { runner: drizzleRunner(session.tx), accountId, actorUserId: session.actorUserId, correlationId: session.correlationId, session };
}

export function runnerContext(runner: GroupingRunner, accountId: number, opts: { actorUserId?: number | null; correlationId?: string | null } = {}): GroupingContext {
  return { runner, accountId, actorUserId: opts.actorUserId ?? null, correlationId: opts.correlationId ?? null };
}

/** Écriture de regroupement d'un compte : transaction, verrou, événements publiés après commit. */
export function withGroupingWrite<T>(accountId: number, fn: (ctx: GroupingContext) => Promise<T>, options: WriteOptions = {}): Promise<T> {
  return withBusinessOperationWrite(accountId, (_repo, session) => fn(groupingContext(session, accountId)), options);
}

// ── Lectures internes (sous verrou) ────────────────────────────────────────

interface ItemRow {
  id: number; account_id: number; op: number | null; role: OperationRole | null; origin: RoleOrigin | null;
  projected: boolean; op_active: boolean | null; op_account: number | null;
}

async function loadItem(ctx: GroupingContext, itemId: number): Promise<ItemRow> {
  const [i] = await ctx.runner.q<ItemRow>(
    `SELECT i.id, i.account_id, i.business_operation_id::int AS op, i.operation_role AS role, i.operation_role_origin AS origin,
            (i.projection_origin IS NOT NULL) AS projected,
            (o.id IS NOT NULL AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS op_active,
            o.account_id AS op_account
       FROM agenda_items i LEFT JOIN business_operations o ON o.id = i.business_operation_id
      WHERE i.id = $1 FOR UPDATE OF i`,
    [itemId],
  );
  if (!i) throw new GroupingError('ITEM_NOT_FOUND', `Élément d'agenda ${itemId} introuvable.`);
  if (Number(i.account_id) !== ctx.accountId) throw new GroupingError('CROSS_ACCOUNT', `Élément d'agenda ${itemId} d'un autre compte.`);
  return { ...i, op: i.op === null ? null : Number(i.op) };
}

async function loadOperation(ctx: GroupingContext, operationId: number, opts: { allowInactive?: boolean } = {}): Promise<{ id: number; active: boolean; merged: number | null }> {
  const [o] = await ctx.runner.q<{ id: string; account_id: number; active: boolean; merged: string | null }>(
    `SELECT id, account_id, (invalidated_at IS NULL AND merged_into_operation_id IS NULL) AS active, merged_into_operation_id AS merged
       FROM business_operations WHERE id = $1 FOR UPDATE`,
    [operationId],
  );
  if (!o) throw new GroupingError('OPERATION_NOT_FOUND', `Opération ${operationId} introuvable.`);
  if (Number(o.account_id) !== ctx.accountId) throw new GroupingError('CROSS_ACCOUNT', `Opération ${operationId} d'un autre compte.`);
  if (!o.active && !opts.allowInactive) throw new GroupingError('OPERATION_INACTIVE', `Opération ${operationId} inactive ou fusionnée.`);
  return { id: Number(o.id), active: o.active, merged: o.merged === null ? null : Number(o.merged) };
}

async function history(ctx: GroupingContext, operationId: number, reasonCode: string, before: unknown, after: unknown): Promise<void> {
  await ctx.runner.q(
    `INSERT INTO business_operation_history (account_id, operation_id, event_type, reason_code, actor_user_id, before_json, after_json, correlation_id)
     VALUES ($1, $2, 'UPDATED', $3, $4, $5::text::jsonb, $6::text::jsonb, $7)`,
    [ctx.accountId, operationId, reasonCode, ctx.actorUserId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), ctx.correlationId],
  );
}

/** Signal après commit (projection T4 de l'Opération : le principal et ses liens sont réévalués). */
function notify(ctx: GroupingContext, operationId: number, reasonCode: string): void {
  ctx.session?.events.push({ type: 'BUSINESS_OPERATION_UPDATED', accountId: ctx.accountId, operationId, reasonCode });
}

function requireSession(ctx: GroupingContext, what: string): { session: WriteSession; repo: BusinessOperationRepository } {
  if (!ctx.session) throw new GroupingError('SESSION_REQUIRED', `${what} exige une écriture Opération (withGroupingWrite).`);
  return { session: ctx.session, repo: ctx.session.repository(ctx.accountId) };
}

// ── Éléments d'agenda (§6.1, §11) ──────────────────────────────────────────

export interface AttachAgendaInput {
  operationId: number;
  itemId: number;
  /** Rôle voulu ; défaut : rôle actuel dans cette Opération, sinon RELATED. */
  role?: OperationRole;
  origin: RoleOrigin;
  reasonCode: string;
  /** Déplacement depuis une autre Opération active (geste utilisateur seulement). */
  move?: boolean;
}

export interface AttachAgendaResult {
  changed: boolean;
  role: OperationRole | null;
  skipped?: 'USER_REJECTED' | 'LINKED_ELSEWHERE' | 'PRINCIPAL_PROTECTED';
}

/**
 * Rattache un élément d'agenda à une Opération (même compte, Opération
 * active). Une inférence ne recrée jamais un rattachement refusé et ne
 * déplace jamais un élément d'une autre Opération active.
 */
export async function attachAgendaItem(ctx: GroupingContext, p: AttachAgendaInput): Promise<AttachAgendaResult> {
  await lockGroupingAccount(ctx.runner, ctx.accountId);
  await loadOperation(ctx, p.operationId);
  const item = await loadItem(ctx, p.itemId);
  const user = p.origin === 'USER';
  if (!user && await isRejected(ctx.runner, ctx.accountId, p.operationId, 'AGENDA', p.itemId)) return { changed: false, role: null, skipped: 'USER_REJECTED' };
  if (item.op !== null && item.op !== p.operationId && item.op_active) {
    if (!(user && p.move)) return { changed: false, role: item.role, skipped: 'LINKED_ELSEWHERE' };
    await detachAgendaItem(ctx, { itemId: p.itemId, operationId: item.op, origin: 'USER', reasonCode: `${p.reasonCode}_MOVED_OUT` });
    item.op = null;
    item.role = null;
  }
  const meme = item.op === p.operationId;
  let role: OperationRole = p.role ?? (meme && item.role ? item.role : 'RELATED');
  let skipped: AttachAgendaResult['skipped'];
  if (role === 'PRINCIPAL') {
    const cur = await currentPrincipal(ctx.runner, ctx.accountId, p.operationId);
    if (cur && cur.itemId !== p.itemId) {
      if (canReplacePrincipal(cur.origin, p.origin)) {
        await stripPrincipalLinks(ctx.runner, [cur.itemId]);
        await ctx.runner.q(`UPDATE agenda_items SET operation_role = 'RELATED', updated_at = now() WHERE id = $1 AND account_id = $2`, [cur.itemId, ctx.accountId]);
      } else {
        role = 'RELATED';
        skipped = 'PRINCIPAL_PROTECTED';
      }
    }
  } else if (meme && item.role === 'PRINCIPAL' && p.role === 'RELATED' && !canReplacePrincipal(item.origin, p.origin)) {
    // Un principal posé par l'utilisateur n'est pas rétrogradé par une inférence.
    return { changed: false, role: 'PRINCIPAL', skipped: 'PRINCIPAL_PROTECTED' };
  }
  const origine = meme && item.role === role && !p.role ? item.origin : p.origin;
  const changed = !meme || item.role !== role || (item.origin !== origine && role === 'PRINCIPAL');
  if (changed) {
    if (item.role === 'PRINCIPAL' && role !== 'PRINCIPAL') await stripPrincipalLinks(ctx.runner, [p.itemId]);
    await ctx.runner.q(
      `UPDATE agenda_items SET business_operation_id = $3, operation_role = $4, operation_role_origin = $5, updated_at = now()
        WHERE id = $1 AND account_id = $2`,
      [p.itemId, ctx.accountId, p.operationId, role, origine],
    );
    await history(ctx, p.operationId, p.reasonCode,
      meme ? { agenda_item_id: p.itemId, role: item.role } : null,
      { agenda_item_id: p.itemId, role, origin: origine });
    notify(ctx, p.operationId, p.reasonCode);
  }
  if (user) await recordGroupingDecision(ctx.runner, { accountId: ctx.accountId, operationId: p.operationId, subject: 'AGENDA', entityId: p.itemId, decision: 'CONFIRMED', reasonCode: p.reasonCode });
  if (changed) await recompute(ctx.runner, ctx.accountId, p.operationId);
  return { changed, role, ...(skipped ? { skipped } : {}) };
}

export interface DetachAgendaInput {
  itemId: number;
  /** Détache seulement si l'élément est ENCORE lié à cette Opération (null : quelle qu'elle soit). */
  operationId?: number | null;
  origin: RoleOrigin;
  reasonCode: string;
  /** Projection T4 : retire aussi ses marques (clé fonctionnelle de projection, origine, corrélation). */
  clearProjectionMarks?: boolean;
}

/** Détache un élément (l'élément reste) ; recalcule le principal ; geste utilisateur mémorisé. */
export async function detachAgendaItem(ctx: GroupingContext, p: DetachAgendaInput): Promise<{ changed: boolean; operationId: number | null }> {
  await lockGroupingAccount(ctx.runner, ctx.accountId);
  const item = await loadItem(ctx, p.itemId);
  const op = item.op;
  if (op === null || (p.operationId != null && op !== p.operationId)) {
    if (p.clearProjectionMarks && op === null && item.projected) {
      await ctx.runner.q(
        `UPDATE agenda_items SET functional_key = NULL, projection_origin = NULL, projection_correlation_id = NULL, updated_at = now()
          WHERE id = $1 AND account_id = $2 AND projection_origin IS NOT NULL`, [p.itemId, ctx.accountId]);
    }
    return { changed: false, operationId: op };
  }
  await stripPrincipalLinks(ctx.runner, [p.itemId]);
  await ctx.runner.q(
    `UPDATE agenda_items
        SET business_operation_id = NULL,
            ${p.clearProjectionMarks ? `functional_key = CASE WHEN projection_origin = 'OPERATION' THEN NULL ELSE functional_key END,
            projection_origin = NULL, projection_correlation_id = NULL,` : ''}
            updated_at = now()
      WHERE id = $1 AND account_id = $2`,
    [p.itemId, ctx.accountId],
  );
  // Opération d'un autre compte (lien historique) : aucune écriture sur elle.
  if (item.op_account !== null && Number(item.op_account) === ctx.accountId) {
    await history(ctx, op, p.reasonCode, { agenda_item_id: p.itemId, role: item.role }, null);
    if (p.origin === 'USER') {
      await recordGroupingDecision(ctx.runner, { accountId: ctx.accountId, operationId: op, subject: 'AGENDA', entityId: p.itemId, decision: 'REJECTED', reasonCode: p.reasonCode });
      // Regroupement créé par un lien utilisateur : la source de cet élément ne le justifie plus.
      const session = ctx.session;
      if (session) {
        const srcs = await ctx.runner.q<{ id: string }>(
          `SELECT id FROM business_operation_sources WHERE operation_id = $1 AND account_id = $2 AND active AND source_kind = 'AGENDA'
              AND source_entity_key = $3 AND locator ? 'grouping'`, [op, ctx.accountId, String(p.itemId)]);
        for (const s of srcs) await session.repository(ctx.accountId).deactivateSource(Number(s.id), p.reasonCode);
      }
    }
    notify(ctx, op, p.reasonCode);
    if (item.role === 'PRINCIPAL') await recompute(ctx.runner, ctx.accountId, op);
    if (ctx.session && p.origin === 'USER') await recomputeOperation(ctx, op, p.reasonCode);
  }
  return { changed: true, operationId: op };
}

/** Désigne le principal (décision T4 ou utilisateur, V-Q5). Voir `attachAgendaItem`. */
export function designatePrincipal(ctx: GroupingContext, p: Omit<AttachAgendaInput, 'role'>): Promise<AttachAgendaResult> {
  return attachAgendaItem(ctx, { ...p, role: 'PRINCIPAL' });
}

/** Retire le rôle principal (l'élément reste lié) — refusé à une inférence face à un choix utilisateur. */
export async function releasePrincipal(ctx: GroupingContext, p: { operationId: number; origin: RoleOrigin; reasonCode: string }): Promise<boolean> {
  await lockGroupingAccount(ctx.runner, ctx.accountId);
  const cur = await currentPrincipal(ctx.runner, ctx.accountId, p.operationId);
  if (!cur || !canReplacePrincipal(cur.origin, p.origin)) return false;
  await stripPrincipalLinks(ctx.runner, [cur.itemId]);
  await ctx.runner.q(`UPDATE agenda_items SET operation_role = 'RELATED', operation_role_origin = $3, updated_at = now() WHERE id = $1 AND account_id = $2`,
    [cur.itemId, ctx.accountId, p.origin]);
  await history(ctx, p.operationId, p.reasonCode, { principal_item_id: cur.itemId }, { principal_item_id: null });
  notify(ctx, p.operationId, p.reasonCode);
  await recompute(ctx.runner, ctx.accountId, p.operationId);
  return true;
}

/** Unicité du principal et propagation des documents (idempotent). */
export async function recomputePrincipal(ctx: GroupingContext, operationId: number): Promise<PrincipalRecompute> {
  await lockGroupingAccount(ctx.runner, ctx.accountId);
  return recompute(ctx.runner, ctx.accountId, operationId);
}

// ── Documents (§6.2, §27.3) ────────────────────────────────────────────────

/** Appartenance explicite (geste utilisateur) d'un document ; propagée au principal. */
export async function attachDocument(ctx: GroupingContext, p: { operationId: number; fileId: number; reasonCode: string }): Promise<boolean> {
  await lockGroupingAccount(ctx.runner, ctx.accountId);
  await loadOperation(ctx, p.operationId);
  const [existe] = await ctx.runner.q(`SELECT 1 FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [p.fileId, ctx.accountId]);
  if (!existe) throw new GroupingError('CROSS_ACCOUNT', `Document ${p.fileId} introuvable dans le compte.`);
  const x = await ctx.runner.q(
    `INSERT INTO business_operation_documents (account_id, operation_id, file_id, origins)
     SELECT $1, $2, f.id, ARRAY['USER']::text[] FROM asset_files f WHERE f.id = $3 AND f.account_id = $1 AND f.deleted_at IS NULL
     ON CONFLICT (operation_id, file_id) DO UPDATE
        SET origins = business_operation_documents.origins || ARRAY['USER']::text[], updated_at = now()
      WHERE NOT ('USER' = ANY(business_operation_documents.origins))
     RETURNING id`,
    [ctx.accountId, p.operationId, p.fileId],
  );
  await recordGroupingDecision(ctx.runner, { accountId: ctx.accountId, operationId: p.operationId, subject: 'DOCUMENT', entityId: p.fileId, decision: 'CONFIRMED', reasonCode: p.reasonCode });
  if (x.length) {
    await history(ctx, p.operationId, p.reasonCode, null, { file_id: p.fileId, membership: 'USER' });
    notify(ctx, p.operationId, p.reasonCode);
  }
  await recompute(ctx.runner, ctx.accountId, p.operationId);
  return x.length > 0;
}

/**
 * Dissociation utilisateur d'un document : refus mémorisé (T3 ne le
 * rattache plus, M0), appartenance retirée, preuves du document sur cette
 * Opération désactivées, Opération recalculée (existence, principal).
 */
export async function detachDocument(ctx: GroupingContext, p: { operationId: number; fileId: number; reasonCode: string }): Promise<boolean> {
  const { repo } = requireSession(ctx, 'detachDocument');
  await lockGroupingAccount(ctx.runner, ctx.accountId);
  await loadOperation(ctx, p.operationId, { allowInactive: true });
  await recordGroupingDecision(ctx.runner, { accountId: ctx.accountId, operationId: p.operationId, subject: 'DOCUMENT', entityId: p.fileId, decision: 'REJECTED', reasonCode: p.reasonCode });
  const u = await ctx.runner.q(`UPDATE business_operation_documents SET origins = array_remove(origins, 'USER'), updated_at = now()
                                  WHERE operation_id = $1 AND account_id = $2 AND file_id = $3 AND 'USER' = ANY(origins) RETURNING id`,
  [p.operationId, ctx.accountId, p.fileId]);
  const srcs = await ctx.runner.q<{ id: string }>(
    `SELECT id FROM business_operation_sources WHERE operation_id = $1 AND account_id = $2 AND active AND source_kind = 'DOCUMENT' AND source_entity_key = $3`,
    [p.operationId, ctx.accountId, String(p.fileId)]);
  let n = u.length;
  for (const s of srcs) if (await repo.deactivateSource(Number(s.id), p.reasonCode)) n++;
  await removeFileFromOperationItems(ctx, p.operationId, p.fileId);
  if (n) {
    const { reconsolidateOperation } = await import('../consolidation/consolidator');
    await reconsolidateOperation(repo, ctx.session!.tx, p.operationId, new Date().toISOString().slice(0, 10));
  }
  await recomputeOperation(ctx, p.operationId, p.reasonCode);
  return n > 0;
}

/** Retire la propagation du document vers le principal de l'Opération (liens précis conservés). */
async function removeFileFromOperationItems(ctx: GroupingContext, operationId: number, fileId: number): Promise<void> {
  const items = await ctx.runner.q<{ id: number }>(`SELECT id FROM agenda_items WHERE account_id = $1 AND business_operation_id = $2`, [ctx.accountId, operationId]);
  if (!items.length) return;
  const { removeFileLinkProvenance } = await import('./provenance');
  await removeFileLinkProvenance(ctx.runner, items.map((i) => Number(i.id)), [fileId], 'OPERATION_PRINCIPAL');
}

/** Lien propagé vers le principal retiré par l'utilisateur : refus mémorisé (la propagation ne le recrée plus). */
export async function rejectPrincipalLink(ctx: GroupingContext, p: { operationId: number; fileId: number; reasonCode: string }): Promise<void> {
  await lockGroupingAccount(ctx.runner, ctx.accountId);
  await recordGroupingDecision(ctx.runner, { accountId: ctx.accountId, operationId: p.operationId, subject: 'PRINCIPAL_LINK', entityId: p.fileId, decision: 'REJECTED', reasonCode: p.reasonCode });
}

// ── Pièces (V-Q6 : la Pièce existante, jamais un second modèle) ────────────

export interface AttachRoomInput {
  operationId: number;
  substructureId: number;
  origin: 'USER' | 'T3';
  authority?: 'USER' | 'DOCUMENT' | 'STRUCTURED' | 'INFERENCE';
  sourceId?: number | null;
  reasonCode: string;
}

/** Rattache une Pièce EXISTANTE (aucune création) ; une inférence respecte un refus utilisateur. */
export async function attachRoom(ctx: GroupingContext, p: AttachRoomInput): Promise<{ changed: boolean; skipped?: 'USER_REJECTED' }> {
  await lockGroupingAccount(ctx.runner, ctx.accountId);
  await loadOperation(ctx, p.operationId);
  if (p.origin !== 'USER' && await isRejected(ctx.runner, ctx.accountId, p.operationId, 'ROOM', p.substructureId)) return { changed: false, skipped: 'USER_REJECTED' };
  const authority = p.authority ?? (p.origin === 'USER' ? 'USER' : 'DOCUMENT');
  const [cur] = await ctx.runner.q<{ id: string; active: boolean }>(
    `SELECT id, active FROM business_operation_room_links WHERE operation_id = $1 AND substructure_id = $2`, [p.operationId, p.substructureId]);
  let changed = false;
  if (!cur) {
    // Garde de compte : déclencheur 0655 (la Pièce doit appartenir à un bien du compte).
    await ctx.runner.q(
      `INSERT INTO business_operation_room_links (account_id, operation_id, substructure_id, asset_id, authority, source_operation_source_id)
       SELECT $1, $2, s.id, s.asset_id, $4, $5 FROM substructures s WHERE s.id = $3`,
      [ctx.accountId, p.operationId, p.substructureId, authority, p.sourceId ?? null]);
    changed = true;
  } else if (!cur.active) {
    await ctx.runner.q(`UPDATE business_operation_room_links SET active = true, authority = $2, source_operation_source_id = COALESCE($3::bigint, source_operation_source_id), updated_at = now() WHERE id = $1`,
      [Number(cur.id), authority, p.sourceId ?? null]);
    changed = true;
  }
  if (changed) {
    await ctx.runner.q(
      `INSERT INTO business_operation_history (account_id, operation_id, event_type, reason_code, source_id, actor_user_id, before_json, after_json, correlation_id)
       VALUES ($1, $2, 'TARGET_CHANGED', $3, $4, $5, NULL, $6::text::jsonb, $7)`,
      [ctx.accountId, p.operationId, p.reasonCode, p.sourceId ?? null, ctx.actorUserId, JSON.stringify({ substructure_id: p.substructureId, active: true }), ctx.correlationId]);
    ctx.session?.events.push({ type: 'BUSINESS_OPERATION_TARGET_CHANGED', accountId: ctx.accountId, operationId: p.operationId, reasonCode: p.reasonCode });
  }
  if (p.origin === 'USER') await recordGroupingDecision(ctx.runner, { accountId: ctx.accountId, operationId: p.operationId, subject: 'ROOM', entityId: p.substructureId, decision: 'CONFIRMED', reasonCode: p.reasonCode });
  return { changed };
}

export async function detachRoom(ctx: GroupingContext, p: { operationId: number; substructureId: number; origin: 'USER' | 'T3'; reasonCode: string }): Promise<boolean> {
  await lockGroupingAccount(ctx.runner, ctx.accountId);
  await loadOperation(ctx, p.operationId, { allowInactive: true });
  const r = await ctx.runner.q(`UPDATE business_operation_room_links SET active = false, updated_at = now()
                                  WHERE operation_id = $1 AND account_id = $2 AND substructure_id = $3 AND active RETURNING id`,
  [p.operationId, ctx.accountId, p.substructureId]);
  if (r.length) {
    await ctx.runner.q(
      `INSERT INTO business_operation_history (account_id, operation_id, event_type, reason_code, actor_user_id, before_json, after_json, correlation_id)
       VALUES ($1, $2, 'TARGET_CHANGED', $3, $4, $5::text::jsonb, $6::text::jsonb, $7)`,
      [ctx.accountId, p.operationId, p.reasonCode, ctx.actorUserId, JSON.stringify({ substructure_id: p.substructureId, active: true }),
        JSON.stringify({ substructure_id: p.substructureId, active: false }), ctx.correlationId]);
    ctx.session?.events.push({ type: 'BUSINESS_OPERATION_TARGET_CHANGED', accountId: ctx.accountId, operationId: p.operationId, reasonCode: p.reasonCode });
  }
  if (p.origin === 'USER') await recordGroupingDecision(ctx.runner, { accountId: ctx.accountId, operationId: p.operationId, subject: 'ROOM', entityId: p.substructureId, decision: 'REJECTED', reasonCode: p.reasonCode });
  return r.length > 0;
}

/**
 * Pièces voulues par la consolidation T3 (cibles ROOM certaines de T1) :
 * liens posés par T3 et plus soutenus retirés, liens voulus posés — refus
 * utilisateur respectés, liens de l'utilisateur jamais retirés.
 */
export async function syncOperationRoomsFromT3(
  ctx: GroupingContext, operationId: number, desired: ReadonlyArray<{ substructureId: number; sourceId: number }>, managedSourceIds: ReadonlySet<number>,
): Promise<number> {
  const cur = await ctx.runner.q<{ substructure_id: number; src: string | null }>(
    `SELECT substructure_id, source_operation_source_id AS src FROM business_operation_room_links WHERE operation_id = $1 AND account_id = $2 AND active`,
    [operationId, ctx.accountId]);
  const voulus = new Set(desired.map((d) => d.substructureId));
  let n = 0;
  for (const l of cur) {
    if (!voulus.has(Number(l.substructure_id)) && l.src !== null && managedSourceIds.has(Number(l.src))) {
      if (await detachRoom(ctx, { operationId, substructureId: Number(l.substructure_id), origin: 'T3', reasonCode: 'T3_TARGET_WITHDRAWN' })) n++;
    }
  }
  for (const d of desired) {
    if ((await attachRoom(ctx, { operationId, substructureId: d.substructureId, origin: 'T3', authority: 'DOCUMENT', sourceId: d.sourceId, reasonCode: 'T3_TARGET_LINKED' })).changed) n++;
  }
  return n;
}

// ── Équipements et biens existants (V-Q8) ──────────────────────────────────

export async function attachEquipment(
  ctx: GroupingContext, p: { operationId: number; equipmentId: number; origin: 'USER' | 'T3'; sourceId?: number | null; reasonCode: string },
): Promise<{ changed: boolean; skipped?: 'USER_REJECTED' }> {
  const { repo } = requireSession(ctx, 'attachEquipment');
  if (p.origin !== 'USER' && await isRejected(ctx.runner, ctx.accountId, p.operationId, 'EQUIPMENT', p.equipmentId)) return { changed: false, skipped: 'USER_REJECTED' };
  const changed = await repo.linkEquipment(p.operationId, { equipmentId: p.equipmentId, authority: p.origin === 'USER' ? 'USER' : 'DOCUMENT', sourceId: p.sourceId ?? null }, p.reasonCode);
  if (p.origin === 'USER') await recordGroupingDecision(ctx.runner, { accountId: ctx.accountId, operationId: p.operationId, subject: 'EQUIPMENT', entityId: p.equipmentId, decision: 'CONFIRMED', reasonCode: p.reasonCode });
  return { changed };
}

export async function detachEquipment(ctx: GroupingContext, p: { operationId: number; equipmentId: number; origin: 'USER' | 'T3'; reasonCode: string }): Promise<boolean> {
  const { repo } = requireSession(ctx, 'detachEquipment');
  const changed = await repo.unlinkEquipment(p.operationId, p.equipmentId, p.reasonCode);
  if (p.origin === 'USER') await recordGroupingDecision(ctx.runner, { accountId: ctx.accountId, operationId: p.operationId, subject: 'EQUIPMENT', entityId: p.equipmentId, decision: 'REJECTED', reasonCode: p.reasonCode });
  return changed;
}

export async function attachAsset(
  ctx: GroupingContext, p: { operationId: number; assetId: number; origin: 'USER' | 'T3'; role?: 'PRIMARY' | 'CONCERNED'; sourceId?: number | null; reasonCode: string },
): Promise<boolean> {
  const { session, repo } = requireSession(ctx, 'attachAsset');
  const changed = await repo.linkAsset(p.operationId, { assetId: p.assetId, role: p.role ?? 'CONCERNED', authority: p.origin === 'USER' ? 'USER' : 'DOCUMENT', sourceId: p.sourceId ?? null }, p.reasonCode);
  if (p.origin === 'USER') await recordAssetDecision(session.tx, { accountId: ctx.accountId, operationId: p.operationId, assetId: p.assetId, decision: 'CONFIRMED', userId: ctx.actorUserId, reasonCode: p.reasonCode });
  return changed;
}

export async function detachAsset(ctx: GroupingContext, p: { operationId: number; assetId: number; origin: 'USER' | 'T3'; reasonCode: string }): Promise<boolean> {
  const { session, repo } = requireSession(ctx, 'detachAsset');
  const changed = await repo.unlinkAsset(p.operationId, p.assetId, p.reasonCode);
  if (p.origin === 'USER') await recordAssetDecision(session.tx, { accountId: ctx.accountId, operationId: p.operationId, assetId: p.assetId, decision: 'REJECTED', userId: ctx.actorUserId, reasonCode: p.reasonCode });
  return changed;
}

// ── Agenda ↔ Agenda (§8.2, §8.3) ───────────────────────────────────────────

export interface LinkAgendaResult {
  case: 'CREATE' | 'ATTACH' | 'NOOP' | 'MERGE';
  operationId: number;
}

/**
 * Deux éléments associés par l'utilisateur rejoignent la même Opération : la
 * crée (type non qualifié : T3 qualifie, AC03), y rattache le second, ne fait
 * rien, ou FUSIONNE les deux Opérations par la fusion existante. Aucun graphe
 * pair-à-pair : le regroupement est l'Opération. Les éléments restent
 * distincts (aucune absorption) ; le principal reste la décision de T4.
 */
export async function linkAgendaItems(ctx: GroupingContext, p: { itemA: number; itemB: number; reasonCode?: string }): Promise<LinkAgendaResult> {
  const { repo } = requireSession(ctx, 'linkAgendaItems');
  const reason = p.reasonCode ?? 'USER_AGENDA_LINK';
  if (p.itemA === p.itemB) throw new GroupingError('SAME_ITEM', 'Un élément ne se relie pas à lui-même.');
  await lockGroupingAccount(ctx.runner, ctx.accountId);
  const a = await loadItem(ctx, p.itemA);
  const b = await loadItem(ctx, p.itemB);
  const opOf = (i: ItemRow) => (i.op !== null && i.op_active && Number(i.op_account) === ctx.accountId ? i.op : null);
  const plan = planLinkAgendaItems({ itemId: a.id, operationId: opOf(a) }, { itemId: b.id, operationId: opOf(b) });
  const source = (itemId: number) => ({ kind: 'AGENDA' as const, entityKey: itemId, authority: 'USER' as const, locator: { grouping: 'USER_LINK' }, matchReason: reason });
  let operationId: number;
  switch (plan.kind) {
    case 'CREATE': {
      const created = await repo.create({ type: null, status: 'ENVISAGED', source: source(a.id), reasonCode: reason });
      operationId = created.id;
      await repo.addSource(operationId, source(b.id), reason);
      await attachAgendaItem(ctx, { operationId, itemId: a.id, origin: 'USER', reasonCode: reason });
      await attachAgendaItem(ctx, { operationId, itemId: b.id, origin: 'USER', reasonCode: reason });
      break;
    }
    case 'ATTACH':
      operationId = plan.operationId;
      await repo.addSource(operationId, source(plan.itemId), reason);
      await attachAgendaItem(ctx, { operationId, itemId: plan.itemId, origin: 'USER', reasonCode: reason });
      break;
    case 'NOOP':
      operationId = plan.operationId;
      break;
    case 'MERGE':
      await mergeOperations(ctx, { absorbedId: plan.absorbedId, canonicalId: plan.canonicalId, reasonCode: reason });
      operationId = plan.canonicalId;
      break;
  }
  for (const id of [a.id, b.id]) {
    await recordGroupingDecision(ctx.runner, { accountId: ctx.accountId, operationId, subject: 'AGENDA', entityId: id, decision: 'CONFIRMED', reasonCode: reason });
  }
  return { case: plan.kind, operationId };
}

// ── Fusion, existence, invalidation ────────────────────────────────────────

/**
 * Fusion par la fusion EXISTANTE du dépôt (lots 42 / 55B / 78A), qui confie
 * sa part regroupement à `grouping/merge.ts`. Types incompatibles : refus
 * explicite (la qualification relève de T3, V-Q5).
 */
export async function mergeOperations(ctx: GroupingContext, p: { absorbedId: number; canonicalId: number; reasonCode: string }): Promise<boolean> {
  const { repo } = requireSession(ctx, 'mergeOperations');
  try {
    return await repo.mergeOperations(p.absorbedId, p.canonicalId, p.reasonCode);
  } catch (e) {
    if ((e as { code?: string }).code === 'MERGE_TYPE_MISMATCH') throw new GroupingError('MERGE_REFUSED', (e as Error).message);
    throw e;
  }
}

/**
 * Recalcul après correction (§8.4) : fusionnée → sa canonique ; plus
 * justifiée (aucune source de soutien) → invalidée, objets sources conservés ;
 * sinon principal et propagation recalculés.
 */
export async function recomputeOperation(ctx: GroupingContext, operationId: number, reasonCode: string): Promise<{ operationId: number; invalidated: boolean }> {
  const { repo } = requireSession(ctx, 'recomputeOperation');
  await lockGroupingAccount(ctx.runner, ctx.accountId);
  const op = await loadOperation(ctx, operationId, { allowInactive: true });
  if (op.merged !== null) return recomputeOperation(ctx, op.merged, reasonCode);
  if (op.active && await repo.invalidateIfUnsupported(operationId, `${reasonCode}_UNSUPPORTED`)) {
    await releaseInvalidatedOperation(ctx, operationId, reasonCode);
    return { operationId, invalidated: true };
  }
  if (!op.active) {
    await releaseInvalidatedOperation(ctx, operationId, reasonCode);
    return { operationId, invalidated: true };
  }
  await recompute(ctx.runner, ctx.accountId, operationId);
  return { operationId, invalidated: false };
}

/** Invalidation d'une Opération injustifiée (AC33) : aucun objet source supprimé. */
export async function deleteOrInvalidateOperation(ctx: GroupingContext, operationId: number, reasonCode: string): Promise<boolean> {
  const { repo } = requireSession(ctx, 'deleteOrInvalidateOperation');
  await lockGroupingAccount(ctx.runner, ctx.accountId);
  const changed = await repo.invalidate(operationId, reasonCode);
  await releaseInvalidatedOperation(ctx, operationId, reasonCode);
  return changed;
}

/**
 * Opération invalidée : ses éléments SAISIS ou T4 sont détachés (ils
 * restent dans l'Agenda) ; ses projections intactes sont laissées à la
 * projection T4, qui les retire sous trace (`OPERATION_PROJECTION`) — une
 * seule chaîne de retrait. Plus aucune propagation.
 */
async function releaseInvalidatedOperation(ctx: GroupingContext, operationId: number, reasonCode: string): Promise<void> {
  const items = await ctx.runner.q<{ id: number; projected: boolean }>(
    `SELECT id, projection_origin IS NOT NULL AS projected FROM agenda_items WHERE account_id = $1 AND business_operation_id = $2 ORDER BY id`,
    [ctx.accountId, operationId]);
  await stripPrincipalLinks(ctx.runner, items.map((i) => Number(i.id)));
  for (const i of items.filter((x) => !x.projected)) {
    await detachAgendaItem(ctx, { itemId: Number(i.id), operationId, origin: 'SYSTEM', reasonCode: `${reasonCode}_OPERATION_INVALIDATED` });
  }
  notify(ctx, operationId, reasonCode);
}

// ── Transfert entre comptes (§28) ──────────────────────────────────────────

/**
 * Déplacement d'un bien (Duo) : aucun regroupement ne franchit les comptes.
 * Éléments d'agenda liés à une Opération d'un autre compte détachés (rôle et
 * propagation retirés) ; appartenances USER et Pièces intercomptes retirées.
 * Appelée par `transferAssetDataInTx` (étape 9) dans sa transaction.
 */
export async function detachCrossAccountGroupingInTx(r: GroupingRunner, accountIds: readonly number[]): Promise<{ agendaItems: number; documents: number; rooms: number }> {
  const comptes = intArray(accountIds);
  for (const a of [...new Set(accountIds)].sort((x, y) => x - y)) await lockGroupingAccount(r, a);
  const items = await r.q<{ id: number }>(
    `SELECT ai.id FROM agenda_items ai JOIN business_operations o ON o.id = ai.business_operation_id
      WHERE ai.account_id = ANY($1::int[]) AND o.account_id <> ai.account_id`, [comptes]);
  if (items.length) {
    await stripPrincipalLinks(r, items.map((i) => Number(i.id)));
    await r.q(`UPDATE agenda_items SET business_operation_id = NULL, updated_at = now() WHERE id = ANY($1::int[])`, [intArray(items.map((i) => Number(i.id)))]);
  }
  const docs = await r.q(
    `UPDATE business_operation_documents d SET origins = array_remove(d.origins, 'USER'), updated_at = now()
       FROM asset_files f
      WHERE f.id = d.file_id AND d.account_id = ANY($1::int[]) AND f.account_id <> d.account_id AND 'USER' = ANY(d.origins)
     RETURNING d.id`, [comptes]);
  const rooms = await r.q(
    `UPDATE business_operation_room_links l SET active = false, updated_at = now()
       FROM assets a
      WHERE a.id = l.asset_id AND l.account_id = ANY($1::int[]) AND a.account_id <> l.account_id AND l.active
     RETURNING l.id`, [comptes]);
  return { agendaItems: items.length, documents: docs.length, rooms: rooms.length };
}
