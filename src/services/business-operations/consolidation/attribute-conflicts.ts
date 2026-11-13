/**
 * Lot 113AQ (Trello #750, anomalie BO #12) — QUALIFICATION des contradictions
 * d'attributs d'une Opération (pur, sans IA, sans base).
 *
 * Le moteur 78A (`consolidateOperationState`) relève, pour chaque attribut
 * (date prévue, de début, de réalisation, de fin, prestataire), les valeurs
 * distinctes portées par les sources ACTIVES de l'Opération. Avant 113AQ,
 * toute différence de ce relevé devenait une « contradiction » ouverte
 * (`attribute_provenance.conflicts`) et l'anomalie dure
 * IDENTITY_ATTRIBUTE_CONFLICT, quel que soit le RÔLE des valeurs comparées.
 * Causes de faux conflits démontrées (tests L113AQ-U-CAUSES) :
 *   · rôles de dates différents comparés entre eux : paiement ≠ réalisation,
 *     fin de validité d'un devis ≠ fin de période facturée, couverture ≠ effet
 *     contractuel ;
 *   · parties de rôles différents comparées entre elles : banque d'une preuve
 *     de paiement, office notarial d'un acte, intervenant d'un rapport,
 *     émetteur inconnu ≠ fournisseur facturant ;
 *   · désignations ÉQUIVALENTES d'un même prestataire (équivalences prouvées
 *     du compte, lot 86C, que le relevé n'utilisait pas ; « & » / « et »,
 *     « Ets », « Société ») ;
 *   · révisions successives d'une relation durable (avenant, changement de
 *     partie) lues comme une contradiction de la valeur actuelle ;
 *   · valeur tranchée par l'utilisateur (Agenda, fiche) laissée « ouverte ».
 *
 * Règle 113AQ (version `ATTRIBUTE_CONFLICT_RULES_VERSION`) : on ne compare
 * que le MÊME attribut métier du MÊME rôle sémantique (même fait). Le relevé
 * 78A reste la seule détection (aucune nouvelle contradiction n'est créée :
 * la qualification ne fait que partager un relevé existant), et les valeurs
 * conservées sont inchangées (aucune donnée écrite autrement qu'avant).
 *
 * Qualifications (contrat #751) :
 *   LEGITIMATE_DIFFERENCE        rôles / faits différents, formats équivalents,
 *                                révision successive : AUCUN conflit (faits
 *                                conservés, consultables) ;
 *   REAL_CONFLICT_RESOLVED       contradiction du même fait tranchée (valeur de
 *                                l'utilisateur, rétablissement BO) ;
 *   REAL_CONFLICT_UNRESOLVED     même fait prouvé (même référence, fait unique)
 *                                et valeurs incompatibles, non tranché ;
 *   INSUFFICIENT_EVIDENCE        même rôle mais identité du fait non établie
 *                                (ou rôle inconnu) : non vérifiable ;
 *   SOURCE_LINK_ERROR_SUSPECTED  une source porte un doute d'identité ouvert
 *                                (78A) ou des cibles disjointes : le mauvais
 *                                rapprochement se traite d'abord ;
 *   CHECK_FAILED                 contrôle non achevé (posé à la LECTURE par
 *                                le diagnostic #751, jamais ici).
 * Aucune règle par enseigne, mot-clé ou exemple : seulement les rôles des
 * sources (`SOURCE_ROLES`) et l'identité économique déjà persistée.
 */
import type { BusinessOperationTypeCode, SourceRole } from '../model';
import { normalizeProvider, transactionWindowDays, type AttributeProvenance, type CandidateIdentity, type SourceContribution } from './model';

/** Version de la règle de qualification (portée par chaque provenance écrite). */
export const ATTRIBUTE_CONFLICT_RULES_VERSION = 2;
export const ATTRIBUTE_CONFLICT_RULES = 'iac-113aq-v2';

export const ATTRIBUTE_CONFLICT_QUALIFICATIONS = [
  'LEGITIMATE_DIFFERENCE', 'REAL_CONFLICT_RESOLVED', 'REAL_CONFLICT_UNRESOLVED',
  'INSUFFICIENT_EVIDENCE', 'SOURCE_LINK_ERROR_SUSPECTED', 'CHECK_FAILED',
] as const;
export type AttributeConflictQualification = (typeof ATTRIBUTE_CONFLICT_QUALIFICATIONS)[number];

/** Qualifications qui maintiennent l'alerte (conflit actif ou non vérifiable). */
export const ALERTING_QUALIFICATIONS: readonly AttributeConflictQualification[] = [
  'REAL_CONFLICT_UNRESOLVED', 'SOURCE_LINK_ERROR_SUSPECTED', 'INSUFFICIENT_EVIDENCE', 'CHECK_FAILED',
];

export type ConflictField = 'plannedDate' | 'startDate' | 'realizedDate' | 'endDate' | 'provider';
export const CONFLICT_FIELDS: readonly ConflictField[] = ['plannedDate', 'startDate', 'realizedDate', 'endDate', 'provider'];

/** Relevé 78A (forme persistée historique). */
export interface RawAttributeConflict {
  field: ConflictField;
  values: Array<{ value: string; sourceIds: number[] }>;
  retained: string | null;
}

/** Une source d'une valeur, avec son rôle sémantique (fait comparé). */
export interface ConflictValueSource {
  id: number;
  /** Rôle sémantique de la valeur pour CET attribut (`semanticRoleOf`). */
  role: string;
  /** Rôle du document (`SOURCE_ROLES`), null si inconnu. */
  documentRole: SourceRole | null;
  /** Autorité persistée de la source (USER, DOCUMENT, STRUCTURED, INFERENCE) ou nature non documentaire. */
  authority: string | null;
}

export interface QualifiedConflictValue {
  value: string;
  normalized: string;
  sourceIds: number[];
  sources: ConflictValueSource[];
}

export interface QualifiedAttributeConflict {
  field: ConflictField;
  /** Rôle sémantique comparé (même fait) ; `MIXED` : relevé réparti sur plusieurs rôles. */
  role: string;
  values: QualifiedConflictValue[];
  retained: string | null;
  qualification: AttributeConflictQualification;
  reasonCode: string;
  /** Portées métier POTENTIELLEMENT concernées (à vérifier) ; vide : aucune incidence. */
  impact: string[];
  /** Lot 114 (#750) : `value` = valeur retenue par l'arbitrage (carte « À traiter » ou T3) ; `reviewId` = arbitrage T3. */
  resolution?: { by: 'USER' | 'ADMIN' | 'T3'; sourceId?: number; value?: string; reviewId?: number };
  protection?: 'USER' | 'ADMIN' | 'IMPORT';
  /** Valeur persistée sur l'Opération au moment du contrôle (posée par le consolidateur). */
  current?: string | null;
  /** Lot 114 (#750, issue B) : issue du dernier examen T3 de cette ligne (absente : jamais examinée). */
  t3?: { outcome: AttributeReview['outcome']; reviewId?: number };
}

export interface QualificationContext {
  type: BusinessOperationTypeCode | null;
  contributions: readonly SourceContribution[];
  provenance: AttributeProvenance;
  /** Source → autorité et nature persistées. */
  sourceMeta?: ReadonlyMap<number, { authority: string | null; kind: string | null }>;
  /** Sources visées par un doute d'identité OUVERT (78A, SUSPECT). */
  suspectSourceIds?: ReadonlySet<number>;
  /** Lot 114 (#750) : arbitrages durables (utilisateur, T3) par `attributeChoiceKey`. */
  choices?: ReadonlyMap<string, AttributeChoice>;
  /** Lot 114 (#750) : examens T3 sans arbitrage (différence légitime, abstention…) par `attributeReviewKey`. */
  reviews?: ReadonlyMap<string, AttributeReview>;
}

/**
 * Lot 114 (#750, issues B et C) — arbitrage DURABLE d'une contradiction réelle : la valeur retenue
 * pour un attribut et un rôle, et les valeurs connues au moment de la décision. Une valeur nouvelle
 * (absente de `known`) rouvre la contradiction avec son motif ; un constat identique ne la rouvre jamais.
 */
export interface AttributeChoice {
  field: ConflictField;
  role: string;
  /** Valeur retenue, forme de comparaison (`normalizeConflictDate` / `normalizeConflictProvider`). */
  normalized: string;
  /** Formes de comparaison de toutes les valeurs présentées à la décision. */
  known: string[];
  by: 'USER' | 'T3';
  /** Source de décision (`USER_ARBITRATION`) de l'utilisateur. */
  sourceId?: number;
  /** Arbitrage T3 (`business_operation_attribute_arbitrations`). */
  reviewId?: number;
}

/** Lot 114 (#750, issue B) — examen T3 d'une ligne qui n'a PAS retenu de valeur. */
export interface AttributeReview {
  field: ConflictField;
  role: string;
  /** Formes de comparaison des valeurs examinées (un constat différent n'est pas couvert). */
  known: string[];
  outcome: 'LEGITIMATE_DIFFERENCE' | 'UNDECIDABLE' | 'LINK_ERROR' | 'ABSTAINED' | 'FAILED' | 'PENDING';
  reviewId?: number;
}

export const attributeChoiceKey = (field: ConflictField, role: string): string => `${field}|${role}`;
export const attributeReviewKey = attributeChoiceKey;

// ── Rôles sémantiques ─────────────────────────────────────────────────────

const USER_ROLE = 'USER_ENTRY';
const UNKNOWN_ROLE = 'UNKNOWN';

const BILLING: ReadonlySet<string> = new Set(['INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE']);

/**
 * Rôle sémantique d'une valeur selon l'attribut et le rôle de sa source :
 * deux valeurs ne sont comparables que si ce rôle est le même.
 */
export function semanticRoleOf(field: ConflictField, identity: Pick<CandidateIdentity, 'role' | 'agenda' | 'structured' | 'coverageDocument'>,
  authority: string | null = null): string {
  if (identity.agenda || authority === 'USER') return USER_ROLE;
  if (identity.structured) {
    // Donnée structurée du bien : un achat / une cession portent la date du fait lui-même.
    return field === 'realizedDate' ? 'REALIZATION' : field === 'provider' ? 'SUPPLIER' : `STRUCTURED_${field.toUpperCase()}`;
  }
  const r = identity.role;
  if (r === null || r === 'OTHER_EVIDENCE') return UNKNOWN_ROLE;
  if (field === 'provider') {
    if (r === 'QUOTE' || r === 'ORDER' || BILLING.has(r) || r === 'CONTRACT_DOCUMENT') return 'SUPPLIER';
    if (r === 'REPORT') return 'EXECUTANT';
    if (r === 'PAYMENT_PROOF' || r === 'REFUND_PROOF') return 'PAYMENT_INTERMEDIARY';
    if (r === 'SALE_DOCUMENT') return 'DEED_ISSUER';
    return 'CLAIM_PARTY';
  }
  if (field === 'realizedDate') {
    if (r === 'PAYMENT_PROOF' || r === 'REFUND_PROOF') return 'PAYMENT';
    if (r === 'CREDIT_NOTE') return 'CREDIT';
    if (r === 'QUOTE') return 'QUOTE';
    return 'REALIZATION';
  }
  if (field === 'plannedDate') {
    if (r === 'QUOTE') return 'QUOTE_PLANNED';
    if (r === 'ORDER') return 'ORDER_PLANNED';
    if (r === 'CONTRACT_DOCUMENT') return 'CONTRACT_PLANNED';
    return 'PLANNED';
  }
  // startDate / endDate
  const bord = field === 'startDate' ? 'START' : 'END';
  if (identity.coverageDocument) return `COVERAGE_${bord}`;
  if (r === 'CONTRACT_DOCUMENT') return field === 'startDate' ? 'CONTRACT_EFFECTIVE' : 'CONTRACT_END';
  if (r === 'QUOTE') return `QUOTE_VALIDITY_${bord}`;
  if (BILLING.has(r)) return `BILLING_PERIOD_${bord}`;
  if (r === 'PAYMENT_PROOF' || r === 'REFUND_PROOF') return `PAYMENT_${bord}`;
  return bord;
}

// ── Normalisation (formats équivalents) ───────────────────────────────────

const PARIS_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Date normalisée AAAA-MM-JJ (jour de Paris pour un instant) ; null si illisible. */
export function normalizeConflictDate(raw: string): string | null {
  const v = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const fr = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (fr) return `${fr[3]}-${fr[2].padStart(2, '0')}-${fr[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    // Instant avec fuseau : jour de Paris ; sans fuseau : jour écrit.
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(v)) return v.slice(0, 10);
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : PARIS_DAY.format(d);
  }
  return null;
}

/** Désignations génériques d'une forme d'entreprise (jamais une enseigne). */
const FORMES_GENERIQUES = /\b(societe|ste|ets|etablissements|entreprise|et)\b/g;

/** Clé de comparaison d'un prestataire : équivalence prouvée du compte, sinon forme normalisée. */
export function normalizeConflictProvider(raw: string, canonicalKey: string | null = null): string {
  if (canonicalKey) return canonicalKey;
  const etendu = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(FORMES_GENERIQUES, ' ');
  return normalizeProvider(etendu) ?? normalizeProvider(raw) ?? raw.trim().toLowerCase();
}

const ecart = (a: string, b: string): number => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

// ── Qualification ─────────────────────────────────────────────────────────

const IMPACT: Record<ConflictField, string[]> = {
  plannedDate: ['OPERATION', 'TIMELINE_AGENDA'],
  startDate: ['OPERATION', 'TIMELINE_AGENDA'],
  realizedDate: ['OPERATION', 'TIMELINE_AGENDA'],
  endDate: ['OPERATION', 'TIMELINE_AGENDA'],
  provider: ['OPERATION', 'SUPPLIER'],
};

interface Item { value: string; normalized: string; sourceId: number; identity: CandidateIdentity | null; src: ConflictValueSource }

function valuesOf(items: readonly Item[]): QualifiedConflictValue[] {
  const out: QualifiedConflictValue[] = [];
  for (const it of items) {
    const v = out.find((x) => x.value === it.value);
    if (v) {
      if (!v.sourceIds.includes(it.sourceId)) { v.sourceIds.push(it.sourceId); v.sources.push(it.src); }
    } else out.push({ value: it.value, normalized: it.normalized, sourceIds: [it.sourceId], sources: [it.src] });
  }
  for (const v of out) { v.sourceIds.sort((a, b) => a - b); v.sources.sort((a, b) => a.id - b.id); }
  return out.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/** Valeurs distinctes (normalisées) qui se contredisent selon la règle 78A (fenêtre de la transaction pour une date). */
function contradicts(field: ConflictField, normalized: readonly string[], window: number | null): boolean {
  const d = [...new Set(normalized)].sort();
  if (d.length < 2) return false;
  if (field === 'provider') return true;
  if (window === null) return false;
  return ecart(d[0], d[d.length - 1]) > window;
}

const refsOf = (i: CandidateIdentity | null): string[] => (i?.refs ?? []).map((r) => `${r.kind}:${r.normalized}`);

/** Les valeurs du groupe désignent-elles le MÊME fait (référence commune entre sources de valeurs différentes) ? */
function sharedReference(items: readonly Item[]): boolean {
  const parValeur = new Map<string, Set<string>>();
  for (const it of items) {
    const s = parValeur.get(it.normalized) ?? new Set<string>();
    for (const r of refsOf(it.identity)) s.add(r);
    parValeur.set(it.normalized, s);
  }
  const ens = [...parValeur.values()];
  for (let i = 0; i < ens.length; i++) for (let j = i + 1; j < ens.length; j++) if ([...ens[i]].some((r) => ens[j].has(r))) return true;
  return false;
}

/** Cibles explicites (DOCUMENT) disjointes entre valeurs : sources d'objets différents. */
function disjointTargets(items: readonly Item[]): boolean {
  const parValeur = new Map<string, Set<number>>();
  for (const it of items) {
    if (it.identity?.targetAuthority !== 'DOCUMENT') continue;
    const s = parValeur.get(it.normalized) ?? new Set<number>();
    for (const a of it.identity.assetIds) s.add(a);
    parValeur.set(it.normalized, s);
  }
  const ens = [...parValeur.values()].filter((s) => s.size > 0);
  if (ens.length < 2) return false;
  for (let i = 0; i < ens.length; i++) for (let j = i + 1; j < ens.length; j++) if ([...ens[i]].some((a) => ens[j].has(a))) return false;
  return true;
}

/** Révisions successives d'une relation durable : chaque valeur portée par une date d'effet distincte. */
function successiveRevisions(items: readonly Item[]): boolean {
  const effets = new Map<string, Set<string>>();
  for (const it of items) {
    const d = it.identity?.dates.startDate;
    if (!d) return false;
    const s = effets.get(it.normalized) ?? new Set<string>();
    s.add(d);
    effets.set(it.normalized, s);
  }
  const vus = new Set<string>();
  for (const s of effets.values()) for (const d of s) { if (vus.has(d)) return false; vus.add(d); }
  return effets.size >= 2;
}

const SINGLE_FACT: ReadonlySet<string> = new Set(['ACQUISITION', 'DISPOSAL', 'CLAIM']);
const DURABLE: ReadonlySet<string> = new Set(['CONTRACT', 'FINANCING']);

/** Valeurs d'un relevé, une par source, avec rôle sémantique et forme de comparaison. */
function itemsOf(c: RawAttributeConflict, ctx: QualificationContext, byId: ReadonlyMap<number, CandidateIdentity>): Item[] {
  const items: Item[] = [];
  for (const v of c.values) {
    for (const sourceId of v.sourceIds) {
      const identity = byId.get(sourceId) ?? null;
      const meta = ctx.sourceMeta?.get(sourceId);
      const authority = meta?.authority ?? (identity?.agenda ? 'USER' : null);
      const role = identity ? semanticRoleOf(c.field, identity, authority) : UNKNOWN_ROLE;
      const normalized = c.field === 'provider'
        // Équivalence de désignations PROUVÉE du compte (lot 86C) : clé canonique ; sinon forme normalisée étendue.
        ? normalizeConflictProvider(v.value, identity?.providerKeyRaw !== undefined && identity.provider
          && normalizeProvider(identity.provider) === normalizeProvider(v.value) ? identity.providerKey : null)
        : normalizeConflictDate(v.value) ?? v.value;
      items.push({ value: v.value, normalized, sourceId, identity, src: { id: sourceId, role, documentRole: identity?.role ?? null, authority } });
    }
  }
  return items;
}

/**
 * Lot 114 (#750) — l'arbitrage durable couvre-t-il ce groupe ? `COVERED` : mêmes valeurs qu'à la
 * décision et valeur retenue toujours portée par une source ; `NEW_EVIDENCE` : une valeur nouvelle
 * est apparue ; `VALUE_WITHDRAWN` : la source de la valeur retenue n'est plus là.
 */
function choiceState(choice: AttributeChoice | undefined, its: readonly Item[]): 'NONE' | 'COVERED' | 'NEW_EVIDENCE' | 'VALUE_WITHDRAWN' {
  if (!choice) return 'NONE';
  if (!its.every((i) => choice.known.includes(i.normalized))) return 'NEW_EVIDENCE';
  return its.some((i) => i.normalized === choice.normalized) ? 'COVERED' : 'VALUE_WITHDRAWN';
}

const reviewCovers = (r: AttributeReview | undefined, its: readonly Item[]): r is AttributeReview =>
  !!r && its.every((i) => r.known.includes(i.normalized)) && r.known.every((k) => its.some((i) => i.normalized === k));

/**
 * Qualifie le relevé 78A (pur, déterministe). `alerting` : lignes qui
 * maintiennent l'anomalie (persistées dans `conflicts`) ; `divergences` :
 * différences légitimes ou tranchées (persistées à part, consultables).
 */
export function qualifyAttributeConflicts(raw: readonly RawAttributeConflict[], ctx: QualificationContext): {
  alerting: QualifiedAttributeConflict[]; divergences: QualifiedAttributeConflict[];
} {
  const byId = new Map(ctx.contributions.map((c) => [c.sourceId, c.identity]));
  const window = transactionWindowDays(ctx.type);
  const alerting: QualifiedAttributeConflict[] = [];
  const divergences: QualifiedAttributeConflict[] = [];

  for (const c of raw) {
    const items = itemsOf(c, ctx, byId);
    const roles = [...new Set(items.map((i) => i.src.role))].sort();
    const comparables = roles.filter((r) => r !== USER_ROLE);
    const prov = ctx.provenance[c.field];
    const userRetained = prov && c.retained !== null && prov.value === c.retained
      && items.some((i) => i.sourceId === prov.sourceId && i.src.role === USER_ROLE) ? prov.sourceId : null;
    const impact = c.retained === null ? [] : [...IMPACT[c.field]];
    const base = (role: string, its: readonly Item[]) => ({ field: c.field, role, values: valuesOf(its), retained: c.retained });

    let groupes = 0;
    for (const role of comparables) {
      const its = items.filter((i) => i.src.role === role);
      if (!contradicts(c.field, its.map((i) => i.normalized), window)) continue;
      groupes++;
      const suspect = its.some((i) => ctx.suspectSourceIds?.has(i.sourceId));
      const choix = ctx.choices?.get(attributeChoiceKey(c.field, role));
      const etat = choiceState(choix, its);
      const examen = ctx.reviews?.get(attributeReviewKey(c.field, role));
      const examine = reviewCovers(examen, its) ? examen : undefined;
      let e: QualifiedAttributeConflict;
      if (role === UNKNOWN_ROLE) {
        e = { ...base(role, its), qualification: 'INSUFFICIENT_EVIDENCE', reasonCode: 'ROLE_UNKNOWN', impact };
      } else if (suspect || disjointTargets(its)) {
        e = { ...base(role, its), qualification: 'SOURCE_LINK_ERROR_SUSPECTED', reasonCode: suspect ? 'IDENTITY_REVIEW_OPEN' : 'TARGETS_DISJOINT', impact };
      } else if (userRetained !== null) {
        e = { ...base(role, its), qualification: 'REAL_CONFLICT_RESOLVED', reasonCode: 'USER_VALUE_RETAINED', impact: [], resolution: { by: 'USER', sourceId: userRetained }, protection: 'USER' };
      } else if (choix && etat === 'COVERED') {
        // Lot 114 (#750) : contradiction tranchée par la carte « À traiter » ou par l'arbitrage T3 (preuve suffisante).
        const valeur = its.find((i) => i.normalized === choix.normalized)!.value;
        e = {
          ...base(role, its), qualification: 'REAL_CONFLICT_RESOLVED', reasonCode: choix.by === 'USER' ? 'USER_ARBITRATED' : 'T3_ARBITRATED', impact: [],
          resolution: { by: choix.by, value: valeur, ...(choix.sourceId !== undefined ? { sourceId: choix.sourceId } : {}), ...(choix.reviewId !== undefined ? { reviewId: choix.reviewId } : {}) },
          ...(choix.by === 'USER' ? { protection: 'USER' as const } : {}),
        };
      } else if (choix && etat !== 'NONE') {
        // Nouvelle preuve contradictoire (ou valeur retenue retirée) APRÈS une décision : réouverture motivée.
        e = {
          ...base(role, its), qualification: 'REAL_CONFLICT_UNRESOLVED',
          reasonCode: etat === 'NEW_EVIDENCE' ? 'NEW_EVIDENCE_AFTER_DECISION' : 'DECIDED_VALUE_WITHDRAWN', impact,
          ...(choix.by === 'USER' ? { protection: 'USER' as const } : {}),
        };
      } else if (examine?.outcome === 'LEGITIMATE_DIFFERENCE') {
        // Lot 114 (#750, issue B) : T3 a établi, preuves citées, que les valeurs portent sur des faits distincts.
        e = { ...base(role, its), qualification: 'LEGITIMATE_DIFFERENCE', reasonCode: 'T3_DISTINCT_FACTS', impact: [], ...(examine.reviewId !== undefined ? { resolution: { by: 'T3' as const, reviewId: examine.reviewId } } : {}) };
      } else if (examine?.outcome === 'LINK_ERROR') {
        e = { ...base(role, its), qualification: 'SOURCE_LINK_ERROR_SUSPECTED', reasonCode: 'T3_LINK_ERROR_SUSPECTED', impact };
      } else if (DURABLE.has(ctx.type ?? '') && successiveRevisions(its)) {
        e = { ...base(role, its), qualification: 'LEGITIMATE_DIFFERENCE', reasonCode: 'SUCCESSIVE_REVISION', impact: [] };
      } else if (role === 'QUOTE_PLANNED' || role.startsWith('QUOTE_VALIDITY') || role === 'QUOTE') {
        // Un devis révisé ou concurrent ne contredit pas la réalisation : seules la commande / la facture engagent.
        e = { ...base(role, its), qualification: 'LEGITIMATE_DIFFERENCE', reasonCode: 'QUOTE_REVISION', impact: [] };
      } else if (sharedReference(its)) {
        e = { ...base(role, its), qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'SAME_REFERENCE', impact };
      } else if (c.field === 'realizedDate' && role === 'REALIZATION' && SINGLE_FACT.has(ctx.type ?? '')) {
        e = { ...base(role, its), qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'SINGLE_FACT_OPERATION', impact };
      } else {
        e = { ...base(role, its), qualification: 'INSUFFICIENT_EVIDENCE', reasonCode: 'FACT_IDENTITY_NOT_ESTABLISHED', impact };
      }
      // Lot 114 (#750, issue B) : issue de l'examen T3 portée par la ligne (diagnostic #751), sans changer le verdict.
      if (examine && (e.qualification === 'REAL_CONFLICT_UNRESOLVED' || e.qualification === 'INSUFFICIENT_EVIDENCE') && role !== UNKNOWN_ROLE) {
        e.t3 = { outcome: examine.outcome, ...(examine.reviewId !== undefined ? { reviewId: examine.reviewId } : {}) };
        if (examine.outcome === 'UNDECIDABLE' && e.qualification === 'INSUFFICIENT_EVIDENCE' && e.reasonCode === 'FACT_IDENTITY_NOT_ESTABLISHED') {
          // Même fait reconnu par T3, preuves de même autorité : contradiction réelle, à arbitrer par l'utilisateur.
          e.qualification = 'REAL_CONFLICT_UNRESOLVED';
          e.reasonCode = 'T3_UNDECIDABLE';
        }
      }
      (ALERTING_QUALIFICATIONS.includes(e.qualification) ? alerting : divergences).push(e);
    }
    // Valeur saisie par l'utilisateur (Agenda, fiche) NON retenue alors qu'un document la contredit : jamais masqué.
    if (groupes === 0 && roles.includes(USER_ROLE) && userRetained === null && new Set(items.map((i) => i.normalized)).size > 1) {
      const choix = ctx.choices?.get(attributeChoiceKey(c.field, 'MIXED'));
      if (choix && choix.by === 'USER' && choiceState(choix, items) === 'COVERED') {
        const valeur = items.find((i) => i.normalized === choix.normalized)!.value;
        divergences.push({
          ...base('MIXED', items), qualification: 'REAL_CONFLICT_RESOLVED', reasonCode: 'USER_ARBITRATED', impact: [],
          resolution: { by: 'USER', value: valeur, ...(choix.sourceId !== undefined ? { sourceId: choix.sourceId } : {}) }, protection: 'USER',
        });
        continue;
      }
      alerting.push({ ...base('MIXED', items), qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'USER_VALUE_NOT_RETAINED', impact, protection: 'USER' });
      continue;
    }
    // Faits de rôles différents (ou formats équivalents) : conservés, consultables, jamais un conflit.
    if (groupes === 0) {
      const normalises = new Set(items.map((i) => i.normalized));
      const reasonCode = normalises.size < 2 ? 'FORMAT_EQUIVALENT'
        : userRetained !== null ? 'USER_VALUE_RETAINED'
          : roles.includes(UNKNOWN_ROLE) && comparables.length > 1 ? 'ROLE_UNKNOWN_NOT_COMPARABLE' : 'ROLES_DIFFER';
      const qualification: AttributeConflictQualification = reasonCode === 'USER_VALUE_RETAINED' ? 'REAL_CONFLICT_RESOLVED'
        : reasonCode === 'ROLE_UNKNOWN_NOT_COMPARABLE' ? 'INSUFFICIENT_EVIDENCE' : 'LEGITIMATE_DIFFERENCE';
      divergences.push({
        ...base(roles.length > 1 ? 'MIXED' : roles[0] ?? UNKNOWN_ROLE, items), qualification, reasonCode, impact: [],
        ...(qualification === 'REAL_CONFLICT_RESOLVED' ? { resolution: { by: 'USER' as const, sourceId: userRetained! }, protection: 'USER' as const } : {}),
      });
    }
  }
  return { alerting, divergences };
}

/** Lot 79A : contradiction arbitrée par un rétablissement BO — qualification « tranchée par l'administrateur ». */
export function markAdminArbitrated(c: QualifiedAttributeConflict): QualifiedAttributeConflict {
  return { ...c, qualification: 'REAL_CONFLICT_RESOLVED', reasonCode: 'ADMIN_RESTORED_SOURCE', impact: [], resolution: { by: 'ADMIN' }, protection: 'ADMIN' };
}

/** Empreinte stable d'une ligne (attribut, rôle, valeurs normalisées, qualification) — anti-réouverture. */
export function conflictLineKey(c: Pick<QualifiedAttributeConflict, 'field' | 'role' | 'values' | 'qualification'>): string {
  return `${c.field}|${c.role}|${c.values.map((v) => v.normalized).sort().join(',')}|${c.qualification}`;
}

// ── Lot 114 (#750) : application des arbitrages et besoins de cartes ──────

export interface AppliedAttributeChoice { field: ConflictField; role: string; value: string; by: 'USER' | 'T3'; sourceId: number }

/**
 * Valeurs À ÉCRIRE sur l'Opération d'après les arbitrages durables (pur). Un arbitrage ne s'applique
 * que s'il couvre le relevé actuel (mêmes valeurs, valeur retenue toujours portée par une source) et
 * s'il porte sur le rôle de la valeur actuellement retenue (ou s'il est le seul de l'attribut) : la
 * date d'un devis arbitrée ne remplace jamais une date de réalisation. `sourceId` : source qui porte
 * la valeur retenue (provenance).
 */
export function resolveAttributeChoices(raw: readonly RawAttributeConflict[], ctx: QualificationContext): AppliedAttributeChoice[] {
  if (!ctx.choices?.size) return [];
  const byId = new Map(ctx.contributions.map((c) => [c.sourceId, c.identity]));
  const out: AppliedAttributeChoice[] = [];
  for (const c of raw) {
    const items = itemsOf(c, ctx, byId);
    const retenue = c.retained === null ? null : items.find((i) => i.value === c.retained)?.normalized ?? null;
    const couverts: Array<{ choix: AttributeChoice; its: Item[] }> = [];
    for (const role of [...new Set(items.map((i) => i.src.role)), 'MIXED']) {
      const choix = ctx.choices.get(attributeChoiceKey(c.field, role));
      const its = role === 'MIXED' ? items : items.filter((i) => i.src.role === role);
      if (choix && choiceState(choix, its) === 'COVERED' && !its.some((i) => ctx.suspectSourceIds?.has(i.sourceId))) couverts.push({ choix, its });
    }
    const elu = couverts.find((x) => retenue !== null && x.its.some((i) => i.normalized === retenue)) ?? (couverts.length === 1 ? couverts[0] : null);
    if (!elu) continue;
    const porteur = elu.its.find((i) => i.normalized === elu.choix.normalized)!;
    out.push({ field: c.field, role: elu.choix.role, value: porteur.value, by: elu.choix.by, sourceId: porteur.sourceId });
  }
  return out;
}

/** Empreinte du SUJET d'une ligne (attribut, rôle) — une seule carte par sujet, quelles que soient les valeurs. */
export const attributeSubjectKey = (c: Pick<QualifiedAttributeConflict, 'field' | 'role'>): string => `${c.field}:${c.role}`;

/**
 * Lot 114 (#750, issue C) — la ligne appelle-t-elle une carte « Arbitrer » ? Seulement une
 * contradiction RÉELLE non tranchée, à incidence métier, avec au moins deux valeurs réellement
 * différentes. Jamais un doute de rattachement (traité d'abord), ni une preuve insuffisante, ni
 * une ligne en attente de l'examen T3.
 */
export function needsArbitrationCard(c: QualifiedAttributeConflict): boolean {
  return c.qualification === 'REAL_CONFLICT_UNRESOLVED' && c.impact.length > 0
    && new Set(c.values.map((v) => v.normalized)).size >= 2 && c.t3?.outcome !== 'PENDING';
}
