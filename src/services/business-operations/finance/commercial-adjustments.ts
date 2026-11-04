/**
 * Lot 109D — AJUSTEMENTS COMMERCIAUX ET COMPOSITION DES ACHATS d'un document
 * (ticket P1 « TCO — remises vs avoirs, 1 document → 1..N achats »).
 * Module PUR (aucun accès base, utilisable côté client) du moteur financier
 * commun : il est appelé par les DEUX consommateurs des indices T1 —
 * `economic-lines.ts` (dépenses documentaires) et la consolidation T3
 * (`consolidation/model.ts#buildCandidateIdentity`) — et par la barrière T1
 * (`operation-candidates/prepare.ts`). Une seule règle, aucun second moteur,
 * aucune règle propre à un fournisseur, un montant ou un type d'objet.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CAUSE RACINE (démontrée en e2e sur base réelle, L109D-E2E-01)
 *
 * T1 porte le signe d'un montant par son RÔLE : la remise « −20,00 » d'une
 * commande devient un indice `REDUCTION`. Les deux consommateurs le lisaient
 * différemment :
 *   · `economic-lines` faisait de CHAQUE indice une ligne autonome : la remise
 *     devenait un « avoir » retenu (−20 €), en plus du total TTC déjà net
 *     (double déduction) ou à côté d'une commande comptée en prévision (TCO
 *     diminué de 20 € pour un achat non compté) ;
 *   · T3 ignorait la remise portée par le candidat du coût (lot 48) mais en
 *     faisait une composante `REDUCTION` quand T1 l'avait isolée dans un
 *     autre candidat du même document, et perdait remise et frais quand le
 *     document ne portait que des lignes (278,00 € compté au lieu de 277,35 €).
 *
 * RÈGLE (une par document, toutes sources confondues)
 *
 *   · un document est une PIÈCE DE TRANSACTION s'il porte un coût (réalisé ou
 *     prévu) dans un candidat dont le rôle n'est ni avoir ni preuve de
 *     remboursement ;
 *   · sur une pièce de transaction, un montant `REDUCTION` / `REFUND` d'un
 *     candidat qui n'est pas un avoir est un AJUSTEMENT COMMERCIAL (remise de
 *     ligne, remise globale, code promo) : il entre dans le net de l'achat,
 *     jamais un avoir ni un remboursement autonome. Seul un document propre
 *     (avoir, preuve de remboursement) établit une vraie réduction ;
 *   · un candidat chiffré = un ACHAT (objet économique distinct établi par
 *     T1) : plusieurs lignes d'un même candidat (exemplaires identiques,
 *     fournitures + main-d'œuvre d'une même prestation, livraison) forment UN
 *     coût ; deux candidats ciblés forment deux coûts ;
 *   · net de l'achat : le TOTAL écrit s'il existe (déjà net : lignes, frais et
 *     remises en sont la composition) ; sinon lignes + frais − remises,
 *     réconcilié avec le montant du document quand il est connu (écart
 *     signalé, jamais masqué) ; un montant seul est réputé déjà net (lot 48) ;
 *   · remise globale d'un document à PLUSIEURS achats : aucune règle de
 *     ventilation explicite → part indéterminée conservée, non attribuée,
 *     jamais un net par article inventé ;
 *   · commande (jamais un devis) dont le document prouve le paiement daté du
 *     net : achat RÉALISÉ à la date du paiement ; sinon prévision (inchangé) ;
 *   · acomptes, soldes, échéances, périodes : jamais fusionnés (faits propres).
 * ══════════════════════════════════════════════════════════════════════════
 */

export interface AdjustmentHint {
  role: string;
  amountMinor: number;
  currency: string;
  amountScope?: string | null;
  economicDate?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
}

export interface AdjustmentCandidate {
  id: number;
  sourceRole: string | null;
  statusHint?: string | null;
  established?: boolean;
  hints: readonly AdjustmentHint[];
}

/** Rôles de source qui établissent une VRAIE réduction (document propre). */
export const CREDIT_SOURCE_ROLES: ReadonlySet<string> = new Set(['CREDIT_NOTE', 'REFUND_PROOF']);
const COUTS = new Set(['REALIZED_COST', 'FORECAST_COST']);
const AJUSTEMENTS = new Set(['REDUCTION', 'REFUND']);
/** Portées qui sont des faits PROPRES (jamais une composition). */
const PARTS = new Set(['DEPOSIT', 'BALANCE', 'INSTALLMENT']);
/** Tolérance d'arrondi de la réconciliation (centimes). */
export const RECONCILIATION_TOLERANCE_MINOR = 2;

export type CompositionPart = 'LINE' | 'FEE' | 'DISCOUNT';

export type HintTreatment =
  /** Indice inchangé (aucune composition à faire). */
  | { kind: 'KEEP' }
  /** Indice qui porte le net de l'achat (total écrit). */
  | { kind: 'PURCHASE_NET'; purchase: number }
  /** Composante de calcul de l'achat : comprise dans son net, jamais une transaction distincte. */
  | { kind: 'COMPOSITION'; purchase: number; part: CompositionPart }
  /** Remise globale d'un document à plusieurs achats : part indéterminée, non ventilée, jamais un avoir. */
  | { kind: 'DISCOUNT_UNALLOCATED' };

export interface PurchaseComposition {
  /** Candidat T1 qui porte l'achat (clé de l'achat). */
  candidateId: number;
  kind: 'REALIZED_COST' | 'FORECAST_COST';
  currency: string;
  netMinor: number;
  basis: 'TOTAL' | 'SINGLE_AMOUNT' | 'LINES_NET';
  /** Net non écrit tel quel sur le document : calculé depuis les lignes (une ligne nette est produite). */
  synthesized: boolean;
  /** Rang (dans le candidat) de l'indice qui porte le net ; null si synthétisé. */
  principalHintIndex: number | null;
  /** Premier indice de coût de l'achat (ancre de preuve d'un net synthétisé). */
  anchorHintIndex: number;
  economicDate: string | null;
  linesMinor: number;
  feesMinor: number;
  discountsMinor: number;
  reconciliation: 'RECONCILED' | 'MISMATCH' | 'UNVERIFIED';
  /** Commande payée (paiement daté du net sur le document) : réalisée à cette date. */
  paidBy: { date: string; amountMinor: number } | null;
  parts: Array<{ candidateId: number; hintIndex: number; part: CompositionPart; role: string; amountMinor: number; scope: string | null }>;
}

export interface DocumentAdjustmentPlan {
  /** Pièce de transaction : un coût porté hors avoir. */
  costBearing: boolean;
  /** Traitement de chaque indice (`hintKey`). */
  treatments: Map<string, HintTreatment>;
  purchases: PurchaseComposition[];
  /** Candidats qui ne portent QUE des ajustements commerciaux intégrés (jamais une réalité propre). */
  adjustmentOnlyCandidates: number[];
  /** Codes stables de qualification (diagnostic, contrôle de cohérence). */
  codes: string[];
}

export const hintKey = (candidateId: number, index: number): string => `${candidateId}:${index}`;

const isoDay = (d: string | null | undefined): string | null => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);
const proche = (a: number, b: number) => Math.abs(a - b) <= RECONCILIATION_TOLERANCE_MINOR;
const devise = (h: AdjustmentHint) => String(h.currency || 'EUR').trim().toUpperCase();
const estPeriode = (h: AdjustmentHint) => !!(h.periodStart || h.periodEnd);

/**
 * Plan d'un document (pure, déterministe, idempotente) à partir de ses
 * candidats T1 ACTIFS et établis. `documentTotalMinor` : montant TTC du
 * document lu par T1 (même devise que l'achat, sinon ignoré).
 */
export function planDocumentAdjustments(
  candidates: readonly AdjustmentCandidate[],
  opts: { documentTotalMinor?: number | null; documentCurrency?: string | null; today?: string | null } = {},
): DocumentAdjustmentPlan {
  const treatments = new Map<string, HintTreatment>();
  const codes = new Set<string>();
  const vivants = candidates.filter((c) => c.established !== false && c.statusHint !== 'CANCELLED');
  const horsAvoir = (c: AdjustmentCandidate) => !CREDIT_SOURCE_ROLES.has(String(c.sourceRole ?? ''));
  const costBearing = vivants.some((c) => horsAvoir(c) && c.hints.some((h) => COUTS.has(h.role)));
  const plan: DocumentAdjustmentPlan = { costBearing, treatments, purchases: [], adjustmentOnlyCandidates: [], codes: [] };
  for (const c of candidates) c.hints.forEach((_, i) => treatments.set(hintKey(c.id, i), { kind: 'KEEP' }));
  if (!costBearing) return plan;

  // Achats : candidats hors avoir qui portent un coût composable (hors acomptes, soldes, échéances, périodes).
  const composables = (c: AdjustmentCandidate) => c.hints.map((h, i) => ({ h, i }))
    .filter(({ h }) => COUTS.has(h.role) && !PARTS.has(String(h.amountScope ?? '')) && !estPeriode(h));
  const achats = vivants.filter((c) => horsAvoir(c) && composables(c).length > 0);
  const ajustementsDe = (c: AdjustmentCandidate) => (horsAvoir(c) ? c.hints.map((h, i) => ({ h, i })).filter(({ h }) => AJUSTEMENTS.has(h.role)) : []);
  // Remises portées par un candidat SANS coût (remise isolée par T1) : globales au document.
  const globales = vivants.filter((c) => horsAvoir(c) && !c.hints.some((h) => COUTS.has(h.role)))
    .flatMap((c) => ajustementsDe(c).map((x) => ({ c, ...x })));
  for (const c of vivants) {
    if (horsAvoir(c) && c.hints.length && c.hints.every((h) => AJUSTEMENTS.has(h.role) || h.role === 'PAYMENT') && c.hints.some((h) => AJUSTEMENTS.has(h.role))) {
      plan.adjustmentOnlyCandidates.push(c.id);
    }
  }
  if (globales.length && achats.length !== 1) {
    // Plusieurs achats : aucune règle de ventilation explicite — la part reste indéterminée (jamais inventée).
    for (const g of globales) treatments.set(hintKey(g.c.id, g.i), { kind: 'DISCOUNT_UNALLOCATED' });
    codes.add('GLOBAL_DISCOUNT_NOT_ALLOCATED');
  }
  const paiements = vivants.filter(horsAvoir).flatMap((c) => c.hints.filter((h) => h.role === 'PAYMENT'));
  const today = isoDay(opts.today ?? null);

  for (const c of achats) {
    const couts = composables(c);
    const cur = devise(couts[0].h);
    if (couts.some(({ h }) => devise(h) !== cur)) { codes.add('MIXED_CURRENCIES_NOT_COMPOSED'); continue; }
    const remises = [...ajustementsDe(c).map((x) => ({ c, ...x })), ...(achats.length === 1 ? globales : [])]
      .filter((x) => devise(x.h) === cur);
    const totaux = couts.filter(({ h }) => h.amountScope === 'TOTAL');
    const lignes = couts.filter(({ h }) => h.amountScope !== 'TOTAL' && h.amountScope !== 'FEE');
    const frais = couts.filter(({ h }) => h.amountScope === 'FEE');
    // Dates distinctes entre lignes sans total : peut-être plusieurs faits — aucune composition (prudence).
    const dates = new Set(lignes.map(({ h }) => isoDay(h.economicDate)).filter(Boolean));
    if (!totaux.length && dates.size > 1) {
      for (const r of remises) treatments.set(hintKey(r.c.id, r.i), { kind: 'DISCOUNT_UNALLOCATED' });
      if (remises.length) codes.add('DISCOUNT_DATES_DISTINCT_NOT_ALLOCATED');
      continue;
    }
    if (!remises.length && couts.length < 2) continue; // rien à composer : l'indice reste le coût
    const somme = (xs: Array<{ h: AdjustmentHint }>) => xs.reduce((n, { h }) => n + h.amountMinor, 0);
    const L = somme(lignes); const F = somme(frais); const D = somme(remises);
    const docTotal = opts.documentTotalMinor != null && opts.documentTotalMinor > 0
      && (!opts.documentCurrency || String(opts.documentCurrency).toUpperCase() === cur) ? opts.documentTotalMinor : null;
    let netMinor: number; let basis: PurchaseComposition['basis']; let reconciliation: PurchaseComposition['reconciliation'];
    let principal: { h: AdjustmentHint; i: number } | null = null;
    let fraisInclus = true;
    if (totaux.length) {
      principal = totaux.reduce((m, x) => (x.h.amountMinor > m.h.amountMinor ? x : m), totaux[0]);
      netMinor = principal.h.amountMinor; basis = 'TOTAL';
      const autresTotaux = totaux.filter((x) => x !== principal);
      if (lignes.length || autresTotaux.length) {
        reconciliation = proche(L + F - D, netMinor) || proche(L + F, netMinor) ? 'RECONCILED'
          : proche(L - D, netMinor) || proche(L, netMinor) ? 'RECONCILED' : 'MISMATCH';
        // Frais hors du total écrit (total = lignes seules) : faits propres, jamais absorbés.
        if (frais.length && !(proche(L + F - D, netMinor) || proche(L + F, netMinor)) && (proche(L - D, netMinor) || proche(L, netMinor))) fraisInclus = false;
      } else {
        reconciliation = docTotal != null && proche(docTotal, netMinor) ? 'RECONCILED' : 'UNVERIFIED';
        if (frais.length && !(docTotal != null && proche(docTotal, netMinor))) fraisInclus = false;
      }
    } else if (couts.length === 1) {
      // Un montant seul : déjà net (lot 48), sauf si le document prouve le contraire (montant − remises = total du document).
      netMinor = couts[0].h.amountMinor; basis = 'SINGLE_AMOUNT'; reconciliation = 'UNVERIFIED';
      if (docTotal != null && D > 0 && proche(netMinor - D, docTotal) && !proche(netMinor, docTotal)) { netMinor -= D; basis = 'LINES_NET'; reconciliation = 'RECONCILED'; }
      else if (docTotal != null) reconciliation = proche(netMinor, docTotal) ? 'RECONCILED' : 'MISMATCH';
    } else {
      basis = 'LINES_NET';
      if (docTotal != null && proche(L + F - D, docTotal)) { netMinor = L + F - D; reconciliation = 'RECONCILED'; }
      else if (docTotal != null && proche(L + F, docTotal)) { netMinor = L + F; reconciliation = 'RECONCILED'; }
      else { netMinor = L + F - D; reconciliation = docTotal != null ? 'MISMATCH' : 'UNVERIFIED'; }
    }
    if (reconciliation === 'MISMATCH') codes.add('PURCHASE_NOT_RECONCILED');
    if (netMinor < 0) { codes.add('NEGATIVE_NET_NOT_COMPOSED'); continue; }
    const kind: PurchaseComposition['kind'] = (principal ? principal.h.role : couts.some(({ h }) => h.role === 'REALIZED_COST') ? 'REALIZED_COST' : 'FORECAST_COST') as PurchaseComposition['kind'];
    // Commande (jamais un devis) payée : paiement daté, non futur, du net — réalisée à la date du paiement.
    let paidBy: PurchaseComposition['paidBy'] = null;
    if (kind === 'FORECAST_COST' && c.sourceRole === 'ORDER') {
      const p = paiements.filter((h) => devise(h) === cur && proche(h.amountMinor, netMinor) && isoDay(h.economicDate) && (!today || isoDay(h.economicDate)! <= today))
        .sort((a, b) => isoDay(a.economicDate)!.localeCompare(isoDay(b.economicDate)!))[0];
      if (p) { paidBy = { date: isoDay(p.economicDate)!, amountMinor: p.amountMinor }; codes.add('ORDER_PAID_REALIZED'); }
    }
    const synthesized = !principal && (couts.length > 1 || netMinor !== couts[0].h.amountMinor);
    const parts: PurchaseComposition['parts'] = [];
    const ajouter = (cid: number, i: number, h: AdjustmentHint, part: CompositionPart) => {
      treatments.set(hintKey(cid, i), { kind: 'COMPOSITION', purchase: c.id, part });
      parts.push({ candidateId: cid, hintIndex: i, part, role: h.role, amountMinor: h.amountMinor, scope: h.amountScope ?? null });
    };
    if (principal) treatments.set(hintKey(c.id, principal.i), { kind: 'PURCHASE_NET', purchase: c.id });
    for (const x of totaux) if (x !== principal) ajouter(c.id, x.i, x.h, 'LINE');
    for (const x of lignes) if (principal || synthesized) ajouter(c.id, x.i, x.h, 'LINE');
    for (const x of frais) if (fraisInclus && (principal || synthesized)) ajouter(c.id, x.i, x.h, 'FEE');
    if (!principal && !synthesized) treatments.set(hintKey(c.id, couts[0].i), { kind: 'PURCHASE_NET', purchase: c.id });
    for (const r of remises) ajouter(r.c.id, r.i, r.h, 'DISCOUNT');
    if (remises.length) codes.add('COMMERCIAL_ADJUSTMENT_INTEGRATED');
    plan.purchases.push({
      candidateId: c.id, kind: paidBy ? 'REALIZED_COST' : kind, currency: cur, netMinor, basis, synthesized,
      principalHintIndex: principal ? principal.i : !synthesized ? couts[0].i : null, anchorHintIndex: couts[0].i,
      economicDate: paidBy?.date ?? isoDay((principal ?? couts[0]).h.economicDate) ?? lignes.map(({ h }) => isoDay(h.economicDate)).find(Boolean) ?? null,
      linesMinor: L + somme(totaux.filter((x) => x !== principal)), feesMinor: fraisInclus ? F : 0, discountsMinor: D, reconciliation, paidBy, parts,
    });
  }
  // Remises globales restées sans achat (achat non composable) : jamais un avoir.
  for (const g of globales) {
    const t = treatments.get(hintKey(g.c.id, g.i));
    if (t?.kind === 'KEEP') { treatments.set(hintKey(g.c.id, g.i), { kind: 'DISCOUNT_UNALLOCATED' }); codes.add('GLOBAL_DISCOUNT_NOT_ALLOCATED'); }
  }
  // Remise d'un achat non composé (devises mêlées, net négatif) : jamais un avoir autonome.
  for (const c of vivants) for (const x of ajustementsDe(c)) {
    if (treatments.get(hintKey(c.id, x.i))?.kind === 'KEEP') treatments.set(hintKey(c.id, x.i), { kind: 'DISCOUNT_UNALLOCATED' });
  }
  plan.codes = [...codes].sort();
  return plan;
}

/** Vue de la composition d'un achat (tiroir du TCO, diagnostic) — montants en unités mineures. */
export interface PurchaseCompositionView {
  netMinor: number;
  currency: string;
  basis: PurchaseComposition['basis'];
  linesMinor: number;
  feesMinor: number;
  discountsMinor: number;
  reconciliation: PurchaseComposition['reconciliation'];
  paidOn: string | null;
  /** Méthode de calcul en langage simple. */
  method: string;
}

export function compositionView(p: PurchaseComposition): PurchaseCompositionView {
  const method = p.basis === 'TOTAL' ? 'Total TTC écrit sur le document (remises et frais déjà compris).'
    : p.basis === 'LINES_NET' ? 'Montant des articles + frais − remises, d’après le document.'
      : 'Montant unique du document (déjà net).';
  return {
    netMinor: p.netMinor, currency: p.currency, basis: p.basis, linesMinor: p.linesMinor, feesMinor: p.feesMinor, discountsMinor: p.discountsMinor,
    reconciliation: p.reconciliation, paidOn: p.paidBy?.date ?? null,
    method: `${method}${p.paidBy ? ' Commande payée : comptée à la date du paiement.' : ''}${p.reconciliation === 'MISMATCH' ? ' Écart entre les lignes et le total du document : à vérifier.' : ''}`,
  };
}

/** Libellés simples des traitements (diagnostic, recette PO). */
export const ADJUSTMENT_CODE_LABELS: Readonly<Record<string, string>> = {
  COMMERCIAL_ADJUSTMENT_INTEGRATED: 'Remise commerciale intégrée au prix net de l’achat (jamais un avoir)',
  GLOBAL_DISCOUNT_NOT_ALLOCATED: 'Remise globale sur plusieurs achats : non ventilée faute de règle explicite',
  DISCOUNT_DATES_DISTINCT_NOT_ALLOCATED: 'Remise sur des lignes de dates différentes : non attribuée',
  PURCHASE_NOT_RECONCILED: 'Lignes, frais et remises ne retrouvent pas le total du document : écart signalé',
  ORDER_PAID_REALIZED: 'Commande payée (paiement daté du même montant) : achat réalisé',
  MIXED_CURRENCIES_NOT_COMPOSED: 'Devises différentes : achat non recomposé',
  NEGATIVE_NET_NOT_COMPOSED: 'Net négatif : achat non recomposé',
};
