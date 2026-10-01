/**
 * Cartes « À traiter » des rattrapages CDC 15 (§14, règle migration MIG-09 ;
 * lot 17, volet B) — règle MIG-REVIEW.
 *
 * « Aucune migration automatique ne doit écraser une valeur USER/ADMIN ni
 * trancher un conflit non résolu. Les cas ambigus vont dans un rapport de
 * migration ou À traiter. » Un cas ambigu EXPLOITABLE par l'utilisateur
 * (valeur de bien à choisir parmi des candidates) ouvre UNE carte :
 *
 *   · cible : le BIEN ; relation `mig:<étape>:<clé canonique>` — une carte
 *     par ÉTAPE et par champ (MIG-02 et MIG-07 sur le même champ ne se
 *     réécrivent pas), IDEMPOTENTE : une relance met à jour la même carte
 *     (jamais de doublon) et ne rouvre rien si l'utilisateur a déjà tranché
 *     le MÊME cas (même empreinte : étape, clé, motif, valeurs). La contrainte
 *     « exactement une clé » de `to_process_actions` interdit d'y poser AUSSI
 *     `field_key` : la saisie de la valeur dans la fiche ferme ces cartes par
 *     `resolveActionsForData`, qui reconnaît la relation `mig:*:<clé>`
 *     (USER_COMPLETED) ;
 *   · propositions : la valeur en place (« Garder … », valeur actuelle) et
 *     les valeurs candidates (alias, montant corrigé, colonne historique) ;
 *   · résolution : la valeur choisie — et seulement une valeur proposée —
 *     est écrite par `writeCanonicalAssetField`, origine USER (alias alignés,
 *     colonnes miroirs, journal 0216), SOUS CONTRÔLE OPTIMISTE : la valeur
 *     en place doit être celle de l'ouverture de la carte (`triggerContext
 *     .current`) ; sinon la carte est marquée PÉRIMÉE (OBSOLETE) et rien
 *     n'est écrit. Garder la valeur en place la confirme (elle devient USER :
 *     le cas ne revient plus). Annulation : la valeur précédente est
 *     réécrite si la valeur en place est toujours celle de la résolution
 *     (même contrôle), la même carte rouverte ; sinon carte périmée.
 */
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { createHash } from 'crypto';
import { db } from '@/db';
import { toProcessActionEvents, toProcessActions } from '@/db/schema';
import { getField } from '@/services/canonical/registry';
import type { ActionProposal, ResolutionReason } from './action-model';
import type { DbClient, ResolveOptions, ResolveResult } from './resolve-action.service';
import { upsertAction } from './to-process-action.service';

export const MIG_REVIEW_RULE = 'MIG-REVIEW';

export interface MigrationReviewInput {
  step: string;
  accountId: number;
  assetId: number;
  key: string;
  reason: string;
  current: unknown;
  candidates: Array<{ value: unknown; label?: string; source?: string }>;
}

type Scalar = string | number | boolean | null;
const scalar = (v: unknown): Scalar | undefined =>
  (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined);

/** Libellé court d'une valeur (pur, testé). */
export function valueLabel(key: string, v: unknown): string {
  const def = getField(key);
  if (v === null || v === undefined || v === '') return 'aucune valeur';
  if ((def?.valueType === 'money_eur') && typeof v === 'number') {
    return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(v)} €`;
  }
  if (def?.valueType === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const [y, m, d] = v.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }
  return String(v);
}

const QUESTIONS: Record<string, string> = {
  ALIAS_CONFLICT: 'Deux valeurs différentes sont enregistrées pour « {label} ». Laquelle garder ?',
  ALIASES_DISAGREE: 'Deux valeurs différentes sont enregistrées pour « {label} ». Laquelle garder ?',
  COLUMN_DIFFERS_FROM_AUTOMATIC: 'La fiche et une ancienne donnée diffèrent pour « {label} ». Laquelle garder ?',
};

/** Propositions et question d'une carte (pur, testé). */
export function buildMigrationProposals(i: MigrationReviewInput): { question: string; proposals: ActionProposal[] } {
  const label = getField(i.key)?.label ?? i.key;
  const proposals: ActionProposal[] = [];
  const cur = scalar(i.current);
  if (cur !== undefined && cur !== null) {
    proposals.push({ value: cur, label: `Garder ${valueLabel(i.key, cur)}`, confidence: 0, isCurrentValue: true });
  }
  for (const c of i.candidates) {
    const v = scalar(c.value);
    if (v === undefined || v === null || proposals.some((p) => p.value === v)) continue;
    proposals.push({ value: v, label: c.label ?? valueLabel(i.key, v), confidence: 0.5 });
  }
  const question = (QUESTIONS[i.reason] ?? (i.step === 'MIG-02'
    ? 'Le montant « {label} » semble multiplié par 100. Quelle valeur est la bonne ?'
    : 'Quelle valeur garder pour « {label} » ?')).replace('{label}', label);
  return { question, proposals };
}

/** Relation d'une carte : une par étape et par champ (pure, testée). */
export const migrationRelation = (step: string, key: string) => `mig:${step}:${key}`;
/** Clé canonique d'une relation de carte MIG-REVIEW (`mig:MIG-02:acquisitionPrice` → `acquisitionPrice`). */
export const migrationRelationKey = (relation: string | null): string | null => /^mig:MIG-\d{2}:(.+)$/.exec(relation ?? '')?.[1] ?? null;

const empreinte = (i: MigrationReviewInput) => createHash('sha256')
  .update(JSON.stringify([i.step, i.key, i.reason, i.current ?? null, i.candidates.map((c) => c.value ?? null)])).digest('hex').slice(0, 40);

/**
 * Ouvre ou met à jour la carte d'un cas ambigu. `SKIPPED` : rien
 * d'affichable, même cas déjà tranché par l'utilisateur, ou carte d'une
 * autre règle déjà ouverte sur ce champ (elle n'est pas détournée).
 */
export async function upsertMigrationReviewCard(i: MigrationReviewInput): Promise<'CREATED' | 'UPDATED' | 'SKIPPED'> {
  const fp = empreinte(i);
  const surChamp = and(
    eq(toProcessActions.accountId, i.accountId), eq(toProcessActions.targetType, 'ASSET'),
    eq(toProcessActions.targetId, i.assetId), eq(toProcessActions.relationKey, migrationRelation(i.step, i.key)),
  );
  const [derniere] = await db.select({ ctx: toProcessActions.triggerContext })
    .from(toProcessActions)
    .where(and(surChamp, eq(toProcessActions.ruleCode, MIG_REVIEW_RULE), isNotNull(toProcessActions.resolvedAt)))
    .orderBy(desc(toProcessActions.resolvedAt)).limit(1);
  if ((derniere?.ctx as { fingerprint?: string } | null)?.fingerprint === fp) return 'SKIPPED';
  const { question, proposals } = buildMigrationProposals(i);
  const r = await upsertAction({
    accountId: i.accountId,
    targetType: 'ASSET',
    targetId: i.assetId,
    relationKey: migrationRelation(i.step, i.key),
    actionKind: 'ARBITRATE',
    ruleCode: MIG_REVIEW_RULE,
    question: question.slice(0, 300),
    proposals,
    triggerContext: { kind: 'cdc15_migration', step: i.step, key: i.key, reason: i.reason, current: scalar(i.current) ?? null, fingerprint: fp },
  });
  return r.status === 'CREATED' ? 'CREATED' : r.status === 'UPDATED' ? 'UPDATED' : 'SKIPPED';
}

type Action = typeof toProcessActions.$inferSelect;
type MigContext = { key?: string; current?: Scalar };

async function ecrire(action: Action, accountId: number, key: string, value: unknown, expected: unknown, userId: number | null) {
  const { writeCanonicalAssetField } = await import('@/services/canonical/asset-state');
  return writeCanonicalAssetField({
    assetId: action.targetId, accountId, key, value, origin: 'USER', actorUserId: userId, expectedCurrent: expected ?? null,
    source: { type: 'to_process', id: action.publicId }, mode: 'enabled',
  });
}

/** Carte périmée : la valeur en place a changé depuis son ouverture (ou sa résolution). Partagée (cartes d'entité, lot 18). */
export async function perimer(client: DbClient, action: Action, accountId: number, userId: number | null): Promise<ResolveResult> {
  const now = new Date();
  await client.update(toProcessActions).set({
    resolvedAt: action.resolvedAt ?? now, resolutionReason: 'OBSOLETE' satisfies ResolutionReason, updatedAt: now,
  }).where(eq(toProcessActions.id, action.id));
  await client.insert(toProcessActionEvents).values({
    actionId: action.id, accountId, event: 'OBSOLETE', actorUserId: userId,
    targetType: action.targetType, targetId: action.targetId, fieldKey: action.fieldKey ?? action.relationKey,
    previousValue: null as never, newValue: null as never,
    details: { ruleCode: action.ruleCode, reason: 'CURRENT_VALUE_CHANGED' }, createdAt: now,
  });
  return { ok: false, previousValue: null, error: 'STALE' };
}

/**
 * Résolution (appelée par `resolveArbitration`, dans SA transaction). La
 * valeur est écrite par la primitive canonique (sa propre transaction, comme
 * la résolution des conflits de champ), sous contrôle optimiste, PUIS la
 * carte est close dans `tx`.
 */
export async function resolveMigrationReview(
  tx: DbClient,
  action: Action,
  value: unknown,
  accountId: number,
  options: ResolveOptions,
): Promise<ResolveResult> {
  const ctx = action.triggerContext as MigContext | null;
  const key = ctx?.key;
  const proposees = (action.proposalsJson as ActionProposal[] | null) ?? [];
  if (!key || !proposees.some((p) => p.value === value)) return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  const res = await ecrire(action, accountId, key, value, ctx?.current ?? null, options.userId ?? null);
  const f = res.field;
  if (f?.outcome === 'conflict') return perimer(tx, action, accountId, options.userId ?? null);
  if (res.notFound || !f || f.outcome === 'invalid') {
    return { ok: false, previousValue: null, error: res.notFound ? 'NOT_FOUND' : 'INVALID_VALUE' };
  }
  const now = new Date();
  await tx.update(toProcessActions).set({
    resolvedAt: now, resolutionReason: 'USER_ARBITRATED' satisfies ResolutionReason, updatedAt: now,
  }).where(eq(toProcessActions.id, action.id));
  await tx.insert(toProcessActionEvents).values({
    actionId: action.id, accountId, event: 'RESOLVED_ARBITRATION', actorUserId: options.userId ?? null,
    targetType: action.targetType, targetId: action.targetId, fieldKey: action.relationKey,
    previousValue: (f.previousValue ?? null) as never, newValue: (f.nextValue ?? value ?? null) as never,
    details: { ruleCode: action.ruleCode, cycleNumber: action.cycleNumber, key },
    createdAt: now,
  });
  return { ok: true, previousValue: f.previousValue ?? null };
}

/**
 * Annulation : la valeur d'avant la résolution est réécrite (origine USER)
 * si la valeur en place est TOUJOURS celle écrite par la résolution
 * (contrôle optimiste) ; la même carte est rouverte. Sinon : carte périmée,
 * rien n'est écrit. Les valeurs viennent de la trace serveur de la
 * résolution, jamais du client.
 */
export async function undoMigrationReview(action: Action, accountId: number): Promise<ResolveResult> {
  const key = (action.triggerContext as MigContext | null)?.key;
  if (!key) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const [ev] = await db.select({ prev: toProcessActionEvents.previousValue, next: toProcessActionEvents.newValue })
    .from(toProcessActionEvents)
    .where(and(eq(toProcessActionEvents.actionId, action.id), eq(toProcessActionEvents.accountId, accountId),
      eq(toProcessActionEvents.event, 'RESOLVED_ARBITRATION')))
    .orderBy(desc(toProcessActionEvents.id)).limit(1);
  if (!ev || action.resolutionReason !== 'USER_ARBITRATED') return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const res = await ecrire(action, accountId, key, ev.prev ?? null, ev.next ?? null, null);
  if (res.field?.outcome === 'conflict') return perimer(db, action, accountId, null);
  if (res.notFound || !res.field || res.field.outcome === 'invalid') return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  await db.update(toProcessActions).set({ resolvedAt: null, resolutionReason: null, lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(toProcessActions.id, action.id));
  return { ok: true, previousValue: ev.prev ?? null };
}
