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
import { unstructuredContactValues } from './coverage';
import { contentRoots, valueFormsOf } from '../value-decisions/validate';
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

/** Valeur structurée hors faits : métadonnée du document (montant, date, SIRET…) ou candidat Opération. */
export interface ReconciliationValue {
  ref: string;
  source: 'METADATA' | 'CANDIDATE';
  values: ReadonlyArray<unknown>;
  page: number | null;
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
}

/**
 * Motifs d'une unité NON RÉSOLUE que la réconciliation peut lever (jamais une incertitude ni un échec).
 * Lot 114G (#760, P2-06) : `values_not_structured` (coordonnées de contact) est traité à part, par
 * comparaison de TOUTES les coordonnées du passage à la connaissance persistée (`reconcileContactUnit`).
 */
const RECONCILABLE_REASONS = new Set(['not_extracted', 'not_structured', 'fact_dropped', 'values_partially_structured']);

/**
 * Lot 114G (Trello #760, P2-05) — valeurs structurées d'un candidat Opération (références métier, montants,
 * dates, périodes), à partir de sa forme en mémoire OU de sa charge persistée (`document_operation_candidates.payload`).
 * Une seule fonction pour l'analyse et pour la réconciliation sur stockage : même résultat des deux côtés. Pure.
 */
export function candidateReconciliationValue(candidateKey: string, c: unknown): ReconciliationValue {
  const o = (c && typeof c === 'object' ? c : {}) as {
    businessReferences?: Array<{ value?: unknown }>;
    financialHints?: Array<{ amountMinor?: unknown; economicDate?: unknown; periodStart?: unknown; periodEnd?: unknown }>;
    temporalHints?: Record<string, unknown> | null;
  };
  const montant = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v / 100 : null);
  return {
    ref: candidateKey, source: 'CANDIDATE', page: null,
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

/**
 * Réconcilie les unités NON RÉSOLUES avec les données réellement structurées
 * (voir l'en-tête). Rend les unités (requalifiées avec leur provenance) dans
 * le même ordre ; les autres sont rendues telles quelles.
 */
export function reconcileCoverage<U extends CoveredSourceUnit>(units: readonly U[], input: ReconciliationInput): U[] {
  const textes = units.filter((u) => TEXT_KINDS.has(u.kind) && u.text);
  const formesUnite = new Map<string, string[]>();
  for (const u of units) if ((TEXT_KINDS.has(u.kind) || u.kind === 'TABLE_ROW') && u.text) formesUnite.set(u.sourceUnitId, unitValueForms(u.text));
  const platUnite = new Map(textes.map((u) => [u.sourceUnitId, plat(u.text!)]));
  const lignes = units.filter((u) => u.kind === 'TABLE_ROW' && u.status === 'COVERED').map((u) => ({ u, forms: rowForms(u), roots: contentRoots(u.text) }));
  const pagesTableau = new Map<string, [number, number]>();
  for (const t of units) if (t.kind === 'TABLE') pagesTableau.set(t.sourceUnitId, [t.page ?? 1, Number(t.payload.pageEnd ?? t.page ?? 1)]);
  const pageDe = new Map(units.map((u) => [u.sourceUnitId, u.page]));
  const faits = input.facts.map((f) => ({
    f,
    forms: structuredValueForms(f.values),
    roots: new Set(f.labels.flatMap((l) => (l ? [...contentRoots(String(l).replace(/[._]/g, ' '))] : []))),
    ex: f.excerpt ? plat(f.excerpt) : '',
    // Pages du fait : celle de sa preuve et celles de ses unités (une preuve sans page vaut pour toute page).
    pages: new Set<number | null>(f.unitIds.length > 0 && f.page === null
      ? f.unitIds.map((id) => pageDe.get(unitOfCell(id)) ?? null)
      : [f.page, ...f.unitIds.map((id) => pageDe.get(unitOfCell(id)) ?? null)]),
  }));
  const autres = (input.values ?? []).map((v) => ({ v, forms: structuredValueForms(v.values) }));
  const decisions = new Map<string, Map<string, ReconciliationDecision>>();
  for (const d of input.decisions ?? []) {
    if (!d.kind || !d.normalizedValue) continue;
    const id = unitOfCell(d.sourceUnitId);
    const m = decisions.get(id) ?? new Map<string, ReconciliationDecision>();
    m.set(`${d.kind}:${d.normalizedValue}`, d);
    decisions.set(id, m);
  }
  // Unités de texte porteuses de chaque forme (unicité d'une valeur sur la page ou dans le document).
  const parForme = new Map<string, CoveredSourceUnit[]>();
  for (const x of textes) for (const f of formesUnite.get(x.sourceUnitId) ?? []) parForme.set(f, [...(parForme.get(f) ?? []), x]);
  const porteurs = (form: string, page: number | null | 'doc') => (parForme.get(form) ?? []).filter((x) => page === 'doc' || pageOk(x.page, page)).length;

  // Lot 114G (#760, P2-06) : toute la connaissance persistée du document (valeurs des faits, métadonnées, candidats).
  const connaissance = [...input.facts.flatMap((f) => f.values), ...(input.values ?? []).flatMap((v) => v.values)]
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '').map(String);

  return units.map((u) => {
    // ════════════════════════════════════════════════════════════════════
    // LOT 114G (Trello #760, P1-01) — UNITÉ « COUVERTE » À PLUSIEURS VALEURS
    //
    // `computeCoverage` déclare une unité COVERED/fact dès qu'UN fait lui est
    // lié. Un bloc « Montant TTC 120,00 € — HT 100,00 € — acompte 30,00 € »
    // dont seule la première valeur est structurée restait donc couvert, et
    // la réconciliation ne regardait que les unités NON RÉSOLUES. Chaque
    // valeur significative (montant, date, identifiant) d'une unité couverte
    // par un fait doit maintenant être expliquée : décision valide de T1, fait
    // rattaché à l'unité, ou donnée structurée ancrée (mêmes ancrages que
    // ci-dessous — jamais une simple égalité de nombre). Sinon l'unité devient
    // NON RÉSOLUE `values_partially_structured` (réparation ciblée possible),
    // ou INCERTAINE si une valeur est déclarée indéterminée. Une unité à une
    // seule valeur, ou dont toutes les valeurs sont expliquées, n'est jamais
    // dégradée.
    // ════════════════════════════════════════════════════════════════════
    if (u.status === 'COVERED' && u.reason === 'fact' && TEXT_KINDS.has(u.kind) && u.text) {
      const sig = [...new Set(allSignificantValues(u.text).map((v) => `${v.kind}:${v.normalized}`))];
      if (sig.length < 2) return u;
      const decs = decisions.get(u.sourceUnitId) ?? new Map<string, ReconciliationDecision>();
      const libelle = u.label ? contentRoots(u.label) : new Set<string>();
      const pu = platUnite.get(u.sourceUnitId) ?? '';
      const reps: Representation[] = [];
      let structurees = 0; let nonRetenues = 0; let indeterminees = 0;
      for (const form of sig) {
        const d = decs.get(form);
        if (d) {
          reps.push({ source: 'VALUE_DECISION', ref: `decision:${d.ref}` });
          if (d.decision === 'UNDETERMINED') indeterminees++; else if (d.decision === 'NOT_RETAINED') nonRetenues++; else structurees++;
          continue;
        }
        const f = faits.find((x) => x.forms.has(form) && (
          // Fait rattaché à CETTE unité (provenance), ou dont l'extrait la cite, ou de même libellé,
          // ou seule unité de la page à porter la valeur.
          x.f.unitIds.some((id) => unitOfCell(id) === u.sourceUnitId)
          || (pu.length >= MIN_CITATION && x.ex.includes(pu))
          || ([...x.pages].some((pg) => pageOk(pg, u.page)) && (
            (libelle.size > 0 && [...libelle].some((w) => x.roots.has(w)))
            || (u.page !== null && x.pages.has(u.page) && porteurs(form, u.page) === 1)))));
        if (f) { structurees++; reps.push({ source: 'FACT', ref: `fact:${f.f.ref}` }); continue; }
        const l = lignes.find((x) => pageOk(x.u.page, u.page) && x.forms.has(form) && sig.every((g) => x.forms.has(g)));
        if (l) { structurees++; reps.push({ source: 'TABLE', ref: `unit:${l.u.sourceUnitId}` }); continue; }
        const o = autres.find((x) => x.forms.has(form) && pageOk(x.v.page, u.page) && porteurs(form, 'doc') === 1);
        if (o) { structurees++; reps.push({ source: o.v.source, ref: `${o.v.source === 'METADATA' ? 'meta' : 'candidate'}:${o.v.ref}` }); continue; }
      }
      const expliquees = structurees + nonRetenues + indeterminees;
      if (expliquees === sig.length && indeterminees === 0) return u;
      const provenance: CoverageProvenance = {
        rule: expliquees === sig.length ? 'value_decision_undetermined' : 'covered_unit_values_partially_structured',
        sources: [...new Set(reps.map((r) => r.source))], refs: [...new Set(reps.map((r) => r.ref))].slice(0, MAX_REFS),
        previous: u.coverageProvenance?.previous ?? { status: u.status, reason: u.reason },
        values: { total: sig.length, represented: structurees, notRetained: nonRetenues, undetermined: indeterminees }, stage: input.stage,
      };
      return expliquees === sig.length
        ? { ...u, status: 'UNCERTAIN', reason: 'value_undetermined', coverageProvenance: provenance }
        : { ...u, status: 'UNRESOLVED', reason: 'values_partially_structured', coverageProvenance: provenance };
    }
    // ════════════════════════════════════════════════════════════════════
    // LOT 114G (Trello #760, P2-06) — COORDONNÉES DE CONTACT, SANS IA
    //
    // `values_not_structured` (lot 111X) était exclu de la réconciliation :
    // une coordonnée déjà portée par un fait d'une AUTRE unité ou par une
    // donnée structurée du document repartait vers le modèle. Avant toute
    // réparation, TOUTES les coordonnées du passage sont comparées à la
    // connaissance persistée ; l'unité n'est couverte que si aucune ne
    // manque. Un seul résidu réel la laisse NON RÉSOLUE.
    // ════════════════════════════════════════════════════════════════════
    if (u.status === 'UNRESOLVED' && u.reason === 'values_not_structured' && TEXT_KINDS.has(u.kind) && u.text) {
      if (unstructuredContactValues(u.text, connaissance).length > 0) return u;
      return {
        ...u, status: 'COVERED', reason: 'values_structured',
        coverageProvenance: {
          rule: 'contact_values_structured', sources: ['FACT'], refs: [],
          previous: u.coverageProvenance?.previous ?? { status: u.status, reason: u.reason },
          values: { total: 0, represented: 0, notRetained: 0, undetermined: 0 }, stage: input.stage,
        },
      };
    }
    if (u.status !== 'UNRESOLVED' || !RECONCILABLE_REASONS.has(u.reason ?? '') || !TEXT_KINDS.has(u.kind) || !u.text) return u;
    const p = platUnite.get(u.sourceUnitId) ?? '';
    const forms = formesUnite.get(u.sourceUnitId) ?? [];
    const decs = decisions.get(u.sourceUnitId) ?? new Map<string, ReconciliationDecision>();
    // Requalification répétée (reprise) : l'état d'ORIGINE est conservé.
    const previous = u.coverageProvenance?.previous ?? { status: u.status, reason: u.reason };
    const requalifier = (status: CoverageStatus, reason: string, rule: string, reps: Representation[], counts: CoverageProvenance['values']): U => ({
      ...u, status, reason,
      coverageProvenance: {
        rule, sources: [...new Set(reps.map((r) => r.source))], refs: [...new Set(reps.map((r) => r.ref))].slice(0, MAX_REFS),
        previous, values: counts, stage: input.stage,
      },
    });

    // ── Ancrages au niveau de l'unité ──
    const cite = p.length >= MIN_CITATION ? faits.filter((x) => x.ex && x.ex.includes(p) && [...x.pages].some((pg) => pageOk(pg, u.page))) : [];
    const repetition = textes.find((x) => x.sourceUnitId !== u.sourceUnitId && x.kind === u.kind && x.status === 'COVERED' && platUnite.get(x.sourceUnitId) === p);
    const segment = (x: CoveredSourceUnit) => (x.location as { segment?: unknown }).segment ?? null;
    const recouvrement = p.length >= MIN_CITATION * 2 ? textes.find((x) => {
      if (x.sourceUnitId === u.sourceUnitId || x.status !== 'COVERED' || x.page !== u.page || segment(x) === segment(u)) return false;
      const q = platUnite.get(x.sourceUnitId) ?? '';
      return q.length >= MIN_CITATION * 2 && (q.includes(p) || p.includes(q));
    }) : undefined;

    if (repetition) {
      return requalifier('COVERED', 'duplicate', 'duplicate_of_covered_unit', [{ source: 'UNIT', ref: `unit:${repetition.sourceUnitId}` }],
        { total: forms.length, represented: forms.length, notRetained: 0, undetermined: 0 });
    }
    if (forms.length === 0) {
      if (cite.length > 0) {
        return requalifier('COVERED', 'fact_excerpt', 'cited_by_fact_excerpt', cite.map((x) => ({ source: 'FACT' as const, ref: `fact:${x.f.ref}` })),
          { total: 0, represented: 0, notRetained: 0, undetermined: 0 });
      }
      if (recouvrement) {
        return requalifier('COVERED', 'overlap', 'same_passage_other_segment', [{ source: 'UNIT', ref: `unit:${recouvrement.sourceUnitId}` }],
          { total: 0, represented: 0, notRetained: 0, undetermined: 0 });
      }
      return u;
    }

    // ── Chaque valeur : décision de T1, sinon donnée structurée ancrée ──
    const libelle = u.label ? contentRoots(u.label) : new Set<string>();
    const ancreGlobal = cite.length > 0 || recouvrement !== undefined;
    const reps: Representation[] = [];
    if (recouvrement) reps.push({ source: 'UNIT', ref: `unit:${recouvrement.sourceUnitId}` });
    let structurees = 0;
    let nonRetenues = 0;
    let indeterminees = 0;
    let decidees = 0;
    // Ligne de tableau qui porte TOUTES les valeurs de l'unité (mots communs, même page).
    const motsUnite = contentRoots(u.text);
    const ligne = lignes.find((l) => {
      const parent = pagesTableau.get(l.u.parentUnitId ?? '');
      const memePage = pageOk(l.u.page, u.page) || (parent !== undefined && u.page !== null && u.page >= parent[0] && u.page <= parent[1]);
      if (!memePage || !forms.every((f) => l.forms.has(f))) return false;
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
    if (!ligne && transcrites.length > 0) {
      let reste = p;
      for (const c of transcrites.flatMap((l) => cellPlats(l.u)).sort((a, b) => b.length - a.length)) reste = reste.split(c).join('');
      if (!/\d/.test(reste)) {
        return requalifier('COVERED', 'table_transcription', 'table_transcription', transcrites.map((l) => ({ source: 'TABLE' as const, ref: `unit:${l.u.sourceUnitId}` })),
          { total: forms.length, represented: forms.length, notRetained: 0, undetermined: 0 });
      }
    }
    for (const form of forms) {
      const d = decs.get(form);
      if (d) {
        decidees++;
        reps.push({ source: 'VALUE_DECISION', ref: `decision:${d.ref}` });
        if (d.decision === 'UNDETERMINED') indeterminees++;
        else if (d.decision === 'NOT_RETAINED') nonRetenues++;
        else structurees++;
        continue;
      }
      if (ligne) { structurees++; reps.push({ source: 'TABLE', ref: `unit:${ligne.u.sourceUnitId}` }); continue; }
      const f = faits.find((x) => x.forms.has(form) && [...x.pages].some((pg) => pageOk(pg, u.page)) && (
        ancreGlobal || cite.includes(x)
        || (libelle.size > 0 && [...libelle].some((w) => x.roots.has(w)))
        || (u.page !== null && x.pages.has(u.page) && porteurs(form, u.page) === 1)));
      if (f) { structurees++; reps.push({ source: 'FACT', ref: `fact:${f.f.ref}` }); continue; }
      const o = autres.find((x) => x.forms.has(form) && pageOk(x.v.page, u.page) && (ancreGlobal || porteurs(form, 'doc') === 1));
      if (o) { structurees++; reps.push({ source: o.v.source, ref: `${o.v.source === 'METADATA' ? 'meta' : 'candidate'}:${o.v.ref}` }); continue; }
    }
    const counts = { total: forms.length, represented: structurees, notRetained: nonRetenues, undetermined: indeterminees };
    const expliquees = structurees + nonRetenues + indeterminees;
    if (expliquees === forms.length) {
      if (indeterminees > 0) return requalifier('UNCERTAIN', 'value_undetermined', 'value_decision_undetermined', reps, counts);
      if (structurees === 0) return requalifier('COVERED', 'value_decision_not_retained', 'value_decision_not_retained', reps, counts);
      const rule = decidees === forms.length ? 'value_decision' : ligne && reps.every((r) => r.source === 'TABLE' || r.source === 'VALUE_DECISION') ? 'table_transcription'
        : recouvrement ? 'same_passage_other_segment' : cite.length > 0 ? 'cited_by_fact_excerpt' : 'values_structured';
      const reason = rule === 'value_decision' ? 'value_decision' : rule === 'table_transcription' ? 'table_transcription'
        : rule === 'same_passage_other_segment' ? 'overlap' : rule === 'cited_by_fact_excerpt' ? 'fact_excerpt' : 'values_structured';
      return requalifier('COVERED', reason, rule, reps, counts);
    }
    if (expliquees > 0) {
      // Une partie seulement des valeurs est représentée : NON RÉSOLUE, motif précis (réparation ciblée possible).
      return requalifier('UNRESOLVED', 'values_partially_structured', 'values_partially_structured', reps, counts);
    }
    return u;
  });
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
 *   REPAIR_EXHAUSTED            plafond de tentatives atteint ;
 *   REPAIR_NOT_RUN:<motif>      réparation non exécutée à l'analyse (DISABLED, BELOW_MIN_UNITS, BUDGET) ;
 *   NEEDS_SOURCE                relecture du fichier nécessaire (incertitude visuelle) ;
 *   T3_REINTERPRETATION         décision indéterminée ou fait conflictuel : arbitrage T3 / T2 ;
 *   PRESERVED_UNSTRUCTURED      texte sans valeur structurable, conservé (lu par T2 / T3) ;
 *   TECHNICAL_FAILURE_FINAL     échec définitif (lacune de pages, réparation refusée).
 * `null` pour une unité couverte ou non informative.
 */
export function residualPolicyOf(u: Pick<CoveredSourceUnit, 'status' | 'reason' | 'kind' | 'salient' | 'repairState' | 'repairAttempts' | 'payload'> & { text?: string | null },
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
}

export function reconciliationSummary(units: readonly CoveredSourceUnit[], stage: ReconciliationStage): ReconciliationSummary {
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
  };
}

/** Résidus par politique (compteurs) — rapport de complétude. */
export function residualCounts(units: readonly CoveredSourceUnit[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of units) if (u.residualPolicy) out[u.residualPolicy] = (out[u.residualPolicy] ?? 0) + 1;
  return out;
}
