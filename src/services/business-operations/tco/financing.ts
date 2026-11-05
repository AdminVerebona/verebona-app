/**
 * Lot 111F (ticket P1 « TCO — coût de possession, financement et
 * valorisation », §3) — financement d'un bien. PUR, sans import serveur.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN SECOND RÉFÉRENTIEL, AUCUN SECOND MOTEUR
 *
 * Un prêt = une Opération FINANCING existante (principal, PTZ, prêt travaux,
 * crédit auto…), reliée au bien par les liens existants ; ses données
 * contractuelles sont celles de `business_operation_financing_details`
 * (référence, prêteur, capital, dates) et ses coûts sont ses composantes
 * financières consolidées par T3 (intérêts, assurance emprunteur, frais),
 * datées par échéance, avec leurs justificatifs (offre, tableau
 * d'amortissement, avenant). Les prêts du bien sont consolidés ici, à partir
 * des lignes que le moteur TCO vient d'évaluer (`TcoEconomicLine`) : le coût
 * du crédit à date est EXACTEMENT la part « financement » du coût total
 * (mêmes lignes, mêmes montants retenus).
 *
 * Audit du modèle (lot 111F, §3 « vérifier les lacunes avant extension ») :
 *   · porté par l'existant : échéances (montant, devise, date d'échéance,
 *     période) de chaque coût du crédit, prévision (FORECAST_COST) ou fait
 *     (REALIZED_COST), justificatifs de chaque échéance (provenance), date de
 *     chaque justificatif, capital emprunté (jamais un coût : LOAN_PRINCIPAL),
 *     dates de début et de fin du prêt ;
 *   · NON porté : ventilation du capital par échéance (capital restant dû),
 *     taux et nature (fixe / variable). Le capital restant dû n'est donc pas
 *     affiché ; un taux variable n'est pas inventé (le prévisionnel suit
 *     l'échéancier connu, signalé partiel s'il s'arrête avant le terme).
 *   Aucune migration n'est nécessaire pour les règles ci-dessous.
 *
 * Règles (`planFinancingComponents`) :
 *   · ÉCHÉANCIER CONTRACTUEL : une échéance d'un prêt, justifiée par un
 *     document du prêt et datée au plus tard à la date de référence, est
 *     présumée honorée (« Calculé selon l'échéancier du prêt ») — jamais
 *     « payée » ni « vérifiée » ; aucune preuve de paiement mensuelle exigée.
 *     Une échéance future reste au prévisionnel, jamais au coût à date.
 *   · CAPITAL : un montant égal au capital emprunté n'est jamais un coût
 *     (le prix d'achat du bien est compté une seule fois, quel que soit son
 *     financement) ; les mensualités ne s'ajoutent jamais au prix d'achat.
 *   · AVENANT / REPORT / REMBOURSEMENT ANTICIPÉ / RENÉGOCIATION : un
 *     justificatif PLUS RÉCENT du même prêt qui porte un échéancier remplace,
 *     à partir de sa première échéance (date d'effet), les échéances des
 *     justificatifs antérieurs ; il ne crée jamais un prêt fictif. Deux prêts
 *     distincts (deux Opérations) ne sont jamais fusionnés.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { componentEurMinor, isIsoDate } from '../finance/engine';
import type { FinancialComponentKind } from '../model';

/** Détails contractuels d'un prêt (`business_operation_financing_details`). */
export interface TcoFinancingDetails {
  reference: string | null;
  lender: string | null;
  principalAmountMinor: number | null;
  principalCurrency: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

/** Libellé de la base de calcul (texte exact du ticket, §3) — jamais « réellement payé ». */
export const TCO_FINANCING_BASIS_LABEL = 'Calculé selon l’échéancier du prêt';

/** Traitement d'une composante d'un prêt. */
export type FinancingComponentTreatment =
  | { kind: 'CONTRACTUAL_TO_DATE'; date: string }
  | { kind: 'PRINCIPAL' }
  | { kind: 'SUPERSEDED'; byFileId: number; effectiveFrom: string };

interface PlanComponent {
  id: number;
  kind: FinancialComponentKind;
  amountMinor: number;
  currency: string;
  amountEurCents: number | null;
}

/**
 * Traitements des composantes d'UNE Opération FINANCING (pure, testée
 * L111F-FIN-*). `dateOf` : date d'échéance (date économique résolue) ;
 * `filesOf` : justificatifs qui portent la composante ; `documentDates` :
 * date de chaque justificatif du prêt.
 */
export function planFinancingComponents(input: {
  components: readonly PlanComponent[];
  details: TcoFinancingDetails | null;
  dateOf: (componentId: number) => string | null;
  filesOf: (componentId: number) => readonly number[];
  documentDates: ReadonlyMap<number, string | null>;
  today: string;
}): Map<number, FinancingComponentTreatment> {
  const out = new Map<number, FinancingComponentTreatment>();
  const couts = input.components.filter((c) => c.kind === 'REALIZED_COST' || c.kind === 'FORECAST_COST');
  // Capital emprunté : jamais un coût (même devise, même montant).
  const d = input.details;
  if (d?.principalAmountMinor != null && d.principalAmountMinor > 0 && d.principalCurrency) {
    const cap = componentEurMinor({ amountMinor: d.principalAmountMinor, currency: d.principalCurrency, amountEurCents: null });
    for (const c of couts) {
      const eur = componentEurMinor(c);
      if ((cap != null && eur === cap) || (c.currency.toUpperCase() === d.principalCurrency.toUpperCase() && c.amountMinor === d.principalAmountMinor)) {
        out.set(c.id, { kind: 'PRINCIPAL' });
      }
    }
  }
  const jour = (v: string | null | undefined): string | null => (isIsoDate(v) ? v.slice(0, 10) : null);
  // Échéancier par justificatif : date d'effet = première échéance qu'il porte.
  const parFichier = new Map<number, { effet: string; date: string | null }>();
  for (const c of couts) {
    if (out.has(c.id)) continue;
    const dt = jour(input.dateOf(c.id));
    if (!dt) continue;
    for (const f of input.filesOf(c.id)) {
      const cur = parFichier.get(f);
      if (!cur || dt < cur.effet) parFichier.set(f, { effet: dt, date: jour(input.documentDates.get(f) ?? null) });
    }
  }
  for (const c of couts) {
    if (out.has(c.id)) continue;
    const dt = jour(input.dateOf(c.id));
    const fichiers = input.filesOf(c.id);
    if (dt && fichiers.length) {
      // Justificatif plus récent du même prêt dont l'échéancier commence au plus tard à cette échéance.
      const propres = fichiers.map((f) => parFichier.get(f)?.date ?? null);
      const remplacant = [...parFichier.entries()]
        .filter(([f, x]) => !fichiers.includes(f) && x.date && x.effet <= dt && propres.every((p) => p != null && p < x.date!))
        .sort((a, b) => b[1].date!.localeCompare(a[1].date!) || a[0] - b[0])[0];
      if (remplacant) { out.set(c.id, { kind: 'SUPERSEDED', byFileId: remplacant[0], effectiveFrom: remplacant[1].effet }); continue; }
    }
    // Échéance passée justifiée par un document du prêt (prévision contractuelle ou coût) : présumée honorée.
    if (dt && dt <= input.today.slice(0, 10) && fichiers.length) out.set(c.id, { kind: 'CONTRACTUAL_TO_DATE', date: dt });
  }
  return out;
}

// ── Consolidation des prêts du bien ─────────────────────────────────────────

/** Ligne minimale lue (sous-ensemble de `TcoEconomicLine`). */
interface FinancingLine {
  id: string;
  source: string;
  status: string;
  reason: string | null;
  kind: FinancialComponentKind | null;
  category: string | null;
  includedCents: number;
  eurCents: number | null;
  date: string | null;
  fileId: number | null;
  operationId: number | null;
  financingBasis?: 'SCHEDULE';
}

export interface TcoLoan {
  /** Clé stable du prêt (`op:<id>`, ou `doc:<fichier>` sans événement de référence). */
  key: string;
  operationId: number | null;
  label: string;
  lender: string | null;
  reference: string | null;
  /** Capital emprunté (information, jamais un coût). */
  principalCents: number | null;
  startDate: string | null;
  endDate: string | null;
  /** Coût du crédit à date (intérêts, assurance, frais) — compris dans le coût total. */
  costToDateCents: number;
  /** Échéances futures connues (prévisionnel), jamais ajoutées au coût total. */
  remainingCents: number;
  /** Coût total prévisionnel du crédit sur la durée connue (null : aucun échéancier). */
  contractualTotalCents: number | null;
  /** Au moins une échéance est comptée selon l'échéancier (présumée honorée). */
  scheduleBased: boolean;
  /** L'échéancier connu s'arrête avant la fin du prêt : prévisionnel partiel (estimation). */
  partialSchedule: boolean;
  /** Échéances remplacées par un avenant (à partir de sa date d'effet). */
  supersededCount: number;
}

export interface TcoFinancing {
  loans: TcoLoan[];
  costToDateCents: number;
  remainingCents: number;
  contractualTotalCents: number | null;
  /** « Calculé selon l'échéancier du prêt » dès qu'une échéance est comptée ainsi ; sinon null. */
  basisLabel: string | null;
  /** Prévisionnel partiel ou incertain : estimation identifiée, la suite n'est jamais inventée. */
  estimated: boolean;
  /** Explication (icône d'information). */
  info: string;
}

const RETENUE = (s: string) => s === 'RETAINED_DIRECT' || s === 'RETAINED_CONSOLIDATED';
const CREDITS = new Set(['REDUCTION', 'REFUND', 'INDEMNITY']);
const EXCLUS_PREVISION = new Set(['LOAN_PRINCIPAL', 'FINANCING_SCHEDULE_SUPERSEDED']);
const eurFr = (c: number) => `${(c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Prêts du bien consolidés (pure, testée L111F-FIN-*). */
export function consolidateFinancing(input: {
  operations: ReadonlyArray<{ id: number; label: string; typeCode: string | null; status: string; startDate: string | null; realizedDate: string | null }>;
  details: ReadonlyMap<number, TcoFinancingDetails>;
  lines: readonly FinancingLine[];
  today: string;
}): TcoFinancing {
  const today = input.today.slice(0, 10);
  const prets = new Map<string, TcoLoan>();
  const opsFin = new Map(input.operations.filter((o) => o.typeCode === 'FINANCING' && o.status !== 'CANCELLED').map((o) => [o.id, o]));
  const pret = (key: string, init: () => Omit<TcoLoan, 'costToDateCents' | 'remainingCents' | 'contractualTotalCents' | 'scheduleBased' | 'partialSchedule' | 'supersededCount'>): TcoLoan => {
    let p = prets.get(key);
    if (!p) {
      p = { ...init(), costToDateCents: 0, remainingCents: 0, contractualTotalCents: null, scheduleBased: false, partialSchedule: false, supersededCount: 0 };
      prets.set(key, p);
    }
    return p;
  };
  const vues = new Set<string>();
  const derniereEcheance = new Map<string, string>();
  // Un justificatif d'un prêt consolidé : ses échéances sont les composantes du prêt (jamais comptées deux fois).
  const pretsConsolides = new Set(input.lines.filter((l) => l.source === 'OPERATION' && l.operationId != null && opsFin.has(l.operationId)).map((l) => l.operationId!));
  for (const l of input.lines) {
    if (vues.has(l.id)) continue;
    if (l.source === 'DOCUMENT' && l.operationId != null && pretsConsolides.has(l.operationId) && !RETENUE(l.status)) continue;
    const op = l.operationId != null ? opsFin.get(l.operationId) : undefined;
    const docFinancement = !op && l.source === 'DOCUMENT' && l.category === 'FINANCING' && l.fileId != null;
    if (!op && !docFinancement) continue;
    vues.add(l.id);
    const key = op ? `op:${op.id}` : `doc:${l.fileId}`;
    const p = pret(key, () => {
      const d = op ? input.details.get(op.id) ?? null : null;
      const cap = d?.principalAmountMinor != null && d.principalCurrency
        ? componentEurMinor({ amountMinor: d.principalAmountMinor, currency: d.principalCurrency, amountEurCents: null }) : null;
      return {
        key, operationId: op?.id ?? null, label: op?.label ?? 'Financement (justificatif)', lender: d?.lender ?? null, reference: d?.reference ?? null,
        principalCents: cap, startDate: isIsoDate(d?.effectiveFrom) ? d!.effectiveFrom!.slice(0, 10) : null,
        endDate: isIsoDate(d?.effectiveTo) ? d!.effectiveTo!.slice(0, 10) : null,
      };
    });
    if (l.reason === 'FINANCING_SCHEDULE_SUPERSEDED') { p.supersededCount += 1; continue; }
    if (RETENUE(l.status)) {
      if (l.kind === 'REALIZED_COST') p.costToDateCents += l.includedCents;
      else if (l.kind && CREDITS.has(l.kind)) p.costToDateCents -= l.includedCents;
      if (l.financingBasis === 'SCHEDULE') p.scheduleBased = true;
      if (isIsoDate(l.date)) derniereEcheance.set(key, [derniereEcheance.get(key) ?? '', l.date.slice(0, 10)].sort().pop()!);
      continue;
    }
    // Prévisionnel : échéances futures connues (coûts), jamais le capital ni une échéance remplacée.
    if ((l.kind === 'FORECAST_COST' || l.kind === 'REALIZED_COST') && l.eurCents != null && !EXCLUS_PREVISION.has(l.reason ?? '')
      && isIsoDate(l.date) && l.date.slice(0, 10) > today && (l.status === 'FORECAST' || l.status === 'EXCLUDED')) {
      p.remainingCents += l.eurCents;
      p.scheduleBased = true;
      derniereEcheance.set(key, [derniereEcheance.get(key) ?? '', l.date.slice(0, 10)].sort().pop()!);
    }
  }
  // Prêts documentés sans aucune ligne de coût (capital seul) : montrés, coût « – ».
  for (const op of opsFin.values()) {
    const key = `op:${op.id}`;
    if (prets.has(key) || !input.details.has(op.id)) continue;
    const d = input.details.get(op.id)!;
    pret(key, () => ({
      key, operationId: op.id, label: op.label, lender: d.lender, reference: d.reference,
      principalCents: d.principalAmountMinor != null && d.principalCurrency ? componentEurMinor({ amountMinor: d.principalAmountMinor, currency: d.principalCurrency, amountEurCents: null }) : null,
      startDate: isIsoDate(d.effectiveFrom) ? d.effectiveFrom.slice(0, 10) : null, endDate: isIsoDate(d.effectiveTo) ? d.effectiveTo.slice(0, 10) : null,
    }));
  }
  const loans = [...prets.values()].sort((a, b) => (a.startDate ?? '9999').localeCompare(b.startDate ?? '9999') || a.key.localeCompare(b.key));
  for (const p of loans) {
    if (p.scheduleBased) p.contractualTotalCents = p.costToDateCents + p.remainingCents;
    const fin = derniereEcheance.get(p.key);
    p.partialSchedule = p.scheduleBased && !!p.endDate && !!fin && fin < p.endDate && p.endDate > today;
  }
  const avecEcheancier = loans.filter((p) => p.scheduleBased);
  const costToDateCents = loans.reduce((n, p) => n + p.costToDateCents, 0);
  const remainingCents = loans.reduce((n, p) => n + p.remainingCents, 0);
  const contractualTotalCents = avecEcheancier.length ? avecEcheancier.reduce((n, p) => n + (p.contractualTotalCents ?? 0), 0) : null;
  const estimated = loans.some((p) => p.partialSchedule);
  const info = !loans.length
    ? 'Aucun prêt documenté pour ce bien : aucun coût de financement n’est ajouté.'
    : [
      `${loans.length} prêt(s) rattaché(s) au bien, consolidé(s) sans doublon. Le capital emprunté et le capital remboursé ne sont jamais comptés comme un coût : seuls les intérêts, l’assurance emprunteur et les frais le sont.`,
      avecEcheancier.length ? `${TCO_FINANCING_BASIS_LABEL} : les échéances passées sont présumées honorées (paiements non vérifiés).` : '',
      remainingCents > 0 ? `Échéances à venir : ${eurFr(remainingCents)}, affichées à part, jamais ajoutées au coût total.` : '',
      estimated ? 'L’échéancier connu s’arrête avant la fin du prêt : prévisionnel partiel, la suite n’est pas estimée.' : '',
    ].filter(Boolean).join(' ');
  return {
    loans, costToDateCents, remainingCents, contractualTotalCents,
    basisLabel: avecEcheancier.length ? TCO_FINANCING_BASIS_LABEL : null, estimated, info,
  };
}
