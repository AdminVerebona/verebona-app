/**
 * ══════════════════════════════════════════════════════════════════════════
 * CARTE TRELLO #853 (P1-01 de #835) — INVENTAIRE DES OCCURRENCES D'UNE UNITÉ
 * (fonctions pures)
 *
 * Règle remplacée : le contrôle de complétude raisonnait sur l'ENSEMBLE des
 * formes de valeur d'une unité (`new Set(kind:normalized)`). Deux prestations
 * distinctes à 120 € devenaient UNE valeur à expliquer : un seul fait à 120 €
 * « expliquait » les deux, et le bloc était déclaré complet alors qu'une
 * prestation manquait. Les lignes de tableau, elles, étaient couvertes sans
 * confrontation de leurs cellules, et les propositions sans nombre
 * (obligation, exclusion, instruction) passaient au travers.
 *
 * Ici, chaque unité est inventoriée OCCURRENCE PAR OCCURRENCE :
 *   · valeurs significatives (montant, date, identifiant) — position exacte
 *     dans le texte de l'unité, forme normalisée, RÔLE local (libellé, mots
 *     qui précèdent la valeur dans la même clause) ;
 *   · nombres nus (quantités, index) — seulement là où le contrôle les
 *     comparait déjà (unités non résolues) ;
 *   · propositions utiles sans valeur (obligation, condition, exclusion,
 *     instruction) — une phrase = une information, jamais chaque mot ;
 *   · cellules d'une ligne de tableau — colonne, en-tête (rôle), en-tête de
 *     ligne ; cellules vides et en-têtes répétés EXCLUS avec motif.
 *
 * IDENTITÉ STABLE : `<unité>@<début>` (texte) ou `<ligne>:cell:<colonne>`
 * (tableau) — la position n'est jamais inventée : elle est lue dans le texte
 * persisté de l'unité. Deux occurrences de même valeur dans la même unité
 * restent DEUX identités ; deux lectures chevauchantes d'une même zone n'en
 * font qu'une (`significantValueOccurrences`).
 *
 * ÉQUIVALENCE (une même preuve explique plusieurs occurrences) : même forme
 * ET même rôle local non vide (« Total TTC » rappelé) — jamais la seule
 * valeur, le seul extrait ou la seule page (`equivalentOccurrences`).
 * Le rôle sert aussi à REFUSER une preuve : un fait dont le libellé porte un
 * rôle (HT, TTC, franchise, début, échéance…) distinct de celui de
 * l'occurrence ne la prouve pas (`roleConflict`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { contentRoots } from '../value-decisions/validate';
import { mots, plat, significantValueOccurrences, type SignificantKind } from './text';
import type { CoveredSourceUnit } from './types';

/** Nature d'une occurrence inventoriée. */
export type OccurrenceNature = SignificantKind | 'NUMBER' | 'PROPOSITION' | 'CELL';

export interface SourceOccurrence {
  /** Identité stable dans le document : `<unité>@<début>` ou `<ligne>:cell:<colonne>`. */
  id: string;
  unitId: string;
  nature: OccurrenceNature;
  /** Forme comparable (`AMOUNT:12000`, `DATE:2026-03-12`, `IDENTIFIER:AB123CD`, `NUM:45`) ; null : proposition / cellule sans valeur. */
  form: string | null;
  /** Toutes les formes portées (une cellule peut porter un montant ET des chiffres nus). */
  forms: readonly string[];
  /** Position dans le texte de l'unité (cellule : dans la valeur de la cellule). */
  start: number;
  end: number;
  page: number | null;
  cell: { column: number; header: string | null; rowHeader: string | null } | null;
  /** Racines de contenu du contexte local (rôle) — jamais une valeur. */
  role: ReadonlySet<string>;
  /** Rôles reconnus (`ROLE_LEXICON`) dans le contexte local. */
  roleTags: ReadonlySet<string>;
  /** Proposition : forme plate (comparaison avec un extrait). */
  flat?: string;
}

/** Occurrence EXCLUE de l'inventaire (non informative), avec son motif — comptée à part, jamais « couverte ». */
export interface ExcludedOccurrence { id: string; unitId: string; reason: 'empty_cell' | 'repeated_header' }

/**
 * Rôles DISCRIMINANTS (forme de comparaison) : deux rôles distincts d'un même groupe désignent deux informations
 * différentes (un montant HT n'est pas le TTC, une date de début n'est pas l'échéance). Paramètre centralisé.
 */
export const ROLE_LEXICON: Readonly<Record<string, readonly string[]>> = {
  ht: ['ht', 'hors taxe', 'hors taxes'],
  ttc: ['ttc', 'toutes taxes'],
  tva: ['tva'],
  acompte: ['acompte', 'arrhes'],
  franchise: ['franchise'],
  plafond: ['plafond'],
  remise: ['remise', 'rabais', 'reduction'],
  solde: ['solde', 'reste a payer', 'restant du'],
  caution: ['caution', 'depot de garantie'],
  debut: ['debut', 'date d effet', 'prise d effet'],
  fin: ['fin', 'expiration', 'jusqu au'],
  echeance: ['echeance', 'date limite', 'a regler avant', 'a payer avant'],
  emission: ['emission', 'emise le', 'etablie le', 'date de facture'],
};
/** Rôles reconnus dans un texte (libellé, clé de fait, contexte local). */
export function roleTagsOf(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const ws = mots(text.replace(/[._]/g, ' '));
  const joint = ` ${ws.join(' ')} `;
  for (const [role, formes] of Object.entries(ROLE_LEXICON)) {
    // Mots ENTIERS seulement : « ht » n'est jamais lu dans un autre mot.
    for (const f of formes) if (joint.includes(` ${f} `)) out.add(role);
  }
  return out;
}

/** Le libellé d'une preuve désigne-t-il un rôle DIFFÉRENT de celui de l'occurrence ? (les deux rôles connus et disjoints) */
export function roleConflict(occurrence: Pick<SourceOccurrence, 'roleTags'>, proofTags: ReadonlySet<string>): boolean {
  if (occurrence.roleTags.size === 0 || proofTags.size === 0) return false;
  return ![...occurrence.roleTags].some((t) => proofTags.has(t));
}

/** Deux occurrences sont-elles le rappel de la MÊME information ? Même forme et même rôle local non vide. */
export function equivalentOccurrences(a: Pick<SourceOccurrence, 'form' | 'role'>, b: Pick<SourceOccurrence, 'form' | 'role'>): boolean {
  if (a.form === null || a.form !== b.form || a.role.size === 0 || a.role.size !== b.role.size) return false;
  return [...a.role].every((w) => b.role.has(w));
}

/** Séparateurs de clause : le rôle d'une valeur est lu entre le séparateur (ou la valeur) précédent et elle. */
const CLAUSE = /[;\n|•·]|\s[-–—]\s|,\s(?=\p{L})/gu;
const NOMBRES = /\d{1,3}(?:[   .]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g;

/**
 * Propositions UTILES sans valeur (obligation, interdiction, condition, exclusion, instruction) : vocabulaire
 * normatif, en forme de comparaison sans accents. Paramètre centralisé — il dit seulement « cette phrase énonce
 * une règle », jamais si elle est pertinente pour l'utilisateur.
 */
export const NORMATIVE_CUES: readonly string[] = [
  'doit', 'doivent', 'devra', 'devront', 'obligatoire', 'obligatoirement', 'obligation', 'imperatif', 'imperativement',
  'est tenu', 'sont tenus', 'interdit', 'interdite', 'interdits', 'interdiction', 'ne doit', 'ne peut', 'ne pas', 'n est pas couvert',
  'ne sont pas couverts', 'ne sont pas garantis', 'exclu', 'exclue', 'exclus', 'exclues', 'exclusion', 'exclusions', 'hors garantie',
  'a condition', 'sous reserve', 'en cas de', 'veuillez', 'il est necessaire', 'il convient', 'a conserver', 'conservez',
  'respectez', 'est requis', 'est requise', 'sont requis',
];
const CUES = NORMATIVE_CUES.map((c) => ` ${c} `);
/** Longueur minimale (forme de comparaison) d'une proposition : en deçà, ce n'est pas une information autonome. */
const MIN_PROPOSITION = 16;

const sansAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Le texte énonce-t-il une règle (obligation, exclusion, condition, instruction) ? */
export function isNormative(text: string): boolean {
  const t = ` ${sansAccents(text).replace(/[^a-z0-9]+/g, ' ').trim()} `;
  return CUES.some((c) => t.includes(c));
}

/** Rôle local : mots de contenu de la clause qui PRÉCÈDE la valeur (le libellé d'un couple y figure déjà). */
function roleOf(text: string, from: number, to: number): { role: Set<string>; tags: Set<string> } {
  const avant = text.slice(from, to);
  return { role: contentRoots(avant), tags: roleTagsOf(avant) };
}

/** Début de la clause qui contient la position `i` (séparateur précédent), sans remonter avant `min`. */
function debutClause(text: string, i: number, min: number): number {
  let debut = min;
  for (const m of text.matchAll(CLAUSE)) {
    const fin = (m.index ?? 0) + m[0].length;
    if (fin <= i && fin > debut) debut = fin;
  }
  return debut;
}

/**
 * Occurrences de VALEUR d'une unité de texte (bloc, libellé : valeur, formulaire), dans l'ordre de lecture.
 * `numbers` : ajoute les nombres nus (`NUM:<chiffres>`, ≥ 2 chiffres) hors valeurs significatives.
 */
export function valueOccurrencesOf(u: Pick<CoveredSourceUnit, 'sourceUnitId' | 'page' | 'text'>, opts: { numbers?: boolean } = {}): SourceOccurrence[] {
  const text = u.text ?? '';
  if (!text) return [];
  const sig = significantValueOccurrences(text);
  const out: SourceOccurrence[] = [];
  let precedent = 0;
  for (const v of sig) {
    const { role, tags } = roleOf(text, debutClause(text, v.start, precedent), v.start);
    const form = `${v.kind}:${v.normalized}`;
    out.push({ id: `${u.sourceUnitId}@${v.start}`, unitId: u.sourceUnitId, nature: v.kind, form, forms: [form], start: v.start, end: v.end, page: u.page, cell: null, role, roleTags: tags });
    precedent = v.end;
  }
  if (opts.numbers) {
    for (const m of text.matchAll(NOMBRES)) {
      const i = m.index ?? 0;
      const fin = i + m[0].length;
      if (sig.some((s) => i < s.end && s.start < fin)) continue;
      const d = m[0].replace(/\D/g, '');
      if (d.length < 2) continue;
      const prec = Math.max(0, ...out.filter((o) => o.end <= i).map((o) => o.end));
      const { role, tags } = roleOf(text, debutClause(text, i, prec), i);
      const form = `NUM:${d.replace(/^0+(?=\d)/, '')}`;
      out.push({ id: `${u.sourceUnitId}@${i}`, unitId: u.sourceUnitId, nature: 'NUMBER', form, forms: [form], start: i, end: fin, page: u.page, cell: null, role, roleTags: tags });
    }
    out.sort((a, b) => a.start - b.start);
  }
  return out;
}

/**
 * Propositions utiles SANS valeur significative d'une unité de texte : une phrase (ou clause terminée par « ; »)
 * normative, assez longue pour être une information autonome. Une phrase qui porte une valeur est déjà
 * inventoriée par cette valeur.
 */
export function propositionOccurrencesOf(u: Pick<CoveredSourceUnit, 'sourceUnitId' | 'page' | 'text'>): SourceOccurrence[] {
  const text = u.text ?? '';
  if (!text) return [];
  const valeurs = significantValueOccurrences(text);
  const out: SourceOccurrence[] = [];
  for (const m of text.matchAll(/[^.;!?\n]+[.;!?]?/g)) {
    const start = (m.index ?? 0) + (m[0].length - m[0].trimStart().length);
    const phrase = m[0].trim();
    const end = start + phrase.length;
    if (plat(phrase).length < MIN_PROPOSITION || !isNormative(phrase)) continue;
    if (valeurs.some((v) => v.start < end && start < v.end)) continue;
    out.push({
      id: `${u.sourceUnitId}@${start}`, unitId: u.sourceUnitId, nature: 'PROPOSITION', form: null, forms: [], start, end, page: u.page, cell: null,
      role: contentRoots(phrase), roleTags: new Set(), flat: plat(phrase),
    });
  }
  return out;
}

/**
 * Cellules d'une ligne de tableau : une cellule renseignée = une occurrence (forme de sa valeur, rôle = en-tête
 * de colonne et en-tête de ligne). Cellule vide : exclue (`empty_cell`) ; valeur identique à son en-tête de
 * colonne (en-tête répété sur une nouvelle page) : exclue (`repeated_header`).
 */
export function cellOccurrencesOf(u: Pick<CoveredSourceUnit, 'sourceUnitId' | 'page' | 'payload'>, formsOf: (values: unknown[]) => Set<string>): {
  occurrences: SourceOccurrence[]; excluded: ExcludedOccurrence[];
} {
  const cells = Array.isArray(u.payload.cells)
    ? (u.payload.cells as Array<{ column?: unknown; header?: unknown; value?: unknown; normalized?: unknown; page?: unknown }>) : [];
  const rowHeader = typeof u.payload.rowHeader === 'string' && u.payload.rowHeader.trim() ? u.payload.rowHeader : null;
  const occurrences: SourceOccurrence[] = [];
  const excluded: ExcludedOccurrence[] = [];
  for (const c of cells) {
    const column = typeof c.column === 'number' ? c.column : Number(c.column ?? 0);
    const id = `${u.sourceUnitId}:cell:${column + 1}`;
    const valeur = c.value === null || c.value === undefined ? '' : String(c.value).trim();
    const header = typeof c.header === 'string' && c.header.trim() ? c.header : null;
    if (!valeur || plat(valeur).length === 0) { excluded.push({ id, unitId: u.sourceUnitId, reason: 'empty_cell' }); continue; }
    if (header && plat(header) === plat(valeur)) { excluded.push({ id, unitId: u.sourceUnitId, reason: 'repeated_header' }); continue; }
    const forms = [...formsOf([c.value, c.normalized])];
    const sig = forms.filter((f) => /^(AMOUNT|DATE|IDENTIFIER):/.test(f));
    const role = contentRoots([header, rowHeader].filter(Boolean).join(' '));
    occurrences.push({
      id, unitId: u.sourceUnitId, nature: 'CELL', form: sig[0] ?? forms[0] ?? null, forms, start: 0, end: valeur.length,
      page: typeof c.page === 'number' ? c.page : u.page, cell: { column, header, rowHeader }, role,
      roleTags: roleTagsOf([header, rowHeader].filter(Boolean).join(' ')),
    });
  }
  return { occurrences, excluded };
}

/**
 * Fidélité de la transcription d'une page (preuve de CONSERVATION d'une proposition) : la vérification de la
 * source existe, n'est ni « non vérifiable » ni « reconstituée », et la page n'est ni manquante, ni non vérifiée,
 * ni numérisée (lecture par le modèle). Vérification absente ou page inconnue : NON PROUVÉE (jamais supposée).
 */
export function faithfulPagesOf(v: { status: string; missing?: readonly number[]; unverified?: readonly number[]; scanned?: readonly number[] } | null | undefined): (page: number | null) => boolean {
  if (!v || (v.status !== 'VERIFIED' && v.status !== 'PARTIAL')) return () => false;
  const exclues = new Set([...(v.missing ?? []), ...(v.unverified ?? []), ...(v.scanned ?? [])]);
  return (page) => page !== null && page !== undefined && !exclues.has(page);
}

// ── Issues par occurrence ──────────────────────────────────────────────────

/**
 * Issue d'une occurrence (R2) :
 *   STRUCTURED    donnée structurée persistée qui la porte (fait, décision STRUCTURED / COMPONENT_OR_CONTEXT,
 *                 métadonnée, candidat, ligne de tableau structurée, unité jumelle équivalente) ;
 *   PRESERVED     conservée autrement : cellule persistée avec son rôle, passage fidèle, localisable, exploitable ;
 *   NOT_RETAINED  non-rétention VALIDE, motivée, ancrée à l'occurrence ;
 *   UNDETERMINED  décision indéterminée (jamais une couverture) ;
 *   UNCERTAIN     non vérifiable (transcription non vérifiée, rattachement ambigu) ;
 *   UNRESOLVED    aucune preuve propre ;
 *   FAILED        unité en échec technique.
 */
export type OccurrenceOutcome = 'STRUCTURED' | 'PRESERVED' | 'NOT_RETAINED' | 'UNDETERMINED' | 'UNCERTAIN' | 'UNRESOLVED' | 'FAILED';

/** Compteurs d'occurrences : `total` = somme des issues (sans double compte) ; exclues comptées à part. */
export interface OccurrenceCounts {
  total: number; structured: number; preserved: number; notRetained: number; undetermined: number;
  uncertain: number; unresolved: number; failed: number; excluded: number;
}

export const emptyOccurrenceCounts = (): OccurrenceCounts => ({
  total: 0, structured: 0, preserved: 0, notRetained: 0, undetermined: 0, uncertain: 0, unresolved: 0, failed: 0, excluded: 0,
});

const CLE: Record<OccurrenceOutcome, Exclude<keyof OccurrenceCounts, 'total' | 'excluded'>> = {
  STRUCTURED: 'structured', PRESERVED: 'preserved', NOT_RETAINED: 'notRetained', UNDETERMINED: 'undetermined',
  UNCERTAIN: 'uncertain', UNRESOLVED: 'unresolved', FAILED: 'failed',
};

export function countOutcomes(outcomes: readonly OccurrenceOutcome[], excluded = 0): OccurrenceCounts {
  const c = emptyOccurrenceCounts();
  for (const o of outcomes) { c[CLE[o]]++; c.total++; }
  c.excluded = excluded;
  return c;
}

export function addOccurrenceCounts(a: OccurrenceCounts, b: OccurrenceCounts): OccurrenceCounts {
  const out = emptyOccurrenceCounts();
  for (const k of Object.keys(out) as Array<keyof OccurrenceCounts>) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}

/** Détail d'une occurrence (persisté avec la provenance) : identité, localisation, issue, preuve ou motif — jamais la valeur. */
export interface OccurrenceDetail {
  id: string;
  nature: OccurrenceNature;
  /** Position dans le texte de l'unité (cellule : colonne). */
  at: number;
  outcome: OccurrenceOutcome | 'EXCLUDED';
  /** Preuve : origine et référence exacte (`fact:db:12`, `decision:db:4`, `cell:<id>`, `unit:<id>`…). */
  proof: { source: string; ref: string } | null;
  /** Motif (issue non couverte, exclusion, rattachement par équivalence). */
  reason: string | null;
  /** Occurrence dont celle-ci est le rappel (même information). */
  recallOf?: string;
}

/** Détails gardés au plus par unité (au-delà : comptés, jamais perdus des compteurs). */
export const MAX_OCCURRENCE_DETAILS = 40;

/**
 * Fidélité des pages d'après les diagnostics PERSISTÉS de la couverture (`document_extraction_coverage.verification`,
 * clés `sourceVerification`, `pagesMissing`, `pagesUnverified`, `pagesScanned`) — même règle que `faithfulPagesOf`.
 */
export function faithfulPagesFromDiagnostics(d: unknown): (page: number | null) => boolean {
  const o = (typeof d === 'string' ? (() => { try { return JSON.parse(d) as unknown; } catch { return null; } })() : d) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.sourceVerification !== 'string') return () => false;
  const nums = (x: unknown) => (Array.isArray(x) ? x.map(Number).filter((n) => Number.isInteger(n)) : []);
  return faithfulPagesOf({ status: o.sourceVerification, missing: nums(o.pagesMissing), unverified: nums(o.pagesUnverified), scanned: nums(o.pagesScanned) });
}
