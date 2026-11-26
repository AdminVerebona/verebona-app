/**
 * Lot 114H (Trello #775, P1-C) — RÉÉVALUATION AUTOMATISÉE DE LA COUVERTURE T1
 * DU STOCK, et clôture des SEULES alertes dont la cause a disparu.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Les lots 113AN (#741) et 114G (#760) ont corrigé les règles de couverture
 * (faux « non résolu », valeurs partiellement structurées, coordonnées…) et
 * ce lot corrige les règles de reprise. Aucun ne recalculait les documents
 * DÉJÀ analysés : leurs états, leurs alertes et leurs échéances de reprise
 * restaient ceux de l'ancienne condition, jusqu'à une consultation manuelle
 * du BO. Cette campagne applique les règles ACTUELLES à tout le stock, sans
 * action de personne, lancée par la tâche planifiée `t1-coverage-reassessment`
 * (au démarrage, puis toutes les heures tant qu'il reste des documents).
 *
 * CE QU'ELLE FAIT, DOCUMENT PAR DOCUMENT — SANS AUCUN APPEL IA
 *   1. re-vérification déterministe des pages d'un PDF contre son texte
 *      original déjà persisté (`reverifyStoredCoverage`, lot 109K), quand elle
 *      est due — jamais de promotion sans texte retrouvé ;
 *   2. réconciliation des unités avec les faits, décisions de valeur,
 *      tableaux, candidats et métadonnées persistés
 *      (`reconcileStoredDocumentCoverage`, lots 113AN / 114G), et règle
 *      unique des reprises (`retry-policy.ts`) : attentes sans chemin levées,
 *      état et anomalies recalculés, échéance retirée ou, pour une lacune
 *      réellement réparable, reposée — la réparation ciblée elle-même reste
 *      exécutée par `t1-completeness-retry`, avec ses plafonds normaux ;
 *   3. alertes de Supervision du document (`ai:t1-completeness:<id>`,
 *      `ai:t1-normalisation-loss:<id>`) : CLOSE si l'état recalculé ne la
 *      justifie plus, MAINTENUE si la cause existe toujours, OUVERTE si une
 *      lacune réelle sans reprise admissible n'était pas signalée ;
 *   4. journal `t1_coverage_reassessments` (migration 1705) : avant / après,
 *      version des règles, date, alertes, durée.
 * Puis les alertes T1 ouvertes SANS document éligible au passage (document
 * supprimé, couverture devenue complète entre-temps) sont examinées par leur
 * empreinte, sur l'état COURANT.
 *
 * CE QU'ELLE NE FAIT JAMAIS
 *   · appeler un modèle, relire un fichier, réanalyser un document ;
 *   · créer ou modifier un fait, une décision, un événement brut, un appel IA
 *     ou une trace d'audit ;
 *   · promouvoir une unité sans preuve, ni effacer une incertitude ;
 *   · notifier l'utilisateur ;
 *   · clore une alerte dont la cause subsiste.
 *
 * REPRENABLE, PAGINÉE, IDEMPOTENTE
 *   · pagination par identifiant de document (curseur), lots bornés
 *     (`T1_REASSESSMENT_BATCH`), échéance de passage ;
 *   · point de reprise = le journal : un document journalisé pour la version
 *     courante n'est pas retraité (une erreur l'est, `REASSESSMENT_MAX_ATTEMPTS`
 *     fois au plus) ; deux campagnes de suite : la seconde ne fait rien ;
 *   · comptes éligibles seulement (lot 82A) — les autres sont repris à leur
 *     réactivation ; toute lecture et écriture est filtrée par le compte du
 *     document.
 *
 * RÈGLE PERMANENTE (carte § 4) : tout correctif T1 qui change la condition
 * d'une alerte ou d'un état de couverture AUGMENTE `T1_COVERAGE_RULES_VERSION` ;
 * le stock est alors réévalué de nouveau, automatiquement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash, randomUUID } from 'node:crypto';
import { processingEligibleSql } from '@/services/account/processing-eligibility';

/**
 * Version des règles de couverture / d'alerte T1 appliquées au stock.
 *   1 — lot 114H (#775) : règles 113AN + 114G + règle unique des reprises.
 *   4 — carte #853 (P1-01 #835) : complétude par OCCURRENCE (valeurs, propositions, cellules) — le stock, y
 *       compris les documents COMPLETE, est réévalué sans IA pour requalifier les faux COVERED historiques.
 */
export const T1_COVERAGE_RULES_VERSION = 4;

/**
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 115H (Trello #785, § 5) — TOUT CHANGEMENT DE CONDITION D'ALERTE T1
 * DÉCLENCHE AUTOMATIQUEMENT LE RATTRAPAGE
 *
 * Règle complétée : `T1_COVERAGE_RULES_VERSION` devait être incrémenté À LA
 * MAIN. Rien ne le garantissait : un correctif changeant la condition d'une
 * alerte pouvait partir sans que le stock soit réévalué — les documents déjà
 * journalisés pour la version restaient sur l'ancienne condition.
 *
 * Le mécanisme est maintenant VÉRIFIÉ PAR LES TESTS DE LIVRAISON :
 *   1. `t1AlertConditionsSignature()` est l'empreinte des conditions d'alerte
 *      réellement en vigueur (familles, préfixes, ce que chacune couvre) ;
 *   2. `T1_RULES_VERSION_SIGNATURES` associe chaque version LIVRÉE à sa
 *      signature ;
 *   3. un test exige que la signature de la version courante corresponde.
 * Changer une condition change la signature : le test échoue tant que la
 * version n'a pas été incrémentée ET enregistrée ici. Et incrémenter la version
 * suffit à faire reprendre tout le stock (la campagne sélectionne les documents
 * non journalisés pour la version courante) : le rattrapage est automatique.
 *
 * Histoire des versions :
 *   1 — lot 114H (#775) : règles 113AN + 114G + règle unique des reprises ;
 *       familles d'alertes « complétude » et « perte de normalisation » ;
 *   2 — lot 115H (#785) : la famille « refus de remise en file »
 *       (`ai:t1-requeue:*`) entre dans le recontrôle, l'achèvement exige une
 *       action persistée et confirmée, et la re-vérification se déclenche aussi
 *       sur une preuve nouvelle à version constante.
 * ══════════════════════════════════════════════════════════════════════════
 */
export const T1_RULES_VERSION_SIGNATURES: Readonly<Record<number, string>> = {
  // Version 1 : inventaire du lot 114H (complétude, perte de normalisation) — signature reconstituée.
  1: 'e83f8cdd7f71969ba22cf5c85183671f',
  2: 'f1ff0b8354239dc2e562b8e5183100c4',
  // Version 3 (carte #837) : inventaire des familles INCHANGÉ — ce sont les PRÉDICATS qui changent (voir ci-dessous).
  3: 'f1ff0b8354239dc2e562b8e5183100c4',
  // Version 4 (carte #853) : inventaire des familles INCHANGÉ — prédicat de couverture par occurrence ajouté.
  4: 'f1ff0b8354239dc2e562b8e5183100c4',
};

/**
 * ══════════════════════════════════════════════════════════════════════════
 * CARTE TRELLO #837 (C3) — LA GARDE PORTE SUR LE CODE RÉEL DES PRÉDICATS
 *
 * Règle complétée : `t1AlertConditionsSignature()` ne hachait que les
 * MÉTADONNÉES de l'inventaire (code, préfixe, « recontrôlée », ce qu'elle
 * couvre). Modifier la LOGIQUE d'une condition (`alertDecisionOf`,
 * `decideRetry`, issue de couverture…) sans toucher à l'inventaire passait
 * la CI : le stock restait évalué sur l'ancienne condition.
 *
 * `T1_RULES_PREDICATE_SIGNATURES` enregistre, pour chaque version LIVRÉE,
 * l'empreinte du CODE (corps sans commentaires ni mise en forme, via le
 * compilateur TypeScript) de chaque prédicat listé dans
 * `T1_RULE_PREDICATES`. Le test de livraison recalcule cette empreinte sur
 * les sources : toute modification matérielle d'un prédicat le fait échouer
 * tant que `T1_COVERAGE_RULES_VERSION` n'a pas été incrémentée ET la nouvelle
 * empreinte enregistrée — et incrémenter la version relance le cycle complet
 * du stock (journal par version).
 *
 * Histoire : 3 — carte #837 (admission commune, DONE métier, échéance
 * admissible, empreinte des preuves exhaustive) ; 4 — carte #853 (couverture
 * par occurrence, `reconcileCoverage` ajouté aux prédicats gardés, documents
 * COMPLETE réévalués).
 * ══════════════════════════════════════════════════════════════════════════
 */
export const T1_RULE_PREDICATES: ReadonlyArray<{ file: string; fn: string }> = [
  { file: 'src/services/ai/source-analysis/source-units/historical-reassessment.ts', fn: 'alertDecisionOf' },
  { file: 'src/services/ai/source-analysis/source-units/historical-reassessment.ts', fn: 'reassessmentOutcomeOf' },
  { file: 'src/services/ai/source-analysis/source-units/historical-reassessment.ts', fn: 'reassessmentCompletionOf' },
  { file: 'src/services/ai/source-analysis/source-units/historical-reassessment.ts', fn: 'refusExplicite' },
  { file: 'src/services/ai/source-analysis/source-units/retry-policy.ts', fn: 'retryFactsOf' },
  { file: 'src/services/ai/source-analysis/source-units/retry-policy.ts', fn: 'decideRetry' },
  { file: 'src/services/ai/source-analysis/source-units/retry-policy.ts', fn: 'decideRequeueRight' },
  { file: 'src/services/ai/source-analysis/source-units/retry-policy.ts', fn: 'decideRequeueAdmission' },
  { file: 'src/services/ai/source-analysis/source-units/retry-policy.ts', fn: 'releaseUnschedulablePending' },
  { file: 'src/services/ai/source-analysis/source-units/retry-policy.ts', fn: 'settleLayerRetry' },
  { file: 'src/services/ai/source-analysis/source-units/coverage-issue.ts', fn: 'coverageIssueOf' },
  { file: 'src/services/ai/source-analysis/source-units/coverage-issue.ts', fn: 'scheduleAdmissible' },
  { file: 'src/services/ai/source-analysis/source-units/coverage-reconciliation.ts', fn: 'residualPolicyOf' },
  { file: 'src/services/ai/source-analysis/source-units/coverage.ts', fn: 'buildCompletenessReport' },
  { file: 'src/services/ai/source-analysis/source-units/verification-followup.ts', fn: 'verificationAutoRetryDue' },
  // Carte #853 : la couverture PAR OCCURRENCE est une condition d'état de couverture — sa logique est gardée.
  { file: 'src/services/ai/source-analysis/source-units/coverage-reconciliation.ts', fn: 'reconcileCoverage' },
];

/** Empreinte du code des prédicats, par version LIVRÉE (carte #837, C3). Recalculée par le test de livraison. */
export const T1_RULES_PREDICATE_SIGNATURES: Readonly<Record<number, string>> = {
  3: '7db94b50502681cdc57f0bd1ff56f58b',
  4: '512d0ef1dcdc018856d47db97eadce1b',
};

/** Empreinte des conditions d'alerte T1 en vigueur (pure, stable d'une exécution à l'autre). */
export function t1AlertConditionsSignature(): string {
  const parts = T1_ALERT_FAMILIES.map((f) => `${f.code}|${f.prefix}|${f.rechecked ? 1 : 0}|${[...f.covers].sort().join('~')}`).sort();
  return createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 32);
}

/**
 * États de qualité réévalués (carte § 4.1).
 * Carte #853 (R4, AC14) — règle complétée : `COMPLETE` est réévalué aussi. Un faux COVERED historique (contrôle par
 * valeur distincte, ligne de tableau non confrontée) se trouve précisément dans un document déclaré complet ; sans
 * IA, borné et journalisé par version comme le reste du stock — un document resté COMPLETE est `UNCHANGED`.
 */
export const REASSESSED_QUALITY_STATES = ['COMPLETE', 'COMPLETE_WITH_UNRESOLVED', 'VERIFICATION_INCOMPLETE', 'INCOMPLETE_RETRYABLE', 'INCOMPLETE_FINAL'] as const;

/** Essais au plus d'un document en erreur, par version. */
export const REASSESSMENT_MAX_ATTEMPTS = 3;
const DEFAULT_BATCH = 100;
/** Fenêtre (minutes) autour de l'échéance pendant laquelle la tâche de reprise peut tenir le document (bail de 30 min). */
const RETRY_ACTIVITY_WINDOW_MINUTES = 31;

type Row = Record<string, unknown>;
type Env = Record<string, string | undefined>;

/**
 * Lot 115H (#785, § 3 et § 4) — deux issues NON TERMINALES s'ajoutent :
 *   `UNCONFIRMED` le traitement n'est PAS journalisé comme achevé : l'action
 *                 décidée n'a pas été retrouvée persistée, et il n'y a ni refus
 *                 explicite reprenable ni absence d'action justifiée. Le
 *                 document est repris au passage suivant (bornée) ;
 *   `DEFERRED`    report explicite et IDENTIFIABLE (compte temporairement
 *                 exclu, analyse en cours, reprise planifiée imminente, couche
 *                 écrite par un autre pendant le recalcul) — réarmé dès que la
 *                 cause disparaît, sans attendre un redémarrage.
 * Toutes deux comptent comme « encore à traiter » pour la campagne.
 */
export type ReassessmentOutcome = 'RESOLVED' | 'RECONCILED' | 'REPAIR_SCHEDULED' | 'STILL_UNRESOLVED' | 'UNVERIFIABLE' | 'FINAL_GAP' | 'UNCHANGED' | 'ERROR'
  | 'UNCONFIRMED' | 'DEFERRED';

/** Issues qui NE closent PAS le document pour la version des règles (il est repris). */
export const NON_TERMINAL_OUTCOMES = ['ERROR', 'UNCONFIRMED', 'DEFERRED'] as const;

/** État d'une couverture consigné au journal (compteurs et codes — jamais de contenu). */
export interface CoverageSnapshot {
  qualityState: string; anomalies: string[];
  covered: number; unresolved: number; uncertain: number; failed: number; total: number;
  retryAttempts: number; retryScheduled: boolean; lastRetryResult: string | null;
}

export type AlertAction = 'CLOSED' | 'MAINTAINED' | 'OPENED';
export interface AlertDecision { fingerprint: string; anomalyId: number | null; action: AlertAction; cause: string }

/**
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 115H (Trello #785, § 6) — INVENTAIRE DES FAMILLES D'ALERTES T1
 * RÉELLEMENT PRODUITES
 *
 * Règle complétée : le recontrôle ne portait que sur `ai:t1-completeness:*` et
 * `ai:t1-normalisation-loss:*`. Les refus de remise en file
 * (`ai:t1-requeue:*`, produits par `jobs.ts`) restaient ouverts indéfiniment,
 * y compris après une mise en file confirmée — et personne ne pouvait dire
 * quelles familles étaient couvertes.
 *
 * L'inventaire ci-dessous est la liste des familles effectivement produites
 * par les conditions T1 de ce périmètre, avec, pour chacune, si la campagne la
 * RECONTRÔLE et, sinon, POURQUOI. Un test de livraison le confronte aux
 * empreintes réellement écrites par le code : une famille nouvelle ne peut pas
 * être oubliée.
 *
 * Les familles non recontrôlées ici ne sont pas « ignorées » : elles ont un
 * propriétaire nommé, qui applique ses propres règles de clôture. Aucun
 * nettoyage aveugle, dans aucun cas.
 * ══════════════════════════════════════════════════════════════════════════
 */
export type T1AlertFamilyCode = 'COMPLETENESS' | 'NORMALISATION_LOSS' | 'REQUEUE_REFUSAL';

export interface T1AlertFamily {
  code: T1AlertFamilyCode;
  prefix: string;
  /** Libellé administrateur (texte nouveau — à valider par le PO). */
  label: string;
  /** La campagne de réévaluation recontrôle-t-elle cette famille sur l'état recalculé ? */
  rechecked: boolean;
  /** Ce que la condition couvre (complétude, réparation épuisée, pages non vérifiées…). */
  covers: readonly string[];
}

export const T1_ALERT_FAMILIES: readonly T1AlertFamily[] = [
  {
    code: 'COMPLETENESS', prefix: 'ai:t1-completeness:', rechecked: true,
    label: 'Analyse T1 définitivement incomplète',
    covers: ['complétude', 'réparation épuisée', 'réparation en attente', 'pages ou couverture non vérifiées', 'pages manquantes'],
  },
  {
    code: 'NORMALISATION_LOSS', prefix: 'ai:t1-normalisation-loss:', rechecked: true,
    label: 'Perte de normalisation non compensée',
    covers: ['perte de normalisation'],
  },
  {
    code: 'REQUEUE_REFUSAL', prefix: 'ai:t1-requeue:', rechecked: true,
    label: 'Relecture T1 non mise en file',
    covers: ['refus de remise en file (définitif ou transitoire répété)'],
  },
];

/**
 * Familles d'alertes liées à T1 mais produites AILLEURS, avec leur
 * propriétaire : la campagne ne les touche pas (lot 115H, § 6). Documenté pour
 * que « non recontrôlé ici » ne se confonde jamais avec « oublié ».
 */
export const T1_ALERT_FAMILIES_OUT_OF_SCOPE: ReadonlyArray<{ prefix: string; owner: string; why: string }> = [
  {
    prefix: 'coherence:', owner: 'src/services/coherence/registry',
    why: 'constats de cohérence : leurs conditions, leurs preuves et leur clôture appartiennent au contrôle de cohérence, qui les rejoue à son propre passage.',
  },
];

/** Issue de la réévaluation, depuis l'avant / après (pure, testée). */
export function reassessmentOutcomeOf(p: {
  before: CoverageSnapshot; after: CoverageSnapshot; requalified: number; written: boolean;
}): ReassessmentOutcome {
  const { before, after } = p;
  // Carte #853 : un document déjà COMPLETE, confirmé tel quel, n'est pas « résolu » par la campagne.
  if (after.qualityState === 'COMPLETE') return before.qualityState === 'COMPLETE' && !p.written && p.requalified === 0 ? 'UNCHANGED' : 'RESOLVED';
  if (after.qualityState === 'INCOMPLETE_FINAL') return before.qualityState === 'INCOMPLETE_FINAL' && !p.written ? 'UNCHANGED' : 'FINAL_GAP';
  if (after.qualityState === 'INCOMPLETE_RETRYABLE') return after.retryScheduled ? 'REPAIR_SCHEDULED' : 'STILL_UNRESOLVED';
  const identique = !p.written && before.qualityState === after.qualityState && before.retryScheduled === after.retryScheduled
    && before.anomalies.join('|') === after.anomalies.join('|');
  if (identique) return 'UNCHANGED';
  if (p.requalified > 0) return 'RECONCILED';
  return after.qualityState === 'VERIFICATION_INCOMPLETE' ? 'UNVERIFIABLE' : 'STILL_UNRESOLVED';
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 115H (Trello #785, § 3) — « ACHEVÉ » N'EST JOURNALISÉ QU'AVEC UNE ACTION
 * RÉELLEMENT PERSISTÉE ET CONFIRMÉE
 *
 * Règle complétée : le journal consignait l'issue calculée par le code, sans
 * jamais vérifier que ce qui avait été DÉCIDÉ était bien EN BASE. Un document
 * dont l'échéance n'avait pas pu être posée, ou dont l'état n'avait pas été
 * écrit, était pourtant marqué « traité pour la version » — donc jamais
 * repris, et la campagne le comptait comme un succès.
 *
 * Un traitement n'est désormais journalisé comme achevé que dans trois cas,
 * et seulement eux :
 *   1. l'action décidée est PERSISTÉE et CONFIRMÉE : l'état de qualité et la
 *      présence (ou l'absence) d'échéance relus en base sont exactement ceux
 *      que le recalcul a décidés ;
 *   2. un REFUS EXPLICITE REPRENABLE est constaté (remise en file refusée pour
 *      une cause transitoire, compte non éligible…) : la cause est nommée et le
 *      document repartira de lui-même ;
 *   3. l'ABSENCE d'action est JUSTIFIÉE : aucune action n'était admissible, et
 *      le motif est connu (plafond, rien à reprendre, limite de vérification).
 * Sinon : `UNCONFIRMED` — le document reste à traiter, dans ses bornes.
 * Fonction PURE.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function reassessmentCompletionOf(p: {
  /** Issue de la réconciliation enregistrée. */
  reconciliation: 'APPLIED' | 'SIMULATED' | 'UNCHANGED' | 'NO_LAYER' | 'CONFLICT_DEFERRED';
  /** Échéance DÉCIDÉE par le recalcul, et échéance réellement présente en base après écriture. */
  scheduledDecided: boolean; scheduledPersisted: boolean;
  /** État de qualité DÉCIDÉ et état relu en base (`null` : non relisible). */
  qualityDecided: string | null; qualityPersisted: string | null;
  /** Refus explicite reprenable constaté (code), ou `null`. */
  explicitRefusal: string | null;
  /** Motif d'absence d'action automatique admissible (`RetryBlock`), ou `null` si une action l'était. */
  noActionReason: string | null;
}): { complete: boolean; reason: string } {
  if (p.reconciliation === 'CONFLICT_DEFERRED') {
    return { complete: false, reason: 'couche réécrite par un autre traitement pendant le recalcul — rien n’a été écrit' };
  }
  if (p.reconciliation === 'NO_LAYER') return { complete: true, reason: 'aucune couche A : absence d’action justifiée' };
  if (p.explicitRefusal) return { complete: true, reason: `refus explicite reprenable : ${p.explicitRefusal}` };
  if (p.qualityPersisted === null) return { complete: false, reason: 'état de la couverture non relisible après écriture' };
  // L'action décidée doit être RETROUVÉE en base : l'état ET l'échéance.
  if (p.qualityDecided !== null && p.qualityPersisted !== p.qualityDecided) {
    return { complete: false, reason: `état décidé ${p.qualityDecided} absent en base (trouvé ${p.qualityPersisted})` };
  }
  if (p.scheduledDecided !== p.scheduledPersisted) {
    return {
      complete: false,
      reason: p.scheduledDecided ? 'reprise décidée mais aucune échéance persistée' : 'aucune reprise décidée mais une échéance subsiste',
    };
  }
  if (p.scheduledDecided) return { complete: true, reason: 'action persistée et confirmée : échéance de reprise en base' };
  if (p.noActionReason) return { complete: true, reason: `absence d’action justifiée : ${p.noActionReason}` };
  return { complete: true, reason: 'état recalculé persisté et confirmé, aucune action à programmer' };
}

/**
 * Décision sur UNE alerte T1 de couverture, depuis l'état COURANT (pure, testée).
 * `null` : rien à faire (aucune alerte ouverte et aucune cause).
 */
export function alertDecisionOf(p: {
  kind: T1AlertFamilyCode; open: boolean;
  /** Document supprimé (ou introuvable). */
  deleted: boolean;
  /** Couverture courante ; null : aucune couche A. */
  qualityState: string | null; normalisationLosses: number | null;
  rulesVersion: number;
  /**
   * Lot 115H (#785, § 6) : dernier résultat de reprise et présence d'une
   * échéance — ce qui décide de la famille `REQUEUE_REFUSAL`. Une réparation
   * PROGRAMMÉE n'est pas une réparation ACCOMPLIE : elle ne clôt rien.
   */
  lastRetryResult?: string | null;
  retryScheduled?: boolean;
}): { action: AlertAction; cause: string } | null {
  const v = `règles T1 v${p.rulesVersion}`;
  if (p.deleted) return p.open ? { action: 'CLOSED', cause: `${v} : document supprimé — plus d’objet à réparer` } : null;
  // Sans couverture lisible, la cause ne peut pas être vérifiée : l'alerte est conservée.
  if (p.qualityState === null) return p.open ? { action: 'MAINTAINED', cause: `${v} : couverture absente — cause non vérifiable` } : null;
  if (p.kind === 'REQUEUE_REFUSAL') {
    if (!p.open) return null;
    // La cause de cette alerte est un REFUS de remise en file. Elle ne se clôt que sur une remise en file
    // RÉELLEMENT confirmée (ou une absence de refus), jamais sur une simple reprise programmée.
    const refus = p.lastRetryResult ?? null;
    if (refus === 'REQUEUE_REJECTED_FINAL') return { action: 'MAINTAINED', cause: `${v} : remise en file T1 toujours refusée (définitif)` };
    if (refus === 'REQUEUE_REJECTED_TRANSIENT') return { action: 'MAINTAINED', cause: `${v} : remise en file T1 refusée (transitoire) — refus non levé` };
    if (refus === 'REQUEUE_ACCOUNT_NOT_ELIGIBLE') return { action: 'MAINTAINED', cause: `${v} : compte non éligible au traitement — refus non levé` };
    if (refus && refus.startsWith('REQUEUE_NOT_ADMISSIBLE:')) {
      return { action: 'MAINTAINED', cause: `${v} : demande refusée par la règle des reprises (${refus.slice('REQUEUE_NOT_ADMISSIBLE:'.length)})` };
    }
    return { action: 'CLOSED', cause: `${v} : plus aucun refus de remise en file sur ce document (dernier résultat : ${refus ?? 'aucun'})` };
  }
  if (p.kind === 'COMPLETENESS') {
    if (p.qualityState === 'INCOMPLETE_FINAL') {
      return p.open ? { action: 'MAINTAINED', cause: `${v} : lacune réelle sans reprise admissible (INCOMPLETE_FINAL)` }
        : { action: 'OPENED', cause: `${v} : lacune réelle sans reprise admissible, non signalée jusqu’ici` };
    }
    return p.open ? { action: 'CLOSED', cause: `${v} : état recalculé ${p.qualityState} — l’analyse n’est plus définitivement incomplète` } : null;
  }
  // Perte de normalisation : compteur absent des diagnostics = non vérifiable, l'alerte est conservée.
  if (p.normalisationLosses === null) return p.open ? { action: 'MAINTAINED', cause: `${v} : diagnostics absents — cause non vérifiable` } : null;
  if (p.normalisationLosses > 0) return p.open ? { action: 'MAINTAINED', cause: `${v} : ${p.normalisationLosses} perte(s) de normalisation non compensée(s)` } : null;
  return p.open ? { action: 'CLOSED', cause: `${v} : aucune perte de normalisation dans la couverture courante` } : null;
}

/** Document visé par une empreinte d'alerte T1 de couverture (pure) ; null : autre empreinte. */
export function alertTargetOf(fingerprint: string): { kind: T1AlertFamilyCode; fileId: number } | null {
  for (const famille of T1_ALERT_FAMILIES) {
    if (!fingerprint.startsWith(famille.prefix)) continue;
    const n = Number(fingerprint.slice(famille.prefix.length));
    if (Number.isSafeInteger(n) && n > 0) return { kind: famille.code, fileId: n };
  }
  return null;
}

export interface ReassessmentPassResult {
  rulesVersion: number;
  /** Documents examinés pendant ce passage, par issue. */
  examined: number;
  byOutcome: Partial<Record<ReassessmentOutcome, number>>;
  /** Documents laissés au passage suivant (reprise planifiée, analyse en cours, compte exclu, conflit d'écriture). */
  deferred: number;
  /** Lot 115H (#785, § 5) : reports par CAUSE — le travail différé est identifiable, jamais invisible. */
  deferredByCause: Record<string, number>;
  /** Lot 115H (#785, § 3) : documents dont le traitement n'a PAS été journalisé comme achevé (repris). */
  unconfirmed: number;
  /** Lot 115H (#785, § 4) : réservations de reprise orphelines rendues / confirmées avant le parcours. */
  reservationsRecovered: number;
  reservationsConfirmed: number;
  /** Lot 115H (#785, § 5) : la fin du stock a été atteinte pendant ce passage (le curseur repart à zéro). */
  fullCycle: boolean;
  /** Carte #837 (C1) : documents contrôlés dont l'empreinte EXHAUSTIVE des preuves est inchangée (aucun rejeu, aucune écriture). */
  unchangedEvidence: number;
  /** Carte #837 (C1) : documents à issue terminale dont l'empreinte a été recalculée par le balayage permanent. */
  evidenceChecked: number;
  /** … dont l'empreinte avait CHANGÉ (preuve nouvelle sans réécriture de la couverture) : réévalués. */
  evidenceChanged: number;
  /** Le balayage des empreintes a atteint la fin du stock pendant ce passage. */
  evidenceSweepComplete: boolean;
  /** Carte #837 (B1) : restitutions de droit CONFIRMÉES en base par la récupération des réservations. */
  reservationsRestituted: number;
  errors: number;
  alertsClosed: number; alertsMaintained: number; alertsOpened: number;
  /** Alertes sans document éligible examinées (document supprimé, couverture complète…). */
  orphanAlertsExamined: number;
  /** Reprises ciblées programmées / échéances retirées par le recalcul. */
  retriesScheduled: number; retriesCancelled: number;
  /** Appels IA de la campagne : toujours 0 (aucun chemin de ce module n'appelle un modèle). */
  aiCalls: 0;
  durationMs: number;
  more: boolean;
  /** Motif d'inactivité (schéma absent) ; absent : campagne exécutée. */
  disabled?: string;
}

function batchSize(env: Env = process.env): number {
  const n = Number(env.T1_REASSESSMENT_BATCH);
  return env.T1_REASSESSMENT_BATCH !== undefined && env.T1_REASSESSMENT_BATCH.trim() !== '' && Number.isFinite(n)
    ? Math.min(500, Math.max(1, Math.trunc(n))) : DEFAULT_BATCH;
}

let journal1705: { ready: boolean; at: number } | null = null;

/** Journal 1705 présent ? Ne lève jamais. */
export async function reassessmentJournalReady(): Promise<boolean> {
  if (journal1705 && Date.now() - journal1705.at < 30_000) return journal1705.ready;
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(`SELECT to_regclass('t1_coverage_reassessments') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    journal1705 = { ready: r[0]?.ok === true, at: Date.now() };
  } catch {
    journal1705 = { ready: false, at: Date.now() };
  }
  return journal1705.ready;
}

const liste = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function snapshotOf(c: Row | null | undefined): CoverageSnapshot | null {
  if (!c) return null;
  return {
    qualityState: String(c.qualityState), anomalies: liste(c.anomalies).sort(),
    covered: Number(c.coveredUnits ?? 0), unresolved: Number(c.unresolvedUnits ?? 0), uncertain: Number(c.uncertainUnits ?? 0),
    failed: Number(c.failedUnits ?? 0), total: Number(c.totalSourceUnits ?? 0),
    retryAttempts: Number(c.retryAttempts ?? 0), retryScheduled: c.nextRetryAt !== null && c.nextRetryAt !== undefined,
    lastRetryResult: c.lastRetryResult == null ? null : String(c.lastRetryResult),
  };
}

/** Pertes de normalisation des diagnostics ; null : compteur absent (non vérifiable). */
function lossesOf(verification: unknown): number | null {
  const d = (typeof verification === 'string' ? JSON.parse(verification) : verification) as { normalisationLosses?: unknown } | null;
  return d && typeof d.normalisationLosses === 'number' ? d.normalisationLosses : null;
}

/**
 * Applique la décision à UNE alerte (écriture). `CLOSED` : résolution
 * automatique historisée sur l'anomalie elle-même (origine, cause, date) ;
 * l'anomalie et ses occurrences restent consultables.
 */
async function applyAlertDecision(p: {
  accountId: number | null; fileId: number; kind: T1AlertFamilyCode; anomalyId: number | null;
  decision: { action: AlertAction; cause: string }; coverage: Row | null;
}): Promise<AlertDecision> {
  const famille = T1_ALERT_FAMILIES.find((f) => f.code === p.kind)!;
  const fingerprint = `${famille.prefix}${p.fileId}`;
  let anomalyId = p.anomalyId;
  if (p.decision.action === 'CLOSED') {
    const { autoResolveAnomaly } = await import('@/services/admin/anomaly.service');
    await autoResolveAnomaly(fingerprint, { origin: `t1_coverage_reassessment:v${T1_COVERAGE_RULES_VERSION}`, cause: p.decision.cause });
  } else if (p.decision.action === 'OPENED' && p.coverage && p.accountId !== null) {
    const { reportT1IncompleteFinal } = await import('./monitoring');
    anomalyId = await reportT1IncompleteFinal({
      accountId: p.accountId, fileId: p.fileId, persisted: true,
      report: {
        qualityState: 'INCOMPLETE_FINAL', anomalies: liste(p.coverage.anomalies), coverageRatio: Number(p.coverage.coverageRatio ?? 0),
        failedUnits: Number(p.coverage.failedUnits ?? 0), truncatedSectionsCount: Number(p.coverage.truncatedSectionsCount ?? 0),
        droppedFactsCount: Number(p.coverage.droppedFactsCount ?? 0),
      },
    });
  }
  return { fingerprint, anomalyId, action: p.decision.action, cause: p.decision.cause };
}

/** Alertes T1 de couverture OUVERTES d'un document : empreinte → identifiant. */
async function openAlertsOf(fileId: number): Promise<Map<string, number>> {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT id, fingerprint FROM admin_anomalies WHERE status = 'open' AND fingerprint = ANY($1::text[])`,
    [T1_ALERT_FAMILIES.map((f) => `${f.prefix}${fileId}`)] as never[],
  )) as unknown as Array<{ id: number; fingerprint: string }>;
  return new Map(rows.map((r) => [String(r.fingerprint), Number(r.id)]));
}

/**
 * Décide et applique les alertes de TOUTES les familles traitées du document,
 * sur l'état RECALCULÉ (lot 115H, § 6). Aucun nettoyage aveugle : chaque
 * décision est prise famille par famille, avec sa cause.
 */
async function decideDocumentAlerts(p: {
  accountId: number; fileId: number; after: CoverageSnapshot; coverage: Row | null;
}): Promise<AlertDecision[]> {
  const ouvertes = await openAlertsOf(p.fileId);
  const alerts: AlertDecision[] = [];
  for (const famille of T1_ALERT_FAMILIES) {
    if (!famille.rechecked) continue;
    const fp = `${famille.prefix}${p.fileId}`;
    const decision = alertDecisionOf({
      kind: famille.code, open: ouvertes.has(fp), deleted: false, qualityState: p.after.qualityState,
      normalisationLosses: lossesOf(p.coverage?.verification ?? null),
      lastRetryResult: p.after.lastRetryResult, retryScheduled: p.after.retryScheduled,
      rulesVersion: T1_COVERAGE_RULES_VERSION,
    });
    if (decision) {
      alerts.push(await applyAlertDecision({
        accountId: p.accountId, fileId: p.fileId, kind: famille.code, anomalyId: ouvertes.get(fp) ?? null, decision, coverage: p.coverage,
      }));
    }
  }
  return alerts;
}

// ── Lot 115H (#785, § 3, § 4, § 5) : empreinte, bail, refus explicite ───────

/**
 * Empreinte des PREUVES confrontées (lot 115H, § 5) — la même que celle des
 * demandes de reprise (`requeueEvidenceFingerprint`) : une seule définition.
 * Une preuve nouvelle la change même à version de règle constante.
 */
async function evidenceFingerprintOf(accountId: number, fileId: number, cov: Row): Promise<{ fingerprint: string; sourceSha: string | null }> {
  const { requeueEvidenceFingerprint } = await import('./requeue-identity');
  // Carte #837 (C2) : TOUTES les dépendances lues (faits, décisions, candidats, tableaux, ancrages, extraction, texte
  // original), versionnées — une modification qui laisse les compteurs égaux change l'empreinte.
  const { loadEvidenceDependencies } = await import('./evidence-version');
  const { pgClient: client } = await import('@/db');
  const dependances = await loadEvidenceDependencies(client as never, accountId, fileId);
  const d = (typeof cov.verification === 'string' ? JSON.parse(cov.verification) : cov.verification) as Record<string, unknown> | null;
  let sha: string | null = null;
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(
      `SELECT source_sha256 FROM document_raw_extracts WHERE file_id = $1 AND account_id = $2`,
      [fileId, accountId] as never[],
    )) as unknown as Array<{ source_sha256: string | null }>;
    sha = r[0]?.source_sha256 ?? null;
  } catch { /* extraction brute absente : l'empreinte reste calculable sans elle */ }
  const pages = Array.isArray(d?.pagesMissing) ? (d!.pagesMissing as unknown[]).map(Number) : [];
  const rev = (d?.reverification as { fingerprint?: unknown } | undefined)?.fingerprint;
  const fingerprint = requeueEvidenceFingerprint({
    qualityState: cov.qualityState == null ? null : String(cov.qualityState),
    anomalies: liste(cov.anomalies),
    verificationReason: typeof d?.verificationReason === 'string' ? d.verificationReason : null,
    sourceVerification: cov.sourceVerification == null ? null : String(cov.sourceVerification),
    pagesMissing: pages,
    unresolvedUnits: Number(cov.unresolvedUnits ?? 0), uncertainUnits: Number(cov.uncertainUnits ?? 0),
    failedUnits: Number(cov.failedUnits ?? 0),
    reverificationFingerprint: typeof rev === 'string' ? rev : null,
    sourceSha256: sha, layerVersion: Number(cov.layerVersion ?? 0),
    dependencies: dependances.fingerprint,
  });
  return { fingerprint, sourceSha: sha };
}

/** Libère le bail du document et consigne la cause du report (jamais bloquant). */
async function libererBail(p: { accountId: number; fileId: number }, avecBail: boolean, cause: string, owner: string): Promise<void> {
  if (!avecBail) return;
  try {
    const { pgClient } = await import('@/db');
    // Carte #837 (B3) : seul le TITULAIRE du bail (jeton unique) peut le libérer — jamais un ancien titulaire.
    await pgClient.unsafe(
      `UPDATE t1_coverage_reassessments
          SET lease_owner = NULL, lease_expires_at = NULL, outcome = 'DEFERRED', deferred_cause = $4, updated_at = NOW()
        WHERE file_id = $1 AND account_id = $2 AND rules_version = $3 AND lease_owner = $5`,
      [p.fileId, p.accountId, T1_COVERAGE_RULES_VERSION, cause, owner] as never[],
    );
  } catch (e) {
    console.warn(`[t1-coverage-reassessment] bail du document ${p.fileId} non libéré (non bloquant) :`, (e as Error).message);
  }
}

/**
 * REFUS EXPLICITE REPRENABLE lu sur la couverture (lot 115H, § 3). Un refus de
 * cette nature est une issue ACHEVÉE et honnête : la cause est nommée et le
 * document repartira de lui-même. `null` : aucun refus de ce genre.
 */
export function refusExplicite(lastRetryResult: string | null): string | null {
  if (!lastRetryResult) return null;
  if (lastRetryResult.startsWith('REQUEUE_NOT_ADMISSIBLE:')) return lastRetryResult;
  const reprenables = ['REQUEUE_ACCOUNT_NOT_ELIGIBLE', 'REQUEUE_REJECTED_TRANSIENT', 'REQUEUE_ALREADY_SATISFIED'];
  return reprenables.includes(lastRetryResult) ? lastRetryResult : null;
}

export interface DocumentReassessment {
  fileId: number; accountId: number; outcome: ReassessmentOutcome;
  before: CoverageSnapshot | null; after: CoverageSnapshot | null; alerts: AlertDecision[];
  detail: Record<string, unknown>; durationMs: number; error?: string;
  /** Lot 115H (#785, § 5) : cause d'un report explicite (`DEFERRED`). */
  deferredCause?: string;
  /** Lot 115H (#785, § 5) : empreinte des preuves confrontées. */
  evidenceFingerprint?: string | null;
  /** Lot 115H (#785, § 4) : étapes acquises (reprise après panne entre deux écritures). */
  steps?: ReassessmentSteps;
}

/** Étapes acquises d'un document (lot 115H, § 4) — jamais effacées, cumulées. */
export interface ReassessmentSteps {
  reverified?: boolean;
  reconciled?: boolean;
  alerted?: boolean;
}

/** Durée de la RÉSERVATION d'un document par la campagne (minutes). */
export const REASSESSMENT_LEASE_MINUTES = 10;

let colonnes1805: { ready: boolean; at: number } | null = null;

/** Colonnes de la migration 1805 sur le journal 1705 (bail, étapes, empreinte) ? Ne lève jamais. */
export async function reassessmentLeaseReady(): Promise<boolean> {
  if (colonnes1805 && Date.now() - colonnes1805.at < 30_000) return colonnes1805.ready;
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name = 't1_coverage_reassessments'
          AND column_name IN ('lease_owner', 'lease_expires_at', 'steps', 'evidence_fingerprint', 'deferred_cause')`,
    )) as unknown as Array<{ n: number }>;
    colonnes1805 = { ready: Number(r[0]?.n ?? 0) >= 5, at: Date.now() };
  } catch {
    colonnes1805 = { ready: false, at: Date.now() };
  }
  return colonnes1805.ready;
}

/** Remise à zéro des mémoires de présence de schéma (tests). */
export function resetReassessmentSchemaCache(): void {
  colonnes1805 = null;
  journal1705 = null;
}

const etapesDe = (v: unknown): ReassessmentSteps => {
  const o = (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return {};
  const out: ReassessmentSteps = {};
  for (const k of ['reverified', 'reconciled', 'alerted'] as const) if (o[k] === true) out[k] = true;
  return out;
};

/**
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 115H (Trello #785, § 4) — RÉSERVATION DU DOCUMENT PAR LA CAMPAGNE, ET
 * ÉTAPES ACQUISES
 *
 * Règle complétée : la campagne enchaînait re-vérification, réconciliation,
 * alertes puis journal SANS réservation propre au document, et la fenêtre de
 * `next_retry_at` n'est pas un verrou. Deux campagnes (deux instances, un
 * passage manuel du BO pendant le passage planifié) pouvaient donc traiter le
 * même document en même temps, et un arrêt entre deux étapes laissait le
 * document sans aucune trace de ce qui était acquis.
 *
 * La ligne de journal est maintenant posée AVANT toute écriture, avec l'état
 * AVANT initial, l'empreinte des preuves et un BAIL : une seule campagne tient
 * le document ; chaque étape franchie y est consignée ; une reprise après panne
 * repart de l'étape suivante, sans refaire ce qui est acquis ni consommer deux
 * fois. Un bail expiré est repris (aucun document bloqué).
 *
 * `null` : le document est tenu par une AUTRE campagne — il est différé.
 * ══════════════════════════════════════════════════════════════════════════
 */
async function reserverDocument(p: {
  accountId: number; fileId: number; owner: string; fingerprint: string; before: CoverageSnapshot | null;
}): Promise<{ steps: ReassessmentSteps; rawSteps: Record<string, unknown>; stateBefore: CoverageSnapshot | null } | null> {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `INSERT INTO t1_coverage_reassessments
       (account_id, file_id, rules_version, outcome, state_before, state_after, evidence_fingerprint, steps, lease_owner, lease_expires_at)
     VALUES ($1, $2, $3, 'UNCONFIRMED', $4::jsonb, '{}'::jsonb, $5, '{}'::jsonb, $6, NOW() + make_interval(mins => $7))
     ON CONFLICT (file_id, rules_version) DO UPDATE SET
       lease_owner = EXCLUDED.lease_owner, lease_expires_at = EXCLUDED.lease_expires_at,
       -- Preuves CHANGÉES : nouveau cycle (avant initial et étapes repartent) ; preuves identiques : étapes acquises conservées.
       state_before = CASE WHEN t1_coverage_reassessments.evidence_fingerprint IS DISTINCT FROM EXCLUDED.evidence_fingerprint
                             THEN EXCLUDED.state_before ELSE t1_coverage_reassessments.state_before END,
       steps = CASE WHEN t1_coverage_reassessments.evidence_fingerprint IS DISTINCT FROM EXCLUDED.evidence_fingerprint
                      THEN '{}'::jsonb ELSE t1_coverage_reassessments.steps END,
       evidence_fingerprint = EXCLUDED.evidence_fingerprint,
       attempts = t1_coverage_reassessments.attempts + 1, updated_at = NOW()
     -- Carte #837 (B3) : bail STRICTEMENT exclusif — le titulaire est un jeton UNIQUE par exécution et par document ;
     -- plus de reprise « par le même propriétaire » (deux campagnes du même processus partageaient l'identité).
     WHERE t1_coverage_reassessments.lease_owner IS NULL
        OR t1_coverage_reassessments.lease_expires_at IS NULL
        OR t1_coverage_reassessments.lease_expires_at < NOW()
     RETURNING state_before, steps`,
    [p.accountId, p.fileId, T1_COVERAGE_RULES_VERSION, JSON.stringify(p.before ?? {}), p.fingerprint, p.owner, REASSESSMENT_LEASE_MINUTES] as never[],
  )) as unknown as Row[];
  if (!rows[0]) return null;
  const initial = (typeof rows[0].state_before === 'string' ? JSON.parse(rows[0].state_before) : rows[0].state_before) as CoverageSnapshot | null;
  const brutes = (typeof rows[0].steps === 'string' ? JSON.parse(rows[0].steps) : rows[0].steps) as Record<string, unknown> | null;
  return {
    steps: etapesDe(rows[0].steps),
    rawSteps: brutes && typeof brutes === 'object' ? brutes : {},
    stateBefore: initial && typeof initial === 'object' && 'qualityState' in initial ? initial : p.before,
  };
}

/**
 * Consigne une étape franchie (cumulative) ET renouvelle le bail — carte #837
 * (B3, B4) : écriture CONDITIONNÉE par le jeton du titulaire et un bail non
 * expiré (fencing), CONFIRMÉE par `RETURNING`. `false` : le bail est perdu (ou
 * l'écriture a échoué) — l'appelant s'arrête sans rien déclarer acquis.
 * `detail` : résultat de l'étape (réconciliation, alertes), relu à la reprise.
 */
async function marquerEtape(p: { accountId: number; fileId: number; steps: ReassessmentSteps & Record<string, unknown>; owner: string }): Promise<boolean> {
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(
      `UPDATE t1_coverage_reassessments
          SET steps = steps || $4::jsonb, lease_expires_at = NOW() + make_interval(mins => $6), updated_at = NOW()
        WHERE file_id = $1 AND account_id = $2 AND rules_version = $3 AND lease_owner = $5 AND lease_expires_at > NOW()
        RETURNING file_id`,
      [p.fileId, p.accountId, T1_COVERAGE_RULES_VERSION, JSON.stringify(p.steps), p.owner, REASSESSMENT_LEASE_MINUTES] as never[],
    )) as unknown as Row[];
    if (r.length === 0) console.warn(`[t1-coverage-reassessment] document ${p.fileId} : bail perdu — étape non consignée, traitement arrêté.`);
    return r.length > 0;
  } catch (e) {
    console.error(`[t1-coverage-reassessment] étape du document ${p.fileId} non consignée :`, (e as Error).message);
    return false;
  }
}

/**
 * Réévalue UN document (voir l'en-tête) et journalise. Idempotente : rejouée
 * sur un document déjà à jour, elle n'écrit rien d'autre que le journal.
 * Sans appel IA. Ne lève pas : une erreur est journalisée (`ERROR`).
 *
 * Carte #837 :
 *   B3  le titulaire du bail est un JETON UNIQUE par exécution et par document
 *       (`owner` n'est plus qu'un libellé) ; chaque étape, la libération et la
 *       clôture du journal sont conditionnées par ce jeton et un bail vivant ;
 *       un bail perdu arrête le traitement (`DEFERRED` / `LEASE_LOST`), sans
 *       succès fictif ni réécriture par un ancien titulaire ;
 *   B4  une étape ACQUISE n'est jamais refaite : réconciliation et alertes
 *       relisent leur résultat consigné à la reprise ; une étape échouée
 *       n'est jamais marquée acquise ;
 *   C1  l'empreinte consignée au journal est celle des preuves APRÈS
 *       traitement : un document inchangé n'est pas rejoué (`SAME_EVIDENCE`),
 *       une preuve nouvelle — même sans réécriture de la couverture — l'est.
 */
export async function reassessDocumentCoverage(p: { accountId: number; fileId: number; owner?: string; campaignRef?: string }): Promise<DocumentReassessment> {
  const debut = Date.now();
  const { loadDocumentCoverage } = await import('./repository');
  const titulaire = `${p.owner ?? `t1-reassessment:${process.pid}`}#${randomUUID()}`;
  const ref = { accountId: p.accountId, fileId: p.fileId };
  let before: CoverageSnapshot | null = null;
  try {
    const cov0 = await loadDocumentCoverage(p.fileId, p.accountId);
    before = snapshotOf(cov0 as unknown as Row | null);
    if (!cov0 || !before) {
      return await journaliser({ ...ref, outcome: 'UNCHANGED', before: null, after: null, alerts: [], detail: { skipped: 'NO_COVERAGE' }, durationMs: Date.now() - debut });
    }
    const { fingerprint: empreinte, sourceSha } = await evidenceFingerprintOf(p.accountId, p.fileId, cov0 as unknown as Row);
    const avecBail = await reassessmentLeaseReady();
    if (avecBail) {
      // Confrontation RIGOUREUSEMENT IDENTIQUE (même version, même empreinte des preuves APRÈS le dernier traitement,
      // issue terminale) : jamais rejouée — ni écriture, ni journal (lot 115H § 5, carte #837 C1).
      const { pgClient } = await import('@/db');
      const [deja] = (await pgClient.unsafe(
        `SELECT outcome FROM t1_coverage_reassessments
          WHERE file_id = $1 AND account_id = $2 AND rules_version = $3 AND evidence_fingerprint = $4
            AND NOT (outcome = ANY($5::text[]))`,
        [p.fileId, p.accountId, T1_COVERAGE_RULES_VERSION, empreinte, [...NON_TERMINAL_OUTCOMES]] as never[],
      ).catch(() => [])) as unknown as Row[];
      if (deja) {
        return {
          ...ref, outcome: String(deja.outcome) as ReassessmentOutcome, before, after: before, alerts: [],
          detail: { skipped: 'SAME_EVIDENCE' }, durationMs: Date.now() - debut, evidenceFingerprint: empreinte, steps: {},
        };
      }
    }
    let steps: ReassessmentSteps = {};
    let acquis: Record<string, unknown> = {};
    const differe = (cause: string, extra: Record<string, unknown> = {}): DocumentReassessment => ({
      ...ref, outcome: 'DEFERRED', before, after: null, alerts: [], detail: { deferred: cause, ...extra },
      durationMs: Date.now() - debut, deferredCause: cause, evidenceFingerprint: empreinte, steps,
    });
    if (avecBail) {
      const reserve = await reserverDocument({ accountId: p.accountId, fileId: p.fileId, owner: titulaire, fingerprint: empreinte, before });
      if (!reserve) {
        console.info(`[t1-coverage-reassessment] fichier ${p.fileId} : tenu par une autre campagne — différé.`);
        return differe('LEASE_HELD');
      }
      steps = reserve.steps;
      acquis = reserve.rawSteps;
      if (reserve.stateBefore) before = reserve.stateBefore;
    }
    /** Étape consignée sous le jeton ; `false` : bail perdu → arrêt sans rien déclarer acquis. */
    const etape = async (s: ReassessmentSteps & Record<string, unknown>) => !avecBail || marquerEtape({ ...ref, steps: s, owner: titulaire });
    // 1. Re-vérification déterministe des pages — étape acquise d'un cycle interrompu → non refaite.
    const { reverificationDue, reverifyStoredCoverage } = await import('./stored-reverification');
    let reverification: Record<string, unknown> | null = null;
    if (!steps.reverified && reverificationDue({ qualityState: cov0.qualityState, verification: cov0.verification, sourceSha256: sourceSha })) {
      const rv = await reverifyStoredCoverage({ accountId: p.accountId, fileId: p.fileId, campaignRef: p.campaignRef ?? `t1-coverage-reassessment:v${T1_COVERAGE_RULES_VERSION}` });
      reverification = {
        result: rv.result, reason: rv.reason, qualityBefore: rv.qualityBefore, qualityAfter: rv.qualityAfter,
        pagesVerified: rv.pagesVerified?.length ?? 0, pagesMissing: rv.pagesMissing ?? [], pagesUnverifiable: rv.pagesUnverifiable?.length ?? 0,
        requeued: rv.requeued ?? false,
      };
    }
    if (!steps.reverified && !(await etape({ reverified: true, ...(reverification ? { reverification } : {}) }))) return differe('LEASE_LOST', { step: 'reverified' });
    if (steps.reverified && acquis.reverification && typeof acquis.reverification === 'object') reverification = acquis.reverification as Record<string, unknown>;
    // 2. Réconciliation sans IA et règle unique des reprises — carte #837 (B4) : étape ACQUISE → relue, jamais refaite.
    type Rec = Pick<Awaited<ReturnType<typeof import('./stored-reconciliation').reconcileStoredDocumentCoverage>>, 'outcome' | 'retry'> & {
      requalifiedCount: number; requalifiedByRule: Record<string, number>; afterQuality: string | null;
    };
    let rec: Rec;
    const consignee = acquis.reconciliation as Partial<Rec> | undefined;
    if (steps.reconciled && consignee && typeof consignee === 'object' && typeof consignee.outcome === 'string') {
      rec = {
        outcome: consignee.outcome, retry: consignee.retry, requalifiedCount: Number(consignee.requalifiedCount ?? 0),
        requalifiedByRule: (consignee.requalifiedByRule ?? {}) as Record<string, number>, afterQuality: consignee.afterQuality ?? null,
      };
    } else {
      const { reconcileStoredDocumentCoverage } = await import('./stored-reconciliation');
      const r = await reconcileStoredDocumentCoverage({
        accountId: p.accountId, fileId: p.fileId, apply: true, origin: p.campaignRef ?? `t1-coverage-reassessment:v${T1_COVERAGE_RULES_VERSION}`,
      });
      const parRegle: Record<string, number> = {};
      for (const q of r.requalified) parRegle[q.rule ?? 'unknown'] = (parRegle[q.rule ?? 'unknown'] ?? 0) + 1;
      rec = { outcome: r.outcome, retry: r.retry, requalifiedCount: r.requalified.length, requalifiedByRule: parRegle, afterQuality: r.after.qualityState };
      if (rec.outcome === 'CONFLICT_DEFERRED') {
        // Couche ou PREUVES plus récentes (analyse, reprise, BO, faits) : préservées, rien n'est écrit, report explicite.
        await libererBail(ref, avecBail, 'WRITE_CONFLICT', titulaire);
        return differe('WRITE_CONFLICT', { reconciliation: rec.outcome });
      }
      if (!(await etape({ reconciled: true, reconciliation: rec }))) return differe('LEASE_LOST', { step: 'reconciled' });
    }
    const cov1 = await loadDocumentCoverage(p.fileId, p.accountId);
    const after = snapshotOf(cov1 as unknown as Row | null) ?? before;
    // 3. Alertes de Supervision sur l'état RECALCULÉ — carte #837 (B4) : étape acquise → décisions relues, jamais rejouées.
    let alerts: AlertDecision[];
    if (steps.alerted && Array.isArray(acquis.alerts)) {
      alerts = acquis.alerts as AlertDecision[];
    } else {
      // Renouvellement ATOMIQUE du bail AVANT d'agir sur la Supervision : un titulaire expiré ne touche à aucune alerte.
      if (!(await etape({}))) return differe('LEASE_LOST', { step: 'before-alerts' });
      alerts = await decideDocumentAlerts({ accountId: p.accountId, fileId: p.fileId, after, coverage: cov1 as unknown as Row | null });
      if (!(await etape({ alerted: true, alerts }))) return differe('LEASE_LOST', { step: 'alerted', alerts });
    }
    const written = rec.outcome === 'APPLIED' || (reverification !== null && reverification.result !== 'SKIPPED');
    const confirmation = reassessmentCompletionOf({
      reconciliation: rec.outcome,
      scheduledDecided: rec.retry?.scheduledAfter ?? after.retryScheduled,
      scheduledPersisted: after.retryScheduled,
      qualityDecided: rec.outcome === 'UNCHANGED' ? null : rec.afterQuality,
      qualityPersisted: after.qualityState,
      explicitRefusal: refusExplicite(after.lastRetryResult),
      noActionReason: rec.retry?.blocked ?? null,
    });
    const outcome: ReassessmentOutcome = confirmation.complete
      ? reassessmentOutcomeOf({ before, after, requalified: rec.requalifiedCount, written })
      : 'UNCONFIRMED';
    if (!confirmation.complete) {
      console.warn(`[t1-coverage-reassessment] fichier ${p.fileId} : traitement NON journalisé comme achevé — ${confirmation.reason}`);
    }
    // Carte #837 (C1) : l'empreinte consignée est celle des preuves APRÈS traitement (sinon le recalcul lui-même
    // ferait « changer » le document et le ferait rejouer au passage suivant).
    const empreinteApres = cov1 ? (await evidenceFingerprintOf(p.accountId, p.fileId, cov1 as unknown as Row)).fingerprint : empreinte;
    return await journaliser({
      ...ref, outcome, before, after, alerts, durationMs: Date.now() - debut,
      evidenceFingerprint: empreinteApres, steps, owner: avecBail ? titulaire : undefined,
      detail: {
        reconciliation: rec.outcome, requalified: rec.requalifiedCount, requalifiedByRule: rec.requalifiedByRule,
        ...(rec.retry ? { retry: { pendingReleased: rec.retry.pendingReleased, actions: rec.retry.actions, blocked: rec.retry.blocked, scheduledBefore: rec.retry.scheduledBefore, scheduledAfter: rec.retry.scheduledAfter } } : {}),
        ...(reverification ? { reverification } : {}),
        completion: { complete: confirmation.complete, reason: confirmation.reason },
        evidenceBefore: empreinte,
        aiCalls: 0,
      },
    });
  } catch (e) {
    const error = String((e as Error).message ?? e).slice(0, 500);
    console.error(`[t1-coverage-reassessment] fichier ${p.fileId} :`, error);
    return journaliser({ ...ref, outcome: 'ERROR', before, after: null, alerts: [], detail: {}, durationMs: Date.now() - debut, error, owner: titulaire }).catch(() => ({
      ...ref, outcome: 'ERROR' as const, before, after: null, alerts: [], detail: {}, durationMs: Date.now() - debut, error,
    }));
  }
}

/**
 * Écrit (ou complète) la ligne de journal du document pour la version courante.
 *
 * Lot 115H (#785, § 3 et § 4) : la ligne existe déjà quand un bail a été pris
 * (l'avant INITIAL y a été consigné AVANT la première écriture) ; la clôture
 * n'écrase donc PAS `state_before`. Une ligne NON TERMINALE (erreur, non
 * confirmée, différée) peut être complétée au passage suivant.
 *
 * Carte #837 (B3) : avec bail, la clôture n'est écrite QUE par le titulaire
 * (jeton) d'un bail non expiré — ou, sans titulaire (report du parcours), sur
 * une ligne libre. Écriture refusée : le document est rendu `DEFERRED`
 * (`LEASE_LOST`), jamais un succès fictif.
 */
async function journaliser(r: DocumentReassessment & { owner?: string }): Promise<DocumentReassessment> {
  const { pgClient } = await import('@/db');
  const avecBail = await reassessmentLeaseReady();
  const colonnes = avecBail ? ', evidence_fingerprint, steps, deferred_cause, lease_owner, lease_expires_at' : '';
  const valeurs = avecBail ? ', $11, $12::jsonb, $13, NULL, NULL' : '';
  const majBail = avecBail
    ? `, evidence_fingerprint = EXCLUDED.evidence_fingerprint, steps = t1_coverage_reassessments.steps || EXCLUDED.steps,
         deferred_cause = EXCLUDED.deferred_cause, lease_owner = NULL, lease_expires_at = NULL`
    : '';
  // Fencing (carte #837, B3) : titulaire vivant, ou ligne libre / bail expiré pour une écriture sans titulaire.
  const garde = avecBail
    ? ` AND (CASE WHEN $15::text IS NOT NULL
                  THEN t1_coverage_reassessments.lease_owner = $15 AND t1_coverage_reassessments.lease_expires_at > NOW()
                  ELSE t1_coverage_reassessments.lease_owner IS NULL OR t1_coverage_reassessments.lease_expires_at IS NULL
                       OR t1_coverage_reassessments.lease_expires_at <= NOW() END)`
    : '';
  const params: unknown[] = [
    r.accountId, r.fileId, T1_COVERAGE_RULES_VERSION, r.outcome, JSON.stringify(r.before ?? {}), JSON.stringify(r.after ?? {}),
    JSON.stringify(r.alerts), JSON.stringify(r.detail), r.error ?? null, Math.max(0, Math.trunc(r.durationMs)),
  ];
  if (avecBail) params.push(r.evidenceFingerprint ?? null, JSON.stringify(r.steps ?? {}), r.deferredCause ?? null);
  // `state_before` n'est écrasé que s'il est vide : l'avant INITIAL du cycle est la référence.
  const lignes = (await pgClient.unsafe(
    `INSERT INTO t1_coverage_reassessments (account_id, file_id, rules_version, outcome, state_before, state_after, alerts, detail, error, duration_ms${colonnes})
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10${valeurs})
     ON CONFLICT (file_id, rules_version) DO UPDATE SET
       outcome = EXCLUDED.outcome,
       state_before = CASE WHEN t1_coverage_reassessments.state_before = '{}'::jsonb THEN EXCLUDED.state_before
                           ELSE t1_coverage_reassessments.state_before END,
       state_after = EXCLUDED.state_after, alerts = EXCLUDED.alerts,
       detail = EXCLUDED.detail, error = EXCLUDED.error, duration_ms = EXCLUDED.duration_ms,
       -- L'essai a DÉJÀ été compté par la réservation du document (lot 115H) : la clôture ne le compte pas deux fois.
       attempts = t1_coverage_reassessments.attempts${avecBail ? '' : ' + 1'}, updated_at = NOW()${majBail}
     WHERE (t1_coverage_reassessments.outcome = ANY($${avecBail ? 14 : 11}::text[])${avecBail && r.owner ? ' OR t1_coverage_reassessments.lease_owner = $15' : ''})${garde}
     RETURNING file_id`,
    [...params, [...NON_TERMINAL_OUTCOMES], ...(avecBail ? [r.owner ?? null] : [])] as never[],
  )) as unknown as Row[];
  if (avecBail && r.owner && Array.isArray(lignes) && lignes.length === 0 && r.outcome !== 'ERROR') {
    console.warn(`[t1-coverage-reassessment] document ${r.fileId} : bail perdu avant la clôture — issue ${r.outcome} NON journalisée (différé).`);
    return { ...r, outcome: 'DEFERRED', deferredCause: 'LEASE_LOST', detail: { ...r.detail, deferred: 'LEASE_LOST', intendedOutcome: r.outcome } };
  }
  return r;
}

// ── Lot 115H (#785, § 5) : points de reprise DURABLES de la campagne ────────

let curseurs1805: { ready: boolean; at: number } | null = null;

/** Table `t1_reassessment_cursors` présente ? Ne lève jamais. */
export async function reassessmentCursorsReady(): Promise<boolean> {
  if (curseurs1805 && Date.now() - curseurs1805.at < 30_000) return curseurs1805.ready;
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(`SELECT to_regclass('t1_reassessment_cursors') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    curseurs1805 = { ready: r[0]?.ok === true, at: Date.now() };
  } catch {
    curseurs1805 = { ready: false, at: Date.now() };
  }
  return curseurs1805.ready;
}

/** Natures de parcours bornées par un curseur durable. */
export type ReassessmentCursorKind = 'documents' | 'alerts' | 'evidence';

/**
 * Position de reprise du parcours. Sans elle, chaque passage repartait du DÉBUT
 * du stock : les éléments de fin n'étaient jamais atteints quand l'échéance du
 * passage tombait avant (famine). `0` : début du stock.
 */
async function lireCurseur(kind: ReassessmentCursorKind): Promise<number> {
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(
      `SELECT position FROM t1_reassessment_cursors WHERE rules_version = $1 AND kind = $2`,
      [T1_COVERAGE_RULES_VERSION, kind] as never[],
    )) as unknown as Array<{ position: number | string }>;
    return r[0] ? Math.max(0, Number(r[0].position)) : 0;
  } catch {
    return 0;
  }
}

/** Écrit la position de reprise (jamais bloquant). `cycle` : un tour complet vient d'être achevé. */
async function ecrireCurseur(kind: ReassessmentCursorKind, position: number, cycle: boolean): Promise<void> {
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `INSERT INTO t1_reassessment_cursors (rules_version, kind, position, cycles, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (rules_version, kind) DO UPDATE SET
         position = EXCLUDED.position,
         cycles = t1_reassessment_cursors.cycles + EXCLUDED.cycles,
         updated_at = NOW()`,
      [T1_COVERAGE_RULES_VERSION, kind, Math.max(0, Math.trunc(position)), cycle ? 1 : 0] as never[],
    );
  } catch (e) {
    console.warn(`[t1-coverage-reassessment] curseur « ${kind} » non écrit (non bloquant) :`, (e as Error).message);
  }
}

/**
 * UN PASSAGE de la campagne (tâche `t1-coverage-reassessment`). Voir l'en-tête.
 * `accountId` : passage limité à un compte (tests, diagnostic).
 */
export async function runCoverageReassessment(opts: {
  deadline?: number; env?: Env; maxBatches?: number; accountId?: number;
} = {}): Promise<ReassessmentPassResult> {
  const debut = Date.now();
  const res: ReassessmentPassResult = {
    rulesVersion: T1_COVERAGE_RULES_VERSION, examined: 0, byOutcome: {}, deferred: 0, deferredByCause: {},
    unconfirmed: 0, reservationsRecovered: 0, reservationsConfirmed: 0, fullCycle: false, unchangedEvidence: 0, evidenceChecked: 0, evidenceChanged: 0, evidenceSweepComplete: false, reservationsRestituted: 0, errors: 0,
    alertsClosed: 0, alertsMaintained: 0, alertsOpened: 0, orphanAlertsExamined: 0, retriesScheduled: 0, retriesCancelled: 0,
    aiCalls: 0, durationMs: 0, more: false,
  };
  const fin = (extra: Partial<ReassessmentPassResult> = {}): ReassessmentPassResult => ({ ...res, ...extra, durationMs: Date.now() - debut });
  const { coverageProvenanceReady, sourceLayerReady } = await import('./repository');
  if (!(await sourceLayerReady())) return fin({ disabled: 'SOURCE_LAYER_MISSING' });
  // Migration 1665 (lots 113AN / 114G) : sans elle, la réconciliation ne peut pas conserver ses preuves — rien n'est tenté.
  if (!(await coverageProvenanceReady())) return fin({ disabled: 'MIGRATION_1665_MISSING' });
  if (!(await reassessmentJournalReady())) return fin({ disabled: 'MIGRATION_1705_MISSING' });
  const { pgClient } = await import('@/db');
  const lot = batchSize(opts.env);
  const compter = (alerts: readonly AlertDecision[]) => {
    for (const a of alerts) {
      if (a.action === 'CLOSED') res.alertsClosed++; else if (a.action === 'OPENED') res.alertsOpened++; else res.alertsMaintained++;
    }
  };

  // Lot 115H (#785, § 4) : réservations de reprise orphelines rendues AVANT le parcours — aucune tentative
  // acceptée ne reste non comptabilisée, aucune n'est comptée deux fois.
  {
    const { recoverRequeueReservations } = await import('./requeue-identity');
    const rec = await recoverRequeueReservations({ accountId: opts.accountId });
    res.reservationsRecovered = rec.released;
    res.reservationsConfirmed = rec.confirmed;
    res.reservationsRestituted = rec.restituted;
  }

  // ══════════════════════════════════════════════════════════════════════
  // A. DOCUMENTS DU STOCK — tout le stock pertinent (carte § 5)
  //
  // Règle complétée, sur quatre points :
  //   1. le parcours reprend sur un CURSEUR DURABLE (`t1_reassessment_cursors`)
  //      au lieu de repartir de zéro à chaque passage : les documents de FIN de
  //      stock ne sont plus affamés, et le curseur survit à une panne ;
  //   2. les documents TEMPORAIREMENT EXCLUS (compte non éligible, analyse en
  //      cours, reprise planifiée imminente) ne sont plus invisibles : ils sont
  //      SÉLECTIONNÉS, puis journalisés `DEFERRED` avec leur cause — travail
  //      différé IDENTIFIABLE, réarmé dès que la cause disparaît, sans attendre
  //      un redémarrage ni une consultation du BO ;
  //   3. « déjà traité pour vN » ne suffit plus : la ligne de journal doit aussi
  //      porter la MÊME EMPREINTE DE PREUVES que l'état actuel (§ 5) — une
  //      preuve nouvelle à version constante fait réexaminer le document, et une
  //      confrontation identique n'est jamais rejouée ;
  //   4. une issue NON TERMINALE (erreur, non confirmée, différée) laisse le
  //      document à traiter, borné par `REASSESSMENT_MAX_ATTEMPTS`.
  // ══════════════════════════════════════════════════════════════════════
  const avecCurseur = await reassessmentCursorsReady();
  // ══════════════════════════════════════════════════════════════════════
  // LOT 115H (#785, § 5) — UN REPORT QUI ATTEND UN ÉVÉNEMENT EXTÉRIEUR N'EST
  // PAS REPRIS EN BOUCLE, ET N'EST PAS OUBLIÉ POUR AUTANT
  //
  // Un document différé parce que son compte est temporairement exclu ou son
  // analyse en cours reste hors du parcours TANT QUE SA CAUSE TIENT — sinon
  // chaque passage le reprendrait sans rien pouvoir faire, et le stock ne
  // serait jamais parcouru jusqu'au bout. Dès que la cause disparaît
  // (réactivation du compte, fin d'analyse), la condition ci-dessous devient
  // fausse et le document revient dans le parcours, de lui-même, sans
  // redémarrage ni consultation du BO.
  // ══════════════════════════════════════════════════════════════════════
  const causeTientSql = (await reassessmentLeaseReady())
    ? `OR (j.outcome = 'DEFERRED' AND (
            (j.deferred_cause = 'ACCOUNT_INELIGIBLE' AND NOT (${processingEligibleSql('c.account_id')}))
            OR (j.deferred_cause = 'ANALYSIS_RUNNING' AND (af.analysis_state = 'ANALYZING' OR af.analysis_state = 'UPLOADED'))))`
    : '';
  const avecEmpreinte = await reassessmentLeaseReady();
  const vus = new Set<number>();
  /** Documents DIFFÉRÉS pendant ce passage : leurs alertes ne sont pas décidées sur un état encore à recalculer. */
  const differes = new Set<number>();
  const depart = avecCurseur ? await lireCurseur('documents') : 0;
  let apres = depart;
  /** Le parcours a-t-il fait un tour complet ? (le curseur repart alors à zéro) */
  let tourComplet = false;
  /** Le parcours a-t-il déjà rebouclé au début du stock pendant CE passage ? (une seule fois) */
  let repris = false;
  for (let n = 0; n < (opts.maxBatches ?? 10_000); n++) {
    if (opts.deadline && Date.now() > opts.deadline) { res.more = true; break; }
    const rows = (await pgClient.unsafe(
      `SELECT c.file_id, c.account_id,
              (c.next_retry_at IS NOT NULL AND c.next_retry_at BETWEEN NOW() - make_interval(mins => $6) AND NOW() + make_interval(mins => $6)) AS reprise_active,
              (af.analysis_state = 'ANALYZING' OR af.analysis_state = 'UPLOADED') AS analyse_en_cours,
              NOT (${processingEligibleSql('c.account_id')}) AS compte_exclu
         FROM document_extraction_coverage c
         JOIN asset_files af ON af.id = c.file_id AND af.account_id = c.account_id AND af.deleted_at IS NULL
        WHERE c.file_id > $1 AND c.quality_state = ANY($2::text[])
          AND ($7::int IS NULL OR c.account_id = $7)
          -- Déjà traité pour CETTE version ? Oui seulement si l'issue est TERMINALE (ou les essais épuisés) ET que
          -- la couverture n'a pas été réécrite depuis : une preuve nouvelle à version constante le fait
          -- réexaminer (§ 5). L'empreinte EXACTE est comparée ensuite, document par document : une confrontation
          -- rigoureusement identique n'est pas rejouée.
          AND NOT EXISTS (
            SELECT 1 FROM t1_coverage_reassessments j
             WHERE j.file_id = c.file_id AND j.rules_version = $3
               AND (
                 ((NOT (j.outcome = ANY($8::text[])) OR j.attempts >= $4) AND c.updated_at <= j.updated_at)
                 ${causeTientSql})
          )
        ORDER BY c.file_id
        LIMIT $5`,
      [apres, [...REASSESSED_QUALITY_STATES], T1_COVERAGE_RULES_VERSION, REASSESSMENT_MAX_ATTEMPTS, lot + 1,
        RETRY_ACTIVITY_WINDOW_MINUTES, opts.accountId ?? null, [...NON_TERMINAL_OUTCOMES]] as never[],
    )) as unknown as Array<{ file_id: number; account_id: number; reprise_active: boolean; analyse_en_cours: boolean; compte_exclu: boolean }>;
    const plus = rows.length > lot;
    for (const r of rows.slice(0, lot)) {
      apres = Number(r.file_id);
      if (opts.deadline && Date.now() > opts.deadline) { res.more = true; break; }
      // ══════════════════════════════════════════════════════════════
      // EXCLUSIONS TEMPORAIRES = TRAVAIL DIFFÉRÉ IDENTIFIABLE (carte § 5)
      //
      // Compte temporairement exclu (lot 82A), analyse en cours, reprise
      // planifiée imminente : le document n'est PAS traité maintenant — mais il
      // est journalisé `DEFERRED` avec sa cause, donc visible et réarmé dès que
      // la cause disparaît (réactivation du compte, fin d'analyse, échéance
      // passée), au passage suivant et sans redémarrage.
      // ══════════════════════════════════════════════════════════════
      const cause = r.compte_exclu ? 'ACCOUNT_INELIGIBLE' : r.analyse_en_cours ? 'ANALYSIS_RUNNING' : r.reprise_active ? 'RETRY_ACTIVE' : null;
      if (cause !== null) {
        res.deferred++;
        // `more` ne demande un passage IMMÉDIAT que pour une cause qui se lève en quelques minutes. Une cause
        // qui attend un ÉVÉNEMENT extérieur (réactivation du compte, fin d'analyse) est reprise au passage
        // planifié suivant : la demander tout de suite ferait boucler la tâche sans fin.
        if (cause === 'RETRY_ACTIVE') res.more = true;
        differes.add(Number(r.file_id));
        res.byOutcome.DEFERRED = (res.byOutcome.DEFERRED ?? 0) + 1;
        res.deferredByCause[cause] = (res.deferredByCause[cause] ?? 0) + 1;
        await journaliser({
          accountId: Number(r.account_id), fileId: Number(r.file_id), outcome: 'DEFERRED', before: null, after: null,
          alerts: [], detail: { deferred: cause }, durationMs: 0, deferredCause: cause,
        }).catch(() => undefined);
        continue;
      }
      const d = await reassessDocumentCoverage({ accountId: Number(r.account_id), fileId: Number(r.file_id) });
      vus.add(Number(r.file_id));
      // Carte #837 (C1) : preuves identiques à la dernière confrontation — contrôlé, rien rejoué, rien écrit.
      if (d.detail.skipped === 'SAME_EVIDENCE') { res.unchangedEvidence++; continue; }
      res.examined++;
      res.byOutcome[d.outcome] = (res.byOutcome[d.outcome] ?? 0) + 1;
      if (d.outcome === 'ERROR') { res.errors++; res.more = true; }
      if (d.outcome === 'UNCONFIRMED') { res.unconfirmed++; res.more = true; }
      if (d.outcome === 'DEFERRED') {
        res.deferred++;
        res.more = true;
        differes.add(Number(r.file_id));
        if (d.deferredCause) res.deferredByCause[d.deferredCause] = (res.deferredByCause[d.deferredCause] ?? 0) + 1;
      }
      compter(d.alerts);
      if (d.before && d.after && !d.before.retryScheduled && d.after.retryScheduled) res.retriesScheduled++;
      if (d.before && d.after && d.before.retryScheduled && !d.after.retryScheduled) res.retriesCancelled++;
    }
    // Curseur DURABLE : le passage suivant repart d'ici, même après une panne (§ 5 — pas de famine).
    if (avecCurseur) await ecrireCurseur('documents', apres, false);
    if (res.more && opts.deadline && Date.now() > opts.deadline) break;
    if (!plus) {
      // Fin de stock atteinte : le curseur repart à zéro (tour complet).
      if (avecCurseur) await ecrireCurseur('documents', 0, true);
      // Le parcours avait commencé APRÈS le début du stock (curseur durable) : les documents laissés derrière
      // sont pris MAINTENANT, dans le même passage — personne n'est affamé, et le passage se termine quand même.
      // Le reboucle ne consomme pas un lot du passage (`n--`, une seule fois : `repris` le garantit).
      if (depart > 0 && !repris) { repris = true; apres = 0; n--; continue; }
      tourComplet = true;
      break;
    }
    // Nombre de lots du passage atteint alors qu'il reste des documents : le passage suivant reprend.
    if (n + 1 >= (opts.maxBatches ?? 10_000)) res.more = true;
  }
  res.fullCycle = tourComplet;

  // ══════════════════════════════════════════════════════════════════════
  // CARTE #837 (C1) — BALAYAGE DES EMPREINTES : UNE PREUVE NOUVELLE N'EST
  // PLUS ÉCARTÉE AVANT D'AVOIR ÉTÉ EXAMINÉE
  //
  // Règle complétée : le parcours A écarte un document à issue TERMINALE dès
  // que `c.updated_at <= j.updated_at` — AVANT tout calcul d'empreinte. Une
  // preuve nouvelle dans une AUTRE table (fait, décision, candidat, cellule,
  // texte original) ne réécrit pas la couverture et passait donc inaperçue.
  //
  // Ces documents sont maintenant REVUS par un balayage permanent, à curseur
  // durable (`evidence`) : l'empreinte EXHAUSTIVE des preuves est recalculée
  // et comparée à celle du journal — identique → rien n'est rejoué ni écrit
  // (`SAME_EVIDENCE`) ; différente → le document est réévalué, à version de
  // règle constante, sans redémarrage ni consultation du BO. Le balayage est
  // borné par l'échéance du passage (jamais par un plafond silencieux : son
  // curseur et sa progression sont rendus), et reprend où il s'était arrêté.
  // ══════════════════════════════════════════════════════════════════════
  if (avecEmpreinte && avecCurseur && tourComplet) {
    let apresEmpreinte = await lireCurseur('evidence');
    const departEmpreinte = apresEmpreinte;
    let reprisEmpreinte = false;
    for (;;) {
      if (opts.deadline && Date.now() > opts.deadline) { res.more = true; break; }
      const lignes = (await pgClient.unsafe(
        `SELECT c.file_id, c.account_id FROM document_extraction_coverage c
           JOIN asset_files af ON af.id = c.file_id AND af.account_id = c.account_id AND af.deleted_at IS NULL
           JOIN t1_coverage_reassessments j ON j.file_id = c.file_id AND j.account_id = c.account_id AND j.rules_version = $3
          WHERE c.file_id > $1 AND c.quality_state = ANY($2::text[]) AND ($5::int IS NULL OR c.account_id = $5)
            AND NOT (j.outcome = ANY($6::text[]))
            AND (af.analysis_state IS DISTINCT FROM 'ANALYZING' AND af.analysis_state IS DISTINCT FROM 'UPLOADED')
            AND ${processingEligibleSql('c.account_id')}
          ORDER BY c.file_id LIMIT $4`,
        [apresEmpreinte, [...REASSESSED_QUALITY_STATES], T1_COVERAGE_RULES_VERSION, lot + 1, opts.accountId ?? null, [...NON_TERMINAL_OUTCOMES]] as never[],
      )) as unknown as Array<{ file_id: number; account_id: number }>;
      for (const l of lignes.slice(0, lot)) {
        if (opts.deadline && Date.now() > opts.deadline) { res.more = true; break; }
        apresEmpreinte = Number(l.file_id);
        if (vus.has(apresEmpreinte) || differes.has(apresEmpreinte)) continue;
        res.evidenceChecked++;
        const d = await reassessDocumentCoverage({ accountId: Number(l.account_id), fileId: Number(l.file_id) });
        // Empreinte inchangée : rien n'a été décidé ici — ses alertes restent examinées par le parcours B, comme avant.
        if (d.detail.skipped === 'SAME_EVIDENCE') { res.unchangedEvidence++; continue; }
        vus.add(apresEmpreinte);
        // Preuve NOUVELLE : le document a été réévalué (compté comme tel).
        res.evidenceChanged++;
        res.examined++;
        res.byOutcome[d.outcome] = (res.byOutcome[d.outcome] ?? 0) + 1;
        if (d.outcome === 'ERROR') res.errors++;
        if (d.outcome === 'UNCONFIRMED') res.unconfirmed++;
        if (d.outcome === 'DEFERRED') {
          res.deferred++;
          differes.add(apresEmpreinte);
          if (d.deferredCause) res.deferredByCause[d.deferredCause] = (res.deferredByCause[d.deferredCause] ?? 0) + 1;
        }
        compter(d.alerts);
      }
      if (res.more && opts.deadline && Date.now() > opts.deadline) { await ecrireCurseur('evidence', apresEmpreinte, false); break; }
      await ecrireCurseur('evidence', apresEmpreinte, false);
      if (lignes.length <= lot) {
        await ecrireCurseur('evidence', 0, true);
        res.evidenceSweepComplete = true;
        if (departEmpreinte > 0 && !reprisEmpreinte) { reprisEmpreinte = true; apresEmpreinte = 0; continue; }
        break;
      }
    }
  }

  // ── B. Alertes T1 ouvertes dont le document n'a pas été examiné ci-dessus ─
  //    (document supprimé, couverture complète, compte non éligible) : décision sur l'état COURANT.
  //    Lecture seule tant que rien n'est à clore : parcourue en entier à chaque passage (bornée par l'échéance seulement,
  //    les alertes maintenues restant ouvertes par construction).
  //    Lot 115H (#785, § 5 et § 6) : le parcours a son propre CURSEUR DURABLE, et il a lieu dès que le parcours des
  //    documents a atteint la fin du stock — plus seulement quand rien n'est différé (sinon un seul document
  //    différé suffisait à ne jamais examiner la moindre alerte orpheline). Les documents DIFFÉRÉS de ce passage
  //    sont exclus : jamais de décision sur un état dont le recalcul est encore à venir.
  const departAlerte = avecCurseur ? await lireCurseur('alerts') : 0;
  let apresAlerte = departAlerte;
  /** Le parcours des alertes a-t-il déjà rebouclé au début pendant CE passage ? (une seule fois) */
  let reprisAlerte = false;
  while (tourComplet) {
    if (opts.deadline && Date.now() > opts.deadline) { res.more = true; break; }
    const alertes = (await pgClient.unsafe(
      // Lot 115H (#785, § 6) : TOUTES les familles de l'inventaire, jamais deux préfixes codés en dur.
      `SELECT an.id, an.fingerprint, an.account_id FROM admin_anomalies an
        WHERE an.status = 'open' AND an.id > $1
          AND EXISTS (SELECT 1 FROM unnest($2::text[]) pre WHERE an.fingerprint LIKE pre || '%')
          AND ($4::int IS NULL OR an.account_id = $4)
        ORDER BY an.id LIMIT $3`,
      [apresAlerte, T1_ALERT_FAMILIES.map((f) => f.prefix), lot + 1, opts.accountId ?? null] as never[],
    )) as unknown as Array<{ id: number; fingerprint: string; account_id: number | null }>;
    for (const a of alertes.slice(0, lot)) {
      apresAlerte = Number(a.id);
      const cible = alertTargetOf(String(a.fingerprint));
      // Document examiné en A pendant ce passage : son alerte vient d'être décidée (jamais comptée deux fois).
      // Document DIFFÉRÉ : son état n'est pas à jour — aucune décision sur son alerte (lot 115H, § 5).
      if (!cible || vus.has(cible.fileId) || differes.has(cible.fileId)) continue;
      res.orphanAlertsExamined++;
      try {
        const [etat] = (await pgClient.unsafe(
          `SELECT af.id AS file, af.account_id, af.deleted_at, c.quality_state AS "qualityState", c.anomalies, c.coverage_ratio::float8 AS "coverageRatio",
                  c.failed_units AS "failedUnits", c.truncated_sections_count AS "truncatedSectionsCount", c.dropped_facts_count AS "droppedFactsCount",
                  to_jsonb(c) -> 'verification' AS verification,
                  to_jsonb(c) ->> 'last_retry_result' AS "lastRetryResult", (c.next_retry_at IS NOT NULL) AS "retryScheduled"
             FROM (SELECT $1::int AS id) x
             LEFT JOIN asset_files af ON af.id = x.id
             LEFT JOIN document_extraction_coverage c ON c.file_id = af.id AND c.account_id = af.account_id`,
          [cible.fileId] as never[],
        )) as unknown as Row[];
        const supprime = !etat || etat.file == null || etat.deleted_at != null;
        const decision = alertDecisionOf({
          kind: cible.kind, open: true, deleted: supprime, qualityState: supprime || etat?.qualityState == null ? null : String(etat.qualityState),
          normalisationLosses: supprime ? null : lossesOf(etat?.verification ?? null), rulesVersion: T1_COVERAGE_RULES_VERSION,
          lastRetryResult: supprime || etat?.lastRetryResult == null ? null : String(etat.lastRetryResult),
          retryScheduled: !supprime && etat?.retryScheduled === true,
        });
        if (!decision) continue;
        const d = await applyAlertDecision({
          accountId: a.account_id == null ? null : Number(a.account_id), fileId: cible.fileId, kind: cible.kind, anomalyId: Number(a.id), decision,
          coverage: supprime ? null : etat ?? null,
        });
        compter([d]);
        if (d.action === 'CLOSED') console.info(`[t1-coverage-reassessment] alerte ${a.id} (${a.fingerprint}) close : ${d.cause}`);
      } catch (e) {
        res.errors++;
        console.error(`[t1-coverage-reassessment] alerte ${a.id} :`, (e as Error).message);
      }
    }
    if (avecCurseur) await ecrireCurseur('alerts', apresAlerte, false);
    if (alertes.length <= lot) {
      // Fin du parcours des alertes : le curseur repart à zéro (aucune alerte de fin de liste affamée).
      if (avecCurseur) await ecrireCurseur('alerts', 0, true);
      // Le parcours avait commencé APRÈS la première alerte (curseur durable, reprise d'un passage interrompu) :
      // celles laissées derrière sont examinées MAINTENANT, dans le même passage.
      if (departAlerte > 0 && !reprisAlerte) { reprisAlerte = true; apresAlerte = 0; continue; }
      break;
    }
  }
  return fin();
}

/** Bilan CUMULÉ de la campagne pour une version des règles (lecture du journal — BO). */
export interface ReassessmentReport {
  rulesVersion: number;
  available: boolean;
  documents: number;
  byOutcome: Record<string, number>;
  /** Changements d'état de qualité « avant → après », avec leur nombre. */
  transitions: Array<{ from: string; to: string; documents: number }>;
  unitsRequalified: number;
  alertsClosed: number; alertsMaintained: number; alertsOpened: number;
  retriesScheduled: number; retriesCancelled: number;
  errors: number;
  /** Documents du stock encore à examiner pour cette version (comptes éligibles ou non). */
  remaining: number;
  /** Alertes T1 de couverture encore ouvertes en Supervision. */
  openAlerts: number;
  totalDurationMs: number;
  /** Toujours 0 : la PASSE DÉTERMINISTE n'appelle aucun modèle ; son coût est nul. */
  aiCalls: 0;
  aiCost: 0;
  firstAt: string | null; lastAt: string | null;
  /**
   * ════════════════════════════════════════════════════════════════════════
   * LOT 115H (Trello #785, § 6) — BILAN EXHAUSTIF ET CORRÉLÉ
   *
   * Règle complétée : le bilan annonçait « 0 appel, 0 coût » — vrai pour le
   * recalcul lui-même, faux pour ce qu'il DÉCLENCHE : les réparations qu'il
   * programme consomment, elles, des appels et un coût. Et il ne disait rien
   * des réparations réellement ACCOMPLIES, des documents différés, non
   * vérifiables ou non confirmés.
   *
   * `followUps` consolide la suite : campagne → demandes de reprise → travaux
   * → appels → coûts. Le coût de la passe déterministe reste séparé de celui
   * de ses suites, et un coût que la passerelle n'a pas rendu reste INCONNU —
   * jamais zéro.
   * ════════════════════════════════════════════════════════════════════════
   */
  examined: number;
  deferred: number;
  deferredByCause: Record<string, number>;
  unconfirmed: number;
  reconciled: number;
  verified: number;
  unverifiable: number;
  unresolved: number;
  /** Réparations PROGRAMMÉES par le recalcul (une réparation programmée n'est pas une réparation accomplie). */
  repairsScheduled: number;
  /**
   * Carte #837 (D2) : réparations ACCOMPLIES = suites dont le SUCCÈS MÉTIER est
   * prouvé (unités réellement couvertes après la passe, ou travail T1 terminé
   * `APPLIED`). Un travail `DONE` en échec métier n'en est pas une.
   */
  repairsCompleted: number;
  /** Carte #837 (D2) : du programmé au réparé, sans confusion (documents distincts, sauf mention). */
  repairs: {
    /** Suites exécutées (réparation, relecture, travail T1 terminé). */
    executed: number;
    /** Succès métier prouvé. */
    businessSucceeded: number;
    /** Exécutée mais sans succès métier (échec, aucune unité réparée, DONE métier KO). */
    businessFailed: number;
    /** Issue encore inconnue (travail vivant, résultat métier absent). */
    unknown: number;
    /** Unités réellement couvertes par les suites (somme). */
    unitsRepaired: number;
    /** Documents des suites dont la couverture ACTUELLE porte encore des résidus. */
    residualsRemaining: number;
  };
  followUps: {
    /** Carte #837 (D1) : `EXPLICIT` — chaque suite est rattachée par sa référence de campagne ; `UNAVAILABLE` : migration 1970 absente. */
    correlation: 'EXPLICIT' | 'UNAVAILABLE';
    /** Demandes de reprise nées de la campagne (référence de campagne explicite). */
    requests: number;
    requestsByState: Record<string, number>;
    /** Travaux T1 corrélés à ces demandes, par état réel. */
    jobs: number;
    jobsByState: Record<string, number>;
    /** Appels des suites, par famille (réparation JSON ciblée, relecture du fichier, analyse complète). */
    callsByKind: Record<string, number>;
    calls: number;
    /** Coût RÉEL rendu des suites (micro-unités) — jamais celui de la passe déterministe. */
    costMicros: number;
    /** Appels dont la passerelle n'a pas rendu de coût : INCONNU, jamais compté zéro. */
    callsWithUnknownCost: number;
    /** Travaux T1 de la campagne clos sans fenêtre d'exécution consignée : appels non attribuables, INCONNU. */
    jobsWithUnknownCalls: number;
    /** Appels sur les documents de la campagne NON rattachés à une suite (attribution non prouvée — exclus des totaux). */
    uncorrelatedDocumentCalls: number;
  };
  /** Un plafond a-t-il tronqué un total de ce bilan ? (toujours faux : les totaux sont agrégés en base) */
  truncated: false;
}

export async function getCoverageReassessmentReport(rulesVersion: number = T1_COVERAGE_RULES_VERSION): Promise<ReassessmentReport> {
  const vide: ReassessmentReport = {
    rulesVersion, available: false, documents: 0, byOutcome: {}, transitions: [], unitsRequalified: 0, alertsClosed: 0, alertsMaintained: 0,
    alertsOpened: 0, retriesScheduled: 0, retriesCancelled: 0, errors: 0, remaining: 0, openAlerts: 0, totalDurationMs: 0, aiCalls: 0, aiCost: 0,
    firstAt: null, lastAt: null,
    examined: 0, deferred: 0, deferredByCause: {}, unconfirmed: 0, reconciled: 0, verified: 0, unverifiable: 0, unresolved: 0,
    repairsScheduled: 0, repairsCompleted: 0,
    repairs: { executed: 0, businessSucceeded: 0, businessFailed: 0, unknown: 0, unitsRepaired: 0, residualsRemaining: 0 },
    followUps: {
      correlation: 'UNAVAILABLE', requests: 0, requestsByState: {}, jobs: 0, jobsByState: {}, callsByKind: {}, calls: 0, costMicros: 0,
      callsWithUnknownCost: 0, jobsWithUnknownCalls: 0, uncorrelatedDocumentCalls: 0,
    },
    truncated: false,
  };
  if (!(await reassessmentJournalReady())) return vide;
  const { pgClient } = await import('@/db');
  const q = async (sql: string, params: unknown[]) => (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];
  const [parIssue, transitions, [tot], [reste], [ouvertes], [closes]] = await Promise.all([
    q(`SELECT outcome, COUNT(*)::int AS n FROM t1_coverage_reassessments WHERE rules_version = $1 GROUP BY outcome`, [rulesVersion]),
    q(`SELECT state_before ->> 'qualityState' AS de, state_after ->> 'qualityState' AS vers, COUNT(*)::int AS n
         FROM t1_coverage_reassessments
        WHERE rules_version = $1 AND outcome <> 'ERROR' AND state_before ->> 'qualityState' IS DISTINCT FROM state_after ->> 'qualityState'
        GROUP BY 1, 2 ORDER BY n DESC, 1, 2`, [rulesVersion]),
    q(`SELECT COUNT(*)::int AS documents, COALESCE(SUM(duration_ms), 0)::float8 AS duree, MIN(created_at) AS debut, MAX(updated_at) AS fin,
              COALESCE(SUM(CASE WHEN jsonb_typeof(detail -> 'requalified') = 'number' THEN (detail ->> 'requalified')::int END), 0)::int AS requalifiees,
              COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(alerts) a WHERE a ->> 'action' = 'MAINTAINED')), 0)::int AS maintenues,
              COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(alerts) a WHERE a ->> 'action' = 'OPENED')), 0)::int AS ouvertes,
              COUNT(*) FILTER (WHERE state_before ->> 'retryScheduled' = 'false' AND state_after ->> 'retryScheduled' = 'true')::int AS programmees,
              COUNT(*) FILTER (WHERE state_before ->> 'retryScheduled' = 'true' AND state_after ->> 'retryScheduled' = 'false')::int AS retirees
         FROM t1_coverage_reassessments WHERE rules_version = $1`, [rulesVersion]),
    // Lot 115H (#785, § 6) : AUCUN plafond — les totaux sont agrégés EN BASE, sur tout le stock.
    q(`SELECT COUNT(*)::int AS n FROM document_extraction_coverage c
         JOIN asset_files af ON af.id = c.file_id AND af.deleted_at IS NULL
        WHERE c.quality_state = ANY($2::text[])
          AND NOT EXISTS (SELECT 1 FROM t1_coverage_reassessments j WHERE j.file_id = c.file_id AND j.rules_version = $1
                           AND (NOT (j.outcome = ANY($4::text[])) OR j.attempts >= $3))`,
    [rulesVersion, [...REASSESSED_QUALITY_STATES], REASSESSMENT_MAX_ATTEMPTS, [...NON_TERMINAL_OUTCOMES]]),
    // Lot 115H (#785, § 6) : toutes les familles de l'inventaire, jamais deux préfixes codés en dur.
    q(`SELECT COUNT(*)::int AS n FROM admin_anomalies an
        WHERE an.status = 'open' AND EXISTS (SELECT 1 FROM unnest($1::text[]) pre WHERE an.fingerprint LIKE pre || '%')`,
      [T1_ALERT_FAMILIES.map((f) => f.prefix)]),
    // Clôtures de la campagne, lues sur les anomalies elles-mêmes (documents examinés ET alertes sans document éligible).
    q(`SELECT COUNT(*)::int AS n FROM admin_anomalies WHERE status = 'resolved' AND auto_resolution_origin = $1`,
      [`t1_coverage_reassessment:v${rulesVersion}`]),
  ]);
  const byOutcome: Record<string, number> = {};
  for (const r of parIssue) byOutcome[String(r.outcome)] = Number(r.n);
  const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
  const [parCause, suites] = await Promise.all([reportDeferredByCause(rulesVersion), reportFollowUps(rulesVersion)]);
  const documents = Number(tot?.documents ?? 0);
  const differes = Number(byOutcome.DEFERRED ?? 0);
  const nonConfirmes = Number(byOutcome.UNCONFIRMED ?? 0);
  return {
    rulesVersion, available: true, documents, byOutcome,
    transitions: transitions.map((t) => ({ from: String(t.de ?? '—'), to: String(t.vers ?? '—'), documents: Number(t.n) })),
    unitsRequalified: Number(tot?.requalifiees ?? 0), alertsClosed: Number(closes?.n ?? 0), alertsMaintained: Number(tot?.maintenues ?? 0),
    alertsOpened: Number(tot?.ouvertes ?? 0), retriesScheduled: Number(tot?.programmees ?? 0), retriesCancelled: Number(tot?.retirees ?? 0),
    errors: Number(byOutcome.ERROR ?? 0), remaining: Number(reste?.n ?? 0), openAlerts: Number(ouvertes?.n ?? 0),
    totalDurationMs: Number(tot?.duree ?? 0), aiCalls: 0, aiCost: 0, firstAt: iso(tot?.debut), lastAt: iso(tot?.fin),
    // Lot 115H (#785, § 6) : le détail exhaustif, sans plafond.
    examined: Math.max(0, documents - differes),
    deferred: differes, deferredByCause: parCause, unconfirmed: nonConfirmes,
    reconciled: Number(byOutcome.RECONCILED ?? 0),
    verified: Number(byOutcome.RESOLVED ?? 0),
    unverifiable: Number(byOutcome.UNVERIFIABLE ?? 0),
    unresolved: Number(byOutcome.STILL_UNRESOLVED ?? 0) + Number(byOutcome.FINAL_GAP ?? 0),
    repairsScheduled: Number(byOutcome.REPAIR_SCHEDULED ?? 0),
    repairsCompleted: suites.repairs.businessSucceeded,
    repairs: suites.repairs,
    followUps: suites.followUps,
    truncated: false,
  };
}

/** Reports par CAUSE, agrégés en base (lot 115H, § 5 et § 6). Colonne absente : objet vide. */
async function reportDeferredByCause(rulesVersion: number): Promise<Record<string, number>> {
  if (!(await reassessmentLeaseReady())) return {};
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT COALESCE(deferred_cause, '?') AS cause, COUNT(*)::int AS n FROM t1_coverage_reassessments
        WHERE rules_version = $1 AND outcome = 'DEFERRED' GROUP BY 1`,
      [rulesVersion] as never[],
    )) as unknown as Row[];
    return Object.fromEntries(rows.map((r) => [String(r.cause), Number(r.n)]));
  } catch {
    return {};
  }
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 115H (Trello #785, § 6) — CAMPAGNE → DEMANDES → TRAVAUX → APPELS → COÛTS
 * Carte Trello #837 (D1, D2) — CORRÉLATION EXPLICITE ET SUCCÈS MÉTIER
 *
 * Règles remplacées :
 *   D1  les appels étaient rattachés à la campagne par JOINTURE
 *       document ↔ appel et `e.created_at >= j.created_at` : n'importe quel
 *       appel ultérieur sur le document (nouvelle analyse demandée par
 *       l'utilisateur, autre traitement) était imputé à la campagne ;
 *   D2  `repairsCompleted` comptait les demandes CONFIRMED dont le travail
 *       était `DONE`, sans lire le résultat métier ni la lacune.
 *
 * Désormais :
 *   · demandes : `t1_requeue_requests.campaign_ref` = la campagne ;
 *   · suites exécutées : `t1_campaign_followups` (écrites par l'exécution
 *     elle-même : appels, coût RENDU, coût inconnu, issue métier, unités
 *     réparées) ;
 *   · travaux T1 complets : appels de l'exécution métier PORTÉE par le
 *     travail (`payload.businessExecution.id`), bornés à la fenêtre
 *     d'exécution du travail ; travail sans exécution portée : INCONNU ;
 *   · appels du document NON rattachés : comptés à part, jamais imputés.
 * Inconnu ≠ 0, partout.
 * ══════════════════════════════════════════════════════════════════════════
 */
async function reportFollowUps(rulesVersion: number): Promise<{ repairs: ReassessmentReport['repairs']; followUps: ReassessmentReport['followUps'] }> {
  const campagne = `t1-coverage-reassessment:v${rulesVersion}`;
  const repairs: ReassessmentReport['repairs'] = { executed: 0, businessSucceeded: 0, businessFailed: 0, unknown: 0, unitsRepaired: 0, residualsRemaining: 0 };
  const followUps: ReassessmentReport['followUps'] = {
    correlation: 'UNAVAILABLE', requests: 0, requestsByState: {}, jobs: 0, jobsByState: {}, callsByKind: {}, calls: 0, costMicros: 0,
    callsWithUnknownCost: 0, jobsWithUnknownCalls: 0, uncorrelatedDocumentCalls: 0,
  };
  const { pgClient } = await import('@/db');
  const q = async (sql: string, params: unknown[]): Promise<Row[]> => (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];
  const { requeueRequestsReady } = await import('./requeue-identity');
  let pret = false;
  try {
    pret = (await requeueRequestsReady()) && ((await q(`SELECT to_regclass('t1_campaign_followups') IS NOT NULL AS ok`, []))[0]?.ok === true);
  } catch { pret = false; }
  if (!pret) return { repairs, followUps };
  followUps.correlation = 'EXPLICIT';
  const [parEtat, parTravail, suites, travaux, resultats, nonCorreles] = await Promise.all([
    q(`SELECT r.state, COUNT(*)::int AS n FROM t1_requeue_requests r WHERE r.campaign_ref = $1 GROUP BY 1`, [campagne]),
    q(`SELECT jq.status, COUNT(DISTINCT jq.id)::int AS n FROM t1_requeue_requests r
         JOIN ai_job_queue jq ON jq.id = r.job_id AND jq.account_id = r.account_id
        WHERE r.campaign_ref = $1 GROUP BY 1`, [campagne]),
    // Suites consignées par leur exécution : appels et coûts RENDUS, issue métier.
    q(`SELECT kind, COUNT(*)::int AS n, COALESCE(SUM(calls), 0)::int AS calls,
              COALESCE(SUM(cost_micros), 0)::float8 AS cout, COALESCE(SUM(cost_unknown_calls), 0)::int AS inconnus,
              COUNT(*) FILTER (WHERE calls IS NULL)::int AS appels_inconnus
         FROM t1_campaign_followups WHERE campaign_ref = $1 AND kind <> 'REQUEUE_T1' GROUP BY 1`, [campagne]),
    // Travaux T1 complets de la campagne : appels de l'exécution métier PORTÉE, dans la fenêtre du travail.
    q(`SELECT jq.id,
              COALESCE(jq.payload -> 'businessExecution' ->> 'id', 'T1:job:' || jq.id) AS exec_id,
              (jq.started_at IS NULL AND jq.status IN ('DONE', 'FAILED')) AS fenetre_inconnue,
              (SELECT COUNT(*)::int FROM ai_usage_event e
                WHERE e.business_execution_id = COALESCE(jq.payload -> 'businessExecution' ->> 'id', 'T1:job:' || jq.id) AND e.account_id = jq.account_id
                  AND jq.started_at IS NOT NULL AND e.created_at >= jq.started_at AND e.created_at <= COALESCE(jq.finished_at, NOW())) AS n,
              (SELECT COALESCE(SUM(e.cost_micros), 0)::float8 FROM ai_usage_event e
                WHERE e.business_execution_id = COALESCE(jq.payload -> 'businessExecution' ->> 'id', 'T1:job:' || jq.id) AND e.account_id = jq.account_id
                  AND jq.started_at IS NOT NULL AND e.created_at >= jq.started_at AND e.created_at <= COALESCE(jq.finished_at, NOW())
                  AND e.cost_micros IS NOT NULL) AS cout,
              (SELECT COUNT(*)::int FROM ai_usage_event e
                WHERE e.business_execution_id = COALESCE(jq.payload -> 'businessExecution' ->> 'id', 'T1:job:' || jq.id) AND e.account_id = jq.account_id
                  AND jq.started_at IS NOT NULL AND e.created_at >= jq.started_at AND e.created_at <= COALESCE(jq.finished_at, NOW())
                  AND e.cost_micros IS NULL) AS inconnus,
              jq.status, jq.business_result
         FROM ai_job_queue jq
        WHERE jq.id IN (SELECT r.job_id FROM t1_requeue_requests r WHERE r.campaign_ref = $1 AND r.job_id IS NOT NULL AND r.attempt_consumed)`,
      [campagne]),
    // Issue métier par DOCUMENT (une suite réussie suffit) et résidus actuels.
    q(`WITH s AS (
         SELECT f.account_id, f.file_id, bool_or(f.business_success) AS ok, bool_or(f.business_success IS NULL) AS inconnu,
                COALESCE(SUM(f.units_repaired), 0)::int AS unites
           FROM t1_campaign_followups f WHERE f.campaign_ref = $1 AND f.kind <> 'REQUEUE_T1' GROUP BY 1, 2
         UNION ALL
         SELECT r.account_id, r.file_id, bool_or(jq.status = 'DONE' AND jq.business_result = 'APPLIED'),
                bool_or(jq.status IN ('PENDING', 'RUNNING') OR (jq.status = 'DONE' AND jq.business_result IS NULL)), 0
           FROM t1_requeue_requests r JOIN ai_job_queue jq ON jq.id = r.job_id AND jq.account_id = r.account_id
          WHERE r.campaign_ref = $1 AND r.attempt_consumed GROUP BY 1, 2
       ), d AS (
         SELECT account_id, file_id, bool_or(ok) AS ok, bool_or(inconnu) AS inconnu, SUM(unites)::int AS unites FROM s GROUP BY 1, 2
       )
       SELECT COUNT(*)::int AS executees,
              COUNT(*) FILTER (WHERE ok)::int AS reussies,
              COUNT(*) FILTER (WHERE NOT ok AND NOT inconnu)::int AS echouees,
              COUNT(*) FILTER (WHERE NOT ok AND inconnu)::int AS inconnues,
              COALESCE(SUM(unites), 0)::int AS unites,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM document_extraction_coverage c
                 WHERE c.file_id = d.file_id AND c.account_id = d.account_id
                   AND (c.unresolved_units + c.uncertain_units + c.failed_units) > 0))::int AS residus
         FROM d`, [campagne]),
    // Appels du document NON rattachés à une suite (attribution non prouvée) : visibles, jamais imputés.
    q(`SELECT COUNT(*)::int AS n FROM ai_usage_event e
         JOIN t1_coverage_reassessments j ON j.file_id = e.asset_file_id AND j.account_id = e.account_id AND j.rules_version = $2
        WHERE e.created_at >= j.created_at
          AND NOT EXISTS (SELECT 1 FROM t1_campaign_followups f WHERE f.campaign_ref = $1 AND f.business_execution_id IS NOT NULL
                           AND f.business_execution_id = e.business_execution_id AND f.account_id = e.account_id)
          AND NOT EXISTS (SELECT 1 FROM t1_requeue_requests r JOIN ai_job_queue jq ON jq.id = r.job_id
                           WHERE r.campaign_ref = $1 AND COALESCE(jq.payload -> 'businessExecution' ->> 'id', 'T1:job:' || jq.id) = e.business_execution_id
                             AND jq.account_id = e.account_id AND jq.started_at IS NOT NULL
                             AND e.created_at >= jq.started_at AND e.created_at <= COALESCE(jq.finished_at, NOW()))`,
      [campagne, rulesVersion]).catch(() => [{ n: null }] as Row[]),
  ]);
  for (const r of parEtat) { followUps.requestsByState[String(r.state)] = Number(r.n); followUps.requests += Number(r.n); }
  for (const r of parTravail) { followUps.jobsByState[String(r.status)] = Number(r.n); followUps.jobs += Number(r.n); }
  for (const r of suites) {
    followUps.callsByKind[String(r.kind)] = Number(r.calls);
    followUps.calls += Number(r.calls);
    followUps.costMicros += Number(r.cout ?? 0);
    followUps.callsWithUnknownCost += Number(r.inconnus ?? 0);
  }
  for (const t of travaux) {
    // Travail clos sans début consigné : la fenêtre de ses appels est inconnue → INCONNU, jamais 0.
    if (t.fenetre_inconnue === true) { followUps.jobsWithUnknownCalls++; continue; }
    followUps.callsByKind.FULL_ANALYSIS = (followUps.callsByKind.FULL_ANALYSIS ?? 0) + Number(t.n ?? 0);
    followUps.calls += Number(t.n ?? 0);
    followUps.costMicros += Number(t.cout ?? 0);
    followUps.callsWithUnknownCost += Number(t.inconnus ?? 0);
  }
  const [r0] = resultats;
  if (r0) {
    repairs.executed = Number(r0.executees ?? 0);
    repairs.businessSucceeded = Number(r0.reussies ?? 0);
    repairs.businessFailed = Number(r0.echouees ?? 0);
    repairs.unknown = Number(r0.inconnues ?? 0);
    repairs.unitsRepaired = Number(r0.unites ?? 0);
    repairs.residualsRemaining = Number(r0.residus ?? 0);
  }
  followUps.uncorrelatedDocumentCalls = Number(nonCorreles[0]?.n ?? 0);
  return { repairs, followUps };
}
