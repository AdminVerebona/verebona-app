/**
 * Lot 111S — acquisition prouvée par un justificatif : CORROBORATION
 * canonique d'un candidat T1 (ticket P1 « acquisition bout en bout »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONSTAT (rupture prouvée par L111S-E2E-02 / -03) : une facture d'achat du
 * bien analysée par T1 alimente la fiche (date / prix d'achat, preuves
 * `field_evidence` certaines, ciblées sur le bien, posées par les règles
 * déterministes de la projection T1 — « justificatif d'achat du bien
 * LUI-MÊME », jamais une prestation, une pièce, un accessoire, un acompte,
 * un avoir, une preuve de paiement ni un total multi-articles) ; mais son
 * candidat Opération est resté `probable` (ou sans type) : T3 s'abstient
 * (HOLD_UNRESOLVED / PROBABLE_WITHOUT_MATCH, ou Opération sans type jamais
 * projetée) et la donnée automatique de la fiche ne crée rien (garde
 * anti-blanchiment, lot 43 / 85E). Résultat : fiche datée, facture rattachée,
 * aucune Opération, aucun historique « Achat ».
 *
 * RÈGLE (pure, appliquée à l'identité du candidat, donc à TOUTES les
 * reconsolidations — statut, dates, rapprochements restent ceux de T3) :
 * un candidat ÉTABLI de CE document, réalisé, dont le rôle documentaire
 * prouve un achat (facture, acte de vente, rôle non qualifié), qui vise UNE
 * cible (le bien seul, ou un équipement seul), est CORROBORÉ quand CE MÊME
 * document est la preuve canonique ACTIVE et CERTAINE de la date ou du prix
 * d'acquisition de CETTE cible :
 *   · candidat `probable` → `certain` (la création devient permise, C5) ;
 *   · candidat sans type, seul candidat établi du document → ACQUISITION.
 * Jamais : un type connu requalifié (INTERVENTION, CONTRACT…), un devis /
 * une commande / un acompte / un avoir / un paiement, un candidat non établi
 * (motif d'exclusion T1 conservé), une preuve d'un autre document, une
 * preuve ciblée sur une autre entité (équipement ≠ bien parent), un prix
 * « total du panier » (ticket multi-articles, lot 107D). La trace
 * `corroboration` est portée par l'identité et la décision T3 (BO).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { BusinessOperationTypeCode, SourceRole } from '../model';

/** Code tracé (décision T3, contrôle de cohérence, BO). */
export const ACQUISITION_CORROBORATION = 'CANONICAL_ACQUISITION_EVIDENCE';

/** Clés canoniques dont la preuve documentaire établit l'achat de la cible elle-même. */
export const ACQUISITION_EVIDENCE_KEYS = ['acquisitionDate', 'acquisitionPrice'] as const;

/** Règle de projection T1 d'un prix tiré du total d'un panier (lot 107D) : jamais une corroboration. */
const BASKET_RULES = ['ACQUISITION_PRICE_BASKET_TOTAL', 'ACQUISITION_PRICE_LINE_COUNT_UNKNOWN'];

/** Rôles documentaires qui prouvent un achat réalisé (null : rôle non qualifié par T1). */
const PURCHASE_PROOF_ROLES: ReadonlySet<SourceRole | null> = new Set<SourceRole | null>(['INVOICE', 'SALE_DOCUMENT', null]);

/** Clé d'une cible de preuve (`ASSET:12`, `EQUIPMENT:7`). */
export const evidenceTargetKey = (type: 'ASSET' | 'EQUIPMENT', id: number): string => `${type}:${id}`;

/**
 * Preuves canoniques d'acquisition : cible → documents qui la prouvent.
 * Lue par `loadAcquisitionEvidence` (consolidateur) ; absente : aucune corroboration.
 */
export type AcquisitionEvidenceIndex = ReadonlyMap<string, ReadonlySet<number>>;

interface CorroborationInput {
  fileId: number;
  established: boolean;
  confidence: string;
  type: BusinessOperationTypeCode | null;
  status: string;
  role: SourceRole | null;
  assetIds: readonly number[];
  equipmentIds: readonly number[];
  /** Candidats établis du MÊME document (celui-ci compris). */
  documentEstablished: number;
}

export interface Corroboration {
  code: typeof ACQUISITION_CORROBORATION;
  /** Ce que la corroboration a changé (trace). */
  confidence?: 'certain';
  type?: 'ACQUISITION';
  target: string;
}

/** Corroboration d'un candidat (pure ; null : rien à corroborer). */
export function corroborateAcquisition(c: CorroborationInput, index: AcquisitionEvidenceIndex | undefined): Corroboration | null {
  if (!index || !c.established || c.status !== 'REALIZED' || !PURCHASE_PROOF_ROLES.has(c.role)) return null;
  if (c.type !== 'ACQUISITION' && !(c.type === null && c.documentEstablished === 1)) return null;
  const promote = c.confidence === 'probable';
  const retype = c.type === null;
  if (!promote && !retype) return null;
  if (c.confidence !== 'certain' && c.confidence !== 'probable') return null;
  // Une seule cible : l'équipement s'il est désigné (achat de l'équipement, jamais du bien parent), sinon le bien seul.
  let target: string | null = null;
  if (c.equipmentIds.length === 1) target = evidenceTargetKey('EQUIPMENT', c.equipmentIds[0]);
  else if (c.equipmentIds.length === 0 && c.assetIds.length === 1) target = evidenceTargetKey('ASSET', c.assetIds[0]);
  if (!target || !index.get(target)?.has(c.fileId)) return null;
  return { code: ACQUISITION_CORROBORATION, ...(promote ? { confidence: 'certain' as const } : {}), ...(retype ? { type: 'ACQUISITION' as const } : {}), target };
}

/**
 * SQL (paramètres : $1 compte, $2 biens int[], $3 équipements int[]) des
 * preuves canoniques d'acquisition ACTIVES et CERTAINES issues d'un document
 * vivant du compte. `to_jsonb(fe)` : colonnes 0219 lues sans dépendance stricte.
 */
const ACQUISITION_EVIDENCE_SQL = `
  SELECT DISTINCT COALESCE(to_jsonb(fe) ->> 'target_type', 'ASSET') AS target_type,
         COALESCE((to_jsonb(fe) ->> 'target_entity_id')::int, fe.asset_id) AS target_id, fe.source_id AS file_id
    FROM field_evidence fe
    JOIN asset_files f ON f.id = fe.source_id AND f.account_id = fe.account_id AND f.deleted_at IS NULL
   WHERE fe.account_id = $1 AND fe.source_type = 'document' AND fe.confidence = 'certain' AND fe.status IN ('active', 'conflict')
     AND COALESCE(to_jsonb(fe) ->> 'lifecycle_status', 'ACTIVE') = 'ACTIVE'
     AND COALESCE(to_jsonb(fe) ->> 'canonical_key', fe.field_key) IN ('${ACQUISITION_EVIDENCE_KEYS.join("', '")}')
     AND COALESCE(to_jsonb(fe) ->> 'projection_rule', '') NOT IN ('${BASKET_RULES.join("', '")}')
     AND ((COALESCE(to_jsonb(fe) ->> 'target_type', 'ASSET') = 'ASSET' AND COALESCE((to_jsonb(fe) ->> 'target_entity_id')::int, fe.asset_id) = ANY($2::int[]))
       OR (to_jsonb(fe) ->> 'target_type' = 'EQUIPMENT' AND (to_jsonb(fe) ->> 'target_entity_id')::int = ANY($3::int[])))`;

/** Requête autonome (entiers validés, inscrits en littéraux) — consolidateur et contrôle de cohérence. */
export function acquisitionEvidenceSql(accountId: number, assetIds: readonly number[], equipmentIds: readonly number[]): string {
  const ints = (v: readonly number[]) => `'{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}'`;
  if (!Number.isSafeInteger(accountId)) throw new Error('compte invalide');
  return ACQUISITION_EVIDENCE_SQL.replace('$1', String(accountId)).replace('$2', ints(assetIds)).replace('$3', ints(equipmentIds));
}

/** Index des preuves (pure) depuis les lignes de `ACQUISITION_EVIDENCE_SQL`. */
export function acquisitionEvidenceIndex(rows: ReadonlyArray<{ target_type: unknown; target_id: unknown; file_id: unknown }>): AcquisitionEvidenceIndex {
  const out = new Map<string, Set<number>>();
  for (const r of rows) {
    const type = r.target_type === 'EQUIPMENT' ? 'EQUIPMENT' : r.target_type === 'ASSET' ? 'ASSET' : null;
    const id = Number(r.target_id);
    const f = Number(r.file_id);
    if (!type || !Number.isSafeInteger(id) || !Number.isSafeInteger(f)) continue;
    const k = evidenceTargetKey(type, id);
    out.set(k, (out.get(k) ?? new Set<number>()).add(f));
  }
  return out;
}
