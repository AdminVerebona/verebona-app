/**
 * Lot 113AN (Trello #741, « Corriger les faux UNRESOLVED et reprendre les
 * extractions réellement incomplètes ») — RÉCONCILIATION de la couverture,
 * unité par unité, avec ce que T1 a RÉELLEMENT structuré (fonctions pures).
 *
 * `computeCoverage` (lot 34F) ne connaît qu'un seul chemin : preuve d'un fait
 * → `SourceUnitLinker.link` → l'unité LA PLUS COURTE qui contient l'extrait.
 * Il laisse donc `UNRESOLVED/not_extracted` des unités pourtant couvertes
 * (causes démontrées par `l113an-couverture.test.ts`) :
 *   1. décisions de T1 sur les valeurs (`valueDecisions`, contrat 91D) —
 *      celles de la passe principale ne sont validées QU'APRÈS la
 *      couverture, celles d'une passe de RÉPARATION sont ignorées : une unité
 *      transmise `[page:1:field:2]` à la réparation et qualifiée par elle
 *      (« reprise dans le fait n », « composante du total ») reste
 *      `not_extracted` ;
 *   2. tableau transcrit DEUX fois — lignes du texte (blocs) ET lignes de
 *      tableau structurées : les blocs restent non couverts ;
 *   3. même passage lu par deux segments (recouvrement d'une page entre deux
 *      lots) ou répété sur plusieurs pages (en-tête « Référence client ») :
 *      seule l'unité citée par la preuve est couverte ;
 *   4. extrait qui cite PLUSIEURS unités contenues dans une unité plus
 *      longue d'un autre segment : les unités citées restent non couvertes ;
 *   5. valeur structurée hors faits (métadonnée du document, candidat
 *      Opération) sans extrait littéral.
 *
 * RÈGLE (aucune correspondance abusive) : une unité n'est requalifiée que si
 * CHACUNE de ses valeurs (montants, dates, identifiants, nombres) est
 * représentée par une donnée structurée ET qu'un ANCRAGE relie cette donnée
 * à CETTE unité :
 *   · décision VALIDE de T1 sur la valeur de l'unité (identifiant d'unité ou
 *     preuve retrouvée par la validation serveur) ;
 *   · extrait d'un fait qui CITE l'unité (texte intégral inclus), même page ;
 *   · libellé commun (couple libellé / valeur ↔ libellé du fait) ;
 *   · même ligne de tableau structurée (toutes les valeurs dans UNE ligne,
 *     même page, mots communs) ;
 *   · texte identique à une unité couverte (répétition) ou même passage relu
 *     par un autre segment sur la même page ;
 *   · valeur présente dans cette SEULE unité de la page (fait de la même
 *     page) ou du document (métadonnée, candidat).
 * Une unité dont une valeur seulement est représentée reste NON RÉSOLUE
 * (`values_partially_structured`) : candidate à la réparation ciblée. Une
 * décision `UNDETERMINED` rend l'unité INCERTAINE (`value_undetermined`),
 * jamais couverte. `NOT_RETAINED` validé couvre l'unité avec son motif
 * (`value_decision_not_retained`) — jamais NON_INFORMATIONAL : l'unité reste
 * lisible par T2 / T3 (qui ignorent les unités non informatives).
 *
 * Chaque requalification porte sa PROVENANCE (`coverageProvenance` : règle,
 * sources, références, état d'avant), persistée avec l'unité (migration 1665).
 * Les unités restantes reçoivent une POLITIQUE explicite (`residualPolicyOf`).
 */
import { unitOfCell } from './build-units';
import { allSignificantValues, plat } from './text';
import { contactValueRepresented, contactValuesOf, repairIneligibility } from './coverage';
import { contentRoots, valueFormsOf } from '../value-decisions/validate';
import {
  addOccurrenceCounts, cellOccurrencesOf, countOutcomes, emptyOccurrenceCounts, equivalentOccurrences, MAX_OCCURRENCE_DETAILS,
  propositionOccurrencesOf, roleConflict, roleTagsOf, valueOccurrencesOf,
  type ExcludedOccurrence, type OccurrenceCounts, type OccurrenceDetail, type OccurrenceOutcome, type SourceOccurrence,
} from './occurrences';
import type { CoverageStatus, CoveredSourceUnit } from './types';

/** Origine de la donnée qui couvre une unité requalifiée. */
export type CoverageEvidenceSource = 'FACT' | 'TABLE' | 'METADATA' | 'CANDIDATE' | 'VALUE_DECISION' | 'UNIT' | 'REPAIR';

/** Moment de la réconciliation : analyse, passe de réparation, relecture des données persistées. */
export type ReconciliationStage = 'ANALYSIS' | 'REPAIR' | 'STORED';

/** Provenance d'une requalification (persistée, jamais de contenu au-delà des références). */
export interface CoverageProvenance {
  /** Règle appliquée (code stable). */
  rule: string;
  sources: CoverageEvidenceSource[];
  /** Références (au plus 12) : `fact:<empreinte|id>`, `unit:<id>`, `decision:<n>`, `meta:<champ>`, `candidate:<clé>`. */
  refs: string[];
  /** État AVANT la requalification. */
  previous: { status: CoverageStatus; reason: string | null };
  /** Valeurs de l'unité : total, représentées, non retenues (motif), indéterminées. */
  values: { total: number; represented: number; notRetained: number; undetermined: number };
  stage: ReconciliationStage;
  /**
   * Carte #853 (P1-01 #835, R3/R4) : compteurs PAR OCCURRENCE (total = structurées + conservées + non retenues
   * + indéterminées + incertaines + non résolues + échecs ; exclues à part) et détail de chaque occurrence
   * (identité, position, issue, preuve exacte ou motif — jamais la valeur). Absents : provenance antérieure.
   */
  occurrences?: OccurrenceCounts;
  details?: OccurrenceDetail[];
  /** Détails non gardés (au-delà de `MAX_OCCURRENCE_DETAILS`), toujours comptés dans `occurrences`. */
  detailsOmitted?: number;
}

/** Fait vu par la réconciliation (sortie T1 en cours, ou fait persisté). */
export interface ReconciliationFact {
  ref: string;
  /** Unités déjà rattachées (provenance, extrait retrouvé, réparation). */
  unitIds: readonly string[];
  values: ReadonlyArray<unknown>;
  labels: ReadonlyArray<string | null | undefined>;
  excerpt: string | null;
  page: number | null;
}

/** Valeur structurée hors faits : métadonnée du document (montant, date, SIRET…) ou candidat de l'événement de référence. */
export interface ReconciliationValue {
  ref: string;
  source: 'METADATA' | 'CANDIDATE';
  values: ReadonlyArray<unknown>;
  page: number | null;
  /**
   * Lot 115F (Trello #792, écart P2-05) : unités de source citées par les PREUVES réellement stockées
   * (`evidence[].sourceUnitIds`, `financialHints[].evidence.sourceUnitIds`). Présentes, elles ANCRENT la
   * valeur à ces unités (et à leurs pages) ; absentes, le rapprochement reste celui d'une valeur unique
   * dans le document.
   */
  unitIds?: readonly string[];
}

/** Décision VALIDE de T1 sur une valeur d'une unité (validation serveur faite en amont). */
export interface ReconciliationDecision {
  ref: string;
  sourceUnitId: string;
  kind: string | null;
  normalizedValue: string | null;
  decision: string | null;
}

export interface ReconciliationInput {
  facts: readonly ReconciliationFact[];
  values?: readonly ReconciliationValue[];
  decisions?: readonly ReconciliationDecision[];
  stage: ReconciliationStage;
  /**
   * Carte #853 (R2) : fidélité de la transcription d'une page (`faithfulPagesOf`) — preuve de CONSERVATION d'une
   * proposition sans valeur. Absente : non prouvée (une proposition non portée par un fait reste INCERTAINE).
   */
  faithfulPage?: (page: number | null) => boolean;
  /** Carte #853 (R3/R4) : registre rempli, unité par unité, des compteurs et du détail des occurrences. */
  ledger?: Map<string, UnitOccurrenceLedger>;
}

/** Carte #853 : bilan des occurrences d'une unité (registre de la réconciliation, BO, rapport). */
export interface UnitOccurrenceLedger {
  counts: OccurrenceCounts;
  details: OccurrenceDetail[];
  /** Mode de contrôle appliqué à l'unité. */
  mode: 'COVERED_CHECK' | 'ROW_CHECK' | 'RECONCILE' | 'STATUS_ONLY';
}

/**
 * Motifs d'une unité NON RÉSOLUE que la réconciliation peut lever (jamais une incertitude ni un échec).
 * Lot 114G (#760, P2-06) : `values_not_structured` (coordonnées de contact) est traité à part, par
 * comparaison de TOUTES les coordonnées du passage à la connaissance persistée (`reconcileContactUnit`).
 */
const RECONCILABLE_REASONS = new Set(['not_extracted', 'not_structured', 'fact_dropped', 'values_partially_structured']);

/**
 * Carte #853 (R3) : motifs de COUVERTURE posés par `computeCoverage` qui sont CONTRÔLÉS occurrence par occurrence
 * (unités de texte). Règle remplacée : seul `fact` l'était. Les autres motifs (« metadata », « entity ») ne
 * prouvaient pas davantage chaque valeur du passage.
 */
const CONTROLLED_COVERED_REASONS = new Set(['fact', 'metadata', 'entity']);

/**
 * Carte #853 (R4) : motifs PRODUITS par la réconciliation elle-même. Une unité qui porte l'un d'eux ET une
 * provenance est RECALCULÉE depuis son état d'origine (`previous`) avec les règles et les preuves courantes —
 * c'est ainsi qu'un faux COVERED historique (règles antérieures) est requalifié sans réanalyse. Un état posé
 * depuis par une autre étape (réparation : `fact`, `table_verified`…) n'est jamais rembobiné.
 */
const RECONCILIATION_REASONS = new Set([
  'values_structured', 'duplicate', 'overlap', 'fact_excerpt', 'table_transcription', 'value_decision', 'value_decision_not_retained',
  'value_undetermined', 'values_partially_structured', 'occurrence_unverifiable', 'table_rows_unresolved', 'table_rows_uncertain',
  'preserved_passage',
]);

/**
 * Lot 114G (Trello #760, P2-05) — valeurs structurées d'un candidat Opération (références métier, montants,
 * dates, périodes), à partir de sa forme en mémoire OU de sa charge persistée (`document_operation_candidates.payload`).
 * Une seule fonction pour l'analyse et pour la réconciliation sur stockage : même résultat des deux côtés. Pure.
 */
export function candidateReconciliationValue(candidateKey: string, c: unknown): ReconciliationValue {
  const o = (c && typeof c === 'object' ? c : {}) as {
    businessReferences?: Array<{ value?: unknown }>;
    financialHints?: Array<{ amountMinor?: unknown; economicDate?: unknown; periodStart?: unknown; periodEnd?: unknown; evidence?: unknown }>;
    temporalHints?: Record<string, unknown> | null;
    evidence?: unknown;
  };
  const montant = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v / 100 : null);
  // Lot 115F (#792, écart P2-05) : unités citées par les preuves STOCKÉES du candidat (ancrage réel, jamais déduit).
  const unites = (e: unknown): string[] => {
    const l = Array.isArray(e) ? e : e === null || e === undefined ? [] : [e];
    return l.flatMap((x) => {
      const ids = (x && typeof x === 'object' ? (x as { sourceUnitIds?: unknown }).sourceUnitIds : null);
      return Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string' && i !== '') : [];
    });
  };
  return {
    ref: candidateKey, source: 'CANDIDATE', page: null,
    unitIds: [...new Set([
      ...unites(o.evidence),
      ...(Array.isArray(o.financialHints) ? o.financialHints.flatMap((h) => unites(h?.evidence)) : []),
    ])],
    values: [
      ...(Array.isArray(o.businessReferences) ? o.businessReferences.map((r) => r?.value) : []),
      ...(Array.isArray(o.financialHints) ? o.financialHints.flatMap((h) => [montant(h?.amountMinor), h?.economicDate, h?.periodStart, h?.periodEnd]) : []),
      ...Object.values(o.temporalHints ?? {}),
    ].filter((v) => v !== null && v !== undefined && typeof v !== 'object'),
  };
}
const TEXT_KINDS = new Set(['TEXT_BLOCK', 'LABEL_VALUE', 'FORM_FIELD']);
/** Longueur minimale (forme de comparaison) d'une unité CITÉE par un extrait ou incluse dans un autre passage. */
const MIN_CITATION = 4;
const MAX_REFS = 12;
/** Part minimale des mots de contenu d'une unité retrouvés dans la ligne de tableau qui la représente. */
const ROW_WORDS_RATIO = 0.5;

const pageOk = (a: number | null | undefined, b: number | null | undefined) => a === null || a === undefined || b === null || b === undefined || a === b;
const NOMBRES = /\d{1,3}(?:[   .]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g;

/** Nombres « nus » d'un texte (quantités, index, numéros) hors valeurs significatives : jeton `NUM:<chiffres>`. */
function numberTokens(text: string): string[] {
  let t = text;
  for (const v of allSignificantValues(text)) t = t.split(v.raw).join(' ');
  const out = new Set<string>();
  for (const m of t.matchAll(NOMBRES)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length >= 2) out.add(`NUM:${d.replace(/^0+(?=\d)/, '')}`);
  }
  return [...out];
}

/** Valeurs d'une unité, en formes comparables (`AMOUNT:4520`, `DATE:2026-03-12`, `IDENTIFIER:AB123CD`, `NUM:45`). Pure. */
export function unitValueForms(text: string | null | undefined): string[] {
  if (!text) return [];
  const sig = allSignificantValues(text).map((v) => `${v.kind}:${v.normalized}`);
  return [...new Set([...sig, ...numberTokens(text)])];
}

/** Formes comparables d'une valeur structurée (mêmes formes que `unitValueForms`, plus les chiffres nus). Pure. */
export function structuredValueForms(values: ReadonlyArray<unknown>): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    for (const f of valueFormsOf(v)) out.add(f);
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    for (const f of unitValueForms(s)) out.add(f);
    const d = s.replace(/\D/g, '');
    if (d.length >= 2 && d.length <= 20 && /^[\s\d.,  -]+$/.test(s)) out.add(`NUM:${d.replace(/^0+(?=\d)/, '')}`);
    // Montant en euros écrit sans devise (« 45.20 ») : chiffres nus de sa forme en centimes, et inversement.
    for (const f of valueFormsOf(v)) if (f.startsWith('AMOUNT:')) out.add(`NUM:${f.slice(7)}`);
  }
  return out;
}

/** Formes des cellules d'une ligne de tableau (valeur et forme normalisée). */
function rowForms(u: CoveredSourceUnit): Set<string> {
  const cells = Array.isArray(u.payload.cells) ? (u.payload.cells as Array<{ value?: unknown; normalized?: unknown }>) : [];
  return structuredValueForms(cells.flatMap((c) => [c.value, c.normalized]));
}

/** Cellules renseignées d'une ligne, en forme de comparaison. */
function cellPlats(u: CoveredSourceUnit): string[] {
  const cells = Array.isArray(u.payload.cells) ? (u.payload.cells as Array<{ value?: unknown }>) : [];
  return cells.map((c) => (c.value === null || c.value === undefined ? '' : plat(String(c.value)))).filter((x) => x.length > 0);
}

interface Representation { source: CoverageEvidenceSource; ref: string }

/** Rôles (lexique) et racines des libellés d'une preuve. */
const libellesDe = (labels: ReadonlyArray<string | null | undefined>) => labels.filter((l): l is string => typeof l === 'string' && l.length > 0).join(' ');

/** Candidat de preuve d'une occurrence (une même preuve n'explique qu'UNE information, sauf rappel démontré). */
interface ProofCandidate {
  /** Clé d'usage : la même clé n'explique deux occurrences que si elles sont équivalentes (ou explicitement citées). */
  key: string;
  source: CoverageEvidenceSource;
  ref: string;
  outcome: OccurrenceOutcome;
  score: number;
  /** Unités EXPLICITEMENT citées par la preuve (rappel explicite d'un même fait sur plusieurs unités). */
  explicitUnits?: ReadonlySet<string>;
  /** Décision de valeur (compteur « décidées »). */
  decision?: boolean;
  /** Unités qui sont le MÊME passage relu (recouvrement de segments, même page). */
  samePassage?: ReadonlySet<string>;
}

interface OccurrenceResolution { outcome: OccurrenceOutcome; proof: Representation | null; reason: string | null; recallOf?: string; decision?: boolean }

interface Plan<U extends CoveredSourceUnit> {
  u: U;
  mode: UnitOccurrenceLedger['mode'];
  occs: SourceOccurrence[];
  excluded: ExcludedOccurrence[];
  res: Map<string, OccurrenceResolution>;
  /** Rappels plausibles non démontrés (appliqués seulement faute de preuve propre). */
  fallback: Map<string, OccurrenceResolution>;
  /** Unité de texte non résolue : ancrages au niveau de l'unité (règles 113AN). */
  cite: Array<{ f: ReconciliationFact }>;
  recouvrement?: CoveredSourceUnit;
  twin?: CoveredSourceUnit;
  ligne?: { u: CoveredSourceUnit };
  /** Résultat final (null : unité rendue telle quelle). */
  out?: U;
}

/**
 * Réconcilie les unités avec les données réellement structurées (voir l'en-tête), OCCURRENCE PAR OCCURRENCE
 * (carte #853). Rend les unités (requalifiées avec leur provenance) dans le même ordre ; les autres sont rendues
 * telles quelles.
 */
export function reconcileCoverage<U extends CoveredSourceUnit>(unitsIn: readonly U[], input: ReconciliationInput): U[] {
  // Carte #853 (R4) : un état produit par une réconciliation antérieure est recalculé depuis son origine.
  const units = unitsIn.map((u): U => {
    const pv = u.coverageProvenance;
    if (!pv || !RECONCILIATION_REASONS.has(u.reason ?? '') || (pv.previous.status === u.status && pv.previous.reason === u.reason)) return u;
    return { ...u, status: pv.previous.status, reason: pv.previous.reason };
  });
  const textes = units.filter((u) => TEXT_KINDS.has(u.kind) && u.text);
  const formesUnite = new Map<string, string[]>();
  for (const u of units) if ((TEXT_KINDS.has(u.kind) || u.kind === 'TABLE_ROW') && u.text) formesUnite.set(u.sourceUnitId, unitValueForms(u.text));
  const platUnite = new Map(textes.map((u) => [u.sourceUnitId, plat(u.text!)]));
  const pagesTableau = new Map<string, [number, number]>();
  const tableIncertaine = new Map<string, boolean>();
  for (const t of units) {
    if (t.kind !== 'TABLE') continue;
    pagesTableau.set(t.sourceUnitId, [t.page ?? 1, Number(t.payload.pageEnd ?? t.page ?? 1)]);
    tableIncertaine.set(t.sourceUnitId, t.payload.uncertain === true);
  }
  const pageDe = new Map(units.map((u) => [u.sourceUnitId, u.page]));
  const faits = input.facts.map((f) => {
    const libelles = libellesDe(f.labels);
    return {
      f,
      forms: structuredValueForms(f.values),
      roots: new Set(f.labels.flatMap((l) => (l ? [...contentRoots(String(l).replace(/[._]/g, ' '))] : []))),
      // Carte #853 : rôle porté par le libellé ou la clé du fait (HT, TTC, franchise, échéance…), et racines de sa valeur.
      tags: roleTagsOf(libelles),
      valueRoots: new Set([...f.values.flatMap((v) => (typeof v === 'string' ? [...contentRoots(v.replace(/[._]/g, ' '))] : []))]),
      unites: new Set(f.unitIds.map(unitOfCell)),
      cellules: new Set(f.unitIds),
      ex: f.excerpt ? plat(f.excerpt) : '',
      // Pages du fait : celle de sa preuve et celles de ses unités (une preuve sans page vaut pour toute page).
      pages: new Set<number | null>(f.unitIds.length > 0 && f.page === null
        ? f.unitIds.map((id) => pageDe.get(unitOfCell(id)) ?? null)
        : [f.page, ...f.unitIds.map((id) => pageDe.get(unitOfCell(id)) ?? null)]),
    };
  });
  // Lot 115F (#792, écart P2-05) : valeur structurée hors faits ANCRÉE sur les unités réellement citées par ses
  // preuves (et sur LEURS pages) ; sans preuve ancrée, son rapprochement reste celui d'une valeur unique du document.
  const autres = (input.values ?? []).map((v) => {
    const ids = (v.unitIds ?? []).map(unitOfCell);
    return {
      v, forms: structuredValueForms(v.values), unites: new Set(ids),
      pages: new Set<number | null>(ids.length > 0 ? ids.map((id) => pageDe.get(id) ?? null) : [v.page]),
    };
  });
  const refAutre = (x: (typeof autres)[number]) => `${x.v.source === 'METADATA' ? 'meta' : 'candidate'}:${x.v.ref}`;
  const valeurAncree = (x: (typeof autres)[number], u: CoveredSourceUnit) =>
    x.unites.size > 0 ? x.unites.has(u.sourceUnitId) : [...x.pages].some((pg) => pageOk(pg, u.page));
  // Carte #853 (R2) : décisions indexées par unité ET forme, en LISTE — une décision n'explique qu'une occurrence
  // (règle remplacée : une Map par forme propageait une décision à toutes les occurrences de même valeur).
  const decisions = new Map<string, ReconciliationDecision[]>();
  for (const d of input.decisions ?? []) {
    if (!d.kind || !d.normalizedValue) continue;
    const id = unitOfCell(d.sourceUnitId);
    decisions.set(id, [...(decisions.get(id) ?? []), d]);
  }
  // Unités de texte porteuses de chaque forme (unicité d'une valeur sur la page ou dans le document).
  const parForme = new Map<string, CoveredSourceUnit[]>();
  for (const x of textes) for (const f of formesUnite.get(x.sourceUnitId) ?? []) parForme.set(f, [...(parForme.get(f) ?? []), x]);
  const porteurs = (form: string, page: number | null | 'doc') => (parForme.get(form) ?? []).filter((x) => page === 'doc' || pageOk(x.page, page)).length;
  const fidele = input.faithfulPage ?? (() => false);

  // Lot 115F (#792, écart P2-06) : connaissance persistée du document gardée PAR ORIGINE et PAR RÉFÉRENCE
  // (fait, métadonnée, candidat) — règle remplacée : la comparaison se faisait sur un agrégat global de toutes
  // les valeurs, qui prouvait une coordonnée sans pouvoir dire laquelle des données persistées la portait.
  const textuelles = (values: ReadonlyArray<unknown>) => values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '').map(String);
  const connaissance: Array<{ source: CoverageEvidenceSource; ref: string; values: string[]; unites: ReadonlySet<string> }> = [
    ...input.facts.map((f) => ({
      source: 'FACT' as const, ref: `fact:${f.ref}`, values: textuelles(f.values),
      unites: new Set(f.unitIds.map(unitOfCell)),
    })),
    ...(input.values ?? []).map((v) => ({
      source: v.source, ref: `${v.source === 'METADATA' ? 'meta' : 'candidate'}:${v.ref}`, values: textuelles(v.values),
      unites: new Set((v.unitIds ?? []).map(unitOfCell)),
    })),
  ];

  // ── 1. Plans : mode de contrôle et inventaire des occurrences de chaque unité ──
  const plans: Array<Plan<U>> = units.map((u) => {
    const plan: Plan<U> = { u, mode: 'STATUS_ONLY', occs: [], excluded: [], res: new Map(), fallback: new Map(), cite: [] };
    if (u.kind === 'TABLE_ROW' && u.status === 'COVERED' && u.reason === 'table') {
      plan.mode = 'ROW_CHECK';
      const c = cellOccurrencesOf(u, (vs) => structuredValueForms(vs));
      plan.occs = c.occurrences;
      plan.excluded = c.excluded;
    } else if (TEXT_KINDS.has(u.kind) && u.text && u.status === 'COVERED' && CONTROLLED_COVERED_REASONS.has(u.reason ?? '')) {
      plan.mode = 'COVERED_CHECK';
      plan.occs = [...valueOccurrencesOf(u), ...propositionOccurrencesOf(u)].sort((a, b) => a.start - b.start);
    } else if (TEXT_KINDS.has(u.kind) && u.text && u.status === 'UNRESOLVED' && RECONCILABLE_REASONS.has(u.reason ?? '')) {
      plan.mode = 'RECONCILE';
      plan.occs = [...valueOccurrencesOf(u, { numbers: true }), ...propositionOccurrencesOf(u)].sort((a, b) => a.start - b.start);
      const p = platUnite.get(u.sourceUnitId) ?? '';
      plan.cite = p.length >= MIN_CITATION ? faits.filter((x) => x.ex && x.ex.includes(p) && [...x.pages].some((pg) => pageOk(pg, u.page))) : [];
      const segment = (x: CoveredSourceUnit) => (x.location as { segment?: unknown }).segment ?? null;
      plan.recouvrement = p.length >= MIN_CITATION * 2 ? textes.find((x) => {
        if (x.sourceUnitId === u.sourceUnitId || x.status !== 'COVERED' || x.page !== u.page || segment(x) === segment(u)) return false;
        const q = platUnite.get(x.sourceUnitId) ?? '';
        return q.length >= MIN_CITATION * 2 && (q.includes(p) || p.includes(q));
      }) : undefined;
      // ────────────────────────────────────────────────────────────────
      // Carte #853 (R1, AC04) — règle complétée : un texte IDENTIQUE à une
      // unité couverte n'est le rappel de la même information que s'il est
      // démontré : même page (même passage relu par un autre segment), ou
      // passage qui ne porte que des IDENTIFIANTS (une référence désigne le
      // même objet où qu'elle soit rappelée) ou aucune valeur. Un montant ou
      // une date répétés sur une autre page peuvent être une autre
      // information (autre période, autre facture) : ils doivent porter leur
      // PROPRE preuve. Le jumeau doit lui-même rester couvert (étape 5).
      // ────────────────────────────────────────────────────────────────
      const identifiantsSeuls = plan.occs.every((o) => o.nature === 'IDENTIFIER');
      plan.twin = textes.find((x) => x.sourceUnitId !== u.sourceUnitId && x.kind === u.kind && x.status === 'COVERED'
        && platUnite.get(x.sourceUnitId) === p && (x.page === u.page || identifiantsSeuls));
    } else {
      // Unités non contrôlées ici : bilan d'après leur état (compteurs complets, sans preuve nouvelle).
      if (TEXT_KINDS.has(u.kind) && u.text) plan.occs = [...valueOccurrencesOf(u), ...propositionOccurrencesOf(u)];
      else if (u.kind === 'TABLE_ROW') { const c = cellOccurrencesOf(u, (vs) => structuredValueForms(vs)); plan.occs = c.occurrences; plan.excluded = c.excluded; }
    }
    return plan;
  });
  const parId = new Map(plans.map((pl) => [pl.u.sourceUnitId, pl]));

  // ── Allocation des preuves (une preuve = une information, sauf rappel démontré) ──
  const usages = new Map<string, SourceOccurrence[]>();
  // ════════════════════════════════════════════════════════════════════
  // Carte #853 (R1/R2) — UNE PREUVE = UNE INFORMATION. Une preuve déjà
  // utilisée n'explique une autre occurrence que si la correspondance est
  // DÉMONTRÉE :
  //   · même passage relu par un autre segment (même page) — c'est la même
  //     occurrence, jamais un double compte ;
  //   · référence (identifiant) rappelée — elle désigne le même objet.
  // Un simple rappel PLAUSIBLE (même valeur et même rôle local, ou fait
  // dont l'extrait se retrouve à l'identique dans plusieurs unités) n'est
  // PAS démontré : deux lignes « Filtre 12 € » peuvent être deux achats.
  // L'occurrence est alors INCERTAINE (`recall_not_demonstrated`) — ni
  // couverte, ni présentée comme une omission certaine ; une décision
  // explicite de T1 sur cette occurrence (« rappel du fait n ») la prouve.
  // ════════════════════════════════════════════════════════════════════
  const utilisable = (c: ProofCandidate, o: SourceOccurrence): { ok: boolean; recallOf?: string; uncertain?: boolean } => {
    const avant = usages.get(c.key);
    if (!avant || avant.length === 0) return { ok: true };
    if (c.samePassage && avant.every((a) => a.unitId !== o.unitId && c.samePassage!.has(a.unitId))) return { ok: true, recallOf: avant[0].id };
    if (o.nature === 'IDENTIFIER' && avant.every((a) => a.form === o.form)) return { ok: true, recallOf: avant[0].id };
    const plausible = avant.every((a) => equivalentOccurrences(a, o))
      || (c.explicitUnits !== undefined && c.explicitUnits.has(o.unitId) && avant.every((a) => a.unitId !== o.unitId && c.explicitUnits!.has(a.unitId)));
    return plausible ? { ok: true, recallOf: avant[0].id, uncertain: true } : { ok: false };
  };
  const recouvre = (a: ReadonlySet<string>, b: ReadonlySet<string>) => [...a].filter((w) => b.has(w)).length;

  /** Candidats de preuve d'une occurrence de VALEUR (phase EXPLICIT : ancrage à l'unité ; WEAK : ancrages 113AN). */
  const candidats = (pl: Plan<U>, o: SourceOccurrence, phase: 'EXPLICIT' | 'WEAK'): ProofCandidate[] => {
    const u = pl.u;
    const out: ProofCandidate[] = [];
    const formes = new Set(o.forms);
    const porteForme = (forms: ReadonlySet<string>) => o.forms.some((f) => forms.has(f));
    if (phase === 'EXPLICIT') {
      for (const d of decisions.get(u.sourceUnitId) ?? []) {
        if (!formes.has(`${d.kind}:${d.normalizedValue}`)) continue;
        const outcome: OccurrenceOutcome = d.decision === 'UNDETERMINED' ? 'UNDETERMINED' : d.decision === 'NOT_RETAINED' ? 'NOT_RETAINED' : 'STRUCTURED';
        out.push({ key: `decision:${d.ref}`, source: 'VALUE_DECISION', ref: `decision:${d.ref}`, outcome, score: 400, decision: true });
      }
      if (pl.ligne && o.form) {
        const cells = Array.isArray(pl.ligne.u.payload.cells) ? (pl.ligne.u.payload.cells as Array<{ column?: unknown; value?: unknown; normalized?: unknown }>) : [];
        for (const c of cells) {
          if (!porteForme(structuredValueForms([c.value, c.normalized]))) continue;
          // Même ligne relue (texte ↔ tableau) : une cellule explique UNE occurrence de CETTE unité.
          out.push({ key: `${pl.ligne.u.sourceUnitId}:cell:${Number(c.column ?? 0) + 1}|${u.sourceUnitId}`, source: 'TABLE', ref: `unit:${pl.ligne.u.sourceUnitId}`, outcome: 'STRUCTURED', score: 300 });
        }
      }
      for (const x of faits) {
        const lie = pl.mode === 'ROW_CHECK' ? (x.cellules.has(o.id) || x.unites.has(u.sourceUnitId)) : x.unites.has(u.sourceUnitId);
        if (!lie || !porteForme(x.forms) || roleConflict(o, x.tags)) continue;
        out.push({ key: `fact:${x.f.ref}|${o.form}`, source: 'FACT', ref: `fact:${x.f.ref}`, outcome: 'STRUCTURED', score: 200 + 10 * recouvre(o.role, x.roots) + (x.cellules.has(o.id) ? 50 : 0), explicitUnits: x.unites });
      }
      for (const x of autres) {
        const lie = x.unites.has(u.sourceUnitId) || (x.v.source === 'METADATA' && u.reason === 'metadata' && pl.mode === 'COVERED_CHECK');
        if (!lie || !porteForme(x.forms)) continue;
        out.push({ key: `${refAutre(x)}|${o.form}`, source: x.v.source, ref: refAutre(x), outcome: 'STRUCTURED', score: 150, explicitUnits: x.unites.size > 0 ? x.unites : undefined });
      }
      // Cellule CONSERVÉE avec son rôle (en-tête de colonne ou de ligne) dans une table non incertaine, persistée et lue par T2 / T3.
      if (pl.mode === 'ROW_CHECK' && o.cell && (o.cell.header || o.cell.rowHeader) && !tableIncertaine.get(u.parentUnitId ?? '')) {
        out.push({ key: `cell:${o.id}`, source: 'TABLE', ref: `cell:${o.id}`, outcome: 'PRESERVED', score: 100 });
      }
      return out;
    }
    if (pl.mode === 'ROW_CHECK' || !o.form) return out;
    const pu = platUnite.get(u.sourceUnitId) ?? '';
    const libelle = u.label ? contentRoots(u.label) : new Set<string>();
    const ancreGlobal = pl.mode === 'RECONCILE' && (pl.cite.length > 0 || pl.recouvrement !== undefined);
    for (const x of faits) {
      if (!porteForme(x.forms) || roleConflict(o, x.tags)) continue;
      const surPage = [...x.pages].some((pg) => pageOk(pg, u.page));
      const unicite = o.forms.some((f) => u.page !== null && x.pages.has(u.page) && porteurs(f, u.page) === 1);
      const parLibelle = libelle.size > 0 && [...libelle].some((w) => x.roots.has(w));
      const ok = pl.mode === 'COVERED_CHECK'
        // Fait dont l'extrait CITE l'unité, ou de même libellé, ou seule unité de la page à porter la valeur.
        ? (pu.length >= MIN_CITATION && x.ex.includes(pu)) || (surPage && (parLibelle || unicite))
        : surPage && (ancreGlobal || pl.cite.some((c) => c.f === x.f) || parLibelle || unicite);
      if (!ok) continue;
      // Même passage relu par un autre segment : la même occurrence, jamais deux informations (aucun double compte).
      out.push({
        key: `fact:${x.f.ref}|${o.form}`, source: 'FACT', ref: `fact:${x.f.ref}`, outcome: 'STRUCTURED', score: 60 + 10 * recouvre(o.role, x.roots), explicitUnits: x.unites,
        ...(pl.recouvrement ? { samePassage: new Set([u.sourceUnitId, pl.recouvrement.sourceUnitId]) } : {}),
      });
    }
    if (pl.mode === 'COVERED_CHECK') {
      // Ligne de tableau structurée de la même page qui porte TOUTES les valeurs significatives de l'unité.
      const sig = pl.occs.filter((y) => y.nature !== 'PROPOSITION' && y.form).map((y) => y.form!);
      for (const l of lignes) {
        if (!pageOk(l.u.page, u.page) || !porteForme(l.forms) || !sig.every((g) => l.forms.has(g))) continue;
        out.push({ key: `rowcopy:${l.u.sourceUnitId}|${o.form}|${u.sourceUnitId}`, source: 'TABLE', ref: `unit:${l.u.sourceUnitId}`, outcome: 'STRUCTURED', score: 40 });
      }
    }
    for (const x of autres) {
      if (!porteForme(x.forms) || !valeurAncree(x, u)) continue;
      if (!(x.unites.has(u.sourceUnitId) || ancreGlobal || o.forms.some((f) => porteurs(f, 'doc') === 1))) continue;
      out.push({ key: `${refAutre(x)}|${o.form}`, source: x.v.source, ref: refAutre(x), outcome: 'STRUCTURED', score: 30, explicitUnits: x.unites.size > 0 ? x.unites : undefined });
    }
    return out;
  };

  /** Alloue les preuves aux occurrences de valeur libres des plans donnés (paires triées par force d'ancrage, puis ordre de lecture). */
  const allouer = (liste: ReadonlyArray<Plan<U>>, phase: 'EXPLICIT' | 'WEAK') => {
    for (const pl of liste) {
      const paires: Array<{ o: SourceOccurrence; c: ProofCandidate; i: number }> = [];
      let i = 0;
      for (const o of pl.occs) {
        if (o.nature === 'PROPOSITION' || pl.res.has(o.id)) continue;
        for (const c of candidats(pl, o, phase)) paires.push({ o, c, i: i++ });
      }
      paires.sort((a, b) => b.c.score - a.c.score || a.o.start - b.o.start || a.i - b.i);
      for (const p of paires) {
        if (pl.res.has(p.o.id)) continue;
        const us = utilisable(p.c, p.o);
        if (!us.ok) continue;
        // Choix entre plusieurs occurrences libres de même valeur ET de même force d'ancrage : rattachement NON
        // discriminé — compté (une seule occurrence expliquée), jamais présenté comme démontré pour l'une précise.
        const rivale = paires.some((q) => q.c.key === p.c.key && q.o.id !== p.o.id && q.c.score === p.c.score && !pl.res.has(q.o.id)
          && !equivalentOccurrences(q.o, p.o));
        // Rappel seulement PLAUSIBLE : gardé en dernier recours — une preuve propre (décision, autre fait) reste prioritaire.
        if (us.uncertain) {
          if (!pl.fallback.has(p.o.id)) pl.fallback.set(p.o.id, { outcome: 'UNCERTAIN', proof: { source: p.c.source, ref: p.c.ref }, reason: 'recall_not_demonstrated', ...(us.recallOf ? { recallOf: us.recallOf } : {}) });
          continue;
        }
        pl.res.set(p.o.id, {
          outcome: p.c.outcome, proof: { source: p.c.source, ref: p.c.ref }, decision: p.c.decision,
          reason: us.recallOf ? 'recall_of_same_information' : rivale ? 'occurrence_not_discriminated' : null,
          ...(us.recallOf ? { recallOf: us.recallOf } : {}),
        });
        usages.set(p.c.key, [...(usages.get(p.c.key) ?? []), p.o]);
      }
    }
  };

  /** Rappels plausibles retenus faute de mieux : occurrence INCERTAINE, jamais couverte. */
  const repli = (pl: Plan<U>) => { for (const [id, r] of pl.fallback) if (!pl.res.has(id)) pl.res.set(id, r); };

  /** Propositions sans valeur : portées par un fait qui les cite, sinon conservées (page fidèle), sinon incertaines. */
  const propositions = (pl: Plan<U>) => {
    for (const o of pl.occs) {
      if (o.nature !== 'PROPOSITION' || pl.res.has(o.id)) continue;
      const seuil = Math.max(1, Math.ceil(o.role.size * 0.3));
      const f = faits.find((x) => o.flat && x.ex.includes(o.flat) && [...x.pages].some((pg) => pageOk(pg, pl.u.page))
        && recouvre(o.role, new Set([...x.valueRoots, ...x.roots])) >= seuil);
      if (f) { pl.res.set(o.id, { outcome: 'STRUCTURED', proof: { source: 'FACT', ref: `fact:${f.f.ref}` }, reason: null }); continue; }
      pl.res.set(o.id, fidele(pl.u.page)
        ? { outcome: 'PRESERVED', proof: { source: 'UNIT', ref: `unit:${pl.u.sourceUnitId}` }, reason: 'passage_preserved_layer_a' }
        : { outcome: 'UNCERTAIN', proof: null, reason: 'transcription_unverified' });
    }
  };

  /** Bilan d'une unité (registre et provenance). */
  const bilan = (pl: Plan<U>): { counts: OccurrenceCounts; details: OccurrenceDetail[]; omitted: number } => {
    const outcomes: OccurrenceOutcome[] = [];
    const details: OccurrenceDetail[] = [];
    for (const o of pl.occs) {
      const r = pl.res.get(o.id) ?? { outcome: 'UNRESOLVED' as const, proof: null, reason: 'no_proof' };
      outcomes.push(r.outcome);
      details.push({
        id: o.id, nature: o.nature, at: o.cell ? o.cell.column : o.start, outcome: r.outcome, proof: r.proof, reason: r.reason,
        ...(r.recallOf ? { recallOf: r.recallOf } : {}),
      });
    }
    for (const x of pl.excluded) details.push({ id: x.id, nature: 'CELL', at: Number(x.id.slice(x.id.lastIndexOf(':') + 1)) - 1, outcome: 'EXCLUDED', proof: null, reason: x.reason });
    return { counts: countOutcomes(outcomes, pl.excluded.length), details: details.slice(0, MAX_OCCURRENCE_DETAILS), omitted: Math.max(0, details.length - MAX_OCCURRENCE_DETAILS) };
  };

  const provenanceDe = (pl: Plan<U>, rule: string, extra: Representation[] = []): CoverageProvenance => {
    const b = bilan(pl);
    const reps = [...extra, ...[...pl.res.values()].flatMap((r) => (r.proof ? [r.proof] : []))];
    const valeurs = pl.occs.filter((o) => o.nature !== 'PROPOSITION');
    const issue = (o: SourceOccurrence) => pl.res.get(o.id)?.outcome ?? 'UNRESOLVED';
    return {
      rule, sources: [...new Set(reps.map((r) => r.source))], refs: [...new Set(reps.map((r) => r.ref))].slice(0, MAX_REFS),
      previous: pl.u.coverageProvenance?.previous ?? { status: pl.u.status, reason: pl.u.reason },
      values: {
        total: valeurs.length,
        represented: valeurs.filter((o) => issue(o) === 'STRUCTURED' || issue(o) === 'PRESERVED').length,
        notRetained: valeurs.filter((o) => issue(o) === 'NOT_RETAINED').length,
        undetermined: valeurs.filter((o) => issue(o) === 'UNDETERMINED').length,
      },
      stage: input.stage,
      occurrences: b.counts, details: b.details, ...(b.omitted > 0 ? { detailsOmitted: b.omitted } : {}),
    };
  };

  // ── 2. Lignes de tableau : chaque cellule informative prouvée (preuve propre ou conservation avec rôle) ──
  const lignesPlans = plans.filter((pl) => pl.mode === 'ROW_CHECK');
  allouer(lignesPlans, 'EXPLICIT');
  for (const pl of lignesPlans) repli(pl);
  for (const pl of lignesPlans) {
    const b = bilan(pl).counts;
    // ────────────────────────────────────────────────────────────────────
    // Carte #853 (R3, AC06) — règle remplacée : toute ligne d'un tableau non
    // incertain était COVERED/table sans confrontation de ses cellules. Une
    // cellule informative sans rôle (en-tête perdu) ni preuve propre laisse
    // la ligne NON RÉSOLUE ; une décision indéterminée la rend INCERTAINE.
    // Une ligne dont toutes les cellules sont conservées avec leur rôle reste
    // couverte SANS exiger un fait par cellule.
    // ────────────────────────────────────────────────────────────────────
    if (b.unresolved > 0) pl.out = { ...pl.u, status: 'UNRESOLVED', reason: 'values_partially_structured', coverageProvenance: provenanceDe(pl, 'table_row_cells_unproven') };
    else if (b.undetermined > 0) pl.out = { ...pl.u, status: 'UNCERTAIN', reason: 'value_undetermined', coverageProvenance: provenanceDe(pl, 'value_decision_undetermined') };
  }
  // Lignes de tableau qui PROUVENT un texte (transcription de la même ligne) : seulement celles restées couvertes.
  const ligneCouverte = (pl: Plan<U> | undefined) => pl !== undefined && (pl.out ?? pl.u).status === 'COVERED';
  const lignes = units.filter((u) => u.kind === 'TABLE_ROW' && u.status === 'COVERED' && (parId.get(u.sourceUnitId)?.mode !== 'ROW_CHECK' || ligneCouverte(parId.get(u.sourceUnitId))))
    .map((u) => ({ u, forms: rowForms(u), roots: contentRoots(u.text) }));

  // ── 3. Unités de texte non résolues : ancrages au niveau de l'unité (113AN) ──
  const reconcilier = plans.filter((pl) => pl.mode === 'RECONCILE');
  const differees: Array<Plan<U>> = [];
  for (const pl of reconcilier) {
    const u = pl.u;
    const p = platUnite.get(u.sourceUnitId) ?? '';
    const valeurs = pl.occs.filter((o) => o.nature !== 'PROPOSITION');
    if (pl.twin || (valeurs.length === 0 && (pl.cite.length > 0 || pl.recouvrement))) { differees.push(pl); continue; }
    if (valeurs.length === 0) continue;
    // Ligne de tableau qui porte TOUTES les valeurs de l'unité (mots communs, même page).
    const formes = valeurs.map((o) => o.form!);
    const motsUnite = contentRoots(u.text);
    pl.ligne = lignes.find((l) => {
      const parent = pagesTableau.get(l.u.parentUnitId ?? '');
      const memePage = pageOk(l.u.page, u.page) || (parent !== undefined && u.page !== null && u.page >= parent[0] && u.page <= parent[1]);
      if (!memePage || !formes.every((f) => l.forms.has(f))) return false;
      if (motsUnite.size === 0) return true;
      return [...motsUnite].filter((w) => l.roots.has(w)).length / motsUnite.size >= ROW_WORDS_RATIO;
    });
    // Lignes de tableau TRANSCRITES dans l'unité (toutes leurs cellules y figurent) : si, une fois leurs cellules
    // retirées, l'unité ne porte plus aucun chiffre, ses valeurs sont exactement celles de ces lignes structurées.
    const transcrites = lignes.filter((l) => {
      const parent = pagesTableau.get(l.u.parentUnitId ?? '');
      const memePage = pageOk(l.u.page, u.page) || (parent !== undefined && u.page !== null && u.page >= parent[0] && u.page <= parent[1]);
      const cellules = cellPlats(l.u);
      return memePage && cellules.length >= 2 && cellules.every((c) => p.includes(c));
    });
    if (!pl.ligne && transcrites.length > 0) {
      let reste = p;
      for (const c of transcrites.flatMap((l) => cellPlats(l.u)).sort((a, b) => b.length - a.length)) reste = reste.split(c).join('');
      if (!/\d/.test(reste)) {
        for (const o of valeurs) pl.res.set(o.id, { outcome: 'STRUCTURED', proof: { source: 'TABLE', ref: `unit:${transcrites[0].u.sourceUnitId}` }, reason: 'table_transcription' });
        propositions(pl);
        pl.out = finaliserReconcile(pl, transcrites.map((l) => ({ source: 'TABLE' as const, ref: `unit:${l.u.sourceUnitId}` })), 'table_transcription');
      }
    }
  }

  // ── 4. Allocation : ancrages EXPLICITES d'abord (toutes unités), puis ancrages 113AN ──
  const valeursAPreuver = plans.filter((pl) => (pl.mode === 'COVERED_CHECK' || pl.mode === 'RECONCILE') && pl.out === undefined && !differees.includes(pl));
  allouer(valeursAPreuver, 'EXPLICIT');
  allouer(valeursAPreuver, 'WEAK');
  for (const pl of valeursAPreuver) { repli(pl); propositions(pl); }

  function finaliserReconcile(pl: Plan<U>, extra: Representation[], forcee?: string): U | undefined {
    const valeurs = pl.occs.filter((o) => o.nature !== 'PROPOSITION');
    const b = bilan(pl).counts;
    const expliquees = b.structured + b.preserved + b.notRetained + b.undetermined;
    const requalifier = (status: CoverageStatus, reason: string, rule: string): U => ({ ...pl.u, status, reason, coverageProvenance: provenanceDe(pl, rule, extra) });
    if (forcee) return requalifier('COVERED', forcee, forcee);
    if (b.total === 0) return undefined;
    if (b.unresolved === 0) {
      // Carte #853 (AC07) : passage sans valeur dont chaque proposition utile est conservée fidèlement (ou portée par un fait).
      if (valeurs.length === 0) return b.uncertain === 0 ? requalifier('COVERED', 'preserved_passage', 'propositions_preserved') : undefined;
      if (b.undetermined > 0) return requalifier('UNCERTAIN', 'value_undetermined', 'value_decision_undetermined');
      if (b.uncertain > 0) return expliquees > 0 ? requalifier('UNCERTAIN', 'occurrence_unverifiable', 'occurrence_unverifiable') : undefined;
      if (b.structured + b.preserved === 0) return requalifier('COVERED', 'value_decision_not_retained', 'value_decision_not_retained');
      const decidees = valeurs.filter((o) => pl.res.get(o.id)?.decision).length;
      const reps = [...pl.res.values()].flatMap((r) => (r.proof ? [r.proof] : []));
      const rule = valeurs.length > 0 && decidees === valeurs.length ? 'value_decision'
        : pl.ligne && reps.every((r) => r.source === 'TABLE' || r.source === 'VALUE_DECISION') ? 'table_transcription'
          : pl.recouvrement ? 'same_passage_other_segment' : pl.cite.length > 0 ? 'cited_by_fact_excerpt' : 'values_structured';
      const reason = rule === 'value_decision' ? 'value_decision' : rule === 'table_transcription' ? 'table_transcription'
        : rule === 'same_passage_other_segment' ? 'overlap' : rule === 'cited_by_fact_excerpt' ? 'fact_excerpt' : 'values_structured';
      return requalifier('COVERED', reason, rule);
    }
    // Une partie seulement des occurrences est représentée : NON RÉSOLUE, motif précis (réparation ciblée possible).
    if (expliquees > 0) return requalifier('UNRESOLVED', 'values_partially_structured', 'values_partially_structured');
    return undefined;
  }

  // ── 5. Statut de chaque unité contrôlée ──
  for (const pl of valeursAPreuver) {
    if (pl.mode === 'RECONCILE') {
      pl.out = finaliserReconcile(pl, pl.recouvrement ? [{ source: 'UNIT', ref: `unit:${pl.recouvrement.sourceUnitId}` }] : []);
      continue;
    }
    // ══════════════════════════════════════════════════════════════════
    // LOT 114G (Trello #760, P1-01) / LOT 115F (#792) — UNITÉ « COUVERTE »
    // CARTE #853 (P1-01 #835) — règle remplacée : chaque VALEUR DISTINCTE
    // devait être expliquée ; c'est désormais chaque OCCURRENCE (deux
    // prestations à 120 € = deux occurrences, une preuve chacune), et aussi
    // chaque proposition utile sans valeur, quel que soit le motif de
    // couverture (fait, métadonnée, entité). Priorité des états : une
    // occurrence non résolue → NON RÉSOLUE ; sinon une indéterminée → INCERTAINE
    // (`value_undetermined`) ; sinon une non vérifiable → INCERTAINE
    // (`occurrence_unverifiable`) ; sinon l'unité reste COUVERTE.
    // ══════════════════════════════════════════════════════════════════
    if (pl.occs.length === 0) continue;
    const b = bilan(pl).counts;
    if (b.unresolved > 0) pl.out = { ...pl.u, status: 'UNRESOLVED', reason: 'values_partially_structured', coverageProvenance: provenanceDe(pl, 'covered_unit_values_partially_structured') };
    else if (b.undetermined > 0) pl.out = { ...pl.u, status: 'UNCERTAIN', reason: 'value_undetermined', coverageProvenance: provenanceDe(pl, 'value_decision_undetermined') };
    else if (b.uncertain > 0) pl.out = { ...pl.u, status: 'UNCERTAIN', reason: 'occurrence_unverifiable', coverageProvenance: provenanceDe(pl, 'covered_unit_occurrence_unverifiable') };
  }

  // ── 6. Répétitions et passages relus : le jumeau doit RESTER couvert (aucune preuve circulaire) ──
  const finalDe = (x: CoveredSourceUnit) => { const q = parId.get(x.sourceUnitId); return q ? (q.out ?? q.u) : x; };
  for (const pl of differees) {
    const jumeau = pl.twin && finalDe(pl.twin).status === 'COVERED' ? pl.twin : undefined;
    if (jumeau) {
      for (const o of pl.occs) pl.res.set(o.id, { outcome: 'STRUCTURED', proof: { source: 'UNIT', ref: `unit:${jumeau.sourceUnitId}` }, reason: 'recall_of_same_information', recallOf: `${jumeau.sourceUnitId}@${o.start}` });
      pl.out = { ...pl.u, status: 'COVERED', reason: 'duplicate', coverageProvenance: provenanceDe(pl, 'duplicate_of_covered_unit', [{ source: 'UNIT', ref: `unit:${jumeau.sourceUnitId}` }]) };
      continue;
    }
    if (pl.recouvrement && finalDe(pl.recouvrement).status !== 'COVERED') pl.recouvrement = undefined;
    const valeurs = pl.occs.filter((o) => o.nature !== 'PROPOSITION');
    if (valeurs.length === 0) {
      propositions(pl);
      const b = bilan(pl).counts;
      if (b.uncertain > 0 || b.unresolved > 0) continue;
      if (pl.cite.length > 0) {
        pl.out = { ...pl.u, status: 'COVERED', reason: 'fact_excerpt', coverageProvenance: provenanceDe(pl, 'cited_by_fact_excerpt', pl.cite.map((x) => ({ source: 'FACT' as const, ref: `fact:${x.f.ref}` }))) };
      } else if (pl.recouvrement) {
        pl.out = { ...pl.u, status: 'COVERED', reason: 'overlap', coverageProvenance: provenanceDe(pl, 'same_passage_other_segment', [{ source: 'UNIT', ref: `unit:${pl.recouvrement.sourceUnitId}` }]) };
      }
      continue;
    }
    // Jumeau dégradé : l'unité est jugée sur SES preuves.
    allouer([pl], 'EXPLICIT');
    allouer([pl], 'WEAK');
    repli(pl);
    propositions(pl);
    pl.out = finaliserReconcile(pl, pl.recouvrement ? [{ source: 'UNIT', ref: `unit:${pl.recouvrement.sourceUnitId}` }] : []);
  }

  // ── 7. Coordonnées de contact (lot 114G / 115F), inchangées ──
  for (const pl of plans) {
    const u = pl.u;
    if (!(u.status === 'UNRESOLVED' && u.reason === 'values_not_structured' && TEXT_KINDS.has(u.kind) && u.text)) continue;
    // ════════════════════════════════════════════════════════════════════
    // LOT 114G (Trello #760, P2-06) — COORDONNÉES DE CONTACT, SANS IA
    //
    // `values_not_structured` (lot 111X) était exclu de la réconciliation :
    // une coordonnée déjà portée par un fait d'une AUTRE unité ou par une
    // donnée structurée du document repartait vers le modèle. Avant toute
    // réparation, TOUTES les coordonnées du passage sont comparées à la
    // connaissance persistée ; l'unité n'est couverte que si aucune ne
    // manque. Un seul résidu réel la laisse NON RÉSOLUE.
    //
    // LOT 115F (#792, écart P2-06) — règle complétée : le rapprochement est
    // fait COORDONNÉE PAR COORDONNÉE contre la donnée persistée qui la porte
    // (et non contre un agrégat de toutes les valeurs du document). La
    // provenance porte l'origine RÉELLE de chaque preuve (`FACT`,
    // `METADATA`, `CANDIDATE`), ses références, et des compteurs exacts
    // (total = coordonnées lues, représentées = coordonnées prouvées). Une
    // coordonnée non prouvée laisse l'unité NON RÉSOLUE, avec son décompte.
    // ════════════════════════════════════════════════════════════════════
    const coords = contactValuesOf(u.text);
    if (coords.length === 0) continue;
    const reps: Representation[] = [];
    let prouvees = 0;
    for (const c of coords) {
      // Preuve ancrée d'abord (fait rattaché à CETTE unité), sinon toute donnée persistée qui porte la coordonnée.
      const k = connaissance.find((x) => x.unites.has(u.sourceUnitId) && contactValueRepresented(c.form, x.values))
        ?? connaissance.find((x) => contactValueRepresented(c.form, x.values));
      if (!k) continue;
      prouvees++;
      reps.push({ source: k.source, ref: k.ref });
    }
    const compte = { total: coords.length, represented: prouvees, notRetained: 0, undetermined: 0 };
    const provenance: CoverageProvenance = {
      rule: prouvees === coords.length ? 'contact_values_structured' : 'contact_values_partially_structured',
      sources: [...new Set(reps.map((r) => r.source))], refs: [...new Set(reps.map((r) => r.ref))].slice(0, MAX_REFS),
      previous: u.coverageProvenance?.previous ?? { status: u.status, reason: u.reason },
      values: compte, stage: input.stage,
    };
    pl.out = prouvees === coords.length
      ? { ...u, status: 'COVERED', reason: 'values_structured', coverageProvenance: provenance }
      : { ...u, coverageProvenance: provenance };
  }

  // ── 8. Tableau parent : aucune table « couverte » ne masque une ligne non résolue ou incertaine ──
  const enfants = new Map<string, U[]>();
  for (const pl of plans) {
    const x = pl.out ?? pl.u;
    if (x.kind === 'TABLE_ROW' && x.parentUnitId) enfants.set(x.parentUnitId, [...(enfants.get(x.parentUnitId) ?? []), x]);
  }
  for (const pl of plans) {
    const t = pl.u;
    if (t.kind !== 'TABLE' || t.status !== 'COVERED' || t.reason !== 'table') continue;
    const l = enfants.get(t.sourceUnitId) ?? [];
    const nonResolues = l.filter((x) => x.status === 'UNRESOLVED').length;
    const incertaines = l.filter((x) => x.status === 'UNCERTAIN').length;
    if (nonResolues + incertaines === 0) continue;
    pl.out = {
      ...t, status: nonResolues > 0 ? 'UNRESOLVED' : 'UNCERTAIN', reason: nonResolues > 0 ? 'table_rows_unresolved' : 'table_rows_uncertain',
      coverageProvenance: {
        rule: nonResolues > 0 ? 'table_rows_unresolved' : 'table_rows_uncertain', sources: ['TABLE'],
        refs: l.filter((x) => x.status === 'UNRESOLVED' || x.status === 'UNCERTAIN').map((x) => `unit:${x.sourceUnitId}`).slice(0, MAX_REFS),
        previous: t.coverageProvenance?.previous ?? { status: t.status, reason: t.reason },
        values: { total: 0, represented: 0, notRetained: 0, undetermined: 0 }, stage: input.stage,
      },
    };
  }

  // ── 9. Registre des occurrences (toutes unités inventoriées) ──
  if (input.ledger) {
    for (const pl of plans) {
      if (pl.occs.length === 0 && pl.excluded.length === 0) continue;
      const x = pl.out ?? pl.u;
      if (pl.mode === 'STATUS_ONLY' || (pl.mode === 'RECONCILE' && pl.res.size === 0)) {
        // Bilan d'après l'état : aucune preuve nouvelle — une unité non contrôlée n'est jamais déclarée prouvée par ce registre.
        const issue: OccurrenceOutcome = x.status === 'COVERED' ? 'STRUCTURED' : x.status === 'FAILED' ? 'FAILED'
          : x.status === 'UNCERTAIN' ? 'UNCERTAIN' : x.status === 'NON_INFORMATIONAL' ? 'UNRESOLVED' : 'UNRESOLVED';
        if (x.status === 'NON_INFORMATIONAL') {
          input.ledger.set(x.sourceUnitId, { mode: pl.mode, counts: countOutcomes([], pl.occs.length + pl.excluded.length), details: [] });
          continue;
        }
        input.ledger.set(x.sourceUnitId, {
          mode: pl.mode, counts: countOutcomes(pl.occs.map(() => issue), pl.excluded.length),
          details: pl.occs.slice(0, MAX_OCCURRENCE_DETAILS).map((o) => ({
            id: o.id, nature: o.nature, at: o.cell ? o.cell.column : o.start, outcome: issue, proof: null, reason: `unit_status:${x.status}/${x.reason ?? '-'}`,
          })),
        });
        continue;
      }
      const b = bilan(pl);
      input.ledger.set(x.sourceUnitId, { mode: pl.mode, counts: b.counts, details: b.details });
    }
  }
  return plans.map((pl) => pl.out ?? pl.u);
}

/** Carte #853 : totaux d'occurrences d'un registre (rapport de complétude, BO). */
export function occurrenceTotals(ledger: ReadonlyMap<string, UnitOccurrenceLedger>): OccurrenceCounts & { units: number } {
  let t = emptyOccurrenceCounts();
  for (const l of ledger.values()) t = addOccurrenceCounts(t, l.counts);
  return { ...t, units: ledger.size };
}

// ── Politique explicite des unités restantes ────────────────────────────────

/**
 * Politique d'une unité NON couverte après analyse et réparation (code
 * stable, persisté avec l'unité). Jamais « terminé » sans politique :
 *   REPAIR_PENDING              réparation programmée (budget) ;
 *   REPAIR_RETRY_SCHEDULED      échec technique transitoire : reprise programmée ;
 *   REPAIR_ATTEMPTED_NO_RESULT  réparation ciblée RÉELLEMENT exécutée sans donnée prouvée — conservée, réinterprétable T3 / T2 ;
 *   REPAIR_NOT_ATTEMPTED        aucune tentative tracée et aucun motif d'exclusion connu (lot 114G, #760 P2-08) :
 *                               jamais présenté comme une réparation exécutée — la reprise ciblée reste possible ;
 *   REPAIR_NOT_ELIGIBLE:<motif> unité que la réparation ciblée ne soumettra JAMAIS (lot 115F, #792, écart P2-08) :
 *                               NO_TEXT, KIND_NOT_REPAIRABLE, NOT_SALIENT, FINAL_FAILURE, VALUE_DECISION_REVIEW,
 *                               NOTHING_TO_REPAIR — motif rendu par la règle de sélection elle-même ;
 *   REPAIR_EXHAUSTED            plafond de tentatives atteint ;
 *   REPAIR_NOT_RUN:<motif>      réparation non exécutée à l'analyse (DISABLED, BELOW_MIN_UNITS, BUDGET) ;
 *   NEEDS_SOURCE                relecture du fichier nécessaire (incertitude visuelle) ;
 *   T3_REINTERPRETATION         décision indéterminée ou fait conflictuel : arbitrage T3 / T2 ;
 *   PRESERVED_UNSTRUCTURED      texte sans valeur structurable, conservé (lu par T2 / T3) ;
 *   TECHNICAL_FAILURE_FINAL     échec définitif (lacune de pages, réparation refusée).
 * `null` pour une unité couverte ou non informative.
 */
export function residualPolicyOf(u: Pick<CoveredSourceUnit, 'status' | 'reason' | 'kind' | 'salient' | 'repairState' | 'repairAttempts' | 'payload'>
  & { text?: string | null; coverageProvenance?: { rule: string } | null },
  ctx: { repairSkipped?: string | null } = {}): string | null {
  if (u.status === 'COVERED' || u.status === 'NON_INFORMATIONAL') return null;
  if (u.status === 'FAILED') {
    const retryable = u.kind === 'PAGE_GAP' ? u.payload.retryable === true : (u.reason ?? '').endsWith(':retryable');
    return retryable ? 'REPAIR_RETRY_SCHEDULED' : 'TECHNICAL_FAILURE_FINAL';
  }
  if (u.repairState === 'NEEDS_SOURCE') return 'NEEDS_SOURCE';
  if (u.repairState === 'PENDING') return 'REPAIR_PENDING';
  if (u.repairState === 'EXHAUSTED') return 'REPAIR_EXHAUSTED';
  if (u.status === 'UNCERTAIN') return u.reason === 'table_uncertain' && u.repairAttempts === 0 && ctx.repairSkipped ? `REPAIR_NOT_RUN:${ctx.repairSkipped}` : 'T3_REINTERPRETATION';
  // Lot 114G (#760, P2-08) : la politique vient d'une TRACE réelle — tentative comptée ou état de réparation
  // posé par une passe. Sans trace, jamais « tentée sans résultat ».
  if (u.repairState === 'ATTEMPTED_FAILED' || u.repairState === 'SUCCEEDED' || u.repairAttempts > 0) return 'REPAIR_ATTEMPTED_NO_RESULT';
  // « Non structuré » ne prouve l'absence de valeur exploitable que si le texte n'en porte aucune.
  if (u.reason === 'not_structured' && (u.text === undefined || u.text === null || allSignificantValues(u.text).length === 0)) return 'PRESERVED_UNSTRUCTURED';
  // ══════════════════════════════════════════════════════════════════════
  // LOT 115F (Trello #792, écart P2-08) — « NON RÉPARABLE », ÉTAT DISTINCT
  //
  // Règle remplacée : toute unité sans trace de tentative recevait
  // `REPAIR_NOT_ATTEMPTED` (« reprise ciblée possible »), y compris celle que
  // la sélection de la réparation ciblée n'a jamais pu retenir (texte absent,
  // nature non relisible, texte non saillant, échec définitif, réexamen des
  // décisions de valeur) : une alerte sans action possible. Le motif vient
  // désormais de la règle de sélection elle-même (`repairIneligibility`,
  // définition unique) ; « non tentée » ne subsiste que lorsqu'une tentative
  // est réellement possible.
  // ══════════════════════════════════════════════════════════════════════
  const inexploitable = repairIneligibility(u);
  if (inexploitable) return `REPAIR_NOT_ELIGIBLE:${inexploitable}`;
  return ctx.repairSkipped ? `REPAIR_NOT_RUN:${ctx.repairSkipped}` : 'REPAIR_NOT_ATTEMPTED';
}

/** Pose la politique sur chaque unité (pure ; inchangée si identique). */
export function withResidualPolicies<U extends CoveredSourceUnit>(units: readonly U[], ctx: { repairSkipped?: string | null } = {}): U[] {
  return units.map((u) => {
    const policy = residualPolicyOf(u, ctx);
    return u.residualPolicy === policy ? u : { ...u, residualPolicy: policy };
  });
}

/** Résumé de la réconciliation (compteurs, jamais de contenu) — diagnostics de couverture. */
export interface ReconciliationSummary {
  requalified: number;
  byRule: Record<string, number>;
  partiallyStructured: number;
  undetermined: number;
  stage: ReconciliationStage;
  /**
   * Carte #853 (R3) : totaux PAR OCCURRENCE des unités inventoriées (unités ≠ occurrences) — `total` = structurées
   * + conservées + non retenues + indéterminées + incertaines + non résolues + échecs ; exclues à part.
   * Absent : registre non fourni (diagnostic antérieur).
   */
  occurrences?: OccurrenceCounts & { units: number };
}

export function reconciliationSummary(units: readonly CoveredSourceUnit[], stage: ReconciliationStage,
  ledger?: ReadonlyMap<string, UnitOccurrenceLedger>): ReconciliationSummary {
  const byRule: Record<string, number> = {};
  let requalified = 0;
  for (const u of units) {
    const pv = u.coverageProvenance;
    if (!pv) continue;
    byRule[pv.rule] = (byRule[pv.rule] ?? 0) + 1;
    if (u.status !== pv.previous.status || u.reason !== pv.previous.reason) {
      if (u.status === 'COVERED' || u.status === 'UNCERTAIN') requalified++;
    }
  }
  return {
    requalified, byRule, stage,
    partiallyStructured: units.filter((u) => u.status === 'UNRESOLVED' && u.reason === 'values_partially_structured').length,
    undetermined: units.filter((u) => u.status === 'UNCERTAIN' && u.reason === 'value_undetermined').length,
    ...(ledger ? { occurrences: occurrenceTotals(ledger) } : {}),
  };
}

/** Résidus par politique (compteurs) — rapport de complétude. */
export function residualCounts(units: readonly CoveredSourceUnit[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of units) if (u.residualPolicy) out[u.residualPolicy] = (out[u.residualPolicy] ?? 0) + 1;
  return out;
}
