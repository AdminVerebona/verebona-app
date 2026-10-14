/**
 * Carte « À traiter » de rapprochement agenda incertain (lot 53, retour PO
 * D14 ; CDC Opérations V1 C16.1, F-147).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * EN CAS DE DOUTE : NI PROJECTION, NI SILENCE — UNE QUESTION
 *
 * Quand la projection d'une réalité consolidée (intervention, sinistre,
 * achat…) dans l'Agenda hésite entre des événements existants (intitulé
 * proche, même document à une autre date, deux événements équivalents), elle
 * S'ABSTIENT toujours (aucun lien hasardeux, aucun doublon, aucune hypothèse
 * promue en événement confirmé) ; depuis le lot 53 elle pose une carte :
 *
 *   « Dans votre agenda, « Entretien chaudière » du 10/03/2026 correspond-il
 *     à « Intervention — Garage » du 12/03/2026 (d'après « Facture 123 ») ? »
 *
 *   · `ITEM:<id>`  — relier cet événement (au plus 2 candidats affichés) ;
 *   · `NEW`        — ajouter un nouvel événement (état actuel : rien n'est lié) ;
 *   · `NONE`       — ne rien ajouter à l'agenda (suppression mémorisée, C16.1).
 *
 * UNE carte par réalité et par clé de projection (relation
 * `agendaProjectionMatch:<id>:<clé>`), sur le BIEN concerné : un nouveau
 * passage T3 / T4 la met à jour (`upsertAction`), jamais une seconde carte ;
 * elle se ferme d'elle-même (OBSOLETE) quand la projection n'hésite plus
 * (élément lié, créé, supprimé par l'utilisateur, réalité invalidée).
 * Provenance : documents sources de la réalité et motif du rapprochement de
 * chaque candidat (`triggerContext`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { toProcessActionEvents, toProcessActions } from '@/db/schema';
import type { ActionProposal, ResolutionReason } from './action-model';
import type { DbClient, ResolveOptions, ResolveResult } from './resolve-action.service';
import { upsertAction } from './to-process-action.service';

export const AGENDA_PROJECTION_MATCH_RULE = 'AGENDA-PROJECTION-MATCH';
const RELATION = 'agendaProjectionMatch';
export const agendaProjectionRelationKey = (operationId: number, key: string) => `${RELATION}:${operationId}:${key}`;

/** Besoin de carte rendu par un passage de projection. */
export interface AgendaProjectionCardNeed {
  operationId: number;
  /** Clé de projection (`INTERVENTION`, `CLAIM`, `CONTRACT:END:…`). */
  key: string;
  assetId: number;
  /** Ce que la projection aurait créé. */
  desired: { title: string; date: string | null; typeCode: string | null };
  candidates: Array<{ itemId: number; title: string; date: string | null; reason: string }>;
  /** Documents sources de la réalité (provenance). */
  fileIds: number[];
}

// ── Libellés (purs) ─────────────────────────────────────────────────────────

const borne = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const g = (s: string) => `« ${borne(s, 50)} »`;
const frDate = (iso: string | null | undefined): string | null =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).split('-').reverse().join('/') : null;
const avecDate = (titre: string, d: string | null) => (frDate(d) ? `${g(titre)} du ${frDate(d)}` : g(titre));

export function agendaProjectionQuestion(
  desired: AgendaProjectionCardNeed['desired'], candidates: AgendaProjectionCardNeed['candidates'], documentTitle: string | null,
): string {
  const source = documentTitle ? ` (d’après ${g(documentTitle)})` : '';
  const [a, b] = candidates;
  if (!b) return `Dans votre agenda, ${avecDate(a.title, a.date)} correspond-il à ${avecDate(desired.title, desired.date)}${source} ?`;
  return `Votre agenda contient des événements proches de ${avecDate(desired.title, desired.date)}${source} : lequel lui correspond ?`;
}

export function agendaProjectionProposals(candidates: AgendaProjectionCardNeed['candidates']): ActionProposal[] {
  const seul = candidates.length === 1;
  return [
    ...candidates.slice(0, 2).map((c, i) => ({
      value: `ITEM:${c.itemId}`,
      label: seul ? 'Oui, c’est le même événement' : `Oui, ${avecDate(c.title, c.date)}`,
      confidence: 0.6 - i * 0.1,
    })),
    { value: 'NEW', label: 'Non, ajouter un nouvel événement', confidence: 1, isCurrentValue: true },
  ];
}

/** Choix reçu (pur) ; `null` : invalide (rien hors des candidats de la carte). */
export function parseAgendaProjectionChoice(value: unknown, ctx: unknown):
  { kind: 'ITEM'; itemId: number } | { kind: 'NEW' } | { kind: 'NONE' } | null {
  if (typeof value !== 'string' || !ctx || typeof ctx !== 'object') return null;
  if (value === 'NEW') return { kind: 'NEW' };
  if (value === 'NONE') return { kind: 'NONE' };
  const m = /^ITEM:(\d+)$/.exec(value);
  const c = ctx as { candidates?: Array<{ itemId: number }> };
  return m && (c.candidates ?? []).some((x) => x.itemId === Number(m[1])) ? { kind: 'ITEM', itemId: Number(m[1]) } : null;
}

// ── Producteur ──────────────────────────────────────────────────────────────

const intArray = (v: readonly number[]) => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;

/**
 * Pose / met à jour les cartes des abstentions incertaines d'un passage de
 * projection et ferme celles des réalités `reviewedOperationIds` qui n'hésitent
 * plus. Ne lève jamais (une carte manquée est reprise au passage suivant).
 */
export async function syncAgendaProjectionCards(
  accountId: number, needs: readonly AgendaProjectionCardNeed[], reviewedOperationIds: readonly number[],
): Promise<{ created: number; updated: number; closed: number }> {
  const rep = { created: 0, updated: 0, closed: 0 };
  try {
    const gardees = new Set<string>();
    const titres = new Map<number, string>();
    const fichiers = [...new Set(needs.flatMap((n) => n.fileIds))];
    if (fichiers.length) {
      const r = (await pgClient.unsafe(
        `SELECT id, COALESCE(retained_title, original_filename, filename, 'Document') AS t FROM asset_files
          WHERE account_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL`,
        [accountId, intArray(fichiers)] as never[],
      )) as unknown as Array<{ id: number; t: string }>;
      for (const x of r) titres.set(Number(x.id), x.t);
    }
    for (const n of needs) {
      if (!n.candidates.length) continue;
      const docs = n.fileIds.filter((f) => titres.has(f)).map((f) => ({ fileId: f, title: titres.get(f)! }));
      const relationKey = agendaProjectionRelationKey(n.operationId, n.key);
      const r = await upsertAction({
        accountId, targetType: 'ASSET', targetId: n.assetId, relationKey,
        actionKind: 'ARBITRATE', ruleCode: AGENDA_PROJECTION_MATCH_RULE,
        question: agendaProjectionQuestion(n.desired, n.candidates, docs[0]?.title ?? null),
        proposals: agendaProjectionProposals(n.candidates),
        triggerContext: {
          kind: 'agenda_projection_match', operationId: n.operationId, projectionKey: n.key, desired: n.desired,
          candidates: n.candidates, provenance: { documents: docs },
        },
      });
      if (r.status === 'CREATED') rep.created++;
      else if (r.status === 'UPDATED') rep.updated++;
      gardees.add(`${n.assetId}:${relationKey}`);
    }
    if (reviewedOperationIds.length) {
      const ouvertes = (await pgClient.unsafe(
        `SELECT id, target_id, relation_key FROM to_process_actions
          WHERE account_id = $1 AND rule_code = $2 AND resolved_at IS NULL
            AND (trigger_context->>'operationId')::bigint = ANY($3::bigint[])`,
        [accountId, AGENDA_PROJECTION_MATCH_RULE, intArray(reviewedOperationIds)] as never[],
      )) as unknown as Array<{ id: number; target_id: number; relation_key: string }>;
      const aFermer = ouvertes.filter((o) => !gardees.has(`${o.target_id}:${o.relation_key}`)).map((o) => Number(o.id));
      if (aFermer.length) rep.closed += await closeCards(aFermer, 'PROJECTION_RESOLVED');
    }
  } catch (e) {
    console.error(`[to-process] cartes de rapprochement agenda du compte ${accountId} non synchronisées :`, (e as Error).message);
  }
  return rep;
}

async function closeCards(ids: number[], reason: string): Promise<number> {
  const now = new Date();
  const closed = await db.update(toProcessActions)
    .set({ resolvedAt: now, resolutionReason: 'OBSOLETE' satisfies ResolutionReason, updatedAt: now })
    .where(and(sql`${toProcessActions.id} = ANY(${intArray(ids)}::int[])`, sql`${toProcessActions.resolvedAt} IS NULL`))
    .returning({ id: toProcessActions.id, accountId: toProcessActions.accountId, targetType: toProcessActions.targetType, targetId: toProcessActions.targetId, relationKey: toProcessActions.relationKey });
  if (closed.length) {
    await db.insert(toProcessActionEvents).values(closed.map((a) => ({
      actionId: a.id, accountId: a.accountId, event: 'OBSOLETE', actorUserId: null, targetType: a.targetType, targetId: a.targetId,
      fieldKey: a.relationKey, details: { ruleCode: AGENDA_PROJECTION_MATCH_RULE, reason }, createdAt: now,
    })));
  }
  return closed.length;
}

// ── Résolution ──────────────────────────────────────────────────────────────

type Action = typeof toProcessActions.$inferSelect;
interface Ctx { operationId: number; projectionKey: string; candidates: Array<{ itemId: number }> }

/**
 * Choix de l'utilisateur, dans la transaction de la file :
 *   · ITEM — l'événement choisi est relié à la réalité (seulement s'il n'est
 *     pas déjà celui d'une autre réalité active), puis la projection est
 *     rejouée (statut éventuel, sans réécrire la saisie de l'utilisateur) ;
 *   · NEW — la projection crée l'événement, sans nouveau rapprochement ;
 *   · NONE — « ne rien ajouter » : suppression mémorisée (C16.1).
 */
export async function resolveAgendaProjectionMatch(
  tx: DbClient, action: Action, value: unknown, accountId: number, options: ResolveOptions,
): Promise<ResolveResult & { afterCommit?: () => Promise<void> }> {
  const choice = parseAgendaProjectionChoice(value, action.triggerContext);
  if (!choice) return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  const ctx = action.triggerContext as unknown as Ctx;
  const t = tx as unknown as typeof db;
  const now = new Date();
  const [op] = (await t.execute(sql`
    SELECT id FROM business_operations WHERE id = ${ctx.operationId} AND account_id = ${accountId}
       AND invalidated_at IS NULL AND merged_into_operation_id IS NULL`)) as unknown as Array<{ id: string }>;
  let stale = !op;
  let linkedItemId: number | null = null;
  if (!stale && choice.kind === 'ITEM') {
    const r = (await t.execute(sql`
      UPDATE agenda_items i SET business_operation_id = ${ctx.operationId}, updated_at = now()
       WHERE i.id = ${choice.itemId} AND i.account_id = ${accountId}
         AND (i.business_operation_id IS NULL OR i.business_operation_id = ${ctx.operationId} OR NOT EXISTS (
               SELECT 1 FROM business_operations o WHERE o.id = i.business_operation_id
                  AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL))
      RETURNING i.id`)) as unknown as Array<{ id: number }>;
    if (!r.length) stale = true;
    else linkedItemId = Number(r[0].id);
  }
  if (!stale && choice.kind === 'NONE') {
    await t.execute(sql`
      INSERT INTO business_operation_projection_suppressions (account_id, operation_id, projection_kind, projection_key, user_id)
      VALUES (${accountId}, ${ctx.operationId}, 'AGENDA', ${ctx.projectionKey}, ${options.userId ?? null})
      ON CONFLICT (operation_id, projection_kind, projection_key) DO NOTHING`);
  }
  if (stale) {
    await t.update(toProcessActions).set({ resolvedAt: now, resolutionReason: 'OBSOLETE' satisfies ResolutionReason, updatedAt: now })
      .where(eq(toProcessActions.id, action.id));
    await t.insert(toProcessActionEvents).values({
      actionId: action.id, accountId, event: 'OBSOLETE', actorUserId: options.userId ?? null, targetType: action.targetType,
      targetId: action.targetId, fieldKey: action.relationKey, details: { ruleCode: action.ruleCode, reason: 'CANDIDATE_GONE' }, createdAt: now,
    });
    return { ok: false, previousValue: null, error: 'STALE' };
  }
  await t.update(toProcessActions).set({ resolvedAt: now, resolutionReason: 'USER_ARBITRATED' satisfies ResolutionReason, updatedAt: now })
    .where(eq(toProcessActions.id, action.id));
  await t.insert(toProcessActionEvents).values({
    actionId: action.id, accountId, event: 'RESOLVED_ARBITRATION', actorUserId: options.userId ?? null,
    targetType: action.targetType, targetId: action.targetId, fieldKey: action.relationKey,
    previousValue: null as never, newValue: { ...choice, linkedItemId } as never,
    details: { ruleCode: action.ruleCode, cycleNumber: action.cycleNumber, choice: choice.kind, context: action.triggerContext },
    createdAt: now,
  });
  const operationId = ctx.operationId;
  return {
    ok: true,
    previousValue: null,
    afterCommit: async () => {
      try {
        const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
        await projectAccountOperations(accountId, {
          operationIds: [operationId], correlationId: `to-process:${action.publicId}`,
          ...(choice.kind === 'NEW' ? { forceCreateOperationIds: [operationId] } : {}),
        });
      } catch (e) {
        console.error(`[to-process] rapprochement agenda ${action.publicId} : projection différée au passage suivant :`, (e as Error).message);
      }
    },
  };
}

/**
 * Annulation : le lien posé est retiré (ITEM), l'événement créé est retiré
 * s'il est resté intact (NEW), la suppression mémorisée est levée (NONE) ;
 * la MÊME carte est rouverte.
 */
export async function undoAgendaProjectionMatch(action: Action, accountId: number): Promise<ResolveResult> {
  const ctx = action.triggerContext as unknown as Ctx;
  await db.transaction(async (tx) => {
    const [ev] = await tx.select({ newValue: toProcessActionEvents.newValue }).from(toProcessActionEvents)
      .where(and(eq(toProcessActionEvents.actionId, action.id), eq(toProcessActionEvents.accountId, accountId), eq(toProcessActionEvents.event, 'RESOLVED_ARBITRATION')))
      .orderBy(desc(toProcessActionEvents.id)).limit(1);
    const v = (ev?.newValue ?? null) as { kind?: string; linkedItemId?: number | null } | null;
    if (v?.kind === 'ITEM' && v.linkedItemId) {
      await tx.execute(sql`
        UPDATE agenda_items SET business_operation_id = NULL, updated_at = now()
         WHERE id = ${v.linkedItemId} AND account_id = ${accountId} AND business_operation_id = ${ctx.operationId} AND projection_origin IS NULL`);
    }
    if (v?.kind === 'NONE') {
      await tx.execute(sql`
        DELETE FROM business_operation_projection_suppressions
         WHERE account_id = ${accountId} AND operation_id = ${ctx.operationId} AND projection_kind = 'AGENDA' AND projection_key = ${ctx.projectionKey}`);
    }
    await tx.update(toProcessActions)
      .set({ resolvedAt: null, resolutionReason: null, lastSeenAt: new Date(), updatedAt: new Date() })
      .where(and(eq(toProcessActions.id, action.id), eq(toProcessActions.accountId, accountId)));
  });
  const [ev] = await db.select({ newValue: toProcessActionEvents.newValue }).from(toProcessActionEvents)
    .where(and(eq(toProcessActionEvents.actionId, action.id), eq(toProcessActionEvents.event, 'RESOLVED_ARBITRATION')))
    .orderBy(desc(toProcessActionEvents.id)).limit(1);
  if ((ev?.newValue as { kind?: string } | null)?.kind === 'NEW') {
    // Élément créé par la projection : retiré seulement s'il est resté intact (convention §14.6).
    const r = (await pgClient.unsafe(
      `SELECT id FROM agenda_items WHERE account_id = $1 AND business_operation_id = $2 AND projection_origin = 'OPERATION'
          AND is_automatic AND NOT COALESCE(is_automatic_modified, false) AND (manual_status IS NULL OR manual_status = '')`,
      [accountId, ctx.operationId] as never[],
    )) as unknown as Array<{ id: number }>;
    if (r.length) {
      const { removeAgendaItemsTraced } = await import('@/services/agenda/agenda-removal-trace');
      await removeAgendaItemsTraced(pgClient, { accountId, ids: r.map((x) => Number(x.id)), reason: 'OPERATION_PROJECTION' });
    }
  }
  return { ok: true, previousValue: null };
}
