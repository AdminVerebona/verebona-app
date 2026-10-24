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
 *     soient ses justificatifs ;
 *   · lot 81D : dates civiles STRICTES (`isIsoDate`, jamais normalisées) ;
 *     avec une date de référence (`asOf`, `civilDateParis`), une dépense
 *     datée après n'est pas réalisée (`FUTURE_DATED`) ; une Opération PRÉVUE
 *     n'est réalisée que par un paiement daté (jamais la date planifiée) et
 *     justifié (`NOT_REALIZED` sinon) ; les contradictions statut / date /
 *     nature sont tracées (`contradiction`), jamais corrigées en silence.
 *   · lot 86F : la date d'une composante est SA date économique
 *     (`economicDate`, résolue par `./economic-date` : paiement prouvé, date
 *     propre, justificatif, réalisation d'une Opération ponctuelle à fait
 *     unique) — le repli générique vers la date de l'Opération est SUPPRIMÉ
 *     (plus de `fallbackDate`) ; sans date établie, la composante compte sans
 *     année (jamais une date supposée).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { FinancialComponentKind } from '../model';
import type { EconomicDateResolution } from './economic-date';

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
  /**
   * Lot 61 (TCO) : identifiant STABLE de la ligne économique quand elle ne
   * vient pas d'une composante consolidée (`doc:<fichier>…`, `asset:<bien>:…`).
   * Absent : composante d'Opération, identifiée par `id`.
   */
  lineId?: string;
  /**
   * Lot 86F : résolution de la date économique (`./economic-date`) dont
   * `economicDate` est le résultat — provenance, justification, dates
   * disponibles. Absente : `economicDate` est la date propre de la composante.
   */
  economicDateResolution?: EconomicDateResolution;
}

/** Clé d'unicité d'une ligne : `lineId` (dépense documentaire, fiche) ou la composante (lot 61). */
export const ledgerKey = (e: { lineId?: string; componentId: number }): string => e.lineId ?? `c:${e.componentId}`;

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

/**
 * Lot 81D — date civile STRICTE (`YYYY-MM-DD`, éventuellement suivie d'une
 * heure `T…` ou ` …`) : mois 01–12, jour existant dans le calendrier
 * (années bissextiles grégoriennes). Validation CENTRALISÉE : `Date.parse`
 * acceptait le 29/02/2025 ou le 30/02/2026 en les normalisant silencieusement
 * au 1er / 2 mars. Aucune borne d'ancienneté : une acquisition historique
 * (avant 1900) reste valide.
 */
export const isIsoDate = (d: string | null | undefined): d is string => {
  if (typeof d !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(d);
  if (!m) return false;
  const [y, mo, j] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || j < 1) return false;
  const bissextile = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const jours = [31, bissextile ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return j <= jours;
};

/** Lot 81D — jour civil d'une date valide (`YYYY-MM-DD`), ou null (absente ou impossible) — jamais normalisée. */
export const isoDayOrNull = (d: string | null | undefined): string | null => (isIsoDate(d) ? d.slice(0, 10) : null);

/** Fuseau des dates civiles de Verebona (convention métier). */
export const VEREBONA_TIME_ZONE = 'Europe/Paris';

/**
 * Lot 81D — date civile à Paris de l'instant `now` (`YYYY-MM-DD`) : date de
 * référence UNIQUE du TCO (cumul, annualisation, dépenses de l'année), au
 * lieu de la date UTC du serveur (décalée entre minuit et 1 h / 2 h).
 * Injectable : les tests passent l'instant ou la date de référence.
 */
export function civilDateParis(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: VEREBONA_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const v = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${v('year')}-${v('month')}-${v('day')}`;
}

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
  | 'OPERATION_CANCELLED'      // Opération annulée
  // Lot 81D : dépense non réalisée — Opération prévue sans paiement daté et justifié (une composante
  // « coût réalisé » ne suffit pas), ou dépense datée après la date de référence (jamais anticipée).
  | 'NOT_REALIZED'
  | 'FUTURE_DATED';

export const EXCLUSION_LABELS: Readonly<Record<ExclusionReason, string>> = {
  FORECAST: 'Prévision ou devis, non réalisé',
  UNCONVERTED_CURRENCY: 'Devise sans contre-valeur en euros établie',
  UNALLOCATED_MULTI_ASSET: 'Commun à plusieurs biens, non ventilé',
  OUT_OF_SCOPE: 'Concerne un autre bien',
  AFTER_DISPOSAL: 'Postérieur à la cession',
  PRORATA_AFTER_DISPOSAL: 'Part de la période postérieure à la cession',
  OPERATION_CANCELLED: 'Opération annulée',
  NOT_REALIZED: 'Dépense prévue, non réalisée : aucun paiement daté et justifié',
  FUTURE_DATED: 'Datée après aujourd’hui : non encore réalisée',
};

/** Lot 81D : contradiction entre statut, date et nature d'une composante (signalée, jamais corrigée en silence). */
export type LedgerContradiction =
  | 'PLANNED_WITHOUT_PROOF'   // Opération prévue portant un « coût réalisé » sans paiement daté et justifié
  | 'PLANNED_WITH_PAYMENT'    // Opération prévue, paiement daté et justifié : compté, statut à vérifier
  | 'REALIZED_FUTURE_DATE';   // Opération réalisée, dépense datée après la date de référence

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
  /** Lot 61 : identifiant stable d'une ligne non consolidée (voir `LedgerComponent.lineId`). */
  lineId?: string;
  /** Lot 81D : contradiction statut / date / nature constatée. */
  contradiction?: LedgerContradiction;
  /** Lot 81D : date fournie mais impossible (ex. 29/02/2025) — ignorée, jamais normalisée. */
  dateRejected?: string;
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
  /**
   * Lot 86F : date EFFECTIVE de l'Opération (réalisation, sinon début) —
   * JAMAIS une date économique : seulement un signal de NON-réalisation pour
   * une composante sans date établie (Opération datée après la date de
   * référence → `FUTURE_DATED`, la composante reste sans date).
   */
  operationEffectiveDate?: string | null;
  /**
   * Lot 81D : date de référence (date civile, `civilDateParis`). Une dépense
   * datée APRÈS n'est pas réalisée : exclue (`FUTURE_DATED`). Absente : aucun
   * contrôle (compatibilité des appelants sans date de référence).
   */
  asOf?: string | null;
  /**
   * Lot 81D : la composante est portée par un justificatif (preuve de
   * paiement) — seule une composante d'Opération PRÉVUE datée ET justifiée
   * est comptée comme réalisée.
   */
  realizationEvidence?: boolean;
}

/** Lot 81D : statuts d'Opération non réalisée (ENVISAGED ; PLANNED : ancien libellé). */
const PREVUE = new Set(['ENVISAGED', 'PLANNED']);

/** Évalue UNE composante : effet, EUR, attribution, inclusion ou motif d'exclusion (pure). */
export function evaluateComponent(c: LedgerComponent, ctx: EvaluateContext): LedgerEntry {
  const effect = COMPONENT_EFFECT[c.kind];
  const eur = componentEurMinor(c);
  const attribution = attributeComponent(c, ctx.operationAssetIds, ctx.scope, ctx.equipmentAssets);
  // Lot 81D : dates STRICTES (jamais normalisées) ; Opération prévue : seule la date propre de la dépense
  // (paiement) la date — ni la date planifiée, ni la date de l'Opération.
  // Lot 86F : aucun repli vers la date de l'Opération — la date est la date économique résolue de la composante.
  const prevue = PREVUE.has(String(ctx.operationStatus ?? ''));
  const propre = isoDayOrNull(c.economicDate);
  const date = propre;
  const rejetee = c.economicDate && !propre ? c.economicDate : c.economicDateResolution?.rejectedOwnDate ?? null;
  const base: LedgerEntry = {
    componentId: c.id, operationId: c.operationId, kind: c.kind, effect, amountMinor: c.amountMinor, currency: String(c.currency).trim().toUpperCase(),
    eurMinor: eur, includedEurMinor: 0, included: false, exclusion: null, attribution, date,
    ...(c.lineId ? { lineId: c.lineId } : {}),
    ...(rejetee ? { dateRejected: String(rejetee) } : {}),
  };
  const exclu = (r: ExclusionReason, contradiction?: LedgerContradiction): LedgerEntry => ({ ...base, exclusion: r, ...(contradiction ? { contradiction } : {}) });
  if (attribution === 'OUT') return exclu('OUT_OF_SCOPE');
  if (effect === 'FORECAST') return exclu('FORECAST');
  if (ctx.operationStatus === 'CANCELLED') return exclu('OPERATION_CANCELLED');
  // Lot 81D : une Opération PRÉVUE ne devient pas réalisée par la seule présence d'un « coût réalisé » — il faut un
  // paiement DATÉ (jamais la date planifiée), non futur, et JUSTIFIÉ ; sinon non réalisé (contradiction signalée).
  let contradiction: LedgerContradiction | undefined;
  if (prevue) {
    // Lot 86F : seul un paiement (ou la date propre du montant) établit la réalisation — jamais la date d'un justificatif.
    const fondement = c.economicDateResolution?.basis ?? null;
    const paiementDate = fondement === null || fondement === 'PAYMENT' || fondement === 'AMOUNT_DATE';
    if (!propre || !paiementDate || (ctx.asOf && propre > ctx.asOf) || !ctx.realizationEvidence) return exclu('NOT_REALIZED', 'PLANNED_WITHOUT_PROOF');
    contradiction = 'PLANNED_WITH_PAYMENT';
  }
  // Lot 81D : datée après la date de référence → non encore réalisée (exclue des trois indicateurs du TCO).
  if (ctx.asOf && date && date > ctx.asOf) return exclu('FUTURE_DATED', ctx.operationStatus === 'REALIZED' ? 'REALIZED_FUTURE_DATE' : undefined);
  // Lot 86F : sans date établie, une Opération dont la date effective est postérieure n'est pas encore réalisée (jamais datée par elle).
  const effective = isoDayOrNull(ctx.operationEffectiveDate);
  if (ctx.asOf && !date && effective && effective > ctx.asOf) return exclu('FUTURE_DATED', ctx.operationStatus === 'REALIZED' ? 'REALIZED_FUTURE_DATE' : undefined);
  if (attribution === 'UNALLOCATED') return exclu('UNALLOCATED_MULTI_ASSET');
  if (eur == null) return { ...exclu('UNCONVERTED_CURRENCY'), ...(contradiction ? { contradiction } : {}) };
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
  return { ...base, included: true, includedEurMinor: retenu, prorata, ...(contradiction ? { contradiction } : {}) };
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
  const vus = new Set<string>();
  const t: LedgerTotals = {
    costsEurMinor: 0, reductionsEurMinor: 0, refundsEurMinor: 0, indemnitiesEurMinor: 0, proceedsEurMinor: 0, netCostEurMinor: 0,
    forecastEurMinor: 0, unconverted: [], unallocated: { count: 0, eurMinor: 0 }, complete: true,
  };
  const devises = new Map<string, { currency: string; amountMinor: number; kind: FinancialComponentKind }>();
  for (const e of entries) {
    const cle = ledgerKey(e);
    if (vus.has(cle)) continue;
    vus.add(cle);
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
  const parId = new Map<string, { n: number; componentId: number }>();
  for (const e of entries) {
    const k = ledgerKey(e);
    parId.set(k, { n: (parId.get(k)?.n ?? 0) + 1, componentId: e.componentId });
  }
  const doublons = [...parId.entries()].filter(([, v]) => v.n > 1);
  if (doublons.length) {
    out.push({
      code: 'DUPLICATE_COMPONENT', componentIds: doublons.map(([, v]) => v.componentId),
      // Lot 61 : lignes documentaires dupliquées désignées par leur identifiant stable.
      ...(doublons.some(([k]) => !k.startsWith('c:')) ? { detail: doublons.map(([k]) => k).join(' ') } : {}),
    });
  }
  const zero = entries.filter((e) => e.included && e.eurMinor === null);
  if (zero.length) out.push({ code: 'UNKNOWN_CURRENCY_AS_ZERO', componentIds: zero.map((e) => e.componentId) });
  const nv = entries.filter((e) => e.included && e.attribution === 'UNALLOCATED');
  if (nv.length) out.push({ code: 'UNALLOCATED_COUNTED', componentIds: nv.map((e) => e.componentId) });
  const indemnites = new Map<string, number[]>();
  for (const e of entries.filter((x) => x.effect === 'INDEMNITY' && x.included && !x.lineId)) {
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
