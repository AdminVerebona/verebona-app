/**
 * Thèmes et classes de dépense — vocabulaire commun aux dépenses
 * documentaires (`expenses.ts`, CDC 15 T2-24) et aux coûts consolidés des
 * Opérations (`operations.ts`, lot 45 O6, CDC Opérations V1 C15). Fonctions
 * pures, sans accès base (extraites de `expenses.ts`, qui les réexporte).
 */
import { resolveDocumentType, type EventBusinessType } from '@/services/canonical/registry';

export type ExpenseTheme =
  | 'maintenance' | 'repair' | 'works' | 'insurance' | 'purchase' | 'inspection' | 'subscription' | 'charges'
  // Lot 45 : coût CONSOLIDÉ dont la nature n'est pas établie (intervention
  // sans type de facture, frais de cession…). Jamais déduit d'une question
  // (`expenseThemeOf`) ni d'un document (`classifyExpenseDocument`) : il ne
  // sert qu'au total « tous thèmes » ; une question sur un thème précis le
  // compte comme non qualifié (total incomplet).
  | 'other';

export const EXPENSE_THEME_LABELS: Readonly<Record<ExpenseTheme, string>> = {
  maintenance: 'entretien', repair: 'réparations', works: 'travaux', insurance: 'assurance',
  purchase: 'achat', inspection: 'contrôles et diagnostics', subscription: 'abonnements', charges: 'charges',
  other: 'autres dépenses',
};

const THEME_TABLE: ReadonlyArray<[RegExp, ExpenseTheme]> = [
  [/\b(entretien|entretenir|revision|maintenance|vidange)\b/, 'maintenance'],
  [/\b(reparation|reparations|depannage|panne)\b/, 'repair'],
  [/\b(travaux|renovation|chantier)\b/, 'works'],
  [/\b(assurance|assurances|assureur|cotisation)\b/, 'insurance'],
  [/\b(controle technique|controles?|diagnostics?)\b/, 'inspection'],
  [/\b(abonnements?)\b/, 'subscription'],
  [/\b(charges|copropriete|syndic)\b/, 'charges'],
  [/\b(achat|acquisition)\b/, 'purchase'],
];

/** Thème désigné par une question (sans accents, minuscules) ; null : aucun. */
export function expenseThemeOf(message: string): ExpenseTheme | null {
  const m = message.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return THEME_TABLE.find(([re]) => re.test(m))?.[1] ?? null;
}

/**
 * Lot 49 : mots de la question qui désignent EXPLICITEMENT une catégorie de
 * dépense (« abonnements », « entretien »…) — consommés par l'agrégat
 * qualifié, ils ne laissent pas de résidu sémantique (pure).
 */
export function expenseThemeWords(message: string): string[] {
  const m = message.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return THEME_TABLE.flatMap(([re]) => {
    const x = new RegExp(re.source, 'g');
    return [...m.matchAll(x)].map((r) => r[0]);
  });
}

/** Thème par type du référentiel V2 (le plus précis). */
const THEME_BY_V2_CODE: Readonly<Record<string, ExpenseTheme>> = {
  MAINTENANCE_INVOICE: 'maintenance', REPAIR_INVOICE: 'repair', WORKS_INVOICE: 'works',
  ACQUISITION_INVOICE: 'purchase', SUBSCRIPTION_INVOICE: 'subscription', CHARGE_RECEIPT: 'charges',
  INSURANCE_DUE_NOTICE: 'insurance', INSURANCE_POLICY: 'insurance', INSURANCE_CERTIFICATE: 'insurance',
  VEHICLE_TECHNICAL_INSPECTION: 'inspection',
};

/** Types jamais sommés comme dépense. */
const EXCLUDED_V2 = new Set(['MAINTENANCE_QUOTE', 'REPAIR_QUOTE', 'WORKS_QUOTE', 'RENT_RECEIPT', 'SECURITY_DEPOSIT_RECEIPT']);
const EXCLUDED_CATALOG = new Set(['BON_COMMANDE', 'COMPROMIS_VENTE']);

const THEME_BY_BUSINESS: Partial<Record<EventBusinessType, ExpenseTheme>> = {
  maintenance: 'maintenance', repair: 'repair', insurance: 'insurance', purchase: 'purchase', inspection: 'inspection',
};

/**
 * Preuve de paiement (types V2 `ACQUISITION_PAYMENT`, `*_PAYMENT`,
 * `*_PAYMENT_PROOF` — même règle que la projection T1, `transactionNature`) :
 * elle confirme un règlement, elle n'est JAMAIS un coût (P16, C12, F-132).
 */
const V2_PAIEMENT = /(^ACQUISITION_PAYMENT$|_PAYMENT(_PROOF)?$)/;

export function isPaymentProofType(documentTypeCode: string | null | undefined): boolean {
  return V2_PAIEMENT.test((documentTypeCode ?? '').trim().toUpperCase());
}

/**
 * Avoir / note de crédit, reconnu au TITRE retenu (même tournures que la
 * projection T1 ; « avoir » seul est un verbe courant : en tête de titre ou
 * dans une tournure d'avoir seulement). Un avoir RÉDUIT le coût (C12).
 */
const AVOIR = /(\bfacture d.?avoir\b|\bavoir n\s?[°o]|\bavoir sur facture\b|^\s*avoir\b|\bnote de cr[ée]dit\b|\bcredit note\b)/i;

export function isCreditNoteTitle(title: string | null | undefined): boolean {
  return !!title && AVOIR.test(title);
}

export type ExpenseClass =
  | { kind: 'theme'; theme: ExpenseTheme }
  | { kind: 'excluded'; reason: string }
  | { kind: 'unqualified' };

/** Classe d'un document à montant (pure, testée). */
export function classifyExpenseDocument(documentTypeCode: string | null, legacyType: string | null): ExpenseClass {
  if (documentTypeCode && EXCLUDED_V2.has(documentTypeCode)) return { kind: 'excluded', reason: documentTypeCode };
  // Lot 45 (P16) : une preuve de paiement n'est jamais une dépense de plus.
  if (isPaymentProofType(documentTypeCode)) return { kind: 'excluded', reason: 'PAYMENT_PROOF' };
  if (documentTypeCode && THEME_BY_V2_CODE[documentTypeCode]) return { kind: 'theme', theme: THEME_BY_V2_CODE[documentTypeCode] };
  const entry = resolveDocumentType(documentTypeCode) ?? resolveDocumentType(legacyType);
  if (!entry) return { kind: 'unqualified' };
  if (entry.authority === 'WEAK' || EXCLUDED_CATALOG.has(entry.code)) return { kind: 'excluded', reason: entry.code };
  if (entry.businessTypes.length === 1) {
    const t = THEME_BY_BUSINESS[entry.businessTypes[0]];
    if (t) return { kind: 'theme', theme: t };
  }
  return { kind: 'unqualified' };
}
