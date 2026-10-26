/**
 * Contrat d'un contrôle du registre de cohérence — lot 82B (CDC « Contrôle
 * de cohérence global » §3.2, arbitrages PO C-Q1, C-Q2, C-Q4, §3.2).
 *
 * Un contrôle est DÉCLARATIF : il dit ce qu'il examine, avec quelles
 * sources, quel invariant, quelles réparations sont permises et lesquelles
 * sont interdites, quels services métier il sollicite, sur quels événements
 * il se redéclenche. Il n'écrit JAMAIS lui-même : `inspect` est en lecture
 * seule ; `repair` délègue au service métier existant qui fait autorité
 * (aucune écriture arbitraire, C-Q2). L'orchestrateur (`../engine.ts`)
 * enchaîne inspection → réparation (mode correctif seulement) → recontrôle,
 * et consigne la preuve de contrôle de chaque objet (C-Q4).
 */
import type postgres from 'postgres';

export type Sql = postgres.Sql;

/** Mode d'exécution : à blanc (aucune écriture métier) ou correctif (C-Q5). */
export type CoherenceMode = 'DRY_RUN' | 'CORRECTIVE';

/** Déclencheur d'un contrôle d'objet. */
export type ControlTrigger = 'DAILY' | 'CATCHUP' | 'MANUAL' | 'TARGETED';

/**
 * Maillon de la chaîne de vérification (§3.2) : document source et extract,
 * sortie T1, traitements T3 / T4, persistance et exploitation (liens,
 * projections, cartes), réparation ciblée.
 */
export type ChainLink = 'EXTRACT' | 'T1' | 'T3' | 'T4' | 'PERSISTENCE' | 'LINK' | 'PROJECTION' | 'TO_PROCESS';

/**
 * Verdict d'une inspection (lecture seule) :
 *   CONSISTENT  conforme (ou absence justifiée d'exploitation) ;
 *   REPAIRABLE  écart au diagnostic FIABLE, réparable par le service métier ;
 *   AMBIGUOUS   preuves insuffisantes ou contradictoires : aucune écriture,
 *               le mécanisme d'arbitrage existant reste seul juge ;
 *   FINDING     écart constaté qu'aucune chaîne automatique ne peut réparer
 *               aujourd'hui (cause racine à traiter, contrat IA attendu…) ;
 *   GONE        objet disparu entre l'énumération et l'inspection.
 */
export type Verdict = 'CONSISTENT' | 'REPAIRABLE' | 'AMBIGUOUS' | 'FINDING' | 'GONE';

export interface Inspection {
  verdict: Verdict;
  /** Code de l'anomalie (stable, `ANSWER_AVAILABLE`, `CERTAIN_LINK_MISSING`…). */
  anomaly?: string;
  /** Premier maillon incohérent (§3.2). */
  faultyLink?: ChainLink;
  expected?: unknown;
  observed?: unknown;
  /** Détail borné (identifiants, motifs) — jamais de contenu de document. */
  detail?: Record<string, unknown>;
  /**
   * Empreinte des ENTRÉES du constat : une réparation déjà tentée sur les
   * mêmes entrées sans succès n'est pas rejouée (anti-boucle, C-Q2).
   */
  inputHash?: string;
}

/** Résultat d'une réparation déléguée au service métier. */
export interface RepairResult {
  /** Le service a effectivement été appelé (même s'il n'a rien changé). */
  called: boolean;
  /** Service métier sollicité (`syncDocumentEquipmentLinks`…). */
  service: string;
  /** Résumé borné de la réponse du service. */
  result?: Record<string, unknown>;
  /** Appels IA déclenchés par le service (mesure, C-Q1). */
  aiCalls?: number;
  /** Référence de retour arrière dans le journal du domaine (journal 0591, 0223, événements de carte…). */
  rollbackRef?: string | null;
  /**
   * Lot 83B : relance ACCEPTÉE par une file existante (ex. nouvelle
   * extraction source par la file T1) dont le résultat n'est pas immédiat.
   * Pas de recontrôle immédiat : l'objet reste « réparation en attente »
   * (REPAIR_PENDING, journal PENDING) et n'est jamais relancé tant que le
   * diagnostic est le même ; le contrôle suivant de l'objet clôt la
   * tentative (REPAIRED si cohérent, INEFFECTIVE sinon) — C-Q7.
   */
  pending?: boolean;
  /**
   * Lot 87B (CODE-05, CODE-06) : NATURE de la réparation — reconstruction
   * technique (mêmes décisions rejouées par le service métier) ou NOUVELLE
   * décision sémantique demandée à T3 (identité d'Opération) / T4
   * (représentation Agenda). Journalisée (`coherence_repairs.reevaluation_kind`).
   */
  reevaluation?: 'TECHNICAL_REBUILD' | 'SEMANTIC_REEVALUATION_T3' | 'SEMANTIC_REEVALUATION_T4';
}

/**
 * Lot 83E (C-Q10) — périmètre du compte contrôlé :
 *   ELIGIBLE                  compte actif et modifiable (cas général) ;
 *   SUBSCRIPTION_STATE_READ   compte NON éligible du fait de son abonnement
 *                             (essai échu, impayé, abonnement terminé,
 *                             lecture seule, rétractation, sans abonnement) :
 *                             seuls les contrôles déclarés
 *                             `ineligibleAccounts: 'SUBSCRIPTION_STATE_READ'`
 *                             s'y exécutent, en LECTURE de l'état d'abonnement
 *                             — aucun traitement métier, aucun IA ; réparation
 *                             neutralisée par le moteur SAUF pour un contrôle
 *                             déclaré `repairOnIneligibleBilling` (lot 84A,
 *                             L83-Q1 : resynchronisation Stripe, mode
 *                             correctif seulement).
 */
export type AccountScope = 'ELIGIBLE' | 'SUBSCRIPTION_STATE_READ';

export interface CheckContext {
  sql: Sql;
  now: Date;
  /** Date civile de référence (Paris), injectable pour les tests. */
  today: string;
  mode: CoherenceMode;
  /** Corrélation des écritures déléguées (`coherence:<campagne|ciblé>:<contrôle>`). */
  correlationId: string;
  /** Lot 83E : périmètre du compte (absent : ELIGIBLE). */
  accountScope?: AccountScope;
  /** Lot 91B : déclencheur du contrôle en cours (posé par le moteur). */
  trigger?: ControlTrigger;
  /** Lot 91B : campagne en cours (null : contrôle ciblé). */
  campaignId?: number | null;
}

/** Lot 91B — issue d'un objet SANS réparation tentée (constat, mode à blanc, anti-boucle…), transmise au contrôle. */
export interface UnrepairedOutcome {
  id: number;
  result: ControlResult;
  inspection?: Inspection;
  /** Résultat précédent de la preuve (anti-boucle : ce qui a été tenté). */
  previousResult?: string | null;
}

/** Lot 91B — objet à reprendre par un rattrapage (aucune issue persistée récente). */
export interface CatchupCandidate {
  accountId: number;
  objectId: number;
  /** Motif consigné dans la demande de contrôle (`NEVER_CONTROLLED`, `NO_RECENT_OUTCOME`…). */
  reason: string;
}

interface CheckEvent {
  /** Type d'événement métier (`DOCUMENT_UPDATED`, `SOURCE_ANALYZED`…). */
  type: string;
  entityId: number | null;
  /** Bien concerné, s'il est connu (analyse T1). */
  assetId?: number | null;
}

export interface CoherenceCheck {
  /** Identifiant stable (`COH-…`). */
  id: string;
  /** Version des règles : la changer rend le stock à réexaminer (§6.4). */
  version: number;
  /**
   * ACTIVE : exécuté par l'orchestrateur ; PLANNED : point d'extension
   * DÉCLARÉ (jamais exécuté ni compté comme couvert) — la couverture le
   * signale comme lacune explicite.
   */
  status: 'ACTIVE' | 'PLANNED';
  title: string;
  domain: string;
  /** N1 structure, N2 cohérence métier, N3 exhaustivité fonctionnelle (CDC §3.3). */
  level: 'N1' | 'N2' | 'N3';
  /** Type d'objet contrôlé (preuve par objet). */
  objectType: string;
  /** Objets examinés (périmètre exact). */
  scope: string;
  sources: readonly string[];
  applicability: string;
  invariant: string;
  anomalies: readonly string[];
  autoRepairWhen: string;
  forbiddenRepairs: readonly string[];
  services: readonly string[];
  /** Maillons vérifiés, dans l'ordre de la chaîne (§3.2). */
  chain: readonly ChainLink[];
  /** Événements métier qui demandent un contrôle ciblé. */
  triggers: readonly string[];
  frequency: string;
  criticality: 'LOW' | 'MEDIUM' | 'HIGH';
  /** Tests de non-régression associés (identifiants). */
  tests: readonly string[];
  /**
   * Lot 83E (C-Q10) : le contrôle peut CONSTATER l'état d'abonnement d'un
   * compte non éligible du fait de son abonnement (lecture seule : état local
   * et lecture Stripe) — jamais de traitement métier ni de réparation sur ce
   * compte. Absent : le contrôle ne s'exécute que sur les comptes éligibles.
   */
  ineligibleAccounts?: 'SUBSCRIPTION_STATE_READ';
  /**
   * Lot 84A (décision PO L83-Q1) : sur un compte non éligible DU FAIT DE SON
   * ABONNEMENT (périmètre SUBSCRIPTION_STATE_READ), la réparation de ce
   * contrôle est PERMISE en mode correctif. Réservé aux contrôles dont la
   * réparation est une opération de FACTURATION (resynchronisation de
   * l'abonnement depuis Stripe), jamais un traitement métier ; n'a d'effet
   * qu'avec `ineligibleAccounts: 'SUBSCRIPTION_STATE_READ'`. Compte suspendu,
   * neutralisé ou archivé : jamais (il n'est même pas lu). Absent : la
   * réparation est neutralisée sur ces comptes (constat FINDING).
   */
  repairOnIneligibleBilling?: boolean;
  /**
   * Lot 83E : les constats de ce contrôle sont DÉJÀ signalés par une
   * supervision existante (identifiant de la tâche ou du mécanisme) — la
   * Supervision de cohérence ne les signale pas une seconde fois comme
   * « persistants » (les échecs de réparation et erreurs restent signalés).
   */
  externalSupervision?: string;
  /**
   * Lot 87B (CODE-05) : réévaluations SÉMANTIQUES que ce contrôle peut
   * demander quand une décision historique est suspecte — `T3` (identité
   * d'une Opération), `T4` (représentation Agenda). Absent : le contrôle ne
   * fait que des reconstructions techniques (ou des constats).
   */
  semanticReevaluation?: ReadonlyArray<'T3' | 'T4'>;
  /** Objets du compte, ordonnés par identifiant croissant, après `afterId`. */
  listObjects?(ctx: CheckContext, accountId: number, afterId: number, limit: number): Promise<number[]>;
  /** Objets du compte touchés par un événement (contrôle ciblé). */
  objectsForEvent?(ctx: CheckContext, accountId: number, event: CheckEvent): Promise<number[]>;
  /** Inspection en LECTURE SEULE d'un lot d'objets du compte. */
  inspect?(ctx: CheckContext, accountId: number, ids: readonly number[]): Promise<Map<number, Inspection>>;
  /** Réparation déléguée aux services métier (mode correctif seulement). */
  repair?(ctx: CheckContext, accountId: number, items: ReadonlyArray<{ id: number; inspection: Inspection }>): Promise<Map<number, RepairResult>>;
  /**
   * Lot 91B — le contrôle PERSISTE dans son propre journal l'issue des
   * objets non réparés (constat, mode à blanc, anti-boucle, relance en
   * attente) : aucune sortie silencieuse. Appelé par le moteur avant la
   * preuve ; jamais une écriture métier ; une erreur n'interrompt rien.
   */
  recordOutcomes?(ctx: CheckContext, accountId: number, items: readonly UnrepairedOutcome[]): Promise<void>;
  /**
   * Lot 91B — anomalies signalées IMMÉDIATEMENT dans la Supervision (dès le
   * premier constat, sans attendre la série « persistante ») : défaut de
   * configuration exploitable (contrat IA absent, journal inutilisable…).
   */
  immediateSupervision?: readonly string[];
  /**
   * Lot 91B — RATTRAPAGE : objets à reprendre sans attendre un événement
   * (jamais contrôlés, ou constat ouvert sans issue persistée récente).
   * `apply` : le contrôle consigne dans son journal pourquoi l'objet n'avait
   * pas été examiné ; l'orchestrateur demande ensuite un contrôle ciblé.
   */
  catchupCandidates?(ctx: {
    sql: Sql; now: Date; limit: number; accountId?: number | null; apply: boolean;
    /** Éligibilité du compte (règle 82A) : seuls les comptes éligibles sont repris. */
    eligible?: (accountId: number) => Promise<boolean>;
  }): Promise<CatchupCandidate[]>;
}

/** Résultat consigné dans la preuve de contrôle d'un objet. */
export type ControlResult =
  | 'CONSISTENT' | 'GONE' | 'REPAIRED' | 'WOULD_REPAIR' | 'AMBIGUOUS' | 'FINDING'
  | 'REPAIR_FAILED' | 'REPAIR_INEFFECTIVE' | 'REPAIR_SUPPRESSED' | 'REPAIR_PENDING' | 'ERROR';

/** Résultats « cohérents » (aucun constat ouvert). */
export const RESOLVED_RESULTS: ReadonlySet<ControlResult> = new Set(['CONSISTENT', 'GONE', 'REPAIRED']);
