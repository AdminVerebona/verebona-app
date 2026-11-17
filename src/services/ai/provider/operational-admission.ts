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
 * Les sondes explicites de disponibilité et de rétablissement sont la seule
 * exception : bornées par l'échéance partagée et la réservation (E07),
 * tarifées (#770) et dédupliquées. Une qualification N'EST PAS une sonde de
 * récupération.
 *
 * Ce module ne lit ni n'écrit aucun tarif : disponibilité (#771, #786), tarif
 * (#770) et aptitude métier restent trois dimensions distinctes et cumulatives.
 */
import { BASE_CAPABILITY, OPERATIONAL_CAPABILITY_LABELS, type CheckStatus, type OperationalCapability, type ProbeErrorKind } from './probe-classification';

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
  | { admitted: true; reason: 'AVAILABLE' | 'UNKNOWN_NOT_BLOCKING' | 'AUTHORIZED_PROBE' | 'DIMENSION_INACTIVE'; verdict: PublishedVerdict }
  | { admitted: false; code: AdmissionCode; label: string; verdict: PublishedVerdict };

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
  allowed: number;
  refusedUnavailable: number;
  refusedUnverifiable: number;
  authorizedProbes: number;
  /** Verdicts rendus depuis le dernier instantané fiable (base illisible). */
  servedFromLastReliable: number;
  /** Par point d'envoi : autorisés / refusés. */
  byPoint: Record<string, { allowed: number; refused: number }>;
}

const mesures: AdmissionMetrics = {
  allowed: 0, refusedUnavailable: 0, refusedUnverifiable: 0, authorizedProbes: 0, servedFromLastReliable: 0, byPoint: {},
};

function compter(point: SendPoint, a: SendAdmission): void {
  const e = (mesures.byPoint[point] ??= { allowed: 0, refused: 0 });
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

/** Instantané des décomptes d'admission (copie). */
export function admissionMetrics(): AdmissionMetrics {
  return { ...mesures, byPoint: Object.fromEntries(Object.entries(mesures.byPoint).map(([k, v]) => [k, { ...v }])) };
}

/** Réservé aux tests et au démarrage : remet les décomptes à zéro. */
export function __resetAdmissionMetrics(): void {
  mesures.allowed = 0; mesures.refusedUnavailable = 0; mesures.refusedUnverifiable = 0;
  mesures.authorizedProbes = 0; mesures.servedFromLastReliable = 0;
  for (const k of Object.keys(mesures.byPoint)) delete mesures.byPoint[k];
}

// ── Dernier verdict FIABLE connu de cette instance (E01) ────────────────────

/**
 * Dernier verdict lu de façon FIABLE, par route. Il survit à une panne de
 * base : les interdictions sont conservées, et un refus confirmé n'est jamais
 * remplacé par « inconnu » faute de lecture.
 */
const dernierFiable = new Map<string, PublishedVerdict>();
let lectureFiableObtenue = false;

/** Clé du dernier verdict fiable : la ROUTE **et** la capacité demandée (E05). */
const cleFiable = (model: string, capability: OperationalCapability): string => `${model}\u0000${capability}`;

/** Mémorise un verdict lu de façon fiable (E01). */
export function rememberReliableVerdict(v: PublishedVerdict): void {
  if (!v.reliable) return;
  lectureFiableObtenue = true;
  dernierFiable.set(cleFiable(v.model, v.askedCapability ?? BASE_CAPABILITY), { ...v, fromLastReliable: false });
}

/**
 * Verdict de repli quand la lecture est impossible : le dernier verdict
 * fiable de la route, sinon — si cette instance n'a JAMAIS lu l'état —
 * « invérifiable ». Une route lue fiablement comme absente reste admise :
 * l'inconnu ne retire aucun modèle (P04).
 */
export function lastReliableVerdict(model: string, capability: OperationalCapability = BASE_CAPABILITY): PublishedVerdict | null {
  const v = dernierFiable.get(cleFiable(model, capability))
    // #786 (E05) : à défaut de verdict pour cette capacité, le dernier verdict fiable de la capacité de BASE
    // est opposable (prérequis) — mais seulement s'il REFUSE : il ne vaut jamais autorisation d'une autre capacité.
    ?? (capability !== BASE_CAPABILITY ? dernierFiable.get(cleFiable(model, BASE_CAPABILITY)) : undefined);
  if (v && (v.askedCapability ?? BASE_CAPABILITY) === capability) return { ...v, reliable: false, fromLastReliable: true };
  if (v) {
    return v.state === 'unavailable'
      ? { ...v, reliable: false, fromLastReliable: true, askedCapability: capability, scopeExtendedFromBase: true }
      : { ...unknownVerdict(model, false, capability), fromLastReliable: true };
  }
  if (lectureFiableObtenue) return { ...unknownVerdict(model, false, capability), fromLastReliable: true };
  return null;
}

/** Réservé aux tests : oublie les verdicts fiables mémorisés (démarrage à froid). */
export function __resetLastReliableVerdicts(): void {
  dernierFiable.clear();
  lectureFiableObtenue = false;
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

/** Lecteur du verdict partagé (injecté en test, sinon la lecture canonique). */
export type PublishedVerdictReader = (model: string, capability: OperationalCapability) => Promise<PublishedVerdict>;

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

/** Verdict partagé d'une route et d'une CAPACITÉ, lu à la frontière (ne lève jamais). */
export async function publishedVerdictOf(model: string, capability: OperationalCapability = BASE_CAPABILITY): Promise<PublishedVerdict> {
  if (lecteurInjecte) {
    try {
      const v = await lecteurInjecte(model, capability);
      rememberReliableVerdict(v);
      return v.reliable ? v : lastReliableVerdict(model, capability) ?? v;
    } catch {
      return lastReliableVerdict(model, capability) ?? unknownVerdict(model, false, capability);
    }
  }
  if (!admissionActive()) return unknownVerdict(model, true, capability);
  try {
    const { readPublishedVerdict } = await import('./model-operational.service');
    const v = await readPublishedVerdict(model, undefined, capability);
    if (v.reliable) {
      rememberReliableVerdict(v);
      return v;
    }
    return lastReliableVerdict(model, capability) ?? v;
  } catch {
    return lastReliableVerdict(model, capability) ?? unknownVerdict(model, false, capability);
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
}): Promise<SendAdmission> {
  const dimensionActive = admissionActive();
  const capability = p.capability ?? BASE_CAPABILITY;
  // Sonde autorisée : aucune lecture nécessaire (elle doit atteindre la route).
  const verdict = sendKindOf(p.point) === 'authorized_probe' || !dimensionActive
    ? unknownVerdict(p.model, true, capability)
    : await publishedVerdictOf(p.model, capability);
  const a = admitSend({ point: p.point, verdict, dimensionActive });
  compter(p.point, a);
  if (!a.admitted) {
    // Journal (E08) : envoi refusé, sans secret ni donnée de compte.
    console.info(`[ia-admission] envoi refusé — ${p.model} (${p.point}, ${capability}) : ${a.code}${a.verdict.access ? `, accès ${a.verdict.access}` : ''}${a.verdict.scopeExtendedFromBase ? ', refus de la capacité de base' : ''}${a.verdict.fromLastReliable ? ', dernier verdict fiable' : ''}.`);
  }
  return a;
}

/** Même garde, pour les appelants hors passerelle : lève `ModelSendRefused` si l'envoi est refusé. */
export async function assertSendAdmissible(p: { model: string; point: SendPoint; capability?: OperationalCapability }): Promise<void> {
  const a = await guardSend(p);
  if (!a.admitted) throw new ModelSendRefused(a, p.point);
}
