/**
 * Provenance fait → unité source : INVARIANT et qualification (lot 113AK,
 * carte Trello #736) — fonctions PURES.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INVARIANT DOCUMENTAIRE
 *
 * La provenance d'un fait ACTIF se vérifie avec le compte, le document et
 * l'identifiant d'unité ENSEMBLE : `(account_id, file_id, source_unit_id)`.
 * Un identifiant d'unité n'est qu'une ADRESSE dans un document
 * (`page:1:table:1:row:1:cell:2` existe dans presque tous les documents qui
 * ont un tableau) : le retrouver dans un AUTRE document n'est jamais une
 * correspondance. Une adresse de cellule (`…:row:R:cell:C`) est DÉRIVÉE de sa
 * ligne (la cellule elle-même est dans `document_table_cells`) : elle est
 * valide si la LIGNE existe dans le même document.
 *
 * Qualification d'une référence (aucun jugement de pertinence, aucune règle
 * par type de document) :
 *   VALID                   unité présente dans le même document ;
 *   VALID_CELL              cellule d'une ligne présente ;
 *   UNIT_MISSING            unité absente du document (seulement présente,
 *                           éventuellement, dans d'autres documents du compte —
 *                           `elsewhere`, information de diagnostic, jamais
 *                           utilisée comme correspondance) ;
 *   CONTRADICTION           unité présente, mais l'extrait cité par le fait
 *                           n'y figure pas et figure dans une autre unité du
 *                           même document (constat, jamais réécrit d'office).
 * Qualification d'un fait :
 *   HISTORICAL              fait supersédé : ses références visent la lecture
 *                           d'avant, c'est un historique légitime ;
 *   OUT_OF_SCOPE            document supprimé (corbeille) : faits non
 *                           exploités, hors contrôle ;
 *   SOURCE_UNLINKED         document dans un autre compte que le fait ;
 *   SUPERSEDED_VERSION      fait actif d'une extraction qui n'est plus celle
 *                           du document ;
 *   LAYER_PENDING           aucune unité, couche A jamais écrite : la reprise
 *                           historique (`t1-source-units-backfill`) la
 *                           construira et rétablira la provenance ;
 *   BROKEN                  au moins une référence invalide — RÉPARABLE si la
 *                           provenance se retrouve depuis l'extrait, la cellule
 *                           ou l'observation CONSERVÉS du fait dans les unités
 *                           du MÊME document (`relinkFromStored`), sinon
 *                           « provenance non reconstituable » ;
 *   NOT_RECONSTRUCTIBLE     déjà qualifié (références invalides retirées,
 *                           valeur conservée) : écart subsistant, avec motif ;
 *   VALID                   tout est valide.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { SourceUnitLinker, type EvidenceRef } from './coverage';
import { unitOfCell } from './build-units';
import { plat } from './text';
import type { SourceUnit } from './types';

export type UnitRefStatus = 'VALID' | 'VALID_CELL' | 'UNIT_MISSING' | 'CONTRADICTION';

/** Une référence est-elle une adresse de cellule ? */
const estCellule = (ref: string) => /:row:\d+:cell:\d+$/.test(ref);

/** Statut d'une référence contre les unités du MÊME document (pure). */
export function resolveUnitRef(ref: string, unitIds: ReadonlySet<string>): 'VALID' | 'VALID_CELL' | 'UNIT_MISSING' {
  if (unitIds.has(ref)) return 'VALID';
  if (estCellule(ref) && unitIds.has(unitOfCell(ref))) return 'VALID_CELL';
  return 'UNIT_MISSING';
}

/** Références valides et invalides d'un fait (ordre conservé, doublons retirés). */
export function partitionUnitRefs(refs: readonly string[] | null | undefined, unitIds: ReadonlySet<string>): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const r of new Set((refs ?? []).filter((x) => typeof x === 'string' && x.length > 0))) {
    (resolveUnitRef(r, unitIds) === 'UNIT_MISSING' ? invalid : valid).push(r);
  }
  return { valid, invalid };
}

/** Unité stockée, telle que la qualification la lit (contenu persisté). */
export interface StoredUnitView {
  sourceUnitId: string;
  kind: string;
  page: number | null;
  ordinal: number;
  text: string | null;
  label?: string | null;
  value?: string | null;
  payload?: Record<string, unknown> | null;
}

/** Fait stocké, tel que la qualification le lit. */
export interface StoredFactView {
  id: number;
  accountId: number;
  fileId: number;
  extractionId: number | null;
  status: string;
  sourceUnitIds: string[] | null;
  excerpt: string | null;
  location: Record<string, unknown> | null;
  evidenceOrigin: string | null;
  visualEvidence: { description?: string | null; page?: number | null } | null;
  provenanceStatus?: string | null;
}

/** Contexte du document du fait. */
export interface FactDocumentContext {
  /** Le document existe (ligne `asset_files`). */
  exists: boolean;
  accountId: number | null;
  deleted: boolean;
  /** Extraction courante du document (null : aucune). */
  currentExtractionId: number | null;
  /** Ligne de couverture présente (couche A déjà écrite au moins une fois). */
  hasCoverage: boolean;
}

export type FactProvenanceState =
  | 'VALID' | 'HISTORICAL' | 'OUT_OF_SCOPE' | 'SOURCE_UNLINKED' | 'SUPERSEDED_VERSION' | 'LAYER_PENDING' | 'BROKEN' | 'NOT_RECONSTRUCTIBLE';

export interface RefQualification {
  ref: string;
  status: UnitRefStatus;
  /** L'identifiant existe dans d'AUTRES documents du compte (jamais une correspondance). */
  elsewhere: boolean;
}

export interface FactQualification {
  factId: number;
  fileId: number;
  accountId: number;
  state: FactProvenanceState;
  refs: RefQualification[];
  /** Provenance rétablie depuis les données conservées du même document (BROKEN réparable), sinon null. */
  relinked: string[] | null;
  /** Références valides conservées (sous-ensemble de `refs`). */
  kept: string[];
  /** Motif lisible (stable) de l'état. */
  cause: string;
  /** `provenance_status` du fait avant correction (journal, restauration). */
  previousStatus: string | null;
}

/** Conversion d'une unité stockée vers la forme du rattacheur (pure). */
function versSourceUnit(u: StoredUnitView): SourceUnit {
  return {
    sourceUnitId: u.sourceUnitId, kind: u.kind as SourceUnit['kind'], page: u.page, ordinal: u.ordinal, parentUnitId: null,
    text: u.text, label: u.label ?? null, value: u.value ?? null, payload: (u.payload ?? {}) as Record<string, unknown>, location: {},
    origin: 'PASS_1', salient: false,
  } as SourceUnit;
}

/**
 * Preuve CONSERVÉE d'un fait (extrait, cellule, observation visuelle, page) —
 * jamais sa seule valeur : un rattachement par valeur nue n'est pas une
 * preuve authentique de provenance (même total dans deux lignes).
 */
export function storedEvidenceOf(f: Pick<StoredFactView, 'excerpt' | 'location' | 'evidenceOrigin' | 'visualEvidence'>): EvidenceRef {
  const loc = f.location ?? {};
  const t = (loc.table ?? null) as { tableIndex?: number; row?: number; column?: number } | null;
  return {
    provenance: f.evidenceOrigin === 'VISUAL_ANALYSIS' ? 'VISUAL_ANALYSIS' : 'TEXT_EXTRACTION',
    excerpt: f.excerpt,
    page: typeof loc.page === 'number' ? loc.page : null,
    table: t && typeof t.tableIndex === 'number' && typeof t.row === 'number' && typeof t.column === 'number'
      ? { index: t.tableIndex, row: t.row, column: t.column } : null,
    visualDescription: f.visualEvidence?.description ?? null,
    visualPage: f.visualEvidence?.page ?? null,
  };
}

/** Provenance retrouvée depuis la preuve conservée du fait, dans les unités du MÊME document (pure). */
export function relinkFromStored(f: Pick<StoredFactView, 'excerpt' | 'location' | 'evidenceOrigin' | 'visualEvidence'>, units: readonly StoredUnitView[]): string[] {
  if (units.length === 0) return [];
  return new SourceUnitLinker(units.map(versSourceUnit)).link(storedEvidenceOf(f));
}

/** Texte comparable d'une unité (contenu, libellé, valeur, cellules d'une ligne). */
function texteUnite(u: StoredUnitView): string {
  const cells = Array.isArray(u.payload?.cells) ? (u.payload!.cells as Array<{ value?: unknown }>).map((c) => String(c?.value ?? '')).join(' ') : '';
  return plat([u.text ?? '', u.label ?? '', u.value ?? '', cells].join(' '));
}

/** Extrait cité, en forme de comparaison (marques `[page:…]` retirées). */
const extraitPlat = (excerpt: string | null) => (excerpt ? plat(excerpt.replace(/\[(?:page|doc):[^\]]+\]\s*/g, '')) : '');
/** Longueur minimale d'un extrait pour constater une contradiction (prudence : jamais sur un mot isolé). */
const CONTRADICTION_MIN = 8;

/**
 * Qualification d'un fait (pure, déterministe). `elsewhere(ref)` dit si
 * l'identifiant existe dans un AUTRE document du compte — information de
 * diagnostic uniquement.
 */
export function qualifyFact(
  f: StoredFactView,
  doc: FactDocumentContext,
  units: readonly StoredUnitView[],
  elsewhere: (ref: string) => boolean = () => false,
): FactQualification {
  const base = { factId: f.id, fileId: f.fileId, accountId: f.accountId, previousStatus: f.provenanceStatus ?? null };
  const refsBrutes = [...new Set((f.sourceUnitIds ?? []).filter(Boolean))];
  const ids = new Set(units.map((u) => u.sourceUnitId));
  const refs: RefQualification[] = refsBrutes.map((ref) => {
    const st = resolveUnitRef(ref, ids);
    return { ref, status: st, elsewhere: st === 'UNIT_MISSING' ? elsewhere(ref) : false };
  });
  const rendre = (state: FactProvenanceState, cause: string, extra: Partial<FactQualification> = {}): FactQualification => ({
    ...base, state, refs, relinked: null, kept: refs.filter((r) => r.status !== 'UNIT_MISSING').map((r) => r.ref), cause, ...extra,
  });
  if (f.status !== 'active') return rendre('HISTORICAL', 'FACT_SUPERSEDED');
  if (!doc.exists) return rendre('OUT_OF_SCOPE', 'DOCUMENT_ABSENT');
  if (doc.deleted) return rendre('OUT_OF_SCOPE', 'DOCUMENT_DELETED');
  if (doc.accountId !== null && doc.accountId !== f.accountId) return rendre('SOURCE_UNLINKED', 'DOCUMENT_IN_OTHER_ACCOUNT');
  if (doc.currentExtractionId !== null && f.extractionId !== null && f.extractionId !== doc.currentExtractionId) {
    return rendre('SUPERSEDED_VERSION', 'FACT_OF_REPLACED_EXTRACTION');
  }
  if (refsBrutes.length === 0) {
    return f.provenanceStatus === 'NOT_RECONSTRUCTIBLE' ? rendre('NOT_RECONSTRUCTIBLE', 'PROVENANCE_NOT_RECONSTRUCTIBLE') : rendre('VALID', 'NO_REFERENCE');
  }
  if (units.length === 0) return rendre(doc.hasCoverage ? 'BROKEN' : 'LAYER_PENDING', doc.hasCoverage ? 'SOURCE_LAYER_EMPTY' : 'SOURCE_LAYER_NOT_BUILT');
  // Contradiction : unité présente qui ne contient pas l'extrait, retrouvé ailleurs dans le document.
  const ex = extraitPlat(f.excerpt);
  if (ex.length >= CONTRADICTION_MIN && f.evidenceOrigin !== 'VISUAL_ANALYSIS') {
    const parId = new Map(units.map((u) => [u.sourceUnitId, u]));
    const presentes = refs.filter((r) => r.status !== 'UNIT_MISSING');
    const contiennent = presentes.some((r) => {
      const u = parId.get(r.status === 'VALID_CELL' ? unitOfCell(r.ref) : r.ref);
      const t = u ? texteUnite(u) : '';
      return t.includes(ex) || (t.length >= CONTRADICTION_MIN && ex.includes(t));
    });
    const ailleurs = units.some((u) => !presentes.some((r) => (r.status === 'VALID_CELL' ? unitOfCell(r.ref) : r.ref) === u.sourceUnitId) && texteUnite(u).includes(ex));
    if (presentes.length > 0 && !contiennent && ailleurs) {
      for (const r of presentes) r.status = 'CONTRADICTION';
    }
  }
  const invalides = refs.filter((r) => r.status === 'UNIT_MISSING');
  const contradictoires = refs.filter((r) => r.status === 'CONTRADICTION');
  if (invalides.length === 0 && contradictoires.length === 0) return rendre('VALID', 'ALL_REFERENCES_RESOLVED');
  if (invalides.length === 0) {
    // Contradiction seule : constat (une référence résolue n'est jamais réécrite d'office).
    return { ...rendre('BROKEN', 'UNIT_DOES_NOT_CONTAIN_EXCERPT'), kept: contradictoires.map((r) => r.ref), relinked: null };
  }
  const relie = relinkFromStored(f, units);
  const kept = refs.filter((r) => r.status !== 'UNIT_MISSING').map((r) => r.ref);
  if (relie.length > 0) {
    return { ...rendre('BROKEN', invalides.some((r) => r.elsewhere) ? 'UNIT_MISSING_ID_IN_OTHER_DOCUMENT' : 'UNIT_MISSING'), kept, relinked: [...new Set([...kept, ...relie])] };
  }
  return { ...rendre('BROKEN', invalides.some((r) => r.elsewhere) ? 'UNIT_MISSING_ID_IN_OTHER_DOCUMENT' : 'UNIT_MISSING'), kept, relinked: null };
}

/** Correction d'un fait BROKEN (pure) : provenance rétablie, ou « non reconstituable » (références invalides retirées). */
export function factCorrection(q: FactQualification): { sourceUnitIds: string[] | null; provenanceStatus: 'RELINKED' | 'NOT_RECONSTRUCTIBLE'; eventStatus: 'RELINKED' | 'NOT_RECONSTRUCTIBLE' } | null {
  if (q.state !== 'BROKEN' || !q.refs.some((r) => r.status === 'UNIT_MISSING')) return null;
  if (q.relinked && q.relinked.length > 0) return { sourceUnitIds: q.relinked, provenanceStatus: 'RELINKED', eventStatus: 'RELINKED' };
  return { sourceUnitIds: q.kept.length > 0 ? q.kept : null, provenanceStatus: 'NOT_RECONSTRUCTIBLE', eventStatus: 'NOT_RECONSTRUCTIBLE' };
}

// ── Preuves par champ (field_evidence) ──────────────────────────────────────

export type EvidenceOrphanStatus =
  | 'VALID' | 'HISTORICAL_ARCHIVED'
  | 'ASSET_DELETED' | 'ASSET_TRANSFERRED' | 'DOCUMENT_DELETED' | 'DOCUMENT_PURGED' | 'DOCUMENT_TRANSFERRED' | 'DOCUMENT_MERGED' | 'SOURCE_UNLINKED';

/** Ce que la qualification d'une preuve ACTIVE lit (une ligne par preuve). */
export interface EvidenceView {
  id: number;
  accountId: number;
  assetId: number;
  sourceId: number;
  /** Bien : absent (null), son compte, supprimé, statut. */
  asset: { accountId: number | null; deleted: boolean; status: string | null } | null;
  /** Document source : absent (null : purgé), son compte, supprimé, fusionné. */
  document: { accountId: number | null; deleted: boolean; merged: boolean; linkedToAsset: boolean | null } | null;
}

const ARCHIVES = new Set(['ARCHIVED', 'VENDU', 'TRANSMIS']);

/**
 * Qualification d'une preuve ACTIVE (pure). Les biens archivés, vendus ou
 * transmis restent dans le compte : leurs preuves sont un historique
 * légitime (jamais retirées). `linkedToAsset === false` n'est rendu que
 * lorsque la relation document ↔ bien est connue et ne vise plus ce bien.
 */
export function qualifyEvidence(e: EvidenceView): { status: EvidenceOrphanStatus; withdraw: boolean } {
  if (!e.asset) return { status: 'ASSET_DELETED', withdraw: true };
  if (e.asset.accountId !== null && e.asset.accountId !== e.accountId) return { status: 'ASSET_TRANSFERRED', withdraw: true };
  if (e.asset.deleted) return { status: 'ASSET_DELETED', withdraw: true };
  if (!e.document) return { status: 'DOCUMENT_PURGED', withdraw: true };
  if (e.document.accountId !== null && e.document.accountId !== e.accountId) return { status: 'DOCUMENT_TRANSFERRED', withdraw: true };
  if (e.document.deleted) return { status: e.document.merged ? 'DOCUMENT_MERGED' : 'DOCUMENT_DELETED', withdraw: true };
  if (e.document.linkedToAsset === false) return { status: 'SOURCE_UNLINKED', withdraw: true };
  if (e.asset.status && ARCHIVES.has(e.asset.status)) return { status: 'HISTORICAL_ARCHIVED', withdraw: false };
  return { status: 'VALID', withdraw: false };
}
