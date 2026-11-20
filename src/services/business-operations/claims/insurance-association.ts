/**
 * SINISTRE ↔ ASSURANCE — recherche de l'assurance pertinente d'un sinistre et
 * ASSOCIATION des deux opérations (lot 116C, carte Trello #806 §3 ; CDC
 * « Opérations / Agenda V2.0 » §9, §10).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX OPÉRATIONS DISTINCTES, ASSOCIÉES, JAMAIS FUSIONNÉES
 *
 * L'Assurance (contrat, cotisations, échéances, périodes, garanties) et le
 * Sinistre (déclaration, expertise, réparations, indemnités) restent deux
 * opérations. Elles sont reliées par la relation N↔N persistante du graphe
 * (`business_operation_relations`, nature ASSOCIATED) : un contrat peut couvrir
 * plusieurs sinistres, un sinistre peut concerner plusieurs contrats. Rien
 * n'est copié ni déplacé, aucun montant n'est ajouté, aucune date n'est écrite.
 * UNE ASSOCIATION NE PROUVE PAS UNE PRISE EN CHARGE par l'assureur : elle dit
 * seulement que ce contrat est celui à consulter pour ce sinistre.
 *
 * QUAND : à la création ou à la consolidation d'un sinistre par T3 (après
 * commit, `consolidator.ts › syncCards`), et quand un contrat d'assurance d'un
 * bien sinistré est consolidé (le sinistre peut être arrivé avant son contrat).
 *
 * COMMENT — aucune IA, aucune règle métier écrite ici ; uniquement des faits
 * déjà établis et des référentiels existants :
 *   · CONTRAT D'ASSURANCE : opération CONTRACT active qui porte au moins un
 *     justificatif dont le Type documentaire établit une assurance
 *     (`isInsuranceContractDocumentType`, référentiel des Types V2) ;
 *   · MÊME BIEN : le contrat et le sinistre ont un bien actif en commun ;
 *   · DATE et PÉRIODE : la date de SURVENANCE du sinistre (jamais sa date de
 *     déclaration) est confrontée aux périodes de couverture du contrat (lecture
 *     existante `readOperationsCoverage`, périodes métier 113W / 113AA). Une
 *     période qui exclut la date écarte le contrat ; une période contestée ou
 *     une date partielle ne prouve rien ;
 *   · RÉFÉRENCE : la police ou le contrat cité par les pièces du sinistre
 *     (références POLICY / CONTRACT de l'opération) désigne le contrat qui porte
 *     la même référence, et écarte celui qui en porte une autre ;
 *   · NATURE DU DOMMAGE et GARANTIES : aucune garantie n'est aujourd'hui
 *     enregistrée de façon structurée sur un contrat — ce critère n'écarte donc
 *     personne et ne fonde aucune association (limite écrite dans la fiche de
 *     recette ; rien n'est deviné).
 *
 * DÉCISION (pure, `decideClaimInsurance`) :
 *   · UNE correspondance FIABLE → association automatique (acteur T3, preuves :
 *     les justificatifs d'assurance du contrat) ;
 *       – fiable par la RÉFÉRENCE : un seul contrat porte la police citée et sa
 *         couverture n'exclut pas la date ;
 *       – fiable par le BIEN et la PÉRIODE : un seul contrat d'assurance sur le
 *         bien, dont une période établie couvre la date du sinistre ;
 *   · plusieurs contrats possibles, ou un seul dont la couverture à la date
 *     n'est pas établie → QUESTION CIBLÉE à l'utilisateur, par le mécanisme
 *     existant des cartes « À traiter » d'association entre deux opérations
 *     (`operation-relation-cards.ts`, UNE carte par paire, réponse appliquée par
 *     la façade, jamais reposée après réponse) ;
 *   · aucun contrat possible, sinistre sans bien, sinistre déjà associé à une
 *     assurance : ABSTENTION, rien n'est écrit ni demandé.
 * Un refus de l'utilisateur (paire refusée) n'est jamais contourné : la paire
 * n'est ni associée ni redemandée. ISOLATION : toutes les lectures sont bornées
 * au compte ; l'écriture passe par la façade, qui relit chaque identifiant dans
 * le compte.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { isInsuranceContractDocumentType } from '@/lib/referential/v2/insurance-contract-document-types';
import type { GraphEvidence } from '../graph/model';

// ── Règles pures ───────────────────────────────────────────────────────────

export interface CoveragePeriod {
  /** AAAA-MM-JJ, date partielle (AAAA, AAAA-MM) ou null (début inconnu). */
  start: string | null;
  end: string | null;
  /** Durée indéterminée ÉTABLIE (≠ fin inconnue). */
  openEnded: boolean;
  /** Période contestée ou remplacée (résolution 113AA) : ne prouve rien. */
  unsettled: boolean;
}

/** COVERS : une période établie couvre la date ; OUTSIDE : les périodes établies l'excluent toutes ; UNKNOWN : rien n'est prouvé. */
export type CoverageAtDate = 'COVERS' | 'OUTSIDE' | 'UNKNOWN';

const JOUR = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Couverture du contrat à la date de survenance (pure). Seules des bornes
 * COMPLÈTES (AAAA-MM-JJ) prouvent quelque chose ; une fin inconnue ne prouve
 * pas que la couverture court encore.
 */
export function coverageAt(periods: readonly CoveragePeriod[], date: string | null): CoverageAtDate {
  if (date === null || !JOUR.test(date)) return 'UNKNOWN';
  const etablies = periods.filter((p) => !p.unsettled);
  if (!etablies.length) return 'UNKNOWN';
  let toutesExcluent = true;
  for (const p of etablies) {
    const debut = p.start !== null && JOUR.test(p.start) ? p.start : null;
    const fin = p.end !== null && JOUR.test(p.end) ? p.end : null;
    const finConnue = fin !== null || p.openEnded;
    if (debut !== null && debut <= date && finConnue && (p.openEnded || date <= fin!)) return 'COVERS';
    const exclut = (debut !== null && date < debut) || (fin !== null && date > fin);
    if (!exclut) toutesExcluent = false;
  }
  return toutesExcluent ? 'OUTSIDE' : 'UNKNOWN';
}

export interface ClaimInsuranceFacts {
  /** Date de SURVENANCE du sinistre (AAAA-MM-JJ) ; null : inconnue (la date de déclaration ne la remplace pas). */
  occurredOn: string | null;
  /** Références de police / contrat citées par les pièces du sinistre (normalisées). */
  policyReferences: readonly string[];
}

export interface InsuranceCandidate {
  operationId: number;
  /** Références de police / contrat portées par le contrat (normalisées). */
  references: readonly string[];
  periods: readonly CoveragePeriod[];
}

export type ClaimInsuranceDecision =
  | { outcome: 'ASSOCIATE'; contractOperationId: number; basis: 'POLICY_REFERENCE' | 'ASSET_AND_PERIOD' }
  | { outcome: 'ASK'; contractOperationIds: number[]; reason: 'SEVERAL_CONTRACTS' | 'COVERAGE_NOT_ESTABLISHED' }
  | { outcome: 'ABSTAIN'; reason: 'NO_CONTRACT' | 'NO_COMPATIBLE_CONTRACT' };

/** Contrats soumis au plus à l'utilisateur pour UN sinistre (une carte par paire ; au-delà : les plus probants d'abord). */
export const CLAIM_INSURANCE_QUESTIONS_MAX = 3;

/**
 * Décision d'association d'un sinistre (pure). `candidates` : contrats
 * d'assurance actifs du compte, sur un bien du sinistre, que l'utilisateur n'a
 * pas refusés. Voir l'en-tête pour les règles.
 */
export function decideClaimInsurance(claim: ClaimInsuranceFacts, candidates: readonly InsuranceCandidate[]): ClaimInsuranceDecision {
  if (!candidates.length) return { outcome: 'ABSTAIN', reason: 'NO_CONTRACT' };
  const cites = new Set(claim.policyReferences);
  const vus = candidates.map((c) => ({
    id: c.operationId,
    couverture: coverageAt(c.periods, claim.occurredOn),
    memeReference: c.references.some((r) => cites.has(r)),
    // Le sinistre cite une police, ce contrat en porte une AUTRE : ce n'est pas lui.
    autreReference: cites.size > 0 && c.references.length > 0 && !c.references.some((r) => cites.has(r)),
  }));
  // Écartés : couverture établie qui exclut la date, ou police différente de celle que cite le sinistre.
  const possibles = vus.filter((c) => c.couverture !== 'OUTSIDE' && !c.autreReference);
  if (!possibles.length) return { outcome: 'ABSTAIN', reason: 'NO_COMPATIBLE_CONTRACT' };
  const parReference = possibles.filter((c) => c.memeReference);
  if (parReference.length === 1) return { outcome: 'ASSOCIATE', contractOperationId: parReference[0].id, basis: 'POLICY_REFERENCE' };
  const aDemander = (parReference.length > 1 ? parReference : possibles)
    .slice().sort((a, b) => Number(b.couverture === 'COVERS') - Number(a.couverture === 'COVERS') || a.id - b.id);
  if (aDemander.length === 1) {
    return aDemander[0].couverture === 'COVERS'
      ? { outcome: 'ASSOCIATE', contractOperationId: aDemander[0].id, basis: 'ASSET_AND_PERIOD' }
      : { outcome: 'ASK', contractOperationIds: [aDemander[0].id], reason: 'COVERAGE_NOT_ESTABLISHED' };
  }
  return { outcome: 'ASK', contractOperationIds: aDemander.slice(0, CLAIM_INSURANCE_QUESTIONS_MAX).map((c) => c.id), reason: 'SEVERAL_CONTRACTS' };
}

// ── Service (lectures bornées au compte ; écritures par la façade seule) ───

type Row = Record<string, unknown>;
const n = (v: unknown): number => Number(v);
const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x) && x > 0).join(',')}}`;

/** Motif de l'association automatique (journal du graphe). */
export const CLAIM_INSURANCE_REASON = 'CLAIM_INSURANCE_SINGLE_MATCH';
/** Sinistres examinés au plus par passage et par compte (ordre stable ; le reste revient au passage suivant). */
export const CLAIMS_PER_PASS = 20;
/** Justificatifs d'assurance cités comme preuves d'une association (borne). */
const EVIDENCE_MAX = 5;

export interface ClaimInsuranceOutcome {
  claimOperationId: number;
  outcome: 'ASSOCIATED' | 'ASKED' | 'ABSTAINED' | 'FAILED';
  /** Détail stable : fondement de l'association, motif de la question ou de l'abstention. */
  detail: string;
  contractOperationIds: number[];
}

export interface ClaimInsuranceReport {
  accountId: number;
  examined: number;
  outcomes: ClaimInsuranceOutcome[];
}

/**
 * Recherche l'assurance des sinistres concernés par un passage de
 * consolidation et applique la décision. `operationIds` : opérations
 * réexaminées par le passage (sinistres, ou contrats d'assurance dont les
 * sinistres du même bien sont alors réexaminés). Ne lève jamais : un sinistre
 * manqué est repris au passage suivant de sa consolidation.
 */
export async function syncClaimInsuranceAssociations(accountId: number, p: { operationIds: readonly number[] }): Promise<ClaimInsuranceReport> {
  const report: ClaimInsuranceReport = { accountId, examined: 0, outcomes: [] };
  const ids = [...new Set(p.operationIds)].filter((x) => Number.isSafeInteger(x) && x > 0);
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !ids.length) return report;
  try {
    const { pgClient } = await import('@/db');
    const q = async (text: string, params: readonly unknown[]): Promise<Row[]> => (await pgClient.unsafe(text, params as never[])) as unknown as Row[];
    const ACTIVE = (a: string) => `${a}.invalidated_at IS NULL AND ${a}.merged_into_operation_id IS NULL`;

    // 1. Sinistres à examiner : ceux du passage, et ceux qui partagent un bien avec un CONTRAT du passage.
    const sinistres = await q(
      `SELECT DISTINCT o.id, COALESCE(o.realized_date, o.start_date)::text AS occurred_on, d.insurance_contract_operation_id AS legacy_contract
         FROM business_operations o
         LEFT JOIN business_operation_claim_details d ON d.operation_id = o.id
        WHERE o.account_id = $1 AND o.type_code = 'CLAIM' AND ${ACTIVE('o')}
          AND (o.id = ANY($2::bigint[])
               OR EXISTS (SELECT 1 FROM business_operation_asset_links la
                            JOIN business_operation_asset_links lc ON lc.asset_id = la.asset_id AND lc.active AND lc.account_id = la.account_id
                            JOIN business_operations c ON c.id = lc.operation_id AND c.account_id = la.account_id AND c.type_code = 'CONTRACT' AND ${ACTIVE('c')}
                           WHERE la.operation_id = o.id AND la.account_id = o.account_id AND la.active AND c.id = ANY($2::bigint[])))
        ORDER BY o.id LIMIT ${CLAIMS_PER_PASS}`, [accountId, intArray(ids)]);
    if (!sinistres.length) return report;

    for (const s of sinistres) {
      const claimId = n(s.id);
      report.examined++;
      try {
        report.outcomes.push(await examiner(q, accountId, claimId, (s.occurred_on as string | null) ?? null, s.legacy_contract !== null && s.legacy_contract !== undefined));
      } catch (e) {
        console.error(`[claims] assurance du sinistre ${claimId} (compte ${accountId}) non recherchée :`, (e as Error).message);
        report.outcomes.push({ claimOperationId: claimId, outcome: 'FAILED', detail: 'TECHNICAL_FAILURE', contractOperationIds: [] });
      }
    }
  } catch (e) {
    console.error(`[claims] recherche des assurances du compte ${accountId} impossible :`, (e as Error).message);
  }
  return report;
}

async function examiner(
  q: (text: string, params: readonly unknown[]) => Promise<Row[]>, accountId: number, claimId: number, occurredOn: string | null, legacyContract: boolean,
): Promise<ClaimInsuranceOutcome> {
  const fin = (outcome: ClaimInsuranceOutcome['outcome'], detail: string, contractOperationIds: number[] = []): ClaimInsuranceOutcome =>
    ({ claimOperationId: claimId, outcome, detail, contractOperationIds });
  const ACTIVE = (a: string) => `${a}.invalidated_at IS NULL AND ${a}.merged_into_operation_id IS NULL`;
  // Lien spécialisé historique déjà renseigné (formulaire de sinistre) : le sinistre a son contrat.
  if (legacyContract) return fin('ABSTAINED', 'ALREADY_ASSOCIATED');

  // 2. Contrats ACTIFS du compte sur un bien du sinistre, avec leurs justificatifs, leurs références et la relation
  //    éventuelle avec le sinistre (active : déjà associé ; refusée : jamais contournée).
  const contrats = await q(
    `SELECT c.id,
            (SELECT COALESCE(json_agg(json_build_object('f', f.id, 't', f.document_type_code) ORDER BY f.id), '[]'::json)
               FROM business_operation_documents bd
               JOIN asset_files f ON f.id = bd.file_id AND f.account_id = bd.account_id AND f.deleted_at IS NULL
              WHERE bd.operation_id = c.id AND bd.account_id = c.account_id AND bd.active) AS documents,
            (SELECT COALESCE(json_agg(DISTINCT r.normalized_value), '[]'::json) FROM business_operation_references r
              WHERE r.operation_id = c.id AND r.account_id = c.account_id AND r.active AND r.reference_kind IN ('POLICY', 'CONTRACT')) AS refs,
            (SELECT rel.state FROM business_operation_relations rel
              WHERE rel.account_id = c.account_id AND LEAST(rel.from_operation_id, rel.to_operation_id) = LEAST(c.id, $2::bigint)
                AND GREATEST(rel.from_operation_id, rel.to_operation_id) = GREATEST(c.id, $2::bigint)) AS relation_state
       FROM business_operations c
      WHERE c.account_id = $1 AND c.type_code = 'CONTRACT' AND ${ACTIVE('c')}
        AND EXISTS (SELECT 1 FROM business_operation_asset_links lc
                      JOIN business_operation_asset_links la ON la.asset_id = lc.asset_id AND la.account_id = lc.account_id AND la.active
                     WHERE lc.operation_id = c.id AND lc.account_id = c.account_id AND lc.active AND la.operation_id = $2)
      ORDER BY c.id`, [accountId, claimId]);
  const liste = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : typeof v === 'string' ? (JSON.parse(v) as T[]) : []);
  const assurances = contrats.map((c) => {
    const docs = liste<{ f: number; t: string | null }>(c.documents);
    return {
      operationId: n(c.id), relationState: (c.relation_state as string | null) ?? null, references: liste<string>(c.refs),
      insuranceFileIds: docs.filter((d) => isInsuranceContractDocumentType(d.t)).map((d) => Number(d.f)),
    };
  }).filter((c) => c.insuranceFileIds.length > 0);
  if (!assurances.length) return fin('ABSTAINED', (await sansBien(q, accountId, claimId)) ? 'CLAIM_WITHOUT_ASSET' : 'NO_CONTRACT');
  // Un sinistre déjà associé à une assurance n'en reçoit pas d'autre automatiquement (l'utilisateur peut en ajouter).
  if (assurances.some((c) => c.relationState === 'ACTIVE')) return fin('ABSTAINED', 'ALREADY_ASSOCIATED');
  const libres = assurances.filter((c) => c.relationState !== 'REJECTED');
  if (!libres.length) return fin('ABSTAINED', 'USER_REFUSED');

  // 3. Faits du sinistre et couverture des contrats (lecture existante des périodes métier).
  const refsSinistre = (await q(
    `SELECT DISTINCT r.normalized_value AS v FROM business_operation_references r
      WHERE r.operation_id = $2 AND r.account_id = $1 AND r.active AND r.reference_kind IN ('POLICY', 'CONTRACT')`, [accountId, claimId]))
    .map((r) => String(r.v));
  const { readOperationsCoverage } = await import('@/services/documents/business-period-surfaces');
  const couvertures = await readOperationsCoverage(accountId, libres.map((c) => c.operationId));
  const candidats: InsuranceCandidate[] = libres.map((c) => ({
    operationId: c.operationId, references: c.references,
    periods: (couvertures.get(c.operationId) ?? []).map((p) => ({
      start: p.start ?? null, end: p.end ?? null, openEnded: p.openEnded === true, unsettled: p.resolution !== undefined,
    })),
  }));
  const d = decideClaimInsurance({ occurredOn, policyReferences: refsSinistre }, candidats);
  if (d.outcome === 'ABSTAIN') return fin('ABSTAINED', d.reason);

  const preuves = (contractId: number): GraphEvidence[] =>
    (libres.find((c) => c.operationId === contractId)?.insuranceFileIds ?? []).slice(0, EVIDENCE_MAX).map((f) => ({ kind: 'DOCUMENT' as const, ref: String(f) }));
  if (d.outcome === 'ASSOCIATE') {
    // Association automatique : par la façade (acteur T3), jamais une écriture directe ; un refus de l'utilisateur
    // découvert entre-temps rend « arbitrage requis » ou un refus — rien n'est alors écrit.
    const { associateOperations } = await import('../operation-write.facade');
    const r = await associateOperations(
      { accountId, actor: { kind: 'AI', treatment: 'T3' }, correlationId: `claim-insurance:${claimId}` },
      { fromOperationId: claimId, toOperationId: d.contractOperationId, nature: 'ASSOCIATED', evidence: preuves(d.contractOperationId), reasonCode: CLAIM_INSURANCE_REASON },
    );
    if (r.status === 'APPLIED') return fin('ASSOCIATED', d.basis, [d.contractOperationId]);
    return fin(r.status === 'FAILED' ? 'FAILED' : 'ABSTAINED', r.code, [d.contractOperationId]);
  }
  // Question ciblée : une carte par contrat possible (mécanisme existant des associations entre opérations).
  const { requestOperationRelationArbitration } = await import('@/services/to-process/operation-relation-cards');
  const demandes: number[] = [];
  for (const contractId of d.contractOperationIds) {
    const carte = await requestOperationRelationArbitration(accountId, {
      fromOperationId: claimId, toOperationId: contractId, nature: 'ASSOCIATED', evidence: preuves(contractId), relationId: null, proposal: 'CLAIM_INSURANCE',
    });
    if (carte.status === 'POSTED' || carte.status === 'UPDATED') demandes.push(contractId);
  }
  return demandes.length ? fin('ASKED', d.reason, demandes) : fin('ABSTAINED', 'QUESTION_NOT_POSTED', d.contractOperationIds);
}

async function sansBien(q: (text: string, params: readonly unknown[]) => Promise<Row[]>, accountId: number, claimId: number): Promise<boolean> {
  const [x] = await q(`SELECT 1 AS ok FROM business_operation_asset_links WHERE operation_id = $2 AND account_id = $1 AND active LIMIT 1`, [accountId, claimId]);
  return !x;
}
