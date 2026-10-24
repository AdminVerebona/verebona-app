/**
 * Seuils de qualification des couples — lot 86A (CDC Pilotage IA V2 P5 :
 * QUAL-02, OPT-02, DEC-01, §15 « seuils chiffrés … paramètres documentés »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉCISION PO N° 14 : LES SEUILS SONT DANS LE CODE, VERSIONNÉS
 *
 * Valeurs définies, testées et versionnées ICI ; le BO les expose en LECTURE
 * (Configuration IA › Qualification par couple) et présente les résultats.
 * Aucun seuil n'est abaissé automatiquement ; une modification exige une
 * évolution explicite du code ET un changement de `version` — qui rend
 * obsolètes toutes les preuves antérieures (la version entre dans la
 * signature de chaque couple, `signature.ts`).
 *
 * Qualité — éliminatoire : 0 invention, 0 omission avérée sur le contenu
 * présent, 0 valeur incorrecte, 0 attribution / rattachement erroné, 0 date
 * ou échéance sans preuve, 0 modification injustifiée, 0 non-conformité au
 * schéma ; 100 % des cas obligatoires exécutés et validés. Un résultat non
 * vérifiable reste NON CONCLUANT ; une erreur métier confirmée empêche la
 * qualification automatique.
 *
 * Délai : 100 % des appels conclus sous le plafond de leur opération ; P95
 * dégradé d'au plus 20 % par rapport au modèle actif, mesuré sur les MÊMES
 * cas dans la même campagne (valeur initiale de qualification).
 *
 * Concurrence : traitements en file testés avec la concurrence existante —
 * 3 exécutions au plus par worker, dont 2 par traitement — sans perte,
 * corruption ni attribution incorrecte ; T2 et T6 (synchrones) avec 3 appels
 * simultanés initiaux chacun (nouveau seuil de test, à valider en
 * préproduction). Une erreur fournisseur transitoire rend l'essai non
 * concluant et entraîne UN nouvel essai ; jamais une réussite, jamais seule
 * une faute métier du modèle.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Treatment } from '../config/treatments';

/** Catégories de défauts métier (décision 14) — chacune éliminatoire à partir de 1. */
export const DEFECT_CATEGORIES = [
  'INVENTION', 'OMISSION', 'INCORRECT_VALUE', 'ATTRIBUTION', 'DATE_WITHOUT_PROOF', 'UNJUSTIFIED_CHANGE', 'SCHEMA', 'BUSINESS_CHECK',
] as const;
export type DefectCategory = (typeof DEFECT_CATEGORIES)[number];

export const DEFECT_LABELS: Readonly<Record<DefectCategory, string>> = {
  INVENTION: 'Invention',
  OMISSION: 'Omission avérée',
  INCORRECT_VALUE: 'Valeur incorrecte',
  ATTRIBUTION: 'Attribution / rattachement erroné',
  DATE_WITHOUT_PROOF: 'Date ou échéance sans preuve',
  UNJUSTIFIED_CHANGE: 'Modification injustifiée',
  SCHEMA: 'Non-conformité au schéma',
  BUSINESS_CHECK: 'Contrôle métier serveur en échec',
};

export interface QualificationThresholds {
  readonly version: string;
  readonly quality: {
    /** Nombre maximal admis par catégorie (toutes à 0). */
    readonly maxDefects: Readonly<Record<DefectCategory, number>>;
    /** Part des cas obligatoires exécutés ET validés (1 = 100 %). */
    readonly mandatoryValidatedRatio: number;
  };
  readonly latency: {
    /** Part des appels conclus sous le plafond de l'opération (1 = 100 %). */
    readonly withinCapRatio: number;
    /** Dégradation maximale du P95 par rapport au modèle actif (0,20 = +20 %). */
    readonly maxP95Degradation: number;
    /** Percentile mesuré. */
    readonly percentile: number;
  };
  readonly concurrency: {
    /** Exécutions simultanées par instance de worker (AI_QUEUE_CONCURRENCY par défaut). */
    readonly queuedPerWorker: number;
    /** Dont exécutions simultanées d'un même traitement. */
    readonly queuedPerTreatment: number;
    /** Appels simultanés initiaux des traitements synchrones. */
    readonly synchronousSimultaneous: number;
    readonly synchronousTreatments: readonly Treatment[];
  };
  /** Erreur fournisseur transitoire : nombre de nouveaux essais du cas. */
  readonly transientRetries: number;
  /** Bornes de campagne (OPT-02 : limiter combinaisons, appels, relances et concurrence). */
  readonly campaign: {
    /** Rejeux de données existantes par compte et par opération. */
    readonly replayPerAccount: number;
    /** Rejeux au plus par opération (tous comptes). */
    readonly replayMaxPerOperation: number;
    /** Observations par cas : test manuel / campagne automatique (DEC-02). */
    readonly observationsManual: number;
    readonly observationsAuto: number;
    /** Candidates automatiques proposées par traitement et par campagne. */
    readonly maxCandidatesPerTreatment: number;
    /** Couples testés au plus par campagne automatique (le reste au passage suivant). */
    readonly maxCouplesPerCampaign: number;
    /** Campagne sans signe de vie au-delà : interrompue (R13). */
    readonly staleAfterMs: number;
    /** Une proposition non concluante peut être retentée après ce délai. */
    readonly inconclusiveRetryAfterMs: number;
  };
}

export const QUALIFICATION_THRESHOLDS: QualificationThresholds = Object.freeze({
  version: 'qualif-seuils-v1',
  quality: Object.freeze({
    maxDefects: Object.freeze({
      INVENTION: 0, OMISSION: 0, INCORRECT_VALUE: 0, ATTRIBUTION: 0, DATE_WITHOUT_PROOF: 0, UNJUSTIFIED_CHANGE: 0, SCHEMA: 0, BUSINESS_CHECK: 0,
    }),
    mandatoryValidatedRatio: 1,
  }),
  latency: Object.freeze({ withinCapRatio: 1, maxP95Degradation: 0.2, percentile: 95 }),
  concurrency: Object.freeze({
    queuedPerWorker: 3, queuedPerTreatment: 2, synchronousSimultaneous: 3, synchronousTreatments: Object.freeze(['T2', 'T6'] as Treatment[]),
  }),
  transientRetries: 1,
  campaign: Object.freeze({
    replayPerAccount: 2,
    replayMaxPerOperation: 20,
    observationsManual: 1,
    observationsAuto: 2,
    maxCandidatesPerTreatment: 1,
    maxCouplesPerCampaign: 24,
    staleAfterMs: 30 * 60_000,
    inconclusiveRetryAfterMs: 24 * 3_600_000,
  }),
}) as QualificationThresholds;

/** Traitement synchrone (T2, T6) : test « 3 appels simultanés initiaux ». */
export function isSynchronousTreatment(t: Treatment, th: QualificationThresholds = QUALIFICATION_THRESHOLDS): boolean {
  return th.concurrency.synchronousTreatments.includes(t);
}

/**
 * Priorité d'optimisation (OPT-02) : rapidité pour les usages interactifs
 * (T2, T6 FORMULATE), coût par résultat valide pour l'arrière-plan.
 */
export function optimizationPriority(operationCode: string): 'LATENCY' | 'COST' {
  return /^t2_/.test(operationCode) || operationCode === 't6_formulate' ? 'LATENCY' : 'COST';
}

/** Vue lisible des seuils (BO, lecture seule). */
export function describeThresholds(th: QualificationThresholds = QUALIFICATION_THRESHOLDS) {
  return {
    version: th.version,
    quality: DEFECT_CATEGORIES.map((c) => ({ category: c, label: DEFECT_LABELS[c], max: th.quality.maxDefects[c] })),
    mandatoryValidatedPercent: Math.round(th.quality.mandatoryValidatedRatio * 100),
    latency: {
      withinCapPercent: Math.round(th.latency.withinCapRatio * 100),
      percentile: th.latency.percentile,
      maxDegradationPercent: Math.round(th.latency.maxP95Degradation * 100),
    },
    concurrency: { ...th.concurrency, synchronousTreatments: [...th.concurrency.synchronousTreatments] },
    transientRetries: th.transientRetries,
    campaign: { ...th.campaign },
    source: 'code',
  };
}
