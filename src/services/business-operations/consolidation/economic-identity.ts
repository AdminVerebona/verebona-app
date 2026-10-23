/**
 * Lot 78A — contrôle d'IDENTITÉ ÉCONOMIQUE avant tout rattachement automatique
 * (ticket « [P1] Opérations & TCO — Fiabiliser l'identité économique », §2A,
 * §2B, §2C, §5). Règles PURES, sans base, sans IA.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * L'Opération #76 (commande de quatre chaises, 277,35 €) a absorbé, par la
 * règle M2 « même cycle de possession », les documents d'acquisition de la
 * maison (490 000 €, 2007 / 2021) : même bien parent, même type ACQUISITION,
 * aucune cession entre les deux — et AUCUN contrôle de ce qui était acquis,
 * de qui, pour combien, quand. Le cycle de possession (comme le bien parent,
 * un document partagé, un libellé, une proximité de dates ou de montants)
 * n'est qu'une CONDITION, jamais une preuve d'identité.
 *
 * QUOI
 *
 * Une « empreinte économique » (`EconomicFootprint`) résume ce qu'une source
 * (candidat T1, donnée structurée du bien) ou une Opération dit de la
 * transaction : nature, tiers, biens et équipements, références, date
 * principale, montants PRINCIPAUX (coût / produit de portée totale) et
 * montants réglés. `assessEconomicIdentity` compare deux empreintes et rend :
 *
 *   indices POSITIFS   référence identifiante commune, même tiers, montants
 *                      concordants (≤ 1 %), même date (donnée de la fiche)
 *   contradictions     tiers différents, montants différents, dates
 *     FAIBLES          éloignées (au-delà de la fenêtre du type), équipements
 *                      d'un côté seulement
 *   contradictions     montants d'ordres de grandeur différents (× 10),
 *     FORTES           équipements explicites disjoints, acquisition du bien
 *                      lui-même (fiche) face à l'achat d'un équipement
 *
 *   verdict            CONTRADICTED : une contradiction forte, ou deux faibles ;
 *                      CONFIRMED / UNPROVEN : selon la BASE du rapprochement
 *                      (voir `assessEconomicIdentity`).
 *
 * Aucune règle propre à un commerçant, à un document ou à un exemple : les
 * seuils sont des ordres de grandeur économiques documentés ci-dessous.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { BusinessOperationTypeCode, ReferenceKind } from '../model';
import { hasRecurringPeriod, transactionWindowDays, type CandidateIdentity, type PersistedFinancialHint } from './model';

export { transactionWindowDays };

/** Ce qu'une source ou une Opération dit de la transaction économique. */
export interface EconomicFootprint {
  type: BusinessOperationTypeCode | null;
  providerKey: string | null;
  assetIds: readonly number[];
  equipmentIds: readonly number[];
  refs: ReadonlyArray<{ kind: ReferenceKind; normalized: string }>;
  /** Date principale (réalisation, à défaut début, prévue, fin). */
  date: string | null;
  /**
   * Montants principaux : coût prévu / réalisé (`COST`) ou produit (`PROCEED`), portée totale (ni acompte,
   * ni solde, ni frais, ni échéance). Un coût ne se compare jamais à un produit (frais d'une vente ≠ prix).
   */
  principal: ReadonlyArray<{ amountMinor: number; currency: string; direction?: 'COST' | 'PROCEED' }>;
  /** Montants réglés (preuve de paiement) : concordance seulement, jamais contradiction. */
  payments: ReadonlyArray<{ amountMinor: number; currency: string }>;
  /**
   * Lot 84E : montants d'ÉCHÉANCE (portée INSTALLMENT, coût ou produit) — comparés seulement
   * en ordre de grandeur par la base `SERIES` ; absents : aucun.
   */
  installments?: ReadonlyArray<{ amountMinor: number; currency: string; direction?: 'COST' | 'PROCEED' }>;
  /** Échéances d'un contrat ou d'un abonnement : les montants ne se comparent pas. */
  periodic: boolean;
  /** Donnée structurée de la fiche du bien (lot 43) : décrit le bien LUI-MÊME. */
  structured: boolean;
  summary: string | null;
}

export type IdentityBasis =
  /** Référence identifiante commune (M1). */
  | 'REFERENCE'
  /** Même cycle de possession (M2, acquisition / cession). */
  | 'OWNERSHIP_CYCLE'
  /** Continuité d'une source déjà rattachée (réanalyse, réévaluation historique). */
  | 'SAME_SOURCE'
  /** Deux candidats d'un même document. */
  | 'SAME_DOCUMENT'
  /** Verdict sémantique (M3, IA). */
  | 'SEMANTIC'
  /**
   * Lot 84E (CDC v5 O-6) : identité de SÉRIE établie par le code (même
   * prestataire + clé de service commune, `recurrence.ts`). Des échéances
   * aux montants différents sont attendues (AC46) — mais un montant d'un
   * AUTRE ordre de grandeur (× 10) reste une contradiction FORTE, et la
   * fenêtre de dates ne s'applique pas (un abonnement dure).
   */
  | 'SERIES';

export const IDENTITY_POSITIVE = ['SHARED_REFERENCE', 'PROVIDER_SAME', 'AMOUNT_COHERENT', 'DATE_SAME'] as const;
export const IDENTITY_WEAK = ['PROVIDER_DIFFERENT', 'AMOUNT_DIFFERENT', 'DATE_APART', 'EQUIPMENT_SCOPE_DIFFERENT'] as const;
export const IDENTITY_STRONG = ['AMOUNT_INCOMPATIBLE', 'EQUIPMENT_DISJOINT', 'OBJECT_INCOMPATIBLE'] as const;
export type IdentityPositive = (typeof IDENTITY_POSITIVE)[number];
export type IdentityWeak = (typeof IDENTITY_WEAK)[number];
export type IdentityStrong = (typeof IDENTITY_STRONG)[number];
export type IdentitySignal = IdentityPositive | IdentityWeak | IdentityStrong;

export type IdentityVerdict = 'CONFIRMED' | 'UNPROVEN' | 'CONTRADICTED';

export interface IdentityAssessment {
  verdict: IdentityVerdict;
  positives: IdentityPositive[];
  weak: IdentityWeak[];
  strong: IdentityStrong[];
}

/** Rapport de montants à partir duquel deux transactions sont d'ordres de grandeur différents. */
export const AMOUNT_INCOMPATIBLE_RATIO = 10;
/** Tolérance de concordance des montants (1 %, au moins une unité mineure). */
export const AMOUNT_COHERENT_TOLERANCE = 0.01;
/** Écart (jours) en deçà duquel une date de fiche et une date de document désignent le même jour économique. */
export const SAME_DATE_DAYS = 7;

const PRINCIPAL_ROLES = new Set(['REALIZED_COST', 'FORECAST_COST', 'PROCEED']);
const principalScope = (h: Pick<PersistedFinancialHint, 'amountScope'>) => h.amountScope === null || h.amountScope === undefined || h.amountScope === 'TOTAL';
const etablie = (currency: string) => /^[A-Z]{3}$/.test(currency) && currency !== 'XXX';

/** Montants principaux et réglés d'indices T1 (pure). */
export function amountsOfHints(hints: readonly PersistedFinancialHint[]): Pick<EconomicFootprint, 'principal' | 'payments' | 'installments'> {
  const principal: Array<{ amountMinor: number; currency: string; direction: 'COST' | 'PROCEED' }> = [];
  const payments: Array<{ amountMinor: number; currency: string }> = [];
  const installments: Array<{ amountMinor: number; currency: string; direction: 'COST' | 'PROCEED' }> = [];
  for (const h of hints) {
    if (!etablie(h.currency) || !(h.amountMinor > 0)) continue;
    if (PRINCIPAL_ROLES.has(h.role) && principalScope(h)) principal.push({ amountMinor: h.amountMinor, currency: h.currency, direction: h.role === 'PROCEED' ? 'PROCEED' : 'COST' });
    else if (h.role === 'PAYMENT' && principalScope(h)) payments.push({ amountMinor: h.amountMinor, currency: h.currency });
    else if (PRINCIPAL_ROLES.has(h.role) && h.amountScope === 'INSTALLMENT') installments.push({ amountMinor: h.amountMinor, currency: h.currency, direction: h.role === 'PROCEED' ? 'PROCEED' : 'COST' });
  }
  return { principal, payments, ...(installments.length ? { installments } : {}) };
}

const mainDate = (d: { realizedDate: string | null; startDate: string | null; plannedDate: string | null; endDate: string | null }) =>
  d.realizedDate ?? d.startDate ?? d.plannedDate ?? d.endDate ?? null;

/** Empreinte d'un candidat (document) ou d'une donnée structurée (pure). */
export function footprintOfIdentity(c: CandidateIdentity): EconomicFootprint {
  return {
    type: c.type, providerKey: c.providerKey, assetIds: c.assetIds, equipmentIds: c.equipmentIds,
    refs: c.refs.map((r) => ({ kind: r.kind, normalized: r.normalized })),
    date: mainDate(c.dates), ...amountsOfHints(c.hints), periodic: hasRecurringPeriod(c),
    structured: !!c.structured, summary: c.summary || null,
  };
}

/** Vue minimale d'une Opération (agrégat de ses sources), pour l'empreinte de repli. */
export interface OperationFootprintInput {
  typeCode: BusinessOperationTypeCode | null;
  providerKey: string | null;
  assetIds: readonly number[];
  refs: ReadonlyArray<{ kind: ReferenceKind; normalized: string }>;
  plannedDate: string | null; startDate: string | null; realizedDate: string | null; endDate: string | null;
  label?: string | null;
  amounts?: ReadonlyArray<{ kind: string; amountMinor: number; currency: string }>;
  periodic?: boolean;
}

/**
 * Empreinte AGRÉGÉE d'une Opération (repli quand ses sources ne sont pas
 * chargées) : tous ses montants actifs, ses références, sa date principale.
 * Moins précise que l'examen source par source (`members`), jamais plus
 * permissive : un agrégat déjà contaminé porte aussi les montants intrus.
 */
export function footprintOfOperation(o: OperationFootprintInput): EconomicFootprint {
  const principal = (o.amounts ?? []).filter((a) => PRINCIPAL_ROLES.has(a.kind) && a.amountMinor > 0 && etablie(a.currency))
    .map((a) => ({ amountMinor: a.amountMinor, currency: a.currency, direction: a.kind === 'PROCEED' ? 'PROCEED' as const : 'COST' as const }));
  return {
    type: o.typeCode, providerKey: o.providerKey, assetIds: o.assetIds, equipmentIds: [], refs: o.refs,
    date: mainDate(o), principal, payments: [], periodic: o.periodic === true || o.typeCode === 'CONTRACT',
    structured: false, summary: o.label ?? null,
  };
}

const JOUR = 86_400_000;
function ecartJours(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const x = Date.parse(`${a}T00:00:00Z`);
  const y = Date.parse(`${b}T00:00:00Z`);
  return Number.isNaN(x) || Number.isNaN(y) ? null : Math.abs(x - y) / JOUR;
}

const coherent = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.round(Math.max(a, b) * AMOUNT_COHERENT_TOLERANCE));

/**
 * Comparaison des montants (pure) : concordants, différents, incompatibles, ou rien à comparer.
 * Lot 84E : `seriesScale` — échéances d'une série : seule l'INCOMPATIBILITÉ d'ordre de grandeur est relevée.
 */
export function compareAmounts(a: EconomicFootprint, b: EconomicFootprint, opts: { seriesScale?: boolean } = {}): 'COHERENT' | 'DIFFERENT' | 'INCOMPATIBLE' | null {
  const tousA = [...a.principal, ...a.payments];
  const tousB = [...b.principal, ...b.payments];
  if (tousA.some((x) => tousB.some((y) => x.currency === y.currency && coherent(x.amountMinor, y.amountMinor)))) return 'COHERENT';
  if (opts.seriesScale) {
    // Lot 84E (série) : montants principaux ET échéances (portée INSTALLMENT comprise) comparés en ordre de grandeur.
    const ma = [...a.principal, ...(a.installments ?? [])];
    const mb = [...b.principal, ...(b.installments ?? [])];
    const paires = ma.flatMap((x) => mb.filter((y) => y.currency === x.currency && (y.direction ?? 'COST') === (x.direction ?? 'COST'))
      .map((y) => [x.amountMinor, y.amountMinor] as const));
    if (!paires.length) return null;
    return paires.every(([x, y]) => Math.max(x, y) >= AMOUNT_INCOMPATIBLE_RATIO * Math.min(x, y)) ? 'INCOMPATIBLE' : null;
  }
  // Échéances, contrats, financements : des montants différents sont attendus.
  if (a.periodic || b.periodic) return null;
  const type = a.type ?? b.type;
  if (type === 'CONTRACT' || type === 'FINANCING' || type === 'CLAIM') return null;
  const paires = a.principal.flatMap((x) => b.principal.filter((y) => y.currency === x.currency && (y.direction ?? 'COST') === (x.direction ?? 'COST'))
    .map((y) => [x.amountMinor, y.amountMinor] as const));
  if (!paires.length) return null;
  const incompatibles = paires.every(([x, y]) => Math.max(x, y) >= AMOUNT_INCOMPATIBLE_RATIO * Math.min(x, y));
  return incompatibles ? 'INCOMPATIBLE' : 'DIFFERENT';
}

/** Écart relatif (fiche du bien) en deçà duquel un prix saisi et un prix documentaire décrivent le même achat. */
export const STRUCTURED_AMOUNT_TOLERANCE = 0.1;
function closeAmounts(a: EconomicFootprint, b: EconomicFootprint): boolean {
  return a.principal.some((x) => b.principal.some((y) => x.currency === y.currency && (x.direction ?? 'COST') === (y.direction ?? 'COST')
    && Math.abs(x.amountMinor - y.amountMinor) <= STRUCTURED_AMOUNT_TOLERANCE * Math.max(x.amountMinor, y.amountMinor)));
}

const refKey = (r: { kind: ReferenceKind; normalized: string }) => `${r.kind}:${r.normalized}`;
/** Natures de références qui identifient une transaction (jamais le numéro client). */
const IDENTIFYING: ReadonlySet<ReferenceKind> = new Set(['INVOICE', 'QUOTE', 'ORDER', 'WORK_ORDER', 'DELIVERY', 'CONTRACT', 'POLICY', 'CLAIM', 'LOAN']);

/**
 * Compare deux empreintes économiques (pure, symétrique). Verdict selon la
 * BASE du rapprochement envisagé :
 *   · contradiction FORTE, ou au moins DEUX faibles → CONTRADICTED (toutes bases) ;
 *   · SEMANTIC (verdict IA) : seule une contradiction FORTE l'écarte ;
 *   · REFERENCE, SAME_SOURCE, SAME_DOCUMENT : l'identité est déjà portée par
 *     la référence, la continuité ou le document → CONFIRMED sauf contradiction ;
 *   · OWNERSHIP_CYCLE : le cycle n'est qu'une condition — il faut un indice
 *     POSITIF (référence, tiers, montant concordant ; même date seulement face
 *     à la fiche du bien) et aucune contradiction faible, sauf un tiers
 *     différent compensé par un montant concordant (vendeur, notaire, agence
 *     d'une même vente). Une donnée de la fiche sans aucun élément comparable
 *     reste rapprochée (règle du lot 43). Sinon UNPROVEN (différé).
 */
export function assessEconomicIdentity(a: EconomicFootprint, b: EconomicFootprint, basis: IdentityBasis): IdentityAssessment {
  const positives: IdentityPositive[] = [];
  const weak: IdentityWeak[] = [];
  const strong: IdentityStrong[] = [];

  const refsB = new Set(b.refs.filter((r) => IDENTIFYING.has(r.kind)).map(refKey));
  if (a.refs.some((r) => IDENTIFYING.has(r.kind) && refsB.has(refKey(r)))) positives.push('SHARED_REFERENCE');

  if (a.providerKey !== null && b.providerKey !== null) {
    if (a.providerKey === b.providerKey) positives.push('PROVIDER_SAME');
    else weak.push('PROVIDER_DIFFERENT');
  }

  const serie = basis === 'SERIES';
  const montants = compareAmounts(a, b, { seriesScale: serie });
  if (montants === 'COHERENT') positives.push('AMOUNT_COHERENT');
  // Prix SAISI sur la fiche du bien face au prix d'un document (TTC / HT, arrondi) : un écart
  // modéré n'est pas une contradiction (la saisie prime, l'écart reste exposé — lot 53D).
  else if (montants === 'DIFFERENT' && !((a.structured || b.structured) && closeAmounts(a, b))) weak.push('AMOUNT_DIFFERENT');
  else if (montants === 'INCOMPATIBLE') strong.push('AMOUNT_INCOMPATIBLE');

  const fenetre = transactionWindowDays(a.type ?? b.type);
  const ecart = ecartJours(a.date, b.date);
  if (ecart !== null) {
    if ((a.structured || b.structured) && ecart <= SAME_DATE_DAYS) positives.push('DATE_SAME');
    if (fenetre !== null && ecart > fenetre && !serie) weak.push('DATE_APART');
  }

  if (a.equipmentIds.length && b.equipmentIds.length) {
    if (!a.equipmentIds.some((e) => b.equipmentIds.includes(e))) strong.push('EQUIPMENT_DISJOINT');
  } else if (a.equipmentIds.length || b.equipmentIds.length) {
    // Données du bien principal (fiche) ≠ achat ou cession d'un de ses équipements.
    const cycle = (a.type ?? b.type) === 'ACQUISITION' || (a.type ?? b.type) === 'DISPOSAL';
    if (cycle && (a.structured || b.structured)) strong.push('OBJECT_INCOMPATIBLE');
    else weak.push('EQUIPMENT_SCOPE_DIFFERENT');
  }

  const out = (verdict: IdentityVerdict): IdentityAssessment => ({ verdict, positives, weak, strong });
  if (strong.length) return out('CONTRADICTED');
  if (basis === 'SEMANTIC') return out('CONFIRMED');
  if (weak.length >= 2) return out('CONTRADICTED');
  if (basis !== 'OWNERSHIP_CYCLE') return out('CONFIRMED');
  if (positives.length && (weak.length === 0 || (weak[0] === 'PROVIDER_DIFFERENT' && positives.includes('AMOUNT_COHERENT')))) return out('CONFIRMED');
  if ((a.structured || b.structured) && weak.length === 0) return out('CONFIRMED');
  return out('UNPROVEN');
}

/** Source déjà rattachée à une Opération, telle que le contrôle d'identité la voit. */
export interface OperationMember {
  sourceId: number;
  footprint: EconomicFootprint;
  /** Source fondatrice : la plus ancienne source gérée active de l'Opération. */
  anchor: boolean;
}

/**
 * Combine l'examen d'une source face aux sources d'une Opération (pure) :
 * une contradiction FORTE face à l'une d'elles l'emporte (l'Opération porte
 * déjà une transaction incompatible) ; sinon le meilleur verdict obtenu.
 */
export function assessAgainstMembers(c: EconomicFootprint, members: readonly OperationMember[], basis: IdentityBasis): IdentityAssessment & { against: number[] } {
  const examens = members.map((m) => ({ m, a: assessEconomicIdentity(c, m.footprint, basis) }));
  const forte = examens.find((x) => x.a.strong.length);
  if (forte) return { ...forte.a, against: [forte.m.sourceId] };
  const rang: Record<IdentityVerdict, number> = { CONFIRMED: 0, UNPROVEN: 1, CONTRADICTED: 2 };
  const meilleur = [...examens].sort((x, y) => rang[x.a.verdict] - rang[y.a.verdict])[0];
  return meilleur ? { ...meilleur.a, against: [meilleur.m.sourceId] } : { verdict: 'CONFIRMED', positives: [], weak: [], strong: [], against: [] };
}

/**
 * Réévaluation d'un rattachement EXISTANT (continuité de source, §5) — pure.
 * La source fondatrice (`anchor`) définit l'identité de l'Opération :
 *   · contredite face à la fondatrice → SÉPARER (certain) ;
 *   · fondatrice muette (non concluante) mais contradiction avec une autre
 *     source et confirmation par aucune → SÉPARER ;
 *   · contradiction ailleurs (sans certitude) → SUSPECT : la source RESTE,
 *     l'anomalie est signalée pour examen ;
 *   · sinon conservée.
 * La source fondatrice elle-même n'est jamais séparée par cette règle (ce sont
 * les intruses qui partent, chacune à son tour).
 */
export function reviewExistingAttachment(c: EconomicFootprint, members: readonly OperationMember[]): {
  outcome: 'KEEP' | 'SEPARATE' | 'SUSPECT'; assessment: IdentityAssessment | null; against: number[];
} {
  if (!members.length) return { outcome: 'KEEP', assessment: null, against: [] };
  const examens = members.map((m) => ({ m, a: assessEconomicIdentity(c, m.footprint, 'SAME_SOURCE') }));
  const fondatrice = examens.find((x) => x.m.anchor) ?? null;
  const contredites0 = examens.filter((x) => x.a.verdict === 'CONTRADICTED');
  // La source examinée EST la fondatrice : jamais séparée, au plus signalée.
  if (!fondatrice) {
    return contredites0.length
      ? { outcome: 'SUSPECT', assessment: contredites0[0].a, against: contredites0.map((x) => x.m.sourceId) }
      : { outcome: 'KEEP', assessment: null, against: [] };
  }
  if (fondatrice.a.verdict === 'CONTRADICTED') return { outcome: 'SEPARATE', assessment: fondatrice.a, against: [fondatrice.m.sourceId] };
  const contredites = contredites0;
  if (!contredites.length) return { outcome: 'KEEP', assessment: fondatrice.a, against: [] };
  const confirmee = examens.some((x) => x.a.verdict === 'CONFIRMED' && x.a.positives.length > 0);
  if (!confirmee) {
    return { outcome: 'SEPARATE', assessment: contredites[0].a, against: contredites.map((x) => x.m.sourceId) };
  }
  return { outcome: 'SUSPECT', assessment: contredites[0].a, against: contredites.map((x) => x.m.sourceId) };
}

/** Codes stables d'une évaluation (trace, diagnostic). */
export function identitySignals(a: IdentityAssessment): string[] {
  return [...a.positives.map((s) => `+${s}`), ...a.weak.map((s) => `-${s}`), ...a.strong.map((s) => `!${s}`)];
}
