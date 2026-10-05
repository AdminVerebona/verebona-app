/**
 * Cartes « À traiter » des conflits de champ d'un ÉQUIPEMENT ou d'une PIÈCE —
 * CDC 15 T1-04, §11.1 (lot 18, R3 ; pièce : lot 19) — règles ENTITY-FIELD et
 * ENTITY-FIELD-ROOM.
 *
 * Même mécanisme que le conflit de champ d'un bien (`reconciliation-bridge`) :
 * les DÉCISIONS de la réconciliation ciblée (`reconcileEntity`) sont
 * traduites, jamais recalculées :
 *   · `create_conflict` → carte ARBITRATE (cible EQUIPMENT, `field_key` =
 *     clé canonique), propositions : la valeur proposée par la preuve et la
 *     valeur en place (« valeur actuelle ») ; une seule carte active par
 *     champ (`upsertAction`) ;
 *   · `apply` / `update` / `keep` → la carte du champ devient sans objet
 *     (OBSOLETE) ;
 *   · résolution : la valeur choisie — seulement une valeur proposée — est
 *     écrite par `writeCanonicalEntityField`, origine USER, sous contrôle
 *     optimiste (valeur en place à l'ouverture, `triggerContext.current`) ;
 *     sinon carte PÉRIMÉE, rien écrit. Annulation : valeur précédente
 *     réécrite sous le même contrôle, carte rouverte.
 *
 * PIÈCE (ROOM, lot 19) : même mécanisme, règle ENTITY-FIELD-ROOM, cible
 * ROOM = SOUS-STRUCTURE (`substructures.id`, décision D-G, lot 20) ; libellé
 * « nom de la pièce » et bien porteur résolus par `to-process-query.service`,
 * ouverture dans le tiroir de la pièce (`openToProcessTarget`). Une carte
 * d'une autre cible (LEGACY_ROOM suspendue par 0229) n'écrit jamais rien.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { toProcessActionEvents, toProcessActions } from '@/db/schema';
import { getField } from '@/services/canonical/registry';
import type { CanonicalEntityTarget } from '@/services/canonical/entity-state';
import type { ReconciliationDecision } from '@/services/ai/reconciliation/types';
import type { ActionProposal, ResolutionReason } from './action-model';
import type { DbClient, ResolveOptions, ResolveResult } from './resolve-action.service';
import { resolveActionsForData, upsertAction } from './to-process-action.service';
import { perimer, valueLabel } from './migration-review-cards';

export const ENTITY_FIELD_RULE = 'ENTITY-FIELD';
export const ENTITY_FIELD_ROOM_RULE = 'ENTITY-FIELD-ROOM';
/** Règles des cartes de champ d'entité, par type de cible. */
export const ENTITY_FIELD_RULES: Readonly<Record<'EQUIPMENT' | 'ROOM', string>> = {
  EQUIPMENT: ENTITY_FIELD_RULE, ROOM: ENTITY_FIELD_ROOM_RULE,
};
export const isEntityFieldRule = (code: string | null | undefined) => code === ENTITY_FIELD_RULE || code === ENTITY_FIELD_ROOM_RULE;

type Scalar = string | number | boolean | null;
const scalar = (v: unknown): Scalar => (v === null || v === undefined ? null
  : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : JSON.stringify(v));

/** Propositions d'un conflit (pures, testées) : preuve proposée, puis valeur en place. */
export function entityConflictProposals(d: ReconciliationDecision): ActionProposal[] {
  const proposals: ActionProposal[] = [];
  const proposee = scalar(d.proposedValue);
  if (proposee !== null) {
    proposals.push({
      value: proposee, label: valueLabel(d.fieldKey, proposee),
      confidence: d.confidence === 'certain' ? 1 : d.confidence === 'probable' ? 0.6 : 0.3,
      evidenceIds: d.evidenceIds.map(String),
    });
  }
  const courante = scalar(d.currentValue);
  if (courante !== null && courante !== proposee) {
    proposals.push({ value: courante, label: valueLabel(d.fieldKey, courante), confidence: 1, isCurrentValue: true });
  }
  return proposals;
}

export interface EntityCardsResult { created: number; resolved: number; skipped: number }

/**
 * Traduit les décisions d'une réconciliation ciblée en mouvements de file.
 * Ne lève jamais (une carte manquée se rattrape au passage suivant).
 */
export async function syncEntityFieldCards(p: {
  accountId: number; target: CanonicalEntityTarget; entityName?: string | null; decisions: readonly ReconciliationDecision[];
}): Promise<EntityCardsResult> {
  const out: EntityCardsResult = { created: 0, resolved: 0, skipped: 0 };
  const type = p.target.type;
  const ruleCode = ENTITY_FIELD_RULES[type];
  if (!ruleCode) { out.skipped = p.decisions.length; return out; }
  const de = type === 'ROOM' ? 'de la pièce' : 'de l’équipement';
  const conflits = new Set(p.decisions.filter((d) => d.action === 'create_conflict').map((d) => d.fieldKey));
  for (const d of p.decisions) {
    try {
      if (d.action === 'create_conflict') {
        const label = getField(d.fieldKey)?.label ?? d.fieldKey;
        const r = await upsertAction({
          accountId: p.accountId, targetType: type, targetId: p.target.id, fieldKey: d.fieldKey,
          actionKind: 'ARBITRATE', ruleCode,
          question: `Deux valeurs différentes pour « ${label} » ${p.entityName ? `de ${p.entityName}` : de}. Laquelle garder ?`.slice(0, 300),
          proposals: entityConflictProposals(d),
          triggerContext: { kind: 'entity_field', key: d.fieldKey, current: scalar(d.currentValue), reasonCode: d.reasonCode },
        });
        if (r.status === 'CREATED') out.created += 1; else if (r.status === 'SKIPPED') out.skipped += 1;
      } else if ((d.action === 'apply' || d.action === 'update' || d.action === 'keep') && !conflits.has(d.fieldKey)) {
        out.resolved += await resolveActionsForData(p.accountId, type, p.target.id, d.fieldKey, 'OBSOLETE');
      } else {
        out.skipped += 1;
      }
    } catch (e) {
      out.skipped += 1;
      console.error(`[to-process] carte du champ ${d.fieldKey} (${type} ${p.target.id}) :`, (e as Error).message);
    }
  }
  return out;
}

type Action = typeof toProcessActions.$inferSelect;
type Ctx = { key?: string; current?: Scalar };

async function ecrire(action: Action, accountId: number, key: string, value: unknown, expected: unknown, userId: number | null) {
  // Cible stricte : une carte d'une autre cible (ex. LEGACY_ROOM, D-G) n'écrit jamais sur un équipement.
  if (action.targetType !== 'ROOM' && action.targetType !== 'EQUIPMENT') return null;
  const { writeCanonicalEntityField } = await import('@/services/canonical/entity-state');
  return writeCanonicalEntityField({
    target: { type: action.targetType, id: action.targetId }, accountId, key, value, origin: 'USER', actorUserId: userId,
    expectedCurrent: expected ?? null, source: { type: 'to_process', id: action.publicId },
  });
}

/** Résolution (appelée par `resolveArbitration`, dans SA transaction). */
export async function resolveEntityFieldCard(
  tx: DbClient, action: Action, value: unknown, accountId: number, options: ResolveOptions,
): Promise<ResolveResult> {
  const ctx = action.triggerContext as Ctx | null;
  const key = ctx?.key ?? action.fieldKey;
  const proposees = (action.proposalsJson as ActionProposal[] | null) ?? [];
  if (!key || !proposees.some((p) => p.value === value)) return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  const res = await ecrire(action, accountId, key, value, ctx?.current ?? null, options.userId ?? null);
  if (!res) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const f = res.field;
  if (f?.outcome === 'conflict') return perimer(tx, action, accountId, options.userId ?? null);
  if (res.notFound || res.skipped || !f || f.outcome === 'invalid') {
    return { ok: false, previousValue: null, error: res.notFound ? 'NOT_FOUND' : 'INVALID_VALUE' };
  }
  const now = new Date();
  await tx.update(toProcessActions).set({
    resolvedAt: now, resolutionReason: 'USER_ARBITRATED' satisfies ResolutionReason, updatedAt: now,
  }).where(eq(toProcessActions.id, action.id));
  await tx.insert(toProcessActionEvents).values({
    actionId: action.id, accountId, event: 'RESOLVED_ARBITRATION', actorUserId: options.userId ?? null,
    targetType: action.targetType, targetId: action.targetId, fieldKey: action.fieldKey,
    previousValue: (f.previousValue ?? null) as never, newValue: (f.nextValue ?? value ?? null) as never,
    details: { ruleCode: action.ruleCode, cycleNumber: action.cycleNumber, key },
    createdAt: now,
  });
  return { ok: true, previousValue: f.previousValue ?? null };
}

/** Annulation : valeur précédente réécrite si la valeur en place est toujours celle de la résolution. */
export async function undoEntityFieldCard(action: Action, accountId: number): Promise<ResolveResult> {
  const key = (action.triggerContext as Ctx | null)?.key ?? action.fieldKey;
  if (!key) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const [ev] = await db.select({ prev: toProcessActionEvents.previousValue, next: toProcessActionEvents.newValue })
    .from(toProcessActionEvents)
    .where(and(eq(toProcessActionEvents.actionId, action.id), eq(toProcessActionEvents.accountId, accountId),
      eq(toProcessActionEvents.event, 'RESOLVED_ARBITRATION')))
    .orderBy(desc(toProcessActionEvents.id)).limit(1);
  if (!ev || action.resolutionReason !== 'USER_ARBITRATED') return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const res = await ecrire(action, accountId, key, ev.prev ?? null, ev.next ?? null, null);
  if (!res) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  if (res.field?.outcome === 'conflict') return perimer(db, action, accountId, null);
  if (res.notFound || !res.field || res.field.outcome === 'invalid') return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  await db.update(toProcessActions).set({ resolvedAt: null, resolutionReason: null, lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(toProcessActions.id, action.id));
  return { ok: true, previousValue: ev.prev ?? null };
}
