/**
 * « Mes documents » et onglet Documents d'un bien — logique d'affichage.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DIRECTION 1a « FLUX CONTINU » (maquette « Mes documents », 2026-09)
 *
 * « Les rubriques sont des titres de section dans un seul flux, jamais des
 * boîtes. Désactiver le regroupement retire les titres, rien d'autre ne
 * bouge. »
 *
 * Conséquence directe : le tri est GLOBAL. Il ordonne la liste entière ; le
 * regroupement ne fait que découper cette liste déjà triée en sections. Un
 * document garde donc sa position relative, avec ou sans titres.
 *
 * Tout ce qui décide de ce que l'on voit (filtrer, trier, regrouper, compter)
 * vit ici, en fonctions pures, pour être testé sans monter l'écran.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { MICROCOPY } from '@/lib/referential/v2/microcopy';
import { UNFILED_COLORS, rubricColors } from '@/lib/referential/v2/rubrics';

/** Identifiant de la zone « Sans rubrique » — le même que côté serveur. */
export const UNFILED = '__UNFILED__';
/** Documents rattachés à aucun bien (filtre Bien). */
export const NO_ASSET = '__NO_ASSET__';
/** Documents sans Type (filtre Type) — affichés « Type à compléter ». */
export const NO_TYPE = '__NO_TYPE__';

export type ViewMode = 'list' | 'grid';
export type SortKey = 'added' | 'docDate' | 'title' | 'bien' | 'rubric';
export type SortDir = 'asc' | 'desc';
export type DocumentsContext = 'mes-documents' | 'fiche-bien';

/** Document tel que reçu de `GET /api/v2/documents`. */
export interface DocumentItem {
  id: number;
  publicId: string;
  title: string;
  originalFilename: string | null;
  assetId: number | null;
  rubricCode: string | null;
  documentTypeCode: string | null;
  documentTypeLabel: string | null;
  /** `YYYY-MM-DD` */
  documentDate: string | null;
  /** ISO 8601 */
  uploadedAt?: string | null;
  mimeType: string | null;
  assetNames: string[];
}

/** Rubrique visible dans le périmètre, dans l'ordre du référentiel. */
export interface RubricRef {
  code: string;
  label: string;
}

export interface ViewFilters {
  biens: string[];
  rubrics: string[];
  types: string[];
}

export const EMPTY_FILTERS: ViewFilters = { biens: [], rubrics: [], types: [] };

/** Options de tri, dans l'ordre de la maquette. */
export const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: 'added', label: "Date d'ajout" },
  { value: 'docDate', label: 'Date du document' },
  { value: 'title', label: 'Nom' },
  { value: 'bien', label: 'Bien' },
  { value: 'rubric', label: 'Rubrique' },
];

/**
 * Options de tri proposées.
 *
 * Regroupé, trier par Rubrique ne dirait rien de plus que les titres : l'option
 * disparaît. Dans l'onglet d'un bien, tous les documents ont le même bien :
 * trier par bien n'aurait aucun effet.
 */
export function sortOptionsFor(grouped: boolean, context: DocumentsContext) {
  return SORT_OPTIONS.filter(
    (o) => !(grouped && o.value === 'rubric') && !(context === 'fiche-bien' && o.value === 'bien'),
  );
}

/**
 * Tri réellement appliqué : une préférence « Rubrique » (ou « Bien » dans
 * l'onglet d'un bien) retombe sur la date d'ajout quand elle n'a pas de sens.
 * La préférence elle-même est conservée : réactiver « Tous les documents »
 * la retrouve.
 */
export function effectiveSort(sort: SortKey, grouped: boolean, context: DocumentsContext): SortKey {
  return sortOptionsFor(grouped, context).some((o) => o.value === sort) ? sort : 'added';
}

/** Sens naturel d'un critère : alphabétique croissant, dates les plus récentes d'abord. */
export function defaultDirection(sort: SortKey): SortDir {
  return sort === 'added' || sort === 'docDate' ? 'desc' : 'asc';
}

export const rubricKey = (d: DocumentItem): string => d.rubricCode ?? UNFILED;
export const bienKey = (d: DocumentItem): string => (d.assetId ? String(d.assetId) : NO_ASSET);
export const typeKey = (d: DocumentItem): string => d.documentTypeCode ?? NO_TYPE;
export const typeLabel = (d: DocumentItem): string => d.documentTypeLabel ?? MICROCOPY.missingType;
export const bienLabel = (d: DocumentItem): string | null => d.assetNames[0] ?? null;
export const isToClassify = (d: DocumentItem): boolean => !d.rubricCode;

// ── Filtrer ──────────────────────────────────────────────────────────────

export function hasActiveFilters(f: ViewFilters): boolean {
  return f.biens.length + f.rubrics.length + f.types.length > 0;
}

export function activeFilterCount(f: ViewFilters): number {
  return f.biens.length + f.rubrics.length + f.types.length;
}

/** Filtres combinés : ET entre dimensions, OU à l'intérieur d'une dimension. */
export function filterDocuments(docs: readonly DocumentItem[], f: ViewFilters): DocumentItem[] {
  return docs.filter(
    (d) =>
      (f.biens.length === 0 || f.biens.includes(bienKey(d)))
      && (f.rubrics.length === 0 || f.rubrics.includes(rubricKey(d)))
      && (f.types.length === 0 || f.types.includes(typeKey(d))),
  );
}

export function toggleFilter(f: ViewFilters, dim: keyof ViewFilters, value: string): ViewFilters {
  const list = f[dim];
  return { ...f, [dim]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] };
}

export interface FilterOption {
  value: string;
  label: string;
  count: number;
  active: boolean;
}

/**
 * Options de filtre, comptées sur le périmètre (pas sur le résultat filtré) :
 * le compteur dit ce que l'on obtiendrait en cochant la seule option. Une
 * option à 0 n'est pas proposée — sauf si elle est déjà active, pour pouvoir
 * la retirer.
 */
export function buildFilterOptions(
  scope: readonly DocumentItem[],
  f: ViewFilters,
  rubrics: readonly RubricRef[],
): { biens: FilterOption[]; rubrics: FilterOption[]; types: FilterOption[] } {
  const compter = (key: (d: DocumentItem) => string) => {
    const m = new Map<string, number>();
    for (const d of scope) m.set(key(d), (m.get(key(d)) ?? 0) + 1);
    return m;
  };
  const garder = (o: FilterOption) => o.count > 0 || o.active;

  const parBien = compter(bienKey);
  const nomsBiens = new Map<string, string>();
  for (const d of scope) if (d.assetId && bienLabel(d)) nomsBiens.set(bienKey(d), bienLabel(d)!);
  const biens: FilterOption[] = [...nomsBiens.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'fr', { sensitivity: 'base' }))
    .map(([value, label]) => ({ value, label, count: parBien.get(value) ?? 0, active: f.biens.includes(value) }));
  if ((parBien.get(NO_ASSET) ?? 0) > 0 || f.biens.includes(NO_ASSET)) {
    biens.push({ value: NO_ASSET, label: 'Sans bien', count: parBien.get(NO_ASSET) ?? 0, active: f.biens.includes(NO_ASSET) });
  }

  const parRubrique = compter(rubricKey);
  const rubricOptions: FilterOption[] = [
    { value: UNFILED, label: MICROCOPY.unfiledZone },
    ...rubrics.map((r) => ({ value: r.code, label: r.label })),
  ].map((o) => ({ ...o, count: parRubrique.get(o.value) ?? 0, active: f.rubrics.includes(o.value) }))
    .filter(garder);

  const parType = compter(typeKey);
  const nomsTypes = new Map<string, string>();
  for (const d of scope) nomsTypes.set(typeKey(d), typeLabel(d));
  const types: FilterOption[] = [...nomsTypes.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'fr', { sensitivity: 'base' }))
    .map(([value, label]) => ({ value, label, count: parType.get(value) ?? 0, active: f.types.includes(value) }))
    .filter(garder);

  return { biens: biens.filter(garder), rubrics: rubricOptions, types };
}

/** Pastilles « Filtré par … », dans l'ordre Bien, Rubrique, Type. */
export function activeFilterChips(
  f: ViewFilters,
  options: ReturnType<typeof buildFilterOptions>,
): Array<{ dim: keyof ViewFilters; value: string; label: string }> {
  const libelle = (list: FilterOption[], v: string) => list.find((o) => o.value === v)?.label ?? v;
  return [
    ...f.biens.map((v) => ({ dim: 'biens' as const, value: v, label: libelle(options.biens, v) })),
    ...f.rubrics.map((v) => ({ dim: 'rubrics' as const, value: v, label: libelle(options.rubrics, v) })),
    ...f.types.map((v) => ({ dim: 'types' as const, value: v, label: libelle(options.types, v) })),
  ];
}

// ── Trier ────────────────────────────────────────────────────────────────

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

/**
 * Tri global.
 *
 * Une valeur absente (document sans date, sans bien) passe TOUJOURS en
 * dernier, quel que soit le sens — comme en base (`NULLS LAST`) : la remonter
 * en tête ferait croire à une donnée là où il n'y en a pas. À valeur égale,
 * le plus récemment ajouté d'abord, puis l'identifiant : l'ordre est stable
 * d'un rendu à l'autre.
 */
export function sortDocuments(
  docs: readonly DocumentItem[],
  sort: SortKey,
  dir: SortDir,
  rubrics: readonly RubricRef[] = [],
): DocumentItem[] {
  const rang = new Map(rubrics.map((r, i) => [r.code, i]));
  const valeur = (d: DocumentItem): string | number | null => {
    switch (sort) {
      case 'added': return d.uploadedAt ?? null;
      case 'docDate': return d.documentDate ?? null;
      case 'title': return d.title;
      case 'bien': return bienLabel(d);
      // « Sans rubrique » avant la première Rubrique en ordre croissant.
      case 'rubric': return d.rubricCode ? (rang.get(d.rubricCode) ?? 998) : -1;
    }
  };
  const signe = dir === 'desc' ? -1 : 1;
  return [...docs].sort((x, y) => {
    const a = valeur(x);
    const b = valeur(y);
    if (a === null && b !== null) return 1;
    if (b === null && a !== null) return -1;
    if (a !== null && b !== null) {
      const c = typeof a === 'number' && typeof b === 'number'
        ? a - b
        : sort === 'title' || sort === 'bien'
          ? collator.compare(String(a), String(b))
          : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
      if (c !== 0) return c * signe;
    }
    const ajoutX = x.uploadedAt ?? '';
    const ajoutY = y.uploadedAt ?? '';
    if (ajoutX !== ajoutY) return ajoutX < ajoutY ? 1 : -1;
    return y.id - x.id;
  });
}

// ── Regrouper ────────────────────────────────────────────────────────────

export interface DocumentGroup {
  /** Code de Rubrique, `UNFILED`, ou `'ALL'` sans regroupement. */
  code: string;
  label: string;
  dot: string;
  docs: DocumentItem[];
  /** Faux sans regroupement : la liste n'a pas de titre. */
  showHeader: boolean;
}

/**
 * Découpe la liste triée en sections.
 *
 * Regroupé : « Sans rubrique » en tête (et seulement s'il contient quelque
 * chose), puis les Rubriques dans l'ordre du référentiel. Une Rubrique sans
 * document n'a pas de section : elle est citée dans `emptyRubrics`, pour la
 * ligne « Rubriques sans document : … ». Chaque section conserve l'ordre
 * global — le regroupement ne retrie rien.
 */
export function groupDocuments(
  sorted: readonly DocumentItem[],
  rubrics: readonly RubricRef[],
  grouped: boolean,
): { groups: DocumentGroup[]; emptyRubrics: string[] } {
  if (!grouped) {
    return {
      groups: sorted.length
        ? [{ code: 'ALL', label: '', dot: '', docs: [...sorted], showHeader: false }]
        : [],
      emptyRubrics: [],
    };
  }
  const parCode = new Map<string, DocumentItem[]>();
  for (const d of sorted) {
    const k = rubricKey(d);
    const liste = parCode.get(k);
    if (liste) liste.push(d); else parCode.set(k, [d]);
  }
  const groups: DocumentGroup[] = [];
  const emptyRubrics: string[] = [];
  const nonClasses = parCode.get(UNFILED);
  if (nonClasses?.length) {
    groups.push({ code: UNFILED, label: MICROCOPY.unfiledZone, dot: UNFILED_COLORS.dot, docs: nonClasses, showHeader: true });
  }
  const connues = new Set<string>([UNFILED]);
  for (const r of rubrics) {
    connues.add(r.code);
    const docs = parCode.get(r.code);
    if (docs?.length) groups.push({ code: r.code, label: r.label, dot: rubricColors(r.code).dot, docs, showHeader: true });
    else emptyRubrics.push(r.label);
  }
  // Rubrique hors du périmètre visible (référentiel modifié depuis) : les
  // documents ne doivent pas disparaître pour autant.
  for (const [code, docs] of parCode) {
    if (!connues.has(code)) groups.push({ code, label: code, dot: rubricColors(code).dot, docs, showHeader: true });
  }
  return { groups, emptyRubrics };
}

/**
 * Plafond de rendu : au-delà, « Afficher plus » ajoute la suite. Le plafond
 * suit l'ordre d'affichage (sections comprises) ; une section entamée reste
 * visible avec son titre.
 */
export function limitGroups(groups: readonly DocumentGroup[], limit: number): { groups: DocumentGroup[]; hidden: number } {
  let reste = limit;
  let hidden = 0;
  const out: DocumentGroup[] = [];
  for (const g of groups) {
    if (reste <= 0) { hidden += g.docs.length; continue; }
    const docs = g.docs.slice(0, reste);
    hidden += g.docs.length - docs.length;
    reste -= docs.length;
    out.push({ ...g, docs });
  }
  return { groups: out, hidden };
}

// ── Textes ───────────────────────────────────────────────────────────────

const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

/**
 * Date courte française : « 12 sept. 2025 ». Une date seule (`YYYY-MM-DD`)
 * est lue telle quelle ; un horodatage est ramené au jour de Paris.
 */
export function formatDateFr(value: string | null | undefined): string {
  if (!value) return '—';
  let y: number, m: number, d: number;
  const seule = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (seule) {
    [y, m, d] = [Number(seule[1]), Number(seule[2]), Number(seule[3])];
  } else {
    const t = new Date(value);
    if (Number.isNaN(t.getTime())) return '—';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(t);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    [y, m, d] = [get('year'), get('month'), get('day')];
  }
  return `${d} ${MOIS[m - 1]} ${y}`;
}

/** Date montrée sur la ligne : celle du tri quand on trie par date du document, sinon la date d'ajout. */
export function displayedDate(d: DocumentItem, sort: SortKey): string {
  return formatDateFr(sort === 'docDate' ? d.documentDate : d.uploadedAt);
}

/** Sous-titre : Type · date · bien (le bien seulement sur « Mes documents »). */
export function documentSubtitle(d: DocumentItem, sort: SortKey, context: DocumentsContext): string {
  return [typeLabel(d), displayedDate(d, sort), context === 'mes-documents' ? bienLabel(d) : null]
    .filter(Boolean)
    .join(' · ');
}

/** « 19 documents », « 4 documents sur 19 », « 12 documents rattachés à ce bien ». */
export function countLabel(shown: number, scopeTotal: number, filtered: boolean, context: DocumentsContext): string {
  const base = `${shown} document${shown > 1 ? 's' : ''}`;
  if (filtered) return `${base} sur ${scopeTotal}`;
  return context === 'fiche-bien' ? `${base} ${shown > 1 ? 'rattachés' : 'rattaché'} à ce bien` : base;
}

export function emptyRubricsLine(labels: readonly string[]): string {
  return labels.length ? `Rubriques sans document : ${labels.join(', ')}.` : '';
}
