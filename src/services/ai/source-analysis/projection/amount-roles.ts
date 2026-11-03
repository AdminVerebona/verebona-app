/**
 * Lot 107D — RÔLES DES MONTANTS d'un justificatif à plusieurs articles
 * (ticket P1 « Draisienne : total du ticket proposé comme prix d'un article,
 * arbitrage réapparu »). FONCTIONS PURES : aucune base, aucun modèle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Un ticket de caisse porte plusieurs montants de natures DIFFÉRENTES :
 * prix unitaire, quantité, montant de ligne, remise de ligne, remise globale,
 * coupon, frais, sous-total, taxes, total payé, paiement, monnaie rendue. Le
 * contrat T1 actuel ne les type pas (`document.amountCents` = total du
 * document, faits sans rôle), et plusieurs chemins — règle « justificatif
 * d'achat du bien », fait `acquisitionPrice` du modèle, prix d'achat ancré
 * dans un candidat Opération (T3 76J) — pouvaient faire du TOTAL DU PANIER le
 * prix d'UN article.
 *
 * Ce module relit ce que la source CONTIENT (transcription / unités de la
 * couche A `document_source_units`, tableaux, montant du document) et rend :
 *   · `ReceiptProfile` : lignes d'articles (désignation, quantité, prix
 *     unitaire, montant de ligne, remise de ligne rattachée), lignes de
 *     synthèse typées, montants « panier » (total, sous-total, paiement) ;
 *   · `classifyAmount` : rôle d'un montant donné dans ce justificatif ;
 *   · `attributeArticle` : la ligne d'un objet identifié (désignation,
 *     marque / modèle / référence), avec ABSTENTION motivée dès que
 *     l'attribution n'est pas démontrable (aucune ligne, plusieurs lignes
 *     candidates, lot, quantité > 1 sans prix unitaire écrit, remise globale
 *     ou coupon, remboursement).
 *
 * Aucune règle sur un montant, une marque ou un type d'objet précis : seuls
 * des MOTS DE STRUCTURE de ticket (total, TVA, remise, CB…) et la
 * correspondance de la désignation avec l'objet comptent.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Rôle d'un montant dans un justificatif (vocabulaire stable : tracé dans les diagnostics). */
export type AmountRole =
  | 'UNIT_PRICE' | 'QUANTITY' | 'LINE_AMOUNT' | 'LINE_DISCOUNT' | 'GLOBAL_DISCOUNT' | 'COUPON' | 'FEES'
  | 'SUBTOTAL' | 'TAX' | 'TOTAL_PAID' | 'PAYMENT' | 'CHANGE' | 'DEPOSIT' | 'REFUND' | 'UNKNOWN';

/** Rôles « panier » : montant de la TRANSACTION, jamais le prix d'un article identifié. */
export const BASKET_ROLES: ReadonlySet<AmountRole> = new Set(['TOTAL_PAID', 'SUBTOTAL', 'PAYMENT']);

/** Ligne brute lue (une ligne physique de transcription, une ligne de tableau, un couple libellé / valeur). */
export interface RawReceiptLine {
  /** Unité de la couche A (`page:1:block:3`, `page:1:table:1:row:2`…) ; null hors couche A. */
  unitId: string | null;
  text: string;
  /** Cellules d'une ligne de tableau (en-tête de colonne → valeur). */
  cells?: Array<{ header: string | null; value: string | null }>;
}

export interface ArticleLine {
  /** Rang de lecture parmi les lignes brutes. */
  index: number;
  unitId: string | null;
  text: string;
  designation: string;
  quantity: number | null;
  unitPriceCents: number | null;
  lineAmountCents: number;
  /** Remise de LIGNE (montant positif) rattachée à cet article (ligne suivante explicite). */
  discountCents: number | null;
  discountUnitId: string | null;
  /** Montant net de la ligne (ligne − remise de ligne). */
  netCents: number;
  /** Ligne de retour / remboursement (montant négatif sans mot de remise). */
  refund: boolean;
  /** Lot, pack, offre groupée (« lot de 3 », « 2 pour 1 », « offert »). */
  bundle: boolean;
}

export interface SummaryLine {
  index: number;
  unitId: string | null;
  text: string;
  role: AmountRole;
  cents: number;
}

export interface ReceiptProfile {
  articles: ArticleLine[];
  summaries: SummaryLine[];
  /** Montant du document lu par T1 (`document.amountCents`, unité `doc:meta:amount`). */
  documentTotalCents: number | null;
  /** Plusieurs articles (ou plusieurs exemplaires) : le total n'est pas le prix d'un article. */
  multiArticle: boolean;
  /** Nombre d'articles annoncé par le ticket (« 3 articles »), s'il est écrit. */
  declaredArticleCount: number | null;
  /** Montants de la transaction (total payé, sous-total, paiement, total du document, somme des lignes). */
  basketCents: number[];
  /** Remises globales, coupons, frais communs : aucune quote-part attribuable sans règle explicite. */
  globalAdjustments: SummaryLine[];
  /** Somme des lignes nettes + frais − remises globales = total payé (à 2 centimes près). */
  reconciled: boolean;
}

// ── Lecture des montants ───────────────────────────────────────────────────

const sansAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const plat = (s: string) => sansAccents(s).toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Montant en fin de ligne : « 69,99 », « 69.99 € », « -10,00 », « 10,00- »,
 * « 1 234,50 EUR », suivi éventuellement d'un code TVA d'un caractère (« A »).
 */
const MONTANT_FIN = /(-)?\s*(\d{1,3}(?:[  .]\d{3})+|\d+)[,.](\d{2})\s*(-)?\s*(?:€|eur(?:os?)?)?\s*(?:\b[a-z0-9]\b)?\s*$/i;
/** Quantité × prix unitaire dans la ligne : « 2 x 10,00 », « 2X10.00 », « 3 × 4,50 ». */
const QTE_PU = /(?:^|\s)(\d{1,3})\s*[x×*]\s*(\d+)[,.](\d{2})(?!\d)/i;
/** Quantité en tête ou annoncée : « 2 STYLO », « Qté : 2 », « x2 ». */
const QTE_TETE = /^(\d{1,3})\s+(?=[a-zà-ÿ])/i;
const QTE_LIBELLE = /\b(?:qte|qté|quantite|quantité|qty)\s*[:=]?\s*(\d{1,3})\b/i;
const QTE_X = /(?:^|\s)x\s?(\d{1,3})(?=\s|$)/i;

export function parseMoneyCents(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  const m = MONTANT_FIN.exec(String(raw).trim());
  if (!m) return null;
  const entier = Number(m[2].replace(/[  .]/g, ''));
  const cents = entier * 100 + Number(m[3]);
  return m[1] || m[4] ? -cents : cents;
}

/** Montant en fin de ligne et texte qui le précède. */
function montantFinal(text: string): { cents: number; before: string } | null {
  const t = text.trim();
  const m = MONTANT_FIN.exec(t);
  if (!m || m.index === undefined) return null;
  // Fin d'un numéro (téléphone, SIRET, date, heure) : jamais un montant.
  const debut = m.index + m[0].indexOf(m[2]);
  if (debut > 0 && /[\d.,:/]/.test(t[debut - 1])) return null;
  const cents = parseMoneyCents(m[0]);
  if (cents === null) return null;
  return { cents, before: t.slice(0, m.index).trim() };
}

// ── Mots de structure (jamais des mots d'objet) ────────────────────────────

const M = {
  sousTotal: /\b(sous[- ]?total|total ht|montant ht|base ht|\bht\b)/,
  tva: /\b(tva|t\.v\.a|taxe(?!.*eco))\b/,
  total: /\b(total(?: ttc| a payer| du| general)?|net a payer|montant (?:ttc|total|du|a payer)|a payer|somme due)\b/,
  paiement: /\b(cb|c\.b|carte(?: bancaire| bleue)?|visa|mastercard|maestro|amex|sans contact|especes|cheque|paiement|reglement|regle|paye|virement|titre restaurant|ticket restaurant)\b/,
  rendu: /\b(rendu|monnaie|a rendre)\b/,
  remise: /\b(remise|reduction|promo(?:tion)?|rabais|escompte|fidelite|avantage|economie)\b/,
  coupon: /\b(coupon|bon d.?achat|bon de reduction|code promo|carte cadeau|cheque cadeau|e-?carte)\b/,
  frais: /\b(frais|livraison|port|expedition|emballage|eco[- ]?participation|consigne)\b/,
  acompte: /\b(acompte|arrhes|deja (?:regle|paye|verse))\b/,
  lot: /\b(lot de|pack|coffret de|\d+\s*(?:pour|=)\s*\d+|offert|gratuit)\b/,
  nbArticles: /\b(\d{1,3})\s*(?:articles?|art\.?|produits?)\b|\b(?:nb|nombre)\.?\s*(?:d.?)?articles?\s*[:=]?\s*(\d{1,3})\b/,
};

function roleSynthese(texte: string): AmountRole | null {
  const t = plat(texte);
  if (M.rendu.test(t)) return 'CHANGE';
  if (M.acompte.test(t)) return 'DEPOSIT';
  if (M.coupon.test(t)) return 'COUPON';
  if (M.sousTotal.test(t)) return 'SUBTOTAL';
  if (M.tva.test(t)) return 'TAX';
  if (M.total.test(t)) return 'TOTAL_PAID';
  if (M.paiement.test(t)) return 'PAYMENT';
  if (M.remise.test(t)) return 'GLOBAL_DISCOUNT';
  if (M.frais.test(t)) return 'FEES';
  return null;
}

// ── Lignes de tableau ──────────────────────────────────────────────────────

const H = {
  designation: /(designation|libelle|article|produit|description|intitule|reference|ref\b)/,
  quantite: /\b(qte|quantite|qty|nb|nombre)\b/,
  unitaire: /(p\.?\s?u\b|prix unit|unitaire|unit price|pu ttc|pu ht)/,
  montant: /(montant|total|prix|ttc|valeur)/,
  remise: /(remise|reduction|rabais)/,
};

function ligneDeTableau(l: RawReceiptLine): { designation: string; quantity: number | null; unitPriceCents: number | null; lineAmountCents: number | null; discountCents: number | null } | null {
  if (!l.cells?.length) return null;
  let designation = ''; let quantity: number | null = null; let unit: number | null = null; let montant: number | null = null; let remise: number | null = null;
  for (const c of l.cells) {
    const h = plat(c.header ?? '');
    const v = (c.value ?? '').toString().trim();
    if (!v) continue;
    if (H.remise.test(h)) { const x = parseMoneyCents(v); if (x !== null) remise = Math.abs(x); continue; }
    if (H.unitaire.test(h)) { unit = parseMoneyCents(v); continue; }
    if (H.quantite.test(h)) { const q = Number(v.replace(',', '.')); if (Number.isFinite(q) && q > 0) quantity = q; continue; }
    if (H.designation.test(h) && !designation) { designation = v; continue; }
    if (H.montant.test(h)) { montant = parseMoneyCents(v); continue; }
    if (!designation && /[a-zà-ÿ]{2}/i.test(v) && parseMoneyCents(v) === null) designation = v;
  }
  if (!designation) return null;
  return { designation, quantity, unitPriceCents: unit, lineAmountCents: montant, discountCents: remise };
}

// ── Profil du justificatif ─────────────────────────────────────────────────

/**
 * Profil d'un justificatif à partir de ses lignes brutes, dans l'ordre de
 * lecture. `documentTotalCents` : montant du document lu par T1.
 */
export function buildReceiptProfile(lines: readonly RawReceiptLine[], documentTotalCents: number | null = null): ReceiptProfile {
  const articles: ArticleLine[] = [];
  const summaries: SummaryLine[] = [];
  let declaredArticleCount: number | null = null;
  let synthesePassee = false;

  lines.forEach((l, index) => {
    const text = l.text.replace(/\s+/g, ' ').trim();
    if (!text && !l.cells?.length) return;
    const nb = M.nbArticles.exec(plat(text));
    if (nb) {
      // « 3 articles » (avec ou sans montant) : nombre d'articles annoncé ; le montant éventuel est le total.
      declaredArticleCount = Number(nb[1] ?? nb[2]);
      const f = montantFinal(text);
      if (f) { summaries.push({ index, unitId: l.unitId, text, role: 'TOTAL_PAID', cents: Math.abs(f.cents) }); synthesePassee = true; }
      return;
    }

    // Ligne de tableau structurée (en-têtes de colonnes).
    const tab = ligneDeTableau(l);
    if (tab) {
      const role = roleSynthese(tab.designation);
      const brut = tab.lineAmountCents ?? (tab.unitPriceCents !== null && tab.quantity ? Math.round(tab.unitPriceCents * tab.quantity) : null);
      if (brut === null) return;
      if (role) { summaries.push({ index, unitId: l.unitId, text, role, cents: Math.abs(brut) }); synthesePassee = true; return; }
      articles.push(article(index, l.unitId, text, tab.designation, tab.quantity, tab.unitPriceCents, brut, tab.discountCents));
      return;
    }

    const fin = montantFinal(text);
    if (!fin) return;
    const avant = fin.before.replace(/[:\-–—.\s]+$/, '').trim();
    if (!/[a-zà-ÿ]{2}/i.test(sansAccents(avant))) return;
    const role = roleSynthese(avant);
    if (role) {
      // Remise juste après un article, avant toute synthèse : remise de LIGNE de cet article.
      const precedent = articles[articles.length - 1];
      if (role === 'GLOBAL_DISCOUNT' && !synthesePassee && precedent && precedent.index === index - 1 && precedent.discountCents === null && !precedent.refund) {
        precedent.discountCents = Math.abs(fin.cents);
        precedent.discountUnitId = l.unitId;
        precedent.netCents = precedent.lineAmountCents - precedent.discountCents;
        summaries.push({ index, unitId: l.unitId, text, role: 'LINE_DISCOUNT', cents: Math.abs(fin.cents) });
        return;
      }
      summaries.push({ index, unitId: l.unitId, text, role, cents: Math.abs(fin.cents) });
      if (role !== 'GLOBAL_DISCOUNT' && role !== 'COUPON' && role !== 'FEES') synthesePassee = true;
      return;
    }
    if (synthesePassee) return; // Après le total : mentions de paiement, fidélité… jamais des articles.

    let designation = avant;
    let quantity: number | null = null;
    let unit: number | null = null;
    const qp = QTE_PU.exec(avant);
    if (qp) {
      quantity = Number(qp[1]);
      unit = Number(qp[2]) * 100 + Number(qp[3]);
      designation = (avant.slice(0, qp.index) + ' ' + avant.slice(qp.index + qp[0].length)).trim();
    } else {
      const qt = QTE_LIBELLE.exec(avant) ?? QTE_X.exec(avant) ?? QTE_TETE.exec(avant);
      if (qt) { quantity = Number(qt[1]); designation = avant.replace(qt[0], ' ').trim(); }
    }
    articles.push(article(index, l.unitId, text, designation, quantity, unit, fin.cents, null));
  });

  const vendus = articles.filter((a) => !a.refund);
  const unites = vendus.reduce((n, a) => n + (a.quantity && a.quantity > 1 ? a.quantity : 1), 0);
  const multiArticle = unites >= 2 || (declaredArticleCount !== null && declaredArticleCount >= 2);
  const globalAdjustments = summaries.filter((s) => s.role === 'GLOBAL_DISCOUNT' || s.role === 'COUPON' || s.role === 'FEES');
  const total = summaries.find((s) => s.role === 'TOTAL_PAID')?.cents ?? documentTotalCents;
  const somme = articles.reduce((n, a) => n + a.netCents, 0)
    + globalAdjustments.reduce((n, s) => n + (s.role === 'FEES' ? s.cents : -s.cents), 0);
  const reconciled = total !== null && articles.length > 0 && Math.abs(somme - total) <= 2;
  const basket = new Set<number>();
  for (const s of summaries) if (BASKET_ROLES.has(s.role)) basket.add(s.cents);
  if (documentTotalCents !== null && documentTotalCents > 0) basket.add(documentTotalCents);
  if (vendus.length >= 2) basket.add(vendus.reduce((n, a) => n + a.lineAmountCents, 0));
  return {
    articles, summaries, documentTotalCents, multiArticle, declaredArticleCount,
    basketCents: [...basket].sort((a, b) => a - b), globalAdjustments, reconciled,
  };
}

function article(index: number, unitId: string | null, text: string, designation: string, quantity: number | null,
  unitPriceCents: number | null, cents: number, discountCents: number | null): ArticleLine {
  const refund = cents < 0;
  const ligne = Math.abs(cents);
  return {
    index, unitId, text, designation: designation.replace(/\s+/g, ' ').trim(), quantity, unitPriceCents,
    lineAmountCents: refund ? -ligne : ligne, discountCents, discountUnitId: null,
    netCents: refund ? -ligne : ligne - (discountCents ?? 0), refund,
    bundle: M.lot.test(plat(designation)),
  };
}

/** Lignes brutes d'une transcription (une par ligne physique). */
export function linesOfTranscription(transcription: string | null | undefined): RawReceiptLine[] {
  if (!transcription) return [];
  return transcription.split(/\r?\n/).map((t) => ({ unitId: null, text: t }));
}

/** Lignes brutes des tableaux du contrat T1 (`analysis.tables`). */
export function linesOfT1Tables(tables: ReadonlyArray<{ columns: Array<{ header: string }>; rows: Array<{ cells: Array<{ column: number; value: string | number | null }> }> }> | null | undefined): RawReceiptLine[] {
  const out: RawReceiptLine[] = [];
  for (const t of tables ?? []) {
    for (const r of t.rows) {
      const cells = r.cells.map((c) => ({ header: t.columns[c.column]?.header ?? null, value: c.value === null ? null : String(c.value) }));
      out.push({ unitId: null, text: cells.map((c) => `${c.header ? `${c.header} : ` : ''}${c.value ?? ''}`).join(' | '), cells });
    }
  }
  return out;
}

/** Unité persistée de la couche A (forme minimale lue en base). */
export interface StoredUnitLike {
  sourceUnitId: string;
  kind: string;
  text: string | null;
  label?: string | null;
  value?: string | null;
  payload?: Record<string, unknown> | null;
}

/**
 * Lignes brutes et montant du document à partir des unités PERSISTÉES
 * (`document_source_units`) — aucune relecture du fichier, aucun appel T1.
 */
export function linesOfSourceUnits(units: readonly StoredUnitLike[]): { lines: RawReceiptLine[]; documentTotalCents: number | null } {
  const lines: RawReceiptLine[] = [];
  let documentTotalCents: number | null = null;
  for (const u of units) {
    if (u.kind === 'DOCUMENT_METADATA') {
      const p = u.payload ?? {};
      if (p.field === 'amount' && Number.isInteger(p.cents)) documentTotalCents = Number(p.cents);
      continue;
    }
    if (u.kind === 'TABLE_ROW') {
      const cells = Array.isArray(u.payload?.cells)
        ? (u.payload!.cells as Array<{ header?: string | null; value?: string | null }>).map((c) => ({ header: c.header ?? null, value: c.value == null ? null : String(c.value) }))
        : undefined;
      lines.push({ unitId: u.sourceUnitId, text: u.text ?? '', ...(cells?.length ? { cells } : {}) });
      continue;
    }
    if (u.kind === 'LABEL_VALUE') {
      lines.push({ unitId: u.sourceUnitId, text: u.text ?? `${u.label ?? ''} ${u.value ?? ''}` });
      continue;
    }
    if (u.kind === 'TEXT_BLOCK' && u.text) {
      for (const t of u.text.split(/\r?\n/)) lines.push({ unitId: u.sourceUnitId, text: t });
    }
  }
  return { lines, documentTotalCents };
}

// ── Rôle d'un montant donné ────────────────────────────────────────────────

export type AmountClassification =
  | { role: 'LINE'; articles: ArticleLine[] }
  | { role: 'BASKET'; summaryRoles: AmountRole[] }
  | { role: 'UNKNOWN' };

/** Rôle d'un montant (centimes) dans le justificatif : ligne d'article, montant de transaction, ou inconnu. */
export function classifyAmount(p: ReceiptProfile, cents: number): AmountClassification {
  const plusieurs = (a: ArticleLine) => a.quantity !== null && a.quantity > 1;
  // Prix d'UN article : ligne d'un seul exemplaire (brute ou nette), ou prix unitaire écrit.
  const lignes = p.articles.filter((a) => !a.refund && (a.unitPriceCents === cents || (!plusieurs(a) && (a.lineAmountCents === cents || a.netCents === cents))));
  if (lignes.length > 0) return { role: 'LINE', articles: lignes };
  // Montant d'une ligne de PLUSIEURS exemplaires : jamais le prix d'un exemplaire.
  if (p.articles.some((a) => !a.refund && plusieurs(a) && (a.lineAmountCents === cents || a.netCents === cents))) {
    return { role: 'BASKET', summaryRoles: ['LINE_AMOUNT', 'QUANTITY'] };
  }
  if (p.basketCents.includes(cents)) {
    const roles = p.summaries.filter((s) => s.cents === cents).map((s) => s.role);
    return { role: 'BASKET', summaryRoles: roles.length ? [...new Set(roles)] : ['TOTAL_PAID'] };
  }
  return { role: 'UNKNOWN' };
}

/**
 * Montant de TRANSACTION d'un justificatif à plusieurs articles (total,
 * sous-total, paiement, somme des lignes) qui n'est le montant d'aucune ligne :
 * jamais le prix d'un article identifié.
 */
export function isBasketAmountOfMultiArticle(p: ReceiptProfile, cents: number): boolean {
  return p.multiArticle && classifyAmount(p, cents).role === 'BASKET';
}

// ── Attribution d'une ligne à un objet ─────────────────────────────────────

export interface TargetDescriptor {
  name: string | null;
  brand?: string | null;
  model?: string | null;
  reference?: string | null;
  serialNumber?: string | null;
}

export type AttributionRefusal =
  | 'NO_ARTICLE_LINES'
  | 'NO_DESCRIPTOR'
  | 'NO_MATCHING_LINE'
  | 'AMBIGUOUS_LINES'
  | 'BUNDLE_OR_LOT'
  | 'REFUND_LINE'
  | 'QUANTITY_UNIT_PRICE_NOT_SHOWN'
  | 'QUANTITY_WITH_LINE_DISCOUNT'
  | 'GLOBAL_ADJUSTMENT_UNCERTAIN';

export type AttributionBasis = 'LINE' | 'LINE_NET' | 'UNIT_PRICE';

export type Attribution =
  | { ok: true; article: ArticleLine; cents: number; basis: AttributionBasis; matchedBy: 'DESIGNATION' | 'REFERENCE'; confidence: 'certain' | 'probable' }
  | { ok: false; reason: AttributionRefusal; candidates?: number };

const VIDES = new Set(['les', 'des', 'une', 'pour', 'avec', 'sans', 'dans', 'sur', 'par', 'the', 'and', 'mon', 'ma', 'mes', 'son', 'sa', 'ses', 'notre', 'votre']);
const jetons = (s: string | null | undefined): string[] =>
  plat(s ?? '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length >= 3 && !VIDES.has(t));
const compact = (s: string | null | undefined) => plat(s ?? '').replace(/[^a-z0-9]+/g, '');

/** Le jeton de l'objet figure-t-il dans la désignation (pluriel / troncature de caisse tolérés) ? */
function jetonPresent(jeton: string, designation: string[]): boolean {
  return designation.some((d) => d === jeton
    || (jeton.length >= 5 && d.length >= 4 && (jeton.startsWith(d) || d.startsWith(jeton))));
}

function correspond(a: ArticleLine, d: TargetDescriptor): 'DESIGNATION' | 'REFERENCE' | null {
  const des = jetons(a.designation);
  const refs = [d.reference, d.model, d.serialNumber].map(compact).filter((r) => r.length >= 4);
  if (refs.some((r) => compact(a.designation).includes(r))) return 'REFERENCE';
  const nom = jetons(d.name);
  if (nom.length > 0 && nom.every((t) => jetonPresent(t, des))) return 'DESIGNATION';
  return null;
}

/**
 * Ligne du justificatif attribuable à l'objet décrit, ou abstention motivée.
 * Le montant rendu est celui que la source DÉMONTRE : ligne (×1), ligne
 * nette d'une remise de ligne explicite, ou prix unitaire écrit et cohérent
 * avec la quantité. Jamais de quote-part de remise globale, coupon ou frais.
 */
export function attributeArticle(p: ReceiptProfile, d: TargetDescriptor | null | undefined): Attribution {
  if (p.articles.length === 0) return { ok: false, reason: 'NO_ARTICLE_LINES' };
  if (!d || (jetons(d.name).length === 0 && ![d.reference, d.model, d.serialNumber].some((r) => compact(r).length >= 4))) {
    return { ok: false, reason: 'NO_DESCRIPTOR' };
  }
  const trouves = p.articles.map((a) => ({ a, by: correspond(a, d) })).filter((x) => x.by !== null);
  if (trouves.length === 0) return { ok: false, reason: 'NO_MATCHING_LINE' };
  // Une référence exacte départage des lignes de même désignation ; sinon plusieurs lignes = ambiguïté.
  const parRef = trouves.filter((x) => x.by === 'REFERENCE');
  const retenus = parRef.length > 0 ? parRef : trouves;
  if (retenus.length > 1) return { ok: false, reason: 'AMBIGUOUS_LINES', candidates: retenus.length };
  const { a, by } = retenus[0];
  if (a.refund) return { ok: false, reason: 'REFUND_LINE' };
  if (a.bundle) return { ok: false, reason: 'BUNDLE_OR_LOT' };
  if (p.globalAdjustments.some((s) => s.role === 'GLOBAL_DISCOUNT' || s.role === 'COUPON')) {
    return { ok: false, reason: 'GLOBAL_ADJUSTMENT_UNCERTAIN' };
  }
  const confidence: 'certain' | 'probable' = p.reconciled ? 'certain' : 'probable';
  if (a.quantity !== null && a.quantity > 1) {
    if (a.discountCents !== null) return { ok: false, reason: 'QUANTITY_WITH_LINE_DISCOUNT' };
    if (a.unitPriceCents === null || Math.abs(a.unitPriceCents * a.quantity - a.lineAmountCents) > 1) {
      return { ok: false, reason: 'QUANTITY_UNIT_PRICE_NOT_SHOWN' };
    }
    return { ok: true, article: a, cents: a.unitPriceCents, basis: 'UNIT_PRICE', matchedBy: by!, confidence };
  }
  if (a.discountCents !== null) return { ok: true, article: a, cents: a.netCents, basis: 'LINE_NET', matchedBy: by!, confidence };
  return { ok: true, article: a, cents: a.lineAmountCents, basis: 'LINE', matchedBy: by!, confidence };
}

/** Libellés simples des motifs d'abstention (diagnostics, recette PO). */
export const ATTRIBUTION_REFUSAL_LABELS: Readonly<Record<AttributionRefusal, string>> = {
  NO_ARTICLE_LINES: 'aucune ligne d’article lisible sur le justificatif',
  NO_DESCRIPTOR: 'objet sans désignation exploitable',
  NO_MATCHING_LINE: 'aucune ligne ne désigne cet objet',
  AMBIGUOUS_LINES: 'plusieurs lignes peuvent désigner cet objet (articles identiques ou proches)',
  BUNDLE_OR_LOT: 'article vendu en lot ou offre groupée : prix individuel non démontrable',
  REFUND_LINE: 'ligne de retour ou de remboursement',
  QUANTITY_UNIT_PRICE_NOT_SHOWN: 'plusieurs exemplaires sans prix unitaire écrit',
  QUANTITY_WITH_LINE_DISCOUNT: 'plusieurs exemplaires avec une remise de ligne : répartition non démontrable',
  GLOBAL_ADJUSTMENT_UNCERTAIN: 'remise globale ou coupon sur le ticket : prix net de l’article non démontrable',
};
