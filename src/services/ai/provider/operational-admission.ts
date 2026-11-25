/**
 * ADMISSION D'UN ENVOI vers une route IA — lot 115, carte Trello #786
 * (« Corriger les 8 écarts du lot 114Q »), écarts E01, E02, E03, E06, E08.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE FRONTIÈRE, FRANCHIE PAR TOUS LES ENVOIS
 *
 * #771 (lot 114Q) contrôlait la disponibilité RANG PAR RANG dans la
 * passerelle. Entre deux rangs, il restait des envois non protégés : essai
 * interne sans schéma, essai diagnostique, passe de réparation, épreuve de
 * qualification, test de clé, sonde du disjoncteur. Et la lecture passait par
 * un cache d'instance toléré 5 s : un verdict publié par une autre instance
 * pouvait laisser partir une requête ordinaire pendant ce délai.
 *
 * Ce module est la frontière COMMUNE : `guardSend` est appelé juste avant
 * CHAQUE envoi (`SEND_POINTS` les recense), et lit l'état partagé DÉJÀ
 * ÉTABLI — une seule ligne, par clé primaire, sans délai de tolérance, sans
 * sonde du catalogue et sans recherche du « meilleur modèle ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POLITIQUE DE VALIDITÉ (E06) — table unique, testée
 *
 *   état partagé lu                       envoi ORDINAIRE   sonde autorisée
 *   ────────────────────────────────────  ────────────────  ───────────────
 *   refus confirmé (`failed_confirmed`)   REFUSÉ            permise (bornée)
 *   sain (`ok`)                           admis             permise
 *   à confirmer / non concluant           admis             permise
 *   absent, inconnu (lecture FIABLE)      admis             permise
 *   lecture impossible, verdict fiable
 *     encore en mémoire                   ce verdict        permise
 *   lecture impossible, aucun verdict
 *     fiable (démarrage à froid)          SUSPENDU          permise
 *
 * Un refus confirmé n'expire JAMAIS en autorisation : ni par ancienneté du
 * verdict, ni par expiration d'un cache, ni par panne de base. Un état
 * inconnu n'est jamais une indisponibilité (il ne retire aucun modèle) ;
 * c'est l'IMPOSSIBILITÉ DE VÉRIFIER qui suspend les envois concernés — sans
 * déclarer le modèle retiré, et sans bloquer l'application (les traitements
 * sans IA, le BO et le reste continuent).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CARTE #786 — IDENTITÉ DE ROUTE, PREUVE PAR ROUTE, DÉPART CONFIRMÉ
 *
 *   · A01 / C01 — une route a une IDENTITÉ immuable à six dimensions
 *     (`RouteIdentity`, `routeKeyOf`) : modèle, capacité, EMPREINTE D'ACCÈS,
 *     environnement, point d'accès, version d'API. C'est elle qui indexe le
 *     dernier verdict fiable — plus `modèle + capacité`. Un refus de l'accès
 *     A ne s'applique donc jamais à l'accès B ;
 *   · A01 — la preuve « j'ai déjà lu l'état » est PAR ROUTE
 *     (`routesLuesFiablement`), plus un booléen d'instance. Une route jamais
 *     lue + base inaccessible = `ADMISSION_UNVERIFIABLE` : aucun départ, et
 *     le modèle n'est PAS déclaré retiré ;
 *   · A02 — `guardSend` et `publishedVerdictOf` acceptent un CONTEXTE
 *     D'ACCÈS : la clé avec laquelle l'envoi va réellement partir (« Tester
 *     la clé »), jamais journalisée. Par défaut, la clé active ;
 *   · B01 — la garde capture la VERSION publiée de l'état, et
 *     `confirmDeparture` la recompare juste avant le départ réseau : un
 *     verdict publié entre les deux arrête l'envoi. La fenêtre résiduelle
 *     irréductible est documentée sur `confirmDeparture` ;
 *   · D03 — les mesures distinguent AUTORISÉ, RÉELLEMENT PARTI, refusé,
 *     refusé après publication et sonde non envoyée. Aucun coût ni appel
 *     fictif pour un saut.
 *
 * Les sondes explicites de disponibilité et de rétablissement sont la seule
 * exception : bornées par l'échéance partagée et la réservation (E07),
 * tarifées (#770) et dédupliquées. Une qualification N'EST PAS une sonde de
 * récupération.
 *
 * Ce module ne lit ni n'écrit aucun tarif : disponibilité (#771, #786), tarif
 * (#770) et aptitude métier restent trois dimensions distinctes et cumulatives.
 */
import { keyFingerprint } from './access-identity';
import {
  BASE_CAPABILITY, OPERATIONAL_CAPABILITY_LABELS, PROBE_ENDPOINT, ROUTE_API_VERSION,
  type CheckStatus, type OperationalCapability, type ProbeErrorKind,
} from './probe-classification';

// ── #786 (C01) : IDENTITÉ CANONIQUE ET IMMUABLE D'UNE ROUTE ─────────────────

/**
 * #786 (A01, C01) — IDENTITÉ d'une route IA, figée AVANT l'envoi et jamais
 * recalculée à la réception. C'est elle, et elle seule, qui indexe le cache du
 * dernier verdict fiable, les journaux d'admission et la comparaison de deux
 * verdicts.
 *
 * Six dimensions, toutes explicites :
 *   · `model`             modèle exact appelé ;
 *   · `capability`        capacité (et modalité) que l'envoi va solliciter ;
 *   · `accessFingerprint` EMPREINTE non réversible de la clé qui envoie —
 *                         jamais la clé, jamais journalisée telle quelle (le
 *                         BO et les traces n'affichent que `accessLabel`) ;
 *   · `environment`       environnement de l'accès ;
 *   · `endpoint`          point d'accès appelé ;
 *   · `apiVersion`        version du point d'accès.
 *
 * Une dimension que l'application ne connaît pas vaut `null` : elle reste
 * « non renseignée » et n'est JAMAIS fusionnée avec une autre (aucun projet
 * inventé, aucun environnement supposé — E05).
 */
export interface RouteIdentity {
  readonly model: string;
  readonly capability: OperationalCapability;
  readonly accessFingerprint: string | null;
  readonly environment: string | null;
  readonly endpoint: string | null;
  readonly apiVersion: string | null;
}

/** Dimension inconnue, dite comme telle dans la clé (jamais confondue avec une valeur). */
const DIMENSION_INCONNUE = '\u0000?';

/**
 * #786 (A01, C01) — SÉRIALISATION PURE de l'identité de route en clé de cache.
 * Déterministe, stable, sans aucune lecture : deux routes qui ne diffèrent que
 * par leur accès, leur environnement, leur point d'accès ou sa version ont des
 * clés DIFFÉRENTES. C'est ce qui garantit qu'un refus de l'accès A ne s'applique
 * jamais à l'accès B, et qu'une route jamais lue n'hérite d'aucun verdict.
 *
 * L'empreinte d'accès entre dans la clé ; elle n'est pas réversible et ne sort
 * jamais de la mémoire du processus par cette fonction.
 */
export function routeKeyOf(route: RouteIdentity): string {
  return [
    route.model, route.capability, route.accessFingerprint, route.environment, route.endpoint, route.apiVersion,
  ].map((d) => (d == null || d === '' ? DIMENSION_INCONNUE : d)).join('\u0000');
}

/**
 * #786 (A02) — CONTEXTE D'ACCÈS d'un envoi, facultatif : l'accès avec lequel
 * l'envoi va réellement partir, quand ce n'est pas la clé active.
 *   · `secret`      la clé à utiliser pour la lecture du verdict. Elle n'est
 *                   JAMAIS journalisée, ni tracée, ni conservée : seule son
 *                   empreinte est retenue ;
 *   · `fingerprint` l'empreinte, quand l'appelant l'a déjà figée (il n'a alors
 *                   pas besoin de faire circuler le secret).
 * Absent : comportement d'avant la carte #786 — la clé ACTIVE.
 */
export interface RouteAccessContext {
  secret?: string | null;
  fingerprint?: string | null;
}

// ── Inventaire des points d'envoi (E03, R17) ────────────────────────────────

/**
 * Tout point du code qui peut transmettre une requête à un fournisseur d'IA.
 * `kind` dit si l'envoi est ORDINAIRE (soumis au verdict) ou une sonde
 * explicitement autorisée. Cet inventaire est vérifié par un test : un point
 * d'envoi nouveau doit y figurer avec sa garde.
 */
export interface SendPointSpec {
  /** Identifiant du point d'envoi (tracé avec le refus). */
  point: SendPoint;
  kind: SendKind;
  /** Où l'envoi part, en français (recette, BO). */
  label: string;
}

export type SendPoint =
  // Envois ordinaires de la passerelle (tous les traitements T1, T2, T3, T4, T6).
  | 'gateway_rank' | 'gateway_send' | 'gateway_schema_retry' | 'gateway_diagnostic_retry' | 'gateway_repair'
  // Envois ordinaires hors passerelle.
  | 'qualification_trial' | 'provider_key_test' | 'breaker_probe'
  // Sondes explicitement autorisées.
  | 'availability_probe' | 'recovery_probe';

export type SendKind = 'ordinary' | 'authorized_probe';

export const SEND_POINTS: readonly SendPointSpec[] = [
  { point: 'gateway_rank', kind: 'ordinary', label: 'passerelle — admission du rang (principal, repli 1, repli 2, escalade)' },
  { point: 'gateway_send', kind: 'ordinary', label: 'passerelle — départ de la requête au fournisseur' },
  { point: 'gateway_schema_retry', kind: 'ordinary', label: 'passerelle — essai interne sans schéma' },
  { point: 'gateway_diagnostic_retry', kind: 'ordinary', label: 'passerelle — essai diagnostique' },
  { point: 'gateway_repair', kind: 'ordinary', label: 'passerelle — passe de réparation (même modèle)' },
  { point: 'qualification_trial', kind: 'ordinary', label: 'qualification technique — une épreuve' },
  { point: 'provider_key_test', kind: 'ordinary', label: 'BO › Fournisseur — « Tester la clé »' },
  { point: 'breaker_probe', kind: 'ordinary', label: 'disjoncteur — sonde de reprise d’un traitement' },
  { point: 'availability_probe', kind: 'authorized_probe', label: 'sonde de disponibilité (actualisation du catalogue, cron)' },
  { point: 'recovery_probe', kind: 'authorized_probe', label: 'sonde de rétablissement d’une route sautée' },
] as const;

const PAR_POINT = new Map(SEND_POINTS.map((s) => [s.point, s]));

/** Un point d'envoi est-il une sonde explicitement autorisée ? */
export function sendKindOf(point: SendPoint): SendKind {
  return PAR_POINT.get(point)?.kind ?? 'ordinary';
}

// ── Verdict partagé ─────────────────────────────────────────────────────────

/**
 * Verdict PUBLIÉ d'une route (fournisseur, modèle, accès), tel que lu dans
 * l'état partagé. `reliable = false` : la lecture a échoué ou expiré — rien
 * n'est conclu de son contenu.
 */
export interface PublishedVerdict {
  model: string;
  /** État RETENU : `unavailable` refus confirmé, `healthy` sain, `unknown` absent / non concluant. */
  state: 'unavailable' | 'healthy' | 'unknown';
  /** La lecture de l'état partagé a abouti (ligne lue, ou absence certaine). */
  reliable: boolean;
  /** Dernier contrôle retenu (issue), à ne pas confondre avec le dernier résultat reçu. */
  checkStatus: CheckStatus | null;
  error: string | null;
  checkedAt: string | null;
  confirmedAt: string | null;
  nextProbeAt: string | null;
  /** Accès concerné, PSEUDONYMISÉ (jamais la clé). */
  access: string | null;
  /**
   * #786 (A01, A02) — EMPREINTE non réversible de l'accès réellement lu, pour
   * que le verdict soit indexé et comparé par route exacte. Jamais la clé ;
   * jamais journalisée telle quelle (les journaux n'affichent que `access`).
   */
  accessFingerprint?: string | null;
  /**
   * CAPACITÉ (et modalité) pour laquelle le verdict a été DEMANDÉ (E05) : le
   * verdict ne vaut que pour elle.
   */
  askedCapability?: OperationalCapability;
  /**
   * E05 — le refus rendu est celui de la capacité de BASE (génération de
   * texte), opposable à la capacité demandée parce qu'il en est le prérequis.
   * C'est la SEULE extension de portée admise, et elle est dite.
   */
  scopeExtendedFromBase?: true;
  /** Contexte d'accès figé du verdict (E05) : capacité ÉPROUVÉE, point d'accès, environnement, version d'API. */
  capability: string | null;
  endpoint: string | null;
  environment: string | null;
  apiVersion: string | null;
  /** Dernier RÉSULTAT reçu, conservé à part du verdict (E04) : un non concluant ne lève pas un refus. */
  lastResultStatus: CheckStatus | null;
  lastResultAt: string | null;
  lastResultKind: ProbeErrorKind | null;
  /** Lecture impossible : le verdict rendu vient du dernier instantané FIABLE de cette instance. */
  fromLastReliable?: boolean;
}

/** Verdict « rien de lu, rien de conclu » (ne retire aucun modèle par lui-même). */
export function unknownVerdict(model: string, reliable: boolean, capability: OperationalCapability = BASE_CAPABILITY): PublishedVerdict {
  return {
    model, state: 'unknown', reliable, checkStatus: null, error: null, checkedAt: null, confirmedAt: null,
    nextProbeAt: null, access: null, askedCapability: capability, capability: null, endpoint: null, environment: null, apiVersion: null,
    lastResultStatus: null, lastResultAt: null, lastResultKind: null,
  };
}

// ── Décision d'admission (pure) ─────────────────────────────────────────────

export type AdmissionCode = 'MODEL_UNAVAILABLE' | 'ADMISSION_UNVERIFIABLE';

export type SendAdmission =
  | {
    admitted: true; reason: 'AVAILABLE' | 'UNKNOWN_NOT_BLOCKING' | 'AUTHORIZED_PROBE' | 'DIMENSION_INACTIVE'; verdict: PublishedVerdict;
    /** #786 (C01) : identité de route figée par la garde (absente : garde purement locale, en test). */
    route?: RouteIdentity;
    /**
     * #786 (B01) : VERSION publiée de l'état opérationnel au moment de la
     * garde. `confirmDeparture` la compare juste avant le départ réseau :
     * si elle a changé, le verdict est relu. `null` : version illisible.
     */
    publishedVersion?: number | null;
    /** #786 (B01, D03) : point d'envoi, pour corréler garde → départ réel. */
    point?: SendPoint;
    /** #786 (D03) : identifiant stable du contrôle / de la tentative, figé à la source. */
    checkId?: string | null;
  }
  | {
    admitted: false; code: AdmissionCode; label: string; verdict: PublishedVerdict;
    route?: RouteIdentity; point?: SendPoint; checkId?: string | null;
  };

/** Libellés de refus d'admission — à valider par le PO. */
export const ADMISSION_REFUSAL_LABELS: Readonly<Record<AdmissionCode, string>> = {
  MODEL_UNAVAILABLE: 'route confirmée indisponible pour cet accès : aucune requête n’est envoyée',
  ADMISSION_UNVERIFIABLE:
    'disponibilité de la route invérifiable (état partagé illisible et aucun verdict fiable en mémoire) : '
    + 'envoi suspendu par prudence, le modèle n’est pas déclaré retiré',
};

/**
 * Cet envoi peut-il partir (PURE) ? `verdict` est le verdict partagé lu à la
 * frontière ; `dimensionActive = false` quand la disponibilité n'est pas
 * instrumentée dans ce processus (tests unitaires sans base) : rien n'est
 * alors ni refusé ni suspendu.
 */
export function admitSend(p: {
  point: SendPoint;
  verdict: PublishedVerdict;
  dimensionActive: boolean;
}): SendAdmission {
  const { verdict } = p;
  if (!p.dimensionActive) return { admitted: true, reason: 'DIMENSION_INACTIVE', verdict };
  // Sonde explicitement autorisée : elle doit ATTEINDRE la route pour trancher
  // (bornée par l'échéance partagée et la réservation — jamais une qualification).
  if (sendKindOf(p.point) === 'authorized_probe') return { admitted: true, reason: 'AUTHORIZED_PROBE', verdict };
  // Refus confirmé : opposable, qu'il vienne de la lecture ou du dernier verdict fiable.
  // #786 (E05) : il ne vaut que pour la CAPACITÉ du verdict rendu — la lecture (`readPublishedVerdict`) a déjà
  // écarté le refus d'une autre capacité, et DIT quand le refus vient de la capacité de base.
  if (verdict.state === 'unavailable') {
    const portee = verdict.scopeExtendedFromBase
      ? `${ADMISSION_REFUSAL_LABELS.MODEL_UNAVAILABLE} (refus de la capacité de base, prérequis de `
        + `« ${OPERATIONAL_CAPABILITY_LABELS[verdict.askedCapability ?? BASE_CAPABILITY]} »)`
      : verdict.askedCapability && verdict.askedCapability !== BASE_CAPABILITY
        ? `${ADMISSION_REFUSAL_LABELS.MODEL_UNAVAILABLE} (capacité « ${OPERATIONAL_CAPABILITY_LABELS[verdict.askedCapability]} » seulement)`
        : ADMISSION_REFUSAL_LABELS.MODEL_UNAVAILABLE;
    return { admitted: false, code: 'MODEL_UNAVAILABLE', label: portee, verdict };
  }
  // Lecture impossible ET aucun verdict fiable : admission invérifiable.
  if (!verdict.reliable && !verdict.fromLastReliable) {
    return { admitted: false, code: 'ADMISSION_UNVERIFIABLE', label: ADMISSION_REFUSAL_LABELS.ADMISSION_UNVERIFIABLE, verdict };
  }
  return { admitted: true, reason: verdict.state === 'healthy' ? 'AVAILABLE' : 'UNKNOWN_NOT_BLOCKING', verdict };
}

// ── Mesures (E08) ───────────────────────────────────────────────────────────

/**
 * Décomptes fidèles de l'admission (supervision, R17) : envois autorisés,
 * envois refusés par motif, sondes autorisées passées. Aucun coût ni appel
 * fictif n'est compté pour un envoi refusé : il n'a jamais eu lieu.
 */
export interface AdmissionMetrics {
  /** AUTORISÉ par la garde — ce n'est PAS la preuve qu'une requête est partie (#786, D03). */
  allowed: number;
  refusedUnavailable: number;
  refusedUnverifiable: number;
  authorizedProbes: number;
  /** Verdicts rendus depuis le dernier instantané fiable (base illisible). */
  servedFromLastReliable: number;
  /**
   * #786 (D03) — DÉPART RÉELLEMENT EFFECTUÉ : la confirmation de départ a
   * laissé passer la requête, qui est donc partie sur le réseau. Distinct de
   * `allowed` : entre les deux, un verdict peut avoir été publié.
   */
  departed: number;
  /**
   * #786 (B01, D03) — départs ANNULÉS entre la garde et le départ réseau
   * parce qu'un verdict a été publié entre-temps : autorisés, jamais partis.
   */
  refusedAfterPublication: number;
  /**
   * #786 (D03) — SONDES NON ENVOYÉES (réservation non obtenue, incident
   * global, échéance non atteinte, base illisible). Une sonde non envoyée
   * n'est jamais un état sain : elle est comptée comme telle, à part.
   */
  probesNotSent: number;
  /**
   * #786 (B01, D03) — départs effectués SANS avoir pu comparer la version
   * publiée (clé de version illisible, ou dimension non instrumentée). Comptés
   * à part : la garantie d'ordre n'est pas démontrée pour ceux-là, et cela doit
   * se voir au BO plutôt que de rester silencieux.
   */
  departuresWithoutVersionCheck: number;
  /** Par point d'envoi : autorisés / réellement partis / refusés (#786, D03). */
  byPoint: Record<string, { allowed: number; departed: number; refused: number }>;
}

const mesures: AdmissionMetrics = {
  allowed: 0, refusedUnavailable: 0, refusedUnverifiable: 0, authorizedProbes: 0, servedFromLastReliable: 0,
  departed: 0, refusedAfterPublication: 0, probesNotSent: 0, departuresWithoutVersionCheck: 0, byPoint: {},
};

const entreeDe = (point: SendPoint): { allowed: number; departed: number; refused: number } =>
  (mesures.byPoint[point] ??= { allowed: 0, departed: 0, refused: 0 });

function compter(point: SendPoint, a: SendAdmission): void {
  const e = entreeDe(point);
  if (a.verdict.fromLastReliable) mesures.servedFromLastReliable++;
  if (a.admitted) {
    e.allowed++;
    mesures.allowed++;
    if (a.reason === 'AUTHORIZED_PROBE') mesures.authorizedProbes++;
    return;
  }
  e.refused++;
  if (a.code === 'MODEL_UNAVAILABLE') mesures.refusedUnavailable++;
  else mesures.refusedUnverifiable++;
}

/** #786 (D03) : départ RÉELLEMENT effectué, ou annulé après publication. */
function compterDepart(point: SendPoint | undefined, parti: boolean): void {
  const e = entreeDe(point ?? 'gateway_send');
  if (parti) { e.departed++; mesures.departed++; return; }
  e.refused++;
}

/**
 * #786 (D03) — JOURNAL CORRÉLÉ des départs, pour que « autorisé » et
 * « réellement parti » ne puissent pas être confondus à la lecture.
 *
 * Chaque entrée relie, pour UN départ : la ROUTE (clé canonique complète,
 * `routeKeyOf`), l'identifiant de CONTRÔLE figé à la source, la VERSION
 * publiée lue juste avant le départ, le WORKER (identifiant de processus) et
 * l'issue — parti, ou annulé parce qu'un verdict a été publié entre-temps.
 *
 * Borné à `JOURNAL_DEPARTS_MAX` entrées (anneau) : c'est un journal de
 * supervision, pas un stockage. Il ne porte ni secret, ni donnée de compte —
 * seulement l'empreinte d'accès déjà pseudonymisée par la clé de route.
 */
export interface DepartureRecord {
  routeKey: string;
  model: string;
  capability: OperationalCapability;
  point: SendPoint;
  /** Identifiant stable du contrôle / de la tentative, figé à la source (`null` : non transmis). */
  checkId: string | null;
  /** Version publiée de l'état opérationnel lue juste avant le départ (`null` : illisible). */
  version: number | null;
  /** Worker : identifiant du processus qui a envoyé (jamais une donnée de compte). */
  worker: string;
  outcome: 'departed' | 'cancelled_after_publication';
  at: string;
}

const JOURNAL_DEPARTS_MAX = 50;
const journalDeparts: DepartureRecord[] = [];
const WORKER_ID = `${process.pid}`;

function journaliserDepart(e: Omit<DepartureRecord, 'at' | 'worker'>): void {
  journalDeparts.push({ ...e, worker: WORKER_ID, at: new Date().toISOString() });
  if (journalDeparts.length > JOURNAL_DEPARTS_MAX) journalDeparts.splice(0, journalDeparts.length - JOURNAL_DEPARTS_MAX);
}

/** #786 (D03) : derniers départs corrélés de cette instance (copie, du plus ancien au plus récent). */
export function departureJournal(): DepartureRecord[] {
  return journalDeparts.map((e) => ({ ...e }));
}

/**
 * #786 (D03) — une SONDE n'est pas partie (réservation tenue ailleurs,
 * incident global, échéance non atteinte, lecture impossible). À appeler par
 * les producteurs de sondes : jamais « tout sain » faute de sonde.
 */
export function noteProbeNotSent(): void {
  mesures.probesNotSent++;
}

/** Instantané des décomptes d'admission (copie). */
export function admissionMetrics(): AdmissionMetrics {
  return { ...mesures, byPoint: Object.fromEntries(Object.entries(mesures.byPoint).map(([k, v]) => [k, { ...v }])) };
}

/** Réservé aux tests et au démarrage : remet les décomptes à zéro. */
export function __resetAdmissionMetrics(): void {
  mesures.allowed = 0; mesures.refusedUnavailable = 0; mesures.refusedUnverifiable = 0;
  mesures.authorizedProbes = 0; mesures.servedFromLastReliable = 0;
  mesures.departed = 0; mesures.refusedAfterPublication = 0; mesures.probesNotSent = 0;
  mesures.departuresWithoutVersionCheck = 0;
  for (const k of Object.keys(mesures.byPoint)) delete mesures.byPoint[k];
  journalDeparts.length = 0;
}

// ── Dernier verdict FIABLE connu de cette instance (E01) ────────────────────

/**
 * Dernier verdict lu de façon FIABLE, PAR ROUTE COMPLÈTE (`routeKeyOf`). Il
 * survit à une panne de base : les interdictions sont conservées, et un refus
 * confirmé n'est jamais remplacé par « inconnu » faute de lecture.
 *
 * Aucune éviction, aucun TTL : un refus confirmé mémorisé reste opposable
 * INDÉFINIMENT. Ce n'est pas un cache de performance — c'est la mémoire des
 * interdictions, et l'ancienneté d'un refus ne l'a jamais levé (E06).
 */
const dernierFiable = new Map<string, PublishedVerdict>();

/**
 * #786 (A01) — ROUTES effectivement lues de façon FIABLE par cette instance.
 *
 * Règle remplacée (carte #786) : un booléen GLOBAL `lectureFiableObtenue`
 * tenait lieu de preuve. Une seule lecture réussie sur la route A rendait
 * alors « inconnu non bloquant » pour une route B JAMAIS lue, et `admitSend`
 * laissait partir la requête pendant une panne de base.
 *
 * Désormais la preuve est PAR ROUTE : si B n'est pas dans cet ensemble et que
 * la base est inaccessible, `lastReliableVerdict` rend `null` et `admitSend`
 * refuse avec `ADMISSION_UNVERIFIABLE` — aucun départ sur B, SANS déclarer B
 * retirée (l'inconnu ne retire jamais un modèle : c'est l'impossibilité de
 * VÉRIFIER qui suspend, et seulement les envois concernés).
 */
const routesLuesFiablement = new Set<string>();

/** Identité de la route telle que le verdict la décrit (pure). */
function routeOfVerdict(v: PublishedVerdict): RouteIdentity {
  return {
    model: v.model, capability: v.askedCapability ?? BASE_CAPABILITY,
    accessFingerprint: v.accessFingerprint ?? null,
    environment: v.environment ?? null, endpoint: v.endpoint ?? null, apiVersion: v.apiVersion ?? null,
  };
}

/**
 * Mémorise un verdict lu de façon fiable (E01), sous l'identité de route
 * `route` — celle qui a été DEMANDÉE, figée avant la lecture, et non celle
 * que la ligne lue décrirait (une ligne absente ne décrit aucune route).
 */
export function rememberReliableVerdict(v: PublishedVerdict, route?: RouteIdentity): void {
  if (!v.reliable) return;
  const cle = routeKeyOf(route ?? routeOfVerdict(v));
  routesLuesFiablement.add(cle);
  dernierFiable.set(cle, { ...v, fromLastReliable: false });
}

/**
 * Verdict de repli quand la lecture est impossible : le dernier verdict fiable
 * de CETTE route, sinon — si cette instance n'a JAMAIS lu CETTE route —
 * `null`, ce qui vaut « admission invérifiable » (aucun départ).
 *
 * Une route lue fiablement comme ABSENTE reste admise : l'inconnu ne retire
 * aucun modèle (P04). Un refus confirmé mémorisé reste opposable sans limite
 * d'âge.
 *
 * #786 (A01) — l'empreinte d'accès fait partie de la clé : un refus de
 * l'accès A n'est jamais servi pour l'accès B, et une route jamais lue sur B
 * n'hérite d'aucun verdict de A.
 */
export function lastReliableVerdict(route: RouteIdentity): PublishedVerdict | null {
  const cle = routeKeyOf(route);
  const exact = dernierFiable.get(cle);
  if (exact) return { ...exact, reliable: false, fromLastReliable: true };
  // #786 (E05) : à défaut de verdict pour cette capacité, celui de la capacité de BASE du MÊME accès. Une
  // lecture de route rend TOUTES ses capacités (`readPublishedVerdict`) : avoir lu la base, c'est avoir lu la
  // route. Le refus de base est opposable (prérequis) ; il ne vaut jamais AUTORISATION d'une autre capacité.
  if (route.capability !== BASE_CAPABILITY) {
    const cleBase = routeKeyOf({ ...route, capability: BASE_CAPABILITY });
    const base = dernierFiable.get(cleBase);
    if (base) {
      return base.state === 'unavailable'
        ? { ...base, reliable: false, fromLastReliable: true, askedCapability: route.capability, scopeExtendedFromBase: true }
        : { ...unknownVerdict(route.model, false, route.capability), fromLastReliable: true };
    }
    if (routesLuesFiablement.has(cleBase)) return { ...unknownVerdict(route.model, false, route.capability), fromLastReliable: true };
  }
  if (routesLuesFiablement.has(cle)) return { ...unknownVerdict(route.model, false, route.capability), fromLastReliable: true };
  // Cette route n'a JAMAIS été lue de façon fiable : rien n'est conclu, et rien ne part.
  return null;
}

/** Réservé aux tests : oublie les verdicts fiables mémorisés (démarrage à froid). */
export function __resetLastReliableVerdicts(): void {
  dernierFiable.clear();
  routesLuesFiablement.clear();
}

// ── Frontière commune ───────────────────────────────────────────────────────

/** Erreur d'un envoi refusé à la frontière (hors passerelle, qui a son propre trajet). */
export class ModelSendRefused extends Error {
  readonly code: AdmissionCode;
  readonly model: string;
  readonly point: SendPoint;
  readonly checkedAt: string | null;
  constructor(a: Extract<SendAdmission, { admitted: false }>, point: SendPoint) {
    super(`« ${a.verdict.model} » : ${a.label}${a.verdict.error ? ` (${a.verdict.error})` : ''}.`);
    this.name = 'ModelSendRefused';
    this.code = a.code;
    this.model = a.verdict.model;
    this.point = point;
    this.checkedAt = a.verdict.checkedAt;
  }
}

/**
 * Lecteur du verdict partagé (injecté en test, sinon la lecture canonique).
 * `route` porte l'identité COMPLÈTE demandée (#786, C01) : un lecteur simulé
 * peut donc distinguer deux accès, deux environnements ou deux versions d'API.
 */
export type PublishedVerdictReader = (model: string, capability: OperationalCapability, route: RouteIdentity) => Promise<PublishedVerdict>;

let lecteurInjecte: PublishedVerdictReader | null = null;
let actifEnTest = false;

/**
 * Réservé aux tests : lecteur simulé du verdict partagé (`null` : lecture
 * canonique). La dimension devient ACTIVE : la garde s'applique.
 */
export function __setPublishedVerdictReaderForTests(r: PublishedVerdictReader | null): void {
  lecteurInjecte = r;
  __resetLastReliableVerdicts();
  __resetAdmissionMetrics();
}

/** Réservé aux e2e : autorise la lecture canonique sous `NODE_ENV=test`. */
export function __enableAdmissionDbForTests(on: boolean): void {
  actifEnTest = on;
  __resetLastReliableVerdicts();
}

/**
 * La dimension « disponibilité » est-elle instrumentée dans ce processus ?
 * Faux en test unitaire sans lecteur injecté (convention de `db/index.ts` :
 * aucune connexion) — aucun envoi n'est alors refusé ni suspendu.
 */
export function admissionActive(): boolean {
  return lecteurInjecte !== null || process.env.NODE_ENV !== 'test' || actifEnTest;
}

// ── #786 (C01) : construction de l'identité de route, figée avant l'envoi ───

/** Environnement de l'accès, relu une fois par processus (`null` : non renseigné, jamais supposé). */
let environnementConnu: string | null | undefined;

async function environnementDeLAcces(): Promise<string | null> {
  if (environnementConnu !== undefined) return environnementConnu;
  try {
    environnementConnu = (await import('../config/environment')).getAiEnvironment();
  } catch {
    environnementConnu = null;
  }
  return environnementConnu;
}

/**
 * #786 (A02, C01) — identité COMPLÈTE de la route que cet envoi va emprunter,
 * figée AVANT la lecture du verdict et AVANT le départ.
 *
 * L'empreinte d'accès vient, dans l'ordre : de l'empreinte fournie par
 * l'appelant, de l'empreinte du secret qu'il va réellement employer, sinon de
 * la clé ACTIVE. Le secret transmis ne sert qu'à calculer son empreinte — il
 * n'est ni conservé, ni journalisé, ni rendu.
 */
export async function routeIdentityOf(p: {
  model: string; capability?: OperationalCapability; access?: RouteAccessContext;
}): Promise<RouteIdentity> {
  const capability = p.capability ?? BASE_CAPABILITY;
  let accessFingerprint: string | null = p.access?.fingerprint ?? null;
  if (accessFingerprint === null) {
    try {
      // `access-identity` est pur : l'empreinte est figée sur le chemin chaud sans charger la persistance,
      // et le secret transmis ne sert qu'à cela (jamais conservé, jamais journalisé).
      if (p.access?.secret != null && p.access.secret !== '') {
        accessFingerprint = keyFingerprint(p.access.secret);
      } else if (p.access !== undefined && 'secret' in p.access) {
        // L'appelant a dit « cet accès » et n'a pas de clé : aucune route n'existe, rien n'est deviné.
        accessFingerprint = null;
      } else {
        const actif = await (await import('./provider-secret')).getProviderSecret('gemini');
        accessFingerprint = actif ? keyFingerprint(actif) : null;
      }
    } catch {
      accessFingerprint = null;
    }
  }
  return {
    model: p.model, capability, accessFingerprint,
    environment: await environnementDeLAcces(), endpoint: PROBE_ENDPOINT, apiVersion: ROUTE_API_VERSION,
  };
}

/**
 * Verdict partagé d'une route et d'une CAPACITÉ, lu à la frontière (ne lève
 * jamais). `access` dit avec QUEL accès l'envoi va partir (#786, A02) : par
 * défaut, la clé active — comportement d'avant la carte.
 */
export async function publishedVerdictOf(
  model: string, capability: OperationalCapability = BASE_CAPABILITY, access?: RouteAccessContext,
): Promise<PublishedVerdict> {
  const route = await routeIdentityOf({ model, capability, access });
  return publishedVerdictOfRoute(route, access);
}

/** Même lecture, pour un appelant qui a DÉJÀ figé l'identité de route (passerelle, confirmation de départ). */
export async function publishedVerdictOfRoute(route: RouteIdentity, access?: RouteAccessContext): Promise<PublishedVerdict> {
  const { model, capability } = route;
  const marquer = (v: PublishedVerdict): PublishedVerdict => ({ ...v, accessFingerprint: route.accessFingerprint });
  if (lecteurInjecte) {
    try {
      const v = marquer(await lecteurInjecte(model, capability, route));
      rememberReliableVerdict(v, route);
      return v.reliable ? v : lastReliableVerdict(route) ?? v;
    } catch {
      return lastReliableVerdict(route) ?? unknownVerdict(model, false, capability);
    }
  }
  if (!admissionActive()) return unknownVerdict(model, true, capability);
  try {
    const { readPublishedVerdict } = await import('./model-operational.service');
    // #786 (A02) : la lecture porte sur l'accès de la ROUTE — jamais sur la clé active quand l'envoi part
    // avec une autre clé. L'empreinte figée suffit : le secret n'a pas à circuler jusqu'ici.
    const v = marquer(await readPublishedVerdict(model, access?.secret, capability, route.accessFingerprint));
    if (v.reliable) {
      rememberReliableVerdict(v, route);
      return v;
    }
    return lastReliableVerdict(route) ?? v;
  } catch {
    return lastReliableVerdict(route) ?? unknownVerdict(model, false, capability);
  }
}

/**
 * GARDE COMMUNE, à franchir juste avant chaque envoi : lit l'état partagé de
 * la route et rend la décision. Ne lève jamais ; ne fait AUCUN appel
 * fournisseur ; aucune sonde, aucune recherche de modèle.
 */
export async function guardSend(p: {
  model: string; point: SendPoint;
  /** #786 (E05) : capacité (et modalité) que cet envoi va solliciter. Par défaut : la capacité de base. */
  capability?: OperationalCapability;
  /**
   * #786 (A02) : accès avec lequel cet envoi va RÉELLEMENT partir, quand ce
   * n'est pas la clé active (« Tester la clé », campagne sur une clé donnée).
   * Le secret transmis ne sert qu'à figer son empreinte : il n'est jamais
   * journalisé. Par défaut : la clé active (comportement d'avant la carte).
   */
  access?: RouteAccessContext;
  /**
   * #786 (D03) : identifiant stable de la tentative, figé à la source. Il n'est
   * employé QUE pour corréler garde → départ réel dans le journal des départs ;
   * il n'intervient dans aucune décision d'admission.
   */
  checkId?: string | null;
}): Promise<SendAdmission> {
  const dimensionActive = admissionActive();
  const capability = p.capability ?? BASE_CAPABILITY;
  const sonde = sendKindOf(p.point) === 'authorized_probe';
  const route = await routeIdentityOf({ model: p.model, capability, access: p.access });
  // Sonde autorisée : aucune lecture nécessaire (elle doit atteindre la route).
  const verdict = sonde || !dimensionActive
    ? unknownVerdict(p.model, true, capability)
    : await publishedVerdictOfRoute(route, p.access);
  const a = admitSend({ point: p.point, verdict, dimensionActive });
  compter(p.point, a);
  if (!a.admitted) {
    // Journal (E08) : envoi refusé, sans secret ni donnée de compte.
    console.info(`[ia-admission] envoi refusé — ${p.model} (${p.point}, ${capability}) : ${a.code}${a.verdict.access ? `, accès ${a.verdict.access}` : ''}${a.verdict.scopeExtendedFromBase ? ', refus de la capacité de base' : ''}${a.verdict.fromLastReliable ? ', dernier verdict fiable' : ''}.`);
    return { ...a, route, point: p.point, checkId: p.checkId ?? null };
  }
  // #786 (B01) : VERSION publiée lue APRÈS le verdict — `confirmDeparture` la recompare juste avant le
  // départ réseau. Lecture mono-ligne par clé primaire, hors transaction ; illisible : `null` (la
  // confirmation relira alors le verdict par prudence).
  const publishedVersion = sonde || !dimensionActive ? null : await lireVersionPubliee();
  return { ...a, route, point: p.point, checkId: p.checkId ?? null, publishedVersion };
}

/** Version publiée de l'état opérationnel (ne lève jamais ; `null` : illisible ou dimension inactive). */
async function lireVersionPubliee(): Promise<number | null> {
  if (lecteurInjecte) return lecteurVersionInjecte ? await lecteurVersionInjecte().catch(() => null) : null;
  try {
    return await (await import('./model-operational.service')).readOperationalVersion();
  } catch {
    return null;
  }
}

let lecteurVersionInjecte: (() => Promise<number | null>) | null = null;

/** Réservé aux tests : lecteur simulé de la version publiée (`null` : lecture canonique). */
export function __setOperationalVersionReaderForTests(r: (() => Promise<number | null>) | null): void {
  lecteurVersionInjecte = r;
}

// ── #786 (B01, D03) : CONFIRMATION DE DÉPART ────────────────────────────────

/**
 * Issue de la confirmation de départ. `departed = true` : la requête PART
 * (et le départ est compté comme réellement effectué). `departed = false` :
 * un verdict a été publié entre la garde et le départ, et la route est devenue
 * indisponible — rien ne part.
 */
export type DepartureConfirmation =
  | { departed: true; reason: 'UNCHANGED' | 'REREAD_STILL_ADMITTED'; version: number | null }
  | { departed: false; code: AdmissionCode; label: string; verdict: PublishedVerdict; version: number | null };

/**
 * #786 (B01) — DERNIÈRE VÉRIFICATION AVANT LE DÉPART RÉSEAU.
 *
 * La garde a lu le verdict ET la version publiée de l'état opérationnel. Cette
 * version est incrémentée DANS LA TRANSACTION qui publie un verdict
 * (`bumpOperationalVersion`) : elle change donc si, et seulement si, un
 * verdict a été publié depuis la garde — par n'importe quel worker. Si elle a
 * changé, le verdict de la route est RELU et l'envoi refusé si la route est
 * devenue indisponible.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * FENÊTRE RÉSIDUELLE IRRÉDUCTIBLE — dite honnêtement
 *
 * Il reste une fenêtre entre cette dernière lecture de version et l'écriture
 * effective de la requête sur la socket. Elle ne peut pas être fermée sans
 * tenir une transaction de base ouverte pendant toute la génération (jusqu'à
 * plusieurs minutes), ce que la carte interdit explicitement, ni sans un
 * verrou distribué sur le chemin chaud de chaque appel.
 *
 * Ce qui la BORNE :
 *   · sa durée est celle d'une lecture mono-ligne par clé primaire suivie de
 *     l'appel système d'envoi — quelques millisecondes, contre les ~5 s du
 *     cache d'instance supprimé par le lot 115I ;
 *   · aucune opération lente, aucune construction de requête, aucun `await`
 *     ne s'intercale : la capture est faite AVANT (voir `capturing.call`) ;
 *   · une requête partie dans cette fenêtre est une requête DÉJÀ ENVOYÉE au
 *     sens du ticket : elle a le droit de finir. Aucune NOUVELLE requête ne
 *     part après la publication, parce que la garde et cette confirmation
 *     sont repassées à chaque tentative (initiale, sans schéma, diagnostique,
 *     réparation, rang suivant, escalade) ;
 *   · le refus reste opposable indéfiniment ensuite : la fenêtre ne se
 *     rouvre pas, et aucun délai de tolérance ne la prolonge.
 * Seule la recette R03 à deux vrais processus peut mesurer cette fenêtre ;
 * elle n'a PAS été exécutée dans l'environnement de développement.
 * ──────────────────────────────────────────────────────────────────────────
 */
export async function confirmDeparture(a: SendAdmission): Promise<DepartureConfirmation> {
  if (!a.admitted) {
    return { departed: false, code: a.code, label: a.label, verdict: a.verdict, version: null };
  }
  // Sonde autorisée, dimension inactive, ou garde sans route figée : rien à recomparer.
  if (a.route === undefined || a.reason === 'AUTHORIZED_PROBE' || a.reason === 'DIMENSION_INACTIVE') {
    compterDepart(a.point, true);
    return { departed: true, reason: 'UNCHANGED', version: a.publishedVersion ?? null };
  }
  const journaliser = (outcome: DepartureRecord['outcome'], version: number | null): void => {
    journaliserDepart({
      routeKey: routeKeyOf(a.route!), model: a.route!.model, capability: a.route!.capability,
      point: a.point ?? 'gateway_send', checkId: a.checkId ?? null, version, outcome,
    });
  };
  const avant = a.publishedVersion ?? null;
  const version = avant === null ? null : await lireVersionPubliee();
  // Version inchangée : aucun verdict n'a été publié depuis la garde — départ immédiat.
  if (version !== null && avant !== null && version === avant) {
    compterDepart(a.point, true);
    journaliser('departed', version);
    return { departed: true, reason: 'UNCHANGED', version };
  }
  /**
   * VERSION ILLISIBLE (d'un côté ou de l'autre) : la confirmation ne peut rien comparer. Le verdict lu par la
   * garde, quelques instants plus tôt, FAIT FOI — le relire ne prouverait rien de plus et doublerait la charge
   * du chemin chaud. Ce cas est COMPTÉ à part (`departuresWithoutVersionCheck`) plutôt que passé sous silence.
   *
   * Il ne crée pas de trou dans la garantie : si la clé de version est illisible, l'état partagé l'est
   * très probablement aussi, et la garde a alors déjà refusé l'envoi faute de lecture fiable
   * (`ADMISSION_UNVERIFIABLE`) ou servi le dernier verdict fiable — dont un refus confirmé.
   */
  if (version === null || avant === null) {
    mesures.departuresWithoutVersionCheck++;
    compterDepart(a.point, true);
    journaliser('departed', version);
    return { departed: true, reason: 'UNCHANGED', version };
  }
  // Version CHANGÉE : un verdict a été publié depuis la garde — le verdict de la route est RELU.
  const verdict = await publishedVerdictOfRoute(a.route);
  const relu = admitSend({ point: a.point ?? 'gateway_send', verdict, dimensionActive: true });
  if (relu.admitted) {
    compterDepart(a.point, true);
    journaliser('departed', version);
    return { departed: true, reason: 'REREAD_STILL_ADMITTED', version };
  }
  mesures.refusedAfterPublication++;
  compterDepart(a.point, false);
  journaliser('cancelled_after_publication', version);
  console.info(`[ia-admission] départ annulé après publication — ${a.route.model} (${a.point ?? 'gateway_send'}, ${a.route.capability}) : ${relu.code}${verdict.access ? `, accès ${verdict.access}` : ''}, version ${a.publishedVersion ?? '?'} → ${version ?? '?'}.`);
  return { departed: false, code: relu.code, label: relu.label, verdict, version };
}

/**
 * Garde + confirmation de départ, pour les appelants hors passerelle : lève
 * `ModelSendRefused` si l'envoi est refusé — à la garde, OU juste avant le
 * départ parce qu'un verdict a été publié entre les deux (#786, B01).
 */
export async function assertSendAdmissible(p: {
  model: string; point: SendPoint; capability?: OperationalCapability; access?: RouteAccessContext;
}): Promise<void> {
  const a = await guardSend(p);
  if (!a.admitted) throw new ModelSendRefused(a, p.point);
  const c = await confirmDeparture(a);
  if (!c.departed) {
    throw new ModelSendRefused({ admitted: false, code: c.code, label: c.label, verdict: c.verdict }, p.point);
  }
}
