/**
 * Contrôle DÉTERMINISTE de couverture (fonctions pures) — ticket T1,
 * « Introduire un contrôle de couverture », « Préserver la provenance ».
 *
 *   fait → sourceUnitId[]   (extrait retrouvé dans l'unité, cellule de
 *                            tableau, observation visuelle) ;
 *   unité → COVERED | NON_INFORMATIONAL | UNRESOLVED | UNCERTAIN | FAILED ;
 *   document → T1CompletenessReport (somme des états = total) et état de
 *              qualité COMPLETE / COMPLETE_WITH_UNRESOLVED /
 *              INCOMPLETE_RETRYABLE / INCOMPLETE_FINAL.
 *
 * Aucun appel modèle : la décision de réparer est prise ici, sur des faits
 * vérifiables. Une unité est COUVERTE dès qu'une donnée persistée exploitable
 * la représente : fait, métadonnée structurée, entité, ligne de tableau
 * structurée, observation enregistrée comme fait.
 */
import { cellUnitId, unitOfCell } from './build-units';
import { isNonInformational, mots, plat } from './text';
import type {
  CoverageStatus, CoveredSourceUnit, SourceUnit, T1CompletenessReport, T1QualityState, UnitCoverage, UnresolvedFactRecord,
} from './types';
import { T1_COMPLETENESS_ANOMALIES } from './types';

/** Preuve d'un fait, telle que la portent `T1Fact`, `ProjectedFact` ou un fait persisté. */
export interface EvidenceRef {
  provenance?: 'TEXT_EXTRACTION' | 'VISUAL_ANALYSIS' | null;
  excerpt?: string | null;
  page?: number | null;
  /** Référence de cellule APRÈS normalisation des tableaux (index, ligne, colonne — base 0). */
  table?: { index: number; row: number; column: number } | null;
  visualDescription?: string | null;
  visualPage?: number | null;
  /** Valeurs (brute, normalisée) et libellés, pour un couple libellé / valeur. */
  values?: Array<string | number | boolean | null | undefined>;
  labels?: Array<string | null | undefined>;
}

const TEXTUELLES = new Set(['TEXT_BLOCK', 'LABEL_VALUE', 'FORM_FIELD', 'TABLE_ROW', 'DOCUMENT_METADATA']);
/** Longueur minimale (forme de comparaison) d'une unité retrouvée À L'INTÉRIEUR d'un extrait. */
const MIN_INCLUSION = 4;

/** Rattache des preuves aux unités. Index construits une fois par document. */
export class SourceUnitLinker {
  private readonly textuelles: Array<{ u: SourceUnit; p: string }>;
  private readonly visuelles: Array<{ u: SourceUnit; p: string }>;
  private readonly tables = new Map<number, { index: number; pageStart: number | null }>();
  private readonly ids: Set<string>;

  constructor(units: readonly SourceUnit[]) {
    this.textuelles = units.filter((u) => TEXTUELLES.has(u.kind) && u.text).map((u) => ({ u, p: plat(u.text!) }));
    this.visuelles = units.filter((u) => u.kind === 'VISUAL_OBSERVATION' || u.kind === 'VISUAL_SUMMARY')
      .map((u) => ({ u, p: plat(String(u.payload.description ?? u.text ?? '')) }));
    for (const u of units) {
      if (u.kind === 'TABLE' && typeof u.payload.tableIndex === 'number') {
        this.tables.set(u.payload.tableIndex, { index: u.payload.tableIndex, pageStart: u.page });
      }
    }
    this.ids = new Set(units.map((u) => u.sourceUnitId));
  }

  /**
   * Unités d'une preuve, dans l'ordre de lecture. Une cellule est désignée
   * par son adresse (`…:row:R:cell:C`) ; la couverture la ramène à sa ligne.
   */
  link(e: EvidenceRef): string[] {
    const out = new Set<string>();
    if (e.table) {
      const t = this.tables.get(e.table.index);
      if (t) {
        const id = cellUnitId(t, e.table.row, e.table.column);
        if (this.ids.has(unitOfCell(id))) out.add(id);
      }
    }
    if (e.provenance === 'VISUAL_ANALYSIS' || (!e.excerpt && e.visualDescription)) {
      for (const id of this.visual(e)) out.add(id);
    }
    if (e.excerpt && out.size === 0) for (const id of this.text(e.excerpt, e.page ?? null)) out.add(id);
    if (out.size === 0 && (e.values?.length ?? 0) > 0) for (const id of this.pair(e)) out.add(id);
    return [...out];
  }

  private text(excerpt: string, page: number | null): string[] {
    const ex = plat(excerpt);
    if (ex.length < 2) return [];
    const surPage = (l: Array<{ u: SourceUnit; p: string }>) => (page ? l.filter((x) => x.u.page === page || x.u.page === null) : l);
    // 1. L'extrait est dans une unité.
    // Le texte lu prime sur la métadonnée qui en est tirée.
    const contient = (l: Array<{ u: SourceUnit; p: string }>) => {
      const h = l.filter((x) => x.p.includes(ex));
      const lus = h.filter((x) => x.u.kind !== 'DOCUMENT_METADATA');
      return lus.length > 0 ? lus : h;
    };
    let hits = contient(surPage(this.textuelles));
    if (hits.length === 0 && page) hits = contient(this.textuelles);
    if (hits.length > 0) {
      // L'unité la plus précise (la plus courte), et ses ex æquo.
      const min = Math.min(...hits.map((h) => h.p.length));
      return hits.filter((h) => h.p.length === min).map((h) => h.u.sourceUnitId);
    }
    // 2. L'extrait s'étend sur plusieurs unités : celles qu'il contient.
    const incluses = (l: Array<{ u: SourceUnit; p: string }>) =>
      l.filter((x) => x.p.length >= MIN_INCLUSION && x.u.kind !== 'DOCUMENT_METADATA' && ex.includes(x.p));
    let parts = incluses(surPage(this.textuelles));
    if (parts.length === 0 && page) parts = incluses(this.textuelles);
    return parts.map((x) => x.u.sourceUnitId);
  }

  private visual(e: EvidenceRef): string[] {
    const d = plat(e.visualDescription ?? '');
    const page = e.visualPage ?? e.page ?? null;
    if (d) {
      const exact = this.visuelles.filter((x) => x.p && (x.p === d || x.p.includes(d) || d.includes(x.p)));
      if (exact.length > 0) return exact.map((x) => x.u.sourceUnitId);
    }
    if (page) {
      const memePage = this.visuelles.filter((x) => x.u.kind === 'VISUAL_OBSERVATION' && x.u.page === page);
      if (memePage.length === 1) return [memePage[0].u.sourceUnitId];
    }
    return [];
  }

  /**
   * Fait sans extrait : la valeur lue est dans la valeur d'un couple
   * libellé / valeur (un mot du libellé du fait dans son libellé, s'il y en
   * a un commun) ; à défaut, une valeur DISTINCTIVE (≥ 5 caractères) dans une
   * seule unité de texte.
   */
  private pair(e: EvidenceRef): string[] {
    const valeurs = (e.values ?? []).filter((v) => v !== null && v !== undefined && String(v).trim()).map((v) => plat(String(v)))
      .filter((v) => v.length >= 2);
    if (valeurs.length === 0) return [];
    const libelles = new Set((e.labels ?? []).flatMap((l) => (l ? mots(l) : [])).filter((w) => w.length >= 3));
    const couples = this.textuelles.filter((x) => x.u.kind === 'LABEL_VALUE' && x.u.value && valeurs.some((v) => plat(x.u.value!).includes(v)));
    const parLibelle = couples.filter((x) => mots(x.u.label ?? '').some((w) => libelles.has(w)));
    if (parLibelle.length > 0) return parLibelle.map((x) => x.u.sourceUnitId);
    const distinctives = valeurs.filter((v) => v.length >= 5);
    if (distinctives.length === 0) return libelles.size === 0 ? couples.map((x) => x.u.sourceUnitId) : [];
    const hits = this.textuelles.filter((x) => x.u.kind !== 'DOCUMENT_METADATA' && distinctives.some((v) => x.p.includes(v)));
    return hits.length === 1 ? [hits[0].u.sourceUnitId] : couples.length === 1 ? [couples[0].u.sourceUnitId] : [];
  }
}

/** Lien d'un fait (pour la couverture) : ses unités et sa confiance. */
export interface FactLink {
  unitIds: string[];
  confidence: 'certain' | 'probable' | 'conflictual';
}

export interface CoverageInput {
  facts: FactLink[];
  /** Unités représentées par une métadonnée structurée (titre, date, émetteur…). */
  metadataUnitIds?: Iterable<string>;
  /** Unités représentées par une entité (signal d'un bien, d'un équipement…). */
  entityUnitIds?: Iterable<string>;
  /** Unités d'un fait écarté non retrouvé (`document_unresolved_facts`). */
  droppedUnitIds?: Iterable<string>;
  /** Unités en échec d'analyse, et si une nouvelle tentative est permise. */
  failed?: ReadonlyMap<string, { reason: string; retryable: boolean }>;
  repairAttempts?: ReadonlyMap<string, number>;
}

/** États de couverture de chaque unité. */
export function computeCoverage(units: readonly SourceUnit[], c: CoverageInput): CoveredSourceUnit[] {
  const parUnite = new Map<string, Array<FactLink['confidence']>>();
  for (const f of c.facts) {
    for (const id of new Set(f.unitIds.map(unitOfCell))) {
      const l = parUnite.get(id) ?? [];
      l.push(f.confidence);
      parUnite.set(id, l);
    }
  }
  const meta = new Set(c.metadataUnitIds ?? []);
  const entites = new Set(c.entityUnitIds ?? []);
  const ecartes = new Set([...(c.droppedUnitIds ?? [])].map(unitOfCell));
  const tableIncertaine = new Map<string, boolean>();
  for (const u of units) if (u.kind === 'TABLE') tableIncertaine.set(u.sourceUnitId, u.payload.uncertain === true);

  return units.map((u) => {
    const confs = parUnite.get(u.sourceUnitId) ?? [];
    const cov = (status: CoverageStatus, reason: string | null): UnitCoverage => ({ status, reason, factCount: confs.length });
    const echec = c.failed?.get(u.sourceUnitId);
    let r: UnitCoverage;
    if (u.kind === 'PAGE_GAP') r = cov('FAILED', String(u.payload.message ?? 'pages non analysées'));
    else if (echec) r = cov('FAILED', echec.reason);
    else if (u.kind === 'DOCUMENT_METADATA') r = cov('COVERED', 'metadata');
    else if (u.kind === 'TABLE') {
      r = u.payload.uncertain === true ? cov('UNCERTAIN', 'table_uncertain')
        : Number(u.payload.rowCount ?? 0) === 0 && !u.text ? cov('NON_INFORMATIONAL', 'empty_table') : cov('COVERED', 'table');
    } else if (u.kind === 'TABLE_ROW') {
      r = !u.salient ? cov('NON_INFORMATIONAL', 'empty_row')
        : tableIncertaine.get(u.parentUnitId ?? '') ? cov('UNCERTAIN', 'table_uncertain') : cov('COVERED', 'table');
    } else if (u.kind === 'VISUAL_OBSERVATION') {
      r = u.payload.confidence === 'conflictual' ? cov('UNCERTAIN', 'observation_conflictual') : cov('COVERED', 'observation');
    } else if (u.kind === 'VISUAL_SUMMARY') r = cov('COVERED', 'observation');
    else if (confs.length > 0) {
      r = confs.every((x) => x === 'conflictual') ? cov('UNCERTAIN', 'fact_conflictual') : cov('COVERED', 'fact');
    } else if (isNonInformational(u.text)) r = cov('NON_INFORMATIONAL', 'pagination_or_decoration');
    else if (meta.has(u.sourceUnitId)) r = cov('COVERED', 'metadata');
    else if (entites.has(u.sourceUnitId)) r = cov('COVERED', 'entity');
    else if (ecartes.has(u.sourceUnitId)) r = cov('UNRESOLVED', 'fact_dropped');
    else r = cov('UNRESOLVED', u.salient ? 'not_extracted' : 'not_structured');
    return { ...u, ...r, repairAttempts: c.repairAttempts?.get(u.sourceUnitId) ?? 0 };
  });
}

/** Types d'unités qu'une réparation ciblée peut relire (texte disponible). */
const REPARABLES = new Set(['TEXT_BLOCK', 'LABEL_VALUE', 'FORM_FIELD']);

/**
 * Unités à soumettre à la réparation ciblée : non couvertes ET porteuses
 * d'une valeur structurable (ou liées à un fait écarté), ou en échec avec du
 * texte. Jamais une unité déjà réparée `maxAttempts` fois ; jamais le
 * document entier.
 */
export function selectRepairUnits(units: readonly CoveredSourceUnit[], maxAttempts: number): CoveredSourceUnit[] {
  return units.filter((u) => REPARABLES.has(u.kind) && u.text && u.repairAttempts < maxAttempts && (
    (u.status === 'UNRESOLVED' && (u.salient || u.reason === 'fact_dropped'))
    || (u.status === 'FAILED' && u.reason?.startsWith('repair_failed'))
  ));
}

export interface ReportInput {
  factsCount: number;
  unresolvedFacts: readonly UnresolvedFactRecord[];
  truncatedSectionsCount: number;
  batchedSectionsCount: number;
  repairPassCount: number;
  chunkCount: number;
  /** Codes d'avertissement de l'analyse. */
  warningCodes: readonly string[];
  /** Une nouvelle tentative automatique reste-t-elle permise (plafond de reprises) ? */
  retryAllowed: boolean;
}

/** Faits écartés à la 1re passe et non retrouvés (motifs de rejet d'un fait du modèle). */
export const DROP_REASONS = new Set(['INVALID_SCHEMA', 'VALUE_TOO_LONG', 'NO_EVIDENCE', 'FIELD_PRUNED']);

/** Rapport de complétude et état de qualité. La somme des états vaut le total (contrôlé). */
export function buildCompletenessReport(units: readonly CoveredSourceUnit[], p: ReportInput): T1CompletenessReport {
  const n = (s: CoverageStatus) => units.filter((u) => u.status === s).length;
  const covered = n('COVERED');
  const nonInfo = n('NON_INFORMATIONAL');
  const unresolved = n('UNRESOLVED');
  const uncertain = n('UNCERTAIN');
  const failed = n('FAILED');
  const total = units.length;
  if (covered + nonInfo + unresolved + uncertain + failed !== total) {
    throw new Error('[t1-completeness] unité sans état de couverture');
  }
  const dropped = p.unresolvedFacts.filter((f) => f.status === 'UNRESOLVED' && DROP_REASONS.has(f.reason)).length;
  const retryableFailures = units.filter((u) => u.status === 'FAILED').every((u) =>
    (u.kind === 'PAGE_GAP' ? u.payload.retryable === true : u.reason?.endsWith(':retryable') === true));

  let quality: T1QualityState;
  if (failed > 0 || p.truncatedSectionsCount > 0) {
    quality = p.truncatedSectionsCount === 0 && retryableFailures && p.retryAllowed ? 'INCOMPLETE_RETRYABLE' : 'INCOMPLETE_FINAL';
  } else if (unresolved > 0 || uncertain > 0 || dropped > 0) {
    quality = 'COMPLETE_WITH_UNRESOLVED';
  } else {
    quality = 'COMPLETE';
  }

  const anomalies = new Set<string>();
  if (p.truncatedSectionsCount > 0) anomalies.add('FACTS_TRUNCATED');
  if (p.warningCodes.includes('PARTIAL_EXTRACTION')) anomalies.add('PARTIAL_EXTRACTION');
  if (dropped > 0) anomalies.add('FACT_INVALID_DROPPED');
  if (failed > 0) anomalies.add('SOURCE_UNIT_FAILED');
  if (quality === 'INCOMPLETE_RETRYABLE' || quality === 'INCOMPLETE_FINAL') anomalies.add('COVERAGE_INCOMPLETE');

  return {
    totalSourceUnits: total,
    coveredUnits: covered,
    nonInformationalUnits: nonInfo,
    unresolvedUnits: unresolved,
    uncertainUnits: uncertain,
    failedUnits: failed,
    factsCount: p.factsCount,
    droppedFactsCount: dropped,
    truncatedSectionsCount: p.truncatedSectionsCount,
    batchedSectionsCount: p.batchedSectionsCount,
    coverageRatio: total === 0 ? 1 : Math.round(((covered + nonInfo) / total) * 10_000) / 10_000,
    repairPassCount: p.repairPassCount,
    chunkCount: p.chunkCount,
    qualityState: quality,
    anomalies: T1_COMPLETENESS_ANOMALIES.filter((a) => anomalies.has(a)),
  };
}
