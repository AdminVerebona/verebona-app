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
 * Raisons auditables (B6) : chaque décision rend ses motifs stables.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { BusinessOperationStatus, BusinessOperationTypeCode, MatchMethod, ReferenceKind } from '../model';
import { componentsFromIdentity, type CandidateIdentity } from './model';
import type { OperationMatchVerdict } from '@/services/ai/reconciliation/master/operation-match';

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
  if (c.type !== null && op.typeCode !== null && c.type !== op.typeCode && op.typeCode !== 'OTHER') out.push('TYPE_INCOMPATIBLE');
  if (c.assetIds.length && op.assetIds.length && !c.assetIds.some((a) => op.assetIds.includes(a))) out.push('TARGET_INCOMPATIBLE');
  const type = c.type ?? op.typeCode;
  for (const fam of negativeFamilies(type)) {
    if (disjoints(refSet(c.refs, fam), refSet(op.refs, fam))) out.push(`REFERENCE_DIFFERENT_${fam.join('_')}`);
  }
  // C7.2 / F-033 : deux factures FINALES de numéros différents, sans aucune
  // référence commune, sont deux interventions. Ne vaut ni pour un acompte /
  // un solde (qui se rattachent par référence), ni pour un contrat ou un
  // financement (factures périodiques d'une même relation).
  if ((type === 'INTERVENTION' || type === 'OTHER' || type === null) && c.role === 'INVOICE'
    && !c.hints.some((h) => h.amountScope === 'DEPOSIT' || h.amountScope === 'BALANCE')
    && disjoints(refSet(c.refs, ['INVOICE']), refSet(op.refs, ['INVOICE']))
    && sharedIdentifyingReferences(c, op).length === 0) {
    out.push('REFERENCE_DIFFERENT_INVOICE');
  }
  return out;
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
function proches(a: string | null, b: string | null, jours: number): boolean {
  if (!a || !b) return true;
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) <= jours * JOUR;
}
const dateCandidat = (c: CandidateIdentity) => c.dates.realizedDate ?? c.dates.plannedDate ?? c.dates.startDate ?? c.dates.endDate;
const dateOperation = (o: ExistingOperation) => o.realizedDate ?? o.plannedDate ?? o.startDate ?? o.endDate;
const memeTiers = (c: CandidateIdentity, o: ExistingOperation) => c.providerKey !== null && c.providerKey === o.providerKey;
const ciblesCompatibles = (c: CandidateIdentity, o: ExistingOperation) =>
  !c.assetIds.length || !o.assetIds.length || c.assetIds.some((a) => o.assetIds.includes(a));

/** Fenêtre de cohérence temporelle d'une même intervention (jours). */
export const INTERVENTION_PERIOD_DAYS = 120;
/** Fenêtre d'un même sinistre déclaré sans référence (jours). */
export const CLAIM_PERIOD_DAYS = 30;
/** Lot 47B : document ↔ intervention établie par l'agenda seul, même bien (jours). */
export const AGENDA_OPERATION_PERIOD_DAYS = 60;

/**
 * L'Opération POURRAIT-elle représenter la même réalité (forts C7 réunis sans
 * clé exacte) ? Une Opération plausible interdit la création (EXH-004) et
 * appellerait un rapprochement sémantique M3 (hors lot).
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
  switch (type) {
    case 'CONTRACT':
    case 'FINANCING':
      return memeTiers(c, o) && ciblesCompatibles(c, o);
    case 'CLAIM':
      return (c.dates.realizedDate !== null && c.dates.realizedDate === o.realizedDate && c.assetIds.some((a) => o.assetIds.includes(a)))
        || (memeTiers(c, o) && ciblesCompatibles(c, o) && proches(dateCandidat(c), dateOperation(o), CLAIM_PERIOD_DAYS));
    case 'ACQUISITION':
    case 'DISPOSAL':
      // Couvert par la règle de cycle (M2) ; hors cycle : rien de plausible.
      return false;
    default:
      return memeTiers(c, o) && ciblesCompatibles(c, o) && proches(dateCandidat(c), dateOperation(o), INTERVENTION_PERIOD_DAYS);
  }
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

  for (const op of ctx.operations) {
    if (ctx.rejected.has(op.id)) { detail.excluded.push({ operationId: op.id, why: 'USER_REJECTED' }); continue; }
    if (ctx.confirmed.has(op.id)) { detail.certain.push({ operationId: op.id, method: 'M0', why: 'USER_CONFIRMED' }); continue; }
    const negatifs = hardNegatives(c, op);
    if (op.invalidated && !op.sameSource) {
      // F-052 / F-053 : une Opération invalidée n'est rattachée que par une
      // référence exacte non contredite ; sinon elle n'existe pas pour T3.
      const communes = sharedIdentifyingReferences(c, op);
      if (communes.length && !negatifs.length) detail.certain.push({ operationId: op.id, method: 'M1', why: `REFERENCE ${communes.join(',')} (INVALIDATED)` });
      else detail.excluded.push({ operationId: op.id, why: 'INVALIDATED' });
      continue;
    }
    if (op.sameSource) {
      // M2 : même source documentaire déjà liée (réanalyse, restauration). Une
      // requalification d'un type connu vers un autre type connu n'est pas la
      // même réalité (C9 : la source est déplacée).
      if (negatifs.includes('TYPE_INCOMPATIBLE')) { detail.excluded.push({ operationId: op.id, why: 'SAME_SOURCE_TYPE_CHANGED' }); continue; }
      detail.certain.push({ operationId: op.id, method: 'M2', why: 'SAME_SOURCE' });
      continue;
    }
    const communes = sharedIdentifyingReferences(c, op);
    if (communes.length) {
      if (negatifs.length) { detail.contradictions.push({ operationId: op.id, why: `${communes[0]} / ${negatifs.join(',')}` }); continue; }
      detail.certain.push({ operationId: op.id, method: 'M1', why: `REFERENCE ${communes.join(',')}` });
      continue;
    }
    if (negatifs.length) { detail.excluded.push({ operationId: op.id, why: negatifs.join(',') }); continue; }
    const type = c.type ?? op.typeCode;
    if ((type === 'ACQUISITION' || type === 'DISPOSAL') && c.type === op.typeCode
      && c.assetIds.some((a) => op.assetIds.includes(a)) && op.status !== 'CANCELLED') {
      const bornes = type === 'ACQUISITION' ? bornesAcq : bornesCes;
      if (sameOwnershipCycle(c, op, bornes)) {
        detail.certain.push({ operationId: op.id, method: 'M2', why: `OWNERSHIP_CYCLE_${type}` });
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
    return res('MATCH_AND_ENRICH', `MATCH_${m.method}`, ids[0], m.method);
  }
  if (ids.length > 1) {
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

// ── Fusion V1 (B8, ch. 8.4) ────────────────────────────────────────────────

const paire = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * Deux Opérations peuvent-elles être la même réalité ? (pure) Types égaux
 * (ou l'un nul), cibles compatibles, prestataires compatibles, aucune
 * référence identifiante divergente, pas deux factures finales distinctes
 * (F-033 : un paiement qui cite deux factures ne les fusionne pas), aucune
 * décision utilisateur qui les sépare (F-046).
 */
export function operationsMergeable(a: ExistingOperation, b: ExistingOperation, nonMergeable?: ReadonlySet<string>): boolean {
  if (nonMergeable?.has(paire(a.id, b.id))) return false;
  if (a.typeCode !== null && b.typeCode !== null && a.typeCode !== b.typeCode) return false;
  if (a.assetIds.length && b.assetIds.length && !a.assetIds.some((x) => b.assetIds.includes(x))) return false;
  if (a.providerKey !== null && b.providerKey !== null && a.providerKey !== b.providerKey) return false;
  const type = a.typeCode ?? b.typeCode;
  for (const fam of negativeFamilies(type)) {
    if (disjoints(refSet(a.refs, fam), refSet(b.refs, fam))) return false;
  }
  if ((type === 'INTERVENTION' || type === 'OTHER' || type === null) && disjoints(refSet(a.refs, ['INVOICE']), refSet(b.refs, ['INVOICE']))) return false;
  return true;
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
 *   · SAME_OPERATION + certain + candidat encore plausible → MATCH_AND_ENRICH (M3, F-059) ;
 *   · DISTINCT_OPERATION + certain → CREATE_NEW si la source peut créer
 *     seule (C5), sinon attente ;
 *   · tout le reste (probable, conflictuel, AMBIGUOUS — F-058) → ambiguïté :
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
  if (verdict.decision === 'SAME_OPERATION' && verdict.confidence === 'certain'
    && verdict.matchedOperationId !== null && plausibles.includes(verdict.matchedOperationId)) {
    return res('MATCH_AND_ENRICH', 'MATCH_M3', verdict.matchedOperationId, 'M3');
  }
  if (verdict.decision === 'DISTINCT_OPERATION' && verdict.confidence === 'certain') {
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
