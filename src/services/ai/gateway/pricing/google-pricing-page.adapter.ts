/**
 * Adaptateur de la page tarifaire officielle Gemini — lot 35B, ticket
 * « Catalogue IA dynamique Google : modèles, tarifs, Preview et alertes BO » ;
 * lot 109L (ticket P1 « Tarifs Gemini non reconnus »), point A.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCE ET FORMATS RECONNUS
 *
 * Page officielle : https://ai.google.dev/gemini-api/docs/pricing (redirigée,
 * constat du 04/11/2026, vers https://aistudio.google.com/docs/pricing). Lue
 * dans son export texte https://ai.google.dev/gemini-api/docs/pricing.md.txt.
 * Trois structures sont reconnues, détectées sur le contenu (jamais sur
 * l'URL) et HISTORISÉES avec l'empreinte de la page (`pageFingerprint`) :
 *
 *   · `markdoc` — format constaté par l'audit du 04/11/2026 :
 *       {% tab title="Standard" %} … {% /tab %}  (ou {% endtab %})
 *       {% table %}
 *       * (vide)
 *       * Free Tier
 *       * Paid Tier, per 1M tokens in USD
 *       ---
 *       * Input price
 *       * Free of charge
 *       * $0.75 through December 31, 2026.
 *         $1.50 starting January 1, 2027.
 *       {% /table %}  (ou {% endtable %})
 *     Une cellule est un élément de liste ; une ligne de continuation indentée
 *     prolonge la cellule ; `---` sépare les lignes.
 *   · `pipe`    — export Markdown historique (relevé du 10/10/2026) :
 *       `### Standard` puis tableau `| Input price | Free… | Paid… |` ;
 *   · `rendered`— vue convertie d'une page HTML (tableaux à barres, `<br>`).
 * Une page HTML brute, vide ou sans section de modèle est un ÉCHEC DE LECTURE
 * (`ok: false`, code structuré) : rien n'est écrit, aucun tarif n'est retiré.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NE JAMAIS PRODUIRE SILENCIEUSEMENT UN TARIF FAUX
 *
 * L'adaptateur ne rend un tarif KNOWN que si TOUT est reconnu :
 *   · le modèle figure dans UNE seule section (identifiant exact, aucun alias) ;
 *   · la section a un onglet / sous-titre « Standard » (la passerelle appelle
 *     l'API en synchrone, donc au palier Standard — jamais Batch, Flex,
 *     Priority, Contributor) ou un tableau unique sans palier ;
 *   · la colonne « Paid » (jamais « Free ») ;
 *   · une seule ligne « Input price » et une seule ligne « Output price »
 *     (libellé « Output price (including thinking tokens) » compris : la
 *     sortie facturée INCLUT alors les jetons de raisonnement — relevé dans
 *     `thinkingIncluded`) ;
 *   · chaque cellule ne contient que des formes connues :
 *       – un montant seul                         « $2.50 »
 *       – des montants par modalité, texte et image/PDF au MÊME prix
 *                                                 « $0.30 (text / image / video) $1.00 (audio) »
 *       – deux paliers de taille d'invite         « $1.25, prompts <= 200k tokens $2.50, prompts > 200k tokens »
 *       – des montants datés                      « $0.75 through Dec 31, 2026; $1.50 from Jan 1, 2027 »
 *     (une alternative « or $0.005/min » est ignorée : facturation à la
 *     durée, hors du calcul au jeton) ; devise USD uniquement.
 * Toute autre forme, toute ambiguïté → UNKNOWN avec un CODE et une raison.
 *
 * Module PUR (aucun accès réseau ni base), testé sur des fixtures
 * (`__tests__/fixtures/google-pricing-*`), provenance et date en tête de
 * chaque fixture.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';

export const GOOGLE_PRICING_PAGE_URL = 'https://ai.google.dev/gemini-api/docs/pricing';
export const GOOGLE_PRICING_SOURCE_URL = 'https://ai.google.dev/gemini-api/docs/pricing.md.txt';
/** Redirection constatée le 04/11/2026 (audit du ticket 109L). */
export const GOOGLE_PRICING_REDIRECT_URL = 'https://aistudio.google.com/docs/pricing';
export const GOOGLE_PRICING_SOURCE = 'google-pricing-page';

export type PageFormat = 'markdoc' | 'pipe' | 'rendered' | 'html' | 'empty' | 'unknown';

/** Codes stables des refus (BO, journal, tests). */
export type PriceReasonCode =
  | 'PAGE_EMPTY' | 'PAGE_HTML' | 'PAGE_UNRECOGNIZED'
  | 'ABSENT' | 'AMBIGUOUS_SECTIONS' | 'NO_STANDARD_TIER' | 'MULTIPLE_STANDARD_TIERS'
  | 'NO_PRICE_TABLE' | 'MISSING_INPUT_ROW' | 'MISSING_OUTPUT_ROW' | 'DUPLICATE_ROW' | 'NO_PAID_COLUMN'
  | 'UNSUPPORTED_CELL' | 'MODALITY_DEPENDENT' | 'PER_UNIT_PRICING' | 'NO_DATED_PRICE_IN_FORCE'
  | 'TIER_MISMATCH' | 'CURRENCY';

export type PriceTier =
  | { kind: 'prompt_tokens_above'; thresholdTokens: number; inputPerMillion: number; outputPerMillion: number }
  | { kind: 'dated'; from: string | null; to: string | null; inputPerMillion: number | null; outputPerMillion: number | null };

export type ResolvedPrice =
  | {
    status: 'KNOWN'; model: string; inputPerMillion: number; outputPerMillion: number;
    currency: 'USD'; tiers: PriceTier[]; section: string;
    /** Libellé « including thinking tokens » : la sortie facturée inclut le raisonnement. */
    thinkingIncluded?: boolean;
  }
  | { status: 'UNKNOWN'; model: string; reason: string; code?: PriceReasonCode };

interface PricingSection {
  heading: string;
  modelIds: string[];
  /** Cellules « payantes » du palier Standard, ou raison de l'impossibilité. */
  input: string | null;
  output: string | null;
  problem: string | null;
  problemCode?: PriceReasonCode | null;
  outputLabel?: string | null;
}

export type ParsedPricingPage =
  | { ok: true; sections: PricingSection[]; format?: PageFormat }
  | { ok: false; reason: string; code?: PriceReasonCode; format?: PageFormat };

// ── Empreinte et format ────────────────────────────────────────────────────

/** Empreinte SHA-256 du contenu lu (historisée, visible au BO). */
export function pageFingerprint(text: string): string {
  return createHash('sha256').update(text ?? '', 'utf8').digest('hex');
}

/** Format détecté sur le CONTENU (pur). */
export function detectPricingFormat(text: string): PageFormat {
  if (typeof text !== 'string' || text.trim() === '') return 'empty';
  const t = text.slice(0, 400_000);
  if (/\{%\s*(tab|table|tabs)\b/.test(t)) return 'markdoc';
  if (/^\s*<!doctype html|^\s*<html[\s>]/i.test(t)) return 'html';
  if (/^\s*\|.*\|\s*$/m.test(t) && /^###\s+/m.test(t)) return 'pipe';
  if (/^\s*\|.*\|\s*$/m.test(t)) return /<br\s*\/?>/i.test(t) ? 'rendered' : 'pipe';
  return 'unknown';
}

/** Extrait court et sans secret (aucun : page publique) pour le BO. */
export function pageSample(text: string, max = 600): string {
  return (text ?? '').replace(/\r\n?/g, '\n').slice(0, max);
}

// ── Lecture de la structure ─────────────────────────────────────────────────

function unescapeMd(s: string): string {
  return s.replace(/\\([<>$_*`|\\[\]()#+.!-])/g, '$1');
}

function cleanCell(c: string): string {
  return unescapeMd(c.replace(/<br\s*\/?>/gi, ' ')).replace(/\s+/g, ' ').trim();
}

function pipeCells(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split(/(?<!\\)\|/).map(cleanCell);
}

const IS_PIPE_SEPARATOR = /^\|?\s*:?-{2,}/;

type Table = string[][];
interface Block { title: string | null; tables: Table[] }

/** Tableaux d'un bloc de lignes : `{% table %}` (listes) et tableaux à barres. */
function tablesOf(lines: string[]): Table[] {
  const out: Table[] = [];
  let pipe: Table | null = null;
  let mark: { rows: Table; row: string[]; cell: string | null } | null = null;
  const flushCell = () => { if (mark && mark.cell !== null) { mark.row.push(cleanCell(mark.cell)); mark.cell = null; } };
  const flushRow = () => { flushCell(); if (mark && mark.row.length) { mark.rows.push(mark.row); mark.row = []; } };
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    if (mark) {
      if (/^\s*\{%\s*(\/table|endtable)\s*%\}/.test(l)) { flushRow(); out.push(mark.rows); mark = null; continue; }
      if (/^\s*-{3,}\s*$/.test(l)) { flushRow(); continue; }
      const item = /^\s*[*-]\s?(.*)$/.exec(l);
      if (item && !/^\s{4,}/.test(l)) { flushCell(); mark.cell = item[1]; continue; }
      if (l.trim() === '') continue;
      if (mark.cell !== null) mark.cell += ` ${l.trim()}`;
      continue;
    }
    if (/^\s*\{%\s*table\b[^%]*%\}/.test(l)) { if (pipe) { out.push(pipe); pipe = null; } mark = { rows: [], row: [], cell: null }; continue; }
    if (/^\s*\|/.test(l)) {
      if (IS_PIPE_SEPARATOR.test(l.trim())) continue;
      (pipe ??= []).push(pipeCells(l));
      continue;
    }
    if (pipe) { out.push(pipe); pipe = null; }
  }
  if (pipe) out.push(pipe);
  if (mark) { flushRow(); out.push(mark.rows); }
  return out;
}

/** Blocs d'une section : avant tout palier (titre null), puis un par onglet ou sous-titre. */
function blocksOf(lines: string[]): Block[] {
  const blocks: Array<{ title: string | null; lines: string[] }> = [{ title: null, lines: [] }];
  let inTab = false;
  for (const l of lines) {
    const tab = /^\s*\{%\s*tab\s+title\s*=\s*["“]([^"”]+)["”][^%]*%\}/.exec(l);
    if (tab) { blocks.push({ title: tab[1].trim(), lines: [] }); inTab = true; continue; }
    if (/^\s*\{%\s*(\/tab|endtab)\s*%\}/.test(l)) { if (inTab) blocks.push({ title: null, lines: [] }); inTab = false; continue; }
    if (/^\s*\{%\s*(tabs|\/tabs|endtabs)\b[^%]*%\}/.test(l)) continue;
    const h3 = /^###\s+(.+?)\s*#*\s*$/.exec(l);
    if (h3 && !inTab) { blocks.push({ title: unescapeMd(h3[1]).trim(), lines: [] }); continue; }
    blocks[blocks.length - 1].lines.push(l);
  }
  return blocks.map((b) => ({ title: b.title, tables: tablesOf(b.lines) })).filter((b) => b.title !== null || b.tables.length > 0);
}

/** Identifiants exacts : lignes en italique (`*…*`, `_…_`, `<em>`) portant des accents graves. */
function idsOf(lines: string[]): string[] {
  const ids: string[] = [];
  for (const l of lines) {
    if (/^\s*\|/.test(l) || /^###/.test(l) || /^\s*\{%/.test(l)) break;
    // Italique (`*[`…`]*`, `_…_`) — jamais un élément de liste « * texte ».
    if (!/^\s*(?:[*_](?![\s*])|<em>)/.test(l)) continue;
    for (const m of l.matchAll(/`([a-z0-9][a-z0-9.\-]*[a-z0-9])`/gi)) if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/** Analyse la structure de la page (pure). */
export function parseGooglePricingMarkdown(md: string): ParsedPricingPage {
  const format = detectPricingFormat(md);
  if (format === 'empty') return { ok: false, reason: 'page vide', code: 'PAGE_EMPTY', format };
  if (format === 'html') {
    return { ok: false, reason: 'structure de la page non reconnue (HTML brut au lieu de l’export texte)', code: 'PAGE_HTML', format };
  }
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let cur: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const h2 = /^##\s+(?!#)(.+?)\s*#*\s*$/.exec(line);
    if (h2) { cur = { heading: unescapeMd(h2[1]).trim(), lines: [] }; sections.push(cur); continue; }
    if (/^#\s/.test(line)) { cur = null; continue; }
    cur?.lines.push(line);
  }

  const out: PricingSection[] = [];
  for (const s of sections) {
    const ids = idsOf(s.lines);
    if (ids.length === 0) continue;
    const blocks = blocksOf(s.lines);
    const titres = blocks.filter((b) => b.title !== null);
    let tables: Table[];
    let problem: string | null = null;
    let problemCode: PriceReasonCode | null = null;
    if (titres.length === 0) {
      tables = blocks.flatMap((b) => b.tables);
    } else {
      const std = titres.filter((b) => /^standard\b/i.test(b.title!));
      if (std.length === 1) tables = std[0].tables;
      else {
        tables = [];
        problem = std.length === 0 ? 'aucun palier « Standard » dans la section' : 'plusieurs paliers « Standard »';
        problemCode = std.length === 0 ? 'NO_STANDARD_TIER' : 'MULTIPLE_STANDARD_TIERS';
      }
    }

    let input: string | null = null;
    let output: string | null = null;
    let outputLabel: string | null = null;
    if (!problem) {
      const avecPrix = tables.filter((t) => t.some((r) => /^input price\b/i.test(r[0] ?? '')));
      if (avecPrix.length === 0) { problem = tables.length === 0 ? 'aucun tableau de prix' : 'ligne « Input price » absente'; problemCode = tables.length === 0 ? 'NO_PRICE_TABLE' : 'MISSING_INPUT_ROW'; }
      else if (avecPrix.length > 1) { problem = 'plusieurs tableaux de prix dans le palier Standard'; problemCode = 'DUPLICATE_ROW'; }
      else {
        const t = avecPrix[0];
        const header = t[0] ?? [];
        const corps = t.slice(1);
        let paid = header.findIndex((c) => /paid/i.test(c));
        if (paid < 0) paid = header.length - 1;
        const ins = corps.filter((c) => /^input price\b/i.test(c[0] ?? ''));
        const outs = corps.filter((c) => /^output price\b/i.test(c[0] ?? ''));
        if (ins.length !== 1) { problem = ins.length === 0 ? 'ligne « Input price » absente' : 'plusieurs lignes « Input price »'; problemCode = ins.length === 0 ? 'MISSING_INPUT_ROW' : 'DUPLICATE_ROW'; }
        else if (outs.length !== 1) { problem = outs.length === 0 ? 'ligne « Output price » absente' : 'plusieurs lignes « Output price »'; problemCode = outs.length === 0 ? 'MISSING_OUTPUT_ROW' : 'DUPLICATE_ROW'; }
        else {
          input = ins[0][paid] ?? null;
          output = outs[0][paid] ?? null;
          outputLabel = outs[0][0] ?? null;
          if (!input || !output) { problem = 'colonne « Paid » introuvable'; problemCode = 'NO_PAID_COLUMN'; }
        }
      }
    }
    out.push({ heading: s.heading, modelIds: ids, input, output, problem, problemCode, outputLabel });
  }
  if (out.length === 0) {
    return { ok: false, reason: 'structure de la page non reconnue (aucune section de modèle identifiée)', code: 'PAGE_UNRECOGNIZED', format };
  }
  return { ok: true, sections: out, format };
}

// ── Lecture d'une cellule de prix ───────────────────────────────────────────

const MOIS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** « Dec 31, 2026 » → « 2026-12-31 » ; `null` si non reconnu. */
export function parseEnglishDate(s: string): string | null {
  const m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const mois = MOIS[m[1].slice(0, 4).toLowerCase()] ?? MOIS[m[1].slice(0, 3).toLowerCase()];
  const jour = Number(m[2]);
  if (!mois || jour < 1 || jour > 31) return null;
  return `${m[3]}-${String(mois).padStart(2, '0')}-${String(jour).padStart(2, '0')}`;
}

type Qualif =
  | { kind: 'plain' }
  | { kind: 'modality'; mods: Set<string> }
  | { kind: 'tier'; op: 'le' | 'gt'; thresholdTokens: number }
  | { kind: 'dated'; from: string | null; to: string | null };

function classify(q: string): Qualif | null {
  const s = q.trim().replace(/^[,;:]\s*/, '').replace(/[;,.]\s*$/, '').trim().toLowerCase();
  if (s === '') return { kind: 'plain' };
  const mod = /^\(?\s*((?:text|image|images|video|audio|pdf)(?:\s*(?:\/|,|&|and)\s*(?:text|image|images|video|audio|pdf))*)\s*\)?$/.exec(s);
  if (mod) return { kind: 'modality', mods: new Set(mod[1].split(/\s*(?:\/|,|&|and)\s*/).map((x) => x.replace(/s$/, ''))) };
  const tier = /^prompts?\s*(<=|≤|<|up to|>|above|over|longer than)\s*(\d+(?:\.\d+)?)\s*(k|m)?\s*(?:tokens?)?$/.exec(s);
  if (tier) {
    const n = Number(tier[2]) * (tier[3] === 'm' ? 1_000_000 : tier[3] === 'k' ? 1_000 : 1);
    return { kind: 'tier', op: /^(<=|≤|<|up to)$/.test(tier[1]) ? 'le' : 'gt', thresholdTokens: n };
  }
  const through = /^(?:through|until|till)\s+(.+)$/.exec(s);
  if (through) { const d = parseEnglishDate(through[1]); return d ? { kind: 'dated', from: null, to: d } : null; }
  const from = /^(?:from|starting|as of|effective)\s+(.+)$/.exec(s);
  if (from) { const d = parseEnglishDate(from[1]); return d ? { kind: 'dated', from: d, to: null } : null; }
  return null;
}

type CellPrice =
  | { ok: true; amount: number; tier: { thresholdTokens: number; amount: number } | null; dated: Array<{ from: string | null; to: string | null; amount: number }> }
  | { ok: false; reason: string; code?: PriceReasonCode };

/**
 * Montant applicable d'une cellule « payante » à la date `asOf` (pure).
 * Toute forme non reconnue → `ok: false` (jamais un montant deviné).
 */
export function parsePriceCell(cell: string, asOf: Date): CellPrice {
  let s = unescapeMd(cell).replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
  if (/[€£¥]/.test(s)) return { ok: false, reason: 'devise autre que USD', code: 'CURRENCY' };
  if (!s.includes('$')) return { ok: false, reason: `aucun montant (« ${s.slice(0, 60)} »)`, code: 'UNSUPPORTED_CELL' };
  // Alternatives à la durée / à l'unité (« or $0.005/min ») : hors calcul au jeton.
  s = s.replace(/\s*\bor\s+\$\s?\d+(?:\.\d+)?\s*\/\s*(?:min|minute|sec|second|image|request)\b/gi, '');
  if (/\$\s?\d+(?:\.\d+)?\s*(?:\/|per\s+)(?:min|minute|sec|second|image|request|hour)/i.test(s)) {
    return { ok: false, reason: 'tarif à l’unité ou à la durée, hors calcul au jeton', code: 'PER_UNIT_PRICING' };
  }
  const segs: Array<{ amount: number; q: Qualif }> = [];
  for (const m of s.matchAll(/\$\s?(\d+(?:\.\d+)?)([^$]*)/g)) {
    const q = classify(m[2]);
    if (!q) return { ok: false, reason: `condition non reconnue « ${m[2].trim().slice(0, 60)} »`, code: 'UNSUPPORTED_CELL' };
    segs.push({ amount: Number(m[1]), q });
  }
  if (segs.length === 0) return { ok: false, reason: 'aucun montant lisible', code: 'UNSUPPORTED_CELL' };
  if (segs.some((x) => !Number.isFinite(x.amount) || x.amount < 0)) return { ok: false, reason: 'montant invalide', code: 'UNSUPPORTED_CELL' };
  const kinds = new Set(segs.map((x) => x.q.kind));
  if (kinds.size > 1) return { ok: false, reason: 'combinaison de conditions non prise en charge', code: 'UNSUPPORTED_CELL' };
  const kind = segs[0].q.kind;

  if (kind === 'plain') {
    return segs.length === 1 ? { ok: true, amount: segs[0].amount, tier: null, dated: [] } : { ok: false, reason: 'plusieurs montants sans condition', code: 'UNSUPPORTED_CELL' };
  }
  if (kind === 'modality') {
    const texte = segs.filter((x) => (x.q as { mods: Set<string> }).mods.has('text'));
    const image = segs.filter((x) => (x.q as { mods: Set<string> }).mods.has('image') || (x.q as { mods: Set<string> }).mods.has('pdf'));
    if (texte.length !== 1) return { ok: false, reason: 'prix du texte introuvable ou multiple', code: 'MODALITY_DEPENDENT' };
    // Verebona envoie texte ET images/PDF : un seul prix doit couvrir les deux.
    if (image.length !== 1 || image[0].amount !== texte[0].amount) return { ok: false, reason: 'tarif dépendant de la modalité (texte ≠ image)', code: 'MODALITY_DEPENDENT' };
    return { ok: true, amount: texte[0].amount, tier: null, dated: [] };
  }
  if (kind === 'tier') {
    const le = segs.filter((x) => (x.q as { op: string }).op === 'le');
    const gt = segs.filter((x) => (x.q as { op: string }).op === 'gt');
    if (segs.length !== 2 || le.length !== 1 || gt.length !== 1) return { ok: false, reason: 'paliers de taille d’invite non reconnus', code: 'UNSUPPORTED_CELL' };
    const a = (le[0].q as { thresholdTokens: number }).thresholdTokens;
    const b = (gt[0].q as { thresholdTokens: number }).thresholdTokens;
    if (a !== b) return { ok: false, reason: 'seuils de paliers incohérents', code: 'TIER_MISMATCH' };
    return { ok: true, amount: le[0].amount, tier: { thresholdTokens: a, amount: gt[0].amount }, dated: [] };
  }
  // Montants datés : celui en vigueur à `asOf`.
  const jour = asOf.toISOString().slice(0, 10);
  const dated = segs.map((x) => ({ ...(x.q as { from: string | null; to: string | null }), amount: x.amount }));
  const enVigueur = dated.filter((d) => (d.from === null || d.from <= jour) && (d.to === null || jour <= d.to));
  if (enVigueur.length !== 1) return { ok: false, reason: 'aucun ou plusieurs montants datés en vigueur', code: 'NO_DATED_PRICE_IN_FORCE' };
  return { ok: true, amount: enVigueur[0].amount, tier: null, dated: dated.map(({ from, to, amount }) => ({ from, to, amount })) };
}

// ── Tarif d'un modèle ───────────────────────────────────────────────────────

/** Tarif d'un modèle à la date `asOf` (pur). */
export function resolveModelPrice(page: ParsedPricingPage, model: string, asOf: Date = new Date()): ResolvedPrice {
  if (!page.ok) return { status: 'UNKNOWN', model, reason: page.reason, code: page.code ?? 'PAGE_UNRECOGNIZED' };
  const sections = page.sections.filter((s) => s.modelIds.includes(model));
  if (sections.length === 0) return { status: 'UNKNOWN', model, reason: 'absent de la page tarifaire officielle', code: 'ABSENT' };
  if (sections.length > 1) return { status: 'UNKNOWN', model, reason: 'présent dans plusieurs sections de la page (correspondance ambiguë)', code: 'AMBIGUOUS_SECTIONS' };
  const s = sections[0];
  if (s.problem || !s.input || !s.output) return { status: 'UNKNOWN', model, reason: s.problem ?? 'prix introuvables', code: s.problemCode ?? 'NO_PRICE_TABLE' };
  const i = parsePriceCell(s.input, asOf);
  if (!i.ok) return { status: 'UNKNOWN', model, reason: `entrée : ${i.reason}`, code: i.code ?? 'UNSUPPORTED_CELL' };
  const o = parsePriceCell(s.output, asOf);
  if (!o.ok) return { status: 'UNKNOWN', model, reason: `sortie : ${o.reason}`, code: o.code ?? 'UNSUPPORTED_CELL' };

  const tiers: PriceTier[] = [];
  if (i.tier || o.tier) {
    if (i.tier && o.tier && i.tier.thresholdTokens !== o.tier.thresholdTokens) {
      return { status: 'UNKNOWN', model, reason: 'seuils de paliers différents entre entrée et sortie', code: 'TIER_MISMATCH' };
    }
    const seuil = (i.tier ?? o.tier)!.thresholdTokens;
    tiers.push({
      kind: 'prompt_tokens_above', thresholdTokens: seuil,
      inputPerMillion: i.tier?.amount ?? i.amount, outputPerMillion: o.tier?.amount ?? o.amount,
    });
  }
  const bornes = new Map<string, { from: string | null; to: string | null; inputPerMillion: number | null; outputPerMillion: number | null }>();
  for (const [cote, d] of [['in', i.dated], ['out', o.dated]] as const) {
    for (const x of d) {
      const k = `${x.from ?? ''}|${x.to ?? ''}`;
      const e = bornes.get(k) ?? { from: x.from, to: x.to, inputPerMillion: null, outputPerMillion: null };
      if (cote === 'in') e.inputPerMillion = x.amount; else e.outputPerMillion = x.amount;
      bornes.set(k, e);
    }
  }
  for (const e of bornes.values()) tiers.push({ kind: 'dated', ...e });

  const thinkingIncluded = /including thinking|thinking tokens/i.test(s.outputLabel ?? '') || /text and thinking/i.test(s.output);
  return {
    status: 'KNOWN', model, inputPerMillion: i.amount, outputPerMillion: o.amount,
    currency: 'USD', tiers, section: s.heading,
    ...(thinkingIncluded ? { thinkingIncluded: true } : {}),
  };
}

/** Bilan global de lecture (pur) : modèles présents et tarifables sur la page. */
export function pageCoverage(page: ParsedPricingPage, asOf: Date = new Date()): { sections: number; modelIds: number; known: number } {
  if (!page.ok) return { sections: 0, modelIds: 0, known: 0 };
  const ids = [...new Set(page.sections.flatMap((s) => s.modelIds))];
  return { sections: page.sections.length, modelIds: ids.length, known: ids.filter((m) => resolveModelPrice(page, m, asOf).status === 'KNOWN').length };
}
