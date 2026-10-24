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

/** Lot 75D (D) : types V2 de dépense qualifiée (lecture des justificatifs SANS montant par le TCO). */
export const EXPENSE_THEME_V2_CODES: readonly string[] = Object.keys(THEME_BY_V2_CODE);

/** Types jamais sommés comme dépense. */
const EXCLUDED_V2 = new Set(['MAINTENANCE_QUOTE', 'REPAIR_QUOTE', 'WORKS_QUOTE', 'ACQUISITION_QUOTE', 'RENT_RECEIPT', 'SECURITY_DEPOSIT_RECEIPT']);
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

// ── Doublons documentaires (extraits de `expenses.ts`, lot 61 : purs, partagés T2 / TCO) ──

/** Ligne de document utile au dédoublonnage. */
export interface ExpenseRow {
  id: number;
  v2: string | null;
  legacy: string | null;
  date: string | null;
  hash: string | null;
  title: string | null;
  assetId: number | null;
  supplier: string | null;
  state: string | null;
  ignored: number[] | null;
}

/** Nombre d'informations qualifiantes d'un document (départage des doublons). */
export function expenseInfoScore(r: ExpenseRow): number {
  return [r.v2, r.legacy, r.date, r.supplier, r.title].filter((x) => x != null && String(x).trim() !== '').length;
}

/**
 * Doublons « fusion possible » comptés une seule fois (pure, testée).
 *
 * Lot 61 (TCO §3.3 « deux copies d'une facture : un seul coût ») : deux
 * documents de MÊME empreinte `sha256_hash` sont une copie l'un de l'autre,
 * signalés ou non (preuve exacte), sauf fusion IGNORÉE par l'utilisateur.
 *
 * Deux documents du résultat forment aussi un doublon si l'un au moins est signalé
 * `FUSION_SUGGESTED`, si la fusion n'a pas été IGNORÉE entre eux
 * (`fusion_ignored_with`, choix de l'utilisateur) et s'ils répondent aux
 * critères du détecteur : même empreinte `sha256_hash` (doublon exact), ou
 * même titre retenu + même bien + même date (doublon probable). Les
 * groupes sont transitifs.
 *
 * Règle de conservation (documentée, CDC 15 T2-24) : dans chaque groupe, on
 * garde le document qui porte le PLUS D'INFORMATIONS (type V2, type
 * historique, date, fournisseur, titre retenu — `expenseInfoScore`) ; à
 * égalité, le PLUS ANCIEN (plus petit identifiant, antérieur au
 * téléversement du doublon). Les autres sont écartés du total et déclarés.
 */
export function dedupePossibleMerges<R extends ExpenseRow>(rows: R[]): { kept: R[]; removed: number[] } {
  const parent = new Map<number, number>(rows.map((r) => [r.id, r.id]));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const ignores = (a: R, b: R) => (a.ignored ?? []).map(Number).includes(b.id) || (b.ignored ?? []).map(Number).includes(a.id);
  // Copie exacte (même empreinte) : preuve suffisante, sans signalement (lot 61).
  const parHash = new Map<string, R[]>();
  for (const r of rows) if (r.hash) parHash.set(r.hash, [...(parHash.get(r.hash) ?? []), r]);
  for (const g of parHash.values()) {
    for (let i = 1; i < g.length; i++) {
      for (let j = 0; j < i; j++) if (!ignores(g[i], g[j])) parent.set(find(g[i].id), find(g[j].id));
    }
  }
  const signales = rows.filter((r) => r.state === 'FUSION_SUGGESTED');
  for (const a of signales) {
    for (const b of rows) {
      if (a.id === b.id || ignores(a, b)) continue;
      const exact = !!a.hash && a.hash === b.hash;
      const probable = !!a.title && a.title === b.title && a.assetId != null && a.assetId === b.assetId
        && (a.date ?? null) === (b.date ?? null);
      if (exact || probable) parent.set(find(a.id), find(b.id));
    }
  }
  const groupes = new Map<number, R[]>();
  for (const r of rows) {
    const g = find(r.id);
    groupes.set(g, [...(groupes.get(g) ?? []), r]);
  }
  const garde = new Set<number>();
  const removed: number[] = [];
  for (const g of groupes.values()) {
    const [meilleur] = [...g].sort((x, y) => expenseInfoScore(y) - expenseInfoScore(x) || x.id - y.id);
    garde.add(meilleur.id);
    for (const r of g) if (r.id !== meilleur.id) removed.push(r.id);
  }
  return { kept: rows.filter((r) => garde.has(r.id)), removed: removed.sort((a, b) => a - b) };
}
