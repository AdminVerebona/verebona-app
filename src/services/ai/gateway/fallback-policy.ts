/**
 * Politique de secours PAR CAUSE — lot 87A (CDC Pilotage IA V2, phase P7 :
 * RUN-01, RUN-02, RUN-03, R09, R10, R11, R57 ; décision PO 08). PUR.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN SECOND MOTEUR
 *
 * La passerelle garde SA boucle principal → secours (INV-09) ; ce module ne
 * fait que DÉCIDER, à chaque rang, si le modèle suivant peut être essayé et
 * pourquoi. Il ne lit rien : l'état opérationnel connu, l'état de
 * qualification des couples et les exclusions lui sont fournis
 * (`fallback-context.ts`). Chaque décision est tracée par la passerelle
 * (`ai_usage_event.metadata.fallback`, capture, erreur finale).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TABLEAU §8 DU CDC → CAUSES
 *
 *   Cause établie (CDC)                         Causes        Action
 *   ──────────────────────────────────────────  ────────────  ──────────────────────────
 *   Défaillance / délai / limite propre au       QUOTA,        secours autorisé dont le
 *   modèle                                       UNAVAILABLE,  profil peut résoudre
 *                                                TIMEOUT,
 *                                                MODEL_LIMIT,
 *                                                KNOWN_UNAVAILABLE
 *   Paramètre refusé pour ce modèle              PARAMETER_*   incompatibilité de requête
 *                                                              (jamais « indisponible »,
 *                                                              disjoncteur non avancé) ;
 *                                                              autre configuration
 *   Défaut commun (prompt, contrat,              COMMON_DEFECT,arrêt des tentatives ;
 *   construction, accès global)                  GLOBAL_ACCESS échec (reprise de la file)
 *                                                              ou suspension (accès)
 *   Résultat invalide ou incomplet               INVALID_      reprise ciblée existante
 *                                                OUTPUT,       (modèle suivant informé) ;
 *                                                OUTPUT_       tronquée : seulement si le
 *                                                TRUNCATED     plafond du secours est
 *                                                              supérieur (gain plausible)
 *   Cause indéterminée                           UNKNOWN       au plus UN essai alternatif,
 *                                                              puis arrêt
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SECOURS ADMISSIBLES (RUN-02, ACT-01, ACT-02, MIG-02) — RÈGLE PRUDENTE
 *
 * Un secours (tout modèle sollicité APRÈS un échec ou un saut) doit être :
 *   1. non connu indisponible (état opérationnel, clé active) ;
 *   2. non exclu par une intervention manuelle (86B, y compris prise en
 *      cours d'exécution : une exclusion ne fait que retirer) ;
 *   3. permis par la cause (tableau ci-dessus) ;
 *   4. qualifié : couple ADMISSIBLE pour la signature courante (86A) ⇒
 *      « secours qualifié ». Sans preuve admissible :
 *        · couple REFUSÉ à la qualification ⇒ jamais choisi ;
 *        · configuration d'origine AUTOMATIQUE (candidate activée par le
 *          système) ⇒ jamais choisi (une preuve obsolète ne fonde aucune
 *          décision automatique, QUAL-08) ;
 *        · sinon (jamais testé, non concluant, obsolète, en test, état
 *          illisible) ⇒ admis comme « secours non testé — choix de
 *          l'administrateur » : il figure dans la chaîne que
 *          l'administrateur a configurée (ACT-02 : tests facultatifs ;
 *          MIG-02 : les configurations existantes restent manuelles, non
 *          qualifiées). Le système ne choisit JAMAIS spontanément un modèle
 *          hors de cette chaîne (aucun modèle improvisé, R11).
 * Le premier modèle sollicité (principal, ou rang d'escalade demandé par
 * l'appelant) n'est pas un secours : seuls l'état opérationnel et les
 * exclusions s'y appliquent. Une exclusion EN VIGUEUR (même prise pendant
 * l'exécution, dont la chaîne est figée — RUN-04) ne fait que retirer : le
 * modèle exclu est sauté sans appel, et le suivant devient le premier
 * sollicité (comme la surcouche 86B au démarrage), sans cause d'échec.
 * Les épreuves de qualification (rang forcé) ne sont jamais détournées :
 * aucun saut, aucune exclusion (elles doivent atteindre le couple testé).
 */

/** Version de la politique (tracée avec chaque décision). */
export const FALLBACK_POLICY_VERSION = 'p7-v1' as const;

export const FAILURE_CAUSES = [
  'QUOTA', 'UNAVAILABLE', 'TIMEOUT', 'MODEL_LIMIT', 'KNOWN_UNAVAILABLE',
  'PARAMETER_REJECTED', 'PARAMETER_INCOMPATIBLE',
  'COMMON_DEFECT', 'GLOBAL_ACCESS',
  'INVALID_OUTPUT', 'OUTPUT_TRUNCATED',
  'UNKNOWN',
] as const;
export type FailureCause = (typeof FAILURE_CAUSES)[number];

/** Ligne du tableau §8 du CDC. */
export type CdcRow = 'MODEL_SPECIFIC' | 'REQUEST_INCOMPATIBILITY' | 'COMMON_DEFECT' | 'INVALID_RESULT' | 'UNDETERMINED';

export interface CausePolicy {
  row: CdcRow;
  /** Un secours peut-il être essayé après cette cause ? */
  fallback: 'ALLOWED' | 'STOP' | 'ONE_ALTERNATIVE' | 'IF_PROFILE_HELPS';
  /** Sans secours admissible : suspendre (reprise possible) plutôt qu'échouer. */
  suspendWithoutFallback: boolean;
  /** Compte pour le disjoncteur (indisponibilité du modèle). */
  countsForBreaker: boolean;
  label: string;
}

export const CAUSE_POLICY: Readonly<Record<FailureCause, CausePolicy>> = {
  QUOTA: { row: 'MODEL_SPECIFIC', fallback: 'ALLOWED', suspendWithoutFallback: true, countsForBreaker: true, label: 'quota ou limite de débit du modèle' },
  UNAVAILABLE: { row: 'MODEL_SPECIFIC', fallback: 'ALLOWED', suspendWithoutFallback: true, countsForBreaker: true, label: 'modèle indisponible' },
  TIMEOUT: { row: 'MODEL_SPECIFIC', fallback: 'ALLOWED', suspendWithoutFallback: true, countsForBreaker: true, label: 'délai dépassé' },
  MODEL_LIMIT: { row: 'MODEL_SPECIFIC', fallback: 'ALLOWED', suspendWithoutFallback: false, countsForBreaker: true, label: 'limite propre au modèle (taille de la demande)' },
  KNOWN_UNAVAILABLE: { row: 'MODEL_SPECIFIC', fallback: 'ALLOWED', suspendWithoutFallback: true, countsForBreaker: false, label: 'modèle connu indisponible (état opérationnel)' },
  PARAMETER_REJECTED: { row: 'REQUEST_INCOMPATIBILITY', fallback: 'ALLOWED', suspendWithoutFallback: true, countsForBreaker: false, label: 'paramètre refusé par ce modèle' },
  PARAMETER_INCOMPATIBLE: { row: 'REQUEST_INCOMPATIBILITY', fallback: 'ALLOWED', suspendWithoutFallback: true, countsForBreaker: false, label: 'réglage incompatible avec ce modèle (refus avant appel)' },
  COMMON_DEFECT: { row: 'COMMON_DEFECT', fallback: 'STOP', suspendWithoutFallback: false, countsForBreaker: true, label: 'défaut commun (prompt, contrat ou construction de la requête)' },
  GLOBAL_ACCESS: { row: 'COMMON_DEFECT', fallback: 'STOP', suspendWithoutFallback: true, countsForBreaker: true, label: 'accès global refusé (clé fournisseur)' },
  INVALID_OUTPUT: { row: 'INVALID_RESULT', fallback: 'ALLOWED', suspendWithoutFallback: false, countsForBreaker: true, label: 'sortie invalide' },
  OUTPUT_TRUNCATED: { row: 'INVALID_RESULT', fallback: 'IF_PROFILE_HELPS', suspendWithoutFallback: false, countsForBreaker: true, label: 'sortie tronquée (plafond de sortie atteint)' },
  UNKNOWN: { row: 'UNDETERMINED', fallback: 'ONE_ALTERNATIVE', suspendWithoutFallback: false, countsForBreaker: true, label: 'cause indéterminée' },
};

/** Échec à classer : famille / sous-type du diagnostic, code de passerelle, métadonnées utiles. */
export interface FailureFacts {
  family: string | null;
  subtype?: string | null;
  code?: string | null;
  httpStatus?: number | null;
  providerErrorCode?: string | null;
  message?: string | null;
}

/**
 * Cause établie d'un échec (pure). N'invente rien : ce qui n'est pas
 * attribuable avec certitude au modèle ou à un défaut commun est UNKNOWN.
 */
export function causeOfFailure(f: FailureFacts): FailureCause {
  const sub = f.subtype ?? null;
  if (sub === 'PARAMETER_REJECTED') return 'PARAMETER_REJECTED';
  if (sub === 'PARAMETER_INCOMPATIBLE' || f.code === 'MODEL_PARAMETERS_INCOMPATIBLE') return 'PARAMETER_INCOMPATIBLE';
  if (sub === 'OUTPUT_TRUNCATED') return 'OUTPUT_TRUNCATED';
  if (sub === 'RUNTIME_CONTRACT_MISMATCH') return 'COMMON_DEFECT';
  switch (f.family) {
    case 'RATE_LIMIT': return 'QUOTA';
    case 'TIMEOUT': return 'TIMEOUT';
    case 'PROVIDER_ERROR': return 'UNAVAILABLE';
    case 'CONTEXT_TOO_LARGE': return 'MODEL_LIMIT';
    case 'INVALID_OUTPUT': return 'INVALID_OUTPUT';
    case 'INTERNAL_ERROR': return 'COMMON_DEFECT';
    case 'AUTH_ERROR': {
      // Clé refusée / absente = accès GLOBAL ; un 403 sur un modèle précis
      // (droit d'accès au modèle) n'est pas établi comme global.
      const msg = String(f.message ?? '');
      const global = f.httpStatus === 401 || f.providerErrorCode === 'UNAUTHENTICATED'
        || /api key (not valid|invalid|expired)|Aucune clé|API_KEY_INVALID/i.test(msg);
      return global ? 'GLOBAL_ACCESS' : 'UNKNOWN';
    }
    case 'INPUT_ERROR': {
      // 404 / NOT_FOUND : le MODÈLE n'existe plus pour la clé (propre au modèle).
      if (f.httpStatus === 404 || f.providerErrorCode === 'NOT_FOUND') return 'UNAVAILABLE';
      return 'UNKNOWN';
    }
    // Réseau, blocage de sécurité, inconnu : non attribuables avec certitude.
    default: return 'UNKNOWN';
  }
}

/** États de qualification d'un couple (86A) vus par la politique ; `UNKNOWN` : illisible. */
export type CoupleQualification = 'ADMISSIBLE' | 'REFUSED' | 'INCONCLUSIVE' | 'OBSOLETE' | 'NEVER_TESTED' | 'TESTING' | 'UNKNOWN';

export type AdmissionReason =
  // Admis
  | 'FIRST' | 'QUALIFIED' | 'MANUAL_UNTESTED'
  // Refusés (aucun appel)
  | 'KNOWN_UNAVAILABLE' | 'EXCLUDED' | 'CAUSE_STOPS_CHAIN' | 'UNKNOWN_CAUSE_LIMIT' | 'PROFILE_CANNOT_RESOLVE'
  | 'COUPLE_REFUSED' | 'NOT_QUALIFIED_AUTOMATIC';

export const ADMISSION_LABELS: Readonly<Record<AdmissionReason, string>> = {
  FIRST: 'premier modèle de la chaîne',
  QUALIFIED: 'secours qualifié (couple admissible)',
  MANUAL_UNTESTED: 'secours non testé — choix de l’administrateur (chaîne configurée)',
  KNOWN_UNAVAILABLE: 'modèle connu indisponible : non appelé',
  EXCLUDED: 'modèle exclu par un administrateur',
  CAUSE_STOPS_CHAIN: 'la cause de l’échec rend tout secours inutile',
  UNKNOWN_CAUSE_LIMIT: 'cause indéterminée : un seul essai alternatif',
  PROFILE_CANNOT_RESOLVE: 'le profil du secours ne peut pas résoudre l’échec (plafond de sortie non supérieur)',
  COUPLE_REFUSED: 'couple refusé à la qualification',
  NOT_QUALIFIED_AUTOMATIC: 'configuration automatique sans preuve admissible courante',
};

export interface Candidate {
  model: string;
  /** Rang dans la chaîne complète (0 = principal). */
  rankIndex: number;
  knownUnavailable: boolean;
  excluded: boolean;
  qualification: CoupleQualification;
  /** Plafond de sortie effectif que recevrait ce modèle (`null` : inconnu / refusé avant appel). */
  maxOutputTokens: number | null;
}

export type Admission =
  | { admitted: true; reason: 'FIRST' | 'QUALIFIED' | 'MANUAL_UNTESTED' }
  | { admitted: false; reason: Exclude<AdmissionReason, 'FIRST' | 'QUALIFIED' | 'MANUAL_UNTESTED'> };

/**
 * Le candidat peut-il être sollicité (pure) ?
 * `previous` : `null` pour le premier modèle considéré ; sinon cause de
 * l'échec (ou du saut) précédent, plafond de sortie envoyé au modèle tronqué,
 * nombre d'essais alternatifs déjà accordés à une cause indéterminée.
 */
export function admitCandidate(c: Candidate, previous: {
  cause: FailureCause; truncatedAtMaxOutputTokens: number | null; unknownAlternativesUsed: number;
} | null, ctx: { configOrigin: 'manual' | 'auto' | null }): Admission {
  if (c.knownUnavailable) return { admitted: false, reason: 'KNOWN_UNAVAILABLE' };
  if (c.excluded) return { admitted: false, reason: 'EXCLUDED' };
  if (previous === null) return { admitted: true, reason: 'FIRST' };
  const pol = CAUSE_POLICY[previous.cause];
  if (pol.fallback === 'STOP') return { admitted: false, reason: 'CAUSE_STOPS_CHAIN' };
  if (pol.fallback === 'ONE_ALTERNATIVE' && previous.unknownAlternativesUsed >= 1) return { admitted: false, reason: 'UNKNOWN_CAUSE_LIMIT' };
  if (pol.fallback === 'IF_PROFILE_HELPS' && previous.truncatedAtMaxOutputTokens !== null
    && (c.maxOutputTokens === null || c.maxOutputTokens <= previous.truncatedAtMaxOutputTokens)) {
    return { admitted: false, reason: 'PROFILE_CANNOT_RESOLVE' };
  }
  if (c.qualification === 'ADMISSIBLE') return { admitted: true, reason: 'QUALIFIED' };
  if (c.qualification === 'REFUSED') return { admitted: false, reason: 'COUPLE_REFUSED' };
  if (ctx.configOrigin === 'auto') return { admitted: false, reason: 'NOT_QUALIFIED_AUTOMATIC' };
  return { admitted: true, reason: 'MANUAL_UNTESTED' };
}

/** Une décision de la chaîne, telle que tracée (appel, capture, erreur finale). */
export interface FallbackDecision {
  policy: typeof FALLBACK_POLICY_VERSION;
  rank: string | null;
  model: string;
  decision: AdmissionReason;
  decisionLabel: string;
  /** Cause de l'échec (ou du saut) qui a conduit à considérer ce modèle ; `null` : premier. */
  afterCause: FailureCause | null;
  afterCauseLabel: string | null;
  /** Modèle dont l'échec a conduit à ce rang. */
  afterModel: string | null;
  qualification: CoupleQualification;
  /** Modèle connu indisponible : dernier contrôle (lien avec l'anomalie, INV-10). */
  operational?: { checkedAt: string | null; error: string | null } | null;
}

export function decisionOf(p: {
  rank: string | null; model: string; admission: Admission; afterCause: FailureCause | null; afterModel: string | null;
  qualification: CoupleQualification; operational?: { checkedAt: string | null; error: string | null } | null;
}): FallbackDecision {
  return {
    policy: FALLBACK_POLICY_VERSION, rank: p.rank, model: p.model,
    decision: p.admission.reason, decisionLabel: ADMISSION_LABELS[p.admission.reason],
    afterCause: p.afterCause, afterCauseLabel: p.afterCause ? CAUSE_POLICY[p.afterCause].label : null,
    afterModel: p.afterModel, qualification: p.qualification,
    ...(p.operational ? { operational: p.operational } : {}),
  };
}

/** Motifs de refus qui traduisent l'ABSENCE de secours admissible (et non une limite de la politique). */
const SANS_SECOURS_ADMISSIBLE: ReadonlySet<AdmissionReason> = new Set<AdmissionReason>([
  'KNOWN_UNAVAILABLE', 'EXCLUDED', 'COUPLE_REFUSED', 'NOT_QUALIFIED_AUTOMATIC',
]);

/**
 * Issue d'une chaîne sans réussite (pure) :
 *   · SUSPEND — la dernière cause relève d'une indisponibilité / d'un accès
 *     (reprise possible) ET aucun secours admissible n'a pu être essayé
 *     (refus faute de secours admissible, ou arrêt sur accès global), ou
 *     aucun modèle n'a pu être appelé ;
 *   · FAIL — sinon (tous les secours admissibles essayés, résultat invalide,
 *     défaut commun, cause indéterminée persistante) : échec de la chaîne,
 *     politiques de reprise existantes inchangées.
 */
export function chainOutcome(p: {
  lastCause: FailureCause | null;
  decisions: readonly Pick<FallbackDecision, 'decision'>[];
  attempted: number;
}): 'SUSPEND' | 'FAIL' {
  if (p.attempted === 0 && p.decisions.length > 0 && p.decisions.every((d) => SANS_SECOURS_ADMISSIBLE.has(d.decision))) return 'SUSPEND';
  if (!p.lastCause || !CAUSE_POLICY[p.lastCause].suspendWithoutFallback) return 'FAIL';
  if (p.lastCause === 'GLOBAL_ACCESS') return 'SUSPEND';
  return p.decisions.some((d) => SANS_SECOURS_ADMISSIBLE.has(d.decision)) ? 'SUSPEND' : 'FAIL';
}
