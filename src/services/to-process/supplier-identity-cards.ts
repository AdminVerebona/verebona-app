/**
 * Carte « À traiter » « S’agit-il du même fournisseur ? » — règle
 * SUPPLIER-IDENTITY (lot 113G, ticket #706).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AVANT : une revue de doublon (`supplier_review_items`, `deduplication`)
 * n'avait ni valeur détectée ni valeur actuelle : le contrôle d'admissibilité
 * la rejetait (aucune proposition) et AUCUNE carte n'apparaissait, tandis que
 * le tiroir document affichait « Rattachement à confirmer » sans bouton. Une
 * carte SUPPLIER-IDENTITY, quand elle existait, n'avait pas d'écrivain
 * (FIELD_NOT_RESOLVABLE).
 *
 * MAINTENANT : une carte = UNE PAIRE explicite de fiches.
 *   · cible : la fiche détectée (A, `supplier_review_items.supplier_id`),
 *     clé `identity` — une seule carte vivante par fiche ; plusieurs
 *     candidats : traités paire par paire (le suivant après la décision) ;
 *   · contexte : `detectedSupplierId` (A), `knownSupplierId` (B), revue,
 *     base du soupçon, documents sources (liens « Voir les justificatifs ») ;
 *     la vue (noms, SIREN, ville, nombre de documents) est relue à
 *     l'affichage — jamais d'information inventée ;
 *   · « Oui » (SAME) : fusion par la procédure unique `mergeSuppliersInTx`
 *     (A → B, B garde son identifiant), dans la transaction de résolution ;
 *   · « Non » (DISTINCT) : décision durable de la paire
 *     (`supplier_identity_decisions`), revue(s) retirées de cette paire, les
 *     deux fiches et leurs rattachements intacts ;
 *   · question binaire (Oui / Non seulement, jamais « Autre ») ; aucune
 *     annulation proposée (une fusion ne se défait pas d'un toast).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { supplierReviewItems, suppliers, toProcessActionEvents, toProcessActions } from '@/db/schema';
import type { ResolutionReason } from './action-model';
import type { DbClient, ResolveOptions, ResolveResult } from './resolve-action.service';
import { reviewCandidateIds, recordPairDecision } from '@/services/suppliers/supplier-identity-reviews';
import type { PairBasis } from '@/services/suppliers/supplier-identity';

export const SUPPLIER_IDENTITY_RULE = 'SUPPLIER-IDENTITY';
/** Texte du ticket #706, repris à l'identique. */
export const SUPPLIER_IDENTITY_QUESTION = 'S’agit-il du même fournisseur ?';
export const SUPPLIER_PAIR_SAME = 'SAME';
export const SUPPLIER_PAIR_DISTINCT = 'DISTINCT';

/** Contexte persistant d'une carte de paire. */
export interface SupplierPairContext {
  kind: 'supplier_pair';
  reviewId: number;
  detectedSupplierId: number;
  knownSupplierId: number;
  basis: PairBasis;
  /** Documents sources des deux fiches (au plus 6), offerts en liens par la carte. */
  fileIds: number[];
}

export function isSupplierPairContext(ctx: unknown): ctx is SupplierPairContext {
  const c = ctx as Partial<SupplierPairContext> | null;
  return !!c && c.kind === 'supplier_pair' && Number.isInteger(c.detectedSupplierId) && Number.isInteger(c.knownSupplierId) && Number.isInteger(c.reviewId);
}

/** Propositions de la carte (pures) : deux boutons reliés à la question. */
export function supplierPairProposals() {
  return [
    { value: SUPPLIER_PAIR_SAME, label: 'Oui', confidence: 0.5 },
    { value: SUPPLIER_PAIR_DISTINCT, label: 'Non', confidence: 0.5 },
  ];
}

/** Fiche telle que la carte l'expose (informations DISCRIMINANTES présentes seulement). */
export interface SupplierPairSide {
  id: number;
  name: string;
  siren: string | null;
  city: string | null;
  documents: number;
}

export interface SupplierPairView {
  detected: SupplierPairSide;
  known: SupplierPairSide;
}

/**
 * Vue des cartes de paire, relue à l'affichage (compte de la session, fiches
 * ACTIVES seulement) : une paire dont une fiche n'existe plus n'a pas de vue
 * (la carte est fermée par le producteur).
 */
export async function loadSupplierPairViews(accountId: number, cards: Array<{ publicId: string; triggerContext: unknown }>): Promise<Map<string, SupplierPairView>> {
  const out = new Map<string, SupplierPairView>();
  const paires = cards.filter((c) => isSupplierPairContext(c.triggerContext));
  if (!paires.length) return out;
  const ids = [...new Set(paires.flatMap((c) => { const x = c.triggerContext as SupplierPairContext; return [x.detectedSupplierId, x.knownSupplierId]; }))];
  const rows = await pgClient.unsafe(
    `SELECT s.id, s.name, s.siren, s.siret, s.city,
            (SELECT count(*)::int FROM document_suppliers ds JOIN asset_files f ON f.id = ds.document_id AND f.account_id = $1 AND f.deleted_at IS NULL
              WHERE ds.supplier_id = s.id) AS documents
       FROM suppliers s WHERE s.account_id = $1 AND s.status = 'active' AND s.id = ANY($2::int[])`,
    [accountId, ids] as never[],
  ) as unknown as Array<{ id: number; name: string; siren: string | null; siret: string | null; city: string | null; documents: number }>;
  const parId = new Map(rows.map((r) => [Number(r.id), r]));
  const side = (id: number): SupplierPairSide | null => {
    const r = parId.get(id);
    if (!r) return null;
    const siret = (r.siret ?? '').replace(/\D/g, '');
    return {
      id, name: String(r.name), city: r.city?.trim() || null, documents: Number(r.documents) || 0,
      siren: (r.siren ?? '').replace(/\D/g, '') || (siret.length === 14 ? siret.slice(0, 9) : null),
    };
  };
  for (const c of paires) {
    const x = c.triggerContext as SupplierPairContext;
    const detected = side(x.detectedSupplierId); const known = side(x.knownSupplierId);
    if (detected && known) out.set(c.publicId, { detected, known });
  }
  return out;
}

/** Documents sources d'une paire (du compte, non supprimés), les plus récents d'abord. */
export async function pairSourceFiles(accountId: number, a: number, b: number, limit = 3): Promise<number[]> {
  const rows = await pgClient.unsafe(
    `SELECT x.document_id FROM (
       SELECT ds.document_id, ds.supplier_id, row_number() OVER (PARTITION BY ds.supplier_id ORDER BY f.created_at DESC, f.id DESC) AS rang
         FROM document_suppliers ds JOIN asset_files f ON f.id = ds.document_id AND f.account_id = $1 AND f.deleted_at IS NULL
        WHERE ds.supplier_id IN ($2, $3)) x
      WHERE x.rang <= $4 ORDER BY x.supplier_id, x.rang`,
    [accountId, a, b, limit] as never[],
  ) as unknown as Array<{ document_id: number }>;
  return [...new Set(rows.map((r) => Number(r.document_id)))];
}

type Action = typeof toProcessActions.$inferSelect;
type Tx = DbClient & { transaction: typeof db.transaction; execute: typeof db.execute };

/** Retire une paire des revues de doublon OUVERTES (dans les deux sens) ; une revue sans candidat est close. */
async function dropPairFromOpenReviews(tx: DbClient, accountId: number, x: number, y: number, resolution: string, userId: number | null): Promise<void> {
  const now = new Date();
  const revues = await tx.select().from(supplierReviewItems).where(and(
    eq(supplierReviewItems.accountId, accountId), eq(supplierReviewItems.itemType, 'deduplication'), eq(supplierReviewItems.status, 'open'),
    sql`${supplierReviewItems.supplierId} IN (${x}, ${y})`));
  for (const r of revues) {
    const autre = r.supplierId === x ? y : x;
    const avant = reviewCandidateIds(r.candidateSupplierIds);
    if (!avant.includes(autre)) continue;
    const restants = avant.filter((c) => c !== autre);
    await tx.update(supplierReviewItems).set(restants.length
      ? { candidateSupplierIds: restants, updatedAt: now }
      : { status: 'resolved', resolution, resolvedByUserId: userId, resolvedAt: now, updatedAt: now })
      .where(eq(supplierReviewItems.id, r.id));
  }
}

/**
 * Résolution (appelée par `resolveArbitration`, dans SA transaction, action
 * verrouillée) : « SAME » fusionne, « DISTINCT » mémorise la séparation.
 */
export async function resolveSupplierIdentityCard(
  tx: Tx, action: Action, value: unknown, accountId: number, options: ResolveOptions,
): Promise<ResolveResult & { afterCommit?: () => Promise<void> }> {
  const ctx = action.triggerContext;
  if (!isSupplierPairContext(ctx)) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  if (value !== SUPPLIER_PAIR_SAME && value !== SUPPLIER_PAIR_DISTINCT) return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  const now = new Date();
  const userId = options.userId ?? null;

  const fiches = await tx.select({
    id: suppliers.id, name: suppliers.name, normalizedName: suppliers.normalizedName, siren: suppliers.siren, siret: suppliers.siret,
    vatNumber: suppliers.vatNumber, status: suppliers.status,
  }).from(suppliers).where(and(eq(suppliers.accountId, accountId), sql`${suppliers.id} IN (${ctx.detectedSupplierId}, ${ctx.knownSupplierId})`));
  const a = fiches.find((f) => f.id === ctx.detectedSupplierId);
  const b = fiches.find((f) => f.id === ctx.knownSupplierId);
  const fermer = async (reason: ResolutionReason, event: string, details: Record<string, unknown>) => {
    await tx.update(toProcessActions).set({ resolvedAt: now, resolutionReason: reason, updatedAt: now }).where(eq(toProcessActions.id, action.id));
    await tx.insert(toProcessActionEvents).values({
      actionId: action.id, accountId, event, actorUserId: userId, targetType: action.targetType, targetId: action.targetId,
      fieldKey: 'identity', newValue: value as never, details: { ruleCode: SUPPLIER_IDENTITY_RULE, cycleNumber: action.cycleNumber, ...details }, createdAt: now,
    });
  };
  // Paire devenue sans objet (fiche fusionnée, archivée, supprimée entre-temps) : carte retirée, rien d'écrit.
  if (!a || !b || a.status !== 'active' || b.status !== 'active') {
    await fermer('OBSOLETE', 'OBSOLETE', { reason: 'SUPPLIER_PAIR_GONE' });
    return { ok: false, previousValue: null, error: 'STALE' };
  }

  let afterCommit: (() => Promise<void>) | undefined;
  if (value === SUPPLIER_PAIR_SAME) {
    const { mergeSuppliersInTx, afterSupplierMerge } = await import('@/services/suppliers/supplier-merge');
    const r = await mergeSuppliersInTx(tx as never, { accountId, fromId: a.id, toId: b.id, actorUserId: userId, reviewId: ctx.reviewId, actionId: action.id });
    afterCommit = async () => {
      await afterSupplierMerge(accountId, r);
      await nextPairCard(accountId, b.id);
    };
  } else {
    await recordPairDecision(tx, { accountId, a, b, decision: 'DISTINCT', reviewId: ctx.reviewId, userId, evidence: { actionId: action.id } });
    await dropPairFromOpenReviews(tx, accountId, a.id, b.id, 'created_new', userId);
    afterCommit = () => nextPairCard(accountId, a.id);
  }
  await options.onAfterFieldWrite?.();
  await fermer('USER_ARBITRATED', 'RESOLVED_ARBITRATION', { decision: value, detectedSupplierId: a.id, knownSupplierId: b.id, reviewId: ctx.reviewId });
  return { ok: true, previousValue: null, undoable: false, afterCommit };
}

/** Paire suivante d'une fiche (autres candidats), immédiatement — sans attendre le balayage. */
async function nextPairCard(accountId: number, supplierId: number): Promise<void> {
  try {
    const { produceSupplierActions } = await import('./producers.service');
    await produceSupplierActions(accountId, { only: [supplierId], trigger: 'USER' });
  } catch (e) {
    console.error('[to-process] paire fournisseur suivante non préparée (le balayage la reprendra) :', (e as Error).message);
  }
}

/** Cartes de paire actives d'un compte (lecture : cohérence, fiche fournisseur). */
export async function activeSupplierPairCards(accountId: number): Promise<Array<{ id: number; targetId: number; ctx: SupplierPairContext }>> {
  const rows = await db.select({ id: toProcessActions.id, targetId: toProcessActions.targetId, ctx: toProcessActions.triggerContext })
    .from(toProcessActions)
    .where(and(eq(toProcessActions.accountId, accountId), eq(toProcessActions.ruleCode, SUPPLIER_IDENTITY_RULE), isNull(toProcessActions.resolvedAt)));
  return rows.filter((r) => isSupplierPairContext(r.ctx)).map((r) => ({ id: r.id, targetId: r.targetId, ctx: r.ctx as SupplierPairContext }));
}
