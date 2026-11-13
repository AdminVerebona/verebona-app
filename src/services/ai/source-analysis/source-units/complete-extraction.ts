/**
 * Complétude T1 — orchestration (lot 34F) :
 *
 *   analyse (passe 1 + lots) → couche A (unités) → contrôle DÉTERMINISTE de
 *   couverture → si couverture complète : STOP ; sinon réparation ciblée des
 *   seules unités concernées (bornée) → fusion idempotente → nouveau contrôle
 *   → après projection : provenance fait → sourceUnitId[], requalifications
 *   tracées, rapport de complétude et état de qualité.
 *
 * Aucune deuxième passe systématique : un document dont chaque unité porteuse
 * d'une valeur est couverte ne déclenche aucun appel de plus.
 */
import { buildSourceUnits } from './build-units';
import {
  buildCompletenessReport, computeCoverage, DROP_REASONS, selectRepairUnits, SourceUnitLinker, withRepairStates,
  type EvidenceRef, type FactLink,
} from './coverage';
import { factFingerprint, mergeFacts } from './merge';
import { plat } from './text';
import { repairAttemptCap, repairSettings, runRepairPass, type RepairCall } from './repair';
import {
  SOURCE_LAYER_VERSION, UNRESOLVED_REASONS,
  type CoveredSourceUnit, type PageGap, type SourceLayer, type SourceUnit, type SourceUnitOrigin, type T1CoverageRepairDiagnostics, type TextSegment,
  type UnresolvedFactRecord, type UnresolvedReason,
} from './types';
import {
  reconcileCoverage, reconciliationSummary, residualCounts, withResidualPolicies,
  type ReconciliationDecision, type ReconciliationFact, type ReconciliationStage, type ReconciliationValue,
} from './coverage-reconciliation';
import { factContextOf, validateValueDecisions, type AnchoredValueDecision, type PreparedValueDecision } from '../value-decisions/validate';
import type { AnchoredOperationCandidate } from '../operation-candidates/prepare';
import { factLabel } from '../master/fact-evidence';
import type { ProjectedFact, T1Fact } from '../master/t1-contract';
import type { T1DroppedItem, T1PreservedOriginal } from '../master/tolerant-output';
import type { PrunedFieldValue } from '../../gateway/output-resolution/field-validation';
import type { SourceVerification } from './source-verification';
import type { ProjectionWarning } from '../projection/document-projection';
import type { AnalysisContext, AnalysisWarning, SourceInput } from '../types';
import type { AnalyzeDocumentResult } from '../steps/analyze-document.step';
import type { AccountCapabilities } from '@/services/account-capabilities.service';
import type { AssetFamily as V2AssetFamily } from '@/lib/referential/v2';

/** Matière de la couche A produite par l'étape d'analyse. */
export interface T1ExtractionExtras {
  segments: TextSegment[];
  gaps: PageGap[];
  dropped: Array<T1DroppedItem & { pass: SourceUnitOrigin }>;
  /** Faits lus sans preuve adaptée (écartés des faits, conservés ici). */
  noEvidence: T1Fact[];
  /** Champs retirés par la validation champ par champ de la passerelle (lot 33D) — chemins génériques. */
  prunedPaths: string[];
  /**
   * Lot 54G (point 3) : les mêmes retraits AVEC leur valeur originale, leur
   * élément englobant et leur motif (passe principale et lots de pages).
   */
  prunedFields?: Array<PrunedFieldValue & { pass: SourceUnitOrigin; pageOffset: number }>;
  batchedSections: number;
  truncatedSections: number;
  chunkCount: number;
  pageCount: number | null;
  /** Lot 49B (DEV-01) : couverture réelle de la source. Absente : non contrôlée (analyse simulée). */
  verification?: SourceVerification;
  /** Lot 49B (DEV-03) : originaux des valeurs réduites ou retirées par la lecture tolérante. */
  originals?: Array<T1PreservedOriginal & { pass: SourceUnitOrigin }>;
  /** Lot 49B (DEV-03) : réductions comptées par la lecture tolérante (contrôle de cohérence). */
  truncatedStrings?: number;
  capabilities: AccountCapabilities;
  v2Families: V2AssetFamily[];
}

interface SourceLayerDraft {
  units: SourceUnit[];
  linker: SourceUnitLinker;
  metadataUnitIds: Set<string>;
  entityUnitIds: Set<string>;
  /** Lot 111X : valeurs structurées hors faits (SIRET et coordonnées de l'émetteur lus par T1). */
  structuredValues: string[];
  failed: Map<string, { reason: string; retryable: boolean }>;
  attempts: Map<string, number>;
  unresolved: UnresolvedFactRecord[];
  repairPassCount: number;
  repairCalls: number;
  extras: T1ExtractionExtras;
  /** Lot 49B (DEV-04) : unités sélectionnées mais non soumises faute de budget (reprise programmée). */
  pending: Set<string>;
  /** Lot 49B : unités soumises à une réparation pendant l'analyse. */
  attempted: Set<string>;
  /** Lot 49B (DEV-02) : faits issus de la réparation ciblée (vérification des lignes de tableau). */
  repairFacts: Set<T1Fact>;
  /** Lot 49B (DEV-02) : faits conflictuels CONFIRMÉS par une relecture ciblée certaine (preuve suffisante). */
  confirmed: Set<T1Fact>;
  /** Lot 113AN : unités ciblées qui prouvent un fait de réparation (lien local, jamais recalculé). */
  repairLinks: Map<T1Fact, string[]>;
  /** Lot 113AN : unités ciblées où la réparation a RELU un fait déjà présent (même empreinte) — couvertes par lui. */
  extraLinks: Map<T1Fact, Set<string>>;
  /** Lot 113AN : décisions de valeur des passes de réparation (ancrées sur une unité ciblée). */
  repairDecisions: AnchoredValueDecision[];
  /** Lot 113AN : décisions VALIDES utilisables pour la couverture (contrat porté par le prompt effectif), sinon null. */
  usableDecisions: boolean;
  /** Lot 113AN : valeurs structurées hors faits (métadonnées) pour la réconciliation. */
  metadataValues: ReconciliationValue[];
  /** Lot 113AN : réparation ciblée de couverture de l'analyse (compteurs). */
  repairDiag: T1CoverageRepairDiagnostics;
  /** Candidats Opération ancrés (valeurs structurées pour la réconciliation). */
  candidates: readonly AnchoredOperationCandidate[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Preuve d'un fait (contrat T1 ou fait projeté). */
function evidenceOf(f: Pick<T1Fact, 'provenance' | 'evidence' | 'visualEvidence' | 'rawValue' | 'normalizedValue' | 'rawKey' | 'label' | 'attribute'>): EvidenceRef {
  return {
    provenance: f.provenance,
    excerpt: f.evidence?.excerpt ?? null,
    page: f.evidence?.page ?? null,
    table: f.evidence?.table ?? null,
    visualDescription: f.visualEvidence?.description ?? null,
    visualPage: f.visualEvidence?.page ?? null,
    values: [f.rawValue, f.normalizedValue],
    labels: [f.rawKey, f.label, f.attribute],
  };
}

/** Preuve d'un élément BRUT (non validé) écarté par la lecture tolérante. */
function evidenceOfRaw(payload: unknown): EvidenceRef {
  if (!isObj(payload)) return {};
  const e = isObj(payload.evidence) ? payload.evidence : {};
  const v = isObj(payload.visualEvidence) ? payload.visualEvidence : {};
  const t = isObj(e.table) ? e.table : null;
  return {
    provenance: payload.provenance === 'VISUAL_ANALYSIS' ? 'VISUAL_ANALYSIS' : 'TEXT_EXTRACTION',
    excerpt: typeof e.excerpt === 'string' ? e.excerpt : null,
    page: typeof e.page === 'number' ? e.page : null,
    table: t && typeof t.index === 'number' && typeof t.row === 'number' && typeof t.column === 'number'
      ? { index: t.index, row: t.row, column: t.column } : null,
    visualDescription: typeof v.description === 'string' ? v.description : typeof payload.description === 'string' ? payload.description : null,
    visualPage: typeof v.page === 'number' ? v.page : typeof payload.page === 'number' ? payload.page : null,
    values: [str(payload.rawValue), str(payload.normalizedValue)],
    labels: [str(payload.rawKey), str(payload.label), str(payload.attribute)],
  };
}

const asReason = (r: string): UnresolvedReason => ((UNRESOLVED_REASONS as readonly string[]).includes(r) ? r as UnresolvedReason : 'INVALID_SCHEMA');

function droppedRecord(d: T1DroppedItem & { pass: SourceUnitOrigin }, linker: SourceUnitLinker): UnresolvedFactRecord {
  const p = isObj(d.payload) ? d.payload : {};
  return {
    reason: asReason(d.reason),
    status: 'UNRESOLVED',
    sourceUnitIds: linker.link(evidenceOfRaw(d.payload)),
    rawKey: str(p.rawKey ?? p.label ?? p.title ?? p.subject ?? null),
    canonicalKey: typeof p.canonicalKey === 'string' ? p.canonicalKey : null,
    rawValue: str(p.rawValue ?? p.normalizedValue ?? p.description ?? null),
    originalPayload: d.payload ?? null,
    pass: d.pass,
    detail: d.path,
  };
}

/** Couche A et réparation ciblée, AVANT projection. `null` sans matière (analyse simulée). */
export async function completeT1Extraction(p: {
  input: SourceInput;
  groupIndices: number[];
  ctx: AnalysisContext;
  analysed: AnalyzeDocumentResult;
  /** Appel ANALYZE_DOCUMENT (injecté pour éviter un cycle d'import). */
  call: RepairCall;
  /** Vérification en base des cibles des faits de réparation. */
  verifyTargets?: (facts: T1Fact[]) => Promise<{ verifiedIds: AnalyzeDocumentResult['verifiedIds']; warnings: AnalysisWarning[] }>;
  env?: Record<string, string | undefined>;
  /**
   * Lot 113AN : le prompt T1 effectif porte-t-il le contrat des décisions de
   * valeur (même condition que leur persistance) ? Absent : décisions non
   * utilisées pour la couverture avant projection (prudence).
   */
  valueDecisionsUsable?: (promptVersion: string) => Promise<boolean>;
}): Promise<SourceLayerDraft | null> {
  const x = p.analysed.extraction;
  if (!x) return null;
  const a = p.analysed.analysis;
  const units = buildSourceUnits({
    segments: x.segments, tables: p.analysed.tables, visual: a.visual ?? null, document: a.document, gaps: x.gaps,
  });
  const linker = new SourceUnitLinker(units);
  const meta = new Set<string>();
  const d = a.document;
  for (const m of [d.title, d.description, d.documentDate, d.amountCents, d.classification, d.supplier]) {
    const ev = m?.evidence;
    if (ev?.excerpt) for (const id of linker.link({ excerpt: ev.excerpt, page: ev.page ?? null })) if (!id.startsWith('doc:')) meta.add(id);
  }
  if (d.supplier?.name) for (const id of linker.link({ excerpt: d.supplier.name })) if (!id.startsWith('doc:')) meta.add(id);
  const entites = new Set<string>();
  for (const c of [...a.entities.assets, ...a.entities.rooms, ...a.entities.equipments, ...a.entities.suppliers]) {
    for (const s of [...c.evidenceSignals, c.rawLabel ?? '']) {
      if (plat(s).length < 4) continue;
      for (const id of linker.link({ excerpt: s })) if (!id.startsWith('doc:')) entites.add(id);
    }
  }
  const unresolved: UnresolvedFactRecord[] = [
    ...x.dropped.map((dr) => droppedRecord(dr, linker)),
    ...x.noEvidence.map((f): UnresolvedFactRecord => ({
      reason: 'NO_EVIDENCE', status: 'UNRESOLVED', sourceUnitIds: linker.link({ ...evidenceOf(f), excerpt: null }),
      rawKey: f.rawKey ?? f.label ?? null, canonicalKey: f.canonicalKey, rawValue: str(f.rawValue ?? f.normalizedValue),
      originalPayload: f, pass: 'PASS_1', detail: f.provenance,
    })),
    // Lot 54G (point 3) : champ retiré par la validation de la passerelle — valeur ORIGINALE conservée.
    ...(x.prunedFields ?? []).map((pf) => prunedRecord(pf, linker)),
    // Retrait connu par son seul chemin (original indisponible) : perte NON compensée, signalée.
    ...prunedPathsWithoutOriginal(x).map((path): UnresolvedFactRecord => ({
      reason: 'FIELD_PRUNED', status: 'UNRESOLVED', sourceUnitIds: [], rawKey: null, canonicalKey: null, rawValue: null,
      originalPayload: { path, preserved: false }, pass: 'PASS_1', detail: path,
    })),
    // Lot 49B (DEV-03) : original intégral de chaque valeur réduite ou retirée par la lecture tolérante.
    ...(x.originals ?? []).map((o) => originalRecord(o, linker)),
  ];

  const draft: SourceLayerDraft = {
    units, linker, metadataUnitIds: meta, entityUnitIds: entites, failed: new Map(), attempts: new Map(),
    structuredValues: [d.supplier?.siret ?? null, ...Object.values(d.supplier?.contacts ?? {})].filter((v): v is string => typeof v === 'string' && !!v.trim()),
    unresolved, repairPassCount: 0, repairCalls: 0, extras: x,
    pending: new Set(), attempted: new Set(), repairFacts: new Set(), confirmed: new Set(),
    repairLinks: new Map(), extraLinks: new Map(), repairDecisions: [],
    usableDecisions: p.valueDecisionsUsable ? await p.valueDecisionsUsable(p.analysed.promptVersion).catch(() => false) : false,
    metadataValues: metadataValuesOf(d),
    repairDiag: { passes: 0, calls: 0, selected: 0, attempted: 0, resolved: 0, factsAdded: 0, factsConfirmed: 0, decisions: 0, skipped: null },
    candidates: p.analysed.operationCandidates ?? [],
  };

  // ── Réparation ciblée, bornée ──────────────────────────────────────────
  // Lot 113AN : la sélection part de la couverture RÉCONCILIÉE (décisions de valeur, tableaux, répétitions…) :
  // seules les vraies lacunes sont réparées ; le motif d'une réparation non exécutée est consigné.
  const { maxPasses, maxCalls, minUnits } = repairSettings(p.env);
  if (maxPasses === 0) draft.repairDiag.skipped = 'DISABLED';
  for (let pass = 1; pass <= maxPasses; pass++) {
    const cov = coverageOf(draft, a.facts, decisionsForCoverage(draft, p.analysed), 'ANALYSIS');
    const cibles = selectRepairUnits(cov, maxPasses);
    if (pass === 1) draft.repairDiag.selected = cibles.length;
    if (cibles.length === 0 || cibles.length < minUnits) {
      if (pass === 1) draft.repairDiag.skipped = cibles.length === 0 ? 'NO_TARGET' : 'BELOW_MIN_UNITS';
      break;
    }
    const r = await runRepairPass({
      input: p.input, groupIndices: p.groupIndices, ctx: p.ctx, capabilities: x.capabilities, v2Families: x.v2Families,
      units: cibles, maxCalls, pass, call: p.call,
    });
    draft.repairPassCount++;
    draft.repairCalls += r.calls;
    for (const id of r.attempted) {
      draft.attempts.set(id, (draft.attempts.get(id) ?? 0) + 1);
      draft.attempted.add(id);
      draft.pending.delete(id);
      const f = r.failed.get(id);
      if (f) draft.failed.set(id, f); else draft.failed.delete(id);
    }
    // Lot 49B (DEV-04) : unités hors budget de la passe — jamais « non interprétables » : reprise programmée.
    for (const id of r.notAttempted) if (!draft.attempted.has(id)) draft.pending.add(id);
    const ajoutes = mergeFacts(a.facts, r.facts);
    for (const f of ajoutes) {
      draft.repairFacts.add(f);
      const ids = r.links.get(f);
      if (ids?.length) draft.repairLinks.set(f, ids);
    }
    draft.repairDiag.factsAdded += ajoutes.length;
    // Relecture CERTAINE d'un fait déjà lu (même valeur, même preuve) : confirmation — l'incertitude d'un
    // fait conflictuel ou d'une cellule de tableau incertain est levée pour la couverture (jamais le fait).
    const parEmpreinte = new Map(a.facts.filter((f) => !ajoutes.includes(f)).map((f) => [factFingerprint(f), f]));
    // Lot 113AN : empreinte d'un fait de réparation identique à un fait existant → ce fait (décisions rattachées).
    const refsDoublons = new Map<string, string>();
    for (const f of r.facts) {
      if (ajoutes.includes(f)) continue;
      const existant = parEmpreinte.get(factFingerprint(f));
      if (!existant) continue;
      if (f.confidence === 'certain') draft.confirmed.add(existant);
      // La réparation a relu CE fait dans une unité ciblée : l'unité est couverte par lui (jamais un doublon de fait).
      const ids = r.links.get(f) ?? [];
      if (ids.length) {
        const s = draft.extraLinks.get(existant) ?? new Set<string>();
        for (const id of ids) s.add(id);
        draft.extraLinks.set(existant, s);
        draft.repairDiag.factsConfirmed++;
      }
      const ref = (f as T1Fact & { t1FactRef?: string }).t1FactRef;
      const refExistant = (existant as T1Fact & { t1FactRef?: string }).t1FactRef;
      if (ref && refExistant) refsDoublons.set(ref, refExistant);
    }
    for (const dec of r.decisions) {
      draft.repairDecisions.push({ ...dec, relatedFactRefs: [...new Set(dec.relatedFactRefs.map((x) => refsDoublons.get(x) ?? x))] });
    }
    draft.repairDiag.decisions += r.decisions.length;
    if (ajoutes.length > 0 && p.verifyTargets) {
      const v = await p.verifyTargets(ajoutes);
      for (const k of Object.keys(v.verifiedIds) as Array<keyof typeof v.verifiedIds>) {
        for (const id of v.verifiedIds[k]) p.analysed.verifiedIds[k].add(id);
      }
      p.analysed.warnings.push(...v.warnings);
    }
    draft.repairDiag.passes = draft.repairPassCount;
    draft.repairDiag.calls = draft.repairCalls;
    draft.repairDiag.attempted = draft.attempted.size;
    console.info(`[t1-repair] passe ${pass} : ${cibles.length} unité(s) ciblée(s), ${r.calls} appel(s), ${ajoutes.length} fait(s) ajouté(s), `
      + `${r.decisions.length} décision(s) de valeur, ${r.failed.size} en échec`);
    if (ajoutes.length === 0 && r.failed.size === 0) break;
  }
  // Lot 113AN : décisions de la réparation persistées avec celles de l'analyse (même validation, même écriture).
  if (draft.repairDecisions.length > 0) {
    p.analysed.valueDecisions = [...(p.analysed.valueDecisions ?? []), ...draft.repairDecisions];
  }
  return draft;
}

/** Valeurs des métadonnées du document (montant, date, SIRET) — réconciliation. */
function metadataValuesOf(d: AnalyzeDocumentResult['analysis']['document']): ReconciliationValue[] {
  const out: ReconciliationValue[] = [];
  if (d.amountCents) out.push({ ref: 'amount', source: 'METADATA', values: [d.amountCents.value / 100], page: d.amountCents.evidence?.page ?? null });
  if (d.documentDate) out.push({ ref: 'documentDate', source: 'METADATA', values: [d.documentDate.value], page: d.documentDate.evidence?.page ?? null });
  if (d.supplier?.siret) out.push({ ref: 'supplier', source: 'METADATA', values: [d.supplier.siret], page: d.supplier.evidence?.page ?? null });
  return out;
}

/** Valeurs structurées des candidats Opération (références métier, montants, dates). */
function candidateValuesOf(cands: readonly AnchoredOperationCandidate[]): ReconciliationValue[] {
  return cands.map((c) => ({
    ref: c.candidateKey, source: 'CANDIDATE' as const, page: null,
    values: [
      ...c.businessReferences.map((r) => r.value),
      ...c.financialHints.flatMap((h) => [h.amountMinor / 100, h.economicDate, h.periodStart, h.periodEnd]),
      ...Object.values(c.temporalHints ?? {}),
    ].filter((v) => v !== null && v !== undefined),
  }));
}

/**
 * Lot 113AN — décisions de valeur VALIDÉES (serveur) utilisables par la
 * couverture pendant l'analyse : passe principale, lots de pages et passes
 * de réparation. Contrat non porté : aucune (prudence, comme la persistance).
 */
function decisionsForCoverage(draft: SourceLayerDraft, analysed: AnalyzeDocumentResult): PreparedValueDecision[] {
  if (!draft.usableDecisions) return [];
  const toutes = [...(analysed.valueDecisions ?? []), ...draft.repairDecisions];
  if (toutes.length === 0) return [];
  const kept = (analysed.analysis.facts as Array<T1Fact & { t1FactRef?: string }>).filter((f) => f.t1FactRef);
  return validateValueDecisions(toutes, {
    units: draft.units,
    keptFactRefs: new Set(kept.map((f) => f.t1FactRef!)),
    candidateKeys: new Set(draft.candidates.map((c) => c.candidateKey)),
    facts: factContextOf(kept as never, draft.units),
  });
}

/** Unités d'un fait : lien local d'une réparation, sinon preuve retrouvée ; plus les unités où la réparation l'a relu. */
function unitsOfFact(draft: SourceLayerDraft, f: T1Fact): string[] {
  const base = draft.repairLinks.get(f) ?? draft.linker.link(evidenceOf(f));
  const extra = draft.extraLinks.get(f);
  return extra ? [...new Set([...base, ...extra])] : base;
}

function factLinks(draft: SourceLayerDraft, facts: readonly T1Fact[]): FactLink[] {
  return facts.map((f) => ({
    unitIds: unitsOfFact(draft, f),
    confidence: draft.confirmed.has(f) ? 'certain' as const : f.confidence,
    values: [f.rawValue, f.normalizedValue],
    ...(draft.repairFacts.has(f) || draft.confirmed.has(f) ? { repair: true } : {}),
  }));
}

/** Original d'une valeur réduite (RETAINED : la valeur réduite reste) ou retirée (UNRESOLVED) — lot 49B. */
function originalRecord(o: T1PreservedOriginal & { pass: SourceUnitOrigin }, linker: SourceUnitLinker): UnresolvedFactRecord {
  const texte = typeof o.original === 'string' ? o.original : null;
  const ids = o.hint?.excerpt ? linker.link({ excerpt: o.hint.excerpt, page: o.hint.page ?? null })
    : texte && texte.length >= 4 && texte.length <= 2_000 ? linker.link({ excerpt: texte }) : [];
  return {
    reason: o.kind === 'TRUNCATED' ? 'VALUE_TRUNCATED' : 'VALUE_NOT_NORMALIZABLE',
    status: o.kind === 'TRUNCATED' ? 'RETAINED' : 'UNRESOLVED',
    sourceUnitIds: ids,
    rawKey: o.path,
    canonicalKey: null,
    rawValue: texte ?? (o.original === null || o.original === undefined ? null : JSON.stringify(o.original)),
    originalPayload: { path: o.path, original: o.original, kept: o.kept ?? null },
    pass: o.pass,
    detail: o.kind === 'TRUNCATED' ? `valeur réduite par le contrat (${o.path})` : `valeur retirée par la normalisation (${o.path})`,
  };
}

/** Retraits du rapport `field_pruning` (chemins génériques) sans original transmis (lot 54G). */
function prunedPathsWithoutOriginal(x: Pick<T1ExtractionExtras, 'prunedPaths' | 'prunedFields'>): string[] {
  const avecOriginal = new Set((x.prunedFields ?? []).map((p) => p.genericPath));
  return x.prunedPaths.filter((path) => !avecOriginal.has(path));
}

/** Le retrait d'un champ a-t-il conservé sa valeur originale ? (lot 54G) */
function prunedOriginalPreserved(r: Pick<UnresolvedFactRecord, 'reason' | 'originalPayload'>): boolean {
  return r.reason === 'FIELD_PRUNED' && isObj(r.originalPayload) && r.originalPayload.preserved === true;
}

/**
 * Champ retiré par la validation de la passerelle (lot 54G, point 3) :
 * chemin, valeur originale intégrale, élément englobant (fait, observation,
 * tableau) et motif ; rattaché à l'unité source quand sa preuve le permet.
 */
function prunedRecord(pf: PrunedFieldValue & { pass: SourceUnitOrigin; pageOffset: number }, linker: SourceUnitLinker): UnresolvedFactRecord {
  const ev = evidenceOfRaw(pf.container?.value);
  const decale = (n: number | null | undefined) => (typeof n === 'number' ? n + pf.pageOffset : n ?? null);
  const ids = pf.container ? linker.link({ ...ev, page: decale(ev.page), visualPage: decale(ev.visualPage) }) : [];
  const v = pf.originalValue;
  return {
    reason: 'FIELD_PRUNED',
    status: 'UNRESOLVED',
    sourceUnitIds: ids,
    rawKey: pf.path.replace(/^\$\.?/, ''),
    canonicalKey: isObj(pf.container?.value) && typeof pf.container.value.canonicalKey === 'string' ? pf.container.value.canonicalKey : null,
    rawValue: v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v),
    originalPayload: {
      path: pf.path, genericPath: pf.genericPath, originalValue: v ?? null, container: pf.container, reason: pf.reason, rule: pf.rule,
      pageOffset: pf.pageOffset, preserved: true,
    },
    pass: pf.pass,
    detail: `champ retiré par la validation (${pf.reason})`.slice(0, 300),
  };
}

/**
 * Cohérence des réductions (DEV-03) : chaque réduction comptée doit avoir son
 * original conservé. Lot 54G (point 3) : un champ retiré par la validation
 * dont l'original est conservé n'est PLUS une perte ; seul un retrait connu
 * par son chemin seul (original indisponible) en est une.
 */
export function normalisationBalance(draft: Pick<SourceLayerDraft, 'unresolved' | 'extras'>): {
  truncations: number; originalsPreserved: number; losses: number; prunedFields: number; prunedOriginalsPreserved: number;
} {
  const truncations = draft.extras.truncatedStrings ?? 0;
  const originalsPreserved = draft.unresolved.filter((u) => u.reason === 'VALUE_TRUNCATED').length;
  const pruned = draft.unresolved.filter((u) => u.reason === 'FIELD_PRUNED');
  const conserves = pruned.filter(prunedOriginalPreserved).length;
  return {
    truncations, originalsPreserved,
    losses: Math.max(0, truncations - originalsPreserved) + (pruned.length - conserves),
    prunedFields: pruned.length, prunedOriginalsPreserved: conserves,
  };
}

function coverageOf(draft: SourceLayerDraft, facts: readonly T1Fact[], decisions: readonly PreparedValueDecision[], stage: ReconciliationStage,
  candidates: readonly AnchoredOperationCandidate[] = draft.candidates): CoveredSourceUnit[] {
  // Lot 113AN : réconciliation des unités NON RÉSOLUES avec ce qui est réellement structuré (provenance tracée).
  return reconcileCoverage(baseCoverageOf(draft, facts), {
    stage,
    facts: facts.map((f, i): ReconciliationFact => ({
      ref: (f as T1Fact & { t1FactRef?: string }).t1FactRef ?? `index:${i}`,
      unitIds: unitsOfFact(draft, f),
      values: [f.rawValue, f.normalizedValue],
      labels: [f.rawKey, f.label, f.attribute, f.canonicalKey],
      excerpt: f.evidence?.excerpt ?? null,
      page: f.evidence?.page ?? null,
    })),
    values: [...draft.metadataValues, ...candidateValuesOf(candidates)],
    decisions: decisions.filter((d) => d.validity === 'VALID' && d.sourceUnitId).map((d, i): ReconciliationDecision => ({
      ref: `${d.origin}:${i}`, sourceUnitId: d.sourceUnitId!, kind: d.kind, normalizedValue: d.normalizedValue, decision: d.decision,
    })),
  });
}

function baseCoverageOf(draft: SourceLayerDraft, facts: readonly T1Fact[]) {
  return computeCoverage(draft.units, {
    facts: factLinks(draft, facts),
    metadataUnitIds: draft.metadataUnitIds,
    entityUnitIds: draft.entityUnitIds,
    droppedUnitIds: draft.unresolved.filter((u) => u.status === 'UNRESOLVED' && DROP_REASONS.has(u.reason)).flatMap((u) => u.sourceUnitIds),
    // Lot 111X : coordonnées structurées par T1 et valeurs écartées AVEC MOTIF (faits non intégrés) — jamais une omission silencieuse.
    structuredValues: [...draft.structuredValues, ...draft.unresolved.map((u) => u.rawValue).filter((v): v is string => typeof v === 'string' && v.length <= 300)],
    failed: draft.failed,
    repairAttempts: draft.attempts,
  });
}

/** Avertissements de projection → motif de conservation d'un fait requalifié. */
const REQUALIFICATIONS: Readonly<Record<string, UnresolvedReason>> = {
  UNKNOWN_CANONICAL_KEY: 'UNKNOWN_CANONICAL_KEY',
  VALUE_NOT_NORMALIZABLE: 'VALUE_NOT_NORMALIZABLE',
  UNIT_MISMATCH: 'VALUE_NOT_NORMALIZABLE',
  KEY_NOT_APPLICABLE_TO_FAMILY: 'KEY_NOT_APPLICABLE',
  KEY_INPUT_ONLY: 'KEY_NOT_APPLICABLE',
  CANONICAL_KEY_TARGET_MISMATCH: 'KEY_NOT_APPLICABLE',
  TARGET_UNVERIFIED: 'UNKNOWN_TARGET',
};

/**
 * Après projection : provenance des faits projetés (`sourceUnitIds`, posé
 * EN PLACE), requalifications tracées, couverture finale, rapport, état de
 * qualité et avertissements fonctionnels.
 */
export function finalizeSourceLayer(draft: SourceLayerDraft, p: {
  analysisFacts: readonly T1Fact[];
  projected: ProjectedFact[];
  projectionWarnings: readonly ProjectionWarning[];
  warningCodes: readonly string[];
  retryAllowed?: boolean;
  /**
   * Lot 113AN : décisions de valeur VALIDÉES qui seront persistées (passe
   * principale, lots, réparation) et candidats retenus par la barrière —
   * réconciliation finale de la couverture.
   */
  valueDecisions?: readonly PreparedValueDecision[];
  candidates?: readonly AnchoredOperationCandidate[];
}): { layer: SourceLayer; warnings: AnalysisWarning[] } {
  for (const f of p.projected) {
    f.sourceUnitIds = draft.linker.link({
      provenance: f.provenance, excerpt: f.evidence?.excerpt ?? null, page: f.evidence?.page ?? null,
      table: f.evidence?.table ?? null, visualDescription: f.visualEvidence?.description ?? null,
      visualPage: f.visualEvidence?.page ?? null, values: [f.rawValue, f.value], labels: [f.rawKey, f.label, f.attribute],
    });
  }
  const reconciliee = coverageOf(draft, p.analysisFacts, p.valueDecisions ?? [], 'ANALYSIS', p.candidates ?? draft.candidates);
  // Lot 113AN : politique EXPLICITE de chaque unité restante (jamais une clôture silencieuse).
  const cov = withResidualPolicies(withRepairStates(reconciliee, {
    attempted: draft.attempted, pending: draft.pending, cap: repairAttemptCap(),
  }), { repairSkipped: draft.repairDiag.skipped === 'NO_TARGET' ? null : draft.repairDiag.skipped });
  draft.repairDiag.resolved = cov.filter((u) => draft.attempted.has(u.sourceUnitId) && (u.status === 'COVERED' || u.status === 'NON_INFORMATIONAL')).length;
  const couvertes = new Set(cov.filter((u) => u.status === 'COVERED' && u.reason === 'fact').map((u) => u.sourceUnitId));
  const records = draft.unresolved.map((r) => (
    r.status === 'UNRESOLVED' && DROP_REASONS.has(r.reason) && r.sourceUnitIds.length > 0
      && draft.repairPassCount > 0 && r.sourceUnitIds.every((id) => couvertes.has(id.replace(/:cell:\d+$/, '')))
      ? { ...r, status: 'RECOVERED' as const } : r
  ));
  // Requalifications : le fait existe (générique, cible neutralisée), mais pas tel qu'annoncé.
  const vus = new Set<string>();
  for (const w of p.projectionWarnings) {
    const reason = REQUALIFICATIONS[w.code];
    if (!reason || !w.target) continue;
    const concernes = p.analysisFacts.filter((f) => (w.code === 'TARGET_UNVERIFIED'
      ? factLabel(f) === w.target && f.target.entityId !== null
      : f.canonicalKey === w.target));
    for (const f of concernes) {
      const k = `${reason}:${p.analysisFacts.indexOf(f)}`;
      if (vus.has(k)) continue;
      vus.add(k);
      records.push({
        reason, status: 'RETAINED', sourceUnitIds: draft.linker.link(evidenceOf(f)),
        rawKey: f.rawKey ?? f.label ?? null, canonicalKey: f.canonicalKey, rawValue: str(f.rawValue ?? f.normalizedValue),
        originalPayload: f, pass: 'PASS_1', detail: w.message.slice(0, 300),
      });
    }
  }
  const report = buildCompletenessReport(cov, {
    factsCount: p.projected.length,
    unresolvedFacts: records,
    truncatedSectionsCount: draft.extras.truncatedSections,
    batchedSectionsCount: draft.extras.batchedSections,
    repairPassCount: draft.repairPassCount,
    chunkCount: draft.extras.chunkCount,
    warningCodes: p.warningCodes,
    retryAllowed: p.retryAllowed ?? true,
    verification: draft.extras.verification ?? null,
    normalisation: normalisationBalance(draft),
  });
  if (report.diagnostics) {
    report.diagnostics.coverageRepair = { ...draft.repairDiag };
    report.diagnostics.reconciliation = reconciliationSummary(cov, 'ANALYSIS');
    report.diagnostics.residualPolicies = residualCounts(cov);
  }
  const warnings: AnalysisWarning[] = [];
  if (report.failedUnits > 0) {
    warnings.push({
      code: 'SOURCE_UNIT_FAILED',
      message: `${report.failedUnits} unité(s) de la source non analysée(s) — contenu conservé, ${report.qualityState === 'INCOMPLETE_RETRYABLE' ? 'nouvelle tentative programmée' : 'reprise manuelle nécessaire'}.`,
      target: 't1-completeness:failed',
    });
  }
  if (report.qualityState === 'INCOMPLETE_RETRYABLE' || report.qualityState === 'INCOMPLETE_FINAL') {
    warnings.push({
      code: 'COVERAGE_INCOMPLETE',
      message: `Couverture de la source incomplète (${Math.round(report.coverageRatio * 100)} %, état ${report.qualityState}).`,
      target: 't1-completeness:incomplete',
    });
  }
  return {
    layer: {
      layerVersion: SOURCE_LAYER_VERSION,
      units: cov,
      unresolvedFacts: records,
      report,
      retryable: report.qualityState === 'INCOMPLETE_RETRYABLE',
    },
    warnings,
  };
}
