/**
 * Sémantique de valorisation — lot 38, O0 (CDC Opérations V1 §19, B18, C18 ;
 * décision PO Q12).
 *
 * « Une estimation de valeur n'est jamais une Opération et alimente
 * valuationHistory » ; « seule une sémantique de valorisation explicite peut
 * créer une valorisation » ; « aucun montant documentaire générique ne doit
 * contaminer valorisation ou acquisition ».
 *
 * Règle commune à T1 (projection) et T3 (preuves admises) : une FACTURE, un
 * devis, un bon de commande, un ticket ou une preuve de paiement ne prouve
 * JAMAIS une valeur estimée — c'est un prix de transaction (acquisition,
 * prestation), pas une valorisation. Une expertise, une estimation ou un
 * inventaire valorisé le peut.
 *
 * Module PUR (aucune base).
 */

/** Champs de valorisation du registre. */
const VALUATION_KEYS: ReadonlySet<string> = new Set([
  'estimatedValue', 'estimatedValueDate', 'estimatedValueMode', 'estimatedValueCurrency',
  'valuationLow', 'valuationHigh', 'valuationDate', 'valuationSource',
]);

/**
 * Types documentaires de VALORISATION explicite (V2 et codes canoniques
 * éventuels renvoyés par le modèle) — ordre d'autorité décroissant.
 */
export const VALUATION_DOCUMENT_TYPES: readonly string[] = [
  'VALUE_APPRAISAL', 'EXPERTISE', 'VALUE_ESTIMATE', 'ESTIMATION', 'AVIS_VALEUR', 'VALUED_INVENTORY',
];

/** Types de TRANSACTION : canoniques, V2 (`*_INVOICE`, `*_QUOTE`, `*_ORDER`, `*_PAYMENT…`). */
const TRANSACTION_CANONIQUES = new Set(['FACTURE', 'DEVIS', 'BON_COMMANDE', 'TICKET_CAISSE', 'DOCUMENT_BANCAIRE']);
const TRANSACTION_V2 = /_(INVOICE|QUOTE|ORDER|PURCHASE_ORDER|PAYMENT|PAYMENT_PROOF|RECEIPT|DEPOSIT_INVOICE|CREDIT_NOTE)$/;

export function isTransactionDocumentType(code: string | null | undefined): boolean {
  const c = (code ?? '').trim().toUpperCase();
  if (!c) return false;
  return TRANSACTION_CANONIQUES.has(c) || TRANSACTION_V2.test(c);
}

function isValuationKey(fieldKey: string): boolean {
  return VALUATION_KEYS.has(fieldKey);
}

/**
 * Une preuve venue de ce type de document peut-elle alimenter ce champ ?
 * Seule exclusion : un champ de valorisation prouvé par un document de
 * transaction. Tout le reste suit les règles habituelles (autorité, À traiter).
 */
export function isValuationEvidenceAdmissible(fieldKey: string, ...documentTypes: Array<string | null | undefined>): boolean {
  if (!isValuationKey(fieldKey)) return true;
  return !documentTypes.some((t) => isTransactionDocumentType(t));
}
