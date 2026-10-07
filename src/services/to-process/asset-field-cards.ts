/**
 * Résolution des cartes « donnée de BIEN » issues de la réconciliation —
 * règles `producer: 'RECONCILIATION_BRIDGE'` (DATA-REGISTRATION,
 * DATA-ACQUISITION-PRICE) — lot 32, ticket L32-1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT
 *
 * « Quel est le numéro d’immatriculation de ce bien ? — RK469970GP » : le clic
 * affichait « La valeur n’a pas pu être appliquée. ». Deux causes :
 *
 *   1. AUCUN écrivain : `resolveArbitration` cherchait un écrivain de la
 *      liste blanche (`FIELD_WRITERS`, documents et statuts seulement) pour
 *      une cible ASSET → `FIELD_NOT_RESOLVABLE` (422), pour TOUTE carte de
 *      donnée de bien, quel que soit le bien ;
 *   2. la carte n'aurait jamais dû exister : un vélo n'a pas d'immatriculation
 *      (capacité de catégorie `requiresCapability: 'registration'`,
 *      `isFieldApplicableToAsset`). Le producteur est corrigé en amont
 *      (collecte des preuves, pont, balayage, migration 0270) ; ici, une carte
 *      encore ouverte sur un champ sans objet est RETIRÉE (OBSOLETE) avec un
 *      message explicite, jamais appliquée.
 *
 * ── ÉCRITURE ──────────────────────────────────────────────────────────────
 *
 * La valeur passe par la primitive canonique (`writeCanonicalAssetField`,
 * origine USER : fiche, colonne miroir, journal), comme les cartes MIG-REVIEW
 * et ENTITY-FIELD ; la carte est close dans la transaction de la résolution.
 * Arbitrage : seule une valeur PROPOSÉE est acceptée (jamais une valeur
 * forgée). Complétion : la valeur saisie, normalisée par le registre.
 * Annulation : la valeur précédente, relue dans la trace SERVEUR de la
 * résolution, est réécrite si la valeur en place est toujours celle de la
 * résolution (contrôle optimiste) ; sinon carte périmée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { assets, toProcessActionEvents, toProcessActions } from '@/db/schema';
import { isFieldApplicableToAsset } from '@/services/canonical/registry';
import type { ActionProposal, ResolutionReason } from './action-model';
import type { DbClient, ResolveOptions, ResolveResult } from './resolve-action.service';
import { getRule } from './rules-catalog';
import { perimer } from './migration-review-cards';

type Action = typeof toProcessActions.$inferSelect;

/** Carte de donnée de bien produite par la réconciliation (pont T3) ? */
export function isAssetFieldCard(action: Pick<Action, 'targetType' | 'ruleCode' | 'fieldKey'>): boolean {
  return action.targetType === 'ASSET' && !!action.fieldKey
    && getRule(action.ruleCode)?.producer === 'RECONCILIATION_BRIDGE';
}

const memeValeur = (a: unknown, b: unknown) =>
  a === b || (a !== null && b !== null && a !== undefined && b !== undefined && String(a) === String(b));

async function lireBien(client: DbClient, assetId: number, accountId: number) {
  const [b] = await client.select({ category: assets.category, subtype: assets.subtype, deletedAt: assets.deletedAt })
    .from(assets).where(and(eq(assets.id, assetId), eq(assets.accountId, accountId))).limit(1);
  return b && !b.deletedAt ? b : null;
}

/** Carte sur un champ sans objet pour ce bien : retirée (OBSOLETE), tracée. */
async function retirerSansObjet(client: DbClient, action: Action, accountId: number, userId: number | null): Promise<ResolveResult> {
  const now = new Date();
  await client.update(toProcessActions).set({
    resolvedAt: now, resolutionReason: 'OBSOLETE' satisfies ResolutionReason, updatedAt: now,
  }).where(eq(toProcessActions.id, action.id));
  await client.insert(toProcessActionEvents).values({
    actionId: action.id, accountId, event: 'OBSOLETE', actorUserId: userId,
    targetType: action.targetType, targetId: action.targetId, fieldKey: action.fieldKey,
    previousValue: null as never, newValue: null as never,
    details: { ruleCode: action.ruleCode, reason: 'FIELD_NOT_APPLICABLE' }, createdAt: now,
  });
  return { ok: false, previousValue: null, error: 'FIELD_NOT_APPLICABLE' };
}

async function ecrire(action: Action, accountId: number, value: unknown, userId: number | null, expected?: unknown) {
  const { writeCanonicalAssetField } = await import('@/services/canonical/asset-state');
  return writeCanonicalAssetField({
    assetId: action.targetId, accountId, key: action.fieldKey!, value, origin: 'USER', actorUserId: userId,
    ...(expected !== undefined ? { expectedCurrent: expected } : {}),
    source: { type: 'to_process', id: action.publicId },
  });
}

/** Résolution (appelée par `resolveArbitration`, dans SA transaction). */
export async function resolveAssetFieldCard(
  tx: DbClient, action: Action, value: unknown, accountId: number, options: ResolveOptions,
): Promise<ResolveResult> {
  const userId = options.userId ?? null;
  const bien = await lireBien(tx, action.targetId, accountId);
  if (!bien) return { ok: false, previousValue: null, error: 'NOT_FOUND' };
  if (!isFieldApplicableToAsset(action.fieldKey!, bien)) return retirerSansObjet(tx, action, accountId, userId);

  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  }
  if (action.actionKind === 'ARBITRATE') {
    const proposees = (action.proposalsJson as ActionProposal[] | null) ?? [];
    if (!proposees.some((p) => memeValeur(p.value, value))) return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  }

  const res = await ecrire(action, accountId, value, userId);
  const f = res.field;
  if (res.notFound) return { ok: false, previousValue: null, error: 'NOT_FOUND' };
  if (!f || f.outcome === 'invalid' || f.outcome === 'protected' || f.outcome === 'conflict') {
    if (f?.reason === 'FIELD_NOT_APPLICABLE') return retirerSansObjet(tx, action, accountId, userId);
    return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  }

  await options.onAfterFieldWrite?.();
  const now = new Date();
  await tx.update(toProcessActions).set({
    resolvedAt: now, resolutionReason: 'USER_ARBITRATED' satisfies ResolutionReason, updatedAt: now,
  }).where(eq(toProcessActions.id, action.id));
  await tx.insert(toProcessActionEvents).values({
    actionId: action.id, accountId, event: 'RESOLVED_ARBITRATION', actorUserId: userId,
    targetType: action.targetType, targetId: action.targetId, fieldKey: action.fieldKey,
    previousValue: (f.previousValue ?? null) as never, newValue: (f.nextValue ?? value ?? null) as never,
    details: { ruleCode: action.ruleCode, cycleNumber: action.cycleNumber, key: f.key },
    createdAt: now,
  });
  // Arbitrage T3 ouvert sur ce champ (registre des incohérences) : tranché.
  try {
    const { resolveObsoleteConflict } = await import('@/services/ai/reconciliation/conflict-writer');
    await resolveObsoleteConflict(accountId, action.targetId, f.key, 'tranché par l’utilisateur depuis « À traiter »');
  } catch (e) {
    console.warn('[to-process] registre des incohérences non mis à jour :', (e as Error).message);
  }
  return { ok: true, previousValue: f.previousValue ?? null };
}

/** Annulation : valeur précédente (trace serveur) réécrite sous contrôle optimiste ; même carte rouverte. */
export async function undoAssetFieldCard(action: Action, accountId: number): Promise<ResolveResult> {
  const [ev] = await db.select({ prev: toProcessActionEvents.previousValue, next: toProcessActionEvents.newValue })
    .from(toProcessActionEvents)
    .where(and(eq(toProcessActionEvents.actionId, action.id), eq(toProcessActionEvents.accountId, accountId),
      eq(toProcessActionEvents.event, 'RESOLVED_ARBITRATION')))
    .orderBy(desc(toProcessActionEvents.id)).limit(1);
  if (!ev || action.resolutionReason !== 'USER_ARBITRATED') return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const res = await ecrire(action, accountId, ev.prev ?? null, null, ev.next ?? null);
  if (res.field?.outcome === 'conflict') return perimer(db, action, accountId, null);
  if (res.notFound || !res.field || res.field.outcome === 'invalid') return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  await db.update(toProcessActions).set({ resolvedAt: null, resolutionReason: null, lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(toProcessActions.id, action.id));
  return { ok: true, previousValue: ev.prev ?? null };
}
