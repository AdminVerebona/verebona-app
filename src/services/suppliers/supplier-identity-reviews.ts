/**
 * Lot 113G (ticket #706) — soupçons de doublon (`supplier_review_items`,
 * item_type `deduplication`) et décisions de l'utilisateur sur une PAIRE de
 * fiches (`supplier_identity_decisions`).
 *
 * Seul point d'ouverture d'une revue de doublon (documents T1, saisie Agenda,
 * contrôle de cohérence) :
 *   · candidats re-jugés par la règle commune (`assessSupplierPair`) : seule
 *     une paire PLAUSIBLE ouvre une revue (une paire certaine est réutilisée
 *     en amont ; une paire contradictoire n'est jamais proposée) ;
 *   · paire déjà tranchée « identités distinctes » : jamais reproposée, sauf
 *     preuve objective nouvelle (`distinctDecisionReopenReason`, motif tracé) ;
 *     paire fusionnée : sans objet ;
 *   · paire déjà couverte par une revue OUVERTE (dans un sens ou dans l'autre) :
 *     aucune seconde revue — plusieurs documents, une seule carte (AC06).
 */
import { and, eq, or, sql } from 'drizzle-orm';
import { supplierIdentityDecisions, supplierReviewItems, suppliers } from '@/db/schema';
import type { SupplierQueryRunner } from './supplier-service';
import {
  assessSupplierPair, distinctDecisionReopenReason, pairEvidenceFingerprint, pairKey,
  type PairAssessment, type StoredPairDecision, type SupplierIdentityFacts,
} from './supplier-identity';

/** Nombre de candidats conservés par revue (une carte = une paire à la fois). */
export const IDENTITY_REVIEW_MAX_CANDIDATES = 3;

export interface PairDecisionRow extends StoredPairDecision { low: number; high: number; reopenedAt: Date | null }

/** Décisions de paire du compte qui concernent ces fiches (clé `low:high`). */
export async function loadPairDecisions(q: SupplierQueryRunner, accountId: number, supplierIds: readonly number[]): Promise<Map<string, PairDecisionRow>> {
  const ids = [...new Set(supplierIds.filter((x) => Number.isInteger(x) && x > 0))];
  const out = new Map<string, PairDecisionRow>();
  if (!ids.length) return out;
  const rows = await q.select({
    low: supplierIdentityDecisions.supplierLowId, high: supplierIdentityDecisions.supplierHighId,
    decision: supplierIdentityDecisions.decision, basis: supplierIdentityDecisions.basis,
    evidenceFingerprint: supplierIdentityDecisions.evidenceFingerprint, reopenedAt: supplierIdentityDecisions.reopenedAt,
  }).from(supplierIdentityDecisions).where(and(
    eq(supplierIdentityDecisions.accountId, accountId),
    sql`(${supplierIdentityDecisions.supplierLowId} = ANY(${`{${ids.join(',')}}`}::int[]) OR ${supplierIdentityDecisions.supplierHighId} = ANY(${`{${ids.join(',')}}`}::int[]))`,
  ));
  for (const r of rows) out.set(`${r.low}:${r.high}`, { ...r, decision: r.decision as 'SAME' | 'DISTINCT' });
  return out;
}

export type PairEligibility =
  | { eligible: true; assessment: PairAssessment; reopenReason: string | null }
  | { eligible: false; reason: 'SAME_SUPPLIER' | 'NOT_PLAUSIBLE' | 'DECIDED_DISTINCT' | 'DECIDED_SAME'; assessment: PairAssessment | null };

/**
 * Une paire de fiches EXISTANTES mérite-t-elle un arbitrage (pur) ? Seulement
 * si elle est plausible ou certaine (deux fiches du même fournisseur déjà
 * créées : jamais fusionnées sans l'utilisateur) et non tranchée — ou certaine
 * par identifiant après une décision « distinctes » contredite par une preuve
 * objective nouvelle.
 */
export function pairEligibility(a: SupplierIdentityFacts, b: SupplierIdentityFacts, decision: StoredPairDecision | null | undefined): PairEligibility {
  if (a.id === b.id) return { eligible: false, reason: 'SAME_SUPPLIER', assessment: null };
  const assessment = assessSupplierPair(a, b);
  if (decision?.decision === 'SAME') return { eligible: false, reason: 'DECIDED_SAME', assessment };
  if (decision?.decision === 'DISTINCT') {
    const reopen = distinctDecisionReopenReason(decision, assessment, pairEvidenceFingerprint(a, b));
    return reopen ? { eligible: true, assessment, reopenReason: reopen } : { eligible: false, reason: 'DECIDED_DISTINCT', assessment };
  }
  // PLAUSIBLE : doute réel. CERTAIN entre deux fiches EXISTANTES (stock historique, création manuelle) :
  // proposé aussi — jamais fusionné sans l'utilisateur.
  return assessment.verdict === 'PLAUSIBLE' || assessment.verdict === 'CERTAIN'
    ? { eligible: true, assessment, reopenReason: null }
    : { eligible: false, reason: 'NOT_PLAUSIBLE', assessment };
}

type FactsRow = SupplierIdentityFacts & { status: string; accountId: number };

async function facts(q: SupplierQueryRunner, accountId: number, ids: readonly number[]): Promise<Map<number, FactsRow>> {
  if (!ids.length) return new Map();
  const rows = await q.select({
    id: suppliers.id, name: suppliers.name, normalizedName: suppliers.normalizedName, siren: suppliers.siren, siret: suppliers.siret,
    vatNumber: suppliers.vatNumber, status: suppliers.status, accountId: suppliers.accountId,
  }).from(suppliers).where(and(eq(suppliers.accountId, accountId), sql`${suppliers.id} = ANY(${`{${[...new Set(ids)].join(',')}}`}::int[])`));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Paires (non ordonnées) déjà couvertes par une revue de doublon OUVERTE du compte, impliquant ces fiches. */
async function openPairs(q: SupplierQueryRunner, accountId: number, supplierId: number, excludeReviewId: number | null = null): Promise<Set<string>> {
  const rows = await q.select({ id: supplierReviewItems.id, supplierId: supplierReviewItems.supplierId, candidates: supplierReviewItems.candidateSupplierIds })
    .from(supplierReviewItems)
    .where(and(
      eq(supplierReviewItems.accountId, accountId), eq(supplierReviewItems.itemType, 'deduplication'), eq(supplierReviewItems.status, 'open'),
      or(eq(supplierReviewItems.supplierId, supplierId), sql`${supplierReviewItems.candidateSupplierIds} @> ${JSON.stringify([supplierId])}::jsonb`),
    ));
  const out = new Set<string>();
  for (const r of rows) {
    if (r.id === excludeReviewId || r.supplierId == null) continue;
    for (const c of reviewCandidateIds(r.candidates)) out.add(pairKey(r.supplierId, c).key);
  }
  return out;
}

/** Candidats d'une revue (jsonb), entiers positifs, ordre conservé, sans doublon. */
export function reviewCandidateIds(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(Number).filter((x) => Number.isInteger(x) && x > 0))];
}

/**
 * Ouvre la revue de doublon d'une fiche (A) face à ses candidats, en ne
 * gardant que les paires qui méritent un arbitrage. Rend l'identifiant de la
 * revue ouverte, ou null (aucune paire utile : aucune revue, aucune carte).
 */
export async function openIdentityReview(q: SupplierQueryRunner, p: {
  accountId: number; supplierId: number; documentId: number | null; detectedName: string; candidateIds: readonly number[];
}): Promise<{ reviewId: number | null; candidateIds: number[] }> {
  const ids = [...new Set(p.candidateIds.filter((x) => x !== p.supplierId))];
  if (!ids.length) return { reviewId: null, candidateIds: [] };
  const f = await facts(q, p.accountId, [p.supplierId, ...ids]);
  const a = f.get(p.supplierId);
  if (!a) return { reviewId: null, candidateIds: [] };
  const decisions = await loadPairDecisions(q, p.accountId, [p.supplierId]);
  const couvertes = await openPairs(q, p.accountId, p.supplierId);
  const retenus: number[] = [];
  for (const id of ids) {
    const b = f.get(id);
    if (!b || b.status !== 'active') continue;
    const k = pairKey(p.supplierId, id).key;
    if (couvertes.has(k)) continue;
    const e = pairEligibility(a, b, decisions.get(k));
    if (!e.eligible) continue;
    if (e.reopenReason) await markDecisionReopened(q, p.accountId, p.supplierId, id, e.reopenReason);
    retenus.push(id);
    if (retenus.length >= IDENTITY_REVIEW_MAX_CANDIDATES) break;
  }
  if (!retenus.length) return { reviewId: null, candidateIds: [] };
  const [r] = await q.insert(supplierReviewItems).values({
    accountId: p.accountId, itemType: 'deduplication', status: 'open', supplierId: p.supplierId, documentId: p.documentId,
    detectedName: p.detectedName, candidateSupplierIds: retenus, createdAt: new Date(), updatedAt: new Date(),
  }).returning({ id: supplierReviewItems.id });
  return { reviewId: r.id, candidateIds: retenus };
}

/** Trace la réouverture d'une décision « distinctes » contredite par une preuve objective nouvelle. */
async function markDecisionReopened(q: SupplierQueryRunner, accountId: number, x: number, y: number, reason: string): Promise<void> {
  const { low, high } = pairKey(x, y);
  await q.update(supplierIdentityDecisions)
    .set({ reopenedAt: new Date(), reopenReason: reason, updatedAt: new Date() })
    .where(and(eq(supplierIdentityDecisions.accountId, accountId), eq(supplierIdentityDecisions.supplierLowId, low), eq(supplierIdentityDecisions.supplierHighId, high)));
}

/** Enregistre (ou remplace) la décision de l'utilisateur sur une paire, avec ses preuves du moment. */
export async function recordPairDecision(q: SupplierQueryRunner, p: {
  accountId: number; a: SupplierIdentityFacts; b: SupplierIdentityFacts; decision: 'SAME' | 'DISTINCT';
  reviewId: number | null; userId: number | null; evidence?: Record<string, unknown>;
}): Promise<void> {
  const { low, high } = pairKey(p.a.id, p.b.id);
  const assessment = assessSupplierPair(p.a, p.b);
  const fingerprint = pairEvidenceFingerprint(p.a, p.b);
  const now = new Date();
  await q.insert(supplierIdentityDecisions).values({
    accountId: p.accountId, supplierLowId: low, supplierHighId: high, decision: p.decision, basis: assessment.basis,
    evidenceFingerprint: fingerprint, evidence: { ...(p.evidence ?? {}), names: [p.a.name, p.b.name] }, reviewId: p.reviewId,
    decidedByUserId: p.userId, decidedAt: now, createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [supplierIdentityDecisions.accountId, supplierIdentityDecisions.supplierLowId, supplierIdentityDecisions.supplierHighId],
    set: {
      decision: p.decision, basis: assessment.basis, evidenceFingerprint: fingerprint, reviewId: p.reviewId, decidedByUserId: p.userId,
      decidedAt: now, reopenedAt: null, reopenReason: null, updatedAt: now,
      evidence: { ...(p.evidence ?? {}), names: [p.a.name, p.b.name] },
    },
  });
}
