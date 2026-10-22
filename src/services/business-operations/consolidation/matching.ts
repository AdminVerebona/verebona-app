/**
 * Machine de décision T3 et rapprochement déterministe — règles PURES
 * (lot 41, O3a ; CDC Opérations V1 ch. 8.1-8.3, B5, B6, C5, C6, C6.1, C7.1 à
 * C7.7, P01-P08, EXH-003, EXH-004, INV-007, INV-008).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ORDRE (C6)
 *
 *   existence établie ?               non → NO_OPERATION
 *   candidat « conflictual »          → HOLD_UNRESOLVED (CONFLICTUAL)
 *   rapprochements CERTAINS, hors hard negatives et décisions REJECTED :
 *     M0  décision utilisateur CONFIRMED (prioritaire) ;
 *     M1  référence métier exacte d'une nature compatible avec le type ;
 *     M2  continuité structurelle (même source documentaire, déjà liée) et
 *         règles fermées de cycle de possession (ACQUISITION / DISPOSAL, C7.1,
 *         C7.6) ;
 *   un seul certain                   → MATCH_AND_ENRICH
 *   plusieurs certains M1 / M2        → FUSION V1 (lot 42, B8, ch. 8.4, F-049) si
 *     compatibles entre eux             la source PROUVE qu'ils sont la même
 *                                       réalité : MATCH_AND_ENRICH sur la
 *                                       canonique, les autres absorbées
 *   plusieurs certains (sinon)        → ARBITRATION_REQUIRED (carte « À traiter »
 *                                       si impact métier, lot 42) / HOLD
 *   référence commune contredite      → HOLD_UNRESOLVED (CONTRADICTORY_REFERENCE)
 *   Opérations PLAUSIBLES restantes   → HOLD_UNRESOLVED (M3_REQUIRED) : seul le
 *     (faisceau C7 sans clé exacte)     rapprochement sémantique M3 (lot 42,
 *                                       `applyM3Verdict`) peut trancher ; en cas
 *                                       de doute on ne crée pas de doublon
 *                                       (EXH-004)
 *   aucune                            → CREATE_NEW si la source peut créer
 *                                       seule (certain + établi, C5), sinon
 *                                       HOLD_UNRESOLVED (PROBABLE_WITHOUT_MATCH)
 *
 * Opération INVALIDÉE (C8, F-052, F-053) : seule une preuve CERTAINE de même
 * identité (M1 référence exacte, M2 même source, M0) la rattache — elle est
 * alors réactivée sous le même identifiant ; elle n'est jamais « plausible ».
 *
 * Jamais de troisième Opération entre deux candidates (P06, INV-008) ; un
 * facteur faible seul (même prestataire, même montant, même date) ne
 * rattache jamais (M4, F-034) — il ne fait que rendre une Opération
 * PLAUSIBLE, donc empêcher la création d'un doublon.
 *
 * LOT 53 (retour PO D5 / D6, docs/exploitation/operations-rapprochement.md) :
 *   · la plausibilité est un FAISCEAU pondéré (`plausibilityEvidence`) : bien
 *     concerné, prestataire, nature des travaux, cohérence des montants,
 *     dates (les fenêtres de 120 j / 30 j sont des INDICES, jamais des
 *     preuves : hors fenêtre, un faisceau fort reste plausible), numéros de
 *     facture distincts (indice contraire, plus une exclusion) ;
 *   · deux factures finales de numéros différents ne créent plus
 *     systématiquement deux interventions (D6) : elles sont soumises à M3
 *     puis, en cas de doute, à l'utilisateur ;
 *   · une référence commune portée par deux prestataires différents n'est
 *     plus une preuve (M1 « fragile ») : jamais de rattachement automatique ;
 *   · M3 examine les Opérations plausibles par lots ordonnés
 *     (`rankPlausible`, `selectM3Batch`, D7) — jamais d'abandon au-delà de 5.
 *
 * LOT 78A (ticket « [P1] Opérations & TCO », correction BLOQUANTE de M1 / M2) :
 *   · tout rattachement automatique (M1, M2 cycle, M3, fusion V1) passe le
 *     contrôle d'identité économique (`economic-identity.ts`) — le même bien
 *     parent, le même cycle de possession, un document partagé ne prouvent
 *     JAMAIS seuls une même transaction : M2 cycle exige un indice positif
 *     (sinon différé : M3 / utilisateur) ; une contradiction écarte ;
 *   · la continuité (M2 même source) est réévaluée face à la source fondatrice
 *     de l'Opération (correction rétroactive, `identity-review.ts`) ;
 *   · candidats d'un même document décrivant la même transaction
 *     (`sameTransactionDescription`) : une seule Opération.
 *
 * Raisons auditables (B6) : chaque décision rend ses motifs stables.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { BusinessOperationStatus, BusinessOperationTypeCode, MatchMethod, ReferenceKind } from '../model';
import { componentsFromIdentity, hasRecurringPeriod, type CandidateIdentity } from './model';
import {
  assessAgainstMembers, footprintOfIdentity, footprintOfOperation, identitySignals, reviewExistingAttachment,
  type IdentityAssessment, type IdentityBasis, type OperationMember,
} from './economic-identity';
import { m3Resolution, type OperationMatchVerdict } from '@/services/ai/reconciliation/master/operation-match';

export type T3Outcome = 'NO_OPERATION' | 'MATCH_AND_ENRICH' | 'CREATE_NEW' | 'HOLD_UNRESOLVED' | 'ARBITRATION_REQUIRED';

export type HoldReason =
  | 'CONFLICTUAL'
  | 'ARBITRATION_REQUIRED'
  | 'CONTRADICTORY_REFERENCE'
  | 'M3_REQUIRED'
  | 'PROBABLE_WITHOUT_MATCH'
  | 'TARGET_OUT_OF_PORTFOLIO';

/** Opération existante telle que le rapprochement la voit (lue sous verrou, bornée par compte). */
export interface ExistingOperation {
  id: number;
  typeCode: BusinessOperationTypeCode | null;
  status: BusinessOperationStatus;
  providerKey: string | null;
  assetIds: number[];
  refs: Array<{ kind: ReferenceKind; normalized: string }>;
  plannedDate: string | null;
  startDate: string | null;
  realizedDate: string | null;
  endDate: string | null;
  /** Opération déjà prouvée par la même source documentaire (même document, même clé de candidat). */
  sameSource?: boolean;
  /** Opération invalidée (plus aucune source active) : réactivable par une preuve certaine seulement (F-052). */
  invalidated?: boolean;
  /**
   * Lot 47B : Opération établie par l'AGENDA seul (sources actives toutes
   * AGENDA) — sans prestataire ni référence, elle ne peut être reconnue par
   * une facture que sémantiquement (M3) : plausible, jamais doublée.
   */
  agendaOnly?: boolean;
  /** Lot 53 (D5) : libellé technique (nature des travaux), pour le faisceau de plausibilité. */
  label?: string | null;
  /** Lot 53 (D5) : montants actifs de l'Opération (cohérence des montants). */
  amounts?: ReadonlyArray<{ kind: string; amountMinor: number; currency: string }>;
  /**
   * Lot 55B : Opération d'échéances — CONTRACT, ou coûts actifs portant une
   * période facturée réelle (abonnement qualifié « intervention » par T1).
   */
  periodic?: boolean;
  /**
   * Lot 78A (§2B, §5) : sources gérées ACTIVES de l'Opération (hors celle du
   * candidat examiné), chacune avec son empreinte économique ; la plus
   * ancienne est la fondatrice. Absentes : l'empreinte agrégée de
   * l'Opération sert de repli (`footprintOfOperation`).
   */
  members?: readonly OperationMember[];
  /** Lot 78A : méthode qui a rattaché la source du candidat à cette Opération (continuité). */
  sameSourceMethod?: MatchMethod | null;
  /** Lot 78A : la source du candidat est la SEULE source active de cette Opération. */
  sameSourceSolo?: boolean;
  /**
   * Lot 78A (§2A) : Opération d'un AUTRE candidat du même document décrivant
   * la même transaction (`sameDocumentReality`) — rapprochement certain.
   */
  sameDocument?: boolean;
}

/**
 * Lot 78A (§2B, §6) : contrôle d'identité économique d'un rattachement
 * envisagé ou existant — trace auditable de la décision.
 *   CONFIRMED  rattachement permis ;
 *   DEFERRED   correspondance non démontrée : rapprochement différé (M3 / utilisateur) ;
 *   REFUSED    contradiction : jamais rattachée (autre réalité) ;
 *   SEPARATED  rattachement HISTORIQUE contredit : la source quitte l'Opération ;
 *   SUSPECT    rattachement historique douteux, CONSERVÉ et signalé pour examen.
 */
export interface IdentityCheck {
  operationId: number;
  basis: IdentityBasis;
  outcome: 'CONFIRMED' | 'DEFERRED' | 'REFUSED' | 'SEPARATED' | 'SUSPECT';
  signals: string[];
  /** Sources de l'Opération face auxquelles la contradiction est constatée. */
  againstSourceIds?: number[];
}

export interface MatchContext {
  operations: readonly ExistingOperation[];
  /** Décisions utilisateur actives pour cette source (C6.3). */
  confirmed: ReadonlySet<number>;
  rejected: ReadonlySet<number>;
  /** Statut des biens cibles (périmètre T3, point 7 du lot). */
  assetStatus: ReadonlyMap<number, string>;
  /**
   * Couples d'Opérations (`min:max`) qu'une décision utilisateur sépare
   * (une source CONFIRMED sur l'une, REJECTED sur l'autre) : jamais fusionnés.
   */
  nonMergeable?: ReadonlySet<string>;
  /**
   * L'utilisateur a déclaré cette source DISTINCTE des Opérations proposées
   * (« Non, c'est une autre intervention ») : autorité USER_ARBITRATION
   * confirmant une réalité (C5) — la création est permise même pour un
   * candidat probable.
   */
  userDistinct?: boolean;
}

export interface CandidateDecision {
  outcome: T3Outcome;
  operationId: number | null;
  matchMethod: MatchMethod | null;
  reason: string;
  /** Raisons auditables (codes stables). */
  detail: {
    certain: Array<{ operationId: number; method: MatchMethod; why: string }>;
    plausible: number[];
    contradictions: Array<{ operationId: number; why: string }>;
    excluded: Array<{ operationId: number; why: string }>;
    /**
     * Lot 53 (D5) : Opérations partageant une référence de document avec un
     * AUTRE prestataire (référence « fragile ») — plausibles, jamais un
     * rattachement automatique.
     */
    fragile?: number[];
    /** Lot 78A : contrôles d'identité économique effectués (trace, BO, diagnostic). */
    identity?: IdentityCheck[];
  };
  /** Fusion V1 (B8) : Opérations absorbées par `operationId` (canonique) dans la même transaction. */
  mergeIds?: number[];
  /** Ambiguïté à soumettre à l'utilisateur (C6 étape 18) : Opérations proposées, par ordre de préférence. */
  arbitration?: { basis: 'CERTAIN' | 'M3'; operationIds: number[] };
}

// ── Règles de références (C6.1 M1, C7) ─────────────────────────────────────

/**
 * Natures de référence qui IDENTIFIENT une Opération du type donné (M1).
 *   · facture, devis, commande, ordre de travail, bon de livraison : tout type
 *     (les copies d'un même document, un devis cité par sa facture) ;
 *   · contrat / police : seulement un CONTRACT (une facture d'intervention qui
 *     cite le contrat d'entretien n'est pas ce contrat, C13.1) ;
 *   · sinistre : seulement un CLAIM ; prêt : seulement un FINANCING ;
 *   · numéro client : jamais (partagé par toutes les Opérations d'un tiers) ;
 *   · autre : seulement entre deux Opérations du même type qualifié.
 */
export function referenceIdentifies(kind: ReferenceKind, type: BusinessOperationTypeCode | null, sameQualifiedType: boolean): boolean {
  switch (kind) {
    case 'INVOICE': case 'QUOTE': case 'ORDER': case 'WORK_ORDER': case 'DELIVERY':
      return true;
    case 'CONTRACT': case 'POLICY':
      return type === 'CONTRACT';
    case 'CLAIM':
      return type === 'CLAIM';
    case 'LOAN':
      return type === 'FINANCING';
    case 'OTHER':
      return sameQualifiedType;
    default:
      return false;
  }
}

/** Familles de références dont la DIVERGENCE prouve une autre Opération (hard negative, C7). */
function negativeFamilies(type: BusinessOperationTypeCode | null): ReferenceKind[][] {
  switch (type) {
    case 'ACQUISITION': return [['ORDER']];
    case 'INTERVENTION': return [['WORK_ORDER']];
    case 'CONTRACT': return [['CONTRACT', 'POLICY']];
    case 'FINANCING': return [['LOAN']];
    case 'CLAIM': return [['CLAIM']];
    default: return [];
  }
}

const refSet = (refs: ReadonlyArray<{ kind: ReferenceKind; normalized: string }>, kinds: ReferenceKind[]) =>
  new Set(refs.filter((r) => kinds.includes(r.kind)).map((r) => r.normalized));

const disjoints = (a: Set<string>, b: Set<string>) => a.size > 0 && b.size > 0 && ![...a].some((x) => b.has(x));

// ── Lot 55B : échéances d'un contrat (qualification T1 hésitante) ─────────

const TYPES_CONTRAT_OU_ECHEANCE = new Set<BusinessOperationTypeCode | null>(['CONTRACT', 'INTERVENTION', 'OTHER', null]);

/**
 * Une facture périodique et un contrat peuvent-ils être la même réalité
 * malgré des qualifications T1 différentes (pure) ? Facture d'échéance
 * (période facturée / portée INSTALLMENT) qualifiée INTERVENTION, OTHER ou
 * sans type face à un CONTRACT ; ou document CONTRACT face à une Opération
 * d'échéances (périodique) qualifiée autrement. Ce n'est JAMAIS une preuve :
 * seulement « ne pas exclure prématurément » — le faisceau rend l'Opération
 * plausible et le rapprochement sémantique (M3) tranche.
 */
export function recurringCrossType(c: CandidateIdentity, op: ExistingOperation): boolean {
  if (c.type === op.typeCode || !TYPES_CONTRAT_OU_ECHEANCE.has(c.type) || !TYPES_CONTRAT_OU_ECHEANCE.has(op.typeCode)) return false;
  if (op.typeCode === 'CONTRACT') return hasRecurringPeriod(c);
  if (c.type === 'CONTRACT') return op.periodic === true;
  return false;
}

/** Deux Opérations d'échéances d'un même contrat, de qualifications différentes (pure). */
function recurringPair(a: ExistingOperation, b: ExistingOperation): boolean {
  if (a.typeCode === b.typeCode) return false;
  const [k, o] = a.typeCode === 'CONTRACT' ? [a, b] : b.typeCode === 'CONTRACT' ? [b, a] : [null, null];
  return !!k && !!o && TYPES_CONTRAT_OU_ECHEANCE.has(o.typeCode) && o.periodic === true;
}

/** Référence de contrat / police commune (pure). */
function sharedContractReference(c: CandidateIdentity, op: ExistingOperation): boolean {
  const a = refSet(c.refs, ['CONTRACT', 'POLICY']);
  return op.refs.some((r) => (r.kind === 'CONTRACT' || r.kind === 'POLICY') && a.has(r.normalized));
}

/** Références communes qui identifient l'Opération (M1). */
export function sharedIdentifyingReferences(c: CandidateIdentity, op: ExistingOperation): string[] {
  const type = c.type ?? op.typeCode;
  const sameQualified = c.type !== null && c.type === op.typeCode;
  const out: string[] = [];
  for (const r of c.refs) {
    if (!referenceIdentifies(r.kind, type, sameQualified)) continue;
    if (op.refs.some((o) => o.kind === r.kind && o.normalized === r.normalized)) out.push(`${r.kind}:${r.normalized}`);
  }
  return out;
}

/**
 * Hard negatives (C6 étape 16, C7) : type incompatible, cibles explicitement
 * disjointes, référence d'une famille identifiante divergente, factures
 * distinctes pour une intervention.
 */
export function hardNegatives(c: CandidateIdentity, op: ExistingOperation): string[] {
  const out: string[] = [];
  // Lot 48 (C7.7, F-055) : une Opération OTHER peut être requalifiée vers un
  // type connu sans changer d'identité ; l'inverse reste incompatible.
  // Lot 55B : une facture d'échéance face à un contrat (ou l'inverse) n'est
  // pas une incompatibilité de type — seulement une hypothèse que M3 tranche.
  const croise = recurringCrossType(c, op);
  if (c.type !== null && op.typeCode !== null && c.type !== op.typeCode && op.typeCode !== 'OTHER' && !croise) out.push('TYPE_INCOMPATIBLE');
  if (c.assetIds.length && op.assetIds.length && !c.assetIds.some((a) => op.assetIds.includes(a))) out.push('TARGET_INCOMPATIBLE');
  const type = c.type ?? op.typeCode;
  const familles = negativeFamilies(type);
  // Couple croisé : deux numéros de contrat différents restent une autre réalité.
  if (croise && !familles.some((f) => f.includes('CONTRACT'))) familles.push(['CONTRACT', 'POLICY']);
  for (const fam of familles) {
    if (disjoints(refSet(c.refs, fam), refSet(op.refs, fam))) out.push(`REFERENCE_DIFFERENT_${fam.join('_')}`);
  }
  // Lot 53 (retour PO D6) : deux factures FINALES de numéros différents ne
  // sont PLUS une exclusion (C7.2 / F-033 livré au lot 41) — deux factures
  // peuvent porter sur une même intervention. C'est désormais un indice
  // contraire du faisceau (`distinctFinalInvoices`, `plausibilityEvidence`).
  return out;
}

/**
 * Deux factures FINALES de numéros différents, sans référence commune (pure) :
 * indice contraire (D6), jamais une exclusion. Ne vaut ni pour un acompte /
 * un solde, ni pour un contrat ou un financement.
 */
export function distinctFinalInvoices(c: CandidateIdentity, op: ExistingOperation): boolean {
  const type = c.type ?? op.typeCode;
  return (type === 'INTERVENTION' || type === 'OTHER' || type === null) && c.role === 'INVOICE'
    && !c.hints.some((h) => h.amountScope === 'DEPOSIT' || h.amountScope === 'BALANCE')
    && disjoints(refSet(c.refs, ['INVOICE']), refSet(op.refs, ['INVOICE']))
    && sharedIdentifyingReferences(c, op).length === 0;
}

/**
 * Référence commune « fragile » (lot 53, D5) : une facture, un devis, un bon
 * portent un numéro propre AU PRESTATAIRE — le même numéro chez deux
 * prestataires différents (tous deux connus) ne prouve rien. Pure.
 */
export function referenceProviderMismatch(c: CandidateIdentity, op: ExistingOperation): boolean {
  if (c.providerKey === null || op.providerKey === null || c.providerKey === op.providerKey) return false;
  const kinds = new Set(sharedIdentifyingReferences(c, op).map((r) => r.split(':')[0]));
  return kinds.size > 0 && [...kinds].every((k) => k === 'INVOICE' || k === 'QUOTE' || k === 'ORDER' || k === 'WORK_ORDER' || k === 'DELIVERY');
}

// ── Cycle de possession (C7.1, C7.6) ───────────────────────────────────────

const FIN = '9999-12-31';
const BORNE_SANS_DATE = '9999-12-30';
const dateOf = (o: { realizedDate: string | null; startDate: string | null }) => o.realizedDate ?? o.startDate ?? null;

/**
 * Même cycle de possession ? Aucune Opération « borne » RÉALISÉE (une CESSION
 * pour des acquisitions, une ACQUISITION pour des cessions) sur un bien commun
 * strictement entre les deux dates (date inconnue = cycle courant).
 */
export function sameOwnershipCycle(
  c: CandidateIdentity, op: ExistingOperation, bornes: readonly ExistingOperation[],
): boolean {
  const a = dateOf({ realizedDate: c.dates.realizedDate, startDate: c.dates.startDate }) ?? FIN;
  const b = dateOf(op) ?? FIN;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return !bornes.some((x) => {
    if (x.status !== 'REALIZED' || !x.assetIds.some((id) => c.assetIds.includes(id) && op.assetIds.includes(id))) return false;
    // Borne réalisée sans date : postérieure à toute Opération datée, antérieure
    // au cycle courant (date inconnue).
    const d = dateOf(x) ?? BORNE_SANS_DATE;
    return lo < d && d < hi;
  });
}

// ── Plausibilité (faisceau C7 sans clé exacte : M3 requis) ─────────────────

const JOUR = 86_400_000;
function ecartJours(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const x = Date.parse(`${a}T00:00:00Z`);
  const y = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return Math.abs(x - y) / JOUR;
}
function proches(a: string | null, b: string | null, jours: number): boolean {
  const e = ecartJours(a, b);
  return e === null || e <= jours;
}
const dateCandidat = (c: CandidateIdentity) => c.dates.realizedDate ?? c.dates.plannedDate ?? c.dates.startDate ?? c.dates.endDate;
const dateOperation = (o: ExistingOperation) => o.realizedDate ?? o.plannedDate ?? o.startDate ?? o.endDate;
const memeTiers = (c: CandidateIdentity, o: ExistingOperation) => c.providerKey !== null && c.providerKey === o.providerKey;
const ciblesCompatibles = (c: CandidateIdentity, o: ExistingOperation) =>
  !c.assetIds.length || !o.assetIds.length || c.assetIds.some((a) => o.assetIds.includes(a));

/** Fenêtre de cohérence temporelle d'une même intervention (jours) — INDICE (lot 53, D5), jamais une preuve. */
export const INTERVENTION_PERIOD_DAYS = 120;
/** Fenêtre d'un même sinistre déclaré sans référence (jours) — INDICE (lot 53, D5). */
export const CLAIM_PERIOD_DAYS = 30;
/** Lot 47B : document ↔ intervention établie par l'agenda seul, même bien (jours). */
export const AGENDA_OPERATION_PERIOD_DAYS = 60;
/** Au-delà de ce multiple de la fenêtre, l'écart de dates devient un indice contraire. */
export const FAR_WINDOW_FACTOR = 3;
/** Score minimal du faisceau pour qu'une Opération soit plausible (lot 53, D5). */
export const PLAUSIBILITY_THRESHOLD = 3;

/**
 * Poids du faisceau de plausibilité (lot 53, D5 ; documentés dans
 * docs/exploitation/operations-rapprochement.md). Plausible = score ≥ seuil
 * ET un ancrage : même prestataire, ou même bien avec la même nature de
 * travaux ou des montants concordants (`hasAnchor`).
 */
export const PLAUSIBILITY_WEIGHTS = {
  PROVIDER_SAME: 3,
  PROVIDER_DIFFERENT: -4,
  ASSET_SAME: 2,
  DATE_IN_WINDOW: 1,
  DATE_FAR: -6,
  NATURE_COMMON: 1,
  NATURE_DIFFERENT: -2,
  AMOUNT_COHERENT: 1,
  INVOICE_NUMBERS_DIFFERENT: -2,
} as const;
export type PlausibilitySignal = keyof typeof PLAUSIBILITY_WEIGHTS;

/** Mots sans valeur discriminante pour la « nature des travaux » (normalisés, sans accents). */
const MOTS_VIDES = new Set([
  'facture', 'factures', 'devis', 'avoir', 'acompte', 'solde', 'intervention', 'interventions', 'travaux', 'prestation',
  'prestations', 'montant', 'total', 'reglement', 'paiement', 'entreprise', 'societe', 'client', 'numero', 'reference',
  'document', 'service', 'services', 'pour', 'avec', 'dans', 'sans', 'chez', 'votre', 'notre', 'date', 'euros',
  'realise', 'realisee', 'effectue', 'effectuee', 'prevu', 'prevue', 'garage', 'artisan', 'commande', 'livraison',
  // Gestes génériques : ils ne disent pas QUELS travaux (« remplacement » de quoi ?).
  'remplacement', 'changement', 'fourniture', 'reparation', 'installation', 'avant', 'arriere',
  // Désignations génériques de biens : elles disent OÙ, pas QUELS travaux.
  'maison', 'appartement', 'immeuble', 'logement', 'local', 'residence', 'voiture', 'vehicule', 'velo', 'bien', 'biens',
]);

/** Mots porteurs de nature (≥ 4 lettres, hors mots vides), normalisés (pure). */
export function natureTokens(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  const mots = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/);
  return new Set(mots.filter((m) => m.length >= 4 && !/^\d+$/.test(m) && !MOTS_VIDES.has(m)));
}

/** Montants concordants (même devise, écart ≤ 1 %) entre le candidat et l'Opération (pure). */
export function amountsCoherent(c: CandidateIdentity, o: ExistingOperation): boolean {
  const ops = o.amounts ?? [];
  if (!ops.length || !c.hints.length) return false;
  return c.hints.some((h) => ops.some((x) => x.currency === h.currency && x.amountMinor > 0
    && Math.abs(x.amountMinor - h.amountMinor) <= Math.max(1, Math.round(x.amountMinor / 100))));
}

export interface PlausibilityEvidence {
  score: number;
  /** Ancrage minimal (même prestataire, ou même bien + nature / montant). */
  anchored: boolean;
  /** Faisceau suffisant : score ≥ seuil et ancré. */
  plausible: boolean;
  signals: PlausibilitySignal[];
  /** Écart de dates (jours), null si inconnu — sert au classement. */
  gapDays: number | null;
}

/**
 * Faisceau de plausibilité d'une Opération pour un candidat (pure, lot 53,
 * D5) : prestataire, bien, dates (fenêtre = indice), nature, montants,
 * numéros de facture. `windowDays` : fenêtre du type (120 j intervention,
 * 30 j sinistre).
 */
export function plausibilityEvidence(c: CandidateIdentity, o: ExistingOperation, windowDays = INTERVENTION_PERIOD_DAYS): PlausibilityEvidence {
  const signals: PlausibilitySignal[] = [];
  if (c.providerKey !== null && o.providerKey !== null) signals.push(c.providerKey === o.providerKey ? 'PROVIDER_SAME' : 'PROVIDER_DIFFERENT');
  if (c.assetIds.some((a) => o.assetIds.includes(a))) signals.push('ASSET_SAME');
  const gapDays = ecartJours(dateCandidat(c), dateOperation(o));
  // Lot 55B : échéance face à une Opération d'échéances — un abonnement court
  // dans le temps et chaque échéance a son propre numéro de facture : ni
  // l'écart de dates ni les numéros distincts ne sont des indices contraires.
  const echeances = o.periodic === true && hasRecurringPeriod(c);
  if (gapDays !== null) {
    if (gapDays <= windowDays) signals.push('DATE_IN_WINDOW');
    else if (gapDays > windowDays * FAR_WINDOW_FACTOR && !echeances) signals.push('DATE_FAR');
  }
  const a = natureTokens(c.summary);
  const b = natureTokens(o.label ?? null);
  if ([...a].some((m) => b.has(m))) signals.push('NATURE_COMMON');
  else if (a.size && b.size) signals.push('NATURE_DIFFERENT');
  if (amountsCoherent(c, o)) signals.push('AMOUNT_COHERENT');
  if (!echeances && distinctFinalInvoices(c, o)) signals.push('INVOICE_NUMBERS_DIFFERENT');
  const score = signals.reduce((n, s) => n + PLAUSIBILITY_WEIGHTS[s], 0);
  const anchored = signals.includes('PROVIDER_SAME')
    || (signals.includes('ASSET_SAME') && (signals.includes('NATURE_COMMON') || signals.includes('AMOUNT_COHERENT')));
  return { score, anchored, plausible: anchored && score >= PLAUSIBILITY_THRESHOLD, signals, gapDays };
}

/**
 * L'Opération POURRAIT-elle représenter la même réalité (forts C7 réunis sans
 * clé exacte) ? Une Opération plausible interdit la création (EXH-004) et
 * appelle le rapprochement sémantique M3 (lot 42), puis l'utilisateur en cas
 * de doute (lot 53, D5).
 */
export function isPlausible(c: CandidateIdentity, o: ExistingOperation): boolean {
  const type = c.type ?? o.typeCode;
  // Lot 47B : une intervention saisie à l'agenda (aucun prestataire, aucune
  // référence) et le document qui la prouve sur le même bien : jamais deux
  // Opérations sans examen M3 (EXH-004). Entre deux éléments d'agenda : non
  // (leur rapprochement est celui de `agenda-source.ts`).
  if (o.agendaOnly && !c.agenda && (type === 'INTERVENTION' || type === null)
    && c.assetIds.some((a) => o.assetIds.includes(a))
    && proches(dateCandidat(c), dateOperation(o), AGENDA_OPERATION_PERIOD_DAYS)) return true;
  // Sources agenda / données structurées (lots 43, 47B) : règle d'origine
  // (même tiers, fenêtre) — leur rapprochement propre est ailleurs.
  const documentaire = !c.agenda && !c.structured;
  // Lot 55B : facture d'échéance ↔ contrat qualifiés différemment par T1 —
  // même règle qu'entre deux contrats (même tiers, ou même référence de
  // contrat sans tiers contradictoire), cibles compatibles.
  if (documentaire && recurringCrossType(c, o)) {
    const tiersContraire = c.providerKey !== null && o.providerKey !== null && c.providerKey !== o.providerKey;
    return ciblesCompatibles(c, o) && (memeTiers(c, o) || (sharedContractReference(c, o) && !tiersContraire));
  }
  switch (type) {
    case 'CONTRACT':
    case 'FINANCING':
      return memeTiers(c, o) && ciblesCompatibles(c, o);
    case 'CLAIM':
      if (c.dates.realizedDate !== null && c.dates.realizedDate === o.realizedDate && c.assetIds.some((a) => o.assetIds.includes(a))) return true;
      if (!documentaire) return memeTiers(c, o) && ciblesCompatibles(c, o) && proches(dateCandidat(c), dateOperation(o), CLAIM_PERIOD_DAYS);
      return ciblesCompatibles(c, o) && plausibilityEvidence(c, o, CLAIM_PERIOD_DAYS).plausible;
    case 'ACQUISITION':
    case 'DISPOSAL':
      // Couvert par la règle de cycle (M2) ; hors cycle : rien de plausible.
      return false;
    default:
      if (!documentaire) return memeTiers(c, o) && ciblesCompatibles(c, o) && proches(dateCandidat(c), dateOperation(o), INTERVENTION_PERIOD_DAYS);
      return ciblesCompatibles(c, o) && plausibilityEvidence(c, o, INTERVENTION_PERIOD_DAYS).plausible;
  }
}

/**
 * Classement des Opérations plausibles pour l'examen M3 progressif (lot 53,
 * D7) : faisceau le plus fort, puis dates les plus proches, puis la plus
 * récente. Déterministe (pur).
 */
export function rankPlausible(c: CandidateIdentity, ops: readonly ExistingOperation[]): number[] {
  const fenetre = (c.type ?? null) === 'CLAIM' ? CLAIM_PERIOD_DAYS : INTERVENTION_PERIOD_DAYS;
  return ops
    .map((o) => ({ id: o.id, e: plausibilityEvidence(c, o, fenetre) }))
    .sort((x, y) => y.e.score - x.e.score
      || (x.e.gapDays ?? Number.MAX_SAFE_INTEGER) - (y.e.gapDays ?? Number.MAX_SAFE_INTEGER)
      || y.id - x.id)
    .map((x) => x.id);
}

// ── Décision (C5, C6) ──────────────────────────────────────────────────────

const OUT_OF_PORTFOLIO = new Set(['VENDU', 'TRANSMIS', 'ARCHIVED']);

/**
 * Création interdite hors périmètre T3 (point 7 du lot) : un bien VENDU ou
 * TRANSMIS n'accueille qu'une CESSION nouvelle ; un bien ARCHIVÉ aucune.
 * L'enrichissement des Opérations existantes de ces biens reste permis.
 */
export function creationOutOfPerimeter(c: CandidateIdentity, assetStatus: ReadonlyMap<number, string>): boolean {
  return c.assetIds.some((a) => {
    const s = assetStatus.get(a) ?? 'EN_SERVICE';
    if (!OUT_OF_PORTFOLIO.has(s)) return false;
    return s === 'ARCHIVED' || c.type !== 'DISPOSAL';
  });
}

/** Décision T3 pour UN candidat (pure). */
export function decideCandidate(c: CandidateIdentity, ctx: MatchContext): CandidateDecision {
  const detail: CandidateDecision['detail'] = { certain: [], plausible: [], contradictions: [], excluded: [] };
  const res = (outcome: T3Outcome, reason: string, operationId: number | null = null, matchMethod: MatchMethod | null = null): CandidateDecision =>
    ({ outcome, operationId, matchMethod, reason, detail });

  if (!c.established) return res('NO_OPERATION', 'NOT_ESTABLISHED');
  if (c.confidence === 'conflictual') return res('HOLD_UNRESOLVED', 'CONFLICTUAL');

  const bornesAcq = ctx.operations.filter((o) => o.typeCode === 'DISPOSAL' && !o.invalidated);
  const bornesCes = ctx.operations.filter((o) => o.typeCode === 'ACQUISITION' && !o.invalidated);

  // Lot 78A (§2B) : trace des contrôles d'identité économique.
  const noter = (operationId: number, basis: IdentityBasis, outcome: IdentityCheck['outcome'], a: (IdentityAssessment & { against?: number[] }) | null) => {
    (detail.identity ??= []).push({
      operationId, basis, outcome, signals: a ? identitySignals(a) : [],
      ...(a?.against?.length && outcome !== 'CONFIRMED' ? { againstSourceIds: a.against.filter((x) => x > 0) } : {}),
    });
  };

  for (const op of ctx.operations) {
    if (ctx.rejected.has(op.id)) { detail.excluded.push({ operationId: op.id, why: 'USER_REJECTED' }); continue; }
    if (ctx.confirmed.has(op.id)) { detail.certain.push({ operationId: op.id, method: 'M0', why: 'USER_CONFIRMED' }); continue; }
    const negatifs = hardNegatives(c, op);
    if (op.invalidated && !op.sameSource) {
      // F-052 / F-053 : une Opération invalidée n'est rattachée que par une
      // référence exacte non contredite ; sinon elle n'existe pas pour T3.
      // Lot 78A : ni contredite par l'identité économique de la transaction.
      const communes = sharedIdentifyingReferences(c, op);
      const ident = communes.length && !negatifs.length ? economicCheck(c, op, 'REFERENCE') : null;
      if (ident && ident.verdict !== 'CONTRADICTED') detail.certain.push({ operationId: op.id, method: 'M1', why: `REFERENCE ${communes.join(',')} (INVALIDATED)` });
      else {
        if (ident) noter(op.id, 'REFERENCE', 'REFUSED', ident);
        detail.excluded.push({ operationId: op.id, why: ident ? 'ECONOMIC_IDENTITY_CONTRADICTED' : 'INVALIDATED' });
      }
      continue;
    }
    if (op.sameSource) {
      // M2 : même source documentaire déjà liée (réanalyse, restauration). Une
      // requalification d'un type connu vers un autre type connu n'est pas la
      // même réalité (C9 : la source est déplacée).
      if (negatifs.includes('TYPE_INCOMPATIBLE')) { detail.excluded.push({ operationId: op.id, why: 'SAME_SOURCE_TYPE_CHANGED' }); continue; }
      // Lot 78A (§2B, §5) : la continuité n'est plus une preuve en soi — le
      // rattachement historique est réévalué face aux autres sources de
      // l'Opération (`reviewExistingAttachment`). Contradiction certaine : la
      // source quitte l'Opération (sauf rattachement décidé par l'IA, jamais
      // défait d'office) ; doute : conservée et signalée.
      if (op.members) {
        const r = reviewExistingAttachment(footprintOfIdentity(c), op.members);
        const a = r.assessment ? { ...r.assessment, against: r.against } : null;
        if (r.outcome === 'SEPARATE' && op.sameSourceMethod !== 'M3') {
          noter(op.id, 'SAME_SOURCE', 'SEPARATED', a);
          detail.excluded.push({ operationId: op.id, why: 'SAME_SOURCE_IDENTITY_CONTRADICTED' });
          continue;
        }
        if (r.outcome !== 'KEEP') noter(op.id, 'SAME_SOURCE', 'SUSPECT', a);
      }
      detail.certain.push({ operationId: op.id, method: 'M2', why: 'SAME_SOURCE' });
      continue;
    }
    if (op.sameDocument && !negatifs.length) {
      // Lot 78A (§2A) : un autre candidat du MÊME document décrit la même
      // transaction (référence commune ou description économique identique).
      detail.certain.push({ operationId: op.id, method: 'M2', why: 'SAME_DOCUMENT_REALITY' });
      continue;
    }
    const communes = sharedIdentifyingReferences(c, op);
    if (communes.length) {
      if (negatifs.length) { detail.contradictions.push({ operationId: op.id, why: `${communes[0]} / ${negatifs.join(',')}` }); continue; }
      // Lot 53 (D5) : même numéro de document chez deux prestataires différents → plausible seulement.
      if (referenceProviderMismatch(c, op)) {
        detail.plausible.push(op.id);
        (detail.fragile ??= []).push(op.id);
        continue;
      }
      // Lot 78A (§2B) : une référence commune ne rattache pas une transaction
      // économiquement contredite (montants d'ordres de grandeur différents,
      // équipements disjoints, plusieurs contradictions).
      const ident = economicCheck(c, op, 'REFERENCE');
      if (ident.verdict === 'CONTRADICTED') {
        noter(op.id, 'REFERENCE', 'REFUSED', ident);
        detail.contradictions.push({ operationId: op.id, why: `${communes[0]} / ECONOMIC_IDENTITY` });
        continue;
      }
      detail.certain.push({ operationId: op.id, method: 'M1', why: `REFERENCE ${communes.join(',')}` });
      continue;
    }
    if (negatifs.length) { detail.excluded.push({ operationId: op.id, why: negatifs.join(',') }); continue; }
    const type = c.type ?? op.typeCode;
    if ((type === 'ACQUISITION' || type === 'DISPOSAL') && c.type === op.typeCode
      && c.assetIds.some((a) => op.assetIds.includes(a)) && op.status !== 'CANCELLED') {
      const bornes = type === 'ACQUISITION' ? bornesAcq : bornesCes;
      if (sameOwnershipCycle(c, op, bornes)) {
        // Lot 78A (§2B, correction BLOQUANTE) : le même cycle de possession
        // n'est qu'une CONDITION. Identité démontrée → M2 ; non démontrée →
        // différée (M3 puis l'utilisateur, aucune contamination) ; contredite →
        // autre transaction.
        const ident = economicCheck(c, op, 'OWNERSHIP_CYCLE');
        if (ident.verdict === 'CONFIRMED') {
          noter(op.id, 'OWNERSHIP_CYCLE', 'CONFIRMED', ident);
          detail.certain.push({ operationId: op.id, method: 'M2', why: `OWNERSHIP_CYCLE_${type}` });
        } else if (ident.verdict === 'UNPROVEN') {
          noter(op.id, 'OWNERSHIP_CYCLE', 'DEFERRED', ident);
          detail.plausible.push(op.id);
        } else {
          noter(op.id, 'OWNERSHIP_CYCLE', 'REFUSED', ident);
          detail.excluded.push({ operationId: op.id, why: 'ECONOMIC_IDENTITY_CONTRADICTED' });
        }
      } else {
        detail.excluded.push({ operationId: op.id, why: 'OTHER_OWNERSHIP_CYCLE' });
      }
      continue;
    }
    if (isPlausible(c, op)) detail.plausible.push(op.id);
  }

  // Une Opération invalidée n'est réactivée que si aucune Opération ACTIVE ne
  // représente déjà la réalité de façon certaine (C8 : « si l'identité est
  // toujours pertinente »).
  const invalidees = new Set(ctx.operations.filter((o) => o.invalidated).map((o) => o.id));
  if (detail.certain.some((x) => !invalidees.has(x.operationId) || x.method === 'M0')) {
    for (const x of detail.certain.filter((y) => invalidees.has(y.operationId) && y.method !== 'M0')) {
      detail.excluded.push({ operationId: x.operationId, why: 'INVALIDATED_ACTIVE_MATCH_EXISTS' });
    }
    detail.certain = detail.certain.filter((y) => !invalidees.has(y.operationId) || y.method === 'M0');
  }

  // M0 prioritaire : une décision utilisateur l'emporte sur les autres signaux.
  const m0 = detail.certain.filter((x) => x.method === 'M0');
  const certains = m0.length ? m0 : detail.certain;
  const ids = [...new Set(certains.map((x) => x.operationId))];
  if (ids.length === 1) {
    const m = certains.find((x) => x.operationId === ids[0])!;
    // Lot 53 (D5) : une référence exacte (M1) concurrencée par une référence
    // fragile vers une autre Opération n'est plus une forte confiance → arbitrage.
    const fragiles = (detail.fragile ?? []).filter((id) => id !== ids[0]);
    if (m.method === 'M1' && fragiles.length) {
      const parId = new Map(ctx.operations.map((o) => [o.id, o]));
      const ops = [ids[0], ...fragiles].map((id) => parId.get(id)).filter((o): o is ExistingOperation => !!o);
      return arbitrate(c, ops, res, 'CERTAIN', 'ARBITRATION_REQUIRED');
    }
    return res('MATCH_AND_ENRICH', `MATCH_${m.method}`, ids[0], m.method);
  }
  if (ids.length > 1) {
    // Lot 78A (§2A, §5) : la source est seule sur sa propre Opération et un
    // autre candidat du MÊME document décrit la même transaction — les deux
    // Opérations sont un doublon : la source rejoint la plus ancienne (son
    // Opération, sans source, est invalidée : réactivable, jamais fusionnée).
    const propres = certains.filter((x) => x.why === 'SAME_SOURCE');
    const memeDoc = certains.filter((x) => x.why === 'SAME_DOCUMENT_REALITY');
    if (!m0.length && propres.length === 1 && memeDoc.length && propres.length + memeDoc.length === certains.length) {
      const parId = new Map(ctx.operations.map((o) => [o.id, o]));
      const propre = parId.get(propres[0].operationId);
      const ops = ids.map((id) => parId.get(id)).filter((o): o is ExistingOperation => !!o && !o.invalidated);
      if (propre?.sameSourceSolo && ops.length) {
        const canonique = canonicalOf(ops);
        return canonique.id === propre.id
          ? res('MATCH_AND_ENRICH', 'MATCH_M2', propre.id, 'M2')
          : res('MATCH_AND_ENRICH', 'MATCH_SAME_DOCUMENT', canonique.id, 'M2');
      }
    }
    // Fusion V1 (B8, ch. 8.4, F-049) : la source porte des références EXACTES
    // de plusieurs Opérations compatibles entre elles — preuve forte qu'elles
    // sont la même réalité. Jamais sur une décision utilisateur (M0), une
    // règle de cycle de possession ou des Opérations incompatibles.
    const fusionnables = !m0.length && certains.every((x) => x.method === 'M1' || (x.method === 'M2' && x.why === 'SAME_SOURCE'));
    const parId = new Map(ctx.operations.map((o) => [o.id, o]));
    const ops = ids.map((id) => parId.get(id)).filter((o): o is ExistingOperation => !!o);
    if (fusionnables && ops.length === ids.length && ops.every((a, i) => ops.slice(i + 1).every((b) => operationsMergeable(a, b, ctx.nonMergeable)))) {
      const canonique = canonicalOf(ops);
      const m = certains.find((x) => x.operationId === canonique.id)!;
      const d = res('MATCH_AND_ENRICH', 'MATCH_MERGE', canonique.id, m.method);
      d.mergeIds = ids.filter((id) => id !== canonique.id).sort((a, b) => a - b);
      return d;
    }
    return arbitrate(c, ops, res, 'CERTAIN', 'ARBITRATION_REQUIRED');
  }
  if (detail.contradictions.length) return res('HOLD_UNRESOLVED', 'CONTRADICTORY_REFERENCE');
  if (detail.plausible.length) return res('HOLD_UNRESOLVED', 'M3_REQUIRED');
  // Aucune Opération ne peut représenter cette réalité : créer seulement si la
  // source établit seule son existence (C5) et dans le périmètre.
  if (c.confidence !== 'certain' && !ctx.userDistinct) return res('HOLD_UNRESOLVED', 'PROBABLE_WITHOUT_MATCH');
  if (creationOutOfPerimeter(c, ctx.assetStatus)) return res('HOLD_UNRESOLVED', 'TARGET_OUT_OF_PORTFOLIO');
  return res('CREATE_NEW', c.confidence === 'certain' ? 'NO_MATCH_ESTABLISHED' : 'USER_DISTINCT_OPERATION');
}

// ── Lot 78A : contrôle d'identité économique ───────────────────────────────

/**
 * Identité économique du candidat face à une Opération (pure) : source par
 * source quand elles sont fournies (`members`), sinon face à l'agrégat.
 */
export function economicCheck(c: CandidateIdentity, op: ExistingOperation, basis: IdentityBasis): IdentityAssessment & { against: number[] } {
  const members: readonly OperationMember[] = op.members?.length
    ? op.members
    : [{ sourceId: 0, footprint: footprintOfOperation(op), anchor: true }];
  return assessAgainstMembers(footprintOfIdentity(c), members, basis);
}

/**
 * Le contrôle d'identité a-t-il besoin des sources de l'Opération (pure) ?
 * Continuité, référence commune, ou acquisition / cession du même bien :
 * seules ces Opérations sont chargées source par source (borne NFR-OP-010).
 */
export function needsEconomicMembers(c: CandidateIdentity, op: ExistingOperation): boolean {
  if (op.sameSource || sharedIdentifyingReferences(c, op).length) return true;
  const type = c.type ?? op.typeCode;
  return (type === 'ACQUISITION' || type === 'DISPOSAL') && c.type === op.typeCode && c.assetIds.some((a) => op.assetIds.includes(a));
}

// ── Lot 76H : deux candidats d'un même document ────────────────────────────

/**
 * Deux candidats T1 d'un MÊME document décrivent-ils la même réalité (pure) ?
 * Seulement sur PREUVE : une référence identifiante commune (M1 : même
 * facture, même devis, même ordre de travail…), d'un même prestataire (ou
 * sans prestataire contradictoire), sans aucun hard negative (type, cibles,
 * ordre de travail divergent). Même document, même date, même bien ou types
 * entretien / réparation compatibles ne suffisent JAMAIS (F-027 : deux
 * travaux sans référence propre restent deux Opérations).
 *
 * C'est la règle que T3 appliquait déjà à la réanalyse (M1 vers l'Opération
 * créée par le premier candidat → fusion V1) : l'appliquer dès le premier
 * passage rend l'issue indépendante du nombre de passages (§3.3).
 */
export function sameDocumentReality(c: CandidateIdentity, other: CandidateIdentity): boolean {
  if (c.fileId !== other.fileId || c.candidateKey === other.candidateKey) return false;
  if (!other.established || other.confidence === 'conflictual') return false;
  const pseudo: ExistingOperation = {
    id: 0, typeCode: other.type, status: other.status, providerKey: other.providerKey, assetIds: other.assetIds,
    refs: other.refs.map((r) => ({ kind: r.kind, normalized: r.normalized })),
    plannedDate: other.dates.plannedDate, startDate: other.dates.startDate, realizedDate: other.dates.realizedDate, endDate: other.dates.endDate,
  };
  if (hardNegatives(c, pseudo).length) return false;
  if (sharedIdentifyingReferences(c, pseudo).length) return !referenceProviderMismatch(c, pseudo);
  // Lot 78A (§2A, §7 « trois candidats redondants ») : plusieurs candidats qui
  // décrivent la MÊME transaction (commande, facture, règlement d'un même
  // achat) sans numéro commun.
  return sameTransactionDescription(c, other);
}

/**
 * Deux candidats d'un même document décrivent-ils la même transaction, sans
 * référence commune (pure) ? Description économique IDENTIQUE : même nature,
 * même tiers, mêmes biens et équipements, mêmes montants (au moins un, mêmes
 * valeurs principales ou réglées), dates compatibles (égales ou absentes
 * d'un côté), aucune référence de même nature divergente, objets non
 * contradictoires. Le seul document partagé, une même date ou un même bien ne
 * suffisent JAMAIS (F-027) : deux travaux distincts d'une même facture ont des
 * montants ou des objets différents et restent deux Opérations.
 */
export function sameTransactionDescription(c: CandidateIdentity, other: CandidateIdentity): boolean {
  if (c.type !== other.type) return false;
  if (c.providerKey !== other.providerKey) return false;
  const memes = (x: readonly number[], y: readonly number[]) => x.length === y.length && x.every((v) => y.includes(v));
  if (!memes(c.assetIds, other.assetIds) || !memes(c.equipmentIds, other.equipmentIds)) return false;
  const a = footprintOfIdentity(c);
  const b = footprintOfIdentity(other);
  const valeurs = (f: typeof a) => new Set([...f.principal, ...f.payments].map((m) => `${m.currency}:${m.amountMinor}`));
  const va = valeurs(a);
  const vb = valeurs(b);
  if (!va.size || va.size !== vb.size || ![...va].every((v) => vb.has(v))) return false;
  if (a.date !== null && b.date !== null && a.date !== b.date) return false;
  for (const kind of new Set(c.refs.map((r) => r.kind))) {
    if (disjoints(refSet(c.refs, [kind]), refSet(other.refs, [kind]))) return false;
  }
  // Une preuve de règlement décrit le paiement, pas l'objet : sa formulation ne contredit rien.
  if (c.role === 'PAYMENT_PROOF' || other.role === 'PAYMENT_PROOF') return true;
  const na = natureTokens(c.summary);
  const nb = natureTokens(other.summary);
  return !(na.size && nb.size && ![...na].some((m) => nb.has(m)));
}

// ── Fusion V1 (B8, ch. 8.4) ────────────────────────────────────────────────

const paire = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * Deux Opérations peuvent-elles être la même réalité ? (pure) Types égaux
 * (ou l'un nul), cibles compatibles, prestataires compatibles, aucune
 * référence identifiante divergente, pas deux factures finales distinctes
 * (F-033 : un paiement qui cite deux factures ne les fusionne pas), aucune
 * décision utilisateur qui les sépare (F-046).
 */
export function operationsMergeable(
  a: ExistingOperation, b: ExistingOperation, nonMergeable?: ReadonlySet<string>,
  /**
   * Lot 55B (D6) : identité commune établie SÉMANTIQUEMENT (verdict M3
   * certain, décision utilisateur) et non par une référence citée : deux
   * numéros de facture différents ne l'excluent plus (indice contraire déjà
   * pesé), et un contrat peut absorber ses échéances qualifiées autrement.
   */
  opts: { semantic?: boolean } = {},
): boolean {
  if (nonMergeable?.has(paire(a.id, b.id))) return false;
  const croise = opts.semantic === true && recurringPair(a, b);
  if (a.typeCode !== null && b.typeCode !== null && a.typeCode !== b.typeCode && !croise) return false;
  if (a.assetIds.length && b.assetIds.length && !a.assetIds.some((x) => b.assetIds.includes(x))) return false;
  if (a.providerKey !== null && b.providerKey !== null && a.providerKey !== b.providerKey) return false;
  const type = croise ? 'CONTRACT' : a.typeCode ?? b.typeCode;
  for (const fam of negativeFamilies(type)) {
    if (disjoints(refSet(a.refs, fam), refSet(b.refs, fam))) return false;
  }
  if (!opts.semantic && (type === 'INTERVENTION' || type === 'OTHER' || type === null)
    && disjoints(refSet(a.refs, ['INVOICE']), refSet(b.refs, ['INVOICE']))) return false;
  // Lot 78A (§2C) : jamais une fusion de deux transactions économiquement
  // incompatibles (ordres de grandeur, équipements disjoints).
  const ident = assessAgainstMembers(footprintOfOperation(a), [{ sourceId: b.id, footprint: footprintOfOperation(b), anchor: true }], 'SEMANTIC');
  return ident.verdict !== 'CONTRADICTED';
}

/** Canonique d'une fusion : la plus ancienne Opération active (à défaut la plus ancienne). */
export function canonicalOf(ops: readonly ExistingOperation[]): ExistingOperation {
  const actives = ops.filter((o) => !o.invalidated);
  return [...(actives.length ? actives : ops)].sort((x, y) => x.id - y.id)[0];
}

// ── Ambiguïté (C6 étape 18, ch. 20, B19) ───────────────────────────────────

/**
 * Le rattachement change-t-il un bien, un montant ou un statut ? (pure) Sans
 * impact, l'incertitude n'est pas soumise à l'utilisateur (C5 : « ne pas
 * polluer À traiter »).
 */
export function hasBusinessImpact(c: CandidateIdentity, ops: readonly ExistingOperation[]): boolean {
  return componentsFromIdentity(c).length > 0 || c.assetIds.length > 0 || ops.some((o) => o.status !== c.status);
}

function arbitrate(
  c: CandidateIdentity, ops: readonly ExistingOperation[],
  res: (outcome: T3Outcome, reason: string) => CandidateDecision, basis: 'CERTAIN' | 'M3', reason: string,
): CandidateDecision {
  if (!hasBusinessImpact(c, ops)) return res('HOLD_UNRESOLVED', `${reason}_NO_IMPACT`);
  const d = res('ARBITRATION_REQUIRED', reason);
  d.arbitration = { basis, operationIds: ops.map((o) => o.id) };
  return d;
}

// ── Niveau M3 : verdict sémantique (C6.1, C6.2, C7) ────────────────────────

/**
 * Applique le verdict M3 (déjà passé au monde fermé, empreinte de contexte
 * vérifiée par l'appelant) à une décision « M3_REQUIRED ». Pure.
 *   · ATTACH (lot 56A : issue explicite validée ; verdict antérieur :
 *     SAME_OPERATION + certain) + candidat encore plausible → MATCH_AND_ENRICH (M3, F-059) ;
 *   · DISTINCT (verdict antérieur : DISTINCT_OPERATION + certain) → CREATE_NEW
 *     si la source peut créer seule (C5), sinon attente ;
 *   · ARBITRATE (verdict antérieur : probable, conflictuel, AMBIGUOUS — F-058) → ambiguïté :
 *     « À traiter » si impact métier, sinon attente. Jamais de rattachement
 *     silencieux.
 */
export function applyM3Verdict(
  c: CandidateIdentity, base: CandidateDecision, verdict: OperationMatchVerdict, ctx: Pick<MatchContext, 'operations' | 'assetStatus' | 'userDistinct'>,
): CandidateDecision {
  if (base.outcome !== 'HOLD_UNRESOLVED' || base.reason !== 'M3_REQUIRED') return base;
  const detail = base.detail;
  const res = (outcome: T3Outcome, reason: string, operationId: number | null = null, matchMethod: MatchMethod | null = null): CandidateDecision =>
    ({ outcome, operationId, matchMethod, reason, detail });
  const plausibles = detail.plausible;
  // Lot 56A : issue explicite du modèle validée par le serveur (`translateOperationMatch`) ;
  // verdict antérieur sans issue : règle historique (`m3Resolution`).
  const issue = m3Resolution(verdict);
  if (issue === 'ATTACH' && verdict.matchedOperationId !== null && plausibles.includes(verdict.matchedOperationId)) {
    // Lot 78A (§2B) : un verdict IA ne rattache pas une transaction
    // économiquement contredite (contradiction forte) — l'utilisateur tranche.
    const cible = ctx.operations.find((o) => o.id === verdict.matchedOperationId);
    const ident = cible ? economicCheck(c, cible, 'SEMANTIC') : null;
    if (!ident || ident.verdict !== 'CONTRADICTED') return res('MATCH_AND_ENRICH', 'MATCH_M3', verdict.matchedOperationId, 'M3');
    (detail.identity ??= []).push({ operationId: verdict.matchedOperationId, basis: 'SEMANTIC', outcome: 'REFUSED', signals: identitySignals(ident) });
    const parId0 = new Map(ctx.operations.map((o) => [o.id, o]));
    const ops0 = [verdict.matchedOperationId, ...plausibles.filter((id) => id !== verdict.matchedOperationId)]
      .map((id) => parId0.get(id)).filter((o): o is ExistingOperation => !!o);
    return arbitrate(c, ops0, res, 'M3', 'M3_IDENTITY_CONTRADICTED');
  }
  if (issue === 'DISTINCT') {
    if (c.confidence !== 'certain' && !ctx.userDistinct) return res('HOLD_UNRESOLVED', 'PROBABLE_WITHOUT_MATCH');
    if (creationOutOfPerimeter(c, ctx.assetStatus)) return res('HOLD_UNRESOLVED', 'TARGET_OUT_OF_PORTFOLIO');
    return res('CREATE_NEW', 'M3_DISTINCT');
  }
  const parId = new Map(ctx.operations.map((o) => [o.id, o]));
  const ordre = verdict.matchedOperationId !== null && plausibles.includes(verdict.matchedOperationId)
    ? [verdict.matchedOperationId, ...plausibles.filter((id) => id !== verdict.matchedOperationId)]
    : [...plausibles].sort((a, b) => b - a);
  const ops = ordre.map((id) => parId.get(id)).filter((o): o is ExistingOperation => !!o);
  return arbitrate(c, ops, res, 'M3', 'M3_AMBIGUOUS');
}
