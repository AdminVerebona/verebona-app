/**
 * Lecture « Opération d'abord, non exclusive » de l'assistant — lot 45, O6
 * (CDC Opérations V1 ch. 16, 1.3, P11 à P13, P16, B15, C10, C12, C15,
 * C15.1, C15.2, C17, C22 ; recette F-126 à F-137).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'OPÉRATION FAIT FOI POUR CE QU'ELLE CONSOLIDE — ET RIEN D'AUTRE
 *
 *   · coûts, historique d'un bien, sinistres, contrats, achat : lus d'abord
 *     sur les Opérations ACTIVES (`BusinessOperationReadService`), montants
 *     tels que CONSOLIDÉS par T3 — T2 ne refait jamais la consolidation
 *     (P11, P12, 16.3) : il additionne des composantes selon C17.1 ;
 *   · repli obligatoire (16.2, P13) : sans Opération, les lectures
 *     existantes (canonique, documents, faits, agenda) répondent comme avant ;
 *   · mode mixte (C15.1) : Opérations + documents NON représentés par une
 *     Opération active — un document source n'est jamais recompté (F-135) ;
 *   · attribution par bien (C10) : une composante non ventilée d'une
 *     Opération multi-biens n'est jamais imputée en entier à chacun ; une
 *     Opération sans bien n'est jamais imputée à un bien (F-136), elle peut
 *     être mentionnée pour le compte (F-137) ;
 *   · devis = prévu (jamais réalisé), avoir / remboursement en réduction,
 *     preuve de paiement jamais un coût (P16), indemnité seulement dans le
 *     NET (Q4), devises sans conversion présentées à part (C12.3) ;
 *   · vocabulaire (P09) : jamais « Opération » — intervention, contrat,
 *     sinistre, achat, vente, financement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db, pgClient } from '@/db';
import { BusinessOperationReadService, type AssistantOperationRead } from '@/services/business-operations/read-service';
import { loadClaimRecords } from '@/services/business-operations/claims/read';
import type { BusinessOperationTypeCode } from '@/services/business-operations/model';
import { CLAIM_STATUS_OPTIONS, CLAIM_TYPE_OPTIONS } from '@/lib/assets/additional-infos';
import type { RetrievedSource } from '../types/sources';
import { classifyExpenseDocument, expenseThemeOf, isPaymentProofType, type ExpenseTheme } from './expense-classes';
// Lot 54D (§4.1) : règles économiques du moteur canonique PARTAGÉ (T2, TCO, Sinistres, exports).
import { attributeComponent, componentEurMinor, COST_SIGN } from '@/services/business-operations/finance/engine';
import { assetFieldSourceId, claimSourceId } from './source-ids';

export type { AssistantOperationRead };

let lecteur: BusinessOperationReadService | null = null;
/** Lecteur des Opérations (substituable en test). */
export function operationReader(): BusinessOperationReadService {
  lecteur ??= new BusinessOperationReadService();
  return lecteur;
}
export function setOperationReaderForTests(r: BusinessOperationReadService | null): void {
  lecteur = r;
}

// ── Vocabulaire utilisateur (P09) ──────────────────────────────────────────

const NOMS: Record<string, [string, string]> = {
  ACQUISITION: ['achat', 'achats'], INTERVENTION: ['intervention', 'interventions'], CONTRACT: ['contrat', 'contrats'],
  FINANCING: ['financement', 'financements'], CLAIM: ['sinistre', 'sinistres'], DISPOSAL: ['vente', 'ventes'],
  OTHER: ['dépense', 'dépenses'],
};

/** « intervention », « 2 contrats »… — jamais « Opération » (P09). */
export function operationNoun(typeCode: BusinessOperationTypeCode | null, n = 1): string {
  const [s, p] = NOMS[typeCode ?? 'OTHER'] ?? NOMS.OTHER;
  return n > 1 ? p : s;
}

/** « 2 interventions et 1 contrat » (pure). */
export function operationCountLabel(byType: Readonly<Record<string, number>>): string {
  const parts = Object.entries(byType).filter(([, n]) => n > 0)
    .sort(([a], [b]) => ORDRE.indexOf(a) - ORDRE.indexOf(b))
    .map(([t, n]) => `${n} ${operationNoun(t as BusinessOperationTypeCode, n)}`);
  return joinFrList(parts);
}
const ORDRE = ['ACQUISITION', 'INTERVENTION', 'CONTRACT', 'CLAIM', 'FINANCING', 'DISPOSAL', 'OTHER'];

function joinFrList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}

const lib = (options: ReadonlyArray<{ value: string; label: string }>, v: string | null) => options.find((o) => o.value === v)?.label ?? null;

/** Libellé lisible d'une Opération (pure) : « intervention « Remplacement embrayage » ». */
export function operationLabel(op: Pick<AssistantOperationRead, 'typeCode' | 'technicalLabel' | 'documents' | 'claimType' | 'provider'>): string {
  const nom = operationNoun(op.typeCode);
  if (op.typeCode === 'CLAIM') {
    const t = lib(CLAIM_TYPE_OPTIONS, op.claimType);
    return t ? `sinistre « ${t} »` : (op.technicalLabel ? `sinistre « ${op.technicalLabel} »` : 'sinistre');
  }
  const libelle = op.technicalLabel?.trim() || op.documents[0]?.title || null;
  return libelle ? `${nom} « ${libelle.slice(0, 80)} »` : nom;
}

/** Statut lisible d'un dossier sinistre (C14.1) — libellés de la fiche. */
export function claimStatusLabel(status: string | null): string | null {
  return lib(CLAIM_STATUS_OPTIONS, status);
}

// ── Thème d'une Opération ─────────────────────────────────────────────────

/**
 * Thème de dépense d'une Opération (pure, testée) : type métier (achat,
 * sinistre), sinon type des documents sources (facture d'entretien, de
 * réparation…), sinon libellé ; `null` : nature non établie.
 */
export function operationTheme(op: Pick<AssistantOperationRead, 'typeCode' | 'technicalLabel' | 'documents' | 'provider'>): ExpenseTheme | null {
  if (op.typeCode === 'ACQUISITION') return 'purchase';
  if (op.typeCode === 'CLAIM') return 'repair';
  for (const d of op.documents) {
    if (d.role === 'PAYMENT_PROOF' || isPaymentProofType(d.documentTypeCode)) continue;
    const c = classifyExpenseDocument(d.documentTypeCode, null);
    if (c.kind === 'theme') return c.theme;
  }
  const parLibelle = expenseThemeOf(op.technicalLabel ?? '');
  if (parLibelle && parLibelle !== 'purchase') return parLibelle;
  if (op.typeCode === 'CONTRACT') return expenseThemeOf(op.provider ?? '') === 'insurance' ? 'insurance' : null;
  return null;
}

// ── Montants (C12, C12.3) ─────────────────────────────────────────────────

/** Montant EUR d'une composante : euros, ou contre-valeur EXPLICITE ; sinon null (devise à part). */
export function componentEurCents(c: { amountMinor: number; currency: string; amountEurCents: number | null }): number | null {
  return componentEurMinor(c);
}

/** « 1 200,00 CHF » : montant d'origine, unités mineures selon la devise, jamais converti. */
export function formatMinorAmount(amountMinor: number, currency: string): string {
  // Lot 53D (D2) : « XXX » = devise non établie sur le document — jamais « ¤ ».
  if (currency === 'XXX') return `${(amountMinor / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, ' ')} (devise non établie)`;
  try {
    const f = new Intl.NumberFormat('fr-FR', { style: 'currency', currency });
    const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
    return f.format(amountMinor / 10 ** digits).replace(/ /g, ' ');
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

/** Montant EUR en centimes : « 1 250,00 € ». */
export function formatEur(cents: number): string {
  return formatMinorAmount(cents, 'EUR');
}

// ── Coûts consolidés d'un périmètre (C15.1, C17.1) ────────────────────────

export interface OperationCostLine {
  operationId: number;
  typeCode: BusinessOperationTypeCode | null;
  status: string;
  theme: ExpenseTheme | null;
  label: string;
  date: string | null;
  /** Coût économique attribuable (EUR) : réalisé − avoirs − remboursements. */
  costCents: number;
  /** Une composante de coût réalisée (même nulle) existe dans le périmètre. */
  hasCost: boolean;
  /** Part de coût sans date alors qu'une année est demandée (non qualifiée). */
  undatedCents: number;
  undatedCount: number;
  /** Indemnités attribuables au périmètre (net seulement, Q4). */
  indemnityCents: number;
  /** Indemnité globale non ventilée (multi-biens) : jamais déduite d'un bien. */
  unallocatedIndemnityCents: number;
  /** Prévu (devis) d'une intervention envisagée — jamais dans le total. */
  forecastCents: number;
  /** Produit de cession (vente) — jamais dans les dépenses. */
  proceedCents: number;
  /** Montants sans contre-valeur EUR : restitués à part, non sommés. */
  foreign: Array<{ currency: string; amountMinor: number; sign: 1 | -1 }>;
  /** Part de coût commune à plusieurs biens, non ventilée (C10). */
  unattributedCents: number;
  /** Aucune composante financière admissible dans le périmètre. */
  noAmount: boolean;
  /** Sans aucun bien lié (compte global, F-137). */
  untargeted: boolean;
  assetIds: number[];
  fileIds: number[];
  /** Document principal (facture d'abord), pour la source ouvrable. */
  primaryFileId: number | null;
  primaryTitle: string | null;
}

/** Types d'Opération dont l'absence de montant rend un total incomplet (F-118). */
const TYPES_DE_COUT = new Set<string | null>(['ACQUISITION', 'INTERVENTION', 'CONTRACT', 'OTHER', null]);

/**
 * Lignes de coût par Opération pour un périmètre (pure, testée). `assetIds`
 * vide : tout le compte (une Opération sans bien y est comptée, F-137) ;
 * sinon, une composante est imputée au périmètre si elle vise un de ses
 * biens, ou si, sans cible, l'Opération ne concerne QUE des biens du
 * périmètre ; une composante non ventilée d'une Opération qui concerne aussi
 * d'autres biens est « non attribuée » (signalée, jamais comptée en entier).
 */
export function operationCostLines(
  ops: readonly AssistantOperationRead[],
  ctx: {
    assetIds: readonly number[]; year?: number | null;
    /**
     * Lot 78B (TCO-R-14) : composantes que la règle PARTAGÉE avec le TCO ne
     * compte pas (doublon présumé d'un autre justificatif, justificatif retiré,
     * prix d'un autre bien, achat non incorporé au bien) — décidées par
     * `t2CostExclusions` (`business-operations/tco/service`), jamais ici.
     */
    excludedComponentIds?: ReadonlySet<number>;
  },
): OperationCostLine[] {
  const scope = new Set(ctx.assetIds);
  const global = scope.size === 0;
  const out: OperationCostLine[] = [];
  for (const op of ops) {
    if (!op.active) continue;
    // F-136 : question limitée à un bien → Opération sans lien fiable exclue.
    if (!global && !op.assetIds.some((a) => scope.has(a))) continue;
    const line: OperationCostLine = {
      operationId: op.id, typeCode: op.typeCode, status: op.status, theme: operationTheme(op), label: operationLabel(op),
      date: op.realizedDate ?? op.startDate ?? op.plannedDate ?? null,
      costCents: 0, hasCost: false, undatedCents: 0, undatedCount: 0, indemnityCents: 0, unallocatedIndemnityCents: 0,
      forecastCents: 0, proceedCents: 0, foreign: [], unattributedCents: 0, noAmount: true,
      untargeted: op.assetIds.length === 0, assetIds: [...op.assetIds],
      fileIds: op.documents.map((d) => d.fileId),
      primaryFileId: documentPrincipal(op)?.fileId ?? null, primaryTitle: documentPrincipal(op)?.title ?? null,
    };
    for (const c of op.components) {
      if (ctx.excludedComponentIds?.has(c.id)) continue;
      // Lot 54D : attribution du moteur partagé (C10) — mêmes règles que le TCO et les Sinistres.
      const a = attributeComponent(c, op.assetIds, global ? null : scope);
      const attrib = a === 'IN' ? 'in' : a === 'OUT' ? 'out' : 'unallocated';
      if (attrib === 'out') continue;
      const date = c.economicDate ?? line.date;
      if (ctx.year != null && date && Number(date.slice(0, 4)) !== ctx.year) continue;
      line.noAmount = false;
      const eur = componentEurCents(c);
      const sign: 1 | -1 = COST_SIGN[c.kind] === -1 && c.kind !== 'INDEMNITY' && c.kind !== 'PROCEED' ? -1 : 1;
      if (c.kind === 'PROCEED') { if (eur != null && attrib === 'in') line.proceedCents += eur; continue; }
      if (c.kind === 'FORECAST_COST') {
        // Le devis d'une intervention réalisée reste historique (C12) : seul
        // l'envisagé est « prévu ». Jamais dans le total réalisé.
        if (op.status === 'ENVISAGED' && eur != null && attrib === 'in') line.forecastCents += eur;
        continue;
      }
      if (c.kind === 'INDEMNITY') {
        if (eur == null) { line.foreign.push({ currency: c.currency, amountMinor: c.amountMinor, sign: -1 }); continue; }
        if (attrib === 'in') line.indemnityCents += eur;
        else line.unallocatedIndemnityCents += eur;
        continue;
      }
      // REALIZED_COST, REDUCTION, REFUND.
      if (eur == null) { line.foreign.push({ currency: c.currency, amountMinor: c.amountMinor, sign }); continue; }
      if (attrib === 'unallocated') { line.unattributedCents += sign * eur; continue; }
      if (ctx.year != null && !date) { line.undatedCents += sign * eur; line.undatedCount += 1; continue; }
      line.costCents += sign * eur;
      if (c.kind === 'REALIZED_COST') line.hasCost = true;
    }
    if (line.noAmount && !TYPES_DE_COUT.has(op.typeCode)) line.noAmount = false;
    // Année demandée : une Opération hors de l'année, sans composante, n'est pas « sans montant ».
    if (line.noAmount && ctx.year != null && line.date && Number(line.date.slice(0, 4)) !== ctx.year) continue;
    out.push(line);
  }
  return out;
}

/** Synthèse des coûts consolidés d'un périmètre (jointe au total mixte). */
export interface OperationExpensePart {
  /** Opérations dont un coût réalisé est compté. */
  count: number;
  sumCents: number;
  operationIds: number[];
  byType: Record<string, number>;
  /** Opérations du périmètre sans montant consolidé (total incomplet, C15.1 §31-32). */
  withoutAmount: { count: number; operationIds: number[]; labels: string[] };
  /** Composantes communes à plusieurs biens, non ventilées (C10). */
  unattributed: { count: number; sumCents: number; operationIds: number[] };
  /** Compte global : Opérations comptées sans bien identifié (F-137). */
  untargeted: { count: number; sumCents: number };
  forecast: { count: number; sumCents: number };
  indemnity: { count: number; sumCents: number; unallocatedCents: number };
  proceeds: { count: number; sumCents: number };
  foreign: Array<{ currency: string; amountMinor: number }>;
  /** Coûts consolidés de nature non établie (thème demandé) : non qualifiés. */
  unqualified: { count: number; sumCents: number };
  undated: { count: number; sumCents: number };
  /** Lignes (pour les sources et l'historique). */
  lines: OperationCostLine[];
}

export function emptyOperationPart(): OperationExpensePart {
  return {
    count: 0, sumCents: 0, operationIds: [], byType: {}, withoutAmount: { count: 0, operationIds: [], labels: [] },
    unattributed: { count: 0, sumCents: 0, operationIds: [] }, untargeted: { count: 0, sumCents: 0 },
    forecast: { count: 0, sumCents: 0 }, indemnity: { count: 0, sumCents: 0, unallocatedCents: 0 }, proceeds: { count: 0, sumCents: 0 },
    foreign: [], unqualified: { count: 0, sumCents: 0 }, undated: { count: 0, sumCents: 0 }, lines: [],
  };
}

/** Entrée d'agrégat (même forme que les documents : `aggregateExpenses`). */
export interface OperationExpenseEntry {
  operationId: number;
  amountCents: number;
  theme: ExpenseTheme | null;
  undated?: boolean;
}

/**
 * Lignes → entrées d'agrégat + synthèse (pure, testée). `theme` demandé :
 * une ligne d'un autre thème est ignorée ; de nature non établie, elle est
 * non qualifiée (le total devient incomplet, comme un document).
 */
export function summarizeOperationCosts(lines: readonly OperationCostLine[], theme: ExpenseTheme | null): { entries: OperationExpenseEntry[]; part: OperationExpensePart } {
  const part = emptyOperationPart();
  const entries: OperationExpenseEntry[] = [];
  const foreign = new Map<string, number>();
  for (const l of lines) {
    const dansTheme = !theme || l.theme === theme;
    const inconnu = !!theme && l.theme === null;
    if (!dansTheme && !inconnu) continue;
    part.lines.push(l);
    if (l.noAmount) {
      part.withoutAmount.count += 1; part.withoutAmount.operationIds.push(l.operationId); part.withoutAmount.labels.push(l.label);
      continue;
    }
    if (l.unattributedCents) { part.unattributed.count += 1; part.unattributed.sumCents += l.unattributedCents; part.unattributed.operationIds.push(l.operationId); }
    for (const f of l.foreign) foreign.set(f.currency, (foreign.get(f.currency) ?? 0) + f.sign * f.amountMinor);
    if (l.forecastCents) { part.forecast.count += 1; part.forecast.sumCents += l.forecastCents; }
    if (l.proceedCents) { part.proceeds.count += 1; part.proceeds.sumCents += l.proceedCents; }
    if (!theme || theme === 'repair') {
      if (l.indemnityCents) { part.indemnity.count += 1; part.indemnity.sumCents += l.indemnityCents; }
      part.indemnity.unallocatedCents += l.unallocatedIndemnityCents;
    }
    if (l.undatedCents || l.undatedCount) {
      part.undated.count += 1; part.undated.sumCents += l.undatedCents;
      entries.push({ operationId: l.operationId, amountCents: l.undatedCents, theme: l.theme, undated: true });
    }
    if (!l.hasCost && l.costCents === 0) continue;
    if (inconnu) {
      part.unqualified.count += 1; part.unqualified.sumCents += l.costCents;
      entries.push({ operationId: l.operationId, amountCents: l.costCents, theme: null });
      continue;
    }
    part.count += 1; part.sumCents += l.costCents; part.operationIds.push(l.operationId);
    const t = l.typeCode ?? 'OTHER';
    part.byType[t] = (part.byType[t] ?? 0) + 1;
    if (l.untargeted) { part.untargeted.count += 1; part.untargeted.sumCents += l.costCents; }
    entries.push({ operationId: l.operationId, amountCents: l.costCents, theme: l.theme ?? 'other' });
  }
  part.foreign = [...foreign.entries()].filter(([, v]) => v !== 0).map(([currency, amountMinor]) => ({ currency, amountMinor }));
  return { entries, part };
}

/**
 * Lot 54D (E02) : lecture EXHAUSTIVE d'un périmètre (pages sur curseur
 * stable) ; `complete` faux seulement au-delà du garde-fou mémoire — jamais
 * une troncature silencieuse à 500.
 */
export async function readAllOperations(accountId: number, filters: Omit<NonNullable<Parameters<BusinessOperationReadService['listForAssistant']>[1]>, 'limit' | 'afterId'>): Promise<{ operations: AssistantOperationRead[]; complete: boolean }> {
  const r = operationReader();
  if (typeof r.listAllForAssistant === 'function') {
    const x = await r.listAllForAssistant(accountId, filters);
    return { operations: x.operations, complete: x.complete };
  }
  const ops = await r.listForAssistant(accountId, { ...filters, limit: 500 });
  return { operations: ops, complete: ops.length < 500 };
}

/** Opérations du périmètre d'une question de coût — exhaustives (lot 54D, E02). */
export async function loadScopeOperations(accountId: number, assetIds: readonly number[]): Promise<AssistantOperationRead[]> {
  return (await loadScopeOperationsRead(accountId, assetIds)).operations;
}

/** Comme `loadScopeOperations`, avec l'indicateur de lecture complète (E02). */
export async function loadScopeOperationsRead(accountId: number, assetIds: readonly number[]): Promise<{ operations: AssistantOperationRead[]; complete: boolean }> {
  return readAllOperations(accountId, { assetIds: assetIds.length ? assetIds : null, includeUntargeted: assetIds.length === 0 });
}

// ── Sources (ouverture : document ou sinistre, jamais une « Opération ») ──

export { claimSourceId, parseClaimSourceId } from './source-ids';

/** Document « principal » d'une Opération : facture (le contrat pour un contrat), preuve de paiement en dernier. */
function documentPrincipal(op: Pick<AssistantOperationRead, 'documents'> & { typeCode?: BusinessOperationTypeCode | null }) {
  const contrat = op.typeCode === 'CONTRACT';
  const rang = (r: string | null) => (contrat && r === 'CONTRACT_DOCUMENT' ? -1 : r === 'INVOICE' ? 0 : r === 'DEPOSIT_INVOICE' ? 1
    : r === 'CONTRACT_DOCUMENT' || r === 'CLAIM_DOCUMENT' || r === 'SALE_DOCUMENT' ? 2 : r === 'QUOTE' ? 3 : r === 'PAYMENT_PROOF' ? 5 : 4);
  return [...op.documents].sort((a, b) => rang(a.role) - rang(b.role) || a.fileId - b.fileId)[0] ?? null;
}

/**
 * Source d'une Opération (pure) : son document principal (`doc_<id>`,
 * s'ouvre en tiroir), un sinistre (`claim:<bien>:<id>`, section Sinistres
 * du bien) ou, pour un achat saisi sur la fiche, le prix d'achat de la fiche.
 * `null` : rien d'ouvrable (la source synthétique du total la porte).
 */
export function operationSource(
  op: AssistantOperationRead,
  ctx: { content: string; assetId?: number | null; assetName?: string | null },
): RetrievedSource | null {
  const assetId = ctx.assetId ?? op.assetIds[0] ?? null;
  const meta = { operationKind: operationNoun(op.typeCode), date: op.realizedDate ?? op.startDate ?? op.plannedDate ?? null, assetName: ctx.assetName ?? null, assetId };
  if (op.typeCode === 'CLAIM' && assetId) {
    return { id: claimSourceId(assetId, op.id), type: 'asset_field', title: capitalize(operationLabel(op)), content: ctx.content.slice(0, 1500), relevanceScore: 1, meta };
  }
  const d = documentPrincipal(op);
  if (d) {
    return {
      id: `doc_${d.fileId}`, type: 'document', title: `${d.title} — ${operationNoun(op.typeCode)}`,
      content: ctx.content.slice(0, 1500), relevanceScore: 1, meta: { ...meta, fileId: d.fileId, date: meta.date ?? d.date },
    };
  }
  if (op.typeCode === 'ACQUISITION' && assetId && op.sourceKinds.includes('ASSET_DATA')) {
    return { id: assetFieldSourceId(assetId, 'acquisitionPrice'), type: 'asset_field', title: capitalize(operationLabel(op)), content: ctx.content.slice(0, 1500), relevanceScore: 1, meta };
  }
  return null;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Source ouvrable d'une ligne de coût comptée (pure) : sinistre → section
 * Sinistres du bien ; sinon document principal ; sinon `null`.
 */
export function costLineSource(l: OperationCostLine, ctx: { assetId?: number | null; assetName?: string | null } = {}): RetrievedSource | null {
  const assetId = ctx.assetId && l.assetIds.includes(ctx.assetId) ? ctx.assetId : l.assetIds[0] ?? null;
  const content = [capitalize(l.label), l.date ?? 'date non précisée', `coût consolidé : ${formatEur(l.costCents)}`].join(' · ');
  const meta = { operationKind: operationNoun(l.typeCode), date: l.date, assetName: ctx.assetName ?? null, assetId };
  if (l.typeCode === 'CLAIM' && assetId) {
    return { id: claimSourceId(assetId, l.operationId), type: 'asset_field', title: capitalize(l.label), content, relevanceScore: 1, meta };
  }
  if (l.primaryFileId) {
    return {
      id: `doc_${l.primaryFileId}`, type: 'document', title: `${l.primaryTitle ?? 'Document'} — ${operationNoun(l.typeCode)}`,
      content, relevanceScore: 1, meta: { ...meta, fileId: l.primaryFileId },
    };
  }
  return null;
}

// ── Historique d'un bien (C15 « qu'est-ce qui a été fait ? », F-134) ──────

export interface AssetHistoryEntry {
  date: string | null;
  /** Thème de dépense (filtre « quelles réparations… ? »), null : non établi. */
  theme: ExpenseTheme | null;
  kind: 'operation' | 'document';
  label: string;
  /** Coût consolidé (ou montant lu, pour un document non représenté). */
  amountCents: number | null;
  status: string | null;
  provider: string | null;
  operationId: number | null;
  fileId: number | null;
  source: RetrievedSource | null;
}

export interface AssetHistory {
  entries: AssetHistoryEntry[];
  operationCount: number;
  documentCount: number;
}

/**
 * Historique d'un bien : Opérations actives du bien (chronologie métier
 * consolidée), complétées des documents de dépense datés NON représentés
 * par une Opération (« compléments non représentés », B15) ; sans
 * Opération : `null` (les lectures existantes répondent, 16.2).
 */
export async function readAssetHistory(accountId: number, assetId: number, opts: { assetName?: string | null; limit?: number } = {}): Promise<AssetHistory | null> {
  const ops = (await operationReader().listForAssistant(accountId, { assetIds: [assetId], limit: 200 }))
    .filter((o) => o.typeCode !== 'FINANCING');
  if (!ops.length) return null;
  const lines = new Map(operationCostLines(ops, { assetIds: [assetId] }).map((l) => [l.operationId, l]));
  const represented = new Set(ops.flatMap((o) => o.documents.map((d) => d.fileId)));
  const docs = (await pgClient.unsafe(
    `SELECT f.id, coalesce(nullif(f.retained_title, ''), f.original_filename, 'Document') AS title, f.document_date::text AS date,
            f.amount_cents AS "amountCents", f.document_type_code AS v2, f.document_type AS legacy, f.supplier
       FROM asset_files f
      WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.document_date IS NOT NULL AND f.amount_cents IS NOT NULL
        AND (EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id
                      AND l.status = 'ACTIVE' AND l.asset_id = $2)
             OR f.asset_id = $2 OR f.linked_asset_id = $2)
      ORDER BY f.document_date DESC, f.id DESC LIMIT 100`,
    [accountId, assetId] as never[],
  )) as unknown as Array<{ id: number; title: string; date: string; amountCents: number; v2: string | null; legacy: string | null; supplier: string | null }>;
  const nonRepresentes = docs.map((d) => ({ ...d, id: Number(d.id) }))
    .filter((d) => !represented.has(d.id))
    .filter((d) => { const c = classifyExpenseDocument(d.v2, d.legacy); return c.kind === 'theme' && c.theme !== 'insurance' && c.theme !== 'subscription' && c.theme !== 'charges'; });
  // Un document « représenté » par une Opération d'un autre bien ou sans bien n'est pas réintroduit (F-135).
  const ailleurs = await operationReader().representedDocuments(accountId, nonRepresentes.map((d) => d.id));
  const entries: AssetHistoryEntry[] = [];
  for (const op of ops) {
    const l = lines.get(op.id);
    const montant = l && (l.hasCost || l.costCents) ? l.costCents : null;
    const statut = op.typeCode === 'CLAIM' ? claimStatusLabel(op.claimStatus)
      : op.status === 'ENVISAGED' ? 'prévu' : op.status === 'CANCELLED' ? 'annulé' : null;
    const content = [
      `${capitalize(operationLabel(op))}`,
      op.realizedDate ?? op.startDate ?? op.plannedDate ?? 'date non précisée',
      op.provider ? `prestataire : ${op.provider}` : null,
      montant != null ? `coût : ${formatEur(montant)}` : null,
      statut ? `statut : ${statut}` : null,
    ].filter(Boolean).join(' · ');
    entries.push({
      date: op.realizedDate ?? op.startDate ?? op.plannedDate ?? null, theme: l?.theme ?? operationTheme(op), kind: 'operation', label: operationLabel(op), amountCents: montant,
      status: statut, provider: op.provider, operationId: op.id, fileId: null,
      source: operationSource(op, { content, assetId, assetName: opts.assetName ?? null }),
    });
  }
  for (const d of nonRepresentes.filter((x) => !ailleurs.has(x.id))) {
    const content = `Document « ${d.title} » · ${d.date} · montant : ${formatEur(Number(d.amountCents))}${d.supplier ? ` · ${d.supplier}` : ''}`;
    const c = classifyExpenseDocument(d.v2, d.legacy);
    entries.push({
      date: d.date, theme: c.kind === 'theme' ? c.theme : null, kind: 'document', label: `document « ${d.title} »`, amountCents: Number(d.amountCents), status: null, provider: d.supplier,
      operationId: null, fileId: d.id,
      source: { id: `doc_${d.id}`, type: 'document', title: d.title, content, relevanceScore: 0.9, meta: { fileId: d.id, date: d.date, assetName: opts.assetName ?? null } },
    });
  }
  entries.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 50);
  return {
    entries: entries.slice(0, limit),
    operationCount: entries.filter((e) => e.kind === 'operation').length,
    documentCount: entries.filter((e) => e.kind === 'document').length,
  };
}

// ── Sinistres (C15 « où en est mon sinistre ? ») ─────────────────────────

export interface ClaimOverview {
  operationId: number;
  label: string;
  assetIds: number[];
  occurredOn: string | null;
  declaredOn: string | null;
  statusLabel: string | null;
  insurerClaimRef: string | null;
  closed: boolean;
  /** Indemnité reçue (composantes INDEMNITY du sinistre). */
  indemnityCents: number | null;
  /** Coût brut des réparations (sinistre + interventions enfants, Q4). */
  grossCents: number;
  netCents: number;
  documentIds: number[];
}

/** Sinistres actifs d'un périmètre (bien(s), ou compte) — lecture lot 44. */
export async function readClaims(accountId: number, assetIds: readonly number[]): Promise<ClaimOverview[]> {
  const ops = await operationReader().listForAssistant(accountId, { assetIds: assetIds.length ? assetIds : null, typeCodes: ['CLAIM'], includeUntargeted: assetIds.length === 0, limit: 50 });
  if (!ops.length) return [];
  const records = new Map((await loadClaimRecords(db, accountId, { ids: ops.map((o) => o.id) })).map((r) => [r.id, r]));
  return ops.map((o) => {
    const r = records.get(o.id);
    return {
      operationId: o.id, label: operationLabel(o), assetIds: o.assetIds,
      occurredOn: o.realizedDate, declaredOn: o.declaredOn, statusLabel: claimStatusLabel(o.claimStatus), insurerClaimRef: o.insurerClaimRef,
      closed: !!o.closedAt || o.claimStatus === 'CLOS',
      indemnityCents: r?.indemnityCents ?? null,
      grossCents: r?.costs.grossCents ?? 0, netCents: r?.costs.netCents ?? 0,
      documentIds: o.documents.map((d) => d.fileId),
    };
  });
}

// ── Règlements (C15 « payé / réglé », F-132) ──────────────────────────────

export interface PaymentsRead {
  /** Preuves de paiement (sources PAYMENT_PROOF des Opérations, ou documents de paiement). */
  proofs: Array<{ fileId: number; title: string; date: string | null; amountCents: number | null; operationId: number | null }>;
  sumCents: number;
  /** Preuves sans montant lisible. */
  withoutAmount: number;
}

/**
 * Preuves de règlement d'un périmètre : documents sources PAYMENT_PROOF des
 * Opérations actives, et documents de type « preuve de paiement » des biens.
 * Jamais confondues avec le coût (P16).
 */
export async function readPayments(accountId: number, opts: { assetIds: readonly number[]; year?: number | null }): Promise<PaymentsRead> {
  // Lot 54D (E02) : toutes les Opérations du périmètre (curseur), plus de borne à 500.
  const { operations: ops } = await readAllOperations(accountId, { assetIds: opts.assetIds.length ? opts.assetIds : null, includeUntargeted: opts.assetIds.length === 0 });
  const proofs = new Map<number, PaymentsRead['proofs'][number]>();
  for (const o of ops) {
    for (const d of o.documents) {
      if (d.role !== 'PAYMENT_PROOF' && !isPaymentProofType(d.documentTypeCode)) continue;
      proofs.set(d.fileId, { fileId: d.fileId, title: d.title, date: d.date, amountCents: d.amountCents, operationId: o.id });
    }
  }
  const ids = opts.assetIds.length ? [...opts.assetIds] : null;
  const docs = (await pgClient.unsafe(
    `SELECT f.id, coalesce(nullif(f.retained_title, ''), f.original_filename, 'Document') AS title, f.document_date::text AS date,
            f.amount_cents AS "amountCents", f.document_type_code AS v2
       FROM asset_files f
      WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.document_type_code IS NOT NULL
        AND (upper(f.document_type_code) = 'ACQUISITION_PAYMENT' OR upper(f.document_type_code) LIKE '%\\_PAYMENT' OR upper(f.document_type_code) LIKE '%\\_PAYMENT\\_PROOF')
        AND ($2::int[] IS NULL
             OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id
                         AND l.status = 'ACTIVE' AND l.asset_id = ANY($2::int[]))
             OR f.asset_id = ANY($2::int[]) OR f.linked_asset_id = ANY($2::int[]))
      ORDER BY f.document_date DESC NULLS LAST, f.id DESC LIMIT 100`,
    [accountId, ids] as never[],
  )) as unknown as Array<{ id: number; title: string; date: string | null; amountCents: number | null; v2: string | null }>;
  for (const d of docs) {
    const id = Number(d.id);
    if (!proofs.has(id) && isPaymentProofType(d.v2)) proofs.set(id, { fileId: id, title: d.title, date: d.date, amountCents: d.amountCents == null ? null : Number(d.amountCents), operationId: null });
  }
  const liste = [...proofs.values()]
    .filter((p) => opts.year == null || (p.date != null && Number(p.date.slice(0, 4)) === opts.year))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.fileId - a.fileId);
  return {
    proofs: liste,
    sumCents: liste.reduce((n, p) => n + (p.amountCents ?? 0), 0),
    withoutAmount: liste.filter((p) => p.amountCents == null).length,
  };
}

// ── Achat (C15.2 « J'ai payé combien pour la Polo ? ») ───────────────────

export interface AcquisitionRead {
  operationId: number;
  /** Prix d'achat consolidé (EUR), ou null. */
  priceCents: number | null;
  foreign: Array<{ currency: string; amountMinor: number }>;
  date: string | null;
  provider: string | null;
  source: RetrievedSource | null;
  /** Lot 53D (D9) : prix lus sur des documents qui diffèrent de la saisie de la fiche (saisie conservée). */
  documentPrices?: Array<{ amountMinor: number; currency: string; title: string | null }>;
  /** Lot 53D (D9) : frais annexes connus, isolés — jamais additionnés au prix d'achat. */
  fees?: Array<{ amountMinor: number; currency: string; title: string | null }>;
}

/** Achat ACTIF d'un bien, prix consolidé (REALIZED_COST − avoirs attribuables). */
export async function readAcquisition(accountId: number, assetId: number, opts: { assetName?: string | null } = {}): Promise<AcquisitionRead | null> {
  const ops = await operationReader().listForAssistant(accountId, { assetIds: [assetId], typeCodes: ['ACQUISITION'], limit: 5 });
  const op = ops.find((o) => o.status === 'REALIZED') ?? ops[0];
  if (!op) return null;
  const [l] = operationCostLines([op], { assetIds: [assetId] });
  const prix = l && (l.hasCost || l.costCents) ? l.costCents : null;
  const content = [
    `Achat de ${opts.assetName ?? 'ce bien'}`,
    op.realizedDate ? `date : ${op.realizedDate}` : null,
    prix != null ? `prix d'achat : ${formatEur(prix)}` : 'prix d’achat non consolidé',
    op.provider ? `vendeur : ${op.provider}` : null,
  ].filter(Boolean).join(' · ');
  // Lot 53D (D9) : écarts document / saisie et frais annexes, exposés à part (lecture en échec : rien).
  const lecteurOps = operationReader();
  const hors = typeof lecteurOps.sideAmounts === 'function' ? await lecteurOps.sideAmounts(accountId, [op.id]).catch(() => []) : [];
  const de = (n: string) => hors.filter((x) => x.nature === n).map((x) => ({ amountMinor: x.amountMinor, currency: x.currency, title: x.title }));
  return {
    operationId: op.id, priceCents: prix,
    ...(hors.length ? { documentPrices: de('DOCUMENT_AMOUNT_DIFFERS'), fees: de('ANCILLARY_FEE') } : {}),
    foreign: (l?.foreign ?? []).map((f) => ({ currency: f.currency, amountMinor: f.sign * f.amountMinor })),
    date: op.realizedDate, provider: op.provider,
    source: operationSource(op, { content, assetId, assetName: opts.assetName ?? null }),
  };
}

// ── Contrats (B15 « contrat d'assurance », C15) ──────────────────────────

export interface ContractOverview {
  operationId: number;
  label: string;
  provider: string | null;
  reference: string | null;
  from: string | null;
  to: string | null;
  status: string;
  /** Coûts réellement documentés (cotisations facturées), EUR. */
  realizedCents: number | null;
  /** Tarif annoncé (prévisionnel) — jamais présenté comme payé. */
  forecastCents: number | null;
  assetIds: number[];
  source: RetrievedSource | null;
}

const PERIODE = (from: string | null, to: string | null) => (from && to ? `du ${from} au ${to}` : from ? `depuis le ${from}` : to ? `jusqu’au ${to}` : null);

/** Contrats actifs d'un périmètre — Opérations CONTRACT et leurs documents sources. */
export async function readContracts(accountId: number, assetIds: readonly number[], opts: { assetName?: string | null } = {}): Promise<ContractOverview[]> {
  const ops = await operationReader().listForAssistant(accountId, { assetIds: assetIds.length ? assetIds : null, typeCodes: ['CONTRACT'], includeUntargeted: assetIds.length === 0, limit: 50 });
  return ops.filter((o) => o.status !== 'CANCELLED').map((o) => {
    const [l] = operationCostLines([o], { assetIds: [...assetIds] });
    const prevu = o.components.filter((c) => c.kind === 'FORECAST_COST').map((c) => componentEurCents(c)).filter((x): x is number => x != null);
    const realise = l && (l.hasCost || l.costCents) ? l.costCents : null;
    const content = [
      capitalize(operationLabel(o)), o.provider ? `assureur / prestataire : ${o.provider}` : null,
      o.contractReference ? `n° ${o.contractReference}` : null, PERIODE(o.effectiveFrom, o.effectiveTo),
      realise != null ? `coûts documentés : ${formatEur(realise)}` : null,
      prevu.length ? `tarif annoncé : ${formatEur(prevu[prevu.length - 1])}` : null,
    ].filter(Boolean).join(' · ');
    return {
      operationId: o.id, label: operationLabel(o), provider: o.provider, reference: o.contractReference,
      from: o.effectiveFrom ?? o.startDate, to: o.effectiveTo ?? o.endDate, status: o.status,
      realizedCents: realise, forecastCents: prevu.length ? prevu[prevu.length - 1] : null, assetIds: o.assetIds,
      // Le document du contrat d'abord (« retourner aussi le document »).
      source: operationSource(o, { content, assetName: opts.assetName ?? null }),
    };
  });
}

// ── Pont Opération → document (B15 « Retrouve la facture de… », F-130) ──

/**
 * Documents sources d'Opérations dont le libellé ou le prestataire répond aux
 * termes (« la facture de l'embrayage ») — candidats ajoutés à la recherche
 * documentaire, jamais à la place de celle-ci.
 */
export async function findOperationDocuments(accountId: number, terms: readonly string[], assetId?: number | null): Promise<Array<{
  fileId: number; title: string; date: string | null; assetName: string | null; matchedTerms: number; analysisState: string | null; snippet: string;
}>> {
  const hits = await operationReader().findSourceDocumentsByText(accountId, terms, { assetId: assetId ?? null });
  if (!hits.length) return [];
  const best = new Map<number, (typeof hits)[number]>();
  for (const h of hits) if (!best.has(h.fileId) || best.get(h.fileId)!.matched < h.matched) best.set(h.fileId, h);
  const rows = (await pgClient.unsafe(
    `SELECT f.id, coalesce(nullif(f.retained_title, ''), f.original_filename, 'Document') AS title, to_char(f.document_date, 'YYYY-MM-DD') AS date,
            f.analysis_state AS "analysisState", (SELECT a.name FROM assets a WHERE a.id = coalesce(f.asset_id, f.linked_asset_id)) AS "assetName"
       FROM asset_files f WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.id = ANY($2::int[])`,
    [accountId, [...best.keys()]] as never[],
  )) as unknown as Array<{ id: number; title: string; date: string | null; analysisState: string | null; assetName: string | null }>;
  return rows.map((r) => {
    const h = best.get(Number(r.id))!;
    const lib = operationLabel({ typeCode: h.typeCode, technicalLabel: h.technicalLabel, documents: [], claimType: null, provider: null });
    return { fileId: Number(r.id), title: r.title, date: r.date, assetName: r.assetName, matchedTerms: h.matched, analysisState: r.analysisState, snippet: `${capitalize(lib)} — document source` };
  });
}

// ── Coût d'une intervention précise (C15 « coût d'une opération », F-127) ─

export interface OperationCostRead {
  operationId: number;
  label: string;
  date: string | null;
  provider: string | null;
  /** Coût consolidé attribuable, ou null : aucun montant consolidé. */
  costCents: number | null;
  indemnityCents: number;
  forecastCents: number;
  foreign: Array<{ currency: string; amountMinor: number }>;
  unattributedCents: number;
  status: string;
  source: RetrievedSource | null;
}

/**
 * Opérations désignées par leur libellé (« la réparation du toit ») dans un
 * périmètre, avec leur coût CONSOLIDÉ — jamais resommé depuis les documents
 * (16.3). Seules les meilleures correspondances sont gardées (5 au plus).
 */
export async function readOperationCosts(accountId: number, terms: readonly string[], assetIds: readonly number[]): Promise<OperationCostRead[]> {
  const hits = await operationReader().findByText(accountId, terms, { assetIds });
  if (!hits.length) return [];
  const best = Math.max(...hits.map((h) => h.matched));
  const ids = hits.filter((h) => h.matched === best).slice(0, 5).map((h) => h.id);
  const ops = await operationReader().listForAssistant(accountId, { ids, limit: 5 });
  return ops.map((op) => {
    const [l] = operationCostLines([op], { assetIds: assetIds.length ? [...assetIds] : [] });
    const content = [
      capitalize(operationLabel(op)), op.realizedDate ?? op.startDate ?? op.plannedDate ?? 'date non précisée', op.provider,
      l && (l.hasCost || l.costCents) ? `coût consolidé : ${formatEur(l.costCents)}` : 'montant non consolidé',
    ].filter(Boolean).join(' · ');
    return {
      operationId: op.id, label: operationLabel(op), date: op.realizedDate ?? op.startDate ?? op.plannedDate ?? null, provider: op.provider,
      costCents: l && (l.hasCost || l.costCents) ? l.costCents : null, indemnityCents: l?.indemnityCents ?? 0, forecastCents: l?.forecastCents ?? 0,
      foreign: (l?.foreign ?? []).map((f) => ({ currency: f.currency, amountMinor: f.sign * f.amountMinor })),
      unattributedCents: l?.unattributedCents ?? 0, status: op.status,
      source: operationSource(op, { content, assetId: assetIds.length ? op.assetIds.find((a) => assetIds.includes(a)) ?? null : null }),
    };
  });
}

/** Mots qui ne désignent jamais une intervention précise (question, montant, thème). */
const MOTS_GENERIQUES = new Set([
  'combien', 'cout', 'coute', 'coutee', 'coutes', 'couts', 'depense', 'depenses', 'depensee', 'depensees', 'paye', 'payee', 'prix', 'montant',
  'total', 'somme', 'quel', 'quelle', 'quels', 'quelles', 'pour', 'avec', 'dans', 'mon', 'mes', 'notre', 'votre', 'cette', 'celle', 'celui',
  'annee', 'mois', 'euros', 'euro', 'fait', 'faite', 'faites', 'faire', 'realise', 'realisee', 'derniere', 'dernier', 'dernieres',
  'reparation', 'reparations', 'entretien', 'entretiens', 'travaux', 'intervention', 'interventions', 'revision', 'achat', 'assurance',
  'facture', 'factures', 'document', 'documents', 'depuis', 'avant', 'apres', 'tout', 'tous', 'toutes', 'elle', 'elles', 'ils', 'est', 'sont',
]);

/** Termes distinctifs d'une question de coût (pure, testée) : ni mots de question ni noms des biens. */
export function specificCostTerms(message: string, assetNames: readonly string[] = []): string[] {
  const p = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const noms = new Set(assetNames.flatMap((n) => p(n).split(/[^a-z0-9]+/)));
  return [...new Set(p(message).replace(/['’]/g, ' ').split(/[^a-z0-9-]+/)
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !/-(je|tu|il|elle|on|nous|vous|ils|elles|ce|t)$|^(a|est)-/.test(w)
      && !MOTS_GENERIQUES.has(w) && !noms.has(w)))].slice(0, 5);
}
