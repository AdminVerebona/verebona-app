/**
 * T3 — harmonisation du nommage documentaire (lot 61) : GARDE-FOUS
 * DÉTERMINISTES, purs (aucun accès base).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE LE CODE DÉCIDE — ET CE QU'IL NE DÉCIDE PAS
 *
 * Le NOM proposé vient de l'IA. Aucune nomenclature, aucun gabarit, aucune
 * règle propre à un fournisseur ou à un type documentaire n'existe ici : le
 * code se contente de REFUSER une proposition dangereuse :
 *   · monde fermé (document et références fournis dans l'appel) ;
 *   · nom protégé (renommage manuel) ;
 *   · document fourni en RÉFÉRENCE (lot 72B, E7) : seuls les documents
 *     TO_EXAMINE de l'appel peuvent être renommés ;
 *   · nom attendu différent du nom envoyé (compare-and-swap côté modèle) ;
 *   · nom équivalent (casse, accents, ponctuation) → aucune écriture ;
 *   · format (longueur, nom technique, retour à la ligne, masquage) ;
 *   · confiance insuffisante (nom d'origine inconnue : « certain » exigé) ;
 *   · information DISCRIMINANTE du nom actuel supprimée (date, période,
 *     référence, montant, adresse) ;
 *   · information discriminante INVENTÉE (absente du nom actuel et des
 *     données connues du document) ;
 *   · document renommé récemment par T3 sans nouvelle information.
 * Ces règles sont génériques : elles reconnaissent la FORME d'une date, d'un
 * montant, d'une référence ou d'une adresse, jamais un contenu attendu.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { isValidBusinessTitle, normalizeTitle, type TitleIdentifiers } from '@/lib/documents/document-title-rules';

/** Longueur maximale d'un nom harmonisé (caractères). */
export const NAMING_MAX_LENGTH = 120;
const NAMING_MIN_LENGTH = 3;

/** Origine du nom EN PLACE (dérivée, jamais stockée : voir migration 0450). */
export type NameOrigin = 'USER' | 'T1' | 'T3' | 'T3_HARMONIZATION' | 'UPLOAD' | 'UNKNOWN';

export type RenameRefusal =
  | 'UNKNOWN_DOCUMENT'
  | 'DUPLICATE_PROPOSAL'
  | 'UNKNOWN_REFERENCE'
  | 'USER_NAME_PROTECTED'
  | 'REFERENCE_NOT_RENAMABLE'
  | 'EXPECTED_NAME_MISMATCH'
  | 'EQUIVALENT_NAME'
  | 'INVALID_NAME'
  | 'TOO_LONG'
  | 'LOW_CONFIDENCE'
  | 'UNKNOWN_ORIGIN_LOW_CONFIDENCE'
  | 'DISCRIMINANT_REMOVED'
  | 'INFORMATION_INVENTED'
  | 'RECENTLY_HARMONIZED'
  | 'NAME_COLLISION';

/** Libellés du reporting (BO). */
export const RENAME_REFUSAL_LABEL: Record<RenameRefusal, string> = {
  UNKNOWN_DOCUMENT: 'Document hors du lot fourni à l’IA (monde fermé)',
  DUPLICATE_PROPOSAL: 'Proposition en double pour ce document',
  UNKNOWN_REFERENCE: 'Document de référence hors du lot fourni à l’IA',
  USER_NAME_PROTECTED: 'Nom personnalisé par l’utilisateur : protégé',
  REFERENCE_NOT_RENAMABLE: 'Document fourni en RÉFÉRENCE dans cet appel (rôle autre que TO_EXAMINE) : jamais renommé',
  EXPECTED_NAME_MISMATCH: 'Nom attendu par l’IA différent du nom en place',
  EQUIVALENT_NAME: 'Nom proposé équivalent au nom en place : aucune écriture',
  INVALID_NAME: 'Nom proposé non conforme (technique, vide ou masqué)',
  TOO_LONG: `Nom proposé trop long (plus de ${NAMING_MAX_LENGTH} caractères)`,
  LOW_CONFIDENCE: 'Confiance IA insuffisante',
  UNKNOWN_ORIGIN_LOW_CONFIDENCE: 'Nom historique d’origine inconnue : confiance « certain » exigée',
  DISCRIMINANT_REMOVED: 'Information discriminante du nom actuel supprimée',
  INFORMATION_INVENTED: 'Information absente du nom actuel et des données du document',
  RECENTLY_HARMONIZED: 'Document déjà harmonisé récemment, sans nouvelle information',
  NAME_COLLISION: 'Même nom qu’un autre document de la famille',
};

// ── Informations discriminantes ─────────────────────────────────────────────

interface DateToken { y: number; m: number | null; d: number | null; q: number | null }
interface Discriminants {
  dates: DateToken[];
  amounts: number[];
  references: string[];
  /** Mots du nom de voie (normalisés). */
  address: string[];
}

const MONTHS: Record<string, number> = {
  janvier: 1, janv: 1, january: 1, jan: 1, fevrier: 2, fevr: 2, fev: 2, february: 2, feb: 2, mars: 3, march: 3, mar: 3,
  avril: 4, avr: 4, april: 4, apr: 4, mai: 5, may: 5, juin: 6, june: 6, jun: 6, juillet: 7, juil: 7, july: 7, jul: 7,
  aout: 8, august: 8, aug: 8, septembre: 9, sept: 9, september: 9, sep: 9, octobre: 10, oct: 10, october: 10,
  novembre: 11, nov: 11, november: 11, decembre: 12, dec: 12, december: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
// « résidence » exclu : trop ambigu (« résidence principale » n'est pas une adresse).
const STREET = 'rue|avenue|av|boulevard|bd|chemin|allee|place|impasse|route|quai|cours|square|lotissement|chaussee|passage|sentier';
const STOP = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'd', 'l', 'et', 'a', 'au', 'aux', 'en', 'sur']);
const UUID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/g;

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const alnum = (s: string) => fold(s).replace(/[^a-z0-9]+/g, '');
/** Clé d'une référence : alphanumérique, sans préfixe « n° », « no », « réf. ». */
const refKey = (tok: string) => alnum(fold(tok).replace(/^(?:n°|no\b\.?|num(?:ero)?\b\.?|ref(?:erence)?\b\.?)\s*[:#-]?\s*/, '').replace(/^n°/, ''));
const validYmd = (y: number, m: number, d: number) => y >= 1900 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
const yr = (s: string) => { const n = Number(s); return s.length === 2 ? 2000 + n : n; };

/** Retire les parties techniques d'un nom (clé de stockage, horodatage, extension, UUID, empreinte). */
function cleanName(name: string): string {
  let s = fold(name).trim();
  s = s.replace(/^(?:verebona|owntrack)\/u_\d+\/\S*/, ' ').replace(/^\d{10,13}_/, ' ');
  for (let i = 0; i < 2; i++) s = s.replace(/\.[a-z0-9]{1,5}$/, '');
  return ` ${s.replace(UUID, ' ').replace(/\b[0-9a-f]{16,}\b/g, ' ').replace(/_/g, ' ')} `;
}

/**
 * Informations discriminantes d'un texte (pure). Chaque motif reconnu est
 * « consommé » : une date n'est pas aussi comptée comme année ou référence.
 */
export function extractDiscriminants(text: string | null | undefined, opts: { clean?: boolean } = {}): Discriminants {
  const out: Discriminants = { dates: [], amounts: [], references: [], address: [] };
  if (!text) return out;
  let s = opts.clean === false ? ` ${fold(text)} ` : cleanName(text);
  const eat = (re: RegExp, fn: (m: RegExpExecArray) => boolean | void) => {
    s = s.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      return fn(m) === false ? m[0] : ' ';
    });
  };
  const date = (y: number, m: number | null, d: number | null, q: number | null = null) => out.dates.push({ y, m, d, q });
  // Montants (avant les dates : « 1 234,56 € »).
  eat(/(\d{1,3}(?:[ .]\d{3})+|\d+)(?:,(\d{1,2}))?\s*(?:€|\beur(?:os?)?\b)/g, (m) => {
    const cents = Number(m[1].replace(/[ .]/g, '')) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
    if (Number.isFinite(cents)) out.amounts.push(cents);
  });
  // Dates complètes.
  eat(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, (m) => { if (!validYmd(+m[1], +m[2], +m[3])) return false; date(+m[1], +m[2], +m[3]); });
  eat(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g, (m) => { const y = yr(m[3]); if (!validYmd(y, +m[2], +m[1])) return false; date(y, +m[2], +m[1]); });
  eat(new RegExp(`\\b(\\d{1,2})(?:er)?\\s+(${MONTH_RE})\\.?\\s+(\\d{4})\\b`, 'g'), (m) => { if (!validYmd(+m[3], MONTHS[m[2]], +m[1])) return false; date(+m[3], MONTHS[m[2]], +m[1]); });
  eat(/\b((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/g, (m) => { date(+m[1], +m[2], +m[3]); });
  // Trimestres.
  eat(/\b(?:t|q)([1-4])\s*[-/ ]?\s*((?:19|20)\d{2})\b/g, (m) => { date(+m[2], null, null, +m[1]); });
  eat(/\b([1-4])(?:er|e|eme)?\s+trimestre\s+((?:19|20)\d{2})\b/g, (m) => { date(+m[2], null, null, +m[1]); });
  // Références alphanumériques (lettres ET chiffres, éventuellement à tirets :
  // « FA-2024-0012 », « n°12345 ») — avant les années, pour ne pas les découper.
  s = s.split(/\s+/).map((brut) => {
    const tok = brut.replace(/^[,;:()[\]{}"«»]+|[,;:()[\]{}"«»]+$/g, '');
    if (!/[a-z]/.test(tok) || !/\d/.test(tok) || /^(?:\d{1,2}(?:er|e|eme)|[tq][1-4])$/.test(tok)) return brut;
    if (new RegExp(`^(?:${MONTH_RE})\\d{4}$`).test(tok)) return brut;
    const k = refKey(tok);
    if (k.length < 3) return brut;
    out.references.push(k);
    return ' ';
  }).join(' ');
  // Mois + année.
  eat(new RegExp(`\\b(${MONTH_RE})\\.?\\s*[-/ ]?\\s*(\\d{4})\\b`, 'g'), (m) => { date(+m[2], MONTHS[m[1]], null); });
  eat(/\b(\d{1,2})[-/.](\d{4})\b/g, (m) => { if (+m[1] < 1 || +m[1] > 12) return false; date(+m[2], +m[1], null); });
  eat(/\b(\d{4})[-/.](\d{1,2})\b/g, (m) => { if (+m[2] < 1 || +m[2] > 12 || +m[1] < 1900) return false; date(+m[1], +m[2], null); });
  // Adresse : numéro facultatif, type de voie, nom de voie.
  eat(new RegExp(`\\b(?:(\\d{1,4})\\s*(?:bis|ter)?\\s*,?\\s+)?(?:${STREET})\\.?\\s+((?:[a-z'-]+\\s*){1,4})`, 'g'), (m) => {
    const mots = m[2].split(/[\s'-]+/).filter((w) => w.length >= 3 && !STOP.has(w));
    if (!mots.length) return false;
    out.address.push(...mots);
    if (m[1]) out.references.push(m[1]);
  });
  // Années seules.
  eat(/\b(19[5-9]\d|20\d{2})\b/g, (m) => { date(+m[1], null, null); });
  // Références numériques restantes (≥ 3 chiffres utiles).
  for (const tok of s.split(/[\s,;:()[\]{}"«»]+/)) {
    if (!/\d/.test(tok)) continue;
    const k = refKey(tok);
    if (k.length >= 3) out.references.push(k);
  }
  return out;
}

/** Données connues d'un document (justifient une information du nouveau nom). */
export interface KnownDocumentData {
  dates: string[];
  periods: Array<{ start: string | null; end: string | null }>;
  amountsCents: number[];
  /** Textes du document (titre d'extraction, fournisseur, faits, extrait, bien, nom déposé…). */
  texts: string[];
}

interface Known { dates: DateToken[]; amounts: Set<number>; refs: string; words: Set<string>; periods: Array<{ s: number; e: number }> }

const monthIndex = (y: number, m: number) => y * 12 + (m - 1);
function isoToken(iso: string | null): DateToken | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso ?? '');
  return m ? { y: +m[1], m: +m[2], d: m[3] ? +m[3] : null, q: null } : null;
}

function knownOf(k: KnownDocumentData): Known {
  const fromTexts = k.texts.map((t) => extractDiscriminants(t, { clean: false }));
  const dates = [...k.dates.map(isoToken).filter((x): x is DateToken => !!x), ...fromTexts.flatMap((d) => d.dates)];
  const periods = k.periods.map((p) => {
    const s = isoToken(p.start) ?? isoToken(p.end);
    const e = isoToken(p.end) ?? isoToken(p.start);
    return s && e && s.m && e.m ? { s: monthIndex(s.y, s.m), e: monthIndex(e.y, e.m) } : null;
  }).filter((x): x is { s: number; e: number } => !!x);
  return {
    dates, periods,
    amounts: new Set([...k.amountsCents, ...fromTexts.flatMap((d) => d.amounts)]),
    refs: k.texts.map(alnum).join('|'),
    words: new Set(k.texts.flatMap((t) => normalizeTitle(t).split(' '))),
  };
}

/** Le jeton daté `t` est-il couvert par `c` (même granularité ou plus fine) ? */
function covers(c: DateToken, t: DateToken): boolean {
  if (c.y !== t.y) return false;
  if (t.d !== null) return c.m === t.m && c.d === t.d;
  if (t.m !== null) return c.m === t.m;
  if (t.q !== null) return c.q === t.q || (c.m !== null && Math.ceil(c.m / 3) === t.q);
  return true;
}

function dateKey(t: DateToken): string {
  return t.d !== null ? `${t.y}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`
    : t.m !== null ? `${t.y}-${String(t.m).padStart(2, '0')}` : t.q !== null ? `${t.y}-T${t.q}` : String(t.y);
}

/**
 * Informations discriminantes du nom ACTUEL absentes du nom proposé (pure).
 * Nom actuel TECHNIQUE (« 5be5….pdf », « IMG_2024… ») : aucune information
 * métier à préserver. Une date complète réduite au mois reste admise si le
 * jour est conservé dans les données du document (date du document).
 */
export function lostDiscriminants(oldName: string, newName: string, known: KnownDocumentData, ids: TitleIdentifiers = {}): string[] {
  const nettoye = cleanName(oldName).trim();
  if (!isValidBusinessTitle(nettoye, ids)) return [];
  const a = extractDiscriminants(oldName);
  const b = extractDiscriminants(newName);
  const k = knownOf({ ...known, texts: [] });
  const perdus: string[] = [];
  for (const t of a.dates) {
    if (b.dates.some((c) => covers(c, t))) continue;
    // Jour retiré du nom mais conservé par la date du document.
    if (t.d !== null && b.dates.some((c) => c.y === t.y && c.m === t.m && c.d === null) && k.dates.some((c) => covers(c, t))) continue;
    perdus.push(`date ${dateKey(t)}`);
  }
  for (const m of a.amounts) if (!b.amounts.includes(m)) perdus.push(`montant ${(m / 100).toFixed(2)}`);
  const nb = alnum(newName);
  for (const r of a.references) if (!nb.includes(r)) perdus.push(`référence ${r}`);
  const mots = new Set(normalizeTitle(newName).split(' '));
  for (const w of a.address) if (!mots.has(w)) perdus.push(`adresse « ${w} »`);
  return [...new Set(perdus)];
}

/**
 * Informations discriminantes du nom PROPOSÉ ni dans le nom actuel, ni dans
 * les données connues du document (pure) : une invention.
 */
export function inventedDiscriminants(oldName: string, newName: string, known: KnownDocumentData): string[] {
  const a = extractDiscriminants(oldName);
  const b = extractDiscriminants(newName);
  const k = knownOf(known);
  const inventes: string[] = [];
  for (const t of b.dates) {
    if (a.dates.some((c) => covers(c, t)) || k.dates.some((c) => covers(c, t))) continue;
    if (t.m !== null && k.periods.some((p) => monthIndex(t.y, t.m!) >= p.s && monthIndex(t.y, t.m!) <= p.e)) continue;
    if (t.m === null && t.d === null && k.periods.some((p) => Math.floor(p.s / 12) <= t.y && Math.floor(p.e / 12) >= t.y)) continue;
    if (t.q !== null && k.periods.some((p) => p.s <= monthIndex(t.y, t.q! * 3) && p.e >= monthIndex(t.y, t.q! * 3 - 2))) continue;
    inventes.push(`date ${dateKey(t)}`);
  }
  for (const m of b.amounts) if (!a.amounts.includes(m) && !k.amounts.has(m)) inventes.push(`montant ${(m / 100).toFixed(2)}`);
  const na = alnum(oldName);
  for (const r of b.references) if (!na.includes(r) && !k.refs.includes(r)) inventes.push(`référence ${r}`);
  const motsAncien = new Set(normalizeTitle(oldName).split(' '));
  for (const w of b.address) if (!motsAncien.has(w) && !k.words.has(w)) inventes.push(`adresse « ${w} »`);
  return [...new Set(inventes)];
}

/** Deux noms équivalents (casse, accents, ponctuation, espaces) — pure. */
export function equivalentNames(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeTitle(a) === normalizeTitle(b);
}

const spaces = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Document tel que fourni à l'IA (instantané du contexte). */
export interface NamingSnapshotDoc {
  id: number;
  name: string;
  /** Forme masquée du nom envoyé au modèle (passerelle), si différente. */
  redactedName?: string | null;
  origin: NameOrigin;
  ids?: TitleIdentifiers;
  /** Dernier renommage T3 (harmonisation) encore en place. */
  lastHarmonizedAt?: string | null;
  /** Empreinte des données du document lors de ce renommage. */
  harmonizedFingerprint?: string | null;
  /** Empreinte actuelle des données du document. */
  fingerprint: string;
  /** Rôle dans l'appel (lot 72B, E7) : seul TO_EXAMINE est renommable. Absent : TO_EXAMINE (compatibilité). */
  role?: 'TO_EXAMINE' | 'REFERENCE';
}

export interface NamingProposal {
  document_id: number;
  expected_current_name: string;
  proposed_name: string;
  reference_document_ids?: number[];
  reason: string;
  confidence: 'certain' | 'probable' | 'conflictual';
}

type ProposalVerdict =
  | { accept: true; name: string }
  | { accept: false; code: RenameRefusal; detail?: string };

/**
 * Verdict déterministe sur UNE proposition (pure). `known` : données connues
 * du document visé (chargées pour les seuls documents proposés).
 */
export function judgeProposal(p: NamingProposal, ctx: {
  docs: ReadonlyMap<number, NamingSnapshotDoc>;
  seen: Set<number>;
  known: KnownDocumentData | null;
  now: Date;
  cooldownDays: number;
}): ProposalVerdict {
  const doc = ctx.docs.get(p.document_id);
  if (!doc) return { accept: false, code: 'UNKNOWN_DOCUMENT' };
  if (ctx.seen.has(p.document_id)) return { accept: false, code: 'DUPLICATE_PROPOSAL' };
  ctx.seen.add(p.document_id);
  const inconnues = (p.reference_document_ids ?? []).filter((r) => !ctx.docs.has(r));
  if (inconnues.length) return { accept: false, code: 'UNKNOWN_REFERENCE', detail: inconnues.join(', ') };
  if (doc.origin === 'USER') return { accept: false, code: 'USER_NAME_PROTECTED' };
  if (doc.role === 'REFERENCE') return { accept: false, code: 'REFERENCE_NOT_RENAMABLE' };
  const attendu = spaces(p.expected_current_name);
  if (attendu !== spaces(doc.name) && attendu !== spaces(doc.redactedName ?? doc.name)) {
    return { accept: false, code: 'EXPECTED_NAME_MISMATCH', detail: `attendu « ${attendu.slice(0, 120)} »` };
  }
  const nom = spaces(p.proposed_name);
  if (equivalentNames(nom, doc.name)) return { accept: false, code: 'EQUIVALENT_NAME' };
  if (nom.length > NAMING_MAX_LENGTH) return { accept: false, code: 'TOO_LONG', detail: `${nom.length} caractères` };
  if (nom.length < NAMING_MIN_LENGTH || /[\r\n\t]/.test(p.proposed_name) || /_MASQU/.test(nom) || !isValidBusinessTitle(nom, doc.ids ?? {})) {
    return { accept: false, code: 'INVALID_NAME' };
  }
  if (p.confidence === 'conflictual') return { accept: false, code: 'LOW_CONFIDENCE' };
  if (doc.origin === 'UNKNOWN' && p.confidence !== 'certain') return { accept: false, code: 'UNKNOWN_ORIGIN_LOW_CONFIDENCE' };
  const known = ctx.known ?? { dates: [], periods: [], amountsCents: [], texts: [] };
  const perdus = lostDiscriminants(doc.name, nom, known, doc.ids ?? {});
  if (perdus.length) return { accept: false, code: 'DISCRIMINANT_REMOVED', detail: perdus.join(', ') };
  const inventes = inventedDiscriminants(doc.name, nom, known);
  if (inventes.length) return { accept: false, code: 'INFORMATION_INVENTED', detail: inventes.join(', ') };
  if (doc.origin === 'T3_HARMONIZATION' && doc.lastHarmonizedAt) {
    const age = ctx.now.getTime() - Date.parse(doc.lastHarmonizedAt);
    if (age < ctx.cooldownDays * 86_400_000 && doc.harmonizedFingerprint === doc.fingerprint) {
      return { accept: false, code: 'RECENTLY_HARMONIZED', detail: `renommé le ${doc.lastHarmonizedAt.slice(0, 10)}` };
    }
  }
  return { accept: true, name: nom };
}

/**
 * Collisions (pure) : deux documents DIFFÉRENTS du lot porteraient le même
 * nom (normalisé) alors que leurs noms actuels diffèrent — signe d'une
 * information discriminante perdue. Rend les documents à refuser.
 */
export function collidingProposals(
  accepted: ReadonlyArray<{ documentId: number; name: string }>,
  docs: ReadonlyMap<number, NamingSnapshotDoc>,
): Set<number> {
  const finaux = new Map<number, string>();
  for (const d of docs.values()) finaux.set(d.id, normalizeTitle(d.name));
  for (const a of accepted) finaux.set(a.documentId, normalizeTitle(a.name));
  const refuses = new Set<number>();
  for (const a of accepted) {
    const n = normalizeTitle(a.name);
    const avant = normalizeTitle(docs.get(a.documentId)?.name);
    for (const [id, nom] of finaux) {
      if (id === a.documentId || nom !== n) continue;
      if (normalizeTitle(docs.get(id)?.name) === avant) continue;
      refuses.add(a.documentId);
    }
  }
  return refuses;
}
