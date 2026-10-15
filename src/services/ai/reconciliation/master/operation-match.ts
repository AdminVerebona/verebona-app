/**
 * T3 master — branche OPERATION_MATCH (lot 42, CDC Opérations V1 C6.1 niveau
 * M3, C6.2, C7 ; CDC 15 §25, U1).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RAPPROCHEMENT SÉMANTIQUE, MONDE FERMÉ, FAITS PERSISTÉS SEULEMENT
 *
 * Appelée par la consolidation T3 des Opérations (`business-operations/
 * consolidation/m3.ts`) pour un candidat T1 en attente « M3_REQUIRED » : les
 * niveaux déterministes M0 à M2 n'ont rien tranché et au moins une Opération
 * reste PLAUSIBLE (faisceau C7 sans clé exacte). Le modèle reçoit :
 *   · SUBJECT_CONTEXT — la source : document (titre, type, date) et candidat
 *     persisté (nature, statut, rôle, prestataire, biens, références, dates,
 *     montants qualifiés) — jamais le fichier brut (C6.2) ;
 *   · CANDIDATES — au plus `OPERATION_MATCH_MAX_CANDIDATES` Opérations
 *     candidates, triées par identifiant (ordre neutre), décrites par leurs
 *     données consolidées et un résumé de leurs documents ;
 *   · RELATION_TYPE — `OPERATION_MATCH` (rappel de la relation recherchée).
 * Aucun nouvel emplacement n'est ajouté au master : une version BO antérieure
 * reste valide pour VALUE_CONFLICT et LINK_AMBIGUITY.
 *
 * Après le modèle, en code : monde fermé (un identifiant hors jeu =
 * AMBIGUOUS, jamais un rattachement), validation de l'issue explicite
 * (lot 56A, `validateResolution`), puis décision serveur (`applyM3Verdict`,
 * `matching.ts`) : ATTACH sur un candidat encore plausible rattache (M3) ;
 * DISTINCT ne crée que si la source peut créer seule (C5) ; ARBITRATE est
 * une ambiguïté (« À traiter » si impact métier, sinon attente). Sortie sans
 * issue (version BO du prompt antérieure au lot 56A) : règle historique
 * (`m3Resolution` : seul SAME_OPERATION + certain rattache).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { closedWorldOperationMatch, type ClosedWorldWarning, type T3OperationMatchOutput } from './t3-contract';

/** Borne du monde fermé : au-delà, aucun appel (trop d'Opérations plausibles pour un départage robuste). */
export const OPERATION_MATCH_MAX_CANDIDATES = 5;
/**
 * Version du constructeur de contexte : entre dans l'empreinte (un changement
 * de format rappelle le modèle). Lot 56A : `m3v2` — extraits des unités
 * documentaires T1 (`document_source_units`) et mode de rattachement des
 * documents déjà liés ; chaque attente / arbitrage M3 est réévalué une fois
 * (plafonds d'appels inchangés).
 */
export const OPERATION_MATCH_CONTEXT_VERSION = 'm3v2';
export const OPERATION_MATCH_RELATION = 'OPERATION_MATCH — la source décrit-elle la même réalité métier qu’une des Opérations candidates ?';

export interface OperationMatchSubject {
  document: {
    title: string | null; documentType: string | null; documentDate: string | null;
    /** Lot 56A : extraits des unités documentaires T1 (libellé : valeur, lignes, blocs), bornés — présents s'ils existent. */
    excerpts?: string[];
  };
  candidate: {
    type: string | null;
    status: string;
    sourceRole: string | null;
    summary: string;
    provider: string | null;
    assets: string[];
    references: string[];
    dates: Record<string, string>;
    amounts: string[];
    /**
     * Lot 55B : périodes facturées (échéances) et équipements concernés —
     * présents seulement s'ils existent (un contexte sans ces données garde
     * son empreinte : aucun rappel du modèle sans changement).
     */
    periods?: string[];
    equipments?: string[];
  };
}

export interface OperationMatchCandidate {
  candidateId: number;
  type: string | null;
  status: string;
  provider: string | null;
  dates: Record<string, string>;
  assets: string[];
  references: string[];
  amounts: string[];
  documents: Array<{
    title: string; role: string | null; summary: string | null;
    /** Lot 56A : comment le document a été lié (USER = décision utilisateur, AI = rapprochement sémantique, REFERENCE, SAME_DOCUMENT). */
    linkedBy?: string;
  }>;
  /** Lot 56A : extraits des unités documentaires T1 du document le plus récent de l'Opération (bornés). */
  excerpts?: string[];
  /** Lot 55B : périodes facturées des coûts actifs, équipements, détail du contrat (si présents). */
  periods?: string[];
  equipments?: string[];
  contract?: { reference: string | null; periodicity: string | null; effectiveFrom: string | null; effectiveTo: string | null };
}

/** Canonicalisation (clés triées) : empreinte stable. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** Variables du master (les six emplacements, `null` pour ceux des autres branches). */
export function operationMatchVariables(subject: OperationMatchSubject, candidates: readonly OperationMatchCandidate[]): Record<string, unknown> {
  return {
    FIELD: null,
    CURRENT_STATE: null,
    EVIDENCES: null,
    SUBJECT_CONTEXT: JSON.stringify(canonical(subject)),
    CANDIDATES: [...candidates].sort((a, b) => a.candidateId - b.candidateId).map((c) => canonical(c)),
    RELATION_TYPE: OPERATION_MATCH_RELATION,
  };
}

/**
 * Empreinte du contexte (NFR-OP-005 : un contexte identique ne rappelle
 * jamais le modèle) : version du constructeur + variables canoniques.
 */
export function operationMatchFingerprint(variables: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify([OPERATION_MATCH_CONTEXT_VERSION, canonical(variables)])).digest('hex').slice(0, 32);
}

/** Lot 56A : les trois issues d'un rapprochement Document → Opération. */
export type OperationMatchResolution = 'ATTACH' | 'ARBITRATE' | 'DISTINCT';

/**
 * Lot 56A : motif d'un déclassement serveur (issue du modèle non retenue,
 * toujours vers ARBITRATE — jamais vers un rattachement).
 */
export type OperationMatchDowngrade =
  | 'ATTACH_WITHOUT_CANDIDATE'
  | 'ATTACH_WITHOUT_POSITIVE_SIGNAL'
  | 'ATTACH_WITH_CONTRADICTIONS'
  | 'ATTACH_CONFLICTUAL'
  | 'DISTINCT_INCONSISTENT'
  | 'DISTINCT_WITHOUT_EVIDENCE';

/** Verdict M3 retenu par le serveur (après monde fermé). */
export interface OperationMatchVerdict {
  decision: T3OperationMatchOutput['decision'];
  matchedOperationId: number | null;
  confidence: T3OperationMatchOutput['confidence'];
  concordantSignals: string[];
  contradictions: string[];
  reason: string;
  /**
   * Lot 56A : issue retenue par le serveur. Absente d'un verdict enregistré
   * avant le lot 56A (règle historique, voir `m3Resolution`).
   */
  resolution?: OperationMatchResolution;
  /** Lot 56A : MODEL = issue explicite du modèle validée ; LEGACY = sortie sans issue (prompt antérieur). */
  resolutionOrigin?: 'MODEL' | 'LEGACY';
  /** Lot 56A : issue du modèle déclassée par le serveur (motif). */
  downgraded?: OperationMatchDowngrade;
}

/**
 * Issue d'un verdict (pure). Verdict sans issue explicite (prompt antérieur
 * au lot 56A, trace enregistrée) : règle historique — SAME_OPERATION +
 * certain rattache, DISTINCT_OPERATION + certain écarte, tout le reste est
 * une ambiguïté.
 */
export function m3Resolution(v: Pick<OperationMatchVerdict, 'decision' | 'confidence' | 'matchedOperationId' | 'resolution'>): OperationMatchResolution {
  if (v.resolution) return v.resolution;
  if (v.decision === 'SAME_OPERATION' && v.confidence === 'certain' && v.matchedOperationId !== null) return 'ATTACH';
  if (v.decision === 'DISTINCT_OPERATION' && v.confidence === 'certain') return 'DISTINCT';
  return 'ARBITRATE';
}

/**
 * Validation serveur de l'issue EXPLICITE du modèle (pure, lot 56A). Le
 * serveur ne rejoue aucun raisonnement métier : il vérifie seulement que
 * l'issue est COHÉRENTE avec ce que le modèle déclare lui-même —
 *   · ATTACH exige un candidat désigné dans le jeu fourni, au moins un
 *     signal concordant (une absence de contradiction n'est pas une preuve),
 *     aucune contradiction déclarée, une confiance non conflictuelle ;
 *   · DISTINCT exige DISTINCT_OPERATION et au moins un élément qui écarte ;
 *   · sinon : ARBITRATE (question à l'utilisateur), motif tracé.
 */
export function validateResolution(
  out: Pick<T3OperationMatchOutput, 'decision' | 'confidence' | 'concordantSignals' | 'contradictions' | 'resolution'>, matchedOperationId: number | null,
): { resolution: OperationMatchResolution; downgraded?: OperationMatchDowngrade } {
  const r = out.resolution;
  if (r === 'ATTACH') {
    if (out.decision !== 'SAME_OPERATION' || matchedOperationId === null) return { resolution: 'ARBITRATE', downgraded: 'ATTACH_WITHOUT_CANDIDATE' };
    if (out.confidence === 'conflictual') return { resolution: 'ARBITRATE', downgraded: 'ATTACH_CONFLICTUAL' };
    if (!out.concordantSignals.some((x) => x.trim())) return { resolution: 'ARBITRATE', downgraded: 'ATTACH_WITHOUT_POSITIVE_SIGNAL' };
    if (out.contradictions.some((x) => x.trim())) return { resolution: 'ARBITRATE', downgraded: 'ATTACH_WITH_CONTRADICTIONS' };
    return { resolution: 'ATTACH' };
  }
  if (r === 'DISTINCT') {
    if (out.decision !== 'DISTINCT_OPERATION') return { resolution: 'ARBITRATE', downgraded: 'DISTINCT_INCONSISTENT' };
    if (!out.contradictions.some((x) => x.trim())) return { resolution: 'ARBITRATE', downgraded: 'DISTINCT_WITHOUT_EVIDENCE' };
    return { resolution: 'DISTINCT' };
  }
  return { resolution: 'ARBITRATE' };
}

/** Sortie modèle → verdict (monde fermé U1, puis validation de l'issue — lot 56A). Pure. */
export function translateOperationMatch(
  out: T3OperationMatchOutput, allowedOperationIds: ReadonlySet<number>,
): { verdict: OperationMatchVerdict; warnings: ClosedWorldWarning[] } {
  const { output, warnings } = closedWorldOperationMatch(out, allowedOperationIds);
  const matchedOperationId = output.decision === 'SAME_OPERATION' ? (output.matchedCandidateId ?? null) : null;
  const base: OperationMatchVerdict = {
    decision: output.decision,
    matchedOperationId,
    confidence: output.confidence,
    concordantSignals: output.concordantSignals.slice(0, 10),
    contradictions: output.contradictions.slice(0, 10),
    reason: output.reason.slice(0, 400),
  };
  // Monde fermé violé : la sortie de remplacement n'a pas d'issue — ambiguïté.
  const explicite = warnings.length === 0 ? out.resolution : undefined;
  if (!explicite) return { verdict: { ...base, resolution: m3Resolution(base), resolutionOrigin: 'LEGACY' }, warnings };
  const v = validateResolution({ ...output, resolution: explicite }, matchedOperationId);
  return { verdict: { ...base, resolution: v.resolution, resolutionOrigin: 'MODEL', ...(v.downgraded ? { downgraded: v.downgraded } : {}) }, warnings };
}

export interface OperationMatchCall {
  accountId: number;
  fileId: number;
  variables: Record<string, unknown>;
}

/** Appel réel par la passerelle (traces « Exécutions IA », plafonds, contrat runtime). */
export async function callOperationMatchModel(p: OperationMatchCall): Promise<T3OperationMatchOutput> {
  const [{ AiGateway }, { T3OperationMatchOutput: schema }] = await Promise.all([
    import('../../gateway/ai-gateway'),
    import('./t3-contract'),
  ]);
  const res = await AiGateway.execute({
    useCaseCode: 'DATA_RECONCILIATION',
    operationCode: 't3_operation_match',
    accountId: p.accountId,
    sourceIds: [p.fileId],
    promptVariables: p.variables,
    outputSchema: schema,
  });
  return res.data as T3OperationMatchOutput;
}
