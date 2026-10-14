/**
 * Moteur financier canonique PARTAGÉ — lot 54D (ticket P1 « Opérations V1 :
 * écarts E01–E09, TCO, calculs unifiés », §4 ; CDC Opérations V1 C10, C12,
 * C12.3, C15.1, C17, Q4, P16).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE DÉFINITION DES RÈGLES ÉCONOMIQUES
 *
 * T2 (`verebona-assistant/canonical/operations.ts`, `expenses.ts`), le TCO
 * (`business-operations/tco`), les Sinistres (`claims/model.ts`,
 * `claims/read.ts`) et les exports qui les relisent n'ont plus chacun leur
 * règle : ils appellent ce module. Il ne lit rien en base (PUR, utilisable
 * côté client) ; il ne crée ni ne persiste aucune vérité financière : les
 * composantes sont celles CONSOLIDÉES par T3.
 *
 *   Nature           Règle
 *   REALIZED_COST    augmente le coût
 *   REDUCTION        diminue le coût (avoir)
 *   REFUND           diminue le coût (remboursement réel)
 *   INDEMNITY        diminue le NET si attribuable (Q4 : le brut n'est jamais diminué)
 *   PROCEED          diminue le net FINAL après cession (jamais une dépense)
 *   FORECAST_COST    exclu du réalisé (devis, prévision)
 *   paiement/acompte preuve, pas coût additionnel (jamais une composante, P16)
 *   principal        information du financement, pas un coût (53D, Q16)
 *
 *   · unités MINEURES entières, jamais de flottant dans un total ;
 *   · ZÉRO ≠ INCONNU : un montant sans contre-valeur EUR établie est `null`,
 *     jamais 0 — il est exclu des totaux EUR et signalé (E09) ;
 *   · aucune conversion inventée : seule la contre-valeur ÉCRITE sur le
 *     document (`amount_eur_cents`) est utilisée ;
 *   · attribution : une composante ciblée n'alimente que son bien ; non
 *     ciblée, elle n'est attribuée implicitement que si l'Opération ne
 *     concerne QUE le périmètre ; sinon « non ventilée », jamais répartie ;
 *   · une composante (identifiant) n'est comptée qu'une fois, quels que
 *     soient ses justificatifs.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { FinancialComponentKind } from '../model';

/** Devise non établie sur le document (lot 53D, D2). */
export const UNKNOWN_CURRENCY = 'XXX';

/** Effet économique d'une nature de composante (table §4.2). */
export type ComponentEffect = 'COST' | 'REDUCTION' | 'REFUND' | 'INDEMNITY' | 'PROCEED' | 'FORECAST';

export const COMPONENT_EFFECT: Readonly<Record<FinancialComponentKind, ComponentEffect>> = {
  REALIZED_COST: 'COST', REDUCTION: 'REDUCTION', REFUND: 'REFUND', INDEMNITY: 'INDEMNITY', PROCEED: 'PROCEED', FORECAST_COST: 'FORECAST',
};

/** Signe dans le coût net : +1 augmente le coût, −1 le diminue, 0 hors coût réalisé (prévision). */
export const COST_SIGN: Readonly<Record<FinancialComponentKind, 1 | -1 | 0>> = {
  REALIZED_COST: 1, REDUCTION: -1, REFUND: -1, INDEMNITY: -1, PROCEED: -1, FORECAST_COST: 0,
};

/** Composante consolidée, telle que lue (montant toujours positif, signe porté par la nature). */
export interface LedgerComponent {
  id: number;
  operationId: number;
  kind: FinancialComponentKind;
  amountMinor: number;
  currency: string;
  amountEurCents: number | null;
  economicDate: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  targetAssetId: number | null;
  targetEquipmentId?: number | null;
  label?: string | null;
}

// ── Conversion EUR (C12.3) ─────────────────────────────────────────────────

/**
 * Montant EUR (centimes) d'une composante : le montant lui-même s'il est en
 * euros, sinon la contre-valeur EUR ÉCRITE sur le document ; `null` sinon —
 * jamais 0, jamais un taux inventé (E03, E09).
 */
export function componentEurMinor(c: { amountMinor: number; currency: string | null; amountEurCents: number | null }): number | null {
  const cur = String(c.currency ?? '').trim().toUpperCase();
  if (!Number.isSafeInteger(c.amountMinor) || c.amountMinor < 0) return null;
  if (cur === 'EUR') return c.amountMinor;
  if (cur === UNKNOWN_CURRENCY || !cur) return null;
  return c.amountEurCents != null && Number.isSafeInteger(c.amountEurCents) && c.amountEurCents >= 0 ? c.amountEurCents : null;
}

// ── Attribution aux biens (C10) ────────────────────────────────────────────

export type Attribution = 'IN' | 'OUT' | 'UNALLOCATED';

/**
 * Attribution d'une composante à un périmètre de biens (`null` : compte
 * entier). Ciblée : son bien seulement. Non ciblée : attribuée si
 * l'Opération ne concerne QUE des biens du périmètre (mono-bien implicite) ;
 * sans bien : hors d'un périmètre de biens (F-136) ; sinon non ventilée —
 * jamais répartie arbitrairement ni comptée en entier pour chacun.
 * `equipmentAssets` : bien parent de chaque équipement (une composante
 * ciblant un équipement remonte une seule fois à son bien parent).
 */
export function attributeComponent(
  c: Pick<LedgerComponent, 'targetAssetId'> & { targetEquipmentId?: number | null },
  operationAssetIds: readonly number[],
  scope: ReadonlySet<number> | null,
  equipmentAssets?: ReadonlyMap<number, number>,
): Attribution {
  if (!scope) return 'IN';
  if (c.targetAssetId != null) return scope.has(c.targetAssetId) ? 'IN' : 'OUT';
  if (c.targetEquipmentId != null && equipmentAssets?.has(c.targetEquipmentId)) return scope.has(equipmentAssets.get(c.targetEquipmentId)!) ? 'IN' : 'OUT';
  if (!operationAssetIds.length) return 'OUT';
  if (operationAssetIds.every((a) => scope.has(a))) return 'IN';
  return operationAssetIds.some((a) => scope.has(a)) ? 'UNALLOCATED' : 'OUT';
}

// ── Dates et périodes (C17) ────────────────────────────────────────────────

const DAY = 86_400_000;
const toDay = (d: string): number => Math.floor(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) / DAY);
export const isIsoDate = (d: string | null | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}/.test(d) && !Number.isNaN(Date.parse(`${d.slice(0, 10)}T00:00:00Z`));

/** Nombre de jours de `from` à `to` INCLUS (≥ 0). */
export function daysInclusive(from: string, to: string): number {
  return Math.max(0, toDay(to) - toDay(from) + 1);
}

/**
 * Prorata EXACT au jour d'une période payée qui dépasse la date de fin de
 * possession (C17) : part de `periodStart` à `cutoff` inclus. Entier (arrondi
 * au centime le plus proche, calcul en BigInt : aucun dépassement). `null`
 * si la période ne dépasse pas la coupure ou si les dates sont incomplètes.
 */
export function prorataUntil(amountMinor: number, periodStart: string | null | undefined, periodEnd: string | null | undefined, cutoff: string): { amountMinor: number; days: number; totalDays: number } | null {
  if (!isIsoDate(periodStart) || !isIsoDate(periodEnd) || !isIsoDate(cutoff)) return null;
  if (toDay(periodEnd) <= toDay(cutoff)) return null;
  const totalDays = daysInclusive(periodStart, periodEnd);
  const days = toDay(cutoff) < toDay(periodStart) ? 0 : daysInclusive(periodStart, cutoff);
  if (!totalDays) return null;
  const num = BigInt(amountMinor) * BigInt(days) * BigInt(2) + BigInt(totalDays);
  return { amountMinor: Number(num / (BigInt(totalDays) * BigInt(2))), days, totalDays };
}

// ── Inclusion / exclusion et justification (§4.4) ──────────────────────────

export type ExclusionReason =
  | 'FORECAST'                 // devis / prévision : jamais du réalisé
  | 'UNCONVERTED_CURRENCY'     // devise sans contre-valeur EUR établie
  | 'UNALLOCATED_MULTI_ASSET'  // composante globale multi-biens non ventilée
  | 'OUT_OF_SCOPE'             // autre bien
  | 'AFTER_DISPOSAL'           // datée après la cession (hors frais de cession)
  | 'PRORATA_AFTER_DISPOSAL'   // part d'une période payée postérieure à la cession
  | 'OPERATION_CANCELLED';     // Opération annulée

export const EXCLUSION_LABELS: Readonly<Record<ExclusionReason, string>> = {
  FORECAST: 'Prévision ou devis, non réalisé',
  UNCONVERTED_CURRENCY: 'Devise sans contre-valeur en euros établie',
  UNALLOCATED_MULTI_ASSET: 'Commun à plusieurs biens, non ventilé',
  OUT_OF_SCOPE: 'Concerne un autre bien',
  AFTER_DISPOSAL: 'Postérieur à la cession',
  PRORATA_AFTER_DISPOSAL: 'Part de la période postérieure à la cession',
  OPERATION_CANCELLED: 'Opération annulée',
};

export interface LedgerEntry {
  componentId: number;
  operationId: number;
  kind: FinancialComponentKind;
  effect: ComponentEffect;
  amountMinor: number;
  currency: string;
  /** EUR (centimes) de la composante entière, ou null (non convertible). */
  eurMinor: number | null;
  /** EUR retenu dans le total (après prorata éventuel), 0 si exclue. */
  includedEurMinor: number;
  included: boolean;
  exclusion: ExclusionReason | null;
  attribution: Attribution;
  date: string | null;
  prorata?: { days: number; totalDays: number } | null;
}

export interface EvaluateContext {
  scope: ReadonlySet<number> | null;
  operationAssetIds: readonly number[];
  operationStatus?: string | null;
  equipmentAssets?: ReadonlyMap<number, number>;
  /** Fin de possession (cession effective) : coupe les périodes et les coûts postérieurs. */
  disposalDate?: string | null;
  /** L'Opération est elle-même la cession (ses frais restent comptés). */
  isDisposalOperation?: boolean;
  /** Un remboursement réel existe sur l'Opération : il remplace l'ajustement théorique (C17). */
  hasRefund?: boolean;
  /** Date de repli (date de l'Opération). */
  fallbackDate?: string | null;
}

/** Évalue UNE composante : effet, EUR, attribution, inclusion ou motif d'exclusion (pure). */
export function evaluateComponent(c: LedgerComponent, ctx: EvaluateContext): LedgerEntry {
  const effect = COMPONENT_EFFECT[c.kind];
  const eur = componentEurMinor(c);
  const attribution = attributeComponent(c, ctx.operationAssetIds, ctx.scope, ctx.equipmentAssets);
  const date = c.economicDate ?? ctx.fallbackDate ?? null;
  const base: LedgerEntry = {
    componentId: c.id, operationId: c.operationId, kind: c.kind, effect, amountMinor: c.amountMinor, currency: String(c.currency).trim().toUpperCase(),
    eurMinor: eur, includedEurMinor: 0, included: false, exclusion: null, attribution, date,
  };
  const exclu = (r: ExclusionReason): LedgerEntry => ({ ...base, exclusion: r });
  if (attribution === 'OUT') return exclu('OUT_OF_SCOPE');
  if (effect === 'FORECAST') return exclu('FORECAST');
  if (ctx.operationStatus === 'CANCELLED') return exclu('OPERATION_CANCELLED');
  if (attribution === 'UNALLOCATED') return exclu('UNALLOCATED_MULTI_ASSET');
  if (eur == null) return exclu('UNCONVERTED_CURRENCY');
  let retenu = eur;
  let prorata: LedgerEntry['prorata'] = null;
  if (ctx.disposalDate && effect !== 'PROCEED' && !ctx.isDisposalOperation) {
    if (date && isIsoDate(date) && toDay(date) > toDay(ctx.disposalDate) && !(isIsoDate(c.periodStart) && toDay(c.periodStart) <= toDay(ctx.disposalDate))) {
      return exclu('AFTER_DISPOSAL');
    }
    if (effect === 'COST' && !ctx.hasRefund) {
      const p = prorataUntil(eur, c.periodStart, c.periodEnd, ctx.disposalDate);
      if (p) { retenu = p.amountMinor; prorata = { days: p.days, totalDays: p.totalDays }; }
    }
  }
  return { ...base, included: true, includedEurMinor: retenu, prorata };
}

// ── Synthèse et complétude (§4.4) ──────────────────────────────────────────

export interface LedgerTotals {
  /** Σ REALIZED_COST retenus. */
  costsEurMinor: number;
  reductionsEurMinor: number;
  refundsEurMinor: number;
  /** Indemnités attribuables (diminuent le net, jamais le brut). */
  indemnitiesEurMinor: number;
  proceedsEurMinor: number;
  /** Coût cumulé documenté (C17) = coûts − réductions − remboursements − indemnités. */
  netCostEurMinor: number;
  /** Prévisions (hors total). */
  forecastEurMinor: number;
  /** Montants non convertibles, par devise et nature (jamais additionnés). */
  unconverted: Array<{ currency: string; amountMinor: number; kind: FinancialComponentKind }>;
  /** Composantes non ventilées (multi-biens) : EUR connu et nombre. */
  unallocated: { count: number; eurMinor: number };
  /** Une composante au moins est exclue pour une raison qui rend le total incomplet. */
  complete: boolean;
}

/** Totaux d'un ensemble d'entrées (une composante = une fois, même citée deux fois). */
export function summarizeLedger(entries: readonly LedgerEntry[]): LedgerTotals {
  const vus = new Set<number>();
  const t: LedgerTotals = {
    costsEurMinor: 0, reductionsEurMinor: 0, refundsEurMinor: 0, indemnitiesEurMinor: 0, proceedsEurMinor: 0, netCostEurMinor: 0,
    forecastEurMinor: 0, unconverted: [], unallocated: { count: 0, eurMinor: 0 }, complete: true,
  };
  const devises = new Map<string, { currency: string; amountMinor: number; kind: FinancialComponentKind }>();
  for (const e of entries) {
    if (vus.has(e.componentId)) continue;
    vus.add(e.componentId);
    if (e.exclusion === 'FORECAST') { if (e.eurMinor != null && e.attribution === 'IN') t.forecastEurMinor += e.eurMinor; continue; }
    if (e.exclusion === 'UNCONVERTED_CURRENCY') {
      const k = `${e.currency}:${e.kind}`;
      const cur = devises.get(k) ?? { currency: e.currency, amountMinor: 0, kind: e.kind };
      cur.amountMinor += e.amountMinor;
      devises.set(k, cur);
      t.complete = false;
      continue;
    }
    if (e.exclusion === 'UNALLOCATED_MULTI_ASSET') {
      t.unallocated.count += 1;
      if (e.eurMinor != null) t.unallocated.eurMinor += COST_SIGN[e.kind] * e.eurMinor;
      // Coût ou indemnité commune non ventilée : le coût du périmètre est incertain (signalé, jamais réparti).
      if (e.effect !== 'PROCEED') t.complete = false;
      continue;
    }
    if (!e.included) continue;
    switch (e.effect) {
      case 'COST': t.costsEurMinor += e.includedEurMinor; break;
      case 'REDUCTION': t.reductionsEurMinor += e.includedEurMinor; break;
      case 'REFUND': t.refundsEurMinor += e.includedEurMinor; break;
      case 'INDEMNITY': t.indemnitiesEurMinor += e.includedEurMinor; break;
      case 'PROCEED': t.proceedsEurMinor += e.includedEurMinor; break;
      default: break;
    }
  }
  t.netCostEurMinor = t.costsEurMinor - t.reductionsEurMinor - t.refundsEurMinor - t.indemnitiesEurMinor;
  t.unconverted = [...devises.values()].sort((a, b) => a.currency.localeCompare(b.currency) || a.kind.localeCompare(b.kind));
  return t;
}

// ── Contrôles automatiques (§4.5) ──────────────────────────────────────────

export type LedgerAnomalyCode =
  | 'SUM_MISMATCH'            // somme des postes ≠ total
  | 'DUPLICATE_COMPONENT'     // composante comptée deux fois
  | 'INDEMNITY_DUPLICATED'    // même indemnité portée deux fois sur un sinistre
  | 'UNKNOWN_CURRENCY_AS_ZERO'// devise inconnue comptée comme 0
  | 'UNALLOCATED_COUNTED';    // multi-biens non ventilé compté

export interface LedgerAnomaly { code: LedgerAnomalyCode; componentIds: number[]; detail?: string }

/**
 * Contrôles de cohérence d'un ensemble d'entrées et de postes (pure) : ce qui
 * est détecté est TRACÉ (diagnostic BO), jamais corrigé en silence.
 */
export function checkLedger(entries: readonly LedgerEntry[], posts?: { totalEurMinor: number; postsEurMinor: readonly number[] }): LedgerAnomaly[] {
  const out: LedgerAnomaly[] = [];
  const parId = new Map<number, number>();
  for (const e of entries) parId.set(e.componentId, (parId.get(e.componentId) ?? 0) + 1);
  const doublons = [...parId.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (doublons.length) out.push({ code: 'DUPLICATE_COMPONENT', componentIds: doublons });
  const zero = entries.filter((e) => e.included && e.eurMinor === null);
  if (zero.length) out.push({ code: 'UNKNOWN_CURRENCY_AS_ZERO', componentIds: zero.map((e) => e.componentId) });
  const nv = entries.filter((e) => e.included && e.attribution === 'UNALLOCATED');
  if (nv.length) out.push({ code: 'UNALLOCATED_COUNTED', componentIds: nv.map((e) => e.componentId) });
  const indemnites = new Map<string, number[]>();
  for (const e of entries.filter((x) => x.effect === 'INDEMNITY' && x.included)) {
    const k = `${e.operationId}:${e.currency}:${e.amountMinor}`;
    indemnites.set(k, [...(indemnites.get(k) ?? []), e.componentId]);
  }
  for (const ids of indemnites.values()) if (ids.length > 1) out.push({ code: 'INDEMNITY_DUPLICATED', componentIds: ids });
  if (posts) {
    const s = posts.postsEurMinor.reduce((n, x) => n + x, 0);
    if (s !== posts.totalEurMinor) out.push({ code: 'SUM_MISMATCH', componentIds: [], detail: `${s} ≠ ${posts.totalEurMinor}` });
  }
  return out;
}

/** Statut de lecture d'un calcul (§4.4 : distinguer complet, incomplet, partiel, erreur). */
export type ReadStatus = 'COMPLETE' | 'INCOMPLETE' | 'PARTIAL' | 'ERROR';
