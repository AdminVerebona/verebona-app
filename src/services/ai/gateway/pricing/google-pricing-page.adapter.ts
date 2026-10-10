/**
 * Adaptateur de la page tarifaire officielle Gemini — lot 35B, ticket
 * « Catalogue IA dynamique Google : modèles, tarifs, Preview et alertes BO ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCE
 *
 * Page officielle : https://ai.google.dev/gemini-api/docs/pricing
 * Lue dans son export Markdown, publié par Google pour chaque page de la
 * documentation : https://ai.google.dev/gemini-api/docs/pricing.md.txt
 * (structure relevée le 10/10/2026 : une section `## <Modèle>` par famille,
 * une ligne en italique portant le ou les identifiants entre accents graves,
 * des sous-sections `### Standard` / `### Batch` / `### Flex` /
 * `### Priority`, et un tableau « | Input price | Free… | Paid… | »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NE JAMAIS PRODUIRE SILENCIEUSEMENT UN TARIF FAUX
 *
 * L'adaptateur ne rend un tarif KNOWN que si TOUT est reconnu :
 *   · le modèle figure dans UNE seule section (identifiant exact) ;
 *   · la section a un palier « Standard » (la passerelle appelle l'API en
 *     synchrone, donc au tarif Standard) ou un tableau unique ;
 *   · une seule ligne « Input price » et une seule ligne « Output price » ;
 *   · chaque cellule « payante » ne contient que des formes connues :
 *       – un montant seul                         « $2.50 »
 *       – des montants par modalité, texte et image au MÊME prix
 *                                                 « $0.30 (text / image / video) $1.00 (audio) »
 *       – deux paliers de taille d'invite         « $1.25, prompts <= 200k tokens $2.50, prompts > 200k tokens »
 *       – des montants datés                      « $0.75 through Dec 31, 2026; $1.50 from Jan 1, 2027 »
 *     (une alternative « or $0.005/min » est ignorée : facturation à la
 *     durée, hors du calcul au jeton).
 * Toute autre forme, toute ambiguïté → UNKNOWN avec sa raison. Une page dont
 * la structure n'est plus reconnue (aucune section de modèle) est un ÉCHEC DE
 * LECTURE (`ok: false`) : rien n'est écrit, l'état connu est conservé et
 * l'échec est signalé — jamais « tous les modèles UNKNOWN ».
 *
 * Module PUR (aucun accès réseau ni base), testé sur des extraits
 * représentatifs (`__tests__/fixtures/google-pricing-*.md`).
 * ══════════════════════════════════════════════════════════════════════════
 */

export const GOOGLE_PRICING_PAGE_URL = 'https://ai.google.dev/gemini-api/docs/pricing';
export const GOOGLE_PRICING_SOURCE_URL = 'https://ai.google.dev/gemini-api/docs/pricing.md.txt';
export const GOOGLE_PRICING_SOURCE = 'google-pricing-page';

export type PriceTier =
  | { kind: 'prompt_tokens_above'; thresholdTokens: number; inputPerMillion: number; outputPerMillion: number }
  | { kind: 'dated'; from: string | null; to: string | null; inputPerMillion: number | null; outputPerMillion: number | null };

export type ResolvedPrice =
  | {
    status: 'KNOWN'; model: string; inputPerMillion: number; outputPerMillion: number;
    currency: 'USD'; tiers: PriceTier[]; section: string;
  }
  | { status: 'UNKNOWN'; model: string; reason: string };

export interface PricingSection {
  heading: string;
  modelIds: string[];
  /** Cellules « payantes » du palier Standard, ou raison de l'impossibilité. */
  input: string | null;
  output: string | null;
  problem: string | null;
}

export type ParsedPricingPage =
  | { ok: true; sections: PricingSection[] }
  | { ok: false; reason: string };

// ── Lecture de la structure ─────────────────────────────────────────────────

function unescapeMd(s: string): string {
  return s.replace(/\\([<>$_*`|\\[\]()#+.!-])/g, '$1');
}

function cellsOf(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split(/(?<!\\)\|/).map((c) => unescapeMd(c.replace(/<br\s*\/?>/gi, ' ')).replace(/\s+/g, ' ').trim());
}

const IS_SEPARATOR = /^\|?\s*:?-{2,}/;

/** Analyse la structure de l'export Markdown (pure). */
export function parseGooglePricingMarkdown(md: string): ParsedPricingPage {
  if (typeof md !== 'string' || md.trim() === '') return { ok: false, reason: 'page vide' };
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
    // Identifiants : lignes en italique (`*…*`) avant le premier tableau ou
    // sous-titre — la page y nomme le ou les modèles couverts.
    const ids: string[] = [];
    for (const l of s.lines) {
      if (/^\s*\|/.test(l) || /^###/.test(l)) break;
      if (!/^\s*[*_]/.test(l)) continue;
      for (const m of l.matchAll(/`([a-z0-9][a-z0-9.\-]*[a-z0-9])`/gi)) if (!ids.includes(m[1])) ids.push(m[1]);
    }
    if (ids.length === 0) continue;

    const sub: Array<{ title: string | null; rows: string[] }> = [{ title: null, rows: [] }];
    for (const l of s.lines) {
      const h3 = /^###\s+(.+?)\s*#*\s*$/.exec(l);
      if (h3) { sub.push({ title: unescapeMd(h3[1]).trim(), rows: [] }); continue; }
      if (/^\s*\|/.test(l)) sub[sub.length - 1].rows.push(l.trim());
    }
    const titres = sub.filter((x) => x.title !== null);
    let rows: string[];
    let problem: string | null = null;
    if (titres.length === 0) {
      rows = sub[0].rows;
    } else {
      const std = titres.filter((x) => /^standard\b/i.test(x.title!));
      if (std.length === 1) rows = std[0].rows;
      else { rows = []; problem = std.length === 0 ? 'aucun palier « Standard » dans la section' : 'plusieurs paliers « Standard »'; }
    }

    let input: string | null = null;
    let output: string | null = null;
    if (!problem) {
      if (rows.length === 0) problem = 'aucun tableau de prix';
      else {
        const header = cellsOf(rows[0]);
        const corps = rows.slice(1).filter((r) => !IS_SEPARATOR.test(r));
        let paid = header.findIndex((c) => /paid/i.test(c));
        if (paid < 0) paid = header.length - 1;
        const ins = corps.map(cellsOf).filter((c) => /^input price\b/i.test(c[0] ?? ''));
        const outs = corps.map(cellsOf).filter((c) => /^output price\b/i.test(c[0] ?? ''));
        if (ins.length !== 1) problem = ins.length === 0 ? 'ligne « Input price » absente' : 'plusieurs lignes « Input price »';
        else if (outs.length !== 1) problem = outs.length === 0 ? 'ligne « Output price » absente' : 'plusieurs lignes « Output price »';
        else {
          input = ins[0][paid] ?? null;
          output = outs[0][paid] ?? null;
          if (!input || !output) problem = 'colonne « Paid » introuvable';
        }
      }
    }
    out.push({ heading: s.heading, modelIds: ids, input, output, problem });
  }
  if (out.length === 0) {
    return { ok: false, reason: 'structure de la page non reconnue (aucune section de modèle identifiée)' };
  }
  return { ok: true, sections: out };
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

export type CellPrice =
  | { ok: true; amount: number; tier: { thresholdTokens: number; amount: number } | null; dated: Array<{ from: string | null; to: string | null; amount: number }> }
  | { ok: false; reason: string };

/**
 * Montant applicable d'une cellule « payante » à la date `asOf` (pure).
 * Toute forme non reconnue → `ok: false` (jamais un montant deviné).
 */
export function parsePriceCell(cell: string, asOf: Date): CellPrice {
  let s = unescapeMd(cell).replace(/\s+/g, ' ').trim();
  if (!s.includes('$')) return { ok: false, reason: `aucun montant (« ${s.slice(0, 60)} »)` };
  // Alternatives à la durée / à l'unité (« or $0.005/min ») : hors calcul au jeton.
  s = s.replace(/\s*\bor\s+\$\s?\d+(?:\.\d+)?\s*\/\s*(?:min|minute|sec|second|image|request)\b/gi, '');
  if (/\$\s?\d+(?:\.\d+)?\s*(?:\/|per\s+)(?:min|minute|sec|second|image|request|hour)/i.test(s)) {
    return { ok: false, reason: 'tarif à l’unité ou à la durée, hors calcul au jeton' };
  }
  const segs: Array<{ amount: number; q: Qualif }> = [];
  for (const m of s.matchAll(/\$\s?(\d+(?:\.\d+)?)([^$]*)/g)) {
    const q = classify(m[2]);
    if (!q) return { ok: false, reason: `condition non reconnue « ${m[2].trim().slice(0, 60)} »` };
    segs.push({ amount: Number(m[1]), q });
  }
  if (segs.length === 0) return { ok: false, reason: 'aucun montant lisible' };
  if (segs.some((x) => !Number.isFinite(x.amount) || x.amount < 0)) return { ok: false, reason: 'montant invalide' };
  const kinds = new Set(segs.map((x) => x.q.kind));
  if (kinds.size > 1) return { ok: false, reason: 'combinaison de conditions non prise en charge' };
  const kind = segs[0].q.kind;

  if (kind === 'plain') {
    return segs.length === 1 ? { ok: true, amount: segs[0].amount, tier: null, dated: [] } : { ok: false, reason: 'plusieurs montants sans condition' };
  }
  if (kind === 'modality') {
    const texte = segs.filter((x) => (x.q as { mods: Set<string> }).mods.has('text'));
    const image = segs.filter((x) => (x.q as { mods: Set<string> }).mods.has('image'));
    if (texte.length !== 1) return { ok: false, reason: 'prix du texte introuvable ou multiple' };
    // Verebona envoie texte ET images/PDF : un seul prix doit couvrir les deux.
    if (image.length !== 1 || image[0].amount !== texte[0].amount) return { ok: false, reason: 'tarif dépendant de la modalité (texte ≠ image)' };
    return { ok: true, amount: texte[0].amount, tier: null, dated: [] };
  }
  if (kind === 'tier') {
    const le = segs.filter((x) => (x.q as { op: string }).op === 'le');
    const gt = segs.filter((x) => (x.q as { op: string }).op === 'gt');
    if (segs.length !== 2 || le.length !== 1 || gt.length !== 1) return { ok: false, reason: 'paliers de taille d’invite non reconnus' };
    const a = (le[0].q as { thresholdTokens: number }).thresholdTokens;
    const b = (gt[0].q as { thresholdTokens: number }).thresholdTokens;
    if (a !== b) return { ok: false, reason: 'seuils de paliers incohérents' };
    return { ok: true, amount: le[0].amount, tier: { thresholdTokens: a, amount: gt[0].amount }, dated: [] };
  }
  // Montants datés : celui en vigueur à `asOf`.
  const jour = asOf.toISOString().slice(0, 10);
  const dated = segs.map((x) => ({ ...(x.q as { from: string | null; to: string | null }), amount: x.amount }));
  const enVigueur = dated.filter((d) => (d.from === null || d.from <= jour) && (d.to === null || jour <= d.to));
  if (enVigueur.length !== 1) return { ok: false, reason: 'aucun ou plusieurs montants datés en vigueur' };
  return { ok: true, amount: enVigueur[0].amount, tier: null, dated: dated.map(({ from, to, amount }) => ({ from, to, amount })) };
}

// ── Tarif d'un modèle ───────────────────────────────────────────────────────

/** Tarif d'un modèle à la date `asOf` (pur). */
export function resolveModelPrice(page: ParsedPricingPage, model: string, asOf: Date = new Date()): ResolvedPrice {
  if (!page.ok) return { status: 'UNKNOWN', model, reason: page.reason };
  const sections = page.sections.filter((s) => s.modelIds.includes(model));
  if (sections.length === 0) return { status: 'UNKNOWN', model, reason: 'absent de la page tarifaire officielle' };
  if (sections.length > 1) return { status: 'UNKNOWN', model, reason: 'présent dans plusieurs sections de la page (correspondance ambiguë)' };
  const s = sections[0];
  if (s.problem || !s.input || !s.output) return { status: 'UNKNOWN', model, reason: s.problem ?? 'prix introuvables' };
  const i = parsePriceCell(s.input, asOf);
  if (!i.ok) return { status: 'UNKNOWN', model, reason: `entrée : ${i.reason}` };
  const o = parsePriceCell(s.output, asOf);
  if (!o.ok) return { status: 'UNKNOWN', model, reason: `sortie : ${o.reason}` };

  const tiers: PriceTier[] = [];
  if (i.tier || o.tier) {
    if (i.tier && o.tier && i.tier.thresholdTokens !== o.tier.thresholdTokens) {
      return { status: 'UNKNOWN', model, reason: 'seuils de paliers différents entre entrée et sortie' };
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

  return {
    status: 'KNOWN', model, inputPerMillion: i.amount, outputPerMillion: o.amount,
    currency: 'USD', tiers, section: s.heading,
  };
}
