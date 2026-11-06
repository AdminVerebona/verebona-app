/**
 * COH-SUPPLIER-IDENTITY — identité des fiches fournisseur : seuls les doublons
 * réels sont soumis à l'utilisateur, une fois, par paire (lot 113G, ticket
 * #706). Ajouté EN FIN de registre, après COH-SUPPLIER-COORDINATES (111X).
 *
 * Rattrapage du STOCK par le moteur existant (campagne quotidienne des comptes
 * éligibles + contrôle ciblé à l'analyse, au dépôt, à la modification d'un
 * document ou d'une fiche) — aucun système parallèle. Règle de paire commune
 * (`suppliers/supplier-identity.ts`), revues et décisions de
 * `supplier-identity-reviews.ts`, cartes du producteur SUPPLIER-IDENTITY.
 *
 * Objet : une fiche ACTIVE (la plus récente d'une paire porte la question).
 *   REPAIRABLE SUPPLIER_DUPLICATE_UNREVIEWED — une fiche active plus ancienne
 *              forme avec elle une paire plausible (ou certaine) jamais
 *              tranchée, sans revue : revue ouverte + carte (au moins une des
 *              deux fiches créée automatiquement — deux fiches saisies par
 *              l'utilisateur sont ses choix) ;
 *   REPAIRABLE SUPPLIER_REVIEW_OBSOLETE — revue de doublon ouverte sans plus
 *              aucune paire utile (fiche fusionnée ou archivée, paire tranchée,
 *              noms qui ne se ressemblent pas selon la règle actuelle) : revue
 *              close (`resolution = 'obsolete'`), carte retirée ;
 *   REPAIRABLE SUPPLIER_REVIEW_WITHOUT_CARD — revue ouverte avec une paire
 *              utile mais aucune carte vivante : carte (re)produite.
 * Interdits : fusionner, réassocier un document, écrire `is_confirmed`,
 * modifier ou rouvrir une décision de l'utilisateur (fusion, séparation,
 * revue tranchée), toucher aux conflits de coordonnées (COH-SUPPLIER-COORDINATES).
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

export const SUPPLIER_IDENTITY_CHECK_ID = 'COH-SUPPLIER-IDENTITY';

interface Fiche { id: number; name: string; normalizedName: string; siren: string | null; siret: string | null; vatNumber: string | null; source: string; status: string }

const FICHES_SQL = `SELECT id, name, normalized_name AS "normalizedName", siren, siret, vat_number AS "vatNumber", source, status
                      FROM suppliers WHERE account_id = $1 AND status = 'active' ORDER BY id`;

/** Constat d'une fiche (pur, testé) : paires à proposer, revues obsolètes ou sans carte. */
export async function supplierIdentityState(sql: Parameters<typeof rows>[0], accountId: number, ids: readonly number[]) {
  const { pairEligibility, reviewCandidateIds } = await import('@/services/suppliers/supplier-identity-reviews');
  const fiches = (await rows(sql, FICHES_SQL, [accountId])) as unknown as Fiche[];
  const parId = new Map(fiches.map((f) => [Number(f.id), { ...f, id: Number(f.id) }]));
  const decisions = new Map((await rows(sql,
    `SELECT supplier_low_id AS low, supplier_high_id AS high, decision, basis, evidence_fingerprint AS "evidenceFingerprint"
       FROM supplier_identity_decisions WHERE account_id = $1`, [accountId]))
    .map((d) => [`${Number(d.low)}:${Number(d.high)}`, { decision: d.decision as 'SAME' | 'DISTINCT', basis: (d.basis as string | null) ?? null, evidenceFingerprint: (d.evidenceFingerprint as string | null) ?? null }]));
  const revues = await rows(sql,
    `SELECT id, supplier_id, candidate_supplier_ids, status, resolution FROM supplier_review_items
      WHERE account_id = $1 AND item_type = 'deduplication' AND supplier_id IS NOT NULL`, [accountId]);
  const cartes = new Set(idsOf(await rows(sql,
    `SELECT target_id AS id FROM to_process_actions WHERE account_id = $1 AND rule_code = 'SUPPLIER-IDENTITY' AND resolved_at IS NULL
        AND trigger_context->>'kind' = 'supplier_pair'`, [accountId])));
  // Paires déjà portées par une revue (ouverte, ou tranchée par l'utilisateur : jamais reproposées).
  const couvertes = new Set<string>();
  for (const r of revues) {
    if (r.status !== 'open' && r.resolution === 'obsolete') continue;
    for (const c of reviewCandidateIds(r.candidate_supplier_ids)) couvertes.add(`${Math.min(Number(r.supplier_id), c)}:${Math.max(Number(r.supplier_id), c)}`);
  }

  const out = new Map<number, { gone: boolean; nouvelles: number[]; obsoletes: number[]; sansCarte: boolean; utiles: number }>();
  for (const id of ids) {
    const a = parId.get(id);
    if (!a) { out.set(id, { gone: true, nouvelles: [], obsoletes: [], sansCarte: false, utiles: 0 }); continue; }
    const nouvelles: number[] = [];
    for (const b of fiches) {
      const bid = Number(b.id);
      if (bid >= id) break; // la fiche la plus récente porte la question ; une paire n'est examinée qu'une fois
      if (a.source !== 'document_extraction' && b.source !== 'document_extraction') continue;
      const key = `${bid}:${id}`;
      if (couvertes.has(key)) continue;
      const e = pairEligibility(a, { ...b, id: bid }, decisions.get(key));
      if (e.eligible) nouvelles.push(bid);
      if (nouvelles.length >= 3) break;
    }
    const obsoletes: number[] = [];
    let utiles = 0;
    for (const r of revues.filter((x) => x.status === 'open' && Number(x.supplier_id) === id)) {
      const ok = reviewCandidateIds(r.candidate_supplier_ids).some((c) => {
        const b = parId.get(c);
        return !!b && c !== id && pairEligibility(a, b, decisions.get(`${Math.min(id, c)}:${Math.max(id, c)}`)).eligible;
      });
      if (ok) utiles += 1; else obsoletes.push(Number(r.id));
    }
    out.set(id, { gone: false, nouvelles, obsoletes, sansCarte: utiles > 0 && !cartes.has(id), utiles });
  }
  return out;
}

export const supplierIdentityCheck: CoherenceCheck = {
  id: SUPPLIER_IDENTITY_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Fournisseurs : doublons réels soumis une fois par paire (Oui / Non), aucun « à confirmer » formel, décisions respectées',
  domain: 'fournisseurs',
  level: 'N3',
  objectType: 'supplier',
  scope: 'fiches fournisseurs ACTIVES du compte',
  sources: ['suppliers', 'supplier_review_items', 'supplier_identity_decisions', 'to_process_actions'],
  applicability: 'compte éligible ; fiche active',
  invariant: 'toute paire de fiches actives plausiblement identiques et jamais tranchée a une revue et une carte « S’agit-il du même fournisseur ? » ; aucune revue ouverte sans paire utile ; une paire tranchée (fusion ou séparation) n’est jamais reproposée sans preuve objective nouvelle',
  anomalies: ['SUPPLIER_DUPLICATE_UNREVIEWED', 'SUPPLIER_REVIEW_OBSOLETE', 'SUPPLIER_REVIEW_WITHOUT_CARD'],
  autoRepairWhen: 'paire plausible non tranchée sans revue (au moins une fiche créée automatiquement) ; revue sans paire utile ; revue utile sans carte',
  forbiddenRepairs: ['fusionner des fiches', 'réassocier un document', 'promouvoir is_confirmed', 'modifier ou rouvrir une décision de l’utilisateur',
    'reproposer une paire tranchée sans preuve objective nouvelle', 'toucher aux conflits de coordonnées'],
  services: ['suppliers/supplier-identity-reviews#openIdentityReview', 'to-process/producers.service#produceSupplierActions'],
  chain: ['PERSISTENCE', 'TO_PROCESS'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPLOADED', 'DOCUMENT_UPDATED', 'SUPPLIER_CHANGED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque analyse, dépôt, modification de document ou de fiche',
  criticality: 'LOW',
  tests: ['L113G-U-PAIR', 'L113G-U-ELIGIBILITY', 'L113G-E2E-AC09'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT id FROM suppliers WHERE account_id = $1 AND status = 'active' AND id > $2 ORDER BY id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (e.type === 'SUPPLIER_CHANGED') {
      return idsOf(await rows(ctx.sql, `SELECT id FROM suppliers WHERE account_id = $1 AND status = 'active' AND id = $2`, [accountId, e.entityId]));
    }
    return idsOf(await rows(ctx.sql, `
      SELECT DISTINCT s.id FROM suppliers s JOIN document_suppliers ds ON ds.supplier_id = s.id
       WHERE s.account_id = $1 AND s.status = 'active' AND ds.document_id = $2`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const st = await supplierIdentityState(ctx.sql, accountId, ids);
    for (const id of ids) {
      const s = st.get(id);
      if (!s || s.gone) { out.set(id, { verdict: 'GONE' }); continue; }
      const observed = { candidates: s.nouvelles, obsoleteReviews: s.obsoletes, usefulReviews: s.utiles };
      const inputHash = hashOf({ id, ...observed, sansCarte: s.sansCarte });
      if (s.obsoletes.length) out.set(id, { verdict: 'REPAIRABLE', anomaly: 'SUPPLIER_REVIEW_OBSOLETE', faultyLink: 'PERSISTENCE', observed, inputHash });
      else if (s.nouvelles.length) out.set(id, { verdict: 'REPAIRABLE', anomaly: 'SUPPLIER_DUPLICATE_UNREVIEWED', faultyLink: 'PERSISTENCE', observed, inputHash });
      else if (s.sansCarte) out.set(id, { verdict: 'REPAIRABLE', anomaly: 'SUPPLIER_REVIEW_WITHOUT_CARD', faultyLink: 'TO_PROCESS', observed, inputHash });
      else out.set(id, { verdict: 'CONSISTENT' });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { db } = await import('@/db');
    const { openIdentityReview } = await import('@/services/suppliers/supplier-identity-reviews');
    const { produceSupplierActions } = await import('@/services/to-process/producers.service');
    const { SUPPLIER_REFERENTIAL_LOCK } = await import('@/services/suppliers/supplier-from-analysis');
    const { sql: dsql } = await import('drizzle-orm');
    const ids = intArray(items.map((i) => i.id));
    for (const id of ids) {
      let closed = 0; let opened: number | null = null;
      await db.transaction(async (tx) => {
        await tx.execute(dsql`SELECT pg_advisory_xact_lock(${SUPPLIER_REFERENTIAL_LOCK}, ${accountId})`);
        // État relu SOUS le verrou (jamais de décision sur un état périmé).
        const s = (await supplierIdentityState(ctx.sql, accountId, [id])).get(id);
        if (!s || s.gone) return;
        if (s.obsoletes.length) {
          const r = await tx.execute(dsql`
            UPDATE supplier_review_items SET status = 'resolved', resolution = 'obsolete', resolved_at = now(), updated_at = now()
             WHERE account_id = ${accountId} AND status = 'open' AND item_type = 'deduplication'
               AND id = ANY(${`{${s.obsoletes.join(',')}}`}::int[]) RETURNING id`);
          closed = (r as unknown as unknown[]).length;
        }
        if (s.nouvelles.length) {
          const [nom] = await rows(ctx.sql, `SELECT name FROM suppliers WHERE id = $1 AND account_id = $2`, [id, accountId]);
          opened = (await openIdentityReview(tx as never, { accountId, supplierId: id, documentId: null, detectedName: String(nom?.name ?? ''), candidateIds: s.nouvelles })).reviewId;
        }
      });
      const p = await produceSupplierActions(accountId, { only: [id], trigger: 'BACKFILL', runRef: ctx.correlationId ?? null });
      out.set(id, {
        called: true, service: 'openIdentityReview+produceSupplierActions',
        result: { reviewsClosed: closed, reviewOpened: opened, cardsCreated: p.created, cardsKept: p.updated, cardsClosed: p.closed },
        rollbackRef: `supplier_review_items:supplier=${id};to_process_action_events`,
        reevaluation: 'TECHNICAL_REBUILD',
      });
    }
    return out;
  },
};
