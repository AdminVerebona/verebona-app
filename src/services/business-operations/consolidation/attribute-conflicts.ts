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
import { lowerBound, upperBound } from '@/lib/documents/business-periods';
import type { BusinessOperationTypeCode, SourceRole } from '../model';
import {
  normalizeProvider, semanticRoleOf, SEMANTIC_UNKNOWN_ROLE, SEMANTIC_USER_ROLE,
  type AttributeProvenance, type CandidateIdentity, type ProvenancedField, type SourceContribution,
} from './model';

// Référentiel UNIQUE du rôle sémantique (lot 115, #791 : il vit dans `model.ts`, lu aussi par le choix
// du prestataire canonique). Ré-exporté ici : les appelants historiques ne changent pas.
export { semanticRoleOf };

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

export type ConflictField = ProvenancedField;
export const CONFLICT_FIELDS: readonly ConflictField[] = ['plannedDate', 'startDate', 'realizedDate', 'endDate', 'provider'];

/** Relevé 78A (forme persistée historique). */
export interface RawAttributeConflict {
  field: ConflictField;
  values: Array<{ value: string; sourceIds: number[] }>;
  retained: string | null;
  /**
   * Lot 115 (#791, E01) : l'écart de dates dépasse la FENÊTRE de la transaction.
   */
  materialGap?: boolean;
  /**
   * Décision PO du 16/11 (carte #791) : les dates relevées désignent le même
   * jour économique (`SAME_DATE_DAYS`) d'une TRANSACTION. Absent (relevé
   * antérieur, écart au-delà de la tolérance, prestataire, contrat ou
   * financement) : aucun adoucissement.
   */
  sameEconomicDay?: boolean;
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
  /**
   * Lot 115 (#791, E07) : périmètre MATÉRIEL des preuves de la ligne
   * (`evidenceScopeKeyOf`). Un examen T3 rendu sur un autre périmètre ne la
   * couvre plus ; vingt scans identiques ne le changent pas.
   */
  evidenceKey?: string;
  /**
   * Carte #836 (écart E08) : document déclaré ÉTRANGER par T3 sur cette ligne.
   * Porté jusqu'au producteur de cartes : tant que ce document est une source
   * ACTIVE, la question du rattachement est POSÉE (action exploitable), au lieu
   * d'un doute qui reste ouvert sans suite.
   */
  foreignFileId?: number;
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
  /**
   * Carte #836 (écart E09) — valeurs RELUES SUR L'ÉVÉNEMENT DE RÉFÉRENCE
   * après écriture, dans la transaction de consolidation (`repo.load`), pour
   * chacun des attributs arbitrables. C'est le CONTRÔLE EN BASE sans lequel
   * aucune décision T3 n'est dite « résolue ».
   *
   * **Règle remplacée** (lot 114, #750) : une ligne `business_operation_
   * attribute_arbitrations` à `status = 'DECIDED'` suffisait à qualifier la
   * contradiction `REAL_CONFLICT_RESOLVED` / `T3_ARBITRATED` — y compris
   * lorsque l'écriture avait échoué (`application_state = 'APPLY_FAILED'`),
   * lorsqu'elle n'avait jamais eu lieu (`RECEIVED`, panne entre la décision et
   * la reconsolidation) ou lorsque la valeur en base était autre. Désormais
   * « décidé » ne vaut jamais « appliqué » : la qualification lit la valeur
   * RÉELLEMENT persistée (champ, valeur, même fait / même rôle par le groupe
   * comparé, compte par la transaction, provenance par `provenance`).
   *
   * Absent pour un attribut : le contrôle est IMPOSSIBLE, donc la contradiction
   * reste ouverte (jamais un faux « résolu »).
   */
  persisted?: Partial<Record<ConflictField, string | null>>;
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
  /**
   * Carte #836 (écart E09) : état DURABLE de l'application de la décision T3
   * (`application_state`, migration 1785 puis 1960). `UNTRACKED` : ligne
   * antérieure à la migration 1785, ou migration non passée — l'état durable
   * est inconnu, et seul le contrôle en base décide (voir `choiceApplication`).
   */
  application?: 'UNTRACKED' | 'PENDING' | 'FAILED' | 'APPLIED' | 'ESCALATED';
  /**
   * Carte #836 (écart E07) : périmètre MATÉRIEL des preuves au moment de la
   * décision (`evidenceScopeKeyOf`). Absent : décision antérieure à la carte
   * #836 (aucune question nouvelle posée au déploiement).
   */
  evidenceKey?: string;
}

/** Lot 114 (#750, issue B) — examen T3 d'une ligne qui n'a PAS retenu de valeur. */
export interface AttributeReview {
  field: ConflictField;
  role: string;
  /** Formes de comparaison des valeurs examinées (un constat différent n'est pas couvert). */
  known: string[];
  outcome: 'LEGITIMATE_DIFFERENCE' | 'UNDECIDABLE' | 'LINK_ERROR' | 'ABSTAINED' | 'FAILED' | 'PENDING';
  reviewId?: number;
  /**
   * Carte #836 (écart E08) : document que T3 déclare ÉTRANGER à l'événement de
   * référence (`LINK_ERROR`), preuve citée. Tant qu'il en est une source
   * ACTIVE, le mauvais rattachement doit devenir ACTIONNABLE (question « ce
   * document concerne-t-il la même réalité ? ») : c'est le seul chemin de
   * réparation qui ne décide ni fusion, ni scission, ni dissociation.
   */
  foreignFileId?: number;
  /**
   * Lot 115 (#791, E02, E07) : périmètre MATÉRIEL des preuves SOUMISES à cet
   * examen. Absent (examen antérieur au lot 115) : toléré, la couverture reste
   * jugée sur les seules valeurs — aucun réexamen de masse au déploiement.
   */
  evidenceKey?: string;
}

export const attributeChoiceKey = (field: ConflictField, role: string): string => `${field}|${role}`;
export const attributeReviewKey = attributeChoiceKey;

// ── Rôles sémantiques (référentiel unique : `model.ts`) ───────────────────

const USER_ROLE = SEMANTIC_USER_ROLE;
const UNKNOWN_ROLE = SEMANTIC_UNKNOWN_ROLE;

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

/**
 * Valeurs distinctes (normalisées) du MÊME attribut et du MÊME rôle qui se
 * contredisent.
 *
 * Lot 115 (#791, E01) — **règle remplacée** : aucun seuil de jours. Deux
 * valeurs du même attribut, du même rôle de date et de la même période se
 * contredisent, qu'elles soient à 7 jours ou à 7 ans ; et un contrat ou un
 * financement (sans fenêtre) n'est plus exclu de la détection. Ce qui rend une
 * différence LÉGITIME se prouve ailleurs, par le fait lui-même : rôle
 * sémantique différent (devis ≠ facture ≠ réalisation, signature ≠ prise
 * d'effet ≠ couverture), format équivalent, ou révision PROUVÉE
 * (`provenRevision`).
 */
function contradicts(normalized: readonly string[]): boolean {
  return new Set(normalized).size >= 2;
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

/**
 * Révisions successives d'une relation durable (avenant, rectificatif,
 * renouvellement) : chaque valeur portée par une date d'effet distincte.
 *
 * Lot 115 (#791, E05) — **règle complétée** : des dates d'effet différentes ne
 * suffisent plus. Le lien de révision doit être PROUVÉ, par l'une de ces deux
 * preuves seulement :
 *   · une source d'une des valeurs DÉCLARE la relation (fait T1
 *     `period.relation` : avenant, rectificatif, renouvellement) ;
 *   · les PÉRIODES contractuelles qualifiées par T1 (`period.contract`) des
 *     valeurs sont DISJOINTES (l'une remplace l'autre dans le temps).
 * Sans preuve, la différence n'est pas certifiée « légitime » : l'assureur de
 * 2022 maintenu face à une source de 2024 devient une contradiction réelle, et
 * l'utilisateur tranche (valeur historique / valeur actuelle).
 */
function provenRevision(items: readonly Item[]): boolean {
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
  if (effets.size < 2) return false;
  // Preuve 1 : relation déclarée qui LIE les deux assertions comparées (carte #836, E05).
  if (relationBridgesValues(items)) return true;
  // Preuve 2 : périodes contractuelles qualifiées disjointes entre deux valeurs différentes.
  return disjointContractTerms(items);
}

/**
 * Carte #836 (écart E05) — la relation DÉCLARÉE (avenant, rectificatif,
 * renouvellement) lie-t-elle SPÉCIFIQUEMENT les deux assertions comparées ?
 *
 * **Règle remplacée** (lot 115, #791) : une relation déclarée par n'importe
 * quelle source du groupe prouvait la succession, y compris quand la pièce qui
 * la déclare porte ELLE-MÊME les deux valeurs contradictoires — un seul
 * document affirmant deux dates incompatibles était alors certifié « révision
 * successive ». Une relation est désormais une preuve de succession seulement
 * si la pièce qui la déclare porte une des valeurs comparées ET qu'une AUTRE
 * pièce porte une valeur DIFFÉRENTE : la succession va d'une assertion à
 * l'autre, et non d'un document à lui-même. Aucun avenant n'est jamais
 * supposé : seule la relation réellement déclarée par T1 est lue.
 */
function relationBridgesValues(items: readonly Item[]): boolean {
  const docsDe = new Map<string, Set<number>>();
  for (const it of items) {
    const s = docsDe.get(it.normalized) ?? new Set<number>();
    if (it.identity?.fileId !== undefined) s.add(it.identity.fileId);
    docsDe.set(it.normalized, s);
  }
  for (const it of items) {
    if (!it.identity?.documentRelation) continue;
    const declarant = it.identity.fileId;
    for (const [n, docs] of docsDe) {
      if (n === it.normalized) continue;
      if ([...docs].some((f) => f !== declarant)) return true;
    }
  }
  return false;
}

/**
 * Carte #836 (écart E05) — les deux assertions sont-elles portées par des
 * OFFRES véritablement distinctes ? Deux identifiants de documents ne le
 * prouvent pas (le même devis peut être déposé en deux exemplaires). Preuves
 * admises : des références d'identité toutes présentes et DISJOINTES entre les
 * valeurs, ou des tiers (prestataires) tous présents et différents — deux
 * offres concurrentes. Sinon : rien n'est prouvé.
 */
function distinctOfferIdentity(items: readonly Item[]): boolean {
  const disjointes = (par: Map<string, Set<string>>): boolean => {
    const ens = [...par.values()];
    if (ens.length < 2 || ens.some((s) => s.size === 0)) return false;
    for (let i = 0; i < ens.length; i++) for (let j = i + 1; j < ens.length; j++) if ([...ens[i]].some((x) => ens[j].has(x))) return false;
    return true;
  };
  const refsDe = new Map<string, Set<string>>();
  const tiersDe = new Map<string, Set<string>>();
  for (const it of items) {
    const r = refsDe.get(it.normalized) ?? new Set<string>();
    for (const x of refsOf(it.identity)) r.add(x);
    refsDe.set(it.normalized, r);
    const t = tiersDe.get(it.normalized) ?? new Set<string>();
    const p = normalizeProvider(it.identity?.provider ?? null);
    if (p) t.add(p);
    tiersDe.set(it.normalized, t);
  }
  return disjointes(refsDe) || disjointes(tiersDe);
}

/** Bornes d'une période contractuelle qualifiée par T1, en jour comparable (préfixe AAAA[-MM[-JJ]]). */
const termBounds = (it: Item): Array<{ start: string | null; end: string | null }> =>
  (it.identity?.termQualification?.contractTerms ?? []).map((t) => ({ start: t.start ?? null, end: t.openEnded ? null : t.end ?? null }));

/** Deux valeurs différentes dont TOUTES les périodes contractuelles qualifiées ne se chevauchent pas. */
function disjointContractTerms(items: readonly Item[]): boolean {
  const parValeur = new Map<string, Array<{ start: string | null; end: string | null }>>();
  for (const it of items) {
    const b = termBounds(it);
    if (!b.length) continue;
    parValeur.set(it.normalized, [...(parValeur.get(it.normalized) ?? []), ...b]);
  }
  const ens = [...parValeur.values()];
  if (ens.length < 2) return false;
  // Bornes partielles comparées par les helpers du référentiel des périodes (une année, un mois, un jour).
  const chevauche = (a: { start: string | null; end: string | null }, b: { start: string | null; end: string | null }): boolean =>
    (a.end === null || b.start === null || lowerBound(b.start) <= upperBound(a.end))
    && (b.end === null || a.start === null || lowerBound(a.start) <= upperBound(b.end));
  for (let i = 0; i < ens.length; i++) {
    for (let j = i + 1; j < ens.length; j++) {
      for (const a of ens[i]) for (const b of ens[j]) if (chevauche(a, b)) return false;
    }
  }
  return true;
}

/**
 * Lot 115 (#791, E05) — deux valeurs portées par des DEVIS distincts : deux
 * offres concurrentes, ou un devis révisé, ne se contredisent pas (un devis
 * n'engage rien : seules la commande et la facture le font). Deux valeurs
 * contradictoires portées par le MÊME document, en revanche, ne sont pas une
 * révision : la contradiction suit son cours au lieu d'être certifiée
 * « légitime ». Une relation déclarée (rectificatif, avenant) suffit aussi.
 *
 * Carte #836 (écart E05) — **règle complétée**, deux fois :
 *   · la relation déclarée ne court-circuite plus le contrôle des pièces :
 *     deux dates du MÊME document ne sont une révision que si la relation lie
 *     réellement deux pièces (`relationBridgesValues`) ;
 *   · deux identifiants de documents ne PROUVENT pas deux devis. Il faut une
 *     preuve qui sépare les offres : références de devis distinctes ou tiers
 *     différents (`distinctOfferIdentity`), relation déclarée, ou périodes de
 *     validité disjointes. Le MÊME devis déposé en deux PDF contradictoires
 *     reste donc une contradiction à trancher.
 */
function provenQuoteAlternatives(items: readonly Item[]): boolean {
  const parValeur = new Map<string, Set<number>>();
  for (const it of items) {
    const f = it.identity?.fileId;
    if (f === undefined) return false;
    const s = parValeur.get(it.normalized) ?? new Set<number>();
    s.add(f);
    parValeur.set(it.normalized, s);
  }
  const ens = [...parValeur.values()];
  if (ens.length < 2) return false;
  // Aucun document commun entre deux valeurs : des devis distincts les portent.
  for (let i = 0; i < ens.length; i++) for (let j = i + 1; j < ens.length; j++) if ([...ens[i]].some((f) => ens[j].has(f))) return false;
  // … et une preuve sépare bien les deux offres (carte #836, E05).
  return distinctOfferIdentity(items) || relationBridgesValues(items) || disjointContractTerms(items);
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

/**
 * Carte #836 (écart E09) — état de l'arbitrage DURABLE face au contrôle en
 * base. `VERIFIED` est le SEUL état qui ferme la contradiction.
 *
 *   VERIFIED               la valeur retenue est celle réellement persistée sur
 *                          l'événement (décision de l'utilisateur : sa valeur
 *                          est protégée et écrite dans la même transaction) ;
 *   NOT_VERIFIED           la décision T3 existe mais son effet n'est pas
 *                          constaté en base (reçue, en cours, échec d'écriture,
 *                          valeur discordante, contrôle impossible) : la
 *                          contradiction RESTE visible et actionnable ;
 *   ESCALATED              le plafond de reprises d'application est épuisé :
 *                          escalade EXPLICITE (jamais un blocage silencieux) ;
 *   USER_EVIDENCE_CHANGED  carte #836 (écart E07) : le périmètre matériel des
 *                          preuves a changé depuis la réponse de l'utilisateur.
 *                          Sa valeur n'est JAMAIS écrasée — une question ciblée
 *                          est posée.
 */
export type ChoiceApplicationState = 'VERIFIED' | 'NOT_VERIFIED' | 'ESCALATED' | 'USER_EVIDENCE_CHANGED';

/**
 * Carte #836 (écart E09) — contrôle en base d'un arbitrage (pur) : la valeur
 * retenue est-elle celle que l'événement de référence porte VRAIMENT ?
 * `persisted` est la valeur relue après écriture ; `undefined` (contrôle
 * impossible) ne vaut jamais « appliqué ».
 */
export function choiceApplication(
  choix: AttributeChoice, retainedValue: string, persisted: string | null | undefined, evidenceKey: string,
): ChoiceApplicationState {
  if (choix.by === 'USER') {
    // La valeur de l'utilisateur est écrite et protégée dans la même transaction (acquis #750) : aucune
    // vérification différée. Seule une preuve matériellement NOUVELLE justifie de lui reposer la question.
    return choix.evidenceKey !== undefined && choix.evidenceKey !== evidenceKey ? 'USER_EVIDENCE_CHANGED' : 'VERIFIED';
  }
  const ecrite = persisted !== undefined && persisted !== null
    && (persisted === retainedValue
      || (choix.field === 'provider' ? normalizeConflictProvider(persisted) : normalizeConflictDate(persisted)) === choix.normalized);
  if (ecrite) return 'VERIFIED';
  return choix.application === 'ESCALATED' ? 'ESCALATED' : 'NOT_VERIFIED';
}

/**
 * Carte #836 (écart E01) — deux valeurs INCOMPATIBLES portées par la MÊME
 * assertion : même attribut, même rôle sémantique, même nature de pièce, même
 * autorité, même référence d'identité, même période d'effet et même révision
 * déclarée. Alors rien ne peut rendre la différence légitime : ce sont deux
 * affirmations contradictoires du même fait.
 *
 * C'est la borne du domaine de la tolérance du MÊME JOUR ÉCONOMIQUE
 * (`SAME_DATE_DAYS`, décision PO du 16/11, carte #791) : elle vaut pour deux
 * PIÈCES DIFFÉRENTES d'une même transaction (l'acte du 30/06 et l'attestation
 * du 02/07), jamais pour deux assertions identiques en tous points qui se
 * contredisent de deux jours.
 */
export function sameAssertionContradicted(items: ReadonlyArray<{
  normalized: string; identity: CandidateIdentity | null; src: Pick<ConflictValueSource, 'role' | 'documentRole' | 'authority'>;
}>): boolean {
  const parAssertion = new Map<string, Set<string>>();
  for (const it of items) {
    const i = it.identity;
    // Identité MATÉRIELLE de l'assertion : une référence d'identité, ou la même pièce. Sans l'une ni
    // l'autre, rien ne prouve que les deux valeurs affirment le même fait — la tolérance garde son effet.
    const identite = refsOf(i).sort().join('+') || (i?.fileId !== undefined ? `file:${i.fileId}` : '');
    if (!identite) continue;
    const cle = [
      identite, it.src.role, it.src.documentRole ?? '-', it.src.authority ?? '-', i?.documentRelation ?? '-',
      i?.dates.startDate ?? '-', i?.dates.endDate ?? '-',
    ].join('|');
    const s = parAssertion.get(cle) ?? new Set<string>();
    s.add(it.normalized);
    parAssertion.set(cle, s);
  }
  for (const s of parAssertion.values()) if (s.size >= 2) return true;
  return false;
}

/**
 * L'examen T3 couvre-t-il ce groupe ? Mêmes valeurs des deux côtés ET, depuis
 * le lot 115 (#791, E02 / E07), MÊME périmètre matériel de preuves : un
 * verdict rendu sans avoir vu une pièce décisive (plus autoritaire, révision
 * déclarée, identité ou date d'effet nouvelle) ne couvre plus la ligne.
 */
const reviewCovers = (r: AttributeReview | undefined, its: readonly Item[], evidenceKey: string): r is AttributeReview =>
  !!r && its.every((i) => r.known.includes(i.normalized)) && r.known.every((k) => its.some((i) => i.normalized === k))
  && (r.evidenceKey === undefined || r.evidenceKey === evidenceKey);

/**
 * Qualifie le relevé 78A (pur, déterministe). `alerting` : lignes qui
 * maintiennent l'anomalie (persistées dans `conflicts`) ; `divergences` :
 * différences légitimes ou tranchées (persistées à part, consultables).
 */
export function qualifyAttributeConflicts(raw: readonly RawAttributeConflict[], ctx: QualificationContext): {
  alerting: QualifiedAttributeConflict[]; divergences: QualifiedAttributeConflict[];
} {
  const byId = new Map(ctx.contributions.map((c) => [c.sourceId, c.identity]));
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
      if (!contradicts(its.map((i) => i.normalized))) continue;
      groupes++;
      const suspect = its.some((i) => ctx.suspectSourceIds?.has(i.sourceId));
      const choix = ctx.choices?.get(attributeChoiceKey(c.field, role));
      const etat = choiceState(choix, its);
      const evidenceKey = evidenceScopeKeyOf(its);
      const examen = ctx.reviews?.get(attributeReviewKey(c.field, role));
      const examine = reviewCovers(examen, its, evidenceKey) ? examen : undefined;
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
        const resolution = {
          by: choix.by, value: valeur,
          ...(choix.sourceId !== undefined ? { sourceId: choix.sourceId } : {}), ...(choix.reviewId !== undefined ? { reviewId: choix.reviewId } : {}),
        } as const;
        // Carte #836 (écarts E09 et E07) — **règle remplacée** : `DECIDED` ne ferme plus rien. La valeur
        // retenue doit être CELLE QUE L'ÉVÉNEMENT PORTE (contrôle en base, `ctx.persisted`) ; et une décision
        // de l'utilisateur rendue sur d'AUTRES preuves matérielles donne lieu à une question ciblée.
        const application = choiceApplication(choix, valeur, ctx.persisted?.[c.field], evidenceKey);
        if (application === 'VERIFIED') {
          e = {
            ...base(role, its), qualification: 'REAL_CONFLICT_RESOLVED', reasonCode: choix.by === 'USER' ? 'USER_ARBITRATED' : 'T3_ARBITRATED', impact: [],
            resolution, ...(choix.by === 'USER' ? { protection: 'USER' as const } : {}),
          };
        } else if (application === 'USER_EVIDENCE_CHANGED') {
          // La valeur de l'utilisateur reste écrite et protégée (`resolveAttributeChoices` l'applique toujours) :
          // la carte lui POSE la question, elle ne défait rien.
          e = {
            ...base(role, its), qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'USER_DECISION_EVIDENCE_CHANGED', impact,
            resolution, protection: 'USER',
          };
        } else {
          e = {
            ...base(role, its), qualification: 'REAL_CONFLICT_UNRESOLVED',
            reasonCode: application === 'ESCALATED' ? 'T3_APPLICATION_ESCALATED' : 'T3_APPLICATION_NOT_VERIFIED', impact, resolution,
          };
        }
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
        e = {
          ...base(role, its), qualification: 'SOURCE_LINK_ERROR_SUSPECTED', reasonCode: 'T3_LINK_ERROR_SUSPECTED', impact,
          // Carte #836 (écart E08) : le document désigné voyage avec la ligne — le mauvais rattachement doit
          // devenir une action exploitable tant qu'il est encore une source active.
          ...(examine.foreignFileId !== undefined ? { foreignFileId: examine.foreignFileId } : {}),
        };
      } else if (DURABLE.has(ctx.type ?? '') && provenRevision(its)) {
        e = { ...base(role, its), qualification: 'LEGITIMATE_DIFFERENCE', reasonCode: 'SUCCESSIVE_REVISION', impact: [] };
      } else if ((role === 'QUOTE_PLANNED' || role.startsWith('QUOTE_VALIDITY') || role === 'QUOTE') && provenQuoteAlternatives(its)) {
        // Deux devis DISTINCTS (ou un devis qui déclare rectifier) ne contredisent pas la réalisation : seules
        // la commande / la facture engagent. Lot 115 (#791, E05) : deux exemplaires du MÊME devis, si.
        e = { ...base(role, its), qualification: 'LEGITIMATE_DIFFERENCE', reasonCode: 'QUOTE_REVISION', impact: [] };
      } else if (c.sameEconomicDay === true && !sameAssertionContradicted(its)) {
        // Décision PO du 16/11 (carte #791) : deux dates qui désignent le même JOUR ÉCONOMIQUE au sens
        // du référentiel existant (`SAME_DATE_DAYS` : acte du 30/06 et attestation du 02/07 d'un même
        // achat) ne posent aucune question à l'utilisateur — la date de la source fondatrice est
        // retenue (règle de rétention inchangée) et la différence reste consultable dans la fiche.
        // Au-delà de la tolérance, et pour un contrat ou un financement, la contradiction est entière.
        //
        // Carte #836 (écart E01) — **règle complétée** : la tolérance garde SON domaine (deux PIÈCES
        // différentes d'une même transaction) mais n'efface plus une contradiction du MÊME attribut, du
        // MÊME rôle, de la MÊME nature de pièce, de la MÊME référence, de la MÊME période et de la MÊME
        // révision (`sameAssertionContradicted`) : deux assertions identiques en tous points qui se
        // contredisent de deux jours restent un conflit, comme à sept jours ou à sept ans.
        e = { ...base(role, its), qualification: 'LEGITIMATE_DIFFERENCE', reasonCode: 'SAME_ECONOMIC_DAY', impact: [] };
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
      e.evidenceKey = evidenceKey;
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

// ── Lot 115 (#791, E07) : PÉRIMÈTRE MATÉRIEL des preuves d'une ligne ──────

/** Empreinte pure, stable et bornée (FNV-1a 32 bits) — aucune dépendance au runtime (module lu côté BO). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

const MATERIAL_KEY_MAX = 600;

/**
 * Lot 115 (#791, E07) — périmètre MATÉRIEL des preuves d'une ligne : ce qui,
 * en changeant, justifie un nouvel examen. Y entrent, par valeur comparée :
 * le rôle sémantique, le rôle du document, l'autorité, la relation DÉCLARÉE
 * (avenant, rectificatif, renouvellement), les références d'identité et les
 * bornes d'effet. N'y entrent PAS l'identifiant du document, celui de la
 * source ni l'horodatage : vingt scans identiques, ou une pièce ÉQUIVALENTE
 * redéposée, donnent la même empreinte et ne relancent aucun examen. Une
 * pièce plus autoritaire, une révision déclarée, une identité ou une date
 * d'effet nouvelle la changent.
 */
export function evidenceScopeKeyOf(items: ReadonlyArray<{
  normalized: string; identity: CandidateIdentity | null; src: Pick<ConflictValueSource, 'role' | 'documentRole' | 'authority'>;
}>): string {
  const parts = new Set<string>();
  for (const it of items) {
    const i = it.identity;
    parts.add([
      it.normalized, it.src.role, it.src.documentRole ?? '-', it.src.authority ?? '-', i?.documentRelation ?? '-',
      refsOf(i).sort().join('+') || '-', i?.dates.startDate ?? '-', i?.dates.endDate ?? '-',
    ].join('|'));
  }
  const materiel = [...parts].sort().join('\u0001');
  return `l115:${fnv1a(materiel)}:${Math.min(materiel.length, MATERIAL_KEY_MAX)}`;
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
