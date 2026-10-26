/**
 * Couverture RÉELLE de la source (lot 49B — ticket « T1 — Garantir la
 * couverture réelle des documents et corriger les pertes résiduelles
 * d'extraction », DEV-01).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Le contrôle de couverture du lot 34F part de ce que T1 a RENDU : une page
 * entièrement oubliée n'a aucune unité, donc rien à déclarer non couvert. Ce
 * module confronte la sortie T1 au DOCUMENT ORIGINAL, de façon déterministe
 * (aucun appel IA) :
 *
 *   PDF  · nombre RÉEL de pages (pdf-lib, déjà dépendance) ;
 *        · par page, sonde du flux de contenu : texte (opérateurs Tj / TJ),
 *          image seule (page scannée), vide ; échantillon du texte lisible
 *          (chaînes littérales, polices simples) ;
 *        · page VÉRIFIÉE : son texte se retrouve dans la transcription
 *          (≥ 50 % des mots distinctifs), ou elle est vide, ou elle a été
 *          relue par une reprise ciblée ; lot 54G : une CITATION (marque de
 *          page, preuve d'un fait, tableau, observation) n'est plus qu'un
 *          signal COMPLÉMENTAIRE — elle ne vérifie qu'une page dont
 *          l'échantillon lisible correspond partiellement (zone 30-50 %) ou
 *          trop pauvre pour conclure ; jamais une page sans échantillon
 *          (scannée, police illisible) ni une page dont l'échantillon
 *          démontre une omission (< 30 %) ; « page citée » ≠ « page
 *          couverte » (`citedUnverified`) ;
 *        · page MANQUANTE (omission → reprise ciblée de CES pages) : texte
 *          lisible absent de la transcription (< 30 %), ou transcription
 *          paginée (marques « --- page N --- ») sans cette page ;
 *        · sinon NON VÉRIFIÉE (scannée sans citation, texte illisible) :
 *          l'incertitude est conservée, jamais convertie en couverture.
 *          La page 1 n'est jamais réputée lue sans preuve (multi-pages).
 *   Image seule : une « page », lue si T1 a rendu un contenu.
 *   Texte préextrait (lien web, corpus) : la source EST le texte — sans objet.
 *   Source illisible (téléchargement, PDF corrompu) : NON VÉRIFIABLE.
 *
 * Statut (`sourceVerification`, attribut distinct de l'état de qualité :
 * information comprise ≠ document effectivement lu) :
 *   VERIFIED · PARTIAL (pages non vérifiées ou manquantes) · UNVERIFIABLE ·
 *   NOT_APPLICABLE · RECONSTRUCTED (reprise historique, jamais vérifiée).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { T1AnalyzeDocumentOutput } from '../master/t1-contract';
import { mots, pageMarker, paginationFooter, plat } from './text';

export const SOURCE_VERIFICATION_STATUSES = ['VERIFIED', 'PARTIAL', 'UNVERIFIABLE', 'NOT_APPLICABLE', 'RECONSTRUCTED'] as const;
export type SourceVerificationStatus = (typeof SOURCE_VERIFICATION_STATUSES)[number];

/** Pages sondées au plus (au-delà : non vérifiées, jamais réputées lues). */
const PROBE_MAX_PAGES = 1_000;
/** Caractères d'échantillon par page. */
const SAMPLE_MAX = 6_000;
/** Mots distinctifs comparés par page. */
const WORDS_MAX = 40;
/** Seuils de correspondance du texte d'une page avec la transcription. */
const MATCH_VERIFIED = 0.5;
const MATCH_MISSING = 0.3;
/** Mots distinctifs minimaux pour conclure à une omission (jamais sur un échantillon pauvre). */
const MIN_WORDS_FOR_MISSING = 8;

type PageKind = 'TEXT' | 'SCANNED' | 'EMPTY' | 'UNKNOWN';

export interface PageProbe {
  page: number;
  kind: PageKind;
  /** Texte lisible extrait du flux (null : aucun, ou police non lisible). */
  sample: string | null;
}

export interface SourceProbe {
  pageCount: number;
  pages: PageProbe[];
}

export interface SourceVerification {
  status: SourceVerificationStatus;
  /** Pages du document original (null : inconnu). */
  pagesExpected: number | null;
  verified: number[];
  missing: number[];
  unverified: number[];
  scanned: number[];
  /** Motif lisible (sans contenu du document). */
  reason: string | null;
  /** Pages relues par une reprise ciblée. */
  reread?: number[];
  /** Lot 54G : pages citées par T1 (mentionnées / visitées) mais NON vérifiées. */
  citedUnverified?: number[];
}

export const verificationNotApplicable = (reason: string): SourceVerification => ({
  status: 'NOT_APPLICABLE', pagesExpected: null, verified: [], missing: [], unverified: [], scanned: [], reason,
});
export const verificationUnverifiable = (reason: string, pagesExpected: number | null = null): SourceVerification => ({
  status: 'UNVERIFIABLE', pagesExpected, verified: [], missing: [], unverified: pagesExpected ? range(1, pagesExpected) : [], scanned: [], reason,
});

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

// ── Sonde PDF (pdf-lib) ────────────────────────────────────────────────────

/** Décode les séquences d'échappement d'une chaîne littérale PDF (latin-1). */
function literal(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c: string) => {
    if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return ({ n: '\n', r: '\r', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' } as Record<string, string>)[c] ?? c;
  });
}

/**
 * Texte d'un flux de contenu (pure) : chaînes littérales des blocs BT…ET,
 * nombre d'opérateurs d'affichage de texte, appels d'objets (`Do`).
 */
export function readContentStream(content: string): { textOps: number; doOps: number; text: string } {
  let textOps = 0;
  for (const _m of content.matchAll(/(?:\)|\]|>)\s*(?:Tj|TJ|'|")/g)) textOps++;
  let doOps = 0;
  for (const _m of content.matchAll(/\/[^\s/]+\s+Do\b/g)) doOps++;
  const parts: string[] = [];
  let taille = 0;
  for (const bloc of content.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
    // Chaînes littérales (parenthèses équilibrées, échappements).
    const b = bloc[1];
    let i = 0;
    while (i < b.length && taille < SAMPLE_MAX) {
      if (b[i] === '(') {
        let profondeur = 1;
        let j = i + 1;
        let s = '';
        while (j < b.length && profondeur > 0) {
          const ch = b[j];
          if (ch === '\\' && j + 1 < b.length) { s += ch + b[j + 1]; j += 2; continue; }
          if (ch === '(') profondeur++;
          else if (ch === ')') { profondeur--; if (profondeur === 0) break; }
          s += ch;
          j++;
        }
        const t = literal(s);
        parts.push(t);
        taille += t.length;
        i = j + 1;
        continue;
      }
      // Chaîne hexadécimale (police simple : un octet par caractère ; une police
      // CID donne des octets illisibles, écartés par `readableSample`).
      if (b[i] === '<' && b[i + 1] !== '<') {
        const fin = b.indexOf('>', i + 1);
        if (fin > i) {
          const hex = b.slice(i + 1, fin).replace(/\s+/g, '');
          if (/^[0-9a-fA-F]*$/.test(hex)) {
            const t = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex').toString('latin1');
            parts.push(t);
            taille += t.length;
          }
          i = fin + 1;
          continue;
        }
      }
      // Fin d'un affichage : séparateur de mots.
      if ((b[i] === 'T' && (b[i + 1] === 'j' || b[i + 1] === 'J' || b[i + 1] === '*' || b[i + 1] === 'd' || b[i + 1] === 'D')) || b[i] === '\'') parts.push(' ');
      i++;
    }
  }
  return { textOps, doOps, text: parts.join('').replace(/\s+/g, ' ').trim().slice(0, SAMPLE_MAX) };
}

/** Le texte est-il lisible (police simple) ? Majorité de lettres / chiffres / espaces. */
export function readableSample(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  const n = plat(t).length;
  if (n === 0) return null;
  const lisibles = (t.match(/[A-Za-zÀ-ÿ0-9\s.,;:'’()€%/-]/g) ?? []).length;
  // Lot 54G : un texte COURT reste un échantillon (page peu remplie), avec une exigence de lisibilité plus forte.
  return lisibles / t.length >= (n < 40 ? 0.9 : 0.75) ? t : null;
}

/**
 * Sonde d'un PDF : nombre réel de pages, nature et texte lisible de chaque
 * page. `null` : document illisible (corrompu, chiffré non lisible).
 */
export async function probePdf(bytes: Uint8Array, maxPages = PROBE_MAX_PAGES): Promise<SourceProbe | null> {
  try {
    const lib = await import('pdf-lib');
    const doc = await lib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const pageCount = doc.getPageCount();
    const pages: PageProbe[] = [];
    doc.getPages().slice(0, maxPages).forEach((p, i) => {
      try {
        const node = p.node;
        const contents = node.Contents();
        const streams: unknown[] = [];
        if (contents instanceof lib.PDFArray) {
          for (let k = 0; k < contents.size(); k++) streams.push(doc.context.lookup(contents.get(k)));
        } else if (contents) streams.push(contents);
        let content = '';
        for (const s of streams) {
          if (s instanceof lib.PDFRawStream) content += Buffer.from(lib.decodePDFRawStream(s).decode()).toString('latin1');
          else if (s && typeof (s as { getContents?: () => Uint8Array }).getContents === 'function') {
            content += Buffer.from((s as { getContents: () => Uint8Array }).getContents()).toString('latin1');
          }
          content += '\n';
        }
        const r = readContentStream(content);
        const xo = node.Resources()?.lookup(lib.PDFName.of('XObject'));
        let images = 0;
        let formes = 0;
        if (xo instanceof lib.PDFDict) {
          for (const [, ref] of xo.entries()) {
            const o = doc.context.lookup(ref);
            const dict = o && (o as { dict?: unknown }).dict;
            const sub = dict instanceof lib.PDFDict ? dict.get(lib.PDFName.of('Subtype')) : undefined;
            if (sub === lib.PDFName.of('Image')) images++; else formes++;
          }
        }
        // Lot 54G : opérateurs de texte sans aucun caractère, ni image ni forme : page objectivement VIDE.
        const texteVide = r.textOps > 0 && !r.text.trim() && r.doOps === 0;
        const kind: PageKind = texteVide ? 'EMPTY' : r.textOps > 0 ? 'TEXT' : formes > 0 && r.doOps > 0 ? 'UNKNOWN' : images > 0 && r.doOps > 0 ? 'SCANNED'
          : content.trim() ? 'UNKNOWN' : 'EMPTY';
        pages.push({ page: i + 1, kind, sample: r.textOps > 0 ? readableSample(r.text) : null });
      } catch {
        pages.push({ page: i + 1, kind: 'UNKNOWN', sample: null });
      }
    });
    return { pageCount, pages };
  } catch {
    return null;
  }
}

// ── Pages citées par la sortie T1 ─────────────────────────────────────────

interface CitedPages {
  /** Pages désignées explicitement (marques, preuves, tableaux, observations). */
  pages: Set<number>;
  /** La transcription porte des marques de page (pagination fiable de la lecture). */
  markers: boolean;
}

/** Pages explicitement citées par une sortie T1 (pure). Décalage de page d'un lot. */
export function citedPages(out: Pick<T1AnalyzeDocumentOutput, 'facts' | 'tables' | 'visual'> & { transcription?: string | null }, pageOffset = 0): CitedPages {
  const pages = new Set<number>();
  let markers = false;
  const add = (n: unknown) => { if (typeof n === 'number' && Number.isInteger(n) && n > 0) pages.add(n + pageOffset); };
  let courante = 1;
  let feuilles = false;
  for (const l of (out.transcription ?? '').split('\n')) {
    const m = pageMarker(l) ?? paginationFooter(l);
    if (m !== null) { markers = true; add(m); courante = m; }
    if (l.includes('\f')) { feuilles = true; courante += l.split('\f').length - 1; add(courante); }
  }
  if (feuilles) { markers = true; add(1); }
  for (const f of out.facts ?? []) { add(f.evidence?.page); add(f.visualEvidence?.page); }
  for (const t of out.tables ?? []) {
    if (typeof t.pageStart === 'number' && typeof t.pageEnd === 'number' && t.pageEnd >= t.pageStart && t.pageEnd - t.pageStart < 500) {
      for (let p = t.pageStart; p <= t.pageEnd; p++) add(p);
    } else { add(t.pageStart); add(t.pageEnd); }
  }
  for (const o of out.visual?.observations ?? []) add(o.page);
  return { pages, markers };
}

/** Part des mots distinctifs d'une page retrouvés dans la transcription (pure). null : échantillon trop pauvre. */
function pageMatchRatio(sample: string, transcriptionWords: ReadonlySet<string>): { ratio: number; words: number } | null {
  const distinctifs = [...new Set(mots(sample).filter((w) => w.length >= 5 && !/^\d+$/.test(w)))].slice(0, WORDS_MAX);
  if (distinctifs.length === 0) return null;
  const trouves = distinctifs.filter((w) => transcriptionWords.has(w)).length;
  return { ratio: trouves / distinctifs.length, words: distinctifs.length };
}

/**
 * Vérification d'un PDF (pure) : pages vérifiées, manquantes, non vérifiées,
 * scannées. `reread` : pages relues par une reprise ciblée réussie.
 */
export function verifyPdfCoverage(p: {
  probe: SourceProbe;
  cited: CitedPages;
  transcription: string;
  /** T1 a rendu un contenu (transcription, faits, tableaux ou observations). */
  hasContent: boolean;
  reread?: ReadonlySet<number>;
}): SourceVerification {
  const { probe, cited } = p;
  const motsTranscription = new Set(mots(p.transcription).filter((w) => w.length >= 5));
  const parPage = new Map(probe.pages.map((x) => [x.page, x]));
  const verified: number[] = [];
  const missing: number[] = [];
  const unverified: number[] = [];
  const scanned: number[] = [];
  const citeesNonVerifiees: number[] = [];
  for (let page = 1; page <= probe.pageCount; page++) {
    const s = parPage.get(page);
    if (s?.kind === 'SCANNED') scanned.push(page);
    if (p.reread?.has(page)) { verified.push(page); continue; }
    if (s?.kind === 'EMPTY') { verified.push(page); continue; }
    const m = s?.sample ? pageMatchRatio(s.sample, motsTranscription) : null;
    // 1. Échantillon textuel exploitable : il fait foi, comparé à la transcription.
    if (m && m.ratio >= MATCH_VERIFIED) { verified.push(page); continue; }
    const omission = !!m && m.ratio < MATCH_MISSING && m.words >= MIN_WORDS_FOR_MISSING;
    const citee = cited.pages.has(page);
    if (omission) {
      // Omission démontrée par la source : MANQUANTE même si un fait cite la page (TC13).
      missing.push(page);
      if (citee) citeesNonVerifiees.push(page);
      continue;
    }
    // 2. Correspondance partielle ou échantillon trop pauvre : la citation (ou un
    //    document d'une seule page lu) complète un indice textuel réel.
    if (m && (citee || (probe.pageCount === 1 && p.hasContent))) { verified.push(page); continue; }
    // 3. Aucun échantillon (scannée, police illisible) : une citation ne prouve
    //    jamais la page entière (TC14) — NON VÉRIFIÉE, sauf omission paginée.
    if (cited.markers && s?.kind !== 'SCANNED' && s !== undefined && !citee) { missing.push(page); continue; }
    if (citee) citeesNonVerifiees.push(page);
    unverified.push(page);
  }
  const status: SourceVerificationStatus = missing.length === 0 && unverified.length === 0 ? 'VERIFIED' : 'PARTIAL';
  return {
    status, pagesExpected: probe.pageCount, verified, missing, unverified, scanned,
    reason: missing.length > 0 ? 'pages_missing' : unverified.length > 0 ? 'pages_unverified' : null,
    ...(p.reread && p.reread.size > 0 ? { reread: [...p.reread].sort((a, b) => a - b) } : {}),
    ...(citeesNonVerifiees.length > 0 ? { citedUnverified: citeesNonVerifiees } : {}),
  };
}

/** Plages contiguës d'une liste de pages (pure) : [2,3,4,8] → [[2,4],[8,8]]. */
export function pageRanges(pages: readonly number[]): Array<{ start: number; end: number }> {
  const tri = [...new Set(pages)].sort((a, b) => a - b);
  const out: Array<{ start: number; end: number }> = [];
  for (const p of tri) {
    const last = out[out.length - 1];
    if (last && p === last.end + 1) last.end = p;
    else out.push({ start: p, end: p });
  }
  return out;
}

/** Vérification d'une source qui n'est pas un PDF unique (pure). */
export function verifyNonPdf(p: { mimeTypes: readonly string[]; textSource: boolean; hasContent: boolean }): SourceVerification {
  if (p.textSource) return verificationNotApplicable('text_source');
  const images = p.mimeTypes.length > 0 && p.mimeTypes.every((m) => m.startsWith('image/'));
  if (images) {
    // Image / document scanné : aucun texte original à confronter — la
    // couverture n'est pas vérifiable, l'incertitude est conservée (jamais
    // COMPLETE sur la seule foi d'une sortie IA cohérente).
    return { ...verificationUnverifiable(p.hasContent ? 'image_not_checkable' : 'image_without_content', p.mimeTypes.length), scanned: range(1, p.mimeTypes.length) };
  }
  return verificationUnverifiable(p.mimeTypes.length > 1 ? 'multiple_files' : 'format_not_checkable');
}
